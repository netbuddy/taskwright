/**
 * 建表语句与「确保库已建好」的函数。全部代码里建表语句只有这一份。
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

import { existsSync, statSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { databasePath, inImmediateTransaction } from "./db.ts";

/**
 * 忙等待超时（busy timeout）：遇到别的连接占着锁时，最多等这么多毫秒再放弃。
 * 取 5000 毫秒的依据是 2026-09-21 的实测：4 个进程同时写 80 次，最长一次等了 154 毫秒；
 * 另一个进程占住写锁 3 秒时，写入等 3.1 秒后成功。5 秒足够覆盖一次正常的写入，又不至于让工具
 * 在真出问题时长时间卡住。读取一侧（observatory/taskwright_observatory/taskdb.py）用同一个数值。
 */
export const BUSY_TIMEOUT_MS = 5000;

/** 十一张表的名字，按建表的先后排。model_call 是早期版本加的、review_finding 是早期版本加的，旧库在 ensureSchema 里补上，
 *  所以缺这两张不算「表不全」。 */
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
] as const;

/** 旧库里可能没有、由 ensureSchema 补建的表。 */
export const ADDED_TABLES = ["model_call", "review_finding"];

/** 旧库表里有、新库表里没有的那张表。库里有它就说明是旧格式。 */
export const LEGACY_TABLE = "slot";

/** 任务的三种状态。「已放弃」先留着这个取值，放弃任务的工具以后再加。 */
export const TASK_ACTIVE = "进行中";
export const TASK_DONE = "已完成";
export const TASK_ABANDONED = "已放弃";

/**
 * 来源的四种种类。前三种由执行者在「保存修订」里填；第四种「用户直接修改」只由系统写：用户在界面上直接改了
 * 某个字段时，扩展命令给改到的字段写一条这种来源，出处是那次操作的编号。
 */
export const SOURCE_USER_EDIT = "用户直接修改";
export const SOURCE_KINDS = ["文档原文", "用户的话", "执行者补充", SOURCE_USER_EDIT] as const;
/** 执行者可以填的三种。 */
export const EXECUTOR_SOURCE_KINDS = ["文档原文", "用户的话", "执行者补充"] as const;
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

export const SCHEMA_SQL = `
CREATE TABLE task (
  task_id          TEXT PRIMARY KEY,   -- 任务编号，由创建任务的核心函数生成，例如 TASK-001；一库一任务，这张表只有一行
  task_name        TEXT,               -- 用户在界面上给任务起的名字；为空时显示任务定义里的任务名（任务类型）
  domain_tag       TEXT,               -- 领域标签，只存不用，给将来的需求池预留；用户没给就取任务定义里的，都没有为空
  definition_path  TEXT NOT NULL,      -- 任务定义文件相对任务目录的路径
  definition_text  TEXT NOT NULL,      -- 创建任务那一刻任务定义文件的原文快照
  status           TEXT NOT NULL CHECK (status IN ('进行中', '已完成', '已放弃')),  -- 任务的状态
  session_id       TEXT NOT NULL,      -- 创建它的那条 pi 会话的会话编号；由用户在界面上创建时还没有会话，为空文字
  call_id          TEXT NOT NULL,      -- 创建它的那次写入的编号：界面创建时是后端生成的操作编号（ui- 开头）
  event_seq        INTEGER NOT NULL,   -- 记下这次创建的那条事件的序号
  started_at       TEXT NOT NULL,      -- 创建时刻（本地时间）
  ended_at         TEXT                -- 完成或放弃的时刻，没结束为空
);

CREATE TABLE revision (
  task_id      TEXT NOT NULL,          -- 所属任务的任务编号
  revision_no  INTEGER NOT NULL,       -- 修订序号，每个任务从 1 起
  session_id   TEXT NOT NULL,          -- 产生这次修订的 pi 会话编号
  call_id      TEXT NOT NULL,          -- 产生这次修订的那次工具调用的 pi 调用编号
  event_seq    INTEGER NOT NULL,       -- 记下这次修订的那条事件的序号
  created_at   TEXT NOT NULL,          -- 时刻（本地时间）
  summary      TEXT NOT NULL,          -- 这次改动了哪些条目的摘要（JSON 列表，每项是操作种类、条目编号、所属集合）
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

CREATE TABLE item_source (
  task_id      TEXT NOT NULL,          -- 所属任务的任务编号
  item_id      TEXT NOT NULL,          -- 条目编号
  revision_no  INTEGER NOT NULL,       -- 条目在哪次修订下的来源
  position     INTEGER NOT NULL,       -- 这次修订下这个条目的第几条来源，从 1 起
  support_no   INTEGER NOT NULL,       -- 这条来源支持的第几处，从 1 起；一条来源支持几处字段就展开成几行，支持整个条目时只有一行
  kind         TEXT NOT NULL CHECK (kind IN ('文档原文', '用户的话', '执行者补充', '用户直接修改')),  -- 来源的种类；「用户直接修改」只由系统写
  locator      TEXT NOT NULL,          -- 出处：文档原文写文件路径；用户的话写「会话编号#会话条目编号」，由工具代填；执行者补充照模型写的存；用户直接修改写操作编号
  excerpt      TEXT NOT NULL,          -- 摘录的原文
  field        TEXT,                   -- 这一处支持的字段名；为空表示这条来源支持整个条目
  field_index  INTEGER,                -- 列表型字段里的第几项，从 0 起；为空表示支持整个字段
  event_seq    INTEGER NOT NULL,       -- 记下这次修订的那条事件的序号
  PRIMARY KEY (task_id, item_id, revision_no, position, support_no)
);

CREATE TABLE review (
  review_id           INTEGER PRIMARY KEY,  -- 评审记录的编号
  task_id             TEXT NOT NULL,        -- 所属任务的任务编号
  item_id             TEXT NOT NULL,        -- 被评审的条目编号
  revision_no         INTEGER NOT NULL,     -- 被评审的是条目在哪次修订下的内容；标记不随后续修订移动
  verdict             TEXT NOT NULL CHECK (verdict IN ('合规', '不合规')),  -- 评审结论
  reason              TEXT NOT NULL,        -- 理由
  rules_digest        TEXT NOT NULL,        -- 所依据的规矩文档的摘要值
  reviewer_session_id TEXT NOT NULL,        -- 评审者那条 pi 会话的会话编号
  call_id             TEXT NOT NULL,        -- 「请求评审」那次工具调用的 pi 调用编号
  event_seq           INTEGER NOT NULL,     -- 记下这条评审的那条事件的序号
  created_at          TEXT NOT NULL         -- 时刻（本地时间）
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
${REVIEW_FINDING_SQL}`;

/** 任务目录里还没有库、又不允许新建时抛的错。调用方据此给出「还没有创建任务」的拒绝。 */
export class NoDatabaseYet extends Error {}

/** 库里现有的表名。 */
export function existingTables(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * 确保库已建好：一张表都没有就建齐九张；九张都在就什么都不做；是旧库表（有 slot 表）就拒绝；
 * 只有一部分表时也拒绝，因为那不是本代码建出来的样子，贸然补建会掩盖问题。
 * 必须在调用方已经开好的事务里调用，好让建表与随后的写入一起提交或一起回退。
 */
export function ensureSchema(db: DatabaseSync): void {
  const tables = existingTables(db);
  if (tables.includes(LEGACY_TABLE)) {
    throw new Error("这个任务目录的库是旧格式，请换一个新的任务目录。旧格式的库里有 slot 表，本工具不认识它，也不会去改它。");
  }
  if (tables.length === 0) {
    db.exec(SCHEMA_SQL);
    return;
  }
  // 模型调用表是后来加的：只加表、不动已有的表，旧库在这里补上（见 MODEL_CALL_SQL 的说明）。
  db.exec(MODEL_CALL_SQL);
  // 评审发现表是早期版本加的，做法同上。
  db.exec(REVIEW_FINDING_SQL);
  // 评审发现表的规则编号与级别两列是后来加的：缺哪列就加哪列，只加列、不动已有的数据。
  const findingColumns = (db.prepare("PRAGMA table_info(review_finding)").all() as { name: string }[]).map((row) => row.name);
  for (const [name, type] of REVIEW_FINDING_ADDED_COLUMNS) {
    if (!findingColumns.includes(name)) db.exec(`ALTER TABLE review_finding ADD COLUMN ${name} ${type}`);
  }
  // 这两张刚在上面补过，不按开头读到的表名清单判它们缺不缺。
  const missing = TABLE_NAMES.filter((name) => !ADDED_TABLES.includes(name) && !tables.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `这个任务目录的库里缺了 ${missing.join("、")} 这几张表，不是本工具建出来的样子，所以没有写入。` +
        `请换一个新的任务目录。`,
    );
  }
  // 最早格式的库，来源表没有字段一级的几列。库表改动不做迁移，给一句明白的拒绝，免得落到 SQLite 的英文报错上。
  const sourceColumns = (db.prepare("PRAGMA table_info(item_source)").all() as { name: string }[]).map((row) => row.name);
  const missingColumns = SOURCE_LEVEL_COLUMNS.filter((name) => !sourceColumns.includes(name));
  if (missingColumns.length > 0) {
    throw new Error(
      `这个任务目录的库是最早的格式：来源表 item_source 没有 ${missingColumns.join("、")} 这几列（来源记到字段一级是后来加的），` +
        "库表改动不做迁移，所以没有写入。请换一个新的任务目录。",
    );
  }
  // 修订统一之前建的库：条目内容表以内容版本号为主键。库表改动不做迁移，这样的库一律拒绝。
  if (hasVersionColumns(db)) {
    throw new Error(OLD_VERSION_FORMAT_TEXT);
  }
  const taskColumns = (db.prepare("PRAGMA table_info(task)").all() as { name: string }[]).map((row) => row.name);
  const missingTaskColumns = TASK_TABLE_COLUMNS.filter((name) => !taskColumns.includes(name));
  if (missingTaskColumns.length > 0) {
    throw new Error(
      `这个任务目录的库是较早的格式：任务表 task 没有 ${missingTaskColumns.join("、")} 这几列（后来加的），` +
        "库表改动不做迁移，所以没有写入。请新建一个任务。",
    );
  }
}

/** 修订统一之前的库给出的拒绝文字。后端与观测台遇到这种库时说的是同一件事。 */
export const OLD_VERSION_FORMAT_TEXT =
  "这个任务是旧格式：条目还按内容版本号记（修订统一之前建的），本版本不支持，库表改动不做迁移，所以没有写入。请新建一个任务。";

/** 库里的条目内容表还有没有 version_no 列（修订统一之前的格式）。 */
export function hasVersionColumns(db: DatabaseSync): boolean {
  const columns = (db.prepare("PRAGMA table_info(item_version)").all() as { name: string }[]).map((row) => row.name);
  return columns.includes("version_no");
}

/** 来源记到字段一级时给来源表加的几列。库里的来源表缺这几列，说明是最早格式的库。 */
export const SOURCE_LEVEL_COLUMNS = ["support_no", "field", "field_index"] as const;

/** 评审发现表后来加的两列与它们的类型。已有这张表、缺这两列的库（0.1 建的库，这张表还是空的）打开时补上。 */
export const REVIEW_FINDING_ADDED_COLUMNS = [["rule_id", "TEXT"], ["level", "TEXT"]] as const;

/** 任务名与领域标签加进任务表时加的两列。缺这两列说明是更早建的库。 */
export const TASK_TABLE_COLUMNS = ["task_name", "domain_tag"] as const;

/**
 * 打开任务目录的库并确保它已建好，然后把 body 放进同一个立即事务里执行。这是每个写入工具的执行函数
 * 第一步要调用的函数。
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
  const path = databasePath(workspaceDir);
  const existed = existsSync(path) && statSync(path).size > 0;
  if (!existed && !options.createIfMissing) {
    throw new NoDatabaseYet(path);
  }
  const db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  let succeeded = false;
  try {
    useWriteAheadLog(db);
    const result = inImmediateTransaction(db, () => {
      ensureSchema(db);
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
  // 旧格式的库随后会被拒绝，本工具不改它，所以也不切它的日志模式。
  if (existingTables(db).includes(LEGACY_TABLE)) return;
  const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  if (row.journal_mode.toLowerCase() !== "wal") {
    db.exec("PRAGMA journal_mode = WAL");
  }
}

/**
 * 这个库的来源表认不认「用户直接修改」。加入第四种来源之前建的库，来源表的种类检查只有三种，写这一种会被 SQLite 拒绝；
 * 库表改动不做迁移，这样的库在用户直接改字段时沿用旧做法（来源沿用条目当前的来源），由调用方据此判断。
 */
export function acceptsUserEditSource(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'item_source'").get() as { sql?: string } | undefined;
  // 只看种类检查里带单引号的取值；建表语句的列注释里也出现这几个字，不能算。
  return (row?.sql ?? "").includes(`'${SOURCE_USER_EDIT}'`);
}
