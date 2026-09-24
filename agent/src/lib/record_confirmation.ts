/**
 * 「登记用户确认」的核心逻辑：
 * 执行者认为用户在对话里接受了某几个条目时调用；工具读会话当前分支上「这几个版本产生之后」用户说过的原话，
 * 连同条目当前版本的内容交给确认判读者（一次不带工具的模型调用），判读结论由这里的代码写进库。
 * 执行者自己写不了确认记录；界面上点「确认」走扩展命令（user_ops.ts），不经这里。
 *
 * 分三步，模型调用夹在中间、不在事务里（事务里不能 await）：
 *   1. prepareJudgement：只读核对（条目存在、版本是当前版本、这一版之后用户说过话），装配提示；
 *   2. 调用方调模型，parseJudgement 解析与核对输出（每个条目恰好一条、接受的要有逐字摘录的依据）；
 *   3. writeJudgement：在立即事务里再核对一次版本（判读期间可能被改），写判读、判读明细、模型调用、事件。
 * 输出不合格、最终被拒时，writeFailedModelCalls 仍把这几次模型调用记进 model_call，留作证据。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ACTOR_EXECUTOR, databasePath, dump, emit, load, wallClockText } from "./db.ts";
import { withTaskDatabase } from "./schema.ts";
import { EVENT_CONFIRMATION_RECORDED } from "./user_ops.ts";

/** 判读者的系统提示，文字放在 prompts/ 下，由这里读出。 */
export const JUDGE_PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "judge_confirmation.md");

/**
 * 会话里是用户角色、但不是用户说的话：兜底扩展追加的那句、界面操作之后后端按模板发给执行者的话。
 * 判读者只看人说的话，这几种不交给它。文字要与 hooks/reply_fallback.ts、user_ops.ts、后端 executor.py 保持一致。
 */
export const NOT_USER_WORDS: { exact?: string; prefix?: string }[] = [
  { exact: "请用 reply 工具把要对用户说的话发出来" },
  { prefix: "我已经在界面上确认了：" },
  { prefix: "我先不管 " },
];

export function isUserWords(text: string): boolean {
  return !NOT_USER_WORDS.some((rule) => (rule.exact !== undefined ? text === rule.exact : text.startsWith(rule.prefix!)));
}

export class ConfirmationError extends Error {}

/** 会话当前分支上的一个条目（只列用得到的几项）。 */
export interface BranchEntry {
  id: string;
  type: string;
  timestamp?: string;
  customType?: string;
  details?: Record<string, unknown>;
  message?: { role?: string; content?: unknown };
}

export interface RequestedItem {
  item_id: string;
  version_no: number;
}

export interface PreparedItem extends RequestedItem {
  collection: string;
  fields: Record<string, unknown>;
  /** 在这一版产生之后说的用户原话的编号。 */
  after: string[];
}

export interface UserWords {
  id: string;
  text: string;
}

export interface PreparedJudgement {
  taskId: string;
  items: PreparedItem[];
  messages: UserWords[];
  system: string;
  user: string;
}

export interface Verdict {
  item_id: string;
  version_no: number;
  accepted: boolean;
  basis: { message: string; excerpt: string }[];
  note: string;
}

/** 一次模型调用的记录，写进 model_call。 */
export interface ModelCallRecord {
  prompt: string;
  output: string;
  outcome: "采用" | "输出不合格" | "调用失败";
  model: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface CallContext {
  workspaceDir: string;
  sessionId: string;
  callId: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n");
}

/** 核对参数的形状：items 是不为空的列表，每项有条目编号与从 1 起的整数版本号，编号不重复。 */
export function checkParams(params: unknown): RequestedItem[] {
  const items = (params as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ConfirmationError("缺少 items：要写明用户接受了哪几个条目，每项是 { item_id, version_no }。什么都没有登记。");
  }
  const seen = new Set<string>();
  const out: RequestedItem[] = [];
  items.forEach((raw, index) => {
    const one = raw as { item_id?: unknown; version_no?: unknown };
    if (typeof one?.item_id !== "string" || one.item_id.trim() === "") {
      throw new ConfirmationError(`items 的第 ${index + 1} 项要写 item_id（条目编号，例如 UC-001）。什么都没有登记。`);
    }
    if (!Number.isInteger(one.version_no) || (one.version_no as number) < 1) {
      throw new ConfirmationError(`items 的第 ${index + 1} 项（${one.item_id}）要写 version_no，一个从 1 起的整数。什么都没有登记。`);
    }
    if (seen.has(one.item_id)) throw new ConfirmationError(`items 里 ${one.item_id} 写了两次。什么都没有登记。`);
    seen.add(one.item_id);
    out.push({ item_id: one.item_id, version_no: one.version_no as number });
  });
  return out;
}

/** 一个条目某一版在分支上的位置：产生它的那次调用之后的第一个分支条目的下标。 */
function anchorIndex(branch: BranchEntry[], callId: string, at: string): number {
  for (let i = 0; i < branch.length; i++) {
    const e = branch[i];
    if (e.type === "message" && e.message?.role === "assistant") {
      const content = Array.isArray(e.message.content) ? e.message.content : [];
      if (content.some((part: any) => part?.type === "toolCall" && String(part.id) === callId)) return i + 1;
    }
    if (e.type === "custom_message" && (e.details as { op_id?: unknown } | undefined)?.op_id === callId) return i + 1;
  }
  // 当前分支上找不到产生这一版的那次调用（例如那一版产生在别的会话里）：退到比时刻。
  // 库里记的是本地时间文字，会话条目的时间戳是世界时；本地时间文字不带时区，按本地时区解析即可比较。
  const when = new Date(at).getTime();
  if (Number.isNaN(when)) return branch.length;
  const index = branch.findIndex((e) => e.timestamp && new Date(e.timestamp).getTime() >= when);
  return index < 0 ? branch.length : index;
}

/**
 * 第 1 步：只读核对并装配提示。库以只读方式打开，查完就关。
 * 拒绝：库或任务不存在；条目不存在或已删除；版本不是当前版本；某个条目这一版之后用户在这条会话里没说过话。
 */
export function prepareJudgement(workspaceDir: string, requested: RequestedItem[], branch: BranchEntry[]): PreparedJudgement {
  const path = databasePath(workspaceDir);
  if (!existsSync(path)) throw new ConfirmationError("这个任务目录还没有任务数据库，没有条目可以登记确认。");
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  let taskId: string;
  const items: PreparedItem[] = [];
  try {
    const task = db.prepare("SELECT task_id, status FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; status: string } | undefined;
    if (!task) throw new ConfirmationError("库里还没有任务，没有条目可以登记确认。");
    if (task.status !== "进行中") throw new ConfirmationError(`这个任务的状态是「${task.status}」，不能再登记确认。`);
    taskId = task.task_id;
    const problems: string[] = [];
    for (const want of requested) {
      const item = db.prepare("SELECT collection, deleted_in_revision FROM item WHERE task_id = ? AND item_id = ?").get(taskId, want.item_id) as
        | { collection: string; deleted_in_revision: number | null }
        | undefined;
      if (!item) { problems.push(`库里没有条目 ${want.item_id}`); continue; }
      if (item.deleted_in_revision !== null) { problems.push(`条目 ${want.item_id} 已经删除了`); continue; }
      const current = db.prepare(
        "SELECT v.version_no, v.fields, e.call_id, e.at FROM item_version v JOIN event e ON e.seq = v.event_seq " +
          "WHERE v.task_id = ? AND v.item_id = ? ORDER BY v.version_no DESC LIMIT 1",
      ).get(taskId, want.item_id) as { version_no: number; fields: string; call_id: string; at: string };
      if (current.version_no !== want.version_no) {
        problems.push(`条目 ${want.item_id} 现在是第 ${current.version_no} 版，你写的是第 ${want.version_no} 版；只能登记当前版本`);
        continue;
      }
      const start = anchorIndex(branch, current.call_id, current.at);
      const after = branch.slice(start)
        .filter((e) => e.type === "message" && e.message?.role === "user" && isUserWords(textOf(e.message.content)))
        .map((e) => e.id);
      items.push({ ...want, collection: item.collection, fields: (load(current.fields) as Record<string, unknown>) ?? {}, after });
    }
    if (problems.length) throw new ConfirmationError(`没有登记，因为：${problems.join("；")}。`);
  } finally {
    db.close();
  }
  const silent = items.filter((i) => i.after.length === 0).map((i) => `${i.item_id} 第 ${i.version_no} 版`);
  if (silent.length) {
    throw new ConfirmationError(
      `${silent.join("、")} 产生之后，用户在这条会话里还没有说过话，无从判读，什么都没有登记。` +
        "等用户明确表态之后再登记；用户在界面上点的确认已经直接记下了，不用再登记。",
    );
  }
  const used = new Set(items.flatMap((i) => i.after));
  const messages: UserWords[] = branch
    .filter((e) => used.has(e.id))
    .map((e) => ({ id: e.id, text: textOf(e.message!.content) }));
  const system = readFileSync(JUDGE_PROMPT_PATH, "utf-8");
  const user = [
    "要判读的条目：",
    ...items.map((i) => `- ${i.item_id} 第 ${i.version_no} 版（集合「${i.collection}」），内容：${JSON.stringify(i.fields, null, 0)}`),
    "",
    "用户原话（按先后排）：",
    ...messages.map((m) => {
      const forItems = items.filter((i) => i.after.includes(m.id)).map((i) => i.item_id).join("、");
      return `- 编号 ${m.id}（在 ${forItems} 的这一版产生之后说的）：${m.text}`;
    }),
  ].join("\n");
  return { taskId: taskId!, items, messages, system, user };
}

/** 从模型输出里取 JSON：先整段解析，不行就取第一个左花括号到最后一个右花括号之间那段。 */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new ConfirmationError("判读者的输出里没有 JSON 对象");
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new ConfirmationError("判读者的输出不是合法的 JSON");
    }
  }
}

/**
 * 第 2 步：解析并核对判读者的输出。核对的都是事实：每个条目恰好一条、版本对得上、态度只有两种；
 * 判为接受的要有依据，依据的消息必须是这个条目这一版之后的用户原话，摘录必须逐字出自那句话。
 * 不合格时抛 ConfirmationError，说明哪里不对（调用方据此重试一次）。
 */
export function parseJudgement(text: string, prepared: PreparedJudgement): Verdict[] {
  const raw = extractJson(text) as { 判读?: unknown };
  const list = raw?.判读;
  if (!Array.isArray(list)) throw new ConfirmationError("判读者的输出里没有「判读」列表");
  const problems: string[] = [];
  const verdicts: Verdict[] = [];
  const byId = new Map(prepared.items.map((i) => [i.item_id, i]));
  const seen = new Set<string>();
  for (const one of list as Record<string, unknown>[]) {
    const id = String(one?.条目 ?? "");
    const item = byId.get(id);
    if (!item) { problems.push(`判读里出现了没有要求判读的条目「${id}」`); continue; }
    if (seen.has(id)) { problems.push(`${id} 判读了两次`); continue; }
    seen.add(id);
    if (Number(one.版本) !== item.version_no) problems.push(`${id} 的版本写成了 ${String(one.版本)}，应当是 ${item.version_no}`);
    if (one.态度 !== "接受" && one.态度 !== "不接受") { problems.push(`${id} 的态度写成了「${String(one.态度)}」，只能是「接受」或「不接受」`); continue; }
    const basis = (Array.isArray(one.依据) ? one.依据 : []).map((b: any) => ({ message: String(b?.消息 ?? ""), excerpt: String(b?.摘录 ?? "") }));
    const accepted = one.态度 === "接受";
    if (accepted) {
      if (basis.length === 0) problems.push(`${id} 判为接受，但没有给依据`);
      for (const b of basis) {
        const words = prepared.messages.find((m) => m.id === b.message);
        if (!words || !item.after.includes(b.message)) problems.push(`${id} 的依据引用了消息「${b.message}」，它不是这一版之后的用户原话`);
        else if (!b.excerpt.trim() || !words.text.includes(b.excerpt)) problems.push(`${id} 的依据摘录「${b.excerpt}」没有逐字出现在消息 ${b.message} 里`);
      }
    }
    verdicts.push({ item_id: id, version_no: item.version_no, accepted, basis, note: String(one.说明 ?? "") });
  }
  for (const item of prepared.items) if (!seen.has(item.item_id)) problems.push(`判读里漏了 ${item.item_id}`);
  if (problems.length) throw new ConfirmationError(`判读者的输出不合格：${problems.join("；")}`);
  return verdicts;
}

function insertModelCalls(db: DatabaseSync, taskId: string, toolCallId: string, calls: ModelCallRecord[], judgementId: number | null): void {
  const insert = db.prepare(
    "INSERT INTO model_call (task_id, role, judgement_id, review_id, tool_call_id, prompt, output, outcome, model, duration_ms, " +
      "input_tokens, output_tokens, created_at) VALUES (?, '判读者', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const c of calls) {
    insert.run(taskId, c.outcome === "采用" ? judgementId : null, toolCallId, c.prompt, c.output, c.outcome, c.model, c.durationMs,
      c.inputTokens, c.outputTokens, wallClockText());
  }
}

export interface JudgementOutcome {
  text: string;
  details: { judgement_id: number; event_seq: number; accepted: RequestedItem[]; not_accepted: RequestedItem[]; verdicts: Verdict[] };
}

/**
 * 第 3 步：写库。判读期间条目可能被改，这里在事务里再核对一次版本，不是当前版本就拒绝（模型调用照样记下）。
 * 事件 CONFIRMATION_RECORDED 的 basis 写 user_words，与界面点击的 ui_click 区分；发起方是执行者（是它调的工具）。
 */
export function writeJudgement(
  call: CallContext, prepared: PreparedJudgement, verdicts: Verdict[], calls: ModelCallRecord[],
): JudgementOutcome | { changed: string[] } {
  return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => {
    const changed: string[] = [];
    for (const v of verdicts) {
      const current = db.prepare("SELECT MAX(version_no) AS n FROM item_version WHERE task_id = ? AND item_id = ?").get(prepared.taskId, v.item_id) as { n: number };
      if (current.n !== v.version_no) changed.push(`${v.item_id} 在判读期间被改到了第 ${current.n} 版`);
    }
    if (changed.length) {
      // 不写判读，但这几次模型调用要留下来：不抛异常（抛了事务会回滚），返回原因由调用方拒绝。
      insertModelCalls(db, prepared.taskId, call.callId, calls.map((c) => ({ ...c, outcome: c.outcome === "采用" ? "输出不合格" : c.outcome })), null);
      return { changed };
    }
    const seq = emit(db, {
      taskId: prepared.taskId,
      sessionId: call.sessionId,
      callId: call.callId,
      name: EVENT_CONFIRMATION_RECORDED,
      payload: { items: verdicts.map((v) => ({ item_id: v.item_id, version_no: v.version_no, accepted: v.accepted })), basis: "user_words" },
      actor: ACTOR_EXECUTOR,
    });
    const basis = verdicts.flatMap((v) => v.basis.map((b) => ({ 条目: v.item_id, 会话条目: `${call.sessionId}#${b.message}`, 摘录: b.excerpt })));
    const judgementId = Number(db.prepare("INSERT INTO judgement (task_id, basis, call_id, event_seq, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(prepared.taskId, dump(basis), call.callId, seq, wallClockText()).lastInsertRowid);
    const insert = db.prepare(
      "INSERT INTO judgement_item (judgement_id, task_id, item_id, version_no, attitude, event_seq) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const v of verdicts) insert.run(judgementId, prepared.taskId, v.item_id, v.version_no, v.accepted ? "接受" : "不接受", seq);
    insertModelCalls(db, prepared.taskId, call.callId, calls, judgementId);
    const accepted = verdicts.filter((v) => v.accepted);
    const rejected = verdicts.filter((v) => !v.accepted);
    const line = (v: Verdict) => `${v.item_id} 第 ${v.version_no} 版` +
      (v.basis.length ? `（依据：${v.basis.map((b) => `「${b.excerpt}」`).join("、")}）` : v.note ? `（${v.note}）` : "");
    const text = [
      `已登记确认判读（第 ${judgementId} 次判读）。`,
      accepted.length ? `判读者判定用户接受了：${accepted.map(line).join("；")}。` : "判读者判定用户没有接受任何一条。",
      rejected.length ? `没有判为接受的：${rejected.map(line).join("；")}。这几条不算用户确认，需要时请把不清楚的地方问清楚。` : "",
    ].filter(Boolean).join("\n");
    return {
      text,
      details: {
        judgement_id: judgementId, event_seq: seq, verdicts,
        accepted: accepted.map(({ item_id, version_no }) => ({ item_id, version_no })),
        not_accepted: rejected.map(({ item_id, version_no }) => ({ item_id, version_no })),
      },
    };
  });
}

/** 被拒之前把这几次模型调用记下来（输出不合格或调用失败），关联判读为空。 */
export function writeFailedModelCalls(call: CallContext, taskId: string, calls: ModelCallRecord[]): void {
  if (!calls.length) return;
  withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => insertModelCalls(db, taskId, call.callId, calls, null));
}
