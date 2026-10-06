/**
 * 知识库文档换算好的数字串存在哪里、怎样读写。一份文档换算好之后，在它旁边有两个派生文件（与投影、分段清单一样不列在 documents 里）：
 *   <文档名>.embeddings.json   {version, chunk_rules, document_sha256, model, dimensions, byte_order, normalized, embedded_at, chunks}
 *                              chunks 是各片段的位置与正文（knowledge_chunks.ts 的 Chunk），model 是「服务名/型号」。
 *   <文档名>.embeddings.bin    各片段的数字串依次连在一起，每个数是 4 个字节的浮点数（Float32），低位字节在前；
 *                              文件长度是「片段个数 × dimensions × 4」个字节。数字串存进去之前已经缩放成长度 1。
 *
 * 整份文档算完才写，写的次序保证任何时候断电都不会留下一份看起来完整、其实对不上的成品：先删旧的 .json（旧成品从这一刻起不算数），
 * 再把数字串写成临时文件、改名成 .bin，最后把 .json 写成临时文件、改名。读的时候 .json 在、.bin 的长度也对得上才算数。
 * 没有片段的文档（没有文字）照样写：chunks 是空的，dimensions 是 0，.bin 是空文件。
 *
 * 一份文档算不算「换算好了」每次现看（isEmbedded）：成品里记的文档 sha256、模型名、格式版本与切法版本都与现在的一致才算。
 * 所以换了嵌入模型、换了文档内容或者服务重启之后，不用另外登记，状态自然是对的。
 *
 * 本模块只管这两个文件，不调嵌入模型。
 */

import { closeSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { endianness } from "node:os";
import { join } from "node:path";
import * as clock from "./clock.ts";
import { type Chunk, chunkRulesVersion } from "./knowledge_chunks.ts";

export const EMBEDDINGS_SUFFIX = ".embeddings.json";
export const VECTORS_SUFFIX = ".embeddings.bin";
export const EMBEDDINGS_VERSION = 1;

const LITTLE = endianness() === "LE";
/** 写到一半的临时文件：成品的文件名后面加「.进程号.tmp」。 */
const LEFTOVER = /\.embeddings\.(json|bin)\.\d+\.tmp$/;

/** 成品的概况：.json 里除各片段以外的几项，加片段的个数。 */
export interface EmbeddingsHead {
  version: number;
  chunk_rules: number;
  document_sha256: string;
  model: string;
  /** 每条数字串的长度；没有片段时是 0。 */
  dimensions: number;
  /** 片段的个数。 */
  chunks: number;
  embedded_at: string;
}

/** 一份成品的全部内容。vectors 是各片段的数字串依次连在一起，第 i 个片段（从 0 起）是 [i × dimensions, (i + 1) × dimensions)。 */
export interface Embeddings {
  head: EmbeddingsHead;
  chunks: Chunk[];
  vectors: Float32Array;
}

function sizeOf(path: string): number | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function drop(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 本来就没有
  }
}

/** 把一条数字串缩放成长度 1。里面有不是数的项，或者全是 0（缩放不了）时是 null。 */
export function normalize(vector: readonly number[]): Float32Array | null {
  let sum = 0;
  for (const x of vector) {
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  if (!(norm > 0) || !Number.isFinite(norm)) return null;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

/** 一条数字串写进文件的字节：低位字节在前。 */
function bytesOf(vector: Float32Array): Buffer {
  if (LITTLE) return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  const out = Buffer.alloc(vector.length * 4);
  vector.forEach((x, i) => out.writeFloatLE(x, i * 4));
  return out;
}

function floatsOf(bytes: Buffer): Float32Array {
  const out = new Float32Array(bytes.length / 4);
  if (LITTLE) Buffer.from(out.buffer).set(bytes);
  else for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

/** 读过的概况按 .json 的修改时间与大小记着：知识库页面隔两秒问一次状态，不必每次把各片段的正文都读一遍。 */
const heads = new Map<string, { mtimeMs: number; size: number; head: EmbeddingsHead | null }>();

function parseHead(raw: any): EmbeddingsHead | null {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.chunks)) return null;
  const { version, chunk_rules, document_sha256, model, dimensions, embedded_at } = raw;
  if (![version, chunk_rules, dimensions].every((n) => Number.isInteger(n) && n >= 0)) return null;
  if (typeof document_sha256 !== "string" || typeof model !== "string") return null;
  return { version, chunk_rules, document_sha256, model, dimensions, chunks: raw.chunks.length, embedded_at: typeof embedded_at === "string" ? embedded_at : "" };
}

/** document 是文档本体的绝对路径。成品不在、读不出来，或者 .bin 的长度对不上时是 null。 */
export function readHead(document: string): EmbeddingsHead | null {
  const file = document + EMBEDDINGS_SUFFIX;
  let st;
  try {
    st = statSync(file);
  } catch {
    heads.delete(file);
    return null;
  }
  let known = heads.get(file);
  if (!known || known.mtimeMs !== st.mtimeMs || known.size !== st.size) {
    let head: EmbeddingsHead | null = null;
    try {
      head = parseHead(JSON.parse(readFileSync(file, "utf-8")));
    } catch {
      head = null;
    }
    known = { mtimeMs: st.mtimeMs, size: st.size, head };
    heads.set(file, known);
  }
  const head = known.head;
  return head && sizeOf(document + VECTORS_SUFFIX) === head.chunks * head.dimensions * 4 ? head : null;
}

/** 这份文档（内容的 sha256 是 sha256）在嵌入模型 model 下是不是换算好了。 */
export function isEmbedded(document: string, sha256: string, model: string): boolean {
  const head = readHead(document);
  return head !== null && head.version === EMBEDDINGS_VERSION && head.chunk_rules === chunkRulesVersion(document) && head.document_sha256 === sha256 && head.model === model;
}

/** 读整份成品（按意思查找时用）；不在或对不上时是 null。 */
export function readEmbeddings(document: string): Embeddings | null {
  const head = readHead(document);
  if (!head) return null;
  try {
    const chunks = JSON.parse(readFileSync(document + EMBEDDINGS_SUFFIX, "utf-8")).chunks as Chunk[];
    const bytes = readFileSync(document + VECTORS_SUFFIX);
    if (chunks.length !== head.chunks || bytes.length !== head.chunks * head.dimensions * 4) return null;
    return { head, chunks, vectors: floatsOf(bytes) };
  } catch {
    return null;
  }
}

/**
 * 写一份成品。vectors 与 chunks 一一对应，各条一样长，已经缩放成长度 1（normalize）。
 */
export function writeEmbeddings(document: string, sha256: string, model: string, chunks: Chunk[], vectors: Float32Array[]): EmbeddingsHead {
  if (vectors.length !== chunks.length) throw new TypeError(`片段有 ${chunks.length} 个，数字串有 ${vectors.length} 条。`);
  const dimensions = vectors[0]?.length ?? 0;
  if (vectors.some((v) => v.length !== dimensions)) throw new TypeError("各条数字串长短不一。");
  const file = document + EMBEDDINGS_SUFFIX;
  const bin = document + VECTORS_SUFFIX;
  const mark = `.${process.pid}.tmp`;
  heads.delete(file);
  drop(file);
  const fd = openSync(bin + mark, "w");
  try {
    for (const vector of vectors) writeSync(fd, bytesOf(vector));
  } finally {
    closeSync(fd);
  }
  renameSync(bin + mark, bin);
  const head = { version: EMBEDDINGS_VERSION, chunk_rules: chunkRulesVersion(document), document_sha256: sha256, model, dimensions };
  const at = clock.now();
  writeFileSync(file + mark, JSON.stringify({ ...head, byte_order: "little", normalized: true, embedded_at: at, chunks }, null, 2) + "\n", "utf-8");
  renameSync(file + mark, file);
  heads.delete(file);
  return { ...head, chunks: chunks.length, embedded_at: at };
}

/** 删掉这份文档的成品（删除文档时用）。 */
export function removeEmbeddings(document: string): void {
  heads.delete(document + EMBEDDINGS_SUFFIX);
  drop(document + EMBEDDINGS_SUFFIX);
  drop(document + VECTORS_SUFFIX);
}

/**
 * 清掉一个库的 files/ 目录里换算留下的半成品：写到一半的临时文件，以及没有 .json 的 .bin（数字串写完了、概况还没写）。
 * 服务启动时做一次；返回删掉了几个文件。目录不在时什么也不做。
 */
export function sweepLeftovers(filesDir: string): number {
  let names: string[];
  try {
    names = readdirSync(filesDir);
  } catch {
    return 0;
  }
  const present = new Set(names);
  let removed = 0;
  for (const name of names) {
    const orphan = name.endsWith(VECTORS_SUFFIX) && !present.has(name.slice(0, -VECTORS_SUFFIX.length) + EMBEDDINGS_SUFFIX);
    if (!LEFTOVER.test(name) && !orphan) continue;
    drop(join(filesDir, name));
    removed++;
  }
  return removed;
}
