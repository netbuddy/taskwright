/**
 * 知识库按意思查找：把一句话用选定的嵌入模型按查询的用途换算成数字串（会加查询前缀），与若干个知识库里全部片段的数字串比远近，
 * 给出最相近的几个片段，连同它在哪个知识库、哪份文档、哪个位置。片段与数字串是后台换算时存在文档旁边的（knowledge_embeddings.ts）。
 *
 * 相近程度是两条数字串的点积：存着的数字串长度都是 1，查询的那一条这里也缩放成长度 1，所以它在 -1 到 1 之间，越大越相近。
 * 不设门槛：按相近程度从高到低取前几个，高低交给看结果的一方判断。
 *
 * 每次查找都逐份读文档旁边的文件、当场比完，不在内存里留着：一万个片段、数字串长度 4096 时一次是一两百毫秒。
 *
 * 换算完成之前不查：这几个知识库里只要还有一份文档没有用现在选定的嵌入模型换算好，就回「还不能用」与还差几份，
 * 不拿换算好的那一部分给出不完整的结果。没有选嵌入模型时以 rejected 拒绝。
 */

import { join } from "node:path";
import { knowledgeLocator } from "../../agent/src/lib/knowledge_locator.ts";
import { EmbeddingError, NOT_SELECTED_TEXT, embed } from "./embedding.ts";
import { ApiError } from "./errors.ts";
import type { DocumentRow, Kind, KnowledgeStore } from "./knowledge.ts";
import type { Chunk } from "./knowledge_chunks.ts";
import type { KnowledgeEmbedder } from "./knowledge_embedder.ts";
import { isEmbedded, normalize, readEmbeddings } from "./knowledge_embeddings.ts";
import type { Context } from "./model_config.ts";

/** 不说要几个时给几个，以及最多给几个。 */
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 10;

export const QUERY_REQUIRED_TEXT = "query 应当是要找的一句话，不能是空的。";
export const LIMIT_RANGE_TEXT = `limit 应当是 1 到 ${SEARCH_MAX_LIMIT} 的整数。`;
export const LIBRARIES_SHAPE_TEXT = "libraries 应当是知识库编号的列表。";

/** 查到的一个片段。 */
export interface SearchHit {
  /** 相近程度，-1 到 1，四位小数。 */
  score: number;
  /** 知识库的编号与名字。 */
  library: string;
  library_name: string;
  /** 文档名与种类。 */
  name: string;
  kind: Kind;
  /** 片段的标题（Word 文档是所在块的标题，Markdown 是各级标题连起来）；没有是 null。 */
  title: string | null;
  /** Word 文档的起止段落号；别的文档是 null。 */
  first_paragraph: number | null;
  last_paragraph: number | null;
  /** Markdown 与纯文本的起止行号；Word 文档是 null。 */
  first_line: number | null;
  last_line: number | null;
  /** 片段的正文。 */
  text: string;
  /** 引用这份文档作来源时出处的写法；Word 文档还要加摘录所在那一段的段落号。 */
  locator: string;
}

export interface SearchResult {
  ok: true;
  /** 这几个知识库里的文档是不是都换算好了；为假时不查，hits 是空的。 */
  ready: boolean;
  /** 用的嵌入模型，「服务名/型号」。 */
  model: string;
  /** 还没有换算好的文档份数。 */
  pending: number;
  /** 比了几个知识库、几个片段。 */
  libraries: number;
  chunks: number;
  hits: SearchHit[];
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
 * 查找。换算查询时模型服务出了事（连不上、到时间没有回答、回答了错误）以 embedding_failed 报出去，说明是模型服务给的那一句。
 */
export async function searchKnowledge(store: KnowledgeStore, embedder: KnowledgeEmbedder, ctx: Context, request: SearchRequest): Promise<SearchResult> {
  const model = embedder.model();
  if (model === null) throw new ApiError("rejected", NOT_SELECTED_TEXT);
  const known = store.libraries();
  const libraries = request.libraries ? known.filter((lib) => request.libraries!.includes(lib.id)) : known;
  const overview = embedder.overview(libraries.map((lib) => lib.id));
  const base = { ok: true as const, model, pending: overview.pending, libraries: libraries.length };
  if (!overview.ready) return { ...base, ready: false, chunks: 0, hits: [] };
  if (overview.total === 0) return { ...base, ready: true, chunks: 0, hits: [] };

  let query: Float32Array | null;
  try {
    query = normalize((await embed(ctx, [request.query], "query")).vectors[0]);
  } catch (error) {
    if (error instanceof EmbeddingError) throw new ApiError("embedding_failed", error.message);
    throw error;
  }
  if (query === null) throw new ApiError("embedding_failed", "模型服务回答的数字串全是 0，没法用。");

  // 只记下要用的几样（不记整份成品）：一份文档比完，它的数字串就可以放掉。
  const found: { score: number; library: (typeof libraries)[number]; row: DocumentRow; chunk: Chunk }[] = [];
  let chunks = 0;
  for (const lib of libraries) {
    for (const row of store.documents(lib.id)) {
      const path = join(store.filesDir(lib.id), row.name);
      // 换算查询的这一会儿里文档可能换了、嵌入模型也可能换了：对不上的这一份不比。数字串长度与查询的不一样的也不比。
      if (!isEmbedded(path, row.sha256, model)) continue;
      const stored = readEmbeddings(path);
      if (!stored || stored.head.dimensions !== query.length) continue;
      const size = query.length;
      stored.chunks.forEach((chunk, i) => {
        let score = 0;
        const from = i * size;
        for (let k = 0; k < size; k++) score += stored.vectors[from + k] * query![k];
        chunks++;
        found.push({ score, library: lib, row, chunk });
      });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const hits = found.slice(0, request.limit).map(({ score, library, row, chunk }): SearchHit => ({
    score: Math.round(score * 10000) / 10000, library: library.id, library_name: library.name, name: row.name, kind: row.kind, title: chunk.heading,
    first_paragraph: chunk.first_paragraph, last_paragraph: chunk.last_paragraph, first_line: chunk.first_line, last_line: chunk.last_line,
    text: chunk.text, locator: knowledgeLocator(library.id, row.name),
  }));
  return { ...base, ready: true, chunks, hits };
}
