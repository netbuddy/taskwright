/**
 * 「请求评审」的调度：一次最多并行 4 个条目；单个条目限时 60 秒（重试也算在里面），
 * 超时、调用失败、两次输出都不合格、评审期间条目被改都记为「评审未完成」，不写合规与否。
 *
 * 调模型的那一步由调用方传进来（complete），工具与界面操作里用 pi 的 ctx.modelRegistry.complete，单元测试里用假的，
 * 所以本模块不依赖 pi。每评完一条调一次 onItemDone（界面发起的评审据此写进度事件）。
 * 每一批结束时记一条 REVIEW_BATCH 摘要事件（批次编号、发起方、范围、各类计数），评审页签直接用它。
 * 返回给调用方的文字写明每条的结论（「合规」或「不合规（问题 N 处，建议 M 条）」）与逐条发现，发现带规则编号。
 */

import type { ModelCallRecord } from "./model_call.ts";
import {
  type CallContext, type Finding, type PreparedReview, ReviewError, findingText, parseReview,
  prepareReviews, type PreparedReviews, type RequestedItem, writeReview, writeUnfinished,
} from "./review.ts";
import { RULE_REQUIRED } from "./definition.ts";
import { ACTOR_EXECUTOR, ACTOR_USER, emit } from "./db.ts";
import { withTaskDatabase } from "./schema.ts";
import { EVENT_REVIEW_BATCH } from "./review_state.ts";

export const MAX_PARALLEL = 4;
export const ITEM_TIMEOUT_MS = 60_000;
export const ATTEMPTS = 2;

/** 一次模型调用的结果。出错时抛异常（超时由 signal 触发）。 */
/** temperature 是这次调用实际传给模型服务的温度；没传时为 null。它随提示一起记进 model_call。 */
export interface Completion { text: string; inputTokens: number | null; outputTokens: number | null; temperature?: number | null; temperatureNote?: string }
export type Complete = (system: string, user: string, signal: AbortSignal, attempt: number, item: PreparedReview) => Promise<Completion>;

export interface ItemOutcome extends RequestedItem {
  status: "合规" | "不合规" | "评审未完成";
  reason: string;
  findings: Finding[];
  review_id: number | null;
}

export interface RunOutcome { text: string; details: { results: ItemOutcome[]; batch_seq: number | null } }

export interface RunOptions {
  complete: Complete;
  model: string;
  signal?: AbortSignal;
  parallel?: number;
  timeoutMs?: number;
  /** 一个条目开始评审时调用；running 是此刻正在评的全部条目编号。 */
  onItemStart?: (item: PreparedReview, running: string[]) => void;
  /** 一个条目评完（含评审未完成）时调用；done 是到此为止评完的条数，running 是还在评的条目编号。 */
  onItemDone?: (outcome: ItemOutcome, done: number, total: number, running: string[]) => void;
}

async function reviewOne(call: CallContext, taskId: string, item: PreparedReview, opts: RunOptions): Promise<ItemOutcome> {
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? ITEM_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  const prompt = JSON.stringify({ systemPrompt: item.system, messages: [{ role: "user", content: item.user }] });
  const calls: ModelCallRecord[] = [];
  let problem = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const started = Date.now();
    let reply: Completion;
    try {
      reply = await raceAbort(opts.complete(item.system, item.user, signal, attempt, item), signal);
    } catch (error) {
      calls.push({ prompt, output: "", outcome: "调用失败", model: opts.model, durationMs: Date.now() - started, inputTokens: null, outputTokens: null });
      problem = deadline.aborted ? `超过 ${Math.round((opts.timeoutMs ?? ITEM_TIMEOUT_MS) / 1000)} 秒没有评完` : `评审者的模型调用失败了：${(error as Error).message}`;
      if (signal.aborted) break;
      continue;
    }
    const sent = reply.temperature === undefined ? prompt
      : JSON.stringify({ systemPrompt: item.system, messages: [{ role: "user", content: item.user }], temperature: reply.temperature,
        ...(reply.temperatureNote ? { temperature_note: reply.temperatureNote } : {}) });
    const record: ModelCallRecord = { prompt: sent, output: reply.text, outcome: "采用", model: opts.model, durationMs: Date.now() - started,
      inputTokens: reply.inputTokens, outputTokens: reply.outputTokens };
    let result;
    try {
      result = parseReview(reply.text, item);
    } catch (error) {
      if (!(error instanceof ReviewError)) throw error;
      calls.push({ ...record, outcome: "输出不合格" });
      problem = error.message;
      continue;
    }
    calls.push(record);
    const written = writeReview(call, taskId, item, result, calls);
    if ("changed" in written) {
      return { item_id: item.item_id, revision_no: item.revision_no, status: "评审未完成", reason: `评审期间条目被改到了修订 ${written.changed}`,
        findings: [], review_id: null };
    }
    return { item_id: item.item_id, revision_no: item.revision_no, status: result.verdict, reason: result.reason, findings: result.findings,
      review_id: written.review_id };
  }
  writeUnfinished(call, taskId, item, calls, problem);
  return { item_id: item.item_id, revision_no: item.revision_no, status: "评审未完成", reason: problem, findings: [], review_id: null };
}

/** 模型调用不理会中止时，也在中止那一刻放弃等待。 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("已中止"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("已中止"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

/** 分批并行评审已经核对好的条目、写库、拼给调用方的文字。一个都没有评成时也照常返回（每条写明为什么）。 */
export async function runPrepared(call: CallContext, prepared: PreparedReviews, opts: RunOptions): Promise<RunOutcome> {
  const results: ItemOutcome[] = new Array(prepared.items.length);
  const running = new Set<string>();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < prepared.items.length) {
      const index = next++;
      const item = prepared.items[index];
      running.add(item.item_id);
      opts.onItemStart?.(item, [...running]);
      results[index] = await reviewOne(call, prepared.taskId, item, opts);
      running.delete(item.item_id);
      done += 1;
      opts.onItemDone?.(results[index], done, prepared.items.length, [...running]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.parallel ?? MAX_PARALLEL, prepared.items.length) }, worker));
  const batchSeq = recordBatch(call, prepared, results);
  return { text: summaryText(results), details: { results, batch_seq: batchSeq } };
}

/** 一批评审的计数：合规、不合规、未完成各几条，问题几处、建议几条。 */
export function batchCounts(results: ItemOutcome[]) {
  const findings = results.flatMap((r) => r.findings);
  const problems = findings.filter((f) => f.level === RULE_REQUIRED).length;
  return {
    total: results.length,
    passed: results.filter((r) => r.status === "合规").length,
    failed: results.filter((r) => r.status === "不合规").length,
    unfinished: results.filter((r) => r.status === "评审未完成").length,
    problems,
    advice: findings.length - problems,
  };
}

/** 记这一批的摘要事件 REVIEW_BATCH，调用编号就是批次编号。返回事件序号；写不进去时（例如库被删了）为 null。 */
function recordBatch(call: CallContext, prepared: PreparedReviews, results: ItemOutcome[]): number | null {
  const actor = call.actor ?? ACTOR_EXECUTOR;
  try {
    return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => emit(db, {
      taskId: prepared.taskId, sessionId: call.sessionId, callId: call.callId, name: EVENT_REVIEW_BATCH, actor,
      payload: {
        batch_id: call.callId, started_by: actor === ACTOR_USER ? "user" : "executor",
        scope: prepared.scope, items: prepared.items.map((i) => ({ item_id: i.item_id, revision_no: i.revision_no })),
        forced: prepared.items.filter((i) => i.forced).map((i) => i.item_id),
        ...batchCounts(results),
      },
    }));
  } catch {
    return null;
  }
}

/** 整个流程：核对、分批并行评审、写库、拼给调用方的文字。核对不通过时抛 ReviewError，什么都不评。 */
export async function runReviews(call: CallContext, requested: RequestedItem[] | null, opts: RunOptions & { force?: boolean }): Promise<RunOutcome> {
  return runPrepared(call, prepareReviews(call.workspaceDir, requested, { force: opts.force }), opts);
}

/** 一条结果的结论说法：「合规」「合规（建议 M 条）」「不合规（问题 N 处，建议 M 条）」。 */
export function statusText(r: ItemOutcome): string {
  if (r.status === "评审未完成") return "评审未完成";
  const problems = r.findings.filter((f) => f.level === RULE_REQUIRED).length;
  const advice = r.findings.length - problems;
  if (r.status === "合规") return advice ? `合规（建议 ${advice} 条）` : "合规";
  return `不合规（问题 ${problems} 处，建议 ${advice} 条）`;
}

/** 给调用方的文字：一句总数，然后每条一行结论，发现逐条列在下面。 */
export function summaryText(results: ItemOutcome[]): string {
  const lines: string[] = [];
  const counts = (s: ItemOutcome["status"]) => results.filter((r) => r.status === s).length;
  lines.push(`评审了 ${results.length} 个条目：合规 ${counts("合规")} 个，不合规 ${counts("不合规")} 个，评审未完成 ${counts("评审未完成")} 个。`);
  for (const r of results) {
    if (r.status === "评审未完成") {
      lines.push(`${r.item_id}（修订 ${r.revision_no}）：评审未完成（${r.reason}），没有记下合规与否，可以稍后再评审。`);
      continue;
    }
    lines.push(`${r.item_id}（修订 ${r.revision_no}）：${statusText(r)}。`);
    r.findings.forEach((f, i) => lines.push(`  ${i + 1}. ${findingText(f)}`));
  }
  return lines.join("\n");
}
