/**
 * 知识库文档的后台换算：把还没有换算好的文档排成队，一份一份地切成片段、送去嵌入模型、把拿回来的数字串存到文档旁边
 * （切法见 knowledge_chunks.ts，存放见 knowledge_embeddings.ts，调嵌入模型见 embedding.ts）。
 *
 * 同一时间只算一份文档、只发一个请求；队里的文档按知识库在清单里的先后、再按文档在库里的先后算。一份文档的各片段分批送去
 * （一批几段按模型服务的种类取 embedding.ts 的 BATCH_LIMIT），整份都拿回来才写成品，中途出了事这一份什么都不留下。
 *
 * 一份文档现在是什么状态每次现看，不另外登记：
 *   done    成品在，而且是用现在选定的嵌入模型、对着现在这份内容算的；
 *   running 正在算；queued 在队里；failed 上一次没算成（原因记在内存里，服务重启就忘了）；
 *   none    其余的：没有选嵌入模型、换了嵌入模型、还没有人让它开始、上一次整个换算停下了。
 * 所以服务重启之后，正在算的与排着队的都回到 none，等用户再点一次；换了嵌入模型之后，全部文档自然都是 none。
 *
 * 没算成分两种。与文档无关的（连不上、到时间没有回答、密钥被拒绝、选定的模型服务不在了或者没有嵌入模型）：整个换算停下，
 * 队清空，原因记在 stopped_reason 里，文档不记成失败。只关这一份文档的（模型服务回答了错误，例如文字超过它一次能收的长度；
 * 回答的数字串不对；文档读不出来）：这一份记成 failed 带上原因，接着算下一份。
 *
 * 算到一半时：嵌入模型换了，这一份作废、放回队首按新的模型重算；文档被删除了或者换了内容，这一份作废；服务停止，手上的请求立刻放下。
 */

import { join } from "node:path";
import type { SegmentParams } from "../../agent/src/lib/segments.ts";
import { BATCH_LIMIT, EmbeddingError, type EmbeddingFailure, NOT_SELECTED_TEXT, embed } from "./embedding.ts";
import { ApiError } from "./errors.ts";
import type { DocumentRow, KnowledgeStore } from "./knowledge.ts";
import { chunkDocument, chunkInput } from "./knowledge_chunks.ts";
import { isEmbedded, normalize, readHead, writeEmbeddings } from "./knowledge_embeddings.ts";
import { type Context, embeddingTarget } from "./model_config.ts";

export type EmbeddingStatus = "none" | "queued" | "running" | "done" | "failed";

/** 一份文档的换算状态（GET /api/v1/knowledge 里每份文档的 embedding）。 */
export interface DocumentEmbedding {
  status: EmbeddingStatus;
  /** done、running、failed 时是用的嵌入模型（「服务名/型号」）；none、queued 时是旁边留着的成品所用的模型，没有成品是 null。 */
  model: string | null;
  /** failed 时的原因；别的状态是 null。 */
  error: string | null;
  /** 片段数：done 时两个数相同；running 时是算完了几个、一共几个（还没切好时 total 是 null）；别的状态是 null。 */
  done: number | null;
  total: number | null;
}

/** 若干个知识库合起来的换算情况。 */
export interface EmbeddingOverview {
  /** 现在选定的嵌入模型；没有选是 null。 */
  model: string | null;
  /** 有文档正在算或者在队里。 */
  running: boolean;
  /** 选了嵌入模型，而且这些库里的文档全都换算好了（一份文档也没有时也算）。按意思查找据此决定能不能用。 */
  ready: boolean;
  /** 还没有换算好的文档份数（正在算的、在队里的、没算成的都算在内）。 */
  pending: number;
  /** 文档一共多少份。 */
  total: number;
  /** 上一次整个换算停下的原因；没有停下过，或者之后又开始了，是 null。 */
  stopped_reason: string | null;
}

/** 与文档无关的失败：遇到了就整个停下，不往下一份试。 */
const STOPPING: ReadonlySet<EmbeddingFailure> = new Set(["not_selected", "provider_gone", "not_offered", "unreachable", "timeout", "key_rejected"]);

/** 模型服务回答的数字串缩放不成长度 1（全是 0）时的那句话。 */
export const ZERO_VECTOR_TEXT = "模型服务回答的数字串全是 0，没法用。";

interface Job {
  library: string;
  name: string;
}

interface Current extends Job {
  model: string;
  done: number;
  total: number | null;
  /** 中止它就放下手上的请求，这一份作废。 */
  abort: AbortController;
}

const keyOf = (library: string, name: string) => `${library}\n${name}`;

export interface EmbedderOptions {
  /** 一次请求最多等多久；不给时用 embedding.ts 的缺省值。 */
  timeoutMs?: number;
}

export class KnowledgeEmbedder {
  private readonly store: KnowledgeStore;
  private readonly context: () => Context;
  private readonly params: () => SegmentParams;
  private readonly options: EmbedderOptions;
  private queue: Job[] = [];
  private current: Current | null = null;
  private readonly failed = new Map<string, { sha256: string; model: string; error: string }>();
  private stopped: string | null = null;
  private loop: Promise<void> | null = null;
  private closed = false;

  /** context 给出读模型配置要的环境，params 给出 Word 文档的分段参数；两个都是每次用到时现取。 */
  constructor(store: KnowledgeStore, context: () => Context, params: () => SegmentParams, options: EmbedderOptions = {}) {
    this.store = store;
    this.context = context;
    this.params = params;
    this.options = options;
  }

  /** 现在选定的嵌入模型，「服务名/型号」；没有选是 null。写法与 embed() 结果里的 model 相同。 */
  model(): string | null {
    const target = embeddingTarget(this.context());
    return target ? `${target.provider_id}/${target.model}` : null;
  }

  private path(library: string, name: string): string {
    return join(this.store.filesDir(library), name);
  }

  /** 一份文档的换算状态。model 是现在选定的嵌入模型，调用的一方已经取过时传进来，免得每份文档读一次设置。 */
  documentState(library: string, row: DocumentRow, model: string | null = this.model()): DocumentEmbedding {
    const path = this.path(library, row.name);
    const head = readHead(path);
    if (model !== null && head !== null && isEmbedded(path, row.sha256, model)) return { status: "done", model, error: null, done: head.chunks, total: head.chunks };
    const cur = this.current;
    if (cur && cur.library === library && cur.name === row.name) return { status: "running", model: cur.model, error: null, done: cur.done, total: cur.total };
    const kept = head?.model ?? null;
    if (this.queue.some((job) => job.library === library && job.name === row.name)) return { status: "queued", model: kept, error: null, done: null, total: null };
    const failure = this.failed.get(keyOf(library, row.name));
    if (failure && failure.sha256 === row.sha256 && failure.model === model) return { status: "failed", model, error: failure.error, done: null, total: null };
    return { status: "none", model: kept, error: null, done: null, total: null };
  }

  /** 这些知识库合起来的换算情况；不给时是全部知识库。清单里没有的编号不算。 */
  overview(libraries?: string[]): EmbeddingOverview {
    const model = this.model();
    const known = this.store.libraries().map((lib) => lib.id);
    const ids = libraries ? libraries.filter((id) => known.includes(id)) : known;
    let total = 0;
    let done = 0;
    for (const id of ids) {
      for (const row of this.store.documents(id)) {
        total++;
        if (model !== null && isEmbedded(this.path(id, row.name), row.sha256, model)) done++;
      }
    }
    return { model, running: this.current !== null || this.queue.length > 0, ready: model !== null && done === total, pending: total - done, total, stopped_reason: this.stopped };
  }

  /**
   * 把现在选定的嵌入模型下还没有换算好的文档排进队，开始算；返回这一次新排进去几份。不给范围是全部知识库，给 library 是那一个库，
   * 再给 name 是那一份文档（没算成之后重试用）。已经在算或者已经在队里的不重复排；上一次停下的原因与这些文档上一次没算成的原因随之清掉。
   * 没有选嵌入模型时以 rejected 拒绝；没有那个库或那份文档时 not_found。
   */
  enqueue(scope: { library?: string; name?: string } = {}): number {
    const model = this.model();
    if (model === null) throw new ApiError("rejected", NOT_SELECTED_TEXT);
    if (scope.library !== undefined) this.store.library(scope.library);
    const libraries = this.store.libraries().map((lib) => lib.id);
    const order = new Map<string, number>();
    let added = 0;
    let found = scope.name === undefined;
    for (const id of libraries) {
      for (const row of this.store.documents(id)) {
        order.set(keyOf(id, row.name), order.size);
        if ((scope.library !== undefined && id !== scope.library) || (scope.name !== undefined && row.name !== scope.name)) continue;
        found = true;
        if (isEmbedded(this.path(id, row.name), row.sha256, model)) continue;
        this.failed.delete(keyOf(id, row.name));
        const cur = this.current;
        if (cur && cur.library === id && cur.name === row.name) continue;
        if (this.queue.some((job) => job.library === id && job.name === row.name)) continue;
        this.queue.push({ library: id, name: row.name });
        added++;
      }
    }
    if (!found) throw new ApiError("not_found", `这个知识库里没有文档《${scope.name}》。`);
    this.queue.sort((a, b) => (order.get(keyOf(a.library, a.name)) ?? 0) - (order.get(keyOf(b.library, b.name)) ?? 0));
    this.stopped = null;
    this.start();
    return added;
  }

  /** 文档或者整个知识库要删除了：从队里拿掉，没算成的记录去掉；正在算的是它就放下，这一份作废。不给 name 是整个库。 */
  forget(library: string, name?: string): void {
    const hit = (job: Job) => job.library === library && (name === undefined || job.name === name);
    this.queue = this.queue.filter((job) => !hit(job));
    for (const key of [...this.failed.keys()]) {
      if (name === undefined ? key.startsWith(`${library}\n`) : key === keyOf(library, name)) this.failed.delete(key);
    }
    if (this.current && hit(this.current)) this.current.abort.abort();
  }

  /** 等后台把手上排着的都算完（或者停下）。 */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  /** 服务停止：队清空，手上的请求放下，等后台收住。之后不再接受新的。 */
  async close(): Promise<void> {
    this.closed = true;
    this.queue = [];
    this.current?.abort.abort();
    await this.idle();
  }

  private start(): void {
    if (this.loop || this.closed || !this.queue.length) return;
    this.loop = this.run().finally(() => {
      this.loop = null;
      // 收尾的这一刻又有新排进来的：接着算。
      this.start();
    });
  }

  private async run(): Promise<void> {
    while (this.queue.length && !this.closed) {
      const job = this.queue.shift()!;
      if (!(await this.embedOne(job))) this.queue = [];
    }
  }

  /** 算一份文档。返回假表示整个换算要停下（原因已经记在 stopped 里，或者是没有选嵌入模型了）。 */
  private async embedOne(job: Job): Promise<boolean> {
    const model = this.model();
    if (model === null) return false;
    const row = this.store.documents(job.library).find((one) => one.name === job.name);
    const path = this.path(job.library, job.name);
    if (!row || isEmbedded(path, row.sha256, model)) return true;
    const key = keyOf(job.library, job.name);
    const cur: Current = { ...job, model, done: 0, total: null, abort: new AbortController() };
    this.current = cur;
    const started = Date.now();
    try {
      const chunks = chunkDocument(job.name, this.store.text(job.library, job.name), this.params());
      cur.total = chunks.length;
      const kind = embeddingTarget(this.context())?.kind ?? null;
      const limit = kind !== null && kind !== "codex" ? BATCH_LIMIT[kind] : 1;
      const vectors: Float32Array[] = [];
      let dimensions: number | null = null;
      for (let i = 0; i < chunks.length; i += limit) {
        const batch = chunks.slice(i, i + limit);
        const got = await embed(this.context(), batch.map(chunkInput), "document", { timeoutMs: this.options.timeoutMs, signal: cur.abort.signal });
        if (cur.abort.signal.aborted) return true;
        if (got.model !== model) {
          // 算到一半换了嵌入模型：这一份作废，放回队首，下一轮按新的模型算。
          this.queue.unshift(job);
          return true;
        }
        if (dimensions !== null && got.dimensions !== dimensions) throw new EmbeddingError("bad_answer", "模型服务回答的各条数字串长短不一。");
        dimensions = got.dimensions;
        for (const vector of got.vectors) {
          const unit = normalize(vector);
          if (unit === null) throw new EmbeddingError("bad_answer", ZERO_VECTOR_TEXT);
          vectors.push(unit);
        }
        cur.done += batch.length;
      }
      // 算的这段时间里文档可能被删除了，或者删了又上传了一份同名的：对着的不是现在这份内容就作废。
      const now = this.store.documents(job.library).find((one) => one.name === job.name);
      if (cur.abort.signal.aborted || !now || now.sha256 !== row.sha256) return true;
      writeEmbeddings(path, row.sha256, model, chunks, vectors);
      this.failed.delete(key);
      console.log(`知识库文档《${job.name}》换算好了：${chunks.length} 个片段，用了 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`);
      return true;
    } catch (error) {
      if (cur.abort.signal.aborted) return true;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof EmbeddingError && STOPPING.has(error.kind)) {
        this.stopped = message;
        console.log(`知识库文档的换算停下了：${message}`);
        return false;
      }
      this.failed.set(key, { sha256: row.sha256, model, error: message });
      console.log(`知识库文档《${job.name}》没有换算成：${message}`);
      return true;
    } finally {
      if (this.current === cur) this.current = null;
    }
  }
}
