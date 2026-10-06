/**
 * 调嵌入模型：把若干段文字各换算成一串数字（数字串的长度由模型定）。知识库按意思查找、文档换算都建在这一个函数上。
 *
 * 用途分两种。查询（query）：送去的文字是设置里的查询前缀直接接上原文，中间不添任何字符。指令感知的嵌入模型要在查询前面加一句
 * 任务说明，这句话以什么结尾（换行、冒号）由用户在前缀里自己写全。文档（document）：原样送去，不加前缀。
 *
 * 按选定的嵌入模型所在模型服务的种类发请求（连接从 model_config.ts 的 embeddingTarget 取）：ollama 用它自己的接口，
 * 请求体 {model, input}，回答里的 embeddings 是各段的数字串；别的种类都是兼容 OpenAI 接口的 …/embeddings，请求体相同，
 * 回答里的 data 每项有 index 与 embedding。Codex 订阅没有嵌入模型，不发请求。
 *
 * 文字超过模型一次能收的长度时：ollama 缺省会悄悄只算前面一部分，所以请求体里另带 truncate: false，让它报错；
 * 兼容 OpenAI 接口的几种没有这个字段，超长时它们自己会报错。
 *
 * 一次调用只发一个请求，不分批、不并发；段数超过这一种模型服务一次能收的上限（BATCH_LIMIT）时直接报错。只用 fetch，不引入依赖。
 * 没有做成一律抛 EmbeddingError，message 是给人看的一句。
 */

import { type Context, embeddingTarget } from "./model_config.ts";
import type { Kind } from "./product_settings.ts";

export type Purpose = "query" | "document";

/** 一次请求最多等这么久；本地的模型服务第一次载入模型可能要几十秒。 */
export const EMBED_TIMEOUT_MS = 60_000;
/** 一次请求最多送几段：阿里云百炼的嵌入模型一次只收 10 段，别的种类取 32。 */
export const BATCH_LIMIT: Record<Exclude<Kind, "codex">, number> = {
  ollama: 32, llamacpp: 32, vllm: 32, deepseek: 32, aliyun: 10, openai_compatible: 32,
};
/** 模型服务给的报错原文最多带回这么多个字。 */
const DETAIL_LIMIT = 200;

export const NOT_SELECTED_TEXT = "还没有选嵌入模型。";
export const NOT_OFFERED_TEXT = "这个模型服务没有嵌入模型。";
export const UNREACHABLE_TEXT = "连不上这个模型服务。请确认它已经启动，地址与端口没有写错。";
export const KEY_REJECTED_TEXT = "模型服务拒绝了这个密钥。";

/**
 * 没有做成的几种：not_selected 没有选嵌入模型；provider_gone 选定的模型所在的模型服务不在了；not_offered 这种模型服务没有嵌入模型；
 * too_many 段数超过上限；unreachable 连不上；timeout 到时间没有回答；key_rejected 密钥被拒绝；service_error 模型服务回答了错误；
 * bad_answer 回答里的数字串不对（没有、个数不符、是空的、有不是数的项、长短不一）。
 */
export type EmbeddingFailure =
  | "not_selected" | "provider_gone" | "not_offered" | "too_many" | "unreachable" | "timeout" | "key_rejected" | "service_error" | "bad_answer";

export class EmbeddingError extends Error {
  readonly kind: EmbeddingFailure;

  constructor(kind: EmbeddingFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface Embedded {
  /** 用的嵌入模型，「服务名/型号」。 */
  model: string;
  /** 实际送去的各段文字；查询用途时已经加了前缀。 */
  inputs: string[];
  /** 各段的数字串，与 inputs 一一对应。 */
  vectors: number[][];
  /** 每条数字串的长度；同一次的各条相同。 */
  dimensions: number;
}

export interface EmbedOptions {
  /** 最多等多久；不给时是 EMBED_TIMEOUT_MS。 */
  timeoutMs?: number;
}

function clip(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit).join("") + "…" : text;
}

/** 模型服务报错时给的原文：ollama 的 error 是一句话，兼容 OpenAI 接口的是 error.message；都没有时用回答的原文。 */
function detailOf(body: any, text: string): string {
  const error = body?.error;
  const detail = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : typeof body?.message === "string" ? body.message : text;
  return clip(detail.trim(), DETAIL_LIMIT);
}

/** 从回答里取出各段的数字串；回答里没有时是 null。兼容 OpenAI 接口的回答每项都带 index 时按它排。 */
function vectorsIn(kind: Kind, body: any): unknown[] | null {
  if (kind === "ollama") return Array.isArray(body?.embeddings) ? body.embeddings : null;
  if (!Array.isArray(body?.data)) return null;
  const data: any[] = body.data;
  const indexed = data.every((entry) => Number.isInteger(entry?.index));
  return (indexed ? [...data].sort((a, b) => a.index - b.index) : data).map((entry) => entry?.embedding);
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === "number" && Number.isFinite(x));
}

/**
 * 用选定的嵌入模型把 texts 各换算成一串数字。purpose 是 query 时每段前面加上设置里的查询前缀，是 document 时原样送去。
 * texts 至少要有一段。
 */
export async function embed(ctx: Context, texts: string[], purpose: Purpose, options: EmbedOptions = {}): Promise<Embedded> {
  if (texts.length === 0) throw new TypeError("embed 至少要有一段文字。");
  const target = embeddingTarget(ctx);
  if (!target) throw new EmbeddingError("not_selected", NOT_SELECTED_TEXT);
  if (target.kind === null) throw new EmbeddingError("provider_gone", `选定的嵌入模型「${target.model}」所在的模型服务不在了，请重新选择嵌入模型。`);
  if (target.kind === "codex" || target.url === null) throw new EmbeddingError("not_offered", NOT_OFFERED_TEXT);
  const kind = target.kind;
  const limit = BATCH_LIMIT[kind];
  if (texts.length > limit) throw new EmbeddingError("too_many", `一次最多换算 ${limit} 段文字，这一次送来了 ${texts.length} 段。`);
  const inputs = purpose === "query" ? texts.map((text) => target.query_prefix + text) : [...texts];
  const timeoutMs = options.timeoutMs ?? EMBED_TIMEOUT_MS;

  const request = { model: target.model, input: inputs };
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (target.key) headers.Authorization = `Bearer ${target.key}`;
  let status: number;
  let text: string;
  try {
    const res = await fetch(target.url, {
      method: "POST", headers, body: JSON.stringify(kind === "ollama" ? { ...request, truncate: false } : request), signal: AbortSignal.timeout(timeoutMs), redirect: "follow",
    });
    status = res.status;
    text = await res.text();
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") throw new EmbeddingError("timeout", `${Math.round(timeoutMs / 1000)} 秒内没有算完。`);
    throw new EmbeddingError("unreachable", UNREACHABLE_TEXT);
  }
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (status === 401 || status === 403) throw new EmbeddingError("key_rejected", KEY_REJECTED_TEXT);
  if (status === 404) throw new EmbeddingError("service_error", `模型服务里找不到模型「${target.model}」，或者这个模型服务没有嵌入模型的接口。`);
  if (status !== 200) {
    const detail = detailOf(body, text);
    throw new EmbeddingError("service_error", `模型服务回答了错误（HTTP ${status}）${detail ? `：${detail}` : "。"}`);
  }

  const vectors = vectorsIn(kind, body);
  if (vectors === null) throw new EmbeddingError("bad_answer", "模型服务的回答里没有数字串。");
  if (vectors.length !== inputs.length) throw new EmbeddingError("bad_answer", `送去 ${inputs.length} 段文字，拿回 ${vectors.length} 条数字串。`);
  if (!vectors.every(isVector)) throw new EmbeddingError("bad_answer", "模型服务回答的数字串不对：是空的，或者里面有不是数的项。");
  const dimensions = vectors[0].length;
  if (vectors.some((v) => v.length !== dimensions)) throw new EmbeddingError("bad_answer", "模型服务回答的各条数字串长短不一。");
  return { model: `${target.provider_id}/${target.model}`, inputs, vectors, dimensions };
}
