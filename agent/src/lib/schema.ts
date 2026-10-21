/**
 * 建表语句与「确保库已建好」的函数。全部代码里建表语句只有这一份；库的格式版本与升级步骤表（UPGRADE_STEPS）也在这里。
 *
 * 为什么建库放在写入工具里、不放在后端或事件钩子里：建库也是写库，写库的入口只能是工具；
 * 事件钩子里出错 pi 只记一行日志就放行，工具的执行函数里出错会当场变成工具的拒绝并带着原因。
 *
 * 条目没有单独的版本号：条目在某一时刻的内容由「条目编号加修订号」标识。库里只存每个条目在它被改动过的
 * 那些修订下的内容；「修订 N 时整份交付物的样子」不另存，读的时候推出来（每个条目在修订号不大于 N 的
 * 最近一行，去掉那时已删除的条目）。
 *
 * 每一条写入类的行都带 event_seq 一列，指向产生它的那条事件；事件里有 pi 的调用编号，
 * 所以任何一行都能经这一列回到模型的那一次工具调用。task 与 revision 两张表另外直接带调用编号，
 * 因为设计里把它列为这两张表的主要列。
 */

import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath, inImmediateTransaction } from "./db.ts";
import { ensureDialogueSchema } from "./dialogue_schema.ts";
import { reviewSpecOf, rulesHash } from "./review_state.ts";

/**
 * 忙等待超时（busy timeout）：遇到别的连接占着锁时，最多等这么多毫秒再放弃。
 * 取 5000 毫秒的依据是 2026-09-21 的实测：4 个进程同时写 80 次，最长一次等了 154 毫秒；
 * 另一个进程占住写锁 3 秒时，写入等 3.1 秒后成功。5 秒足够覆盖一次正常的写入，又不至于让工具
 * 在真出问题时长时间卡住。读取一侧（observatory/taskwright_observatory/taskdb.py）用同一个数值。
 */
export const BUSY_TIMEOUT_MS = 5000;

/** 二十张表的名字，按建表的先后排。 */
export const TABLE_NAMES = [
  "task",
  "revision",
  "item",
  "item_version",
  "item_source",
  "review",
  "judgement",
  "judgement_item",
  "event",
  "model_call",
  "review_finding",
  "review_waiver",
  "dialogue_act",
  "tool_rejection",
  "diagram",
  "diagram_version",
  "activity_record",
  "work_item_session",
  "version_record",
  "material",
] as const;



/** 早先任务表里状态一列的三种取值。格式 8 起这一列不读不写，只有升级时认「已完成」补第 1 版。 */
export const TASK_ACTIVE = "进行中";
export const TASK_DONE = "已完成";
export const TASK_ABANDONED = "已放弃";

/**
 * 来源是任务要素之间的「依据」关系：一个产出型的要素（条目或者图）记下它依据了哪个要素的哪个位置。
 *
 * 依据方的种类（来源表的 kind 列）：
 * - 「文档原文」：材料里或知识库文档里的一段原话，出处写文件的路径（知识库文档以 knowledge/ 开头，不另立种类）。
 * - 「用户的话」：用户在对话里说过的一段原话。
 * - 「助手补充」：助手按常识补上、或者从材料里推出来而材料没有明说的内容；摘录里写的是理由。
 * - 「条目」：任务里的另一个条目，出处写它的条目编号（例如 OA-002、UC-003），摘录写引用的那句；另记引用时它的修订号
 *   （depends_revision），它之后又改了，读取一侧据此标「依据已变」。
 * - 「图」：任务里的一张图，出处写图的编号（例如 D-002），摘录可以不写，写了要逐字出现在那张图现在的 Mermaid 文本里；
 *   同样记下引用时图的修订号（图自己的修订号）。只有条目能依据图，一张图不能把另一张图当作依据。
 * - 「用户直接修改」：早期版本在用户直接改了某个字段时由系统写的，出处是那次操作的编号；现在不再写，也不再显示，
 *   旧修订里的记录原样留在库里（种类清单与表的检查照旧收它）。
 */
export const SOURCE_USER_EDIT = "用户直接修改";
export const SOURCE_SUPPLEMENT = "助手补充";
export const SOURCE_ITEM = "条目";
export const SOURCE_FIGURE = "图";
export const SOURCE_KINDS = ["文档原文", "用户的话", SOURCE_SUPPLEMENT, SOURCE_ITEM, SOURCE_FIGURE, SOURCE_USER_EDIT] as const;
/** 助手可以填的五种。 */
export const EXECUTOR_SOURCE_KINDS = ["文档原文", "用户的话", SOURCE_SUPPLEMENT, SOURCE_ITEM, SOURCE_FIGURE] as const;

/** 产出方是哪种要素（来源表的 element_kind 列）：条目，或者图。 */
export const ELEMENT_ITEM = "条目";
export const ELEMENT_FIGURE = "图";
export const ELEMENT_KINDS = [ELEMENT_ITEM, ELEMENT_FIGURE] as const;

/**
 * 读来源表时「只要某一种要素的来源」这个条件，拼在 WHERE 里用，开头自带 AND。条目的来源与图的来源同在一张表里，
 * 靠 element_kind 区分；凡是按条目编号取来源的地方都要带上它，免得把图的来源当成条目的。alias 是表的别名（带点，例如 "s."）。
 */
export function elementClause(kind: string = ELEMENT_ITEM, alias = ""): string {
  return ` AND ${alias}element_kind = '${kind === ELEMENT_FIGURE ? ELEMENT_FIGURE : ELEMENT_ITEM}'`;
}
export const SOURCE_USER_WORDS = "用户的话";
export const SOURCE_DOCUMENT = "文档原文";

/**
 * 建表语句全文。每一列后面的双短横线注释会随建表语句一起存进库里（sqlite_master 的 sql 列），
 * 用库的人不看代码也能读到每一列是什么意思。
 */
/**
 * 模型调用表：工具里直接调一次模型（现在只有评审者）每调一次记一行——提示全文、原始输出、
 * 模型名、耗时与用量。这是过程留痕，不是领域事实，所以不进事件表；与 review 一对一，
 * 输出不合格、没有写成评审的那一次也记，关联编号为空。role 与 judgement_id 两列是早期版本留下的：
 * 那时还有一种由模型判读用户的话来登记确认的做法，已经退役，旧库里可能还有那种行；新写的行 role 一律是评审者、judgement_id 为空。
 * 用 IF NOT EXISTS：之前建的库没有这张表，第一次被写入一侧打开时补上（只加表，不改已有的表，不算迁移）。
 */
export const MODEL_CALL_SQL = `
CREATE TABLE IF NOT EXISTS model_call (
  model_call_id  INTEGER PRIMARY KEY,  -- 模型调用的编号
  task_id        TEXT NOT NULL,        -- 所属任务的任务编号
  role           TEXT NOT NULL CHECK (role IN ('判读者', '评审者')),  -- 谁的调用
  judgement_id   INTEGER,              -- 早期版本留下的列，新写的行为空
  review_id      INTEGER,              -- 关联的评审编号（评审者调用时填）
  tool_call_id   TEXT NOT NULL,        -- 发起这次模型调用的那次工具调用的 pi 调用编号
  prompt         TEXT NOT NULL,        -- 提示全文（JSON：系统提示与消息）
  output         TEXT NOT NULL,        -- 模型的原始输出
  outcome        TEXT NOT NULL CHECK (outcome IN ('采用', '输出不合格', '调用失败')),  -- 这次输出有没有被采用
  model          TEXT NOT NULL,        -- 模型名（服务名/模型编号）
  duration_ms    INTEGER NOT NULL,     -- 耗时（毫秒）
  input_tokens   INTEGER,              -- 输入用量，服务没报时为空
  output_tokens  INTEGER,              -- 输出用量，服务没报时为空
  created_at     TEXT NOT NULL         -- 时刻（本地时间）
);
`;

/**
 * 评审发现表：评审者对一条评审给出的逐条发现——依据的规则编号与级别、字段、列表型字段的第几项、问题、建议。
 * 评审表只有结论与理由一列文字，发现要能按字段标到界面上，所以单独成表，一条发现一行。
 * 与 model_call 一样用 IF NOT EXISTS：之前建的库第一次被写入一侧打开时补上，只加表、不改已有的表。
 * rule_id 与 level 两列是后来加的，已有这张表的库在 ensureSchema 里用 ALTER TABLE 补上（见 REVIEW_FINDING_ADDED_COLUMNS）。
 */
export const REVIEW_FINDING_SQL = `
CREATE TABLE IF NOT EXISTS review_finding (
  review_id    INTEGER NOT NULL,     -- 所属评审记录的编号
  task_id      TEXT NOT NULL,        -- 所属任务的任务编号
  ordinal      INTEGER NOT NULL,     -- 这条发现在这次评审里的序号，从 1 起
  field        TEXT NOT NULL,        -- 字段名
  item_index   INTEGER,              -- 列表型字段的第几项，从 0 起；指整个字段时为空
  problem      TEXT NOT NULL,        -- 问题
  suggestion   TEXT,                 -- 建议，可空
  rule_id      TEXT,                 -- 依据的规则编号，例如 UC-R3；没有规则文件的集合为空
  level        TEXT,                 -- 那条规则这次的级别：必选或可选；必选规则的发现叫问题，可选规则的发现叫建议
  PRIMARY KEY (review_id, ordinal)
);
`;

/**
 * 评审豁免表：用户保留了一个评审不合规的条目在某次修订上的写法，一次保留一行。只有用户能写（界面操作 waive_review）。
 * 撤销保留（unwaive_review）不删行，只填 revoked_at 与 revoked_op_id。条目改出新修订之后，旧修订上的保留自然不再作数。
 * 后来加的表，与 model_call 一样用 IF NOT EXISTS，旧库第一次被写入一侧打开时补上。
 */
export const REVIEW_WAIVER_SQL = `
CREATE TABLE IF NOT EXISTS review_waiver (
  waiver_id      INTEGER PRIMARY KEY,  -- 保留记录的编号
  task_id        TEXT NOT NULL,        -- 所属任务的任务编号
  item_id        TEXT NOT NULL,        -- 条目编号
  revision_no    INTEGER NOT NULL,     -- 保留的是条目在哪次修订下的写法
  reason         TEXT,                 -- 理由，可空
  source         TEXT NOT NULL,        -- 在哪里点的：detail（条目详情）或 panel（评审页签）
  op_id          TEXT NOT NULL,        -- 那次界面操作的编号（ui- 开头）
  event_seq      INTEGER NOT NULL,     -- 记下这次保留的那条事件的序号
  created_at     TEXT NOT NULL,        -- 时刻（本地时间）
  revoked_at     TEXT,                 -- 撤销保留的时刻；没撤销为空
  revoked_op_id  TEXT                  -- 撤销保留的那次界面操作的编号
);
`;

/**
 * 工具拒绝表：执行者的一次工具调用因为输入不合规（或缺了前置步骤）被工具拒绝时记一行——哪个工具、哪次调用、
 * 事实与指引两层拒绝文字、被拒输入的前 2000 个字符。被拒的调用什么都没有写，所以不记事件；这是过程留痕，
 * 用来事后查「助手被拒过什么、为什么」，不必再翻会话文件。模型服务出错、库打不开之类不是输入的问题，不记。
 * 每一行另记原因码（格式 9 起）：观测台的健康页按原因码数被拒次数。
 */
export const TOOL_REJECTION_SQL = `
CREATE TABLE IF NOT EXISTS tool_rejection (
  rejection_id   INTEGER PRIMARY KEY,  -- 拒绝记录的编号
  task_id        TEXT,                 -- 所属任务的任务编号；库里还没有任务时为空
  session_id     TEXT NOT NULL,        -- 发起这次调用的 pi 会话编号
  work_id        TEXT,                 -- 所属的那次工作：w- 加引出这次运行的那句用户的话的会话条目编号；认不出时为空
  call_id        TEXT NOT NULL,        -- 被拒的那次工具调用的 pi 调用编号
  tool_name      TEXT NOT NULL,        -- 工具名，例如 save_revision
  reason_kind    TEXT NOT NULL CHECK (reason_kind IN ('input', 'gate')),  -- input：输入不合规；gate：缺前置步骤（还没写理解、阶段不对、用户还没同意等，按原因码定）
  fact           TEXT NOT NULL,        -- 事实层：哪里不对，面向人
  guidance       TEXT,                 -- 指引层：接下来该怎么做，只给助手；拒绝文字没有这一层时为空
  input_excerpt  TEXT NOT NULL,        -- 被拒的输入（参数的 JSON）的前 2000 个字符，不存整份输入
  created_at     TEXT NOT NULL,        -- 时刻（本地时间）
  reason_code    TEXT,                 -- 原因码（agent/prompts/runtime/ 下拒绝语模板的键，例如 save_revision.collection_unknown）：一次拒绝有几个原因时是第一个；格式 9 之前记下的行为空
  reason_codes   TEXT                  -- 这次拒绝的全部原因码，JSON 数组，按出现的先后；格式 9 之前记下的行为空
);
`;

/**
 * 图的两张表。图是任务的一种要素，不是集合里的条目：它没有字段，内容是一段 Mermaid 文本；不评审，不算进完成条件。
 * 与条目同构：diagram 只放身份（编号、流水号、有没有删除），内容都在 diagram_version 里，一张图「现在的样子」就是它修订号最大的那一行。
 *
 * 图的修订号是这张图自己的，从 1 起连续，不占任务的修订序号（revision 表）：新增是修订 1，之后每改一次、删除一次各加一。
 * 所以任务的修订日志、撤销、按修订生成文档都不涉及图。删除也记一行内容（照删除之前的样子），谁在什么时候删的由它说明。
 *
 * 图的来源写在 item_source 里：element_kind 为「图」，item_id 是图的编号，revision_no 是图自己的修订号，不写支持的字段。
 * 图的编号是 D- 加三位流水号（D-001），由代码生成，不复用；新建任务时集合的编号前缀不许单写 D（见 definition.ts）。
 *
 * 后来加的表，用 IF NOT EXISTS，旧库第一次被写入一侧打开时补上。
 *
 * 图的种类（kind 列）库里不设检查，写的是哪几种只在代码里判（lib/diagram.ts 的 DIAGRAM_KINDS）：加一种图不用改库的结构。
 * 格式版本 2 及更早建的库里这一列带着只许五种的检查，由升级步骤表的「2 到 3」那一步去掉（dropDiagramKindCheck）。
 */
/** 图的内容表的建表语句。建新库与把旧库的这张表重建成不带种类检查的样子（dropDiagramKindCheck）用的是同一份，只是表名与开头不同。 */
export function diagramVersionSql(name: string, ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${name} (  -- 图在它自己的每次修订下的内容
  task_id      TEXT NOT NULL,          -- 所属任务的任务编号
  diagram_id   TEXT NOT NULL,          -- 图的编号
  revision_no  INTEGER NOT NULL,       -- 这张图自己的修订号，从 1 起连续
  op           TEXT NOT NULL CHECK (op IN ('add', 'update', 'delete')),  -- 这次修订做了什么
  name         TEXT NOT NULL,          -- 图名
  kind         TEXT NOT NULL,          -- 图的种类的写法，例如 use_case、class、flowchart；有哪几种由代码判，库里不设检查
  mermaid      TEXT NOT NULL,          -- Mermaid 文本
  note         TEXT NOT NULL,          -- 说明，没有写时是空文字
  actor        TEXT NOT NULL CHECK (actor IN ('executor', 'user')),  -- 由谁：助手或用户
  session_id   TEXT NOT NULL,          -- 产生这次修订的会话编号
  call_id      TEXT NOT NULL,          -- 产生这次修订的那次工具调用的调用编号，或者界面操作的操作编号
  created_at   TEXT NOT NULL,          -- 时刻（本地时间）
  event_seq    INTEGER NOT NULL,       -- 记下这次修订的那条事件的序号
  PRIMARY KEY (task_id, diagram_id, revision_no)
);
`;
}

export const DIAGRAM_SQL = `
CREATE TABLE IF NOT EXISTS diagram (
  task_id              TEXT NOT NULL,     -- 所属任务的任务编号
  diagram_id           TEXT NOT NULL,     -- 图的编号，D- 加三位流水号，例如 D-001，由代码生成，不复用
  serial               INTEGER NOT NULL,  -- 流水号，同一任务里只增不减
  deleted_in_revision  INTEGER,           -- 在这张图自己的第几次修订里删除，没删为空
  event_seq            INTEGER NOT NULL,  -- 记下新增的那条事件的序号
  deleted_event_seq    INTEGER,           -- 记下删除的那条事件的序号，没删为空
  PRIMARY KEY (task_id, diagram_id)
);
${diagramVersionSql("diagram_version", true)}`;



/**
 * 活动记录表：一行是一个工作项，也就是一次启动——启动一项单项活动，或者启动一条工作流程（lib/stage.ts 与 lib/stage_read.ts）。
 * 工作项记着：现在做的是哪一项活动、在哪条流程的哪一站、谁在什么时候为什么启动、范围说明。工作项没有终点：它是任务里长期存在的一条线，
 * 不要了由用户删除（删掉这一行，它的会话归档，见下面的 work_item_session）。
 * 会话指向工作项：助手在一条会话里能写什么，看这条会话指向的工作项，不看任务；一个任务可以同时有几个工作项，其中流程的工作项至多一个。
 * 只有任务定义里有「业务说明」集合的任务才会有行。
 * 活动用英文写法存（reading、clarifying、modeling、writing、reviewing、document），与事件、接口里的写法相同；
 * 有哪几项只在代码里判（lib/stage.ts 的 STAGES），库不检查取值。
 * 流程的工作项：flow 写流程的键（现在只有 analysis，需求分析），node 写现在在哪一站，activity 写这一站上的那项活动；
 * 换站时更新 node 与 activity 两列并记一条事件，不另开一行。单项活动的工作项：node 与 flow 两列为空。
 * 记录号自增且不重用（AUTOINCREMENT）：删掉的工作项的记录号不会落到新的工作项上，事件里的记录号始终只指一个工作项。
 * 格式版本 5 加的表，取代早先的阶段记录表；格式版本 7 之前一行是一项活动的一段（流程里每到一站一行，带结束的时刻），
 * 升级步骤表的「6 到 7」那一步把它们归并成工作项、重建成现在的样子。
 */
const activityRecordSql = (table: string) => `
CREATE TABLE IF NOT EXISTS ${table} (
  record_id    INTEGER PRIMARY KEY AUTOINCREMENT,  -- 工作项的记录号；自增，删掉的不再用
  task_id      TEXT NOT NULL,         -- 所属任务的任务编号
  session_id   TEXT NOT NULL,         -- 启动这个工作项时所在的那条 pi 会话的会话编号
  run_id       TEXT,                  -- 助手启动时是运行号（这条会话当前分支上第几句用户的话，例如 r3）；用户启动时为空
  call_id      TEXT NOT NULL,         -- 助手启动时是那次工具调用的调用编号；用户启动时是界面操作的操作编号
  actor        TEXT NOT NULL CHECK (actor IN ('executor', 'user')),  -- 由谁启动：助手或用户
  activity     TEXT NOT NULL,         -- 现在做的是哪一项活动（取值只在代码里判）；流程的工作项随换站更新
  node         TEXT,                  -- 流程的工作项现在在哪一站（与活动同一个写法）；单项活动的工作项为空
  flow         TEXT,                  -- 流程的工作项属于哪条流程（现在只有 analysis，需求分析）；单项活动的工作项为空
  reason       TEXT NOT NULL,         -- 启动的理由；用户的可以是空文字
  started_at   TEXT NOT NULL,         -- 启动的时刻（本地时间）
  started_seq  INTEGER NOT NULL,      -- 记下启动的那条事件的序号
  scope        TEXT                   -- 用户启动时写的范围说明；没有写为空
);
`;
export const ACTIVITY_RECORD_SQL = activityRecordSql("activity_record");



/**
 * 工作项的会话：哪条会话属于哪个工作项。一条会话在建立时指向一个工作项，或者不指向任何工作项（自由讨论的会话，这张表里没有它的行），
 * 之后不改；一个工作项可以先后有几条会话。
 * 工作项被删除时，它的会话不删（会话文件是留痕，修订也指向会话），而是归档：archived_at 写上删除的时刻，record_id 照旧留着，
 * 说明它曾属于那个已经删除的工作项（事件里也带着这个记录号；记录号不重用，不会落到新的工作项上）。
 * 归档的会话不属于任何工作项，打开后按自由讨论办；会话清单默认不列它。格式版本 7 加的表。
 */
export const WORK_ITEM_SESSION_SQL = `
CREATE TABLE IF NOT EXISTS work_item_session (
  session_id   TEXT PRIMARY KEY,      -- pi 会话的会话编号；一条会话只属于一个工作项
  record_id    INTEGER NOT NULL,      -- 所属工作项的记录号（activity_record.record_id）；会话归档后照旧留着，是那个已经删除的工作项的
  task_id      TEXT NOT NULL,         -- 所属任务的任务编号
  attached_at  TEXT NOT NULL,         -- 这条会话挂到工作项上的时刻（本地时间）
  archived_at  TEXT                   -- 归档的时刻（本地时间）：它的工作项被删除的时刻；没有归档为空
);
`;

/**
 * 版本记录：一次发布一行。发布版本是对外交付的那一份：版本号从 1 起递增；记下发布的时刻、谁发布的、发布时交付物的整体修订号
 * （「某条目比第 N 版新」由它现在的修订号大于这个数推出，不另设字段）、一句发布说明，以及发布时生成的文档存档在任务目录里的位置
 * （versions/v{N}/document.md 与 document.docx；模板与呈现会随产品升级变化，只存修订号不能保证以后重生成一字不差）。
 * figure_count 与 figure_pictures 记文档里有几张图、其中几张在 Word 里是图片：页面发起发布时带着页面画好的图，存进 Word；
 * 没有图片的那几张在 Word 里写成 Mermaid 文本（助手发起时全是这样）。文档里一张图都没有时两项都为空，不写「图存了」。
 * 从早先「已完成」的任务升级来的第 1 版没有存档，两个路径为空。格式版本 8 加的表。
 */
export const VERSION_RECORD_SQL = `
CREATE TABLE IF NOT EXISTS version_record (
  version_no       INTEGER PRIMARY KEY,   -- 版本号，从 1 起递增
  task_id          TEXT NOT NULL,         -- 所属任务的任务编号
  published_at     TEXT NOT NULL,         -- 发布的时刻（本地时间）
  actor            TEXT NOT NULL,         -- 谁发布的：executor 或 user
  revision_no      INTEGER NOT NULL,      -- 发布时交付物的整体修订号；还没有修订时是 0
  note             TEXT,                  -- 发布说明；没有写为空
  markdown_path    TEXT,                  -- 存档的 Markdown 相对任务目录的路径；没有存档为空
  docx_path        TEXT,                  -- 存档的 Word 相对任务目录的路径；没有存档为空
  figure_count     INTEGER,               -- 文档里有几张图；一张都没有、或者没有存档时为空
  figure_pictures  INTEGER,               -- 其中几张在 Word 里是图片（其余写成 Mermaid 文本）；figure_count 为空时为空
  event_seq        INTEGER NOT NULL       -- 记下这次发布的那条事件的序号；升级补的第 1 版是早先完成任务那条事件的
);
`;

/**
 * 材料记录：上传一份材料一行，记它放进了哪个槽位（工作流的声明里的 slot.<键>）、role 是什么。材料本身是任务目录 inputs/ 下的文件，
 * 清单仍扫目录得出（task_status.ts 的 listMaterials）；这张表只补文件上看不出的槽位与 role。删除或被替换时不删行，写上那一刻；
 * 同一路径删了再传是新的一行。格式 11 加的表；升级时不回填，升级前已有的材料没有行，读的时候当作 role「证据」、槽位空。
 */
export const MATERIAL_SQL = `
CREATE TABLE IF NOT EXISTS material (
  material_id  INTEGER PRIMARY KEY,  -- 材料记录的编号；同一路径删了再传是新的一行
  task_id      TEXT NOT NULL,        -- 所属任务的任务编号
  path         TEXT NOT NULL,        -- 相对任务目录的路径，与 listMaterials 列出的相同
  slot         TEXT,                 -- 放进哪个槽位（工作流的声明里的槽位键）；不经槽位上传的为空
  role         TEXT NOT NULL,        -- 槽位的 role；不经槽位上传的是「证据」
  added_at     TEXT NOT NULL,        -- 上传的时刻（本地时间）
  removed_at   TEXT                  -- 删除或被替换的时刻（本地时间）；还在的为空
);
`;

/** 格式 7 升到 8 时给早先「已完成」的任务补的第 1 版用的发布说明（那一版没有存档）。格式 8 的库里可能还有这样的记录，后端据它说明为什么没有存档。 */
export const UPGRADED_VERSION_NOTE = "升级前完成，当时文档未存档";

/**
 * 修订表上按调用编号判重的索引：同一任务里，同一次工具调用（同一个调用编号）只能形成一次修订。
 * 模型重试或 pi 重发同一次调用时，「保存修订」先按这个编号查到第一次的修订、原样返回，不再写一遍（见 save_revision.ts）；
 * 这个唯一索引是最后一道保险。调用编号为空文字的不算：模型服务没有给调用编号时，pi 交来的是空文字，这种调用无从判重。
 * 旧库第一次被写入一侧打开时补建（见 ensureRevisionCallIndex）。
 */
export const REVISION_CALL_INDEX = "revision_call_id";
export const REVISION_CALL_INDEX_SQL =
  `CREATE UNIQUE INDEX IF NOT EXISTS ${REVISION_CALL_INDEX} ON revision (task_id, call_id) WHERE call_id <> '';`;
/** 旧库里已经有同一调用编号的两次修订时建不成唯一索引，改建这个普通索引，只帮判重的查询提速。 */
export const REVISION_CALL_LOOKUP_INDEX = "revision_call_id_lookup";


/** 来源表的建表语句。name 是表名。 */
export function itemSourceSql(name: string): string {
  return `CREATE TABLE ${name} (
  task_id      TEXT NOT NULL,          -- 所属任务的任务编号
  element_kind TEXT NOT NULL DEFAULT '条目' CHECK (element_kind IN ('条目', '图')),  -- 产出方是哪种要素：条目，或者图
  item_id      TEXT NOT NULL,          -- 产出方的编号：条目编号（以后还有图的编号）
  revision_no  INTEGER NOT NULL,       -- 产出方在哪次修订下的来源
  position     INTEGER NOT NULL,       -- 这次修订下这个要素的第几条来源，从 1 起
  support_no   INTEGER NOT NULL,       -- 这条来源支持的第几处，从 1 起；一条来源支持几处字段就展开成几行，支持整个条目时只有一行
  kind         TEXT NOT NULL CHECK (kind IN ('文档原文', '用户的话', '助手补充', '条目', '图', '用户直接修改')),  -- 依据方的种类；「用户直接修改」只由早期版本的系统写
  locator      TEXT NOT NULL,          -- 出处：文档原文写文件路径；用户的话写「会话编号#会话条目编号」，由工具代填；助手补充由工具填「助手补充」；条目写条目编号；图写图的编号
  excerpt      TEXT NOT NULL,          -- 摘录的原文；种类为助手补充时是理由
  field        TEXT,                   -- 这一处支持的字段名；为空表示这条来源支持整个条目
  field_index  INTEGER,                -- 列表型字段里的第几项，从 0 起；为空表示支持整个字段
  event_seq    INTEGER NOT NULL,       -- 记下这次修订的那条事件的序号
  normalized_value TEXT,               -- 种类为用户的话、写入的值与原话不同时，写入的值；摘录仍是逐字的原话
  depends_revision INTEGER,            -- 种类为条目或图时，引用那一刻对方的修订号；别的种类为空
  inserted     TEXT,                   -- 助手补充的来源：这一处补进正文的字串（JSON 字符串数组，逐字出现在这一处的正文里）；别的来源、旧库里抽不出的为空（格式 10 加的列）
  PRIMARY KEY (task_id, element_kind, item_id, revision_no, position, support_no)
);
`;
}

export const SCHEMA_SQL = `
CREATE TABLE task (
  task_id          TEXT PRIMARY KEY,   -- 任务编号，由创建任务的核心函数生成，例如 TASK-001；一库一任务，这张表只有一行
  task_name        TEXT,               -- 用户在界面上给任务起的名字；为空时显示任务定义里的任务名（任务类型）
  domain_tag       TEXT,               -- 领域标签，只存不用，给将来的需求池预留；用户没给就取任务定义里的，都没有为空
  definition_path  TEXT NOT NULL,      -- 任务定义文件相对任务目录的路径
  definition_text  TEXT NOT NULL,      -- 创建任务那一刻任务定义文件的原文快照
  status           TEXT NOT NULL DEFAULT '进行中' CHECK (status IN ('进行中', '已完成', '已放弃')),  -- 早先的任务状态；格式 8 起不读不写，新建时取缺省值，下一次整理表结构时删
  session_id       TEXT NOT NULL,      -- 创建它的那条 pi 会话的会话编号；由用户在界面上创建时还没有会话，为空文字
  call_id          TEXT NOT NULL,      -- 创建它的那次写入的编号：界面创建时是后端生成的操作编号（ui- 开头）
  event_seq        INTEGER NOT NULL,   -- 记下这次创建的那条事件的序号
  started_at       TEXT NOT NULL,      -- 创建时刻（本地时间）
  ended_at         TEXT                -- 早先完成或放弃的时刻；格式 8 起不读不写
);

CREATE TABLE revision (
  task_id      TEXT NOT NULL,          -- 所属任务的任务编号
  revision_no  INTEGER NOT NULL,       -- 修订序号，每个任务从 1 起
  session_id   TEXT NOT NULL,          -- 产生这次修订的 pi 会话编号
  call_id      TEXT NOT NULL,          -- 产生这次修订的那次工具调用的 pi 调用编号
  event_seq    INTEGER NOT NULL,       -- 记下这次修订的那条事件的序号
  created_at   TEXT NOT NULL,          -- 时刻（本地时间）
  summary      TEXT NOT NULL,          -- 这次改动了哪些条目的摘要（JSON 列表，每项是操作种类、条目编号、所属集合）
  intent_act_id TEXT,                  -- 这次修订因用户哪一项对话行为而做（dialogue_act 的编号）；用户直接操作与对不上的为空
  PRIMARY KEY (task_id, revision_no)
);

CREATE TABLE item (
  task_id              TEXT NOT NULL,     -- 所属任务的任务编号
  item_id              TEXT NOT NULL,     -- 条目编号，编号前缀加三位流水号，例如 UC-001，由代码生成，不复用
  collection           TEXT NOT NULL,     -- 所属的条目集合名，例如「功能用例」
  serial               INTEGER NOT NULL,  -- 流水号，同一任务同一集合里只增不减
  added_in_revision    INTEGER NOT NULL,  -- 在第几次修订里新增
  deleted_in_revision  INTEGER,           -- 在第几次修订里删除，没删为空
  event_seq            INTEGER NOT NULL,  -- 记下这次新增的那条事件的序号
  deleted_event_seq    INTEGER,           -- 记下这次删除的那条事件的序号，没删为空
  PRIMARY KEY (task_id, item_id)
);

CREATE TABLE item_version (         -- 条目在某次修订下的内容：条目只在它被新增、修改或恢复的那些修订下有一行
  task_id      TEXT NOT NULL,          -- 所属任务的任务编号
  item_id      TEXT NOT NULL,          -- 条目编号
  revision_no  INTEGER NOT NULL,       -- 产生这份内容的修订号；条目编号加修订号唯一确定条目在那一刻的内容
  fields       TEXT NOT NULL,          -- 各字段的内容（JSON 对象，键是任务定义里声明的字段名）
  event_seq    INTEGER NOT NULL,       -- 记下这次修订的那条事件的序号
  PRIMARY KEY (task_id, item_id, revision_no)
);

${itemSourceSql("item_source")}
CREATE TABLE review (
  review_id           INTEGER PRIMARY KEY,  -- 评审记录的编号
  task_id             TEXT NOT NULL,        -- 所属任务的任务编号
  item_id             TEXT NOT NULL,        -- 被评审的条目编号
  revision_no         INTEGER NOT NULL,     -- 被评审的是条目在哪次修订下的内容；标记不随后续修订移动
  verdict             TEXT NOT NULL CHECK (verdict IN ('合规', '不合规')),  -- 评审结论
  reason              TEXT NOT NULL,        -- 理由
  rules_digest        TEXT NOT NULL,        -- 所依据的规矩文档的摘要值
  reviewer_session_id TEXT NOT NULL,        -- 评审者那条 pi 会话的会话编号
  call_id             TEXT NOT NULL,        -- 发起这次评审的调用编号：界面发起时是操作编号（ui- 开头），助手经工具发起时是 pi 的工具调用编号
  event_seq           INTEGER NOT NULL,     -- 记下这条评审的那条事件的序号
  created_at          TEXT NOT NULL,        -- 时刻（本地时间）
  batch_id            TEXT,                 -- 所属的那一次评审（批次）的编号，与 call_id 相同；早期版本的记录为空
  rules_hash          TEXT,                 -- 规则指纹：这个集合的规则文件内容加任务级开关（关闭、升为必选）算出的哈希；没有规则文件的集合与早期记录为空
  reviewer_version    TEXT,                 -- 评审者提示词文件的哈希
  forced              INTEGER NOT NULL DEFAULT 0  -- 1：内容与规则都没变、用户仍要求重评的那一次
);

CREATE TABLE judgement (           -- 确认标记：用户看过或认可了哪几个条目，一次界面操作一行（表名是早期版本起的）
  judgement_id  INTEGER PRIMARY KEY,   -- 标记的编号
  task_id       TEXT NOT NULL,         -- 所属任务的任务编号
  basis         TEXT NOT NULL,         -- 依据（JSON 列表，每项写「依据」：已读、界面修改或界面点击，另写「操作编号」；早期版本的库里还有依据为用户的话的）
  call_id       TEXT NOT NULL,         -- 写下这次标记的那次界面操作的编号（ui- 开头）
  event_seq     INTEGER NOT NULL,      -- 记下这次标记的那条事件的序号
  created_at    TEXT NOT NULL          -- 时刻（本地时间）
);

CREATE TABLE judgement_item (      -- 确认标记里的每个条目
  judgement_id  INTEGER NOT NULL,      -- 所属标记的编号
  task_id       TEXT NOT NULL,         -- 所属任务的任务编号
  item_id       TEXT NOT NULL,         -- 条目编号
  revision_no   INTEGER NOT NULL,      -- 用户看过或认可的是条目在哪次修订下的内容；标记不随后续修订移动
  attitude      TEXT NOT NULL CHECK (attitude IN ('接受', '不接受')),  -- 接受：看过或认可了；不接受：撤回了确认，条目回到未读
  event_seq     INTEGER NOT NULL,      -- 记下这次标记的那条事件的序号
  PRIMARY KEY (judgement_id, item_id)
);

CREATE TABLE event (
  seq         INTEGER PRIMARY KEY,     -- 全局序号，从 1 起连续
  task_id     TEXT NOT NULL,           -- 所属任务的任务编号
  session_id  TEXT NOT NULL,           -- 发生这件事的那条 pi 会话的会话编号
  call_id     TEXT NOT NULL,           -- pi 的调用编号，文字原样存下
  name        TEXT NOT NULL,           -- 事件名，例如 TASK_CREATED、REVISION_SAVED
  payload     TEXT NOT NULL,           -- 内容（JSON）
  actor       TEXT NOT NULL,           -- 发起方
  at          TEXT NOT NULL            -- 时刻（本地时间）
);
${MODEL_CALL_SQL}
${REVIEW_FINDING_SQL}
${REVIEW_WAIVER_SQL}
${TOOL_REJECTION_SQL}
${DIAGRAM_SQL}
${ACTIVITY_RECORD_SQL}
${WORK_ITEM_SESSION_SQL}
${VERSION_RECORD_SQL}
${MATERIAL_SQL}
${REVISION_CALL_INDEX_SQL}`;

/** 任务目录里还没有库、又不允许新建时抛的错。调用方据此给出「还没有创建任务」的拒绝。 */
export class NoDatabaseYet extends Error {}

/** 库里现有的表名。 */
export function existingTables(db: DatabaseSync): string[] {
  // SQLite 自己的表（记录号自增计数用的 sqlite_sequence）不算。
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all() as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * 任务库的格式版本，记在库文件自己的 PRAGMA user_version 里。每改一次任务库的结构，就在 UPGRADE_STEPS 里加一步，这个数加 1。
 * 本程序只认格式 8 起的库：8 是 0.6 开发期间定下的样子（工作项、工作项的会话、版本记录）；9 给工具拒绝表加了原因码两列
 * （reason_code、reason_codes）；10 给来源表加了助手补充补进正文的字串一列（inserted）；
 * 11 加了材料表（material：每份材料放进哪个槽位、role 是什么）。更早的格式（没有编过版本号的 0.4 的库，与 0.5 建的格式 1 到 7 的库）不再升级，打开时拒绝
 * （OlderTaskDatabase），库原样不动。一张表都没有的空库（版本也是 0）照现在的建表语句建齐，直接记成现在的版本。
 */
export const TASK_DB_VERSION = 11;

/** 本程序还能升级的最早格式：比它早的库打开时拒绝。 */
export const MIN_TASK_DB_VERSION = 8;

/** 任务目录里记建立与升级情况的文件（后端写）。助手一侧只在拒绝比自己新的库时读它，好说出是哪个版本写的。 */
export const TASK_JSON = "task.json";

/** 库的格式版本比这个程序认识的新时抛的错：旧程序不打开新数据，也不做降级。 */
export class NewerTaskDatabase extends Error {}

/** 库的格式早于 MIN_TASK_DB_VERSION 时抛的错：更早的格式不再升级，库原样不动。 */
export class OlderTaskDatabase extends Error {}

/** 库里记的格式版本。 */
export function taskDbVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

/** 拒绝比自己新的数据时的那句话；writtenBy 是写它的产品版本，不知道时给 null。任务库与数据目录都用这一句。 */
export function newerDataText(writtenBy: string | null): string {
  return writtenBy ? `这份数据由 ${writtenBy} 写入，请用 ${writtenBy} 或更新的版本打开。` : "这份数据由更新的版本写入，请用更新的版本打开。";
}

/** 拒绝格式太早的任务库时的那句话；version 是库里记的格式版本（0 是没有编过版本号的库）。 */
export function olderDataText(version: number): string {
  return `这个任务库的格式是 ${version}（${version === 0 ? "没有编过版本号，0.4 建的" : "0.5 建的"}），本版本只能打开格式 ${MIN_TASK_DB_VERSION} 及以后的任务库，` +
    "更早的格式不再升级，库没有改动。请新建一个任务。";
}

/** 任务目录的 task.json 里记的、最近写这个任务的产品版本（升级过的取升级时的，否则取建任务时的）；读不到时是 null。 */
export function taskWrittenBy(workspaceDir: string): string | null {
  try {
    const meta = JSON.parse(readFileSync(join(workspaceDir, TASK_JSON), "utf-8")) as Record<string, unknown>;
    const version = meta.upgraded_by_version ?? meta.created_by_version;
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  }
}

/**
 * 升级步骤表：把库从一个格式版本升到下一个。这是改任务库结构的唯一入口，三条路都走它——助手写库（withTaskDatabase）、
 * 服务启动时的数据升级、命令行的数据升级（后两条经 upgradeTaskDatabase）。
 * 每一步可以重复做（做过的部分再做一遍不出错、不改数据），整张表在调用方开好的一个立即事务里走完，版本号也在这个事务里写：
 * 中途出错整体回退，库与版本号都还是升级之前的样子。
 */
const UPGRADE_STEPS: { from: number; to: number; run: (db: DatabaseSync, ctx: UpgradeContext) => void }[] = [
  { from: 8, to: 9, run: (db, ctx) => { addRejectionReasons(db); renameTaskType(db, ctx); renameOverallCollection(db, ctx); dropSideTab(db, ctx); } },
  { from: 9, to: 10, run: (db, ctx) => addInsertedColumn(db, ctx) },
  { from: 10, to: 11, run: (db) => createMaterialTable(db) },
];

/**
 * 升级时步骤用得着、库里又没有的东西：workspaceDir 是任务目录（只测库的单元测试可以不给，这时步骤只改库）；notes 由步骤往里写这次做了的、值得写进升级报告的事。
 */
export interface UpgradeContext {
  workspaceDir?: string;
  notes: string[];
}

/** 库是不是一张表都没有的空库（版本也是 0）：这样的库照现在的建表语句建齐。 */
function isEmptyDatabase(db: DatabaseSync): boolean {
  return taskDbVersion(db) === 0 && existingTables(db).length === 0;
}

/** 格式太早的库就拒绝。在切日志模式与开事务之前调：被拒的库一个字节都不动。 */
function refuseOlder(db: DatabaseSync): void {
  const version = taskDbVersion(db);
  if (version < MIN_TASK_DB_VERSION && !isEmptyDatabase(db)) throw new OlderTaskDatabase(olderDataText(version));
}

/** 第 8 到 9 步之一：工具拒绝表加原因码两列。只加列，不动已有的行（它们的原因码是空的）；新建的库建表时就有这两列，这里什么都不做。 */
function addRejectionReasons(db: DatabaseSync): void {
  const columns = (db.prepare("PRAGMA table_info(tool_rejection)").all() as { name: string }[]).map((row) => row.name);
  if (!columns.includes("reason_code")) db.exec("ALTER TABLE tool_rejection ADD COLUMN reason_code TEXT");
  if (!columns.includes("reason_codes")) db.exec("ALTER TABLE tool_rejection ADD COLUMN reason_codes TEXT");
}

/** 理由里用直角引号引出的各段字；空的不算。格式 10 之前助手补充靠它标出补进正文的字，升级时由它抽出 inserted。 */
export const QUOTED_IN_REASON = /「([^「」]+)」/g;

/** 来源表里的一行支持处还原成一处支持：inserted 列是 JSON 字符串数组，为空时没有这一项。 */
export function supportOf(field: string, index: number | null, inserted: string | null): { field: string; index?: number; inserted?: string[] } {
  const one: { field: string; index?: number; inserted?: string[] } = index === null ? { field } : { field, index };
  if (inserted) one.inserted = JSON.parse(inserted) as string[];
  return one;
}

/** 一处支持所指的正文：某个字段，列表型字段的某一项；没有字段时是条目全部字段的文字。 */
export function supportedTexts(fields: Record<string, unknown>, field: string | null, index: number | null | undefined): string[] {
  const textsOf = (value: unknown): string[] =>
    typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
  if (field === null) return Object.values(fields).flatMap(textsOf);
  const value = fields[field];
  return index === null || index === undefined || !Array.isArray(value) ? textsOf(value) : textsOf(value[index]);
}

/**
 * 第 9 到 10 步：来源表加 inserted 一列，助手补充的旧行由理由里的直角引号一次性抽出填入：取这一处正文里逐字出现的那几段，
 * 一段也抽不出的留空（照旧可以读，页面退回按理由里的引号显示）。重复做不出错：已经填过的行不再动。
 */
function addInsertedColumn(db: DatabaseSync, ctx: UpgradeContext): void {
  const columns = (db.prepare("PRAGMA table_info(item_source)").all() as { name: string }[]).map((row) => row.name);
  if (!columns.includes("inserted")) db.exec("ALTER TABLE item_source ADD COLUMN inserted TEXT");
  const rows = db.prepare(
    "SELECT s.rowid AS id, s.excerpt, s.field, s.field_index, v.fields FROM item_source s " +
    "LEFT JOIN item_version v ON v.task_id = s.task_id AND v.item_id = s.item_id AND v.revision_no = s.revision_no " +
    `WHERE s.kind = ? AND s.element_kind = ? AND s.inserted IS NULL`,
  ).all(SOURCE_SUPPLEMENT, ELEMENT_ITEM) as { id: number; excerpt: string; field: string | null; field_index: number | null; fields: string | null }[];
  const update = db.prepare("UPDATE item_source SET inserted = ? WHERE rowid = ?");
  let filled = 0;
  for (const row of rows) {
    const texts = row.fields ? supportedTexts(JSON.parse(row.fields) as Record<string, unknown>, row.field, row.field_index) : [];
    const quoted = [...new Set([...row.excerpt.matchAll(QUOTED_IN_REASON)].map((m) => m[1]))].filter((one) => texts.some((text) => text.includes(one)));
    if (quoted.length === 0) continue;
    update.run(JSON.stringify(quoted), row.id);
    filled += 1;
  }
  if (filled) ctx.notes.push(`助手补充的来源里 ${filled} 处由理由里的直角引号抽出了补进正文的字串`);
}

/** 第 10 到 11 步：建材料表，不回填。建表语句带 IF NOT EXISTS，重复做不出错。 */
function createMaterialTable(db: DatabaseSync): void {
  db.exec(MATERIAL_SQL);
}

/** 任务类型改名（格式 9 起）：键与中文名。 */
const OLD_TASK_TYPE = "srs-authoring";
export const TASK_TYPE_KEY = "requirements-engineering";
const OLD_TASK_TYPE_NAME = "软件需求规格说明编制";
const TASK_TYPE_NAME = "需求工程";

/** 任务定义的原文里改名：执行方法的路径与任务名。只换这两处，别的一个字节都不动；已经改过的原样返回。 */
function renamedDefinition(text: string): string {
  return text.replace(`".pi/skills/${OLD_TASK_TYPE}/SKILL.md"`, `".pi/skills/${TASK_TYPE_KEY}/SKILL.md"`)
    .replace(new RegExp(`("任务名"\\s*:\\s*)"${OLD_TASK_TYPE_NAME}"`), `$1"${TASK_TYPE_NAME}"`);
}

/**
 * 第 8 到 9 步之二：任务类型「软件需求规格说明编制」（键 srs-authoring）改名「需求工程」（键 requirements-engineering）。
 * 库里：任务表的定义路径与定义原文快照。任务目录里（有 ctx.workspaceDir 时）：任务定义文件与 skill 目录改名，定义文件的
 * 执行方法与任务名、skill 的名字与标题随改，task.json 的类型名随改。每一样都先看是不是还是旧的，重复做不出错；任务目录里没有的文件跳过。
 */
function renameTaskType(db: DatabaseSync, ctx: UpgradeContext): void {
  const oldPath = `docs/task-definitions/${OLD_TASK_TYPE}.json`;
  const newPath = `docs/task-definitions/${TASK_TYPE_KEY}.json`;
  const row = db.prepare("SELECT task_id, definition_path, definition_text FROM task LIMIT 1").get() as
    { task_id: string; definition_path: string; definition_text: string } | undefined;
  if (row) {
    const path = row.definition_path === oldPath ? newPath : row.definition_path;
    const text = renamedDefinition(row.definition_text);
    if (path !== row.definition_path || text !== row.definition_text) {
      db.prepare("UPDATE task SET definition_path = ?, definition_text = ? WHERE task_id = ?").run(path, text, row.task_id);
    }
  }
  const dir = ctx.workspaceDir;
  if (!dir) return;
  const moved: string[] = [];
  const oldFile = join(dir, oldPath);
  const newFile = join(dir, newPath);
  if (existsSync(oldFile) && !existsSync(newFile)) {
    renameSync(oldFile, newFile);
    moved.push(newPath);
  }
  if (existsSync(newFile)) {
    const text = readFileSync(newFile, "utf-8");
    const now = renamedDefinition(text);
    if (now !== text) writeFileSync(newFile, now, "utf-8");
  }
  const oldSkill = join(dir, ".pi", "skills", OLD_TASK_TYPE);
  const newSkill = join(dir, ".pi", "skills", TASK_TYPE_KEY);
  if (existsSync(oldSkill) && !existsSync(newSkill)) {
    renameSync(oldSkill, newSkill);
    moved.push(`.pi/skills/${TASK_TYPE_KEY}/`);
  }
  const skill = join(newSkill, "SKILL.md");
  if (existsSync(skill)) {
    const text = readFileSync(skill, "utf-8");
    const now = text.replace(new RegExp(`^name: ${OLD_TASK_TYPE}$`, "m"), `name: ${TASK_TYPE_KEY}`)
      .replace(new RegExp(`^# ${OLD_TASK_TYPE_NAME}$`, "m"), `# ${TASK_TYPE_NAME}`);
    if (now !== text) writeFileSync(skill, now, "utf-8");
  }
  const meta = join(dir, TASK_JSON);
  if (existsSync(meta)) {
    try {
      const raw = JSON.parse(readFileSync(meta, "utf-8")) as Record<string, unknown>;
      if (raw.task_type === OLD_TASK_TYPE) writeFileSync(meta, JSON.stringify({ ...raw, task_type: TASK_TYPE_KEY }, null, 2) + "\n", "utf-8");
    } catch {
      // task.json 读不懂：不动它（后端读它时也当作没有）。
    }
  }
  if (moved.length) ctx.notes.push(`任务类型改名为「${TASK_TYPE_NAME}」：${moved.join("、")}`);
}

/** 集合改名（格式 9 起）：「总体分析」改为与页面一致的「业务说明」。集合名就是键；编号前缀 OA 不变。 */
const OLD_OVERALL_COLLECTION = "总体分析";
const OVERALL_COLLECTION_NAME = "业务说明";

/** 任务目录里随任务类型复制来的文本文件（docs/ 与 .pi/skills/ 下的 .md 与 .json）；材料目录不在其中。 */
function taskTypeTextFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    if (!existsSync(at)) return;
    for (const one of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, one.name);
      if (one.isDirectory()) walk(full);
      else if (one.isFile() && /\.(md|json)$/i.test(one.name)) out.push(full);
    }
  };
  walk(join(dir, "docs"));
  walk(join(dir, ".pi", "skills"));
  return out.sort();
}

/** 定义原文里各个要评审的集合与它们的评审规矩。 */
function reviewedCollections(definitionText: string): Map<string, NonNullable<ReturnType<typeof reviewSpecOf>>> {
  const out = new Map<string, NonNullable<ReturnType<typeof reviewSpecOf>>>();
  let raw: { 交付物?: { 条目集合?: { 名称?: unknown }[] } } | null = null;
  try {
    raw = JSON.parse(definitionText);
  } catch {
    return out;
  }
  for (const one of raw?.交付物?.条目集合 ?? []) {
    const name = typeof one?.名称 === "string" ? one.名称 : null;
    const spec = name ? reviewSpecOf(definitionText, name) : null;
    if (name && spec) out.set(name, spec);
  }
  return out;
}

/**
 * 第 8 到 9 步之三：集合「总体分析」改名「业务说明」。库里：定义快照里的集合名、条目表的集合列、事件内容里值正好是「总体分析」的字符串。
 * 任务目录里（有 ctx.workspaceDir 时）：随任务类型复制来的文本文件里的这个词（材料不动）。评审规则文件随之改了字，规则指纹跟着变：
 * 改之前先按各集合的规矩算一遍旧指纹，改完再算新指纹，把评审记录里的旧指纹换成新的，已有的评审仍算作当前规则下评的。
 * 每一样都先看是不是还是旧的，重复做不出错。
 */
function renameOverallCollection(db: DatabaseSync, ctx: UpgradeContext): void {
  const row = db.prepare("SELECT task_id, definition_text FROM task LIMIT 1").get() as { task_id: string; definition_text: string } | undefined;
  const dir = ctx.workspaceDir;
  const before = new Map<string, string>();
  if (row && dir) {
    for (const [name, spec] of reviewedCollections(row.definition_text)) {
      const hash = rulesHash(dir, spec);
      if (hash) before.set(name, hash);
    }
  }
  if (row && row.definition_text.includes(OLD_OVERALL_COLLECTION)) {
    db.prepare("UPDATE task SET definition_text = ? WHERE task_id = ?").run(row.definition_text.replaceAll(OLD_OVERALL_COLLECTION, OVERALL_COLLECTION_NAME), row.task_id);
  }
  const items = Number(db.prepare("UPDATE item SET collection = ? WHERE collection = ?").run(OVERALL_COLLECTION_NAME, OLD_OVERALL_COLLECTION).changes);
  db.prepare("UPDATE event SET payload = REPLACE(payload, ?, ?) WHERE instr(payload, ?) > 0")
    .run(`"${OLD_OVERALL_COLLECTION}"`, `"${OVERALL_COLLECTION_NAME}"`, `"${OLD_OVERALL_COLLECTION}"`);
  if (!dir) return;
  let files = 0;
  for (const file of taskTypeTextFiles(dir)) {
    const text = readFileSync(file, "utf-8");
    if (!text.includes(OLD_OVERALL_COLLECTION)) continue;
    writeFileSync(file, text.replaceAll(OLD_OVERALL_COLLECTION, OVERALL_COLLECTION_NAME), "utf-8");
    files += 1;
  }
  const now = db.prepare("SELECT definition_text FROM task LIMIT 1").get() as { definition_text: string } | undefined;
  if (now) {
    for (const [name, spec] of reviewedCollections(now.definition_text)) {
      const old = before.get(name);
      const hash = rulesHash(dir, spec);
      if (old && hash && old !== hash) {
        db.prepare("UPDATE review SET rules_hash = ? WHERE rules_hash = ? AND item_id IN (SELECT item_id FROM item WHERE collection = ?)").run(hash, old, name);
      }
    }
  }
  if (items || files) ctx.notes.push(`集合「${OLD_OVERALL_COLLECTION}」改名为「${OVERALL_COLLECTION_NAME}」：${items} 个条目，任务目录里 ${files} 份文件`);
}

/** 任务定义原文里删掉集合「界面」一项中的「右侧栏页签」（它在前、在中间或在最后都认）；没有的原样返回。 */
function withoutSideTab(text: string): string {
  return text.replace(/"右侧栏页签"\s*:\s*(true|false)\s*,\s*/g, "").replace(/,\s*"右侧栏页签"\s*:\s*(true|false)/g, "")
    .replace(/"右侧栏页签"\s*:\s*(true|false)/g, "");
}

/**
 * 第 8 到 9 步之四：集合「界面」一项里的「右侧栏页签」去掉（页面早已没有右侧栏的集合页签，任务定义的核对也不再认它）。
 * 库里的定义快照与任务目录里的定义文件一起改，重复做不出错。
 */
function dropSideTab(db: DatabaseSync, ctx: UpgradeContext): void {
  const row = db.prepare("SELECT task_id, definition_path, definition_text FROM task LIMIT 1").get() as
    { task_id: string; definition_path: string; definition_text: string } | undefined;
  if (!row) return;
  const text = withoutSideTab(row.definition_text);
  if (text !== row.definition_text) db.prepare("UPDATE task SET definition_text = ? WHERE task_id = ?").run(text, row.task_id);
  if (!ctx.workspaceDir) return;
  const file = join(ctx.workspaceDir, row.definition_path);
  if (!existsSync(file)) return;
  const raw = readFileSync(file, "utf-8");
  const now = withoutSideTab(raw);
  if (now !== raw) writeFileSync(file, now, "utf-8");
}

/**
 * 确保库是现在的格式：空库照现在的建表语句建齐；别的照 UPGRADE_STEPS 从库里记的版本一步步升到 TASK_DB_VERSION。
 * 已经是现在的版本就什么都不做，不再逐张表去看；比现在的版本新就拒绝（NewerTaskDatabase），早于 MIN_TASK_DB_VERSION 也拒绝（OlderTaskDatabase）。
 * 必须在调用方已经开好的事务里调用，好让建表、升级与随后的写入一起提交或一起回退。返回升级之前与之后的版本。
 */
export function ensureSchema(db: DatabaseSync, ctx: UpgradeContext = { notes: [] }): { from: number; to: number } {
  const from = taskDbVersion(db);
  if (from > TASK_DB_VERSION) throw new NewerTaskDatabase(newerDataText(null));
  if (isEmptyDatabase(db)) {
    db.exec(SCHEMA_SQL);
    ensureDialogueSchema(db);
    db.exec(`PRAGMA user_version = ${TASK_DB_VERSION}`);
    return { from, to: TASK_DB_VERSION };
  }
  refuseOlder(db);
  let version = from;
  for (const step of UPGRADE_STEPS) {
    if (step.from !== version) continue;
    step.run(db, ctx);
    db.exec(`PRAGMA user_version = ${step.to}`);
    version = step.to;
  }
  return { from, to: version };
}

















/**
 * 本服务的任务根目录：后端启动 pi 时经这个环境变量传进来（--tasks 那个目录）。写库之前核对任务库在它之下，
 * 免得复制来的会话把写入打回别处的库。
 */
export const TASKS_ROOT_ENV = "TASKWRIGHT_TASKS_ROOT";

/** 任务库不在本服务的任务根目录之下时抛的错。 */
export class OutsideTasksRoot extends Error {}

let warnedNoRoot = false;

/**
 * 写库前核对：任务库的真实路径（解开符号链接）必须在任务根目录之下，否则抛 OutsideTasksRoot，什么都不写。
 * 没有传任务根目录时（例如直接跑命令行入口、单元测试）不核对，只在标准错误上记一条警告（每个进程一次）。
 */
export function checkUnderTasksRoot(workspaceDir: string): void {
  const root = process.env[TASKS_ROOT_ENV];
  if (!root) {
    if (!warnedNoRoot) {
      warnedNoRoot = true;
      process.stderr.write(`提醒：没有设 ${TASKS_ROOT_ENV}，写任务库之前不核对它是不是在本服务的任务目录之下。\n`);
    }
    return;
  }
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const rootReal = real(root);
  const dirReal = real(workspaceDir);
  if (!dirReal.startsWith(rootReal + sep)) {
    throw new OutsideTasksRoot(`任务库 ${databasePath(dirReal)} 不在本服务的任务目录 ${rootReal} 之下，拒绝写入。`);
  }
}

/**
 * 打开任务目录的库并确保它已建好，然后把 body 放进同一个立即事务里执行。这是每个写入工具的执行函数
 * 第一步要调用的函数，也是扩展里唯一以可写方式打开任务库的地方：打开之前先经 checkUnderTasksRoot 核对路径。
 *
 * createIfMissing 为假时，库文件不存在就直接抛 NoDatabaseYet，不建文件（例如「保存修订」：
 * 没有库就不可能有进行中的任务，不该为了拒绝而留下一个空库）。
 * 为真时库文件不存在就新建；如果随后的核对不通过、整次调用被拒，这个新建出来的文件会被删掉，
 * 任务目录恢复成调用之前的样子。
 */
export function withTaskDatabase<T>(
  workspaceDir: string,
  options: { createIfMissing: boolean },
  body: (db: DatabaseSync) => T,
): T {
  checkUnderTasksRoot(workspaceDir);
  const path = databasePath(workspaceDir);
  const existed = existsSync(path) && statSync(path).size > 0;
  if (!existed && !options.createIfMissing) {
    throw new NoDatabaseYet(path);
  }
  const db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  let succeeded = false;
  try {
    refuseNewer(db, workspaceDir);
    refuseOlder(db);
    useWriteAheadLog(db);
    const result = inImmediateTransaction(db, () => {
      ensureSchema(db, { workspaceDir, notes: [] });
      return body(db);
    });
    succeeded = true;
    return result;
  } finally {
    db.close();
    if (!succeeded && !existed) {
      // 这次调用新建出来的库连同它的两个附属文件一起删掉；关掉连接时 SQLite 通常已经删了附属文件。
      for (const one of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(one)) unlinkSync(one);
      }
    }
  }
}

/** 库比这个程序新就拒绝，话里写上是哪个版本写的（取任务目录的 task.json）。在切日志模式与开事务之前调：新库一个字节都不动。 */
function refuseNewer(db: DatabaseSync, workspaceDir: string): void {
  if (taskDbVersion(db) > TASK_DB_VERSION) throw new NewerTaskDatabase(newerDataText(taskWrittenBy(workspaceDir)));
}


/**
 * 把一个任务目录的库升到现在的格式，返回升级之前与之后的版本（相同就是不用升）。只给数据升级用：服务启动时的升级与命令行的升级
 * 都经后端调这里，走的是与助手写库同一张步骤表（ensureSchema）。库文件不存在抛 NoDatabaseYet，比这个程序新抛 NewerTaskDatabase，
 * 格式早于 MIN_TASK_DB_VERSION 抛 OlderTaskDatabase；出错时库原样不动。
 */
export function upgradeTaskDatabase(workspaceDir: string): { from: number; to: number; notes: string[] } {
  checkUnderTasksRoot(workspaceDir);
  const path = databasePath(workspaceDir);
  if (!(existsSync(path) && statSync(path).size > 0)) throw new NoDatabaseYet(path);
  const db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  try {
    refuseNewer(db, workspaceDir);
    refuseOlder(db);
    useWriteAheadLog(db);
    const ctx: UpgradeContext = { workspaceDir, notes: [] };
    return { ...inImmediateTransaction(db, () => ensureSchema(db, ctx)), notes: ctx.notes };
  } finally {
    db.close();
  }
}

/**
 * 让库用 WAL 模式（write-ahead logging，先把改动写进旁边的日志文件、再合并回库文件）。
 * 默认的回滚日志模式下，只要有别的连接开着读事务，写入就拿不到锁；WAL 模式下读与写互不阻塞，
 * 写与写之间仍然排队，靠上面的忙等待超时等。WAL 模式记在库文件里，切过一次之后一直有效，
 * 所以已有的旧库在第一次被写入一侧打开时就切过去。切换不能在事务里做，所以放在开事务之前。
 *
 * WAL 模式下一个库是三个文件：task.sqlite、task.sqlite-wal、task.sqlite-shm。
 * 复制或归档任务目录时，要么在没有任何连接开着时复制（最后一个连接关闭时 SQLite 会把日志合并回库文件
 * 并删掉两个附属文件），要么三个文件一起复制。
 */
export function useWriteAheadLog(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  if (row.journal_mode.toLowerCase() !== "wal") {
    db.exec("PRAGMA journal_mode = WAL");
  }
}

