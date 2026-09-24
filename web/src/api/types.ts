// 接口约定（docs/api.md）的接口类型，字段名与约定逐字一致。
// 约定里写「可空」的字段用 `| null`；约定没写、但前端必须容忍缺失的，用可选（`?`）。
// 前端遇到不认识的字段一律忽略，所以这里只列用得到的。

// ───────────── 共用 ─────────────

export type Actor = "executor" | "user";
export type TaskStatus = "进行中" | "已完成" | "已放弃";
/** 来源的四种种类。「用户直接修改」由系统在用户直接改字段时写，出处是操作编号（ui-op-…）。 */
export type SourceKind = "文档原文" | "用户的话" | "执行者补充" | "用户直接修改";

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
}

// ───────────── 4.1 整份数据 ─────────────

export interface FieldDef {
  name: string;
  type: "文本" | "文本列表" | "枚举" | "条目引用" | string;
  required: boolean;
  values: string[] | null;
}

export interface CollectionDef {
  name: string;
  prefix: string;
  fields: FieldDef[];
}

export interface TaskDefinition {
  collections: CollectionDef[];
}

export interface Finding {
  field: string;
  index: number | null;
  problem: string;
  suggestion: string | null;
}

export interface Review {
  version_no?: number;
  verdict: "合规" | "不合规" | string;
  findings?: Finding[];
  at?: string;
}

export interface Confirmation {
  version_no: number;
  accepted: boolean;
  basis?: "ui_click" | "user_words" | string;
  at?: string;
}

export interface Item {
  item_id: string;
  collection: string;
  title: string;
  version_no: number;
  version_by: Actor | string;
  version_at: string;
  version_count: number;
  fields: Fields;
  sources: Source[];
  reviews: Review[];
  confirmations: Confirmation[];
  confirmation_stale: boolean;
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
  version_no?: number;
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
  stages?: { text: string; count?: number }[];
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
  version_before: number | null;
  version_after: number | null;
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
  version_no: number;
  verdict: string;
  findings: Finding[];
  completion: Completion | null;
}

export interface ConfirmationRecorded {
  seq: number;
  /** 与后端对齐后新增，与 deliverable_changed 一致，前端靠它消去「正在保存」。 */
  op_id?: string | null;
  at: string;
  task_id: string;
  items: { item_id: string; version_no: number; accepted: boolean }[];
  basis: "ui_click" | "user_words" | string;
  completion: Completion | null;
}

/** 库事件：有序号（SSE 的 id 行），可补发。 */
export type LibraryEvent =
  | { event: "deliverable_changed"; data: DeliverableChanged }
  | { event: "task_changed"; data: TaskChanged }
  | { event: "review_recorded"; data: ReviewRecorded }
  | { event: "confirmation_recorded"; data: ConfirmationRecorded };

export const LIBRARY_EVENTS = ["deliverable_changed", "task_changed", "review_recorded", "confirmation_recorded"] as const;

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
}

export interface TaskDetail extends Task {
  materials: Material[];
  sessions: SessionListEntry[];
}

export interface ItemVersion {
  version_no: number;
  revision_no: number;
  by: Actor | string;
  at: string;
  fields: Fields | null;
  sources: Source[];
  reviews: Review[];
  confirmations: Confirmation[];
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

export type ActionKind = "edit_fields" | "delete_item" | "confirm" | "unconfirm" | "keep_pending" | "undo";

export interface ActionRequest {
  client_id: string;
  kind: ActionKind;
  task_id: string;
  targets: { item_id?: string; base_version?: number; revision_no?: number }[];
  fields?: Fields;
  notify_executor: boolean;
}

// ───────────── 8 错误 ─────────────

export type ErrorCode =
  | "bad_request"
  | "rejected"
  | "stale_version"
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
