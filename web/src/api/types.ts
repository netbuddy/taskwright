// 接口约定（docs/api.md）的接口类型，字段名与约定逐字一致。
// 修订：一次保存（执行者的一次「保存修订」或用户的一次直接操作）产生一次修订，序号在任务内从 1 起连续递增；
// 条目没有自己的版本号，它在某一时刻的内容由「条目编号加修订号」标识。条目「当前所在的修订」是最近一次新增、修改或恢复它的那次修订。
// 约定里写「可空」的字段用 `| null`；约定没写、但前端必须容忍缺失的，用可选（`?`）。
// 前端遇到不认识的字段一律忽略，所以这里只列用得到的。

// ───────────── 共用 ─────────────

export type Actor = "executor" | "user";
export type TaskStatus = "进行中" | "已完成" | "已放弃";
/** 来源的四种种类。「用户直接修改」由系统在用户直接改字段时写，出处是操作编号（ui-op-…）。 */
export type SourceKind = "文档原文" | "用户的话" | "执行者补充" | "领域说明" | "用户直接修改";

/** 一条来源支持哪一处：某个字段，列表型字段还可以指到第几项。supports 为空数组＝支持整个条目。 */
export interface SourceSupport {
  field: string;
  index?: number | null;
}

export interface Source {
  kind: SourceKind | string;
  locator: string;
  excerpt: string;
  supports?: SourceSupport[];
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
  /** 完成条件之外的提示，不是门禁。kind 为 unlinked_domain_notes：还没有和任何条目关联的领域说明。 */
  hints?: CompletionHint[];
}

export interface CompletionHint {
  kind: "unlinked_domain_notes";
  collection: string;
  items: string[];
  /** 一句完整的话，例如「有 2 条领域说明还没有和任何条目关联：DN-003、DN-004。」 */
  summary: string;
}

// ───────────── 4.1 整份数据 ─────────────

export interface FieldDef {
  name: string;
  type: "文本" | "文本列表" | "枚举" | "条目引用" | string;
  required: boolean;
  values: string[] | null;
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
  /** 显示方式（任务定义的「界面」一项）：side_tab 在右侧栏另开页签，group_field 按这个字段分组并在条目行上写成小标签，
   *  leading_groups 这几组按给定顺序排最前、其余按每组第一个条目的编号排，note 是写在这个集合页签下的一句白话。
   *  没写时为 null，照旧显示。 */
  display?: { side_tab: boolean; group_field: string | null; leading_groups: string[]; note?: string | null } | null;
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
  findings?: Finding[];
  at?: string;
  /** 所属的那一次评审（批次）编号；早期记录为空。 */
  batch_id?: string | null;
  /** 评审时的规则指纹；早期记录为空。 */
  rules_hash?: string | null;
  /** 内容与规则都没变、用户仍要求重评的那一次。 */
  forced?: boolean;
}

/** 用户保留了评审不合规的写法（评审豁免）。条目改出新修订后不再作数；撤销后 revoked 为真。 */
export interface Waiver {
  revision_no: number;
  reason: string | null;
  source?: "detail" | "panel" | string;
  at?: string;
  revoked?: boolean;
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
 * ui_click：撤回确认（早期版本还有点了确认的）；user_words：早期版本由执行者登记、依据是用户在对话里说的话。
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
  reviews: Review[];
  /** 保留记录（含已撤销的）；旧后端没有这一项。 */
  waivers?: Waiver[];
  confirmations: Confirmation[];
  confirmation_stale: boolean;
  /** 当前修订上最近一条确认标记是接受（任一依据）；为假就是未读。前端按 confirmations 现算，这两项只作对照。 */
  viewed?: boolean;
  /** viewed 为真时那条标记的依据，未读时为空。 */
  confirmation_basis?: ConfirmationBasis | string | null;
}

export interface Task {
  task_id: string;
  task_name: string;
  task_type: string;
  domain_tag: string | null;
  status: TaskStatus | string;
  started_at: string;
  ended_at: string | null;
  definition: TaskDefinition;
  completion: Completion | null;
  items: Item[];
  /** 任务最新的修订号；还没有修订时是 0。 */
  latest_revision?: number;
  /** 评审批次，按先后；旧后端没有这一项。 */
  review_batches?: ReviewBatch[];
}

export interface Material {
  path: string;
  bytes: number;
  modified_at: string;
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
}

// ───────────── 5.3 回复的形状 ─────────────

export type ActKind = "ask" | "confirm" | "suggest" | "choose" | "propose";

export interface ActItemRef {
  item_id: string;
  /** 条目当前所在的修订号。 */
  revision_no?: number;
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
}

// ───────────── 3.2 过程与对话类事件，也是 conversation.messages 里的条目 ─────────────

export interface UserMessage {
  type: "user_message";
  session_id?: string;
  message_id: string | null;
  at: string;
  text: string;
  origin: "typed" | "card_choice" | "ui_request" | string;
  annotation: unknown | null;
  queued: boolean;
  client_id?: string;
}

export interface AssistantReply {
  type: "assistant_reply";
  session_id?: string;
  message_id: string;
  at: string;
  work_id: string | null;
  via_reply_tool: boolean;
  informs: string[];
  act: Act | null;
  text: string;
  /** 连续被拒到上限后放行的纯文字回复；为真时照普通文字显示并加一行说明。 */
  degraded?: boolean;
}

export interface UiActionNoted {
  type: "ui_action_noted";
  session_id?: string;
  message_id: string;
  at: string;
  text: string;
  event_seq: number | null;
  undoable: boolean;
  /** 与后端对齐后新增：撤销要用的修订序号；确认、撤回确认不产生修订，为 null。 */
  revision_no?: number | null;
  op_id?: string | null;
  /** 界面操作的种类；评审结束的那条是 request_review，另带 review 计数。 */
  kind?: string | null;
  review?: { total: number; passed: number; failed: number; unfinished: number; problems: number; advice: number } | null;
}

export interface SystemNote {
  type: "system_note";
  session_id?: string;
  message_id: string;
  at: string;
  text: string;
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

export interface TaskChanged {
  seq: number;
  at: string;
  task_id: string;
  task_name: string;
  status_before: string | null;
  status_after: string;
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

/** 库事件：有序号（SSE 的 id 行），可补发。 */
export type LibraryEvent =
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
  | { event: "item_viewed"; data: ItemViewed };

export const LIBRARY_EVENTS = [
  "deliverable_changed", "task_changed", "review_recorded", "review_unfinished", "review_progress", "review_finished", "confirmation_recorded", "item_viewed",
  "review_batch", "review_waived", "review_unwaived", "review_rules_changed",
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
  outcome: "replied" | "no_reply" | "stopped_by_user" | "failed" | string;
}

/** 上传材料成功之后后端推的过程类事件（小修新增）。材料属于任务，session_id 只说明从哪条会话上传（可空）。 */
export interface MaterialAdded {
  session_id: string | null;
  at: string;
  path: string;
  bytes: number;
  modified_at: string;
}

export interface Problem {
  session_id?: string;
  code: string;
  text: string;
  retry: { attempt: number; after_ms: number } | null;
}

// ───────────── 4.3 按需读取 ─────────────

export interface TaskListEntry {
  task_id: string;
  task_name: string;
  task_type: string;
  domain_tag: string | null;
  status: TaskStatus | string;
  item_count: number;
  completion_met: number | null;
  completion_total: number | null;
  completion_unmet?: number | null;
  last_active_at: string;
  session_count: number;
  /** 为假时列出来但打不开，note 写明原因：修订统一之前建的旧格式任务，或者正被别的服务占用（这时有 occupied）。 */
  supported?: boolean;
  note?: string;
  /** 正被别的服务占用：那个服务的端口、进程号、主机名。 */
  occupied?: { port: number | null; pid: number | null; host: string | null } | null;
}

export interface TaskDetail extends Task {
  materials: Material[];
  sessions: SessionListEntry[];
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
   */
  origin?: "typed" | "card_choice";
  card?: { reply_message_id: string; kind: ActKind; choice: string };
}

/** request_review：请评审者评审；targets 为空列表时评全部待评审的条目。后端核对通过就回应，评审在后台跑。 */
export type ActionKind = "edit_fields" | "delete_item" | "mark_viewed" | "unconfirm" | "keep_pending" | "undo" | "request_review"
  | "waive_review" | "unwaive_review" | "set_review_rules";

export interface ActionRequest {
  client_id: string;
  kind: ActionKind;
  task_id: string;
  /** base_revision 是打开这个条目时它所在的修订号；撤销（undo）写 revision_no。 */
  targets: { item_id?: string; base_revision?: number; revision_no?: number }[];
  fields?: Fields;
  notify_executor: boolean;
  /** request_review：点名的条目在当前修订、当前规则下已经评过也再评一次（「仍要重评」）。 */
  force?: boolean;
}

// ───────────── 8 错误 ─────────────

export type ErrorCode =
  | "bad_request"
  | "rejected"
  | "stale_revision"
  | "old_format"
  | "undo_conflict"
  | "task_closed"
  | "session_busy"
  | "executor_starting"
  | "executor_unavailable"
  | "busy_timeout"
  | "too_large"
  | "unsupported_type"
  | "not_found";

export interface TaskType {
  task_type: string;
  name: string;
}

export interface ApiErrorBody {
  ok: false;
  error: { code: ErrorCode | string; message: string; data?: Record<string, unknown> };
}
