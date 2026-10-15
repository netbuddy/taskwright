/**
 * 对话行为留痕：执行者对用户每句话的理解、执行者回复里的对话行为，以及由此现算的三个事实。
 *
 * 做法（一句话）：用户每说一句话，执行者在这一轮的文字输出里写一份按 agent/prompts/schemas/user_intent.schema.json
 * 写的 JSON，写明它把这句话读成了哪几项对话行为。理解是登记的结构化输出之一（本模块的 USER_INTENT_OUTPUT，
 * 登记表见 lib/registered_outputs.ts）：扩展在每条助手消息落进会话时扫它的全部文字段，按 schema 认出理解
 * （识别的做法见 lib/structured_outputs.ts），事实核对也过了就写进对话行为表并记事件 USER_INTENT_RECORDED，
 * 事实核对不过记事件 USER_INTENT_INVALID 带原因。这一轮结束时（pi 的 agent_settled）这句话仍没有合格的理解，
 * 记事件 USER_INTENT_MISSING，这是唯一算失败的情形。
 * 保存修订、发布版本、回复三个工具执行时，这一轮（自用户最近一句话起）没有合格的理解就拒绝。
 * 「回复」合格时把它的告知与向用户要的回应也写进对话行为表，编号返回给执行者，用户下一句话的 responds_to 才有所指。
 *
 * 本模块只核对形式与事实（枚举、必填、responds_to 指向的行为存在且还没有被回应、targets 里的条目存在），
 * 不判断理解对不对，也不据对话行为做任何决定。三个派生事实（还在等回应的执行者行为、连续追问次数、改口次数）
 * 只是算出来交给执行者看，代码不据此判断。
 *
 * 本模块不依赖 pi：会话分支由调用方读好交进来，单元测试可以直接调用。
 */

import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { FALLBACK_TEXT } from "../hooks/reply_fallback.ts";
import { ACTOR_EXECUTOR, ACTOR_USER, databasePath, dump, emit, load, wallClockText } from "./db.ts";
import { hasColumn, hasDialogueTable } from "./dialogue_schema.ts";
import { FUNCTION_NAMES, GATE_INVALID_TEXT, GATE_MISSING_TEXT, INTENT_GATE_TEXT, INTENT_SCHEMA, INTENT_SCHEMA_FILE, SUMMARY_LIMIT } from "./intent_schema.ts";
import { BUSY_TIMEOUT_MS, NoDatabaseYet, withTaskDatabase } from "./schema.ts";
import { proposalFor, proposalKindOf } from "./stage_proposal.ts";
import { ToolRejection } from "./tool_rejection.ts";
import {
  type ScanOutcome,
  type StructuredOutput,
  type Turn,
  nearestProblems,
  recordOutputs,
  recordTurnEnd,
  turnDiagnoses,
} from "./structured_outputs.ts";

/** 事件名。 */
export const EVENT_USER_INTENT_RECORDED = "USER_INTENT_RECORDED";
export const EVENT_USER_INTENT_INVALID = "USER_INTENT_INVALID";
/** 这一轮结束时这句用户的话仍没有合格的理解。唯一算失败的情形。 */
export const EVENT_USER_INTENT_MISSING = "USER_INTENT_MISSING";
export const EVENT_EXECUTOR_ACTS_RECORDED = "EXECUTOR_ACTS_RECORDED";

// ───────────── 会话分支：这一轮是哪句话引出的 ─────────────

type Entry = {
  id: string;
  type: string;
  customType?: string;
  details?: any;
  message?: { role?: string; content?: unknown; stopReason?: string };
};

/** 卡片点击的标注、界面操作通知两种自定义消息的类型名（与 hooks/user_commands.ts 同名常量一致）。 */
const UI_CLICK_TYPE = "taskwright-ui-click";
const USER_EDIT_TYPE = "taskwright-user-edit";
/**
 * 用户在卡片的文本框里打了一句话时，扩展命令 /tw-ui 先追加的那条自定义消息的类型。它不是点击：同意判定（lib/completion_consent.ts 的
 * cardClicks）与按点击合成用户行为（synthesizedBy）都只认 taskwright-ui-click，所以这句话照常要执行者写理解，也不会被当成点了哪个选项。
 */
export const CARD_TYPED_TYPE = "taskwright-card-typed";
/** 页面在卡片的文本框里发话时，卡片标识里 choice 写的固定值。 */
export const CARD_TYPED_KEY = "typed";
/** 卡片上点「这几条都看过了」之后替用户发的那句话的开头（lib/user_ops.ts 的 VIEWED_NOTICE_PREFIX）。 */
const VIEWED_PREFIX = "我已经看过了：";
/** 「先不管这条」之后后端替用户发的那句话的开头（backend/src/executor.ts 的 KEEP_PENDING_NOTICE_PREFIX）。 */
const KEEP_PENDING_PREFIX = "我先不管 ";

/** 这一轮的用户的话是系统按界面操作合成的：哪种操作、牵涉哪些条目、点的是哪条回复的哪个选项。 */
export interface Synthesized {
  kind: "card_choice" | "viewed" | "keep_pending";
  items: string[];
  replyEntry?: string | null;
  option?: string | null;
}

/** 这一次运行：由会话当前分支上最近一句用户的话引出。 */
export interface RunInfo {
  runNo: number;
  runId: string;
  userEntryId: string;
  userText: string;
  synthesized: Synthesized | null;
  /** 这句话是用户在某张卡片的文本框里打的：卡片所在回复的会话条目编号；不是时为 null。 */
  typedCard: string | null;
  /** 这句话之后分支上已经有几条助手消息。 */
  assistantCount: number;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("");
}

/**
 * 会话当前分支上的每一次运行，按先后排。运行号是分支上第几句用户的话；「回复」兜底追加的那句固定文字不算，
 * 因为兜底之后的续跑仍属于同一次运行。
 */
export function branchRuns(branch: Entry[]): RunInfo[] {
  const runs: RunInfo[] = [];
  let lastCustom: Entry | null = null;
  for (const entry of branch) {
    if (entry.type === "custom_message") {
      lastCustom = entry;
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role === "user") {
      const text = textOf(entry.message.content);
      if (text.trim() === FALLBACK_TEXT) continue;
      const runNo = runs.length + 1;
      runs.push({ runNo, runId: `r${runNo}`, userEntryId: entry.id, userText: text, synthesized: synthesizedBy(lastCustom, text),
        typedCard: typedCardOf(lastCustom, text), assistantCount: 0 });
      lastCustom = null;
    } else if (role === "assistant" && runs.length > 0) {
      runs[runs.length - 1].assistantCount += 1;
    }
  }
  return runs;
}

/** 这一次运行：由会话当前分支上最近一句用户的话引出。分支上没有用户的话时返回 null。 */
export function currentRun(branch: Entry[]): RunInfo | null {
  return branchRuns(branch).at(-1) ?? null;
}

/** 这句用户的话是不是系统按界面操作合成的：紧挨在它前面的那条自定义消息说明了是哪种操作。 */
function synthesizedBy(custom: Entry | null, text: string): Synthesized | null {
  if (!custom) return null;
  const details = custom.details ?? {};
  if (custom.customType === UI_CLICK_TYPE && details.text === text) {
    return { kind: "card_choice", items: [], replyEntry: details.reply_entry ?? null, option: details.option_text ?? null };
  }
  if (custom.customType === USER_EDIT_TYPE) {
    const items = (Array.isArray(details.results) ? details.results : []).map((one: any) => String(one?.item_id ?? "")).filter(Boolean);
    if (details.kind === "mark_viewed" && text.startsWith(VIEWED_PREFIX)) return { kind: "viewed", items };
    if (details.kind === "keep_pending" && text.startsWith(KEEP_PENDING_PREFIX)) return { kind: "keep_pending", items };
  }
  return null;
}

/** 这句用户的话是不是在某张卡片的文本框里打的：紧挨在它前面的那条自定义消息记着是哪条回复的卡片。 */
function typedCardOf(custom: Entry | null, text: string): string | null {
  if (!custom || custom.customType !== CARD_TYPED_TYPE) return null;
  const details = custom.details ?? {};
  return details.text === text && typeof details.reply_entry === "string" && details.reply_entry ? details.reply_entry : null;
}

// ───────────── 写库 ─────────────

export interface Target {
  item_id: string;
  field?: string;
  index?: number;
}

export interface UserAct {
  function: string;
  targets?: Target[];
  responds_to?: string;
  confidence: string;
  summary: string;
}

interface ActRow {
  act_id: string;
  run_id: string;
  speaker: string;
  function: string;
  targets: string;
  responds_to: string | null;
  expects_response: number;
  confidence: string | null;
  summary: string;
  source_entry: string | null;
  origin: string;
}

function taskIdOf(db: DatabaseSync): string | null {
  return (db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string } | undefined)?.task_id ?? null;
}

/** 这次运行里下一个序号。 */
function nextSerial(db: DatabaseSync, taskId: string, sessionId: string, runId: string): number {
  const rows = db.prepare("SELECT act_id FROM dialogue_act WHERE task_id = ? AND session_id = ? AND run_id = ?").all(taskId, sessionId, runId) as { act_id: string }[];
  return rows.reduce((max, row) => Math.max(max, Number(row.act_id.split("-")[1]) || 0), 0) + 1;
}

function insertAct(db: DatabaseSync, taskId: string, sessionId: string, row: ActRow, seq: number, at: string): void {
  db.prepare(
    "INSERT INTO dialogue_act (task_id, session_id, act_id, run_id, speaker, function, targets, responds_to, expects_response, " +
      "confidence, summary, source_entry, origin, event_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(taskId, sessionId, row.act_id, row.run_id, row.speaker, row.function, row.targets, row.responds_to, row.expects_response,
    row.confidence, row.summary, row.source_entry, row.origin, seq, at);
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return [...flat].length > SUMMARY_LIMIT ? `${[...flat].slice(0, SUMMARY_LIMIT - 1).join("")}…` : flat;
}

/** 这一句用户的话已经有用户的对话行为记下了没有（执行者写的理解，或者界面操作合成的）。 */
function hasUserActs(db: DatabaseSync, taskId: string, sessionId: string, userEntryId: string): boolean {
  return db.prepare("SELECT 1 FROM dialogue_act WHERE task_id = ? AND session_id = ? AND speaker = 'user' AND source_entry = ?")
    .get(taskId, sessionId, userEntryId) !== undefined;
}

/** 一条执行者行为有没有被用户回应过；回应过返回回应它的那条的编号。 */
function answeredBy(db: DatabaseSync, taskId: string, sessionId: string, actId: string): string | null {
  const row = db.prepare("SELECT act_id FROM dialogue_act WHERE task_id = ? AND session_id = ? AND speaker = 'user' AND responds_to = ? ORDER BY rowid LIMIT 1")
    .get(taskId, sessionId, actId) as { act_id: string } | undefined;
  return row?.act_id ?? null;
}

/** 用户那句原话写进拒绝文字时的样子：去掉首尾空白，超过 60 个字截短加省略号。 */
export function quotedUserText(text: string): string {
  const chars = [...text.trim()];
  return chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : chars.join("");
}

/**
 * 一份理解的摘要说的是不是系统那句提醒（FALLBACK_TEXT「请用 reply 工具把要对用户说的话发出来」），不是用户的话。
 * 那句提醒是系统以用户名义发的，不算一次新的运行，这一轮要写理解的仍是它之前用户的那句话；助手被拒几次之后有时会对着提醒写理解。
 * 只看字面：摘要里出现「reply 工具」「回复工具」或「把要对用户说的话发出来」。
 */
export function aboutReminder(summary: string): boolean {
  return /reply\s*工具|回复工具|把要对用户说的话发出来/.test(summary);
}

/**
 * 核对一份已经符合 schema 的理解里的几样事实：responds_to 指向这条会话里有的执行者行为、
 * 那一条期待回应时还没有被回应过；targets 里的条目在这个任务里有（删掉的条目也算有）；摘要说的不是系统的那句提醒。
 * userText 是这一轮用户的那句原话，给了就写进提醒那一条的说明里。typedCard 是这句话所在的那张卡片（用户在卡片的文本框里打的字，
 * 值是卡片所在回复的条目编号）：那张卡片还开着时，理解里要有一项回应它。返回逐条的问题。
 */
export function understandingFactErrors(db: DatabaseSync, taskId: string, sessionId: string, value: unknown, userText?: string,
  typedCard?: string | null): string[] {
  const errors: string[] = [];
  const acts = (value as { acts: UserAct[] }).acts;
  // 这句话是用户在一张还开着的卡片的文本框里打的：页面已经把那张卡片算作答过，理解里要有一项回应它，库里才对得上。
  const card = typedCard ? unansweredActs(db, taskId, sessionId).find((one) => one.source_entry === typedCard) : undefined;
  if (card && !acts.some((act) => act.responds_to === card.act_id)) {
    errors.push(`这句话是用户在 ${card.act_id} 那张卡片的文本框里写的，是在回应这张卡片；理解里要有一项的 responds_to 写 ${card.act_id}`);
  }
  const itemExists = db.prepare("SELECT 1 FROM item WHERE task_id = ? AND item_id = ?");
  const actRow = db.prepare("SELECT speaker, expects_response FROM dialogue_act WHERE task_id = ? AND session_id = ? AND act_id = ?");
  acts.forEach((act, index) => {
    const where = `acts[${index}]`;
    if (act.responds_to !== undefined) {
      const row = actRow.get(taskId, sessionId, act.responds_to) as { speaker: string; expects_response: number } | undefined;
      if (!row) errors.push(`${where}.responds_to 写的是 ${act.responds_to}，这条会话里没有这个编号的对话行为；编号写在你上一次「回复」的返回里（「本轮记了 rN-M」）`);
      else if (row.speaker !== "executor") errors.push(`${where}.responds_to 写的是 ${act.responds_to}，那是用户的行为；只能指向你（执行者）的行为`);
      else if (row.expects_response === 1) {
        const by = answeredBy(db, taskId, sessionId, act.responds_to);
        const resent = by ? null : resentBy(db, taskId, sessionId, act.responds_to);
        if (by) errors.push(`${where}.responds_to 写的是 ${act.responds_to}，它已经被 ${by} 回应过了；这句话不是在回应它时不写 responds_to`);
        else if (resent) errors.push(`${where}.responds_to 写的是 ${act.responds_to}，那张卡片后来重发成了 ${resent}；用户回应的是这件事时 responds_to 写 ${resent}`);
      }
    }
    if (typeof act.summary === "string" && aboutReminder(act.summary)) {
      errors.push(`${where}.summary 说的是系统的那句提醒（「${FALLBACK_TEXT}」），那不是用户的话` +
        (userText?.trim() ? `；这一轮要写理解的是用户这句：「${quotedUserText(userText)}」` : "；要写理解的是它之前用户的那句话"));
    }
    for (const target of act.targets ?? []) {
      if (!itemExists.get(taskId, target.item_id)) errors.push(`${where}.targets 里的 ${target.item_id} 在这个任务里没有；targets 只写已有的条目，说的不是某个条目时不写 targets`);
    }
  });
  return errors;
}

/**
 * 登记的结构化输出之一：执行者对用户这句话的理解。schema 就是发给执行者的那一份（平台说明里的说明由它生成）；
 * 每句用户的话都必须有一份，这一轮结束时没有就记 USER_INTENT_MISSING。
 */
export const USER_INTENT_OUTPUT: StructuredOutput = {
  name: "user_intent",
  schemaFile: INTENT_SCHEMA_FILE,
  schema: INTENT_SCHEMA,
  invalidEvent: EVENT_USER_INTENT_INVALID,
  alreadyRecorded: (db, turn) => hasUserActs(db, turn.taskId, turn.sessionId, turn.userEntryId),
  checkFacts: (db, turn, value) => understandingFactErrors(db, turn.taskId, turn.sessionId, value, turn.userText, turn.typedCard),
  record: (db, turn, value) => writeUnderstanding(db, turn, (value as { acts: UserAct[] }).acts),
  recordInvalid: (db, turn, written, errors) => writeInvalid(db, turn, errors.join("；"), written),
  requiredEachTurn: { recordMissing: (db, turn, nearest) => writeMissing(db, turn, nearest) },
};

/** 扩展处理一条助手消息之后的结果。synthesized 是这一轮界面操作合成的那句话按事实记下的用户行为。 */
export type RecordOutcome =
  | ({ kind: "scanned"; synthesized?: { actIds: string[]; eventSeq: number } } & ScanOutcome)
  | { kind: "skipped"; why: string };

/** 打开任务库，找到这一轮，交给 body；没有任务库、库里没有任务时返回 skipped。 */
function inTurn<T>(workspaceDir: string, sessionId: string, run: RunInfo, body: (db: DatabaseSync, turn: Turn) => T): T | { kind: "skipped"; why: string } {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) return { kind: "skipped", why: "还没有任务库" };
  try {
    return withTaskDatabase(workspaceDir, { createIfMissing: false }, (db) => {
      const taskId = taskIdOf(db);
      if (!taskId) return { kind: "skipped", why: "库里还没有任务" } as const;
      return body(db, { taskId, sessionId, runId: run.runId, userEntryId: run.userEntryId, userText: run.userText, typedCard: run.typedCard });
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) return { kind: "skipped", why: "还没有任务库" };
    throw error;
  }
}

/**
 * 助手消息落进会话时调用（挂在 message_end 上）。这一轮的用户的话是界面操作合成的、还没有记下时，先按操作的事实直接写；
 * 然后扫这条消息的全部文字段，按登记表 outputs 认出结构化输出并记下，未匹配与无法解析的片段记一条诊断
 * （见 lib/structured_outputs.ts 的 recordOutputs）。出错或被中止的消息不扫。
 */
export function recordFromAssistantMessage(
  workspaceDir: string,
  sessionId: string,
  branch: Entry[],
  message: { content?: unknown; stopReason?: string },
  outputs: readonly StructuredOutput[],
): RecordOutcome {
  if (message.stopReason === "error" || message.stopReason === "aborted") return { kind: "skipped", why: "这条助手消息出错或被中止" };
  const run = currentRun(branch);
  if (!run) return { kind: "skipped", why: "会话里还没有用户的话" };
  return inTurn(workspaceDir, sessionId, run, (db, turn): RecordOutcome => {
    const synthesized = run.synthesized && !hasUserActs(db, turn.taskId, sessionId, run.userEntryId)
      ? writeSynthesized(db, turn.taskId, sessionId, run) : undefined;
    return { kind: "scanned", ...(synthesized ? { synthesized } : {}), ...recordOutputs(db, turn, message.content, outputs) };
  });
}

/**
 * 一次运行安顿下来时调用（挂在 pi 的 agent_settled 上）：userEntryIds 是这段处理里出现过的用户的话（会话条目编号），
 * 连同分支上最近一句，逐句检查每句都必须有的那几种输出。界面操作合成的那句话还没有记下时按操作的事实补记；
 * 其余仍没有合格的一份的，由那一种记失败（理解是 USER_INTENT_MISSING）。返回每句话记了失败的输出名。
 */
export function recordAtSettle(
  workspaceDir: string,
  sessionId: string,
  branch: Entry[],
  userEntryIds: Iterable<string>,
  outputs: readonly StructuredOutput[],
): { userEntryId: string; missing: string[] }[] {
  const runs = branchRuns(branch);
  const wanted = new Set(userEntryIds);
  const last = runs.at(-1);
  if (last) wanted.add(last.userEntryId);
  const out: { userEntryId: string; missing: string[] }[] = [];
  for (const run of runs.filter((one) => wanted.has(one.userEntryId))) {
    const result = inTurn(workspaceDir, sessionId, run, (db, turn) => {
      if (run.synthesized && !hasUserActs(db, turn.taskId, sessionId, run.userEntryId)) writeSynthesized(db, turn.taskId, sessionId, run);
      return recordTurnEnd(db, turn, outputs);
    });
    if (Array.isArray(result)) out.push({ userEntryId: run.userEntryId, missing: result });
  }
  return out;
}

function writeUnderstanding(db: DatabaseSync, turn: Turn, acts: UserAct[]): number {
  const { taskId, sessionId, runId, userEntryId } = turn;
  const serial = nextSerial(db, taskId, sessionId, runId);
  const rows: ActRow[] = acts.map((act, index) => ({
    act_id: `${runId}-${serial + index}`,
    run_id: runId,
    speaker: "user",
    function: act.function,
    targets: dump(act.targets ?? []),
    responds_to: act.responds_to ?? null,
    expects_response: 0,
    confidence: act.confidence,
    summary: act.summary.trim(),
    source_entry: userEntryId,
    origin: "understanding",
  }));
  const seq = emit(db, {
    taskId, sessionId, callId: `intent-${userEntryId}`, name: EVENT_USER_INTENT_RECORDED, actor: ACTOR_EXECUTOR,
    payload: { run_id: runId, user_entry: userEntryId, origin: "understanding", acts: rows.map(payloadOf) },
  });
  const at = wallClockText();
  for (const row of rows) insertAct(db, taskId, sessionId, row, seq, at);
  return seq;
}

/** 一份符合 schema、但事实核对不过的理解。 */
function writeInvalid(db: DatabaseSync, turn: Turn, reason: string, written: string): number {
  return emit(db, {
    taskId: turn.taskId, sessionId: turn.sessionId, callId: `intent-${turn.userEntryId}`, name: EVENT_USER_INTENT_INVALID, actor: ACTOR_EXECUTOR,
    payload: { run_id: turn.runId, user_entry: turn.userEntryId, reason, written: [...written].slice(0, 400).join("") },
  });
}

/** 失败事件的原因。 */
export const MISSING_REASON = "这一轮结束时没有合格的理解";

/** 这一轮结束时仍没有合格的理解。nearest 是本轮各片段离理解格式最近的问题（没有片段时为空）。 */
function writeMissing(db: DatabaseSync, turn: Turn, nearest: string[]): number {
  return emit(db, {
    taskId: turn.taskId, sessionId: turn.sessionId, callId: `intent-${turn.userEntryId}`, name: EVENT_USER_INTENT_MISSING, actor: ACTOR_EXECUTOR,
    payload: { run_id: turn.runId, user_entry: turn.userEntryId, reason: MISSING_REASON, nearest },
  });
}

/**
 * 界面操作合成的那句话：按操作的事实写一条用户行为，执行者不写理解。
 * 卡片上选了一个选项是告知（inform），回应那张卡片上要的回应；「这几条都看过了」是同意（affirm），
 * 「先不管」是告知，二者回应这条会话里最近一条还在等回应、针对这几个条目的执行者行为（没有就不写 responds_to）。
 */
function writeSynthesized(db: DatabaseSync, taskId: string, sessionId: string, run: RunInfo): { actIds: string[]; eventSeq: number } {
  const synth = run.synthesized!;
  const open = unansweredActs(db, taskId, sessionId);
  let respondsTo: string | null = null;
  let targets: Target[] = synth.items.map((item_id) => ({ item_id }));
  let fn = "inform";
  let summary = run.userText;
  if (synth.kind === "card_choice") {
    const card = open.find((one) => one.source_entry === synth.replyEntry);
    respondsTo = card?.act_id ?? null;
    targets = card ? (load(card.targets) as Target[]) : [];
    summary = synth.option ? `在卡片上选了「${synth.option}」` : run.userText;
  } else {
    fn = synth.kind === "viewed" ? "affirm" : "inform";
    const hit = [...open].reverse().find((one) => (load(one.targets) as Target[]).some((t) => synth.items.includes(t.item_id)));
    respondsTo = hit?.act_id ?? null;
    summary = synth.kind === "viewed" ? `在卡片上表示看过了 ${synth.items.join("、")}` : `${synth.items.join("、")} 先不管`;
  }
  const row: ActRow = {
    act_id: `${run.runId}-${nextSerial(db, taskId, sessionId, run.runId)}`,
    run_id: run.runId, speaker: "user", function: fn, targets: dump(targets), responds_to: respondsTo, expects_response: 0,
    confidence: "high", summary: clip(summary), source_entry: run.userEntryId, origin: "ui",
  };
  const seq = emit(db, {
    taskId, sessionId, callId: `intent-${run.userEntryId}`, name: EVENT_USER_INTENT_RECORDED, actor: ACTOR_USER,
    payload: { run_id: run.runId, user_entry: run.userEntryId, origin: "ui", ui_kind: synth.kind, acts: [payloadOf(row)] },
  });
  insertAct(db, taskId, sessionId, row, seq, wallClockText());
  return { actIds: [row.act_id], eventSeq: seq };
}

function payloadOf(row: ActRow) {
  return { act_id: row.act_id, function: row.function, targets: load(row.targets), responds_to: row.responds_to, confidence: row.confidence, summary: row.summary };
}

// ───────────── 门禁 ─────────────

/**
 * 三个工具（保存修订、发布版本、回复）执行时调用：这一轮（自用户最近一句话起）没有合格的理解就抛异常拒绝，
 * 理由附上本轮各片段离理解格式最近的问题（校验错误、解析错误或事实核对的问题）；没有片段时说这一轮还没有写理解。
 * 会话里没有用户的话、或者还没有任务库时不拦（没有要理解的话，也没有地方记）。
 */
export function requireUnderstanding(workspaceDir: string, sessionId: string, branch: Entry[], label: string, toolName: string): void {
  const run = currentRun(branch);
  if (!run) return;
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) return;
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  let problems: string[] = [];
  try {
    if (!hasDialogueTable(db)) {
      problems = ["库里还没有对话行为表"];
    } else {
      const taskId = taskIdOf(db);
      if (!taskId || hasUserActs(db, taskId, sessionId, run.userEntryId)) return;
      problems = nearestProblems(turnDiagnoses(db, sessionId, run.userEntryId, [USER_INTENT_OUTPUT]), USER_INTENT_OUTPUT.name);
    }
  } finally {
    db.close();
  }
  const shown = problems.slice(-GATE_PROBLEMS_SHOWN);
  const why = shown.length === 0
    ? GATE_MISSING_TEXT
    : `这一轮写了 ${problems.length} 个 JSON 片段，${GATE_INVALID_TEXT}。` +
      `${problems.length > shown.length ? `最近 ${shown.length} 个` : "各片段"}的问题：` + shown.map((one, i) => `（${i + 1}）${one}`).join("");
  // 引出用户那句原话：助手被拒几次之后容易忘了要理解的是哪一句。
  const said = run.userText.trim() ? `：「${quotedUserText(run.userText)}」` : "";
  const fact = `${label}没有执行：${INTENT_GATE_TEXT}${said}。${why}。`;
  const guidance = "请按平台说明「先写理解」一节的格式，在你的文字输出里写一个 JSON 对象，写下你对用户这句话的理解，" +
    `写完接着调用 ${toolName}。`;
  throw new ToolRejection(`${fact}\n${guidance}`, fact, guidance, "gate");
}

/** 门禁拒绝时最多列几个片段的问题（最近的几个）。 */
const GATE_PROBLEMS_SHOWN = 3;

// ───────────── 回复工具记执行者的行为 ─────────────

export interface ReplyForActs {
  /** 旧的写法里一条告知是一句纯文字，新的是 { text, items }；两种都认。 */
  informs: (string | { text: string; items?: { item_id: string }[] })[];
  act: { kind: string; text: string; items?: { item_id: string; revision_no?: number }[]; options?: { key: string; text: string }[];
    /** 这张卡片重发的是先前哪一张（行为编号）；不是重发时不写。 */
    resends?: string } | null;
}

/**
 * 回复里另带的一件事（现在只有移动工作阶段）在同一个事务里做完之后交回来的三样：text 接在给执行者看的那句话前面；
 * payload 并进 EXECUTOR_ACTS_RECORDED 这条事件（没有就不并）；value 原样放进返回的 extra。
 */
export interface ReplyExtra<T> {
  text: string;
  payload?: Record<string, unknown>;
  value: T;
}

/**
 * 「回复」合格时调用：每条告知记一条 inform（不期待回应，targets 取它点名的条目），向用户要的回应记一条对应功能（期待回应），
 * 记一条事件 EXECUTOR_ACTS_RECORDED。返回记下的编号与给执行者看的一句话。没有任务库时什么都不记，返回 null。
 * 向用户要的回应是一张提议进入下一个阶段的请选择卡片时，事件里另带一项 proposal（lib/stage_proposal.ts）：任务的提议开着没有就从它推。
 * also 给了时，在同一个事务里先调它（传任务编号与运行号），它的结果按 ReplyExtra 的说明并进来。
 */
export function recordReplyActs<T = never>(
  workspaceDir: string,
  sessionId: string,
  branch: Entry[],
  reply: ReplyForActs,
  replyEntryId: string | null,
  toolCallId: string,
  also?: (db: DatabaseSync, taskId: string, runId: string) => ReplyExtra<T>,
): { acts: { act_id: string; function: string; summary: string; expects_response: boolean }[]; text: string; eventSeq: number | null; extra?: T | null;
  /** 用户这句话回答了哪几张卡片：卡片所在回复的会话条目编号（见 answeredCards）。 */
  answersCard: string[];
  /** 这次回复的卡片重发的是哪一张：原来那张所在回复的会话条目编号；不是重发时为 null。 */
  resendsCard: string | null } | null {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const run = currentRun(branch);
  const runId = run?.runId ?? "r0";
  try {
    return withTaskDatabase(workspaceDir, { createIfMissing: false }, (db) => {
      const taskId = taskIdOf(db);
      if (!taskId) return null;
      const extra = also ? also(db, taskId, runId) : null;
      const answersCard = run ? answeredCards(db, taskId, sessionId, run.userEntryId) : [];
      let serial = nextSerial(db, taskId, sessionId, runId);
      const rows: ActRow[] = [];
      const base = { run_id: runId, speaker: "executor", responds_to: null, confidence: null, source_entry: replyEntryId, origin: "reply" };
      for (const inform of reply.informs) {
        const one = typeof inform === "string" ? { text: inform } : inform;
        const targets = (one.items ?? []).map((ref) => ({ item_id: ref.item_id }));
        rows.push({ ...base, act_id: `${runId}-${serial++}`, function: "inform", targets: dump(targets), expects_response: 0, summary: clip(one.text) });
      }
      if (reply.act) {
        const targets = (reply.act.items ?? []).map((one) => ({ item_id: one.item_id }));
        // 重发：新的这一行回应原来那张，原来那张从此不再算等回应（unansweredActs）。
        rows.push({ ...base, act_id: `${runId}-${serial++}`, function: reply.act.kind, targets: dump(targets), expects_response: 1, summary: clip(reply.act.text),
          responds_to: reply.act.resends ?? null });
      }
      const resends = reply.act?.resends ?? null;
      const resendsCard = resends
        ? ((db.prepare("SELECT source_entry FROM dialogue_act WHERE task_id = ? AND session_id = ? AND act_id = ?").get(taskId, sessionId, resends) as
          { source_entry: string | null } | undefined)?.source_entry ?? null)
        : null;
      // 没有告知也没有要的回应：不记这条事件，除非另带的那件事有话要留在事件里。
      if (rows.length === 0 && !extra?.payload) return { acts: [], text: extra?.text ?? "", eventSeq: null, extra: extra?.value ?? null, answersCard, resendsCard };
      const proposal = reply.act ? proposalFor(db, taskId, reply.act) : null;
      const seq = emit(db, {
        taskId, sessionId, callId: toolCallId, name: EVENT_EXECUTOR_ACTS_RECORDED, actor: ACTOR_EXECUTOR,
        payload: { run_id: runId, reply_entry: replyEntryId, acts: rows.map(payloadOf), ...(proposal ? { proposal } : {}), ...(extra?.payload ?? {}) },
      });
      const at = wallClockText();
      for (const row of rows) insertAct(db, taskId, sessionId, row, seq, at);
      const describe = (row: ActRow) => `${row.act_id}（${FUNCTION_NAMES[row.function] ?? row.function}：${row.summary}）`;
      const main = rows.find((row) => row.expects_response === 1);
      const text = (extra?.text ?? "") + (rows.length ? `本轮记了 ${rows.map(describe).join("、")}。` : "") +
        (main && resends ? `${main.act_id} 是 ${resends} 的重发，${resends} 不再等回应。` : "") +
        (main ? `用户回应时，你下一轮理解里的 responds_to 写 ${main.act_id}。` : "");
      return {
        acts: rows.map((row) => ({ act_id: row.act_id, function: row.function, summary: row.summary, expects_response: row.expects_response === 1 })),
        text,
        eventSeq: seq,
        extra: extra?.value ?? null,
        answersCard,
        resendsCard,
      };
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) return null;
    throw error;
  }
}

/**
 * 用户的一句话回答了哪几张卡片：执行者对这句话写的理解里，responds_to 指向的那些期待回应的执行者行为所在的回复（会话条目编号），
 * 按卡片发出的先后排，同一条回复只列一次。只看执行者写的理解：界面点击合成的那句话带着卡片的标识，页面自己认得。
 * 「回复」把它写进返回的 details.answers_card，页面据此把用户在卡片之外答掉的卡片标成答过；库里还没有对话行为表时是空的。
 */
export function answeredCards(db: DatabaseSync, taskId: string, sessionId: string, userEntryId: string): string[] {
  if (!hasDialogueTable(db)) return [];
  const rows = db.prepare(
    "SELECT a.source_entry FROM dialogue_act u JOIN dialogue_act a ON a.task_id = u.task_id AND a.session_id = u.session_id AND a.act_id = u.responds_to " +
      "WHERE u.task_id = ? AND u.session_id = ? AND u.speaker = 'user' AND u.origin = 'understanding' AND u.source_entry = ? " +
      "AND a.speaker = 'executor' AND a.expects_response = 1 AND a.source_entry IS NOT NULL ORDER BY a.rowid",
  ).all(taskId, sessionId, userEntryId) as { source_entry: string }[];
  return [...new Set(rows.map((row) => row.source_entry))];
}

// ───────────── 保存修订取本轮理解里的编号 ─────────────

/**
 * 保存修订时，从这一轮用户的对话行为里取与这次操作的条目相同的那一条的编号（targets 里有其中任一条目的第一条）；
 * 没有对得上的，再取这一轮里没有写 targets 的第一条请求（request，例如「把材料整理成用例」，新增条目时就是它）。
 * 都没有返回 null。必须在保存修订的事务里调用。
 */
export function revisionIntent(db: DatabaseSync, taskId: string, sessionId: string, userEntryId: string, itemIds: string[]): string | null {
  if (!hasDialogueTable(db)) return null;
  const rows = db.prepare(
    "SELECT act_id, function, targets FROM dialogue_act WHERE task_id = ? AND session_id = ? AND speaker = 'user' AND source_entry = ? ORDER BY rowid",
  ).all(taskId, sessionId, userEntryId) as { act_id: string; function: string; targets: string }[];
  const hit = rows.find((row) => (load(row.targets) as Target[]).some((t) => itemIds.includes(t.item_id)));
  if (hit) return hit.act_id;
  return rows.find((row) => row.function === "request" && (load(row.targets) as Target[]).length === 0)?.act_id ?? null;
}

// ───────────── 三个派生事实 ─────────────

export interface OpenAct {
  act_id: string;
  run_id: string;
  function: string;
  summary: string;
  targets: string;
  source_entry: string | null;
  /** 记下这一行的那条事件的序号。 */
  event_seq: number;
  /** 这一行自己是把先前哪一张卡片重发了一遍：那一张的编号；不是重发时为 null。 */
  responds_to: string | null;
}

/** 这条会话里还在等回应的执行者行为：期待回应、还没有用户行为回应它，也没有被后来的卡片重发（重发的那一行 responds_to 指着它）。按先后排。 */
export function unansweredActs(db: DatabaseSync, taskId: string, sessionId: string): OpenAct[] {
  if (!hasDialogueTable(db)) return [];
  return db.prepare(
    "SELECT a.act_id, a.run_id, a.function, a.summary, a.targets, a.source_entry, a.event_seq, a.responds_to FROM dialogue_act a " +
      "WHERE a.task_id = ? AND a.session_id = ? AND a.speaker = 'executor' AND a.expects_response = 1 " +
      "AND NOT EXISTS (SELECT 1 FROM dialogue_act u WHERE u.task_id = a.task_id AND u.session_id = a.session_id AND u.responds_to = a.act_id) " +
      "ORDER BY a.rowid",
  ).all(taskId, sessionId) as unknown as OpenAct[];
}

/** 一条执行者行为有没有被后来的卡片重发过；重发过返回重发的那一条的编号。 */
function resentBy(db: DatabaseSync, taskId: string, sessionId: string, actId: string): string | null {
  const row = db.prepare("SELECT act_id FROM dialogue_act WHERE task_id = ? AND session_id = ? AND speaker = 'executor' AND responds_to = ? ORDER BY rowid LIMIT 1")
    .get(taskId, sessionId, actId) as { act_id: string } | undefined;
  return row?.act_id ?? null;
}

/**
 * 「回复」核对 act.resends 时用：actId 是不是这条会话里一张还开着、可以重发的卡片。只读。
 * 不能重发的几种：没有这个编号、不是向用户要回应的行为、已经被用户回应过、已经重发过、是提议进入或退回阶段（或请过目）的卡片。
 */
export function resendFact(db: DatabaseSync, taskId: string, sessionId: string, actId: string): { open: true; kind: string } | { open: false; why: string } {
  const where = "编号写在查询任务状态「这一段还开着的提问与请选择」一行里";
  if (!hasDialogueTable(db)) return { open: false, why: `这条会话里没有这个编号的对话行为；${where}` };
  const row = db.prepare("SELECT speaker, function, expects_response, event_seq FROM dialogue_act WHERE task_id = ? AND session_id = ? AND act_id = ?")
    .get(taskId, sessionId, actId) as { speaker: string; function: string; expects_response: number; event_seq: number } | undefined;
  if (!row) return { open: false, why: `这条会话里没有这个编号的对话行为；${where}` };
  if (row.speaker !== "executor" || row.expects_response !== 1) return { open: false, why: "那不是一张向用户要回应的卡片；不是重发就不写 resends" };
  const answered = answeredBy(db, taskId, sessionId, actId);
  if (answered) return { open: false, why: `它已经被 ${answered} 回应过了，不用重发；这张卡片问的是新的事就不写 resends` };
  const resent = resentBy(db, taskId, sessionId, actId);
  if (resent) return { open: false, why: `它已经重发过了（${resent}）；还要再问就写 resends: "${resent}"` };
  const event = db.prepare("SELECT payload FROM event WHERE seq = ?").get(row.event_seq) as { payload: string } | undefined;
  const proposal = event ? (load(event.payload) as { proposal?: unknown } | null)?.proposal : undefined;
  if (proposalKindOf(proposal) !== null) {
    return { open: false, why: "那是一张提议的卡片（进入、退回某个阶段或请过目），不重发；用户要做这件事时请他点输入框上方「待决定」一行里的按钮" };
  }
  return { open: true, kind: row.function };
}

/** 只读地打开任务库，给「回复」的核对函数一个查 resends 的函数；没有库时每个编号都答没有。用完调用 close。 */
export function openResendLookup(workspaceDir: string, sessionId: string): { resendFact: (actId: string) => ReturnType<typeof resendFact>; close: () => void } {
  const path = databasePath(workspaceDir);
  const none = { open: false as const, why: "这个任务目录还没有任务数据库，没有可以重发的卡片" };
  if (!existsSync(path) || statSync(path).size === 0) return { resendFact: () => none, close: () => {} };
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  const taskId = taskIdOf(db);
  return { resendFact: (actId) => (taskId ? resendFact(db, taskId, sessionId, actId) : none), close: () => db.close() };
}

export interface DialogueFacts {
  /** 还在等回应的执行者行为。 */
  unanswered: { act_id: string; function: string; summary: string; items: string[] }[];
  /** 连续追问：对同一个条目，最近连续几次运行里你都有期待回应的行为、都没有得到回应。只列 1 次及以上的。 */
  follow_ups: { item_id: string; runs: number; act_ids: string[] }[];
  /** 改口：同一条目同一字段在这条会话里因用户的话或用户的直接操作改过几次，只列 2 次及以上的，附历次写入的值。 */
  rephrasings: { item_id: string; field: string; times: number; values: { revision_no: number; value: unknown }[] }[];
}

const runNumber = (runId: string) => Number(runId.replace(/^r/, "")) || 0;

/**
 * 算三个派生事实。只读，不改任何东西；itemId 给了就只算这个条目的。库里还没有对话行为表时三项都是空的。
 * 连续追问：对每个条目，按运行的先后看你针对它的、期待回应的行为，被回应过就从 0 重数，没有被回应就加一（同一次运行只算一次）。
 * 改口：这条会话里的修订，发起方是用户（直接操作）或者带着 intent_act_id（执行者因用户的话而改）的，
 * 数每个条目每个字段的值改过几次（与它上一个修订下的值比，新增不算）。
 */
export function dialogueFacts(db: DatabaseSync, taskId: string, sessionId: string, itemId?: string): DialogueFacts {
  const empty: DialogueFacts = { unanswered: [], follow_ups: [], rephrasings: [] };
  if (!hasDialogueTable(db)) return empty;
  const itemsOf = (targets: string) => (load(targets) as Target[]).map((t) => t.item_id);
  const unanswered = unansweredActs(db, taskId, sessionId)
    .map((one) => ({ act_id: one.act_id, function: one.function, summary: one.summary, items: itemsOf(one.targets) }))
    .filter((one) => !itemId || one.items.includes(itemId));

  const expecting = db.prepare(
    "SELECT a.act_id, a.run_id, a.targets, (SELECT COUNT(*) FROM dialogue_act u WHERE u.task_id = a.task_id AND u.session_id = a.session_id " +
      "AND u.speaker = 'user' AND u.responds_to = a.act_id) AS answers FROM dialogue_act a " +
      "WHERE a.task_id = ? AND a.session_id = ? AND a.speaker = 'executor' AND a.expects_response = 1",
  ).all(taskId, sessionId) as { act_id: string; run_id: string; targets: string; answers: number }[];
  expecting.sort((a, b) => runNumber(a.run_id) - runNumber(b.run_id));
  const streaks = new Map<string, { runs: Set<string>; act_ids: string[] }>();
  for (const act of expecting) {
    for (const item of itemsOf(act.targets)) {
      if (act.answers > 0) {
        streaks.delete(item);
        continue;
      }
      const streak = streaks.get(item) ?? { runs: new Set<string>(), act_ids: [] };
      streak.runs.add(act.run_id);
      streak.act_ids.push(act.act_id);
      streaks.set(item, streak);
    }
  }
  const follow_ups = [...streaks.entries()]
    .filter(([item]) => !itemId || item === itemId)
    .map(([item, streak]) => ({ item_id: item, runs: streak.runs.size, act_ids: streak.act_ids }));

  return { unanswered, follow_ups, rephrasings: rephrasings(db, taskId, sessionId, itemId) };
}

function rephrasings(db: DatabaseSync, taskId: string, sessionId: string, itemId?: string): DialogueFacts["rephrasings"] {
  const intent = hasColumn(db, "revision", "intent_act_id") ? "r.intent_act_id" : "NULL";
  const revisions = db.prepare(
    `SELECT r.revision_no, r.summary, e.actor, ${intent} AS intent_act_id FROM revision r JOIN event e ON e.seq = r.event_seq ` +
      "WHERE r.task_id = ? AND r.session_id = ? ORDER BY r.revision_no",
  ).all(taskId, sessionId) as { revision_no: number; summary: string; actor: string; intent_act_id: string | null }[];
  const fieldsAt = db.prepare("SELECT fields FROM item_version WHERE task_id = ? AND item_id = ? AND revision_no = ?");
  const before = db.prepare("SELECT fields FROM item_version WHERE task_id = ? AND item_id = ? AND revision_no < ? ORDER BY revision_no DESC LIMIT 1");
  const changes = new Map<string, { item_id: string; field: string; values: { revision_no: number; value: unknown }[] }>();
  for (const revision of revisions) {
    if (revision.actor !== ACTOR_USER && !revision.intent_act_id) continue;
    for (const op of load(revision.summary) as { op: string; item: string }[]) {
      if (op.op !== "update" || (itemId && op.item !== itemId)) continue;
      const now = fieldsAt.get(taskId, op.item, revision.revision_no) as { fields: string } | undefined;
      const old = before.get(taskId, op.item, revision.revision_no) as { fields: string } | undefined;
      if (!now || !old) continue;
      const a = load(old.fields) as Record<string, unknown>;
      const b = load(now.fields) as Record<string, unknown>;
      for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[field]) === JSON.stringify(b[field])) continue;
        const key = `${op.item}\u0000${field}`;
        const entry = changes.get(key) ?? { item_id: op.item, field, values: [] };
        entry.values.push({ revision_no: revision.revision_no, value: b[field] ?? null });
        changes.set(key, entry);
      }
    }
  }
  return [...changes.values()].filter((one) => one.values.length >= 2).map((one) => ({ ...one, times: one.values.length }));
}

/** 三个事实写成给执行者看的几行；三项都空时返回空列表。 */
export function dialogueFactLines(facts: DialogueFacts): string[] {
  const lines: string[] = [];
  const name = (fn: string) => FUNCTION_NAMES[fn] ?? fn;
  if (facts.unanswered.length > 0) {
    lines.push(
      `还在等回应的执行者行为 ${facts.unanswered.length} 条（你问过、用户还没有回应的）：` +
        facts.unanswered.map((one) => `${one.act_id} ${name(one.function)}「${one.summary}」${one.items.length ? `（${one.items.join("、")}）` : ""}`).join("；") + "。",
    );
  }
  const repeated = facts.follow_ups.filter((one) => one.runs >= 2);
  if (repeated.length > 0) {
    lines.push(`连续追问：${repeated.map((one) => `${one.item_id} 已经连续 ${one.runs} 次运行问了都没有得到回应（${one.act_ids.join("、")}）`).join("；")}。`);
  }
  if (facts.rephrasings.length > 0) {
    lines.push(
      `改口：${facts.rephrasings.map((one) => `${one.item_id} 的「${one.field}」在这条会话里按用户的意思改过 ${one.times} 次，历次是 ` +
        one.values.map((v) => `修订 ${v.revision_no}：${JSON.stringify(v.value)}`).join("，")).join("；")}。`,
    );
  }
  if (lines.length > 0) lines.push("这几条事实只供参考，怎样用见平台说明「三个事实怎么用」一节。");
  return lines;
}

/** 只读地打开任务库算三个事实（查询工具与现状消息用）。没有库或没有任务时返回 null。 */
export function readDialogueFacts(workspaceDir: string, sessionId: string, itemId?: string): DialogueFacts | null {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const taskId = taskIdOf(db);
    return taskId ? dialogueFacts(db, taskId, sessionId, itemId) : null;
  } finally {
    db.close();
  }
}

/** 用户在卡片的文本框里打了一句话时，那条自定义消息开头的几个字。 */
export const CARD_TYPED_PREFIX = "卡片里的回复（是用户打的字）：";

/**
 * 用户在卡片的文本框里打了一句话时，扩展命令先追加的那条说明的文字。那张卡片还开着（期待回应、还没有被回应）时写明它的行为编号，
 * 助手据此在理解里写 responds_to；找不到开着的那一条（没有库、卡片早先已经答过）时只说是哪条回复的卡片。只读。
 */
export function cardTypedNotice(workspaceDir: string, sessionId: string, replyEntry: string | null): string {
  const plain = `${CARD_TYPED_PREFIX}用户在回复 ${replyEntry ?? ""} 的卡片的文本框里写了下面这句话。`;
  const path = databasePath(workspaceDir);
  if (!replyEntry || !existsSync(path) || statSync(path).size === 0) return plain;
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const taskId = hasDialogueTable(db) ? taskIdOf(db) : null;
    const card = taskId ? unansweredActs(db, taskId, sessionId).find((one) => one.source_entry === replyEntry) : undefined;
    if (!card) return plain;
    return `${CARD_TYPED_PREFIX}用户在 ${card.act_id}（${FUNCTION_NAMES[card.function] ?? card.function}「${card.summary}」）那张卡片的文本框里写了下面这句话。` +
      `这句话是在回应这张卡片，理解里要有一项的 responds_to 写 ${card.act_id}。`;
  } finally {
    db.close();
  }
}

/**
 * 一次点击发生在什么时候：点击之后系统替用户发的那句话记进对话行为表（界面操作合成，origin 为 ui）时的事件序号。
 * 那句话在助手回应它的第一条消息落进会话时记下，早于助手这一轮的任何工具调用。库里找不到那一行时为 null。
 */
export function clickEventSeq(db: DatabaseSync, taskId: string, sessionId: string, userEntryId: string): number | null {
  const row = db.prepare("SELECT event_seq FROM dialogue_act WHERE task_id = ? AND session_id = ? AND speaker = 'user' AND origin = 'ui' AND source_entry = ? " +
    "ORDER BY rowid LIMIT 1").get(taskId, sessionId, userEntryId) as { event_seq: number } | undefined;
  return row ? Number(row.event_seq) : null;
}
