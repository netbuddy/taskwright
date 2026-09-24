/**
 * 「请求评审」的核心逻辑：
 * 执行者保存条目之后调用；每个条目装配一次评审者调用（一次不带工具的模型调用，干净上下文），结论与发现由这里的代码写进库。
 * 执行者自己写不了评审记录。做法照「登记用户确认」（record_confirmation.ts）：
 *   1. prepareReviews：只读核对并装配每个条目的提示——该集合的规矩文档全文、字段声明、条目当前版本的全部字段与来源；
 *   2. 调用方调模型，parseReview 解析与核对输出（结论只有两种、发现指到声明过的字段与存在的项）；
 *   3. writeReview：在立即事务里再核对一次版本，写评审、评审发现、模型调用、事件。
 * 评审没有完成（超时、调用失败、两次输出都不合格、评审期间条目被改）时 writeUnfinished 只记模型调用与一条
 * REVIEW_UNFINISHED 事件，不写合规与否。
 *
 * 规矩文档从哪里来：任务定义里每个集合可以写一项「评审规矩」（相对任务目录的路径）；没写的集合（例如待定事项）
 * 只按字段声明评。不评哪些：不带参数时，只评完成条件里要求「每个条目评审通过」的那些集合里、当前版本还没有合规记录的条目。
 * 连续三次不合规即停：某条目当前版本已有 3 条不合规记录时不再评，交还前三次的发现，由执行者原样转给用户（第 31 节第 3 条）。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ACTOR_EXECUTOR, databasePath, emit, load, wallClockText } from "./db.ts";
import { withTaskDatabase } from "./schema.ts";
import { extractJson, type ModelCallRecord } from "./record_confirmation.ts";

export const REVIEW_PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "review.md");
export const EVENT_REVIEW_RECORDED = "REVIEW_RECORDED";
export const EVENT_REVIEW_UNFINISHED = "REVIEW_UNFINISHED";
/** 完成条件里要求评审的那个条件名，不带参数时按它挑集合。 */
export const REVIEW_CONDITION = "每个条目评审通过";
/** 同一条目当前版本不合规到这么多次就不再评。 */
export const MAX_FAILED_REVIEWS = 3;

export class ReviewError extends Error {}

export interface RequestedItem { item_id: string; version_no: number }
export interface FieldDecl { 名: string; 类型: string; 必填?: boolean; 取值?: string[] }
export interface Finding { field: string; index: number | null; problem: string; suggestion: string | null }

export interface PreparedReview extends RequestedItem {
  collection: string;
  fields: Record<string, unknown>;
  decls: FieldDecl[];
  rulesPath: string | null;
  rulesDigest: string;
  system: string;
  user: string;
}

/** 已经连续三次不合规、这次不再评的条目，附前三次的发现。 */
export interface BlockedItem extends RequestedItem { rounds: { reason: string; findings: Finding[] }[] }

export interface PreparedReviews { taskId: string; items: PreparedReview[]; blocked: BlockedItem[] }

export interface ReviewResult { verdict: "合规" | "不合规"; reason: string; findings: Finding[] }

export interface CallContext { workspaceDir: string; sessionId: string; callId: string }

/** 核对参数：items 可以不写（评全部还没有合规记录的）；写了就是不为空的列表，每项有编号与从 1 起的整数版本号。 */
export function checkReviewParams(params: unknown): RequestedItem[] | null {
  const items = (params as { items?: unknown })?.items;
  if (items === undefined || items === null) return null;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ReviewError("items 要么不写（评全部还没有评审通过的条目），要么写一个不为空的列表，每项是 { item_id, version_no }。什么都没有评。");
  }
  const seen = new Set<string>();
  return items.map((raw, index) => {
    const one = raw as { item_id?: unknown; version_no?: unknown };
    if (typeof one?.item_id !== "string" || !one.item_id.trim()) {
      throw new ReviewError(`items 的第 ${index + 1} 项要写 item_id（条目编号，例如 UC-001）。什么都没有评。`);
    }
    if (!Number.isInteger(one.version_no) || (one.version_no as number) < 1) {
      throw new ReviewError(`items 的第 ${index + 1} 项（${one.item_id}）要写 version_no，一个从 1 起的整数。什么都没有评。`);
    }
    if (seen.has(one.item_id)) throw new ReviewError(`items 里 ${one.item_id} 写了两次。什么都没有评。`);
    seen.add(one.item_id);
    return { item_id: one.item_id, version_no: one.version_no as number };
  });
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function findingsOf(db: DatabaseSync, reviewId: number): Finding[] {
  return (db.prepare("SELECT field, item_index, problem, suggestion FROM review_finding WHERE review_id = ? ORDER BY ordinal").all(reviewId) as
    { field: string; item_index: number | null; problem: string; suggestion: string | null }[])
    .map((r) => ({ field: r.field, index: r.item_index, problem: r.problem, suggestion: r.suggestion }));
}

/**
 * 第 1 步：只读核对并装配提示。拒绝：库或任务不存在、任务不是进行中；点名的条目不存在、已删除、版本不是当前版本；
 * 集合声明的规矩文档读不到；一个要评的也没有。已经连续三次不合规的条目不算错，放进 blocked 交还。
 */
export function prepareReviews(workspaceDir: string, requested: RequestedItem[] | null): PreparedReviews {
  const path = databasePath(workspaceDir);
  if (!existsSync(path)) throw new ReviewError("这个任务目录还没有任务数据库，没有条目可以评审。");
  const system = readFileSync(REVIEW_PROMPT_PATH, "utf-8");
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const task = db.prepare("SELECT task_id, status, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
      { task_id: string; status: string; definition_text: string } | undefined;
    if (!task) throw new ReviewError("库里还没有任务，没有条目可以评审。");
    if (task.status !== "进行中") throw new ReviewError(`这个任务的状态是「${task.status}」，不能再评审。`);
    const definition = (load(task.definition_text) ?? {}) as Record<string, any>;
    const collections = (definition["交付物"]?.["条目集合"] ?? []) as { 名称: string; 字段: FieldDecl[]; 评审规矩?: string }[];
    const completion = (definition["完成条件"] ?? {}) as Record<string, string[]>;
    const current = (itemId: string) => db.prepare(
      "SELECT v.version_no, v.fields, i.collection, i.deleted_in_revision FROM item i JOIN item_version v ON v.task_id = i.task_id AND v.item_id = i.item_id " +
        "WHERE i.task_id = ? AND i.item_id = ? ORDER BY v.version_no DESC LIMIT 1",
    ).get(task.task_id, itemId) as { version_no: number; fields: string; collection: string; deleted_in_revision: number | null } | undefined;

    let wanted: RequestedItem[];
    const problems: string[] = [];
    if (requested) {
      wanted = [];
      for (const want of requested) {
        const row = current(want.item_id);
        if (!row) { problems.push(`库里没有条目 ${want.item_id}`); continue; }
        if (row.deleted_in_revision !== null) { problems.push(`条目 ${want.item_id} 已经删除了`); continue; }
        if (row.version_no !== want.version_no) { problems.push(`条目 ${want.item_id} 现在是第 ${row.version_no} 版，你写的是第 ${want.version_no} 版；只能评当前版本`); continue; }
        wanted.push(want);
      }
      if (problems.length) throw new ReviewError(`什么都没有评，因为：${problems.join("；")}。`);
    } else {
      const reviewed = new Set(Object.entries(completion).filter(([, list]) => list.includes(REVIEW_CONDITION)).map(([name]) => name));
      wanted = (db.prepare(
        "SELECT i.item_id, MAX(v.version_no) AS version_no FROM item i JOIN item_version v ON v.task_id = i.task_id AND v.item_id = i.item_id " +
          "WHERE i.task_id = ? AND i.deleted_in_revision IS NULL AND i.collection IN (SELECT value FROM json_each(?)) GROUP BY i.item_id ORDER BY i.item_id",
      ).all(task.task_id, JSON.stringify([...reviewed])) as unknown as RequestedItem[])
        .filter((w) => !db.prepare("SELECT 1 FROM review WHERE task_id = ? AND item_id = ? AND version_no = ? AND verdict = '合规'").get(task.task_id, w.item_id, w.version_no))
        .map((w) => ({ item_id: w.item_id, version_no: Number(w.version_no) }));
    }

    const items: PreparedReview[] = [];
    const blocked: BlockedItem[] = [];
    for (const want of wanted) {
      const failed = db.prepare("SELECT review_id, reason FROM review WHERE task_id = ? AND item_id = ? AND version_no = ? AND verdict = '不合规' ORDER BY review_id")
        .all(task.task_id, want.item_id, want.version_no) as { review_id: number; reason: string }[];
      if (failed.length >= MAX_FAILED_REVIEWS) {
        blocked.push({ ...want, rounds: failed.map((f) => ({ reason: f.reason, findings: findingsOf(db, f.review_id) })) });
        continue;
      }
      const row = current(want.item_id)!;
      const decl = collections.find((c) => c.名称 === row.collection);
      const decls = decl?.字段 ?? [];
      let rulesText = "";
      const rulesPath = decl?.评审规矩 ?? null;
      if (rulesPath) {
        const full = resolve(workspaceDir, rulesPath);
        if (!existsSync(full)) { problems.push(`集合「${row.collection}」的评审规矩 ${rulesPath} 在任务目录里读不到`); continue; }
        rulesText = readFileSync(full, "utf-8");
      }
      const fields = (load(row.fields) as Record<string, unknown>) ?? {};
      const sources = db.prepare("SELECT position, kind, locator, excerpt, field, field_index FROM item_source WHERE task_id = ? AND item_id = ? AND version_no = ? ORDER BY position, support_no")
        .all(task.task_id, want.item_id, want.version_no) as { position: number; kind: string; locator: string; excerpt: string; field: string | null; field_index: number | null }[];
      items.push({
        ...want, collection: row.collection, fields, decls, rulesPath,
        rulesDigest: digest(rulesText + "\n" + JSON.stringify(decls)),
        system, user: assembleUser(want, row.collection, fields, decls, rulesPath, rulesText, sources),
      });
    }
    if (problems.length) throw new ReviewError(`什么都没有评，因为：${problems.join("；")}。`);
    if (!items.length && !blocked.length) throw new ReviewError("没有需要评审的条目：要评审的集合里，每个条目的当前版本都已经有评审通过的记录了。");
    return { taskId: task.task_id, items, blocked };
  } finally {
    db.close();
  }
}

function valueLines(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.map((v, i) => `    ${i + 1}. ${String(v)}`).join("\n") : "    （空）";
  const text = value == null ? "" : String(value);
  return `    ${text.trim() ? text : "（空）"}`;
}

/** 装配评审者的用户消息：规矩文档全文、字段声明、条目这一版的字段与来源。 */
function assembleUser(want: RequestedItem, collection: string, fields: Record<string, unknown>, decls: FieldDecl[],
  rulesPath: string | null, rulesText: string,
  sources: { position: number; kind: string; locator: string; excerpt: string; field: string | null; field_index: number | null }[]): string {
  const byPosition = new Map<number, { kind: string; locator: string; excerpt: string; supports: string[] }>();
  for (const s of sources) {
    const one = byPosition.get(s.position) ?? { kind: s.kind, locator: s.locator, excerpt: s.excerpt, supports: [] };
    if (s.field) one.supports.push(s.field_index == null ? s.field : `${s.field}第 ${s.field_index + 1} 项`);
    byPosition.set(s.position, one);
  }
  return [
    rulesPath ? `【规矩文档】${rulesPath} 的全文如下：\n${rulesText}` : `【规矩文档】集合「${collection}」没有规矩文档，只按下面的字段声明评。`,
    "",
    `【字段声明】集合「${collection}」的字段：`,
    ...decls.map((d) => `- ${d.名}：${d.类型}${d.必填 ? "，必填" : "，可以不填"}${d.取值 ? `，取值只能是${d.取值.map((v) => `「${v}」`).join("、")}之一` : ""}${d.类型 === "文本列表" || d.类型 === "条目引用" ? "（列表型字段）" : ""}`),
    "",
    `【要评审的条目】${want.item_id} 第 ${want.version_no} 版，各字段：`,
    ...decls.map((d) => `- ${d.名}：\n${valueLines(fields[d.名])}`),
    "",
    "【来源】",
    ...([...byPosition.values()].map((s, i) => `${i + 1}. ${s.kind}${s.kind === "文档原文" ? `（${s.locator}）` : ""}：「${s.excerpt}」` +
      `，支持${s.supports.length ? s.supports.join("、") : "整个条目"}`)),
    ...(byPosition.size ? [] : ["（这一版没有来源）"]),
  ].join("\n");
}

/** 第 2 步：解析并核对评审者的输出。不合格时抛 ReviewError（调用方据此重试一次）。 */
export function parseReview(text: string, item: PreparedReview): ReviewResult {
  let raw: Record<string, unknown>;
  try {
    raw = extractJson(text) as Record<string, unknown>;
  } catch (error) {
    throw new ReviewError(String((error as Error).message).replace("判读者", "评审者"));
  }
  const problems: string[] = [];
  const verdict = raw?.结论;
  if (verdict !== "合规" && verdict !== "不合规") problems.push(`结论写成了「${String(verdict)}」，只能是「合规」或「不合规」`);
  const reason = String(raw?.理由 ?? "").trim();
  if (!reason) problems.push("没有写理由");
  const list = raw?.发现;
  if (!Array.isArray(list)) problems.push("没有「发现」列表");
  const findings: Finding[] = [];
  (Array.isArray(list) ? list : []).forEach((f: any, n) => {
    const field = String(f?.字段 ?? "");
    const decl = item.decls.find((d) => d.名 === field);
    if (!decl) { problems.push(`第 ${n + 1} 条发现的字段「${field}」不在字段声明里`); return; }
    let index: number | null = null;
    if (f?.序号 !== null && f?.序号 !== undefined && f?.序号 !== "") {
      const no = Number(f.序号);
      const value = item.fields[field];
      if (!(decl.类型 === "文本列表" || decl.类型 === "条目引用")) problems.push(`第 ${n + 1} 条发现给「${field}」写了序号，它不是列表型字段`);
      else if (!Number.isInteger(no) || no < 1 || no > (Array.isArray(value) ? value.length : 0)) problems.push(`第 ${n + 1} 条发现的序号 ${String(f.序号)} 超出了「${field}」现有的项数`);
      else index = no - 1;
    }
    const problem = String(f?.问题 ?? "").trim();
    if (!problem) { problems.push(`第 ${n + 1} 条发现没有写问题`); return; }
    const suggestion = String(f?.建议 ?? "").trim();
    findings.push({ field, index, problem, suggestion: suggestion || null });
  });
  if (verdict === "合规" && findings.length) problems.push("结论是合规，却列了发现");
  if (verdict === "不合规" && Array.isArray(list) && list.length === 0) problems.push("结论是不合规，却一条发现也没有");
  if (problems.length) throw new ReviewError(`评审者的输出不合格：${problems.join("；")}`);
  return { verdict: verdict as ReviewResult["verdict"], reason, findings };
}

function insertModelCalls(db: DatabaseSync, taskId: string, toolCallId: string, calls: ModelCallRecord[], reviewId: number | null): void {
  const insert = db.prepare(
    "INSERT INTO model_call (task_id, role, judgement_id, review_id, tool_call_id, prompt, output, outcome, model, duration_ms, " +
      "input_tokens, output_tokens, created_at) VALUES (?, '评审者', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const c of calls) {
    insert.run(taskId, c.outcome === "采用" ? reviewId : null, toolCallId, c.prompt, c.output, c.outcome, c.model, c.durationMs,
      c.inputTokens, c.outputTokens, wallClockText());
  }
}

export interface WrittenReview { review_id: number; event_seq: number; failed_so_far: number }

/**
 * 第 3 步：写一条评审。评审期间条目可能被改，事务里再核对一次版本；不是当前版本就改记「评审未完成」。
 * 事件 REVIEW_RECORDED 带结论与发现，发起方是执行者（是它调的工具）。
 */
export function writeReview(call: CallContext, taskId: string, item: PreparedReview, result: ReviewResult, calls: ModelCallRecord[]): WrittenReview | { changed: number } {
  return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => {
    const now = (db.prepare("SELECT MAX(version_no) AS n FROM item_version WHERE task_id = ? AND item_id = ?").get(taskId, item.item_id) as { n: number }).n;
    if (now !== item.version_no) {
      unfinishedIn(db, call, taskId, item, calls.map((c) => ({ ...c, outcome: c.outcome === "采用" ? "输出不合格" : c.outcome })),
        `评审期间条目被改到了第 ${now} 版`);
      return { changed: now };
    }
    const seq = emit(db, {
      taskId, sessionId: call.sessionId, callId: call.callId, name: EVENT_REVIEW_RECORDED, actor: ACTOR_EXECUTOR,
      payload: { item_id: item.item_id, version_no: item.version_no, verdict: result.verdict, reason: result.reason, findings: result.findings },
    });
    const reviewId = Number(db.prepare(
      "INSERT INTO review (task_id, item_id, version_no, verdict, reason, rules_digest, reviewer_session_id, call_id, event_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(taskId, item.item_id, item.version_no, result.verdict, result.reason, item.rulesDigest, `review-${call.callId}-${item.item_id}`,
      call.callId, seq, wallClockText()).lastInsertRowid);
    const insert = db.prepare("INSERT INTO review_finding (review_id, task_id, ordinal, field, item_index, problem, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?)");
    result.findings.forEach((f, i) => insert.run(reviewId, taskId, i + 1, f.field, f.index, f.problem, f.suggestion));
    insertModelCalls(db, taskId, call.callId, calls, reviewId);
    const failed = (db.prepare("SELECT COUNT(*) AS n FROM review WHERE task_id = ? AND item_id = ? AND version_no = ? AND verdict = '不合规'")
      .get(taskId, item.item_id, item.version_no) as { n: number }).n;
    return { review_id: reviewId, event_seq: seq, failed_so_far: Number(failed) };
  });
}

function unfinishedIn(db: DatabaseSync, call: CallContext, taskId: string, item: PreparedReview, calls: ModelCallRecord[], reason: string): number {
  const seq = emit(db, {
    taskId, sessionId: call.sessionId, callId: call.callId, name: EVENT_REVIEW_UNFINISHED, actor: ACTOR_EXECUTOR,
    payload: { item_id: item.item_id, version_no: item.version_no, reason },
  });
  insertModelCalls(db, taskId, call.callId, calls, null);
  return seq;
}

/** 评审没有完成：只记模型调用与一条 REVIEW_UNFINISHED 事件，不写合规与否。 */
export function writeUnfinished(call: CallContext, taskId: string, item: PreparedReview, calls: ModelCallRecord[], reason: string): number {
  return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => unfinishedIn(db, call, taskId, item, calls, reason));
}

/** 一条发现写成一句话：字段、第几项、问题、建议。 */
export function findingText(f: Finding): string {
  return `${f.field}${f.index != null ? `第 ${f.index + 1} 项` : ""}：${f.problem}${f.suggestion ? `（建议：${f.suggestion}）` : ""}`;
}
