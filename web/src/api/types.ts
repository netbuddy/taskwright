// 接口约定（docs/api.md）的接口类型，字段名与约定逐字一致。
// 修订：一次保存（执行者的一次「保存修订」或用户的一次直接操作）产生一次修订，序号在任务内从 1 起连续递增；
// 条目没有自己的版本号，它在某一时刻的内容由「条目编号加修订号」标识。条目「当前所在的修订」是最近一次新增、修改或恢复它的那次修订。
// 约定里写「可空」的字段用 `| null`；约定没写、但前端必须容忍缺失的，用可选（`?`）。
// 前端遇到不认识的字段一律忽略，所以这里只列用得到的。

import type { DecisionRow, GoalTree, RulesTable } from "../../../agent/src/lib/overall_views.ts";
import type { LaunchView, StartHow } from "../../../agent/src/lib/stage.ts";

// ───────────── 共用 ─────────────

export type Actor = "executor" | "user";
/**
 * 来源的种类，也就是这个条目依据的是什么：材料或知识库里的原文、用户的话、助手补充（摘录里写的是理由）、任务里的另一个条目、
 * 任务里的一张图（图还没有做出来，现在不会收到）。早期版本的「执行者补充」「领域说明」，后端交来时已经换成「助手补充」「条目」。
 * 「用户直接修改」是早期版本在用户直接改字段时写的，现在不再写，后端也不再把它交给页面；取值留着，旧数据里还有。
 */
export type SourceKind = "文档原文" | "用户的话" | "助手补充" | "条目" | "图" | "用户直接修改";

/** 一条来源支持哪一处：某个字段，列表型字段还可以指到第几项。supports 为空数组＝支持整个条目。 */
export interface SourceSupport {
  field: string;
  index?: number | null;
  /** 只有助手补充的来源有：这一处补进正文的字串（逐字）。旧数据里可能没有。 */
  inserted?: string[];
}

export interface Source {
  kind: SourceKind | string;
  locator: string;
  excerpt: string;
  supports?: SourceSupport[];
  /** 下面三项只在种类是「条目」或「图」时有。引用那一刻对方的修订号；库里没有记下时为 null。 */
  depends_revision?: number | null;
  /** 对方现在的修订号；对方已经删除时为 null。 */
  current_revision?: number | null;
  /** 依据的现状：changed 是对方在引用之后改过（依据已变），deleted 是对方已经删除，null 是没有变。 */
  stale?: "changed" | "deleted" | null;
}

/** 图的列表里的一项：编号、图名、种类与中文名、它自己现在的修订号、最近一次是谁在什么时候改的、有几条来源。 */
export interface DiagramRow {
  diagram_id: string;
  name: string;
  kind: string;
  kind_name: string;
  revision_no: number;
  revision_by: Actor | string;
  revision_at: string;
  created_at: string;
  source_count: number;
  /**
   * 用户看没看过它现在的内容：从最近一次不是用户亲手改出来的修订起、到它现在的修订为止，有一次修订用户打开看过。
   * 助手改过之后要再看一次。早先的后端不给这一项，当作没看过。
   */
  viewed?: boolean;
}

/** 图里画的一个条目（从 Mermaid 文本里扫出来的条目编号）：live 还在，deleted 已经删除，missing 任务里没有这个编号。 */
export interface DrawnItem {
  item_id: string;
  title: string | null;
  state: "live" | "deleted" | "missing";
}

/** 一张图的详情（GET …/diagrams/{编号}）：列表里的各项，加 Mermaid 文本、说明、它改动过的修订号、来源、被谁依据（现在恒为空）与图里画了谁。 */
export interface DiagramDetail extends DiagramRow {
  deleted: boolean;
  mermaid: string;
  note: string;
  revisions: number[];
  sources: Source[];
  depended_by: DependedBy[];
  drawn: DrawnItem[];
}

/** 依据了某个条目的一个要素：种类（条目或图）、编号、它当前的修订号（图的是图自己的修订号）。 */
export interface DependedBy {
  element_kind: string;
  id: string;
  revision_no: number | null;
}

/** 字段的值：文本、文本列表、枚举（文字）、条目引用（条目编号列表）。 */
export type FieldValue = string | string[] | null;
export type Fields = Record<string, FieldValue>;

// ───────────── 4.2 完成条件 ─────────────

export interface CompletionCondition {
  collection: string;
  name: string;
  /** 门禁意义上的满足：集合为空（state 为 empty）时也为真。给人看的状态用 state。 */
  met: boolean;
  /** met 已满足、unmet 还差、empty 集合现在没有条目，这一条暂不需要核对。 */
  state?: "met" | "unmet" | "empty";
  done: number;
  total: number;
  missing: string[];
  note: string;
}

export interface Completion {
  all_met: boolean;
  /** 还差几项（state 为 unmet 的条数）。 */
  unmet_count?: number;
  /** 一句话概括，与执行者看到的说法相同。 */
  brief?: string;
  conditions: CompletionCondition[];
  /** 完成条件之外的提示，不是门禁。kind 为 untagged_overall_pages：业务说明里在用而还没有贴标签的主题。 */
  hints?: CompletionHint[];
}

export interface CompletionHint {
  kind: "untagged_overall_pages" | string;
  collection: string;
  items: string[];
  /** 一句完整的话，例如「有 2 页主题还没有贴标签：OA-003、OA-004。……」 */
  summary: string;
}

// ───────────── 4.1 整份数据 ─────────────

export interface FieldDef {
  name: string;
  type: "文本" | "文本列表" | "枚举" | "条目引用" | string;
  required: boolean;
  /** 枚举的取值；文本列表也可以有取值，这时列表里的每一项只能是其中之一（可以选好几个）。 */
  values: string[] | null;
  /** 条目引用字段：只能指向同一个集合里的条目。 */
  same_collection?: boolean;
  /** 条目引用字段：最多写一个条目编号。 */
  single?: boolean;
}

/** 评审规则清单里的一条（关闭与升为必选之后的）：必选规则违反了即评审不通过，可选规则只给建议。 */
export interface ReviewRule {
  id: string;
  level: "必选" | "可选" | string;
  text: string;
  counter_example?: string;
  example?: string;
}

export interface CollectionDef {
  name: string;
  prefix: string;
  fields: FieldDef[];
  /** 完成条件里对这个集合要求了「每个条目评审通过」。 */
  needs_review?: boolean;
  /** 显示方式（任务定义的「界面」一项）：group_field 按这个字段分组并在条目行上写成小标签，
   *  leading_groups 这几组按给定顺序排最前、其余按每组第一个条目的编号排，note 是写在这个集合页签下的一句白话。
   *  没写时为 null，照旧显示。 */
  display?: { group_field: string | null; leading_groups: string[]; note?: string | null } | null;
  /** 这个集合的评审规则清单；没写评审规矩的集合为 null（评审只按字段声明）。 */
  review_rules?: ReviewRule[] | null;
  /** 规则文件里的全部规则，连同这个任务的开关状态；给评审页签的规则区用。 */
  all_rules?: (ReviewRule & { state: "required" | "optional" | "off" | "promoted" | string })[] | null;
  /** 这个任务对这个集合的规则开关。 */
  rule_switches?: { off: string[]; promote: string[] } | null;
  /** 规则指纹：规则文件内容加开关算出；为空时不按指纹区分评审记录。 */
  rules_hash?: string | null;
}

export interface TaskDefinition {
  collections: CollectionDef[];
}

/** 一条评审发现：依据的规则编号与级别（必选的叫问题，可选的叫建议）、字段、列表型字段的第几项（从 0 起）、问题、改法。 */
export interface Finding {
  rule_id?: string | null;
  level?: "必选" | "可选" | string | null;
  field: string;
  index: number | null;
  problem: string;
  suggestion: string | null;
}

export interface Review {
  /** 被评审的是条目在哪次修订下的内容；标记不随后续修订移动。 */
  revision_no?: number;
  verdict: "合规" | "不合规" | string;
  /** 程序按规则条数与发现记下的一句话，例如「按 14 条规则逐条核对，没有发现问题。」；早期的数据可能没有。 */
  reason?: string | null;
  findings?: Finding[];
  at?: string;
  /** 所属的那一次评审（批次）编号；早期记录为空。 */
  batch_id?: string | null;
  /** 评审时的规则指纹；早期记录为空。 */
  rules_hash?: string | null;
  /** 早期「仍要重评」写下的记录为真；现在同一次修订、同一套规则只评一次，新记录恒为假。读的时候与别的记录同样对待。 */
  forced?: boolean;
  /** 记下这条评审的事件序号，认先后用（同一修订上以最后一条为准，保留要在它之后）；早期的后端不给。 */
  seq?: number;
}

/** 用户保留了评审不合规的写法（评审豁免）。条目改出新修订后不再作数；撤销后 revoked 为真。 */
export interface Waiver {
  revision_no: number;
  reason: string | null;
  source?: "detail" | "panel" | string;
  at?: string;
  revoked?: boolean;
  /** 记下这次保留的事件序号：保留只对它之前的最后一条评审作数；早期的后端不给。 */
  seq?: number;
}

/** 一次评审（批次）：第几次、谁发起、范围与计数。 */
export interface ReviewBatch {
  no: number;
  batch_id: string;
  at: string;
  started_by: "user" | "executor" | string;
  scope: "pending" | "named" | string | null;
  items: { item_id: string; revision_no: number }[];
  forced?: string[];
  total: number;
  passed: number;
  failed: number;
  unfinished: number;
  problems: number;
  advice: number;
}

/**
 * 确认标记的依据。viewed：用户打开详情或在卡片上点「这几条都看过了」（已读）；ui_edit：改字段或标为先不管时随修订自动写；
 * ui_click：早先版本的撤回确认（更早的版本还有点了确认的），接口已经不再接受这两种操作，库里已有的照常显示；user_words：早期版本由执行者登记、依据是用户在对话里说的话。
 */
export type ConfirmationBasis = "viewed" | "ui_click" | "ui_edit" | "user_words";

export interface Confirmation {
  /** 用户看过或认可的是条目在哪次修订下的内容；标记不随后续修订移动。 */
  revision_no: number;
  /** 接受：看过或认可了；不接受：撤回了确认。 */
  accepted: boolean;
  basis?: ConfirmationBasis | string;
  at?: string;
}

export interface Item {
  item_id: string;
  collection: string;
  title: string;
  /** 条目当前所在的修订。 */
  revision_no: number;
  revision_by: Actor | string;
  revision_at: string;
  /** 它改动过的修订号，从早到晚。 */
  revisions: number[];
  fields: Fields;
  sources: Source[];
  /** 被谁依据：把这个条目写成来源的别的条目与图（只数它们当前的修订），没有时是空列表。 */
  depended_by?: DependedBy[];
  reviews: Review[];
  /** 保留记录（含已撤销的）；旧后端没有这一项。 */
  waivers?: Waiver[];
  confirmations: Confirmation[];
  confirmation_stale: boolean;
  /**
   * 已读：条目在任何一次修订上有过一条接受的确认标记（任一依据）；为假就是未读。已读是条目级、单向的，
   * 之后条目被改、或库里有早先版本的撤回确认，都不会变回未读。前端按 confirmations 现算，这两项只作对照。
   */
  viewed?: boolean;
  /** 已读的依据：当前修订上最近一条标记是接受时取它的依据，否则取最近一条接受的标记的依据；未读时为空。 */
  confirmation_basis?: ConfirmationBasis | string | null;
  /** 待核实：当前修订上有助手补充的来源，而用户还没有确认过。看过（或点了确认）是确认整个条目；亲手改只确认改到的那几处。 */
  pending_verification?: boolean;
  /** 还待核实的助手补充来源有几条；不待核实时是 0。 */
  pending_sources?: number;
  /** 还待核实的各处：字段与（列表字段的）第几项，从 0 起；field 为 null 指整个条目。 */
  pending_places?: { field: string | null; index: number | null }[];
  /** 因依据而待核实：它依据的业务说明的一页待核实（pending）或已废弃（deprecated，see 是那一页写的改看）；没有是 null。 */
  basis_pending?: { item_id: string; reason: "pending" | "deprecated" | string; see: string | null } | null;
  /** 只有业务说明的页有：别的页与别的条目的文字里提到它的地方，一处都没有是空列表。 */
  mentioned_by?: Mention[];
}

/** 一条提到：哪个条目的哪个字段（列表字段的第几项，从 0 起）在哪句话里用哪个词提到了一页；revision_no 是被提到的那一页现在的修订号。 */
export interface Mention {
  item_id: string;
  collection: string;
  field: string;
  index: number | null;
  word: string;
  sentence: string;
  revision_no: number;
}

/** 整份任务数据里的三张表；形状由助手一侧算它们的那个文件定（页面可以直接导入）。 */
export interface OverallViews {
  rules: RulesTable;
  goals: GoalTree;
  decisions: DecisionRow[];
}

export interface Task {
  task_id: string;
  task_name: string;
  task_type: string;
  domain_tag: string | null;
  started_at: string;
  definition: TaskDefinition;
  completion: Completion | null;
  items: Item[];
  /** 任务最新的修订号；还没有修订时是 0。 */
  latest_revision?: number;
  /** 任务里还在的图（图是任务的另一种要素，不是条目；内容与来源另由图的接口取）。早先的后端不给这一项。 */
  diagrams?: DiagramRow[];
  /** 评审批次，按先后；旧后端没有这一项。 */
  review_batches?: ReviewBatch[];
  /**
   * 从业务说明的页与问题条目算出来的三张表（只算不存）：rules 规则表，goals 业务目标，decisions 决策记录与待澄清事项。
   * 没有「业务说明」集合的任务是 null；早先的后端不给这一项。库事件里不带它，与待核实那几项一起另取（state/workState.ts 的 facts）。
   */
  overall_views?: OverallViews | null;
  /** 任务现在的工作阶段与每个阶段的几盏灯；早先建的任务（没有「业务说明」集合）没有阶段，是 null；旧后端没有这一项。 */
  stage?: StageView | null;
  /** 发布过的各版，按版本号从小到大；早先的后端不给。 */
  versions?: VersionView[];
}

/**
 * 发布过的一版（GET …/versions 的一项，任务状况与整份数据里的 versions 相同）：版本号、发布的时刻、谁发布的、发布时交付物的修订号、
 * 发布说明、文档里有几张图与其中几张在 Word 里是图片（一张图都没有、或者没有存档时都是 null），以及这一版的 Markdown 与 Word 存档在不在
 * （从早先「已完成」升级来的第 1 版两样都没有）。
 */
export interface VersionView {
  version_no: number;
  published_at: string | null;
  actor: "executor" | "user";
  revision_no: number;
  note: string | null;
  figure_count: number | null;
  figure_pictures: number | null;
  has_markdown: boolean;
  has_docx: boolean;
}

/**
 * 用户的一句话带着的阶段移动：用户在卡片上点了进入下一段或者退回前面的阶段，系统替用户记了这次移动。阶段只由用户移动。
 * from 是移动之前任务在哪里（任务空闲时用户点了「开始核读材料」，是 idle）；how 是这一次怎样开始的：流程里的移动（move）、
 * 启动需求分析（launch）、继续需求分析（resume）。早先的消息没有 how，当作 move。
 */
export interface StageMove {
  from: PositionKey;
  to: StageKey;
  actor: "user";
  how?: StartHow;
}

/** 工作的六个阶段：核读材料、澄清、整理建模、写条目、评审确认、编写文档。它们也是六项可以开展的活动。 */
export type StageKey = "reading" | "clarifying" | "modeling" | "writing" | "reviewing" | "document";
/** 任务现在在哪里：六个阶段之一，或者空闲（没有在进行的活动；新建的任务从空闲起）。 */
export type PositionKey = StageKey | "idle";
/** 「开展一项活动」一节的内容与其中可以点的一项、一项活动怎样开始的：定义在助手一侧（agent/src/lib/stage.ts），后端算好，页面只渲染。 */
export type { LaunchOption, LaunchView, StartHow } from "../../../agent/src/lib/stage.ts";

/** 一盏灯：某个阶段「做到什么算够」的一条判据。ok 为 null 是不适用；items 是差的页、条目或材料。灯只提示，不拦操作。 */
export interface StageLamp {
  key: string;
  summary: string;
  ok: boolean | null;
  items: string[];
}

/**
 * 开着的提议：助手发了一张提议进入下一个阶段的卡片，任务还没有进入。提议一直开着，直到任务的阶段有过一次移动、助手又发了一张这样的卡片、
 * 或者任务不再进行中。stage 是要进入的阶段；enter 与 stay 是卡片上进入与留在这一段的两个选项（没有留在这一段的选项时 stay 为 null）；
 * text 是卡片的问句；items 是点名请用户先看的条目；session_id 与 reply_message_id 指出卡片在哪条会话的哪条回复上；
 * event_seq 与 at 是记下它的那条库事件的序号与时刻。
 */
export interface StageProposal {
  /** 哪一种提议：enter 进入下一段，back 退回前面的阶段，review 请用户过目补写的页（点了不移动阶段）。早先的后端不给，当作 enter。 */
  kind?: "enter" | "back" | "review";
  stage: StageKey;
  enter: { key: string; text: string };
  stay: { key: string; text: string } | null;
  text: string;
  items: { item_id: string; revision_no: number | null }[];
  session_id: string | null;
  reply_message_id: string | null;
  event_seq: number;
  at: string | null;
}

/** 任务现在在哪个阶段、最近一次是谁在什么时候为什么移的（一次都没有移过时三项为 null），六个阶段各自的灯，以及开着的提议（没有时为 null）。 */
export interface StageView {
  /** 任务现在在哪个阶段；空闲时是 idle。 */
  current: PositionKey;
  /** 现在这项活动在需求分析流程里的节点：在流程里时与 current 相同；用户单独开展的活动、空闲时为 null。早先的后端不给。 */
  node?: StageKey | null;
  /** 需求分析走到的节点；没有走过是 null。 */
  flow_node?: StageKey | null;
  /** 「开展一项活动」一节现在的内容。 */
  launch?: LaunchView | null;
  moved_by: "executor" | "user" | null;
  moved_at: string | null;
  reason: string | null;
  lamps: Record<StageKey, StageLamp[]>;
  proposal?: StageProposal | null;
  /** 所属流程：这条会话正在做的工作项属于哪条流程（现在只有需求分析 analysis）；单项活动的工作项、会话空闲时为 null。 */
  flow?: string | null;
  /** 这条会话属于的工作项（不论它是不是已经结束）；自由讨论的会话为 null。早先的后端不给。 */
  work_item?: WorkItemBrief | null;
  /** 用户启动这条会话的工作项时写的范围说明；没有写、会话空闲时为 null。 */
  scope?: string | null;
}

export interface Material {
  path: string;
  bytes: number;
  modified_at: string;
  /** 由哪份材料生成（Word 材料的投影 x.docx.md 写 x.docx 的路径）；界面不单独列出这类文件。原始材料为 null。 */
  derived_from?: string | null;
  /** PDF 材料才有：页数、读出了多少块文字、没有读出文字的是哪几页（页码，多半是扫描件；都读出了时是空的）。 */
  pdf?: { pages: number; units: number; no_text_pages: number[] } | null;
  /** 现在能不能删除（只有任务详情里给）：任务进行中、不是派生文件、还没有进入对话（上传之后没有任何会话有过活动）。能不能替换也看它。 */
  deletable?: boolean;
}

export type ExecutorStateName = "not_started" | "starting" | "idle" | "working" | "exited" | "failed_to_start";

export interface ExecutorState {
  state: ExecutorStateName | string;
  text: string;
  active_session: string | null;
}

export interface SessionInfo {
  session_id: string;
  name: string;
  started_at: string;
  last_active_at: string;
}

export interface SessionListEntry extends SessionInfo {
  message_count: number;
  active: boolean;
  /** 这条会话产生了几次修订；旧后端没有这一项。 */
  revision_count?: number;
  /** 这条会话属于的工作项；自由讨论的会话、归档的会话为 null。早先的后端不给。 */
  work_item?: { record_id: number; kind: "flow" | "activity"; name: string; activity: StageKey; flow: string | null } | null;
  /** 带 archived=1 取清单时才有：是不是归档的会话（它的工作项被删除了）、归档的时刻、它曾属于的那个已经删除的工作项的记录号。 */
  archived?: boolean;
  archived_at?: string | null;
  archived_record_id?: number | null;
}

/** 一条会话属于的工作项里页面用的几样（整份数据的 stage.work_item）。 */
export interface WorkItemBrief {
  record_id: number;
  /** flow 是流程的工作项，activity 是单项活动的工作项。 */
  kind: "flow" | "activity";
  /** 工作项的名字：流程的名字或者活动的名字。 */
  name: string;
  /** 现在做的是哪一项活动。 */
  activity: StageKey;
  flow: string | null;
  scope: string | null;
  started_at: string | null;
}

/** 任务状况里的一个工作项（work_items 的每一项）。 */
export interface WorkItemView extends WorkItemBrief {
  activity_name: string;
  /** 流程的工作项现在在哪一站，与那一站是第几站；单项活动的为 null。 */
  node: StageKey | null;
  ordinal: number | null;
  /** 属于它的会话（按挂上的先后）与条数。 */
  session_ids: string[];
  session_count: number;
  /** 最近有动静的那条会话；都还没有说过话时是最后挂上的那一条；一条会话都没有时为 null。 */
  latest_session: { session_id: string; name: string | null; last_active_at: string | null } | null;
  last_active_at: string | null;
  /** 现在给它新建一条会话时，那条会话起的名字。 */
  session_name: string;
}

// ───────────── 5.3 回复的形状 ─────────────

export type ActKind = "ask" | "confirm" | "suggest" | "choose" | "propose";

export interface ActItemRef {
  item_id: string;
  /** 条目当前所在的修订号。 */
  revision_no?: number;
}

/** 回复里的一条告知。告知不等用户回应，不画卡片。 */
export interface Inform {
  text: string;
  items?: ActItemRef[];
}

export interface Act {
  kind: ActKind;
  text: string;
  items?: ActItemRef[];
  options?: { key: string; text: string }[];
  value?: string;
  basis?: Source[];
  preview?: { effect: "remove" | "add" | "change"; text: string }[];
  /** 与任何条目都无关的问题写 "general"，这时 items 可以为空。 */
  scope?: "general";
  /** 这张卡片是把先前一张没有答的卡片重发一遍时，助手写的那一张的行为编号；页面不用它，认回复上的 resends_card。 */
  resends?: string;
}

// ───────────── 3.2 过程与对话类事件，也是 conversation.messages 里的条目 ─────────────

export interface UserMessage {
  type: "user_message";
  session_id?: string;
  message_id: string | null;
  at: string;
  text: string;
  origin: "typed" | "card_choice" | "ui_request" | string;
  /**
   * 这句话是在哪张卡片上发的：点卡片上的选项（origin 为 card_choice）与在卡片的文本框里打字（origin 仍为 typed，option_key 为 typed）
   * 都带 reply_message_id（卡片所在回复的编号）；底部输入框打的字是 null。
   */
  annotation: unknown | null;
  queued: boolean;
  client_id?: string;
  /** 用户在卡片上点了进入下一段、系统替用户记了移动时才有：从哪个阶段、到哪个阶段。 */
  stage_move?: StageMove;
  /**
   * 用户点了一张进入某个阶段的卡片而阶段没有移动时才有（次序不对，或者任务本来就在那个阶段）：任务当时在哪个阶段。
   * why 为 not_in_flow 是任务当时不在需求分析流程里（空闲，at 是 idle；或者正在单独开展一项活动），进入与退回不算数。
   */
  stage_unmoved?: { at: string; why?: string; blocked?: string };
}

export interface AssistantReply {
  type: "assistant_reply";
  session_id?: string;
  message_id: string;
  at: string;
  work_id: string | null;
  via_reply_tool: boolean;
  /** 告知：一句话，说到某个条目时 items 点名它（画成条目链接）。后端把旧会话里的纯文字告知也整理成这个样子。 */
  informs: Inform[];
  act: Act | null;
  text: string;
  /** 连续被拒到上限后放行的纯文字回复；为真时照普通文字显示并加一行说明。 */
  degraded?: boolean;
  /** 助手在这条回复里汇报用户单独开展的那项活动做完了时才有：结束的是哪一项活动。任务随之空闲。 */
  activity_done?: { activity: StageKey };
  /** 用户在它之前的那句话回答了哪几张卡片（卡片所在回复的编号）：用户在卡片之外说的话，由助手按上下文判断是不是在回答卡片。没有时不带。 */
  answers_card?: string[];
  /** 这条回复的卡片重发的是哪一条回复的卡片（用户搁下没有答，助手再问一遍）。不是重发时不带。 */
  resends_card?: string;
}

export interface UiActionNoted {
  type: "ui_action_noted";
  session_id?: string;
  message_id: string;
  at: string;
  text: string;
  event_seq: number | null;
  undoable: boolean;
  /** 与后端对齐后新增：撤销要用的修订序号；已读这类不产生修订的操作为 null。 */
  revision_no?: number | null;
  op_id?: string | null;
  /**
   * 界面操作的种类；评审结束的那条是 request_review，另带 review 计数；用户停止了助手一次工作之后留的那条是 stop_run；
   * 用户在提议进入下一个阶段的卡片上选了「继续本阶段」之后留的那条是 continue_stage，另带下面两项。
   */
  kind?: string | null;
  /** continue_stage 才有：卡片在哪条回复上、卡片是关于哪个阶段的、点的是卡片上哪一项（早先的后端不给最后一项，当作留在这一段的那一项）。 */
  reply_message_id?: string;
  stage?: StageKey;
  option_key?: string;
  review?: { total: number; passed: number; failed: number; unfinished: number; problems: number; advice: number } | null;
}

export interface SystemNote {
  type: "system_note";
  session_id?: string;
  message_id: string;
  at: string;
  text: string;
  /** task_status：每条会话开头写给助手看的任务状况消息；reply_fallback：助手没有用回复工具说话时系统提醒它的那一句。旧数据里没有这一项。 */
  kind?: "task_status" | "reply_fallback" | string;
  /** 任务状况消息的事实（材料清单、知识库清单、完成条件的几个数、未解决的问题条数；续接时是新增、修改、删除的条目与新材料）。对话区拿它写折叠起来的那一行，见 model/statusNote.ts。 */
  details?: Record<string, unknown> | null;
}

/** 每次工作的过程摘要（4.1 节）：做了几步、用了多久、合并后的阶段。 */
export interface WorkSummary {
  type: "work_summary";
  session_id?: string;
  message_id?: string;
  work_id: string;
  at?: string;
  seconds: number | null;
  step_count: number;
  /** reasons：保存修订被拒的那一步的全部原因，一个操作一条；多于一条时这一行可以点开逐条看。 */
  stages?: { text: string; count?: number; reasons?: string[] }[];
  /** 「理解为：……」：执行者对触发这次工作的那句话的理解；还没有合格的理解时是一句说明：事实核对不过时「助手的理解里有对不上的地方，正在重写」，
   *  只写了没匹配上格式的片段时「助手的理解正在重写」，一轮结束仍没有时「助手这一轮没有写下理解」；
   *  界面点击替用户发的那句话没有这一行，为空。 */
  understanding?: string | null;
  /**
   * 这次工作怎样结束，取值与 work_ended 相同；被停下（stopped_by_user）、出错停下（failed）、助手连续被拒到上限由系统停下
   * （stopped_by_limit）时摘要行下面加一行说明。旧数据没有这个字段。
   */
  outcome?: WorkEnded["outcome"] | null;
  /**
   * 只有被用户停下的那次工作有：它实际保存了什么，后端停下之后按任务库算（不看会话里有没有工具结果）。revisions 是保存的任务修订号，
   * 从小到大；items 是这些修订碰到的条目个数；diagrams 是保存过的图的张数（图的修订号各算各的）。后端没法查时为 null，旧数据没有这个字段。
   */
  saved?: SavedFacts | null;
}

export interface SavedFacts {
  revisions: number[];
  items: number;
  diagrams: number;
}

export type ConversationMessage = UserMessage | AssistantReply | UiActionNoted | SystemNote | WorkSummary;

export interface Step {
  work_id: string;
  step_key: string | number;
  text: string;
  in_progress: boolean;
  failed: boolean;
}

export interface CurrentWork {
  work_id: string;
  started_at: string;
  triggered_by: string | null;
  steps: Step[];
}

export interface Snapshot {
  seq: number;
  generated_at: string;
  executor: ExecutorState;
  session: SessionInfo | null;
  task: Task | null;
  materials: Material[];
  conversation: { messages: ConversationMessage[]; has_earlier: boolean; earliest_id: string | null };
  current_work: CurrentWork | null;
  /**
   * 正在进行的一批评审，形状与评审进度事件里的几项相同；没有、助手不在运行、或者进度写于这个助手启动之前时为 null。
   * 早于 0.4 的后端没有这一项。
   */
  review_in_progress?: ReviewInProgress | null;
}

export interface ReviewInProgress {
  op_id: string;
  done: number;
  total: number;
  current: string[];
}

// ───────────── 3.1 库事件 ─────────────

export interface Operation {
  /** restore：撤销一次删除，条目恢复成删除前的样子。 */
  op: "add" | "update" | "delete" | "restore";
  collection: string;
  item_id: string;
  title: string;
  /** 改前条目所在的修订（新增时为空）与改后所在的修订（就是这次修订；删除时为空）。 */
  revision_before: number | null;
  revision_after: number | null;
  fields: Fields | null;
  sources: Source[];
}

export interface DeliverableChanged {
  seq: number;
  at: string;
  task_id: string;
  revision_no: number;
  actor: Actor | string;
  op_id: string | null;
  undo_of_revision: number | null;
  operations: Operation[];
  completion: Completion | null;
}

/** 一张图新增、修改或删除了一次。revision_no 是图自己改后的修订号；内容与来源由图的详情接口取。 */
export interface DiagramChanged {
  seq: number;
  at: string;
  task_id: string;
  actor: Actor | string;
  op_id?: string | null;
  diagram_id: string;
  revision_no: number;
  op: "add" | "update" | "delete";
  name: string;
  kind: string;
  kind_name: string | null;
}

export interface TaskChanged {
  seq: number;
  at: string;
  task_id: string;
  task_name: string;
  actor: Actor | string;
  completion: Completion | null;
}

export interface ReviewRecorded {
  seq: number;
  at: string;
  task_id: string;
  item_id: string;
  revision_no: number;
  verdict: string;
  reason?: string;
  findings: Finding[];
  /** 用户在界面上发起的评审是那次操作的编号，执行者经工具发起的为 null。 */
  op_id?: string | null;
  batch_id?: string | null;
  rules_hash?: string | null;
  forced?: boolean;
  completion: Completion | null;
}

/** 评审没有完成（超时、调用失败、输出两次不合格、评审期间条目被改）：不记合规与否。 */
export interface ReviewUnfinished {
  seq: number;
  at: string;
  task_id: string;
  item_id: string;
  revision_no: number;
  reason: string;
  op_id?: string | null;
  completion: Completion | null;
}

/** 界面发起的评审的进度：开始时一条（done 为 0），每评完一条一条。current 是此刻正在评的条目。 */
export interface ReviewProgress {
  seq: number;
  at: string;
  task_id: string;
  op_id: string;
  done: number;
  total: number;
  current: string[];
  /** 刚评完的条目；开始时那条为 null。 */
  item_id: string | null;
  completion: Completion | null;
}

/** 一次评审（批次）结束时的摘要。 */
export type ReviewBatchEvent = ReviewBatch & { seq: number; task_id: string; completion: Completion | null };

/** 用户保留或撤销保留：每项是条目与那次修订。 */
export interface ReviewWaived {
  seq: number;
  at: string;
  task_id: string;
  items: { item_id: string; revision_no: number }[];
  reason?: string | null;
  source?: string | null;
  op_id?: string | null;
  completion: Completion | null;
}

/** 用户改了一个集合的评审规则开关：带这个集合评审部分的新样子。 */
export interface ReviewRulesChanged {
  seq: number;
  at: string;
  task_id: string;
  collection: string;
  off: string[];
  promote: string[];
  op_id?: string | null;
  review_rules?: ReviewRule[] | null;
  all_rules?: CollectionDef["all_rules"];
  rule_switches?: CollectionDef["rule_switches"];
  rules_hash?: string | null;
  completion: Completion | null;
}

/** 界面发起的评审全部评完：合规、不合规、评审未完成各几条。 */
export interface ReviewFinished {
  seq: number;
  at: string;
  task_id: string;
  op_id: string;
  total: number;
  passed: number;
  failed: number;
  unfinished: number;
  results: { item_id: string; revision_no: number; status: string }[];
  error: string | null;
  completion: Completion | null;
}

export interface ConfirmationRecorded {
  seq: number;
  /** 与后端对齐后新增，与 deliverable_changed 一致，前端靠它消去「正在保存」。 */
  op_id?: string | null;
  at: string;
  task_id: string;
  items: { item_id: string; revision_no: number; accepted: boolean }[];
  basis: ConfirmationBasis | string;
  completion: Completion | null;
}

/** 用户打开条目详情（或在卡片上点「这几条都看过了」）记为已读：每项是条目与它当时所在的修订。 */
export interface ItemViewed {
  seq: number;
  op_id?: string | null;
  at: string;
  task_id: string;
  items: { item_id: string; revision_no: number }[];
  completion: Completion | null;
}

/** 用户打开看了一张或几张图：每项是图的编号与用户看到的那一次修订号（图自己的修订号）。 */
export interface DiagramViewed {
  seq: number;
  op_id?: string | null;
  at: string;
  task_id: string;
  diagrams: { diagram_id: string; revision_no: number }[];
}

/**
 * 库事件 activity_started 的内容：启动了一个工作项——哪个工作项（record_id）、做的是哪一项活动（to）、谁启动的、理由；用户启动的带操作编号。
 * 流程的工作项另有所属流程与启动的那一站，单项活动的这两项为 null。早先（会话与工作项绑定之前）它说的是任务从一个阶段移到另一个：
 * 没有 record_id，from 是从哪个阶段来。页面不照它改阶段：阶段是按会话算的，看这一批最后一条库事件带的 stage。
 */
export interface StageChanged {
  seq: number;
  at: string;
  task_id: string;
  /** 工作项的记录号；早先记下的事件为 null。 */
  record_id?: number | null;
  to: StageKey;
  from: StageKey | null;
  actor: "executor" | "user" | string;
  reason: string;
  run_id: string | null;
  /** 所属流程（analysis 是需求分析；早先的键 initial 也是它）；单项活动的工作项为 null。 */
  flow?: string | null;
  /** 流程的工作项启动的那一站，与 to 相同；单项活动的为 null。 */
  node?: string | null;
  /** 用户启动时写的范围说明；没有写不带这一项。 */
  scope?: string;
  op_id?: string | null;
  completion: Completion | null;
}

/** 库事件 node_entered 的内容：流程的工作项换了一站——哪个工作项、到哪一站、从哪一站、往前还是往后、谁、理由。 */
export interface NodeEntered {
  seq: number;
  at: string;
  task_id: string;
  record_id: number | null;
  flow: string | null;
  node: StageKey;
  from: StageKey | null;
  direction: "forward" | "back" | null;
  actor: "executor" | "user" | string;
  reason: string;
  run_id: string | null;
  op_id?: string | null;
  completion: Completion | null;
}

/** 库事件 work_item_deleted 的内容：用户删除了一个工作项——哪个工作项、它做的是哪一项活动、所在的一站与所属流程、随之归档了几条会话、谁、理由。 */
export interface WorkItemDeleted {
  seq: number;
  at: string;
  task_id: string;
  record_id: number | null;
  activity: StageKey | null;
  node: string | null;
  flow: string | null;
  scope?: string;
  archived_sessions: number;
  actor: "executor" | "user" | string;
  reason: string;
  op_id?: string | null;
  completion: Completion | null;
}

/**
 * 助手发了一张提议进入下一个阶段的卡片。任务现在开着的是哪一条提议，看这一批最后一条库事件上的 stage.proposal
 * （这张卡片之后阶段又移动过的话，那里已经是 null）。
 */
export interface StageProposed {
  seq: number;
  at: string;
  task_id: string;
  actor: "executor" | string;
  run_id: string | null;
  proposal: StageProposal;
  completion: Completion | null;
}

/**
 * 库事件：有序号（SSE 的 id 行），可补发。有阶段的任务，每一批最后一条库事件（不论哪一种）另带 stage：
 * 现在的阶段与灯，与整份数据里 task.stage 同一个形状。
 */
export type LibraryEvent =
  | { event: "stage_proposed"; data: StageProposed }
  | { event: "deliverable_changed"; data: DeliverableChanged }
  | { event: "task_changed"; data: TaskChanged }
  | { event: "review_recorded"; data: ReviewRecorded }
  | { event: "review_unfinished"; data: ReviewUnfinished }
  | { event: "review_progress"; data: ReviewProgress }
  | { event: "review_finished"; data: ReviewFinished }
  | { event: "review_batch"; data: ReviewBatchEvent }
  | { event: "review_waived"; data: ReviewWaived }
  | { event: "review_unwaived"; data: ReviewWaived }
  | { event: "review_rules_changed"; data: ReviewRulesChanged }
  | { event: "confirmation_recorded"; data: ConfirmationRecorded }
  | { event: "item_viewed"; data: ItemViewed }
  | { event: "diagram_changed"; data: DiagramChanged }
  | { event: "diagram_viewed"; data: DiagramViewed }
  | { event: "activity_started"; data: StageChanged }
  | { event: "node_entered"; data: NodeEntered }
  | { event: "work_item_deleted"; data: WorkItemDeleted };

export const LIBRARY_EVENTS = [
  "stage_proposed",
  "deliverable_changed", "task_changed", "review_recorded", "review_unfinished", "review_progress", "review_finished", "confirmation_recorded", "item_viewed",
  "review_batch", "review_waived", "review_unwaived", "review_rules_changed", "diagram_changed", "diagram_viewed", "activity_started", "node_entered", "work_item_deleted", "version_published",
] as const;

export interface WorkStarted {
  session_id: string;
  work_id: string;
  at: string;
  triggered_by: string | null;
}

export interface WorkEnded {
  session_id: string;
  work_id: string;
  at: string;
  seconds: number;
  step_count: number;
  outcome: "replied" | "no_reply" | "stopped_by_user" | "failed" | "stopped_by_limit" | string;
}

/** 上传材料成功之后后端推的过程类事件（小修新增）。材料属于任务，session_id 只说明从哪条会话上传（可空）。 */
export interface MaterialAdded {
  session_id: string | null;
  at: string;
  path: string;
  bytes: number;
  modified_at: string;
  /** 这份材料是替换上来的：被它换掉的那份材料的路径（两份可以同名）。 */
  replaces?: string;
}

/** 删除了一份材料（material_removed）：path 是那份材料；由它生成的文件一并删掉了，不另发。 */
export interface MaterialRemoved {
  session_id: string | null;
  at: string;
  path: string;
  /** 这份材料是被替换掉的：换上来的那份材料的路径，紧接着有一条它的 material_added。 */
  replaced_by?: string;
}

export interface Problem {
  session_id?: string;
  code: string;
  text: string;
  /** 模型服务暂时不可用、pi 自动重试时才有：第几次重试、隔多少毫秒再试（pi 没说时为 null）。 */
  retry: { attempt: number | null; delay_ms: number | null } | null;
}

// ───────────── 4.3 按需读取 ─────────────

export interface TaskListEntry {
  task_id: string;
  task_name: string;
  task_type: string;
  domain_tag: string | null;
  /** 打不开时写明是哪一种：占用中、旧格式、需要升级、需要处理、需要更新的程序；打得开的任务是 null。 */
  unavailable: string | null;
  item_count: number;
  completion_met: number | null;
  completion_total: number | null;
  completion_unmet?: number | null;
  /** 进展：流程工作项（名字、在哪一站、第几站；没有流程工作项时为 null）、工作项个数、未了结的阻断下游的问题有几条；打不开的任务都是 null，早先的后端不给。 */
  flow?: { name: string; node: string; node_name: string; ordinal: number } | null;
  work_item_count?: number | null;
  blocking_count?: number | null;
  /** 发布过几版、最近一版的发布时刻；打不开的任务是 null，没有发布过是 0 与 null。列表上不显示（版本在起点页与工作台里看）。 */
  version_count: number | null;
  latest_published_at: string | null;
  /** 最近活动：会话里最近一条消息、最近一次启动或结束工作项、建任务，取最晚的那个时刻。 */
  last_active_at: string;
  session_count: number;
  /** 为假时列出来但打不开，note 写明原因：格式太早的旧格式任务，或者正被别的服务占用（这时有 occupied）。 */
  supported?: boolean;
  note?: string;
  /** 正被别的服务占用：那个服务的端口、进程号、主机名。 */
  occupied?: { port: number | null; pid: number | null; host: string | null } | null;
}

export interface TaskDetail extends Task {
  materials: Material[];
  sessions: SessionListEntry[];
  /** 这个任务选用的库的编号；没有知识库的旧后端不给。 */
  knowledge_libraries?: string[];
  /**
   * 任务类型说明的版本：copied 是这个任务建的时候复制进任务目录的那一版，current 是产品自带的现在这一版。
   * 说明不随程序升级更新，两个数都有而且不同时任务页写一句。上一版建的任务没有记，copied 是 null。
   */
  task_type_versions?: { copied: number | null; current: number | null };
}

/** 知识库文档的种类：只是标签，不决定用法。 */
export type KnowledgeKind = "standard" | "glossary" | "template" | "past_work" | "other";

export interface KnowledgeDocument {
  name: string;
  kind: KnowledgeKind;
  bytes: number;
  uploaded_at: string;
}

/** 知识库里的一个库（GET /api/v1/knowledge 的一项）。used_by_tasks 是本服务接手的进行中任务里选用了它的个数。 */
export interface KnowledgeLibrary {
  id: string;
  name: string;
  created_at: string;
  used_by_tasks: number;
  documents: KnowledgeDocument[];
}

/**
 * 一份文档的向量化状态。按意思查找之前，文档要先切成片段、用嵌入模型向量化成数字串。none：未向量化；queued：等待向量化；running：向量化中；
 * done：已向量化；failed：向量化失败，error 是原因。done 与 total 是片段数：已向量化时两个数相同，向量化中是算完了几个、一共几个
 * （还没有切好时 total 是 null），别的状态是 null。model 是用的嵌入模型「服务名/型号」，没有时是 null。
 */
export interface DocumentEmbedding {
  status: "none" | "queued" | "running" | "done" | "failed";
  model: string | null;
  error: string | null;
  done: number | null;
  total: number | null;
}

/**
 * 全部知识库合起来的向量化情况。model 是现在选定的嵌入模型「服务名/型号」，没有选是 null；running 是有文档正在算或者在队里；
 * ready 是选了嵌入模型而且文档都向量化完成；pending 是还没有向量化的份数，total 是文档一共多少份；stopped_reason 是上一次整个向量化停下的原因。
 */
export interface KnowledgeEmbedding {
  model: string | null;
  running: boolean;
  ready: boolean;
  pending: number;
  total: number;
  stopped_reason: string | null;
}

/** 知识库页面用的清单（GET /api/v1/knowledge 的全部内容）：每个知识库另带「向量化完成几份、一共几份」，每份文档另带向量化状态。 */
export interface EmbeddedDocument extends KnowledgeDocument {
  embedding: DocumentEmbedding;
}
export interface EmbeddedLibrary extends Omit<KnowledgeLibrary, "documents"> {
  embedding: { done: number; total: number };
  documents: EmbeddedDocument[];
}
export interface KnowledgeOverview {
  libraries: EmbeddedLibrary[];
  embedding: KnowledgeEmbedding;
}

/**
 * 按意思查找查到的一个片段（POST /api/v1/knowledge/search 的 hits 的一项）。score 是相近程度，越大越相近；title 是片段的标题，没有是 null。
 * 位置：Word 文档给起止段落号，PDF 文档给起止的页与块，别的文档给起止行号，用不上的几项是 null。locator 是引用这份文档作来源时出处的写法。
 */
export interface KnowledgeSearchHit {
  score: number;
  library: string;
  library_name: string;
  name: string;
  kind: KnowledgeKind;
  title: string | null;
  first_paragraph: number | null;
  last_paragraph: number | null;
  first_line: number | null;
  last_line: number | null;
  /** PDF 文档起止的那两块（页与块号）；别的文档是 null，更早的任务服务不给这两项。 */
  first_unit?: { page: number; block: number } | null;
  last_unit?: { page: number; block: number } | null;
  text: string;
  locator: string;
}

/**
 * 按意思查找的结果。ready 为假是这几个知识库里的文档还没有都向量化，这时不查，hits 是空的，pending 是还差几份；
 * libraries 与 chunks 是比了几个知识库、几个片段。
 */
export interface KnowledgeSearchResult {
  ready: boolean;
  model: string;
  pending: number;
  libraries: number;
  chunks: number;
  hits: KnowledgeSearchHit[];
}

/** 条目在它改动过的某次修订下的内容（GET …/items/{item_id}/revisions 的一项）。 */
export interface ItemRevision {
  revision_no: number;
  by: Actor | string;
  at: string;
  fields: Fields | null;
  sources: Source[];
  reviews: Review[];
  confirmations: Confirmation[];
}

/** 修订日志（GET …/revisions）的一项：一次修订碰到的一个条目。 */
export interface RevisionOperation {
  op: "add" | "update" | "delete" | "restore";
  item_id: string;
  collection: string;
  title: string;
  revision_before: number | null;
  revision_after: number | null;
  /** 改了哪些字段（前后两次修订逐字段比较）；新增、删除、恢复时为空。 */
  fields_changed: string[];
}

/** 触发一次修订的事：执行者的修订是触发那次工作的那句话（自己打的、点卡片发出的、界面操作之后发给助手的）；
 *  用户的修订是那次直接操作；都找不到时 kind 为 none。 */
export interface RevisionTrigger {
  kind: "typed" | "card_choice" | "ui_request" | "user_action" | "none" | string;
  text: string;
  message_id?: string;
  action?: ActionKind | null;
}

export interface RevisionLogEntry {
  revision_no: number;
  at: string;
  by: Actor | string;
  session_id: string;
  /** 执行者的修订所在的那次工作；刷新前后同一次工作的编号一致，回复的 work_id 与它对得上。 */
  work_id: string | null;
  op_id: string | null;
  undo_of_revision: number | null;
  trigger: RevisionTrigger;
  operations: RevisionOperation[];
  /** 触发这次修订的那项用户行为（修订表的 intent_act_id 对上对话行为表的一行）；对不上时为空。 */
  intent?: RevisionIntent | null;
}

/** 一项用户行为：编号（运行号-序号）、功能码与中文名（取自理解格式的 schema）、摘要。 */
export interface RevisionIntent {
  act_id: string;
  function: string;
  function_name: string;
  summary: string;
}

export interface RevisionLog {
  latest_revision: number;
  /** 最新的在前。 */
  revisions: RevisionLogEntry[];
}

// ───────────── 5、6 发出的请求 ─────────────

export interface MessageRequest {
  text: string;
  client_id: string;
  attachments: string[];
  /**
   * 卡片点击时带上：后端据此走扩展命令 /tw-ui，并在会话里记下「哪条回复的哪个选项」。
   * 在卡片的文本框里打字也带：choice 写固定值 typed，后端照打的字处理，只记下这句话写在哪张卡片里。
   */
  origin?: "typed" | "card_choice";
  card?: { reply_message_id: string; kind: ActKind; choice: string };
}

/**
 * request_review：请评审者评审；targets 为空列表时评全部待评审的条目。后端核对通过就回应，评审在后台跑。
 * mark_diagram_viewed：用户打开看了一张图；targets 写 { diagram_id, base_revision }。助手工作中也接受，不往会话里追加东西。
 */
export type ActionKind = "edit_fields" | "delete_item" | "mark_viewed" | "keep_pending" | "undo" | "request_review"
  | "waive_review" | "unwaive_review" | "set_review_rules" | "publish_version" | "edit_diagram" | "mark_diagram_viewed" | "move_stage" | "start_activity";

/** 「继续本阶段」：在提议进入下一个阶段的卡片上选了留在这一段。只在会话里留一条通知，不写库、不引出助手运行；fields 写卡片所在回复的编号与点的键。 */
export type StageActionKind = "continue_stage";

export interface ActionRequest {
  client_id: string;
  kind: ActionKind | StageActionKind;
  task_id: string;
  /** base_revision 是打开这个条目时它所在的修订号；撤销（undo）写 revision_no。改图（edit_diagram）写 diagram_id 与页面看到的图自己的修订号。 */
  targets: { item_id?: string; diagram_id?: string; base_revision?: number; revision_no?: number }[];
  /** publish_version 由任务服务代发（页面走 POST …/versions），页面不直接发。edit_diagram 写 { mermaid }：改后的 Mermaid 文本。move_stage 写 { stage }：阶段的名字。
   * start_activity 写 { activity, in_flow }：开展哪一项活动（阶段的写法）、是在需求分析流程里从这个节点开始还是单独开展；
   * 另可以写 scope，是范围说明。 */
  fields?: Fields | { revision_no: number } | { mermaid: string } | { reply_message_id: string; option_key: string } | { activity: string; in_flow: boolean; scope?: string };
  notify_executor: boolean;
}

// ───────────── 8 错误 ─────────────

export type ErrorCode =
  | "bad_request"
  | "rejected"
  | "stale_revision"
  | "undo_conflict"
  | "session_busy"
  | "executor_starting"
  | "executor_unavailable"
  | "busy_timeout"
  | "too_large"
  | "unsupported_type"
  | "not_found"
  | "forbidden"
  | "in_use"
  | "config_unwritable"
  | "config_locked";

export interface TaskType {
  task_type: string;
  name: string;
}

export interface ApiErrorBody {
  ok: false;
  error: { code: ErrorCode | string; message: string; data?: Record<string, unknown> };
}

/** 服务信息（GET /api/v1/service）：运行形态与能力清单，前端按能力显示或隐藏「退出服务」与无模型提示。 */
/** 数据升级的报告（GET /api/v1/service/upgrade 的 upgrade.report）。text 是给人看的整段文字，页面原样显示。 */
export interface UpgradeReport {
  product_version: string;
  started_at: string;
  finished_at: string;
  data_dir: string;
  /** 这一次扫的是哪个任务目录；早先的服务不给。 */
  tasks_dir?: string;
  backup: { dir: string; bytes: number; files: number } | null;
  service: "created" | "upgraded" | "current" | null;
  tasks: { dir: string; task_id: string | null; name: string | null; from: number; to: number; ok: boolean; error: string | null; ms: number }[];
  succeeded: number;
  failed: number;
  /** 整体没有做成的原因；这时一个任务都没有动。 */
  fatal: string | null;
  file: string | null;
  text: string;
}

/**
 * 数据升级的现状：pending 等着人点开始；running 正在做；done 做完了（个别任务没有做成也算，报告里写着）；
 * failed 整体没有做成，可以再试。
 */
export interface UpgradeView {
  state: "pending" | "running" | "done" | "failed";
  data_dir: string;
  /** 升级之前的备份会放在哪个目录下。 */
  backup_dir: string;
  tasks: { task_id: string; name: string | null }[];
  /** 任务登记要不要升级；知识库要不要升级（现在恒为假）。 */
  service: boolean;
  knowledge: boolean;
  progress: { total: number; done: number; current: string | null } | null;
  report: UpgradeReport | null;
}

/** 调试模式：某个任务最近一次运行实际发给模型的系统提示，按部分列出（后端 debug_prompt.ts）。还没有运行过时 available 为假。 */
export interface DebugSystemPrompt {
  available: boolean;
  note: string | null;
  session_id?: string | null;
  at?: string;
  replaced?: boolean;
  stage?: StageKey | null;
  stage_name?: string | null;
  /** recomposed 重新读文件拼的；reused 沿用上一次的。 */
  how?: "recomposed" | "reused" | null;
  error?: string | null;
  prompt_dir?: string | null;
  notes?: string[];
  digest?: string | null;
  parts: { part: string; part_name: string; from: string; from_name: string; file: string | null; lines: number; bytes: number; text: string }[];
  text: string;
}

/** 调试模式：某个任务的阶段记录流水与被拒的工具调用。rejections 新的在前；latest_work_id 是最近一次被拒所在的那次工作。 */
export interface DebugStage {
  records: { from: StageKey; from_name: string; to: StageKey; to_name: string; actor: "executor" | "user"; reason: string; run_id: string | null; session_id: string; at: string;
    /** 所属流程（现在恒为 analysis，需求分析）；flow 这一项做出来之前记下的移动也给 analysis。早先的后端不给。 */
    flow?: string }[];
  rejections: { work_id: string | null; session_id: string; call_id: string; tool: string; kind: string; fact: string; guidance: string | null; at: string }[];
  latest_work_id: string | null;
}

/** 上传上限（GET 与 POST /api/v1/settings/uploads 的回答）：任务材料与知识库文档单个文件的上限，cap_mb 是最大能设多少，defaults 是没有改过时的值，都是 MB。 */
export interface UploadLimitsView {
  material_mb: number;
  knowledge_mb: number;
  cap_mb: number;
  defaults: { material_mb: number; knowledge_mb: number };
}

/** 调试模式的提示词目录：现在设的是什么，以及固定的十五个文件名各自在目录里的情形。 */
export interface PromptDirView {
  /** 设置里写的目录；没有设时是 null。 */
  prompt_dir: string | null;
  /** 设了的目录现在能不能用；没有设时是 null。 */
  usable: boolean | null;
  /** 设了而不能用时的原因。 */
  note: string | null;
  /** used：这一份会代替原来的；absent：目录里没有，用原来的；refused：目录里有而不用，reason 写着原因。 */
  files: { name: string; state: "used" | "absent" | "refused"; reason: string | null }[];
}

export interface ServiceInfo {
  ok: true;
  app: string;
  version: string;
  mode: "desktop" | "server";
  pid: number;
  port: number | null;
  /** 调试模式开没开（服务带 --debug 启动）：开着时设置页面多一栏「调试」。较早的后端没有这一项，等于假。 */
  debug?: boolean;
  /** 启动时发现有上一版留下的数据要先升级、而升级还没有做完：页面整屏显示数据升级页。较早的后端没有这一项，等于假。 */
  upgrade_pending?: boolean;
  /** model_config：这个页面能不能改模型配置；现在的后端恒为 true，较早的后端没有这一项。model_test：后端有测试模型的接口（语言模型与嵌入模型）。 */
  capabilities: { exit: boolean; model?: boolean; model_config?: boolean; model_test?: boolean; knowledge?: boolean };
  model?: { name: string; reason: string };
  /** 上传上限（字节）、超过时的那句话、允许的扩展名、类型给人看的一串与类型不符时的那句话；旧后端没有这一项，较早的后端没有后三样。 */
  upload?: { max_bytes: number; too_large_text: string; extensions?: string[]; types_text?: string; unsupported_type_text?: string };
  /** 知识库文档的上传：形状与 upload 相同，另有种类的取值与中文叫法；没有知识库时不给。 */
  knowledge_upload?: {
    max_bytes: number; too_large_text: string; extensions: string[]; types_text: string; unsupported_type_text: string;
    kinds: { kind: KnowledgeKind; name: string }[];
  };
}

// ───── 模型配置（接口文档第 10 节）─────

/** 模型服务的种类。 */
export type ProviderKind = "ollama" | "llamacpp" | "vllm" | "deepseek" | "aliyun" | "openai_compatible" | "codex";
/** language：语言模型；embedding：嵌入模型。模型服务的用途、选定模型的键、测试接口的 type 用的是同一组值。 */
export type ModelType = "language" | "embedding";

/** 模型服务里的一个模型。它是哪一类模型，看所在模型服务的用途。 */
export interface ProviderModel {
  id: string;
  /** 勾选了的才能选定。 */
  enabled: boolean;
  /** 上下文长度（词元数）；还没有时为 null。 */
  context_window: number | null;
  /** service：从模型服务查到的；user：用户填的；null：还没有。 */
  context_source?: "service" | "user" | null;
}

export interface ProviderStatus {
  checked_at: string;
  ok: boolean;
  message: string;
  /** 只有 Codex 订阅有：登录凭据在不在。 */
  logged_in?: boolean;
  /** 只有 Codex 订阅有：只在更早的登录入口登录过，要用现在的入口重新登录一次；没有这种情形时不带这一项。 */
  relogin?: boolean;
}

export interface Provider {
  id: string;
  /** 在这里添加的是 true；用户在配置文件里手工写的是 false（只读）。 */
  managed: boolean;
  kind: ProviderKind | null;
  /** 用途：这个模型服务提供哪一类模型。添加时定下，之后不改；手工写的那些是 language。 */
  purpose: ModelType;
  name: string;
  /** Codex 订阅、只读的、不是从本机来的请求都是 null。 */
  base_url: string | null;
  key: { set: boolean; last4: string | null } | null;
  status: ProviderStatus | null;
  models: ProviderModel[];
  models_fetched_at: string | null;
  /** 选定的模型属于这个模型服务时是它的用途这一项，否则是空的。 */
  in_use: ModelType[];
}

export interface ModelSelection {
  language: { provider_id: string; model_id: string } | null;
  embedding: { provider_id: string; model_id: string; query_prefix: string } | null;
}

/** GET /api/v1/model-config */
export interface ModelConfig {
  ok: true;
  editable: boolean;
  /** 不能改时那句说明；能改时是 null。 */
  notice: string | null;
  selection: ModelSelection;
  /** 没有选定语言模型时助手启动用的模型；from 是后端给的来源（「启动配置」或「助手程序的设置」），页面原样显示。 */
  fallback: { model: string; from: string } | null;
  providers: Provider[];
  /**
   * 桌面包首次启动时从本机 pi 的配置（一般是 ~/.pi/agent）复制过来的：从哪个目录、什么时候，skipped 是没有复制的别的模型服务登记
   * （用户本人在本机 pi 里登记的服务名）；不是时为 null，早先的后端不给。
   */
  copied_from_pi?: { from: string; at: string; skipped?: string[] } | null;
}

/** POST /api/v1/model-config/providers/{id}/refresh-catalog：联网更新一次模型目录的结果；没有成功时 message 是原因。 */
export interface RefreshCatalogResult {
  ok: true;
  result: "refreshed" | "failed";
  message: string;
}

export interface FetchModelsResult {
  ok: true;
  result: "listed" | "not_offered" | "failed";
  message: string;
  provider: Provider;
}

/**
 * 测试模型的结果，这一次通过还是没有通过。测试语言模型是让模型读一个小文件并回答文件里写的一个数，结果带 tool_calls 与 reply；
 * 测试嵌入模型是把一句话向量化，得到一串数字，结果带 dimensions。
 */
export interface ModelTestResult {
  ok: true;
  result: "passed" | "failed";
  /** 这一次测的模型，「服务商/型号」。 */
  model: string;
  /** 用时，秒，一位小数。 */
  seconds: number;
  /** 只有语言模型的结果有：模型调用了几次工具。 */
  tool_calls?: number;
  /** 语言模型：问模型的那句话。嵌入模型：送去向量化的那句话（前面带着查询前缀）。 */
  question: string;
  /** 只有语言模型的结果有：模型最后一句回复，最多 200 个字；没有回复时是空串。 */
  reply?: string;
  /** 只有嵌入模型的结果有：算出来的数字串的长度；没有拿到数字串时是 null。 */
  dimensions?: number | null;
  /** 没有通过时的原因；通过时是 null。 */
  reason: string | null;
}

export interface ContextWindowResult {
  ok: true;
  context_window: number | null;
  source: "service" | null;
  message: string;
}

// ───────────── 任务状况 ─────────────

/**
 * 任务状况（GET /tasks/{task_id}/status）：程序据任务记录算出来的定位，不经助手。
 * activity 是当前活动：现在总是一个阶段（kind 为 stage），flow 是所属流程（现在恒为 analysis，需求分析）；一次都没有移动过时 moved_by、moved_at、reason 为 null。
 * description 是业务说明：sections 是在用的页数，chapters 是有节的各章（七章的先后），unsorted 是没有归到任何一章的在用页数，open_questions 是没有了结的待澄清问题数。
 * models 是还在的图按种类的张数；items 是业务说明与问题之外各集合的条目数与用户看过现在这一版的条数；
 * missing 是现在这个阶段没有通过的灯；proposal 是开着的提议；versions 留给已发布的文档版本，现在恒为空。
 */
/** 需求资产六类里一类的现状：任务起点页上的一格。 */
export interface AssetCell {
  /** materials、description、models、items、review、versions 之一。 */
  key: string;
  name: string;
  /** 数量；评审与确认是评审过几轮，文档与版本是发布到第几版。 */
  count: number;
  unit: string;
  /** 格里的大字：「3 节」「未评审」「未发布」。 */
  text: string;
  /** 大字下面的一句；没有可说的是空文字。 */
  note: string;
  /** 产出这一类的各项活动的名称；材料来自上传，是空的。 */
  produced_by: string[];
}

/** 带名称的一个键：一类资产、一项活动。 */
export interface NamedKey {
  key: string;
  name: string;
}

/** 活动目录里的一项单项活动。文字取自活动的定义；enabled 与 state 是现在能不能开展。 */
export interface CatalogActivity {
  key: string;
  name: string;
  mode: "batch" | "dialogue" | "user_only";
  mode_name: string;
  purpose: string;
  reads: NamedKey[];
  writes: NamedKey[];
  prerequisite_text: string;
  example: string;
  enabled: boolean;
  /** 一句状态：可以开展、正在进行、正在工作流程中进行、此版本尚未提供，或者缺什么前提。 */
  state: string;
  recommended: boolean;
  /** 这项活动现在有几个进行中的工作项；早先的后端不给。 */
  active_count?: number;
}

/** 活动目录里的一条工作流程。 */
export interface CatalogFlow {
  key: string;
  name: string;
  purpose: string;
  applies: string;
  nodes: NamedKey[];
  inputs: string;
  prerequisite_text: string;
  example: string;
  enabled: boolean;
  state: string;
  recommended: boolean;
  /** 这条流程现在有几个工作项（至多一个）；早先的后端不给。 */
  active_count?: number;
  /** 恒为 null：早先是流程走到的站，现在流程的位置记在工作项上。 */
  at: string | null;
  /** 现在启动应当从哪一站开始；这条流程现在还不能启动时为 null。 */
  start: StageKey | null;
  /**
   * 任务里已有的流程工作项（一个任务至多一个，不论哪条流程）：记录号、名字、所在的一站；没有为 null。有它时流程都不能启动，
   * 页面把流程卡改成「打开它的会话」。早先的后端不给。
   */
  work_item?: { record_id: number; name: string; node: StageKey } | null;
}

export interface ActivityCatalog {
  flows: CatalogFlow[];
  activities: CatalogActivity[];
}

/** 任务起点页与活动输入页上的几段文字。 */
export interface StartPageTexts {
  lead: string;
  guide_note: string;
  /** 三种常见起点；focus 是点了它进输入页时先看哪一块（早先的后端不给）。 */
  cases: { title: string; text: string; focus?: "materials" | "description" }[];
  /** 从头编制时输入页上的几段；早先的后端不给。 */
  intake?: {
    lead: string;
    material_kinds: string[];
    describe_note: string;
    describe_placeholder: string;
    describe_examples: string[];
    /** 「启动后」一块里有材料与没有材料两种情形各一句。 */
    after: string[];
  };
}

export interface TaskStatusView {
  generated_at: string;
  /**
   * 当前活动。kind 为 stage 是任务在需求分析流程里的某个阶段（ordinal 是第几阶段）；activity 是用户单独开展的一项活动
   * （ordinal 与 flow 为 null）；idle 是空闲（key 为 idle，ordinal 与后三项为 null）。
   */
  activity: {
    kind: "stage" | "activity" | "idle"; key: PositionKey; name: string; ordinal: number | null; flow: string | null;
    moved_by: "executor" | "user" | null; moved_at: string | null; reason: string | null;
  };
  /** 「开展一项活动」一节；任务不在进行中、或者后端是早先的版本时没有。 */
  launch?: LaunchView | null;
  /** 需求资产六类的现状；后端是早先的版本时没有。 */
  assets?: AssetCell[];
  /** 活动目录；任务不在进行中、或者后端是早先的版本时没有。 */
  catalog?: ActivityCatalog | null;
  /** 任务起点页上的几段文字；后端是早先的版本时没有。 */
  start_page?: StartPageTexts;
  description: { sections: number; chapters: { no: number; name: string; sections: number }[]; unsorted: number; open_questions: number };
  models: { kind: string; name: string; count: number }[];
  items: { collection: string; total: number; viewed: number }[];
  missing: { key: string; summary: string }[];
  proposal: StageProposal | null;
  /** 任务的全部工作项（工作项没有终点），按最近有动静的倒序；早先的后端不给。 */
  work_items?: WorkItemView[];
  /** 发布过的各版，按版本号从小到大。 */
  versions: VersionView[];
}
