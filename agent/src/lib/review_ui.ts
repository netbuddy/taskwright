/**
 * 用户在界面上发起的评审（/tw-user 的 request_review）：核对通过就立即返回，评审在后台跑。
 *
 * 界面操作有 10 秒的上限，一批评审要几十秒到几分钟，所以不等它跑完：startReview 同步核对（prepareReviews）、
 * 记一条 REVIEW_PROGRESS（done 为 0）后返回，评审在同一个进程里接着跑。每评完一条，除了评审本身写的
 * REVIEW_RECORDED（或 REVIEW_UNFINISHED），再记一条 REVIEW_PROGRESS；全部评完记一条 REVIEW_FINISHED。
 * 这三种事件的发起方是用户，调用编号是这次界面操作的操作编号（ui- 开头）。
 *
 * 同一个任务目录同一时刻只跑一批评审：界面发起的与执行者经工具发起的共用 reviewSlot，上一批没跑完时再发起就拒绝。
 *
 * 本模块只引用 pi 的类型（piComplete 的参数），不在运行时依赖 pi，单元测试可以直接调用。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACTOR_USER, emit } from "./db.ts";
import { withTaskDatabase } from "./schema.ts";
import { notInputProblem } from "./tool_rejection.ts";
import { type CallContext, ReviewError, prepareReviews, type RequestedItem } from "./review.ts";
import { type Complete, type ItemOutcome, MAX_PARALLEL, type RunOptions, type RunOutcome, runPrepared } from "./review_run.ts";

export const EVENT_REVIEW_PROGRESS = "REVIEW_PROGRESS";
export const EVENT_REVIEW_FINISHED = "REVIEW_FINISHED";

/** 任务目录 → 正在跑的那批评审的调用编号。 */
const running = new Map<string, string>();

/** 占用任务目录的评审名额；上一批还没跑完时抛 ReviewError。返回释放名额的函数。 */
export function reviewSlot(workspaceDir: string, callId: string): () => void {
  // 名额被占着不是输入的问题，被拒时不记进 tool_rejection 表。
  if (running.has(workspaceDir)) throw notInputProblem(new ReviewError("上一批评审还没有做完，做完之后再发起评审。"));
  running.set(workspaceDir, callId);
  return () => { if (running.get(workspaceDir) === callId) running.delete(workspaceDir); };
}

export interface StartedReview {
  /** 这批要评的条目与各自所在的修订。 */
  items: RequestedItem[];
  /** 开始时记的那条 REVIEW_PROGRESS 的序号。 */
  event_seq: number;
  /** 全部评完（含出错）时兑现：评审结果，以及 REVIEW_FINISHED 的序号；中途出了意外时 outcome 为 null、error 写原因。 */
  finished: Promise<{ outcome: RunOutcome | null; event_seq: number; error: string | null }>;
}

function record(call: CallContext, name: string, payload: Record<string, unknown>): number {
  return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => {
    const task = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string };
    return emit(db, { taskId: task.task_id, sessionId: call.sessionId, callId: call.callId, name, payload, actor: ACTOR_USER });
  });
}

/** 这批评审的结果按状态计数，写进 REVIEW_FINISHED。 */
function finishedPayload(opId: string, total: number, results: ItemOutcome[], error: string | null): Record<string, unknown> {
  const n = (status: ItemOutcome["status"]) => results.filter((r) => r && r.status === status).length;
  return {
    op_id: opId, total, passed: n("合规"), failed: n("不合规"), unfinished: total - n("合规") - n("不合规"),
    results: results.filter(Boolean).map((r) => ({ item_id: r.item_id, revision_no: r.revision_no, status: r.status })),
    error,
  };
}

/**
 * 核对并开始一批评审。requested 为 null 时评全部待评审的条目。核对不通过、上一批还没做完时抛 ReviewError，什么都不记。
 * call.callId 是操作编号；事件的发起方一律是用户。
 */
export function startReview(call: CallContext, requested: RequestedItem[] | null,
  opts: Omit<RunOptions, "onItemStart" | "onItemDone"> & { onRecorded?: (seq: number) => void; force?: boolean }): StartedReview {
  const release = reviewSlot(call.workspaceDir, call.callId);
  let prepared;
  try {
    prepared = prepareReviews(call.workspaceDir, requested, { force: opts.force });
  } catch (error) {
    release();
    throw error;
  }
  const userCall: CallContext = { ...call, actor: ACTOR_USER };
  const recorded = (seq: number) => { opts.onRecorded?.(seq); return seq; };
  const total = prepared.items.length;
  const items = prepared.items.map((i) => ({ item_id: i.item_id, revision_no: i.revision_no }));
  let seq: number;
  try {
    seq = record(userCall, EVENT_REVIEW_PROGRESS, {
      op_id: call.callId, done: 0, total, current: items.slice(0, opts.parallel ?? MAX_PARALLEL).map((i) => i.item_id), item_id: null,
    });
  } catch (error) {
    release();
    throw error;
  }
  const results: ItemOutcome[] = [];
  const finished = (async () => {
    // 让出一拍再开始：调用方先把「已受理」回传出去，第一次模型调用不挡着它。
    await Promise.resolve();
    let outcome: RunOutcome | null = null;
    let error: string | null = null;
    try {
      outcome = await runPrepared(userCall, prepared, {
        ...opts,
        onItemDone: (one, done, all, still) => {
          results.push(one);
          recorded(record(userCall, EVENT_REVIEW_PROGRESS, { op_id: call.callId, done, total: all, current: still, item_id: one.item_id }));
        },
      });
    } catch (e) {
      error = `评审中途出了意外：${(e as Error).message}`;
    }
    let finishedSeq = -1;
    try {
      finishedSeq = recorded(record(userCall, EVENT_REVIEW_FINISHED, finishedPayload(call.callId, total, outcome?.details.results ?? results, error)));
    } finally {
      release();
    }
    return { outcome, event_seq: finishedSeq, error };
  })();
  return { items, event_seq: seq, finished };
}

/** 所用模型不接受温度参数时记在这里（值是模型服务当时的报错），之后对它不再传温度。 */
const noTemperature = new Map<string, string>();

/**
 * 用 pi 的模型注册表调一次评审者：不带工具、干净上下文，模型是启动配置里的那一个。界面操作与工具共用。
 * 为了同一条目同样内容评两次结果尽量一致，温度设为 0；模型服务因为温度参数报错时，去掉温度再调一次，并记住这个模型不支持。
 */
export function piComplete(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, callId: string): { model: string; complete: Complete } {
  const model = ctx.model;
  if (!model) throw notInputProblem(new ReviewError("现在没有可用的模型，评审者无法评审，什么都没有评。"));
  return {
    model: `${model.provider}/${model.id}`,
    complete: async (system, user, itemSignal, attempt, item) => {
      const key = `${model.provider}/${model.id}`;
      const call = (withTemperature: boolean) => ctx.modelRegistry.complete(model, {
        systemPrompt: system,
        messages: [{ role: "user" as const, timestamp: Date.now(), content: [{ type: "text" as const, text: user }] }],
      }, { sessionId: `review-${callId}-${item.item_id}-${attempt}`, signal: itemSignal, ...(withTemperature ? { temperature: 0 } : {}) });
      let withTemperature = !noTemperature.has(key);
      let response = await call(withTemperature);
      let r = response as { stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number } };
      if (r.stopReason === "error" && withTemperature && /temperature/i.test(r.errorMessage ?? "")) {
        noTemperature.set(key, (r.errorMessage ?? "").slice(0, 300));
        withTemperature = false;
        response = await call(false);
        r = response as typeof r;
      }
      if (r.stopReason === "error" || r.stopReason === "aborted") throw new Error(r.errorMessage ?? "模型服务报错");
      return {
        text: response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""),
        inputTokens: r.usage?.input ?? null,
        outputTokens: r.usage?.output ?? null,
        temperature: withTemperature ? 0 : null,
        ...(withTemperature ? {} : { temperatureNote: `模型服务不接受温度参数，没有传：${noTemperature.get(key) ?? ""}` }),
      };
    },
  };
}
