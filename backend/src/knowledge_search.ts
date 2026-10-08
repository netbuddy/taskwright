/**
 * 知识库查找：在若干个知识库的全部片段里找与一句话最相关的几个，连同它在哪个知识库、哪份文档、哪个位置。两路并行：
 * - 按意思：把这句话用选定的嵌入模型按查询的用途换算成数字串（会加查询前缀），与各片段的数字串比远近。片段与数字串是后台换算时
 *   存在文档旁边的（knowledge_embeddings.ts）。相近程度是两条数字串的点积：存着的数字串长度都是 1，查询的那一条这里也缩放成
 *   长度 1，所以它在 -1 到 1 之间，越大越相近。
 * - 按字面：把这句话切成词，按词在各片段里出现的情况打分（knowledge_keywords.ts）。专管按意思查不准的条号、编号与原话。
 *
 * 取哪几个（limit 个）：按意思一路的前 limit 名是候选；按字面一路得分大于 0 的前 KEYWORD_KEEP 名里不在候选中的，依次替换候选里
 * 按意思排名最末的；按意思第 1 名永不被替换，所以 limit 为 1 时不替换。留下来的按意思排名在前的在前，被替换进来的按字面名次
 * 排在最后。不设门槛：高低交给看结果的一方判断。
 *
 * 按意思那一路做不了时不拒绝，退到只按字面（mode 与 reason 说明是哪一种）：
 * - 没有选嵌入模型：只按字面，mode 是 keyword，reason 是 not_selected。
 * - 有的文档还没有用现在选定的嵌入模型换算好：对它只按字面（片段现切，不写文件），别的文档两路都做；mode 是 hybrid_partial，
 *   uncovered_semantic 列出这些文档。文档旁边的成品读不出来、数字串长度与查询的对不上时也这样办。
 * - 换算这句话时模型服务出了事（到时间没有回答、连不上、密钥被拒绝、回答不对）：只按字面，mode 是 keyword，reason 是那一种。
 * - 某份文档的文字读不出来：跳过它，别的照常；uncovered 列出它。
 * - 调用的一方中途取消（signal）：不退化，以 cancelled 结束。
 *
 * 查到的每个片段另给它的原文（knowledge_passage.ts）：按片段记下的位置从源文字现读，Markdown 与纯文本逐字节相同、连空行，
 * Word 文档逐段给并带段落号。助手照它抄摘录，保存时系统到同一份源文字里核对。读不到源文字的片段不给（那份文档记进 uncovered）。
 *
 * 每次查找都逐份读文档旁边的文件、当场比完，不在内存里留着数字串；按字面一路的词的统计也是现算的。各阶段的耗时记在 timing 里。
 */

import { join } from "node:path";
import { knowledgeLocator } from "../../agent/src/lib/knowledge_locator.ts";
import { type SegmentParams } from "../../agent/src/lib/segments.ts";
import { EmbeddingError, type EmbeddingFailure, embed } from "./embedding.ts";
import { ApiError } from "./errors.ts";
import type { DocumentRow, Kind, KnowledgeStore } from "./knowledge.ts";
import { type Chunk, chunkDocument } from "./knowledge_chunks.ts";
import type { KnowledgeEmbedder } from "./knowledge_embedder.ts";
import { isEmbedded, normalize, readEmbeddings } from "./knowledge_embeddings.ts";
import { keywordIndex, keywordRanking } from "./knowledge_keywords.ts";
import { type Passage, passageOf } from "./knowledge_passage.ts";
import type { Context } from "./model_config.ts";

/** 不说要几个时给几个，以及最多给几个。 */
export const SEARCH_DEFAULT_LIMIT = 3;
export const SEARCH_MAX_LIMIT = 5;
/** 按字面一路的前几名保证进结果（替换候选里按意思排名最末的）。 */
export const KEYWORD_KEEP = 2;

export const QUERY_REQUIRED_TEXT = "query 应当是要找的一句话，不能是空的。";
export const LIMIT_RANGE_TEXT = `limit 应当是 1 到 ${SEARCH_MAX_LIMIT} 的整数。`;
export const LIBRARIES_SHAPE_TEXT = "libraries 应当是知识库编号的列表。";
export const CANCELLED_TEXT = "查找被取消了。";

/** 两路都做了；有的文档只按字面找了；只按字面找了。 */
export type SearchMode = "hybrid" | "hybrid_partial" | "keyword";
/** 只按字面找的原因：没有选嵌入模型，或者换算要找的那句话时出的那一种事。 */
export type SearchReason = "not_selected" | "provider_gone" | "not_offered" | "timeout" | "unreachable" | "key_rejected" | "service_error" | "bad_answer";

/** 查到的一个片段：它的位置与名次，加它的原文（Passage 的 body、paragraphs、table、header、exact）。 */
export interface SearchHit extends Passage {
  /** 按意思的相近程度（-1 到 1，四位小数）；这个片段没有按意思比过时是按字面的得分。score_kind 说明是哪一种。 */
  score: number;
  score_kind: "semantic" | "keyword";
  /** 它在按意思、按字面两路里各排第几（从 1 起）；没有进那一路是 null。 */
  rank_semantic: number | null;
  rank_keyword: number | null;
  /** 知识库的编号与名字。 */
  library: string;
  library_name: string;
  /** 文档名与种类。 */
  name: string;
  kind: Kind;
  /** 片段的标题（Word 文档是所在块的标题，Markdown 是各级标题连起来）；没有是 null。 */
  title: string | null;
  /** 所属结构单位的编号（knowledge_chunks.ts）。 */
  block: number;
  /** Word 文档的起止段落号；别的文档是 null。 */
  first_paragraph: number | null;
  last_paragraph: number | null;
  /** Markdown 与纯文本的起止行号；Word 文档是 null。 */
  first_line: number | null;
  last_line: number | null;
  /** 这是很长的一段切出来的一截。 */
  partial: boolean;
  /** 片段里存的文字，页面显示用（各段用一个换行接起来；Word 表格的行是改写成带竖线的一行的文字）。照抄摘录要用原文，不用它。 */
  text: string;
  /** 引用这份文档作来源时出处的写法；Word 文档还要加摘录所在那一段的段落号。 */
  locator: string;
}

/** 一份文档。 */
export interface DocumentRef {
  library: string;
  library_name: string;
  name: string;
}

/** 各阶段的耗时，毫秒。 */
export interface SearchTiming {
  embed_query: number;
  read_derived: number;
  read_source: number;
  chunk_now: number;
  vector_compare: number;
  tokenize: number;
  keyword_score: number;
}

export interface SearchResult {
  ok: true;
  mode: SearchMode;
  /** mode 是 keyword 时的原因；别的时候是 null。 */
  reason: SearchReason | null;
  /** 用的嵌入模型，「服务名/型号」；没有选是 null。 */
  model: string | null;
  /** 这几个知识库里的文档是不是都用现在选定的嵌入模型换算好了，与还差几份。 */
  ready: boolean;
  pending: number;
  /** 查了几个知识库、几份文档、几个片段。 */
  libraries: number;
  documents: number;
  chunks: number;
  /** 这一次只按字面找了的文档（mode 是 keyword 时不列：全部都是）。 */
  uncovered_semantic: DocumentRef[];
  /** 这一次没有查到的文档与原因。 */
  uncovered: (DocumentRef & { reason: "source_unreadable" })[];
  hits: SearchHit[];
  timing: SearchTiming;
}

export interface SearchRequest {
  query: string;
  /** 只查这几个知识库；不给是全部知识库。清单里没有的编号不算。 */
  libraries?: string[];
  limit: number;
}

/** 把请求体整理成查找的请求；写得不对的以 bad_request 拒绝。 */
export function searchRequest(body: Record<string, any>): SearchRequest {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) throw new ApiError("bad_request", QUERY_REQUIRED_TEXT);
  const limit = body.limit === undefined || body.limit === null ? SEARCH_DEFAULT_LIMIT : body.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) throw new ApiError("bad_request", LIMIT_RANGE_TEXT);
  const libraries = body.libraries;
  if (libraries !== undefined && libraries !== null && !(Array.isArray(libraries) && libraries.every((one) => typeof one === "string"))) {
    throw new ApiError("bad_request", LIBRARIES_SHAPE_TEXT);
  }
  return { query, limit, ...(Array.isArray(libraries) ? { libraries } : {}) };
}

/**
 * 取哪几个。semantic 与 keyword 是两路各自排好的片段下标（靠前的在前）。按意思的前 limit 名为候选；按字面的前 keep 名里
 * 不在候选中的，依次替换候选里按意思排名最末的；按意思第 1 名永不被替换（limit 为 1 时不替换）。候选不满 limit 个时直接补上。
 * 返回的先后：留下来的按意思排名在前的在前，被替换进来的按字面名次排在最后。semantic 是空的时只按字面取前 limit 名。
 */
export function combine(semantic: number[], keyword: number[], limit: number, keep: number = KEYWORD_KEEP): number[] {
  if (!semantic.length) return keyword.slice(0, limit);
  const kept = semantic.slice(0, limit);
  if (limit === 1) return kept;
  const guaranteed = keyword.slice(0, keep);
  const added: number[] = [];
  for (const i of guaranteed.filter((k) => !kept.includes(k))) {
    if (kept.length + added.length < limit) {
      added.push(i);
      continue;
    }
    // 从按意思排名最末的往前找一个不是按字面保底的候选换掉；第 1 名不动。
    let at = kept.length - 1;
    while (at >= 1 && guaranteed.includes(kept[at])) at--;
    if (at < 1) break;
    kept.splice(at, 1);
    added.push(i);
  }
  return [...kept, ...added];
}

/** 嵌入模型出的事归到哪一种原因。 */
const REASONS: Partial<Record<EmbeddingFailure, SearchReason>> = {
  not_selected: "not_selected", provider_gone: "provider_gone", not_offered: "not_offered", timeout: "timeout", unreachable: "unreachable",
  key_rejected: "key_rejected", service_error: "service_error", bad_answer: "bad_answer", too_many: "service_error",
};

export interface SearchOptions {
  /** 调用的一方中途取消时中止（对方断开了连接）。 */
  signal?: AbortSignal;
  /** 现切片段用的分段参数（Word 文档按分段清单分块）。 */
  params: SegmentParams;
}

/** 参加比较的一个片段。 */
interface Entry {
  library: { id: string; name: string };
  row: DocumentRow;
  chunk: Chunk;
  /** 按意思的相近程度；这个片段没有按意思比过是 null。 */
  semantic: number | null;
}

/**
 * 查找。从不因为按意思那一路做不了而拒绝（见文件开头）；调用的一方取消时以 cancelled 结束。
 */
export async function searchKnowledge(
  store: KnowledgeStore, embedder: KnowledgeEmbedder, ctx: Context, request: SearchRequest, options: SearchOptions,
): Promise<SearchResult> {
  const timing: SearchTiming = { embed_query: 0, read_derived: 0, read_source: 0, chunk_now: 0, vector_compare: 0, tokenize: 0, keyword_score: 0 };
  const timed = <T>(key: keyof SearchTiming, work: () => T): T => {
    const from = performance.now();
    try {
      return work();
    } finally {
      timing[key] += performance.now() - from;
    }
  };
  const cancelled = () => {
    if (options.signal?.aborted) throw new ApiError("cancelled", CANCELLED_TEXT);
  };
  cancelled();
  const model = embedder.model();
  const known = store.libraries();
  const libraries = request.libraries ? known.filter((lib) => request.libraries!.includes(lib.id)) : known;
  const overview = embedder.overview(libraries.map((lib) => lib.id));
  const refOf = (library: { id: string; name: string }, row: DocumentRow): DocumentRef => ({ library: library.id, library_name: library.name, name: row.name });

  // 按意思那一路要不要做：选了嵌入模型，而且至少有一份文档换算好了，才为要找的那句话发一次请求。
  let query: Float32Array | null = null;
  let reason: SearchReason | null = model === null ? "not_selected" : null;
  if (model !== null && overview.total - overview.pending > 0) {
    const from = performance.now();
    try {
      query = normalize((await embed(ctx, [request.query], "query", { signal: options.signal })).vectors[0]);
      if (query === null) reason = "bad_answer";
    } catch (error) {
      if (!(error instanceof EmbeddingError)) throw error;
      if (error.kind === "cancelled") throw new ApiError("cancelled", CANCELLED_TEXT);
      reason = REASONS[error.kind] ?? "service_error";
    } finally {
      timing.embed_query += performance.now() - from;
    }
  }
  cancelled();

  const entries: Entry[] = [];
  const uncoveredSemantic: DocumentRef[] = [];
  const uncovered: SearchResult["uncovered"] = [];
  let documents = 0;
  for (const lib of libraries) {
    for (const row of store.documents(lib.id)) {
      cancelled();
      const path = join(store.filesDir(lib.id), row.name);
      // 换算查询的这一会儿里文档可能换了、嵌入模型也可能换了：对不上的这一份只按字面。成品读不出、数字串长度与查询的不一样的也是。
      if (query !== null && isEmbedded(path, row.sha256, model!)) {
        const stored = timed("read_derived", () => readEmbeddings(path));
        if (stored && (stored.chunks.length === 0 || stored.head.dimensions === query.length)) {
          documents++;
          const size = query.length;
          timed("vector_compare", () => stored.chunks.forEach((chunk, i) => {
            let score = 0;
            const from = i * size;
            for (let k = 0; k < size; k++) score += stored.vectors[from + k] * query![k];
            entries.push({ library: lib, row, chunk, semantic: score });
          }));
          continue;
        }
      }
      // 没有数字串可比：片段现切（不写文件），只进按字面一路。
      let text: string;
      try {
        text = timed("read_source", () => store.text(lib.id, row.name));
      } catch {
        uncovered.push({ ...refOf(lib, row), reason: "source_unreadable" });
        continue;
      }
      documents++;
      for (const chunk of timed("chunk_now", () => chunkDocument(row.name, text, options.params))) entries.push({ library: lib, row, chunk, semantic: null });
      if (query !== null) uncoveredSemantic.push(refOf(lib, row));
    }
  }
  // 选了嵌入模型、这句话也没有换算失败，却一份换算好的文档都没有：全部文档都只按字面找了。
  if (model !== null && reason === null && query === null) {
    for (const lib of libraries) for (const row of store.documents(lib.id)) if (!uncovered.some((one) => one.library === lib.id && one.name === row.name)) uncoveredSemantic.push(refOf(lib, row));
  }
  cancelled();

  const index = timed("tokenize", () => keywordIndex(entries.map((entry) => entry.chunk)));
  const keyword = timed("keyword_score", () => keywordRanking(index, request.query));
  const semantic = entries.map((entry, i) => ({ i, score: entry.semantic })).filter((one): one is { i: number; score: number } => one.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const semanticRank = new Map(semantic.map((one, at) => [one.i, at + 1]));
  const keywordRank = new Map(keyword.map((one, at) => [one.i, at + 1]));
  const keywordScore = new Map(keyword.map((one) => [one.i, one.score]));
  const picked = combine(semantic.map((one) => one.i), keyword.map((one) => one.i), request.limit);
  // 取中的片段各读一次源文字（一份文档只读一次）；读不到的这一个不给，文档记进没有查到的。
  const sources = new Map<string, string | null>();
  const sourceOf = (library: { id: string; name: string }, row: DocumentRow): string | null => {
    const key = `${library.id}/${row.name}`;
    if (!sources.has(key)) {
      try {
        sources.set(key, timed("read_source", () => store.text(library.id, row.name)));
      } catch {
        sources.set(key, null);
        if (!uncovered.some((one) => one.library === library.id && one.name === row.name)) uncovered.push({ ...refOf(library, row), reason: "source_unreadable" });
      }
    }
    return sources.get(key)!;
  };
  const hits = picked.flatMap((i): SearchHit[] => {
    const { library, row, chunk, semantic: near } = entries[i];
    const source = sourceOf(library, row);
    if (source === null) return [];
    return [{
      score: Math.round((near ?? keywordScore.get(i) ?? 0) * 10000) / 10000, score_kind: near !== null ? "semantic" : "keyword",
      rank_semantic: semanticRank.get(i) ?? null, rank_keyword: keywordRank.get(i) ?? null,
      library: library.id, library_name: library.name, name: row.name, kind: row.kind, title: chunk.heading, block: chunk.block,
      first_paragraph: chunk.first_paragraph, last_paragraph: chunk.last_paragraph, first_line: chunk.first_line, last_line: chunk.last_line,
      partial: chunk.partial === true, text: chunk.text, locator: knowledgeLocator(library.id, row.name),
      ...passageOf(row.name, chunk, source),
    }];
  });
  const mode: SearchMode = reason !== null ? "keyword" : uncoveredSemantic.length > 0 ? "hybrid_partial" : "hybrid";
  for (const key of Object.keys(timing) as (keyof SearchTiming)[]) timing[key] = Math.round(timing[key] * 10) / 10;
  return {
    ok: true, mode, reason, model, ready: overview.ready, pending: overview.pending, libraries: libraries.length, documents, chunks: entries.length,
    uncovered_semantic: mode === "keyword" ? [] : uncoveredSemantic, uncovered, hits, timing,
  };
}
