// 工作视图的状态与事件应用规则。纯函数，不碰网络，组件测试直接调用。
//
// 规则：
//   1. 先连事件流、再读整份数据。整份数据到达之前收到的库事件先攒着；
//      整份数据到达后，丢掉序号不大于快照序号的库事件，其余按序号应用。
//   2. 同一个序号的库事件只应用一次（序号不大于已应用序号的一律丢掉）。
//   3. 收到 resync，回到第 1 步：清掉攒着的事件，等待重新读整份数据。
//   4. 库事件序号出现缺口（比已应用序号大不止 1）时，也回到第 1 步：宁可重读，也不在缺一段的数据上接着改。
//   5. 过程与对话类事件不参与序号规则，收到就应用；只显示属于本会话的。
//   6. 界面上的状态变化只来自事件；直接操作的响应只用来登记「正在保存」与显示拒绝原因。

import type {
  AssistantReply,
  Completion,
  ConfirmationRecorded,
  ConversationMessage,
  CurrentWork,
  DeliverableChanged,
  ExecutorState,
  Item,
  ItemViewed,
  Material,
  MaterialAdded,
  Problem,
  ReviewFinished,
  ReviewProgress,
  ReviewRecorded,
  SessionInfo,
  Snapshot,
  Step,
  SystemNote,
  Task,
  TaskChanged,
  UiActionNoted,
  UserMessage,
  WorkEnded,
  WorkStarted,
  WorkSummary,
} from "../api/types";
import { LIBRARY_EVENTS } from "../api/types";

export interface BufferedLibraryEvent {
  event: (typeof LIBRARY_EVENTS)[number];
  data: { seq: number } & Record<string, unknown>;
}

/** 本地刚发出、还没被事件确认的一句话。 */
export interface OutgoingMessage {
  client_id: string;
  text: string;
  state: "sending" | "sent" | "failed";
  error?: string;
  queued?: boolean;
}

/**
 * 界面发起的一批评审：进度来自 review_progress，全部评完时 review_finished 填上 finished。
 * 不在整份数据里：刷新页面之后，下一条进度事件到了才重新显示。
 */
export interface ReviewRun {
  op_id: string;
  done: number;
  total: number;
  /** 此刻正在评的条目。 */
  current: string[];
  finished: { passed: number; failed: number; unfinished: number; error: string | null } | null;
}

export interface WorkState {
  sessionId: string;
  phase: "waiting_snapshot" | "ready";
  /** 已应用到的库事件序号；整份数据到达前是 null。 */
  seq: number | null;
  buffered: BufferedLibraryEvent[];
  task: Task | null;
  materials: Material[];
  executor: ExecutorState | null;
  session: SessionInfo | null;
  messages: ConversationMessage[];
  hasEarlier: boolean;
  earliestId: string | null;
  currentWork: CurrentWork | null;
  outgoing: OutgoingMessage[];
  /** 已被接受、还等着库事件的直接操作编号（op_id）→ 说明与涉及的条目，用来显示「正在保存」。 */
  pendingOps: Record<string, { label: string; items: string[] }>;
  problems: Problem[];
  /** 最近几次库事件改动过的条目编号，界面据此闪一下。 */
  recentlyChanged: string[];
  /**
   * 库事件序号 → 修订序号。撤销（undo）要指明修订序号，而 ui_action_noted 只带 event_seq；
   * 快照之后到达的 deliverable_changed 在这里记下对应关系。
   */
  revisionBySeq: Record<number, number>;
  /**
   * 库事件里已经出现过的操作编号（最近 100 个）。直接操作的库事件可能比它的响应先到，
   * 这时响应再来登记「正在保存」就会一直挂着；登记前先查这里，已经到过的就不再登记。
   */
  seenOps: string[];
  /** 最近一次新加进来的材料路径：文档区据此选中它并显示正文。 */
  focusMaterial: string | null;
  /** 任务最新的修订号：整份数据里带一次，之后每条 deliverable_changed 更新。修订日志跟着它重读。 */
  latestRevision: number;
  /** 最近一批界面发起的评审；没有时为 null。 */
  review: ReviewRun | null;
}

export function initialWorkState(sessionId: string): WorkState {
  return {
    sessionId,
    phase: "waiting_snapshot",
    seq: null,
    buffered: [],
    task: null,
    materials: [],
    executor: null,
    session: null,
    messages: [],
    hasEarlier: false,
    earliestId: null,
    currentWork: null,
    outgoing: [],
    pendingOps: {},
    problems: [],
    recentlyChanged: [],
    revisionBySeq: {},
    seenOps: [],
    focusMaterial: null,
    latestRevision: 0,
    review: null,
  };
}

export type WorkAction =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "sse"; event: string; data: unknown }
  | { type: "resync" }
  | { type: "outgoing"; message: OutgoingMessage }
  | { type: "outgoing_update"; client_id: string; patch: Partial<OutgoingMessage> }
  | { type: "op_pending"; op_id: string; label: string; items: string[] }
  | { type: "op_done"; op_id: string }
  | { type: "earlier"; messages: ConversationMessage[]; hasEarlier: boolean; earliestId: string | null }
  | { type: "dismiss_problem"; index: number };

const isLibraryEvent = (name: string): name is BufferedLibraryEvent["event"] =>
  (LIBRARY_EVENTS as readonly string[]).includes(name);

export function workReducer(state: WorkState, action: WorkAction): WorkState {
  switch (action.type) {
    case "snapshot":
      return applySnapshot(state, action.snapshot);
    case "resync":
      return { ...state, phase: "waiting_snapshot", seq: null, buffered: [] };
    case "sse":
      return applySse(state, action.event, action.data);
    case "outgoing":
      return { ...state, outgoing: [...state.outgoing, action.message] };
    case "outgoing_update":
      return {
        ...state,
        outgoing: state.outgoing.map((m) => (m.client_id === action.client_id ? { ...m, ...action.patch } : m)),
      };
    case "op_pending":
      if (state.seenOps.includes(action.op_id)) return state; // 库事件已经先到了
      return { ...state, pendingOps: { ...state.pendingOps, [action.op_id]: { label: action.label, items: action.items } } };
    case "op_done": {
      const rest = { ...state.pendingOps };
      delete rest[action.op_id];
      return { ...state, pendingOps: rest };
    }
    case "earlier":
      return {
        ...state,
        messages: [...action.messages, ...state.messages],
        hasEarlier: action.hasEarlier,
        earliestId: action.earliestId,
      };
    case "dismiss_problem":
      return { ...state, problems: state.problems.filter((_, i) => i !== action.index) };
  }
}

function applySnapshot(state: WorkState, snapshot: Snapshot): WorkState {
  let next: WorkState = {
    ...state,
    phase: "ready",
    seq: snapshot.seq,
    task: snapshot.task,
    materials: snapshot.materials ?? [],
    executor: snapshot.executor,
    session: snapshot.session,
    messages: snapshot.conversation?.messages ?? [],
    hasEarlier: snapshot.conversation?.has_earlier ?? false,
    earliestId: snapshot.conversation?.earliest_id ?? null,
    currentWork: snapshot.current_work,
    buffered: [],
    latestRevision: snapshot.task?.latest_revision ?? state.latestRevision,
    // 快照里已经有的话，本地的「发送中」那条就不要了（按文字对上；client_id 快照里没有）。
    outgoing: state.outgoing.filter((m) => m.state === "failed"),
    // 后端写完库才回应直接操作，重读到的整份数据必然已包含已回应的那些操作：「正在保存」一律清掉，
    // 免得漏收的库事件让某个条目的按钮一直灰着。
    pendingOps: {},
  };
  const pending = [...state.buffered].sort((a, b) => a.data.seq - b.data.seq);
  for (const event of pending) {
    if (event.data.seq <= snapshot.seq) continue;
    next = applyLibrary(next, event);
    if (next.phase === "waiting_snapshot") break;
  }
  return next;
}

function applySse(state: WorkState, name: string, data: unknown): WorkState {
  if (name === "resync") return workReducer(state, { type: "resync" });
  if (isLibraryEvent(name)) {
    const event = { event: name, data } as BufferedLibraryEvent;
    if (typeof event.data?.seq !== "number") return state;
    if (state.phase === "waiting_snapshot") return { ...state, buffered: [...state.buffered, event] };
    return applyLibrary(state, event);
  }
  return applyProcess(state, name, data);
}

function applyLibrary(state: WorkState, event: BufferedLibraryEvent): WorkState {
  const seq = event.data.seq;
  if (state.seq !== null && seq <= state.seq) return state; // 同一序号只应用一次
  if (state.seq !== null && seq > state.seq + 1) {
    // 序号出现缺口：回到「等整份数据」，这条事件先攒着，重读之后按规则决定要不要应用。
    return { ...state, phase: "waiting_snapshot", seq: null, buffered: [event] };
  }
  const opId = (event.data as { op_id?: string | null }).op_id;
  let next: WorkState = { ...state, seq, seenOps: opId ? [...state.seenOps.slice(-99), opId] : state.seenOps };
  switch (event.event) {
    case "deliverable_changed":
      next = applyDeliverableChanged(next, event.data as unknown as DeliverableChanged);
      break;
    case "task_changed":
      next = applyTaskChanged(next, event.data as unknown as TaskChanged);
      break;
    case "review_recorded":
      next = applyReviewRecorded(next, event.data as unknown as ReviewRecorded);
      break;
    case "review_unfinished":
      next = withCompletionOnly(next, (event.data as { completion?: Completion | null }).completion);
      break;
    case "review_progress": {
      const data = event.data as unknown as ReviewProgress;
      next = { ...withCompletionOnly(next, data.completion),
        review: { op_id: data.op_id, done: data.done, total: data.total, current: data.current ?? [], finished: null } };
      break;
    }
    case "review_finished": {
      const data = event.data as unknown as ReviewFinished;
      next = { ...withCompletionOnly(next, data.completion), review: {
        op_id: data.op_id, done: data.total, total: data.total, current: [],
        finished: { passed: data.passed, failed: data.failed, unfinished: data.unfinished, error: data.error ?? null },
      } };
      break;
    }
    case "confirmation_recorded":
      next = applyConfirmationRecorded(next, event.data as unknown as ConfirmationRecorded);
      break;
    case "item_viewed": {
      // 已读就是一条接受的确认标记，依据是 viewed；与撤回、界面修改走同一套应用。
      const data = event.data as unknown as ItemViewed;
      next = applyConfirmationRecorded(next, { ...data, basis: "viewed", items: data.items.map((i) => ({ ...i, accepted: true })) });
      break;
    }
  }
  return next;
}

function withCompletion(task: Task, completion: Completion | null | undefined): Task {
  // 约定：算不出来时库事件里是 null，前端就显示「完成条件这次没有算出来」，所以照样覆盖。
  return completion === undefined ? task : { ...task, completion };
}

/** 只带完成条件的库事件：有就换上。 */
function withCompletionOnly(state: WorkState, completion: Completion | null | undefined): WorkState {
  return state.task ? { ...state, task: withCompletion(state.task, completion) } : state;
}

function staleOf(item: Item): boolean {
  const accepted = [...item.confirmations].reverse().find((c) => c.accepted);
  return !!accepted && accepted.revision_no !== item.revision_no;
}

/** 按 op_id 消去「正在保存」。要在一切提前返回之前做：没消掉的话，那个条目的写入按钮会一直灰着。 */
function clearOp(state: WorkState, opId: string | null | undefined): WorkState {
  if (!opId || !(opId in state.pendingOps)) return state;
  const rest = { ...state.pendingOps };
  delete rest[opId];
  return { ...state, pendingOps: rest };
}

function applyDeliverableChanged(state: WorkState, data: DeliverableChanged): WorkState {
  state = clearOp(state, data.op_id);
  if (!state.task) return state;
  let items = [...state.task.items];
  const changed: string[] = [];
  for (const op of data.operations ?? []) {
    changed.push(op.item_id);
    const index = items.findIndex((i) => i.item_id === op.item_id);
    if (op.op === "delete") {
      if (index >= 0) items.splice(index, 1);
      continue;
    }
    const base: Item =
      index >= 0
        ? items[index]
        : {
            item_id: op.item_id,
            collection: op.collection,
            title: op.title,
            revision_no: 0,
            revision_by: data.actor,
            revision_at: data.at,
            revisions: [],
            fields: {},
            sources: [],
            reviews: [],
            confirmations: [],
            confirmation_stale: false,
          };
    const updated: Item = {
      ...base,
      collection: op.collection ?? base.collection,
      title: op.title ?? base.title,
      revision_no: op.revision_after ?? base.revision_no,
      revision_by: data.actor,
      revision_at: data.at,
      revisions: op.revision_after != null && !base.revisions.includes(op.revision_after) ? [...base.revisions, op.revision_after] : base.revisions,
      fields: op.fields ?? base.fields,
      sources: op.sources ?? base.sources,
    };
    updated.confirmation_stale = staleOf(updated);
    if (index >= 0) items[index] = updated;
    else items = [...items, updated];
  }
  const pendingOps = state.pendingOps;
  // restore（撤销一次删除）在上面的循环里按「条目重新出现」处理：列表里没有就加回去，字段取事件里恢复后的内容。
  return {
    ...state,
    task: withCompletion({ ...state.task, items }, data.completion),
    pendingOps,
    latestRevision: Math.max(state.latestRevision, data.revision_no ?? 0),
    recentlyChanged: changed,
    revisionBySeq: data.revision_no != null ? { ...state.revisionBySeq, [data.seq]: data.revision_no } : state.revisionBySeq,
  };
}

function applyTaskChanged(state: WorkState, data: TaskChanged): WorkState {
  if (!state.task) return state;
  return {
    ...state,
    task: withCompletion({ ...state.task, status: data.status_after, task_name: data.task_name ?? state.task.task_name }, data.completion),
  };
}

function applyReviewRecorded(state: WorkState, data: ReviewRecorded): WorkState {
  if (!state.task) return state;
  const items = state.task.items.map((item) =>
    item.item_id === data.item_id
      ? { ...item, reviews: [...item.reviews, { revision_no: data.revision_no, verdict: data.verdict, findings: data.findings, at: data.at }] }
      : item,
  );
  return { ...state, task: withCompletion({ ...state.task, items }, data.completion), recentlyChanged: [data.item_id] };
}

function applyConfirmationRecorded(state: WorkState, data: ConfirmationRecorded): WorkState {
  state = clearOp(state, data.op_id);
  if (!state.task) return state;
  const byId = new Map(data.items.map((i) => [i.item_id, i]));
  const items = state.task.items.map((item) => {
    const hit = byId.get(item.item_id);
    if (!hit) return item;
    const updated = {
      ...item,
      confirmations: [...item.confirmations, { revision_no: hit.revision_no, accepted: hit.accepted, basis: data.basis, at: data.at }],
    };
    return { ...updated, confirmation_stale: staleOf(updated) };
  });
  // 带 op_id 时按它消去「正在保存」；不带时按涉及的条目消去。
  const touched = new Set(data.items.map((i) => i.item_id));
  const pendingOps = Object.fromEntries(
    Object.entries(state.pendingOps).filter(([op, p]) => (data.op_id ? op !== data.op_id : !p.items.some((id) => touched.has(id)))),
  );
  return {
    ...state,
    task: withCompletion({ ...state.task, items }, data.completion),
    recentlyChanged: data.items.map((i) => i.item_id),
    pendingOps,
  };
}

/** 过程与对话类事件：不带序号，收到就应用；不属于本会话的忽略。 */
function applyProcess(state: WorkState, name: string, data: unknown): WorkState {
  const payload = (data ?? {}) as { session_id?: string };
  // 执行者状态与新加的材料属于整个任务，不按会话过滤。
  if (payload.session_id && payload.session_id !== state.sessionId && name !== "executor_state" && name !== "material_added") return state;
  switch (name) {
    case "user_message":
      return applyUserMessage(state, data as UserMessage);
    case "assistant_reply":
      return appendMessage(state, { ...(data as AssistantReply), type: "assistant_reply" });
    case "ui_action_noted":
      return appendMessage(state, { ...(data as UiActionNoted), type: "ui_action_noted" });
    case "system_note":
      return appendMessage(state, { ...(data as SystemNote), type: "system_note" });
    case "work_started": {
      const d = data as WorkStarted;
      return { ...state, currentWork: { work_id: d.work_id, started_at: d.at, triggered_by: d.triggered_by, steps: [] } };
    }
    case "step":
      return applyStep(state, data as Step);
    case "work_ended": {
      const d = data as WorkEnded;
      const summary: ConversationMessage = {
        type: "work_summary",
        work_id: d.work_id,
        at: d.at,
        seconds: d.seconds,
        step_count: d.step_count,
        stages: (state.currentWork?.work_id === d.work_id ? state.currentWork.steps : []).map((s) => ({ text: s.text })),
      };
      // 过程摘要放在这次工作的回复之前：回复一般先于 work_ended 到达。后端算好的摘要（work_summary）先到了就不再拼。
      if (state.messages.some((m) => m.type === "work_summary" && (m as WorkSummary).work_id === d.work_id)) return { ...state, currentWork: null };
      const messages = [...state.messages];
      const replyIndex = messages.findIndex((m) => m.type === "assistant_reply" && (m as AssistantReply).work_id === d.work_id);
      if (replyIndex >= 0) messages.splice(replyIndex, 0, summary);
      else messages.push(summary);
      return { ...state, currentWork: null, messages };
    }
    case "work_summary":
      return applyWorkSummary(state, data as WorkSummary);
    case "executor_state":
      return { ...state, executor: data as ExecutorState };
    case "material_added": {
      const d = data as MaterialAdded;
      const material: Material = { path: d.path, bytes: d.bytes, modified_at: d.modified_at };
      const materials = [...state.materials.filter((m) => m.path !== d.path), material].sort((a, b) => a.path.localeCompare(b.path));
      return { ...state, materials, focusMaterial: d.path };
    }
    case "problem":
      return { ...state, problems: [...state.problems, data as Problem] };
    default:
      return state; // 不认识的事件一律忽略（第 3 节）
  }
}

/** 后端算好的过程摘要：换掉 work_ended 时前端先按实时步骤拼的那一条，没有就照 work_ended 的规则插进去。 */
function applyWorkSummary(state: WorkState, data: WorkSummary): WorkState {
  const summary: ConversationMessage = { ...data, type: "work_summary" };
  const messages = [...state.messages];
  const existing = messages.findIndex((m) => m.type === "work_summary" && (m as WorkSummary).work_id === data.work_id);
  if (existing >= 0) {
    messages[existing] = summary;
    return { ...state, messages };
  }
  const replyIndex = messages.findIndex((m) => m.type === "assistant_reply" && (m as AssistantReply).work_id === data.work_id);
  if (replyIndex >= 0) messages.splice(replyIndex, 0, summary);
  else messages.push(summary);
  return { ...state, messages };
}

function appendMessage(state: WorkState, message: ConversationMessage): WorkState {
  const id = (message as { message_id?: string | null }).message_id;
  if (id && state.messages.some((m) => (m as { message_id?: string | null }).message_id === id)) return state;
  return { ...state, messages: [...state.messages, message] };
}

function applyUserMessage(state: WorkState, data: UserMessage): WorkState {
  const message: UserMessage = { ...data, type: "user_message" };
  // 同一句话会来两次：排队时先来一次不带 message_id，并入会话后再来一次带 message_id（docs/api.md §5.1）。
  const existing = state.messages.findIndex(
    (m) => m.type === "user_message" && data.client_id && (m as UserMessage).client_id === data.client_id,
  );
  const outgoing = data.client_id ? state.outgoing.filter((m) => m.client_id !== data.client_id) : state.outgoing;
  if (existing >= 0) {
    const messages = [...state.messages];
    messages[existing] = { ...(messages[existing] as UserMessage), ...message };
    return { ...state, messages, outgoing };
  }
  return { ...appendMessage(state, message), outgoing };
}

function applyStep(state: WorkState, step: Step): WorkState {
  const work = state.currentWork ?? { work_id: step.work_id, started_at: "", triggered_by: null, steps: [] };
  if (work.work_id !== step.work_id) return state;
  const steps = [...work.steps];
  const index = steps.findIndex((s) => String(s.step_key) === String(step.step_key));
  if (index >= 0) steps[index] = step; // 同键的更正
  else steps.push(step);
  return { ...state, currentWork: { ...work, steps } };
}
