/**
 * 「请求评审」的调度：一次最多并行 4 个条目；单个条目限时 60 秒（重试也算在里面），
 * 超时、调用失败、两次输出都不合格都记为「评审未完成」，不写合规与否。连续三次不合规的条目不评，原样交还前三次的发现。
 *
 * 调模型的那一步由调用方传进来（complete），工具里用 pi 的 ctx.modelRegistry.complete，单元测试里用假的，
 * 所以本模块不依赖 pi。返回给执行者的文字写明每条的结论与发现原文。
 */

import type { ModelCallRecord } from "./record_confirmation.ts";
import {
  type BlockedItem, type CallContext, type Finding, MAX_FAILED_REVIEWS, type PreparedReview, ReviewError, findingText, parseReview,
  prepareReviews, type RequestedItem, writeReview, writeUnfinished,
} from "./review.ts";

export const MAX_PARALLEL = 4;
export const ITEM_TIMEOUT_MS = 60_000;
export const ATTEMPTS = 2;

/** 一次模型调用的结果。出错时抛异常（超时由 signal 触发）。 */
export interface Completion { text: string; inputTokens: number | null; outputTokens: number | null }
export type Complete = (system: string, user: string, signal: AbortSignal, attempt: number, item: PreparedReview) => Promise<Completion>;

export interface ItemOutcome extends RequestedItem {
  status: "合规" | "不合规" | "评审未完成";
  reason: string;
  findings: Finding[];
  review_id: number | null;
  /** 这一版到这次为止的不合规次数（评审未完成时为空）。 */
  failed_so_far: number | null;
}

export interface RunOutcome { text: string; details: { results: ItemOutcome[]; blocked: BlockedItem[] } }

export interface RunOptions {
  complete: Complete;
  model: string;
  signal?: AbortSignal;
  parallel?: number;
  timeoutMs?: number;
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
    const record: ModelCallRecord = { prompt, output: reply.text, outcome: "采用", model: opts.model, durationMs: Date.now() - started,
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
      return { item_id: item.item_id, version_no: item.version_no, status: "评审未完成", reason: `评审期间条目被改到了第 ${written.changed} 版`,
        findings: [], review_id: null, failed_so_far: null };
    }
    return { item_id: item.item_id, version_no: item.version_no, status: result.verdict, reason: result.reason, findings: result.findings,
      review_id: written.review_id, failed_so_far: written.failed_so_far };
  }
  writeUnfinished(call, taskId, item, calls, problem);
  return { item_id: item.item_id, version_no: item.version_no, status: "评审未完成", reason: problem, findings: [], review_id: null, failed_so_far: null };
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

/** 整个流程：核对、分批并行评审、写库、拼给执行者的文字。一个都没有评成时也照常返回（每条写明为什么）。 */
export async function runReviews(call: CallContext, requested: RequestedItem[] | null, opts: RunOptions): Promise<RunOutcome> {
  const prepared = prepareReviews(call.workspaceDir, requested);
  const results: ItemOutcome[] = new Array(prepared.items.length);
  let next = 0;
  const worker = async () => {
    while (next < prepared.items.length) {
      const index = next++;
      results[index] = await reviewOne(call, prepared.taskId, prepared.items[index], opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.parallel ?? MAX_PARALLEL, prepared.items.length) }, worker));
  return { text: summaryText(results, prepared.blocked), details: { results, blocked: prepared.blocked } };
}

function summaryText(results: ItemOutcome[], blocked: BlockedItem[]): string {
  const lines: string[] = [];
  const counts = (s: ItemOutcome["status"]) => results.filter((r) => r.status === s).length;
  lines.push(`评审了 ${results.length} 个条目：合规 ${counts("合规")} 个，不合规 ${counts("不合规")} 个，评审未完成 ${counts("评审未完成")} 个。`);
  for (const r of results) {
    if (r.status === "合规") lines.push(`${r.item_id} 第 ${r.version_no} 版：合规。${r.reason}`);
    else if (r.status === "评审未完成") lines.push(`${r.item_id} 第 ${r.version_no} 版：评审未完成（${r.reason}），没有记下合规与否，可以稍后再请求评审。`);
    else {
      lines.push(`${r.item_id} 第 ${r.version_no} 版：不合规，${r.findings.length} 处（这一版第 ${r.failed_so_far} 次不合规）。${r.reason}`);
      r.findings.forEach((f, i) => lines.push(`  ${i + 1}. ${findingText(f)}`));
      if ((r.failed_so_far ?? 0) >= MAX_FAILED_REVIEWS) {
        lines.push(`  这条已连续三次不合规，不再评审。请把三次的发现原样转给用户，用「请选择」问他：按发现修改、保留现在的写法，还是先不管。`);
      } else lines.push("  请按这些发现修改之后再请求评审。");
    }
  }
  for (const b of blocked) {
    lines.push(`${b.item_id} 第 ${b.version_no} 版：这条已连续三次不合规，请把三次发现转给用户决定，这次没有再评。前三次的发现：`);
    b.rounds.forEach((round, i) => {
      lines.push(`  第 ${i + 1} 次：${round.reason}`);
      round.findings.forEach((f, j) => lines.push(`    ${j + 1}. ${findingText(f)}`));
    });
  }
  return lines.join("\n");
}
