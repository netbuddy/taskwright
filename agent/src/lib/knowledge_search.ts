/**
 * 「查找知识库」工具（search_knowledge）的核心逻辑：在这个任务选用的知识库里找与一句话最相关的几个片段，按意思与按字面两路并行。
 *
 * 两路都不在这里算。按意思那一路要把那句话换算成数字串、得调嵌入模型，模型服务的地址与密钥只在任务服务那一边；所以这里把要找的话与
 * 任务选用的知识库的编号发给任务服务的查找接口（POST /api/v1/knowledge/search），拿回最相关的片段与它们的原文，排成给助手看的文字。
 *
 * 任务服务在哪里：它接手一个任务时在任务目录里写一份占用标记 service.lock，里面有它监听的端口与所在主机的名字。
 * 助手是任务服务在同一台机器上起的，所以先连本机回环地址上的那个端口；连不上时再按标记里的主机名连一次
 * （任务服务只绑在某一块网卡上时，回环地址连不上）。两处都连不上，或者没有这份标记（不经任务服务直接起的助手），就说这一次没有做成。
 *
 * 这个工具从不让助手停下：任务服务联系不上或者回答了错误，回一句话说明原因与接下来怎么办（再查一次，仍然不成就告诉用户并记
 * 问题条目）；只有参数写错时抛异常（异常文字由 pi 交还模型）。按意思那一路做不了（没有选嵌入模型、文档还没有换算好、模型服务
 * 出错）不算没有做成：任务服务退到只按字面找，结果照样给，开头一句写明这一次是怎样找的、哪些文档只按字面找了、哪些没有查到。
 * 助手取消这次调用时回「查找被取消了」。
 *
 * 给助手的每个片段写着它在哪份文档、位置（行号或段落号，不给文件的路径）、它在两路里各排第几、出处的写法，与逐字的原文：
 * 原文是任务服务按片段的位置从源文字现读的，Markdown 与纯文本连空行逐字节相同，Word 文档每段一行、行首是段落号，表格另写行结构。
 * 助手照原文抄摘录，不必再读知识库文件核对；保存修订时系统逐字核对。引用时出处的写法不变：Word 文档要写摘录所在那一段的段落号。
 * 全部文字按 UTF-8 的字节数不超过 BUDGET_BYTES：超过时从末尾去掉片段并写明还有几条，第 1 个永不去掉。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectedKnowledge } from "./knowledge.ts";

/** 任务服务写在任务目录里的占用标记（backend/src/occupancy.ts 的 LOCK_NAME，两边是一份约定）。 */
export const LOCK_NAME = "service.lock";
/** 查找接口的路径（backend/src/http.ts 的路由，两边是一份约定）。 */
export const SEARCH_PATH = "/api/v1/knowledge/search";
/** 不说要几个时给几个，以及最多给几个；与任务服务那一边相同（backend/src/knowledge_search.ts）。 */
export const SEARCH_DEFAULT_LIMIT = 3;
export const SEARCH_MAX_LIMIT = 5;
/** 等任务服务回答最多等多久：它换算要找的那句话最多等模型服务 60 秒。 */
export const SEARCH_TIMEOUT_MS = 70_000;

/** 这一次没有做成时接在原因后面的话。 */
export const RETRY_TEXT = "可以再查一次；仍然不成时把这个原因告诉用户，这一处先保留材料的原话并记一条问题条目。";
export const NO_KNOWLEDGE_TEXT = "这个任务没有知识库，没有可查的。";
export const NO_DOCUMENTS_TEXT = "这个任务选用的知识库里没有文档，没有可查的。";
export const UNREACHABLE_TEXT = `按意思查找这一次没有做成：联系不上系统里负责查找的那一部分。${RETRY_TEXT}`;
export const CLOSING_TEXT = "查到的片段就是逐字的原文：摘录从片段逐字抄，出处照片段给的写法写；不必再读知识库文件核对，保存时系统会逐字核对，对不上会退回并说明原因。";

export const CANCELLED_TEXT = "查找被取消了。";
export const NOT_FOUND_TEXT = "没有找到相关的片段。换一种说法再查一次；换了说法仍然没有，才算知识库里没有。";

/** 只按字面找的原因写成半句话。 */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  not_selected: "没有选嵌入模型",
  provider_gone: "选定的嵌入模型所在的模型服务不在了",
  not_offered: "选定的模型服务不提供嵌入模型",
  timeout: "按意思那一路没有做成：把要找的话换算成数字串时，到时间没有算完",
  unreachable: "按意思那一路没有做成：连不上嵌入模型的模型服务",
  key_rejected: "按意思那一路没有做成：嵌入模型的模型服务拒绝了密钥",
  service_error: "按意思那一路没有做成：嵌入模型的模型服务回答了错误",
  bad_answer: "按意思那一路没有做成：嵌入模型的模型服务回答的数字串不对",
};

/** 几份文档的名字连起来；多于 5 份时只写前 5 份与一共几份。 */
const documentNames = (docs: { name: string }[]) =>
  docs.slice(0, 5).map((doc) => `《${doc.name}》`).join("") + (docs.length > 5 ? `等 ${docs.length} 份文档` : "");

/**
 * 开头的一句：这一次在多大的范围里、按哪一路找的；哪些文档只按字面找了；哪些文档没有查到。body 是任务服务的回答。
 */
export function openingText(query: string, body: Record<string, any>, selectedLibraries: number): string {
  const keywordOnly = body.mode === "keyword";
  const way = keywordOnly ? `只按字面找（${REASON_TEXT[body.reason] ?? "按意思那一路没有做成"}）` : "按意思与按字面两路找";
  const partial: { name: string }[] = Array.isArray(body.uncovered_semantic) ? body.uncovered_semantic : [];
  const missed: { name: string }[] = Array.isArray(body.uncovered) ? body.uncovered : [];
  return `查找「${query}」：在这个任务选用的 ${Number(body.libraries) || selectedLibraries} 个知识库、${Number(body.documents) || 0} 份文档、${Number(body.chunks) || 0} 个片段里${way}。`
    + (partial.length ? `${documentNames(partial)}还没有换算好，这一次对${partial.length > 1 ? "它们" : "它"}只按字面找了。` : "")
    + (missed.length ? `${documentNames(missed)}这一次没有查到，因为${missed.length > 1 ? "它们" : "它"}的文件读不出来；没有找到不等于知识库里没有。` : "");
}

export const failedText = (reason: string) => `按意思查找这一次没有做成：${reason.replace(/[。.]$/, "")}。${RETRY_TEXT}`;

/** 工具的返回：给模型的一段文字，给读取一侧的结构化内容。 */
export interface SearchOutcome {
  text: string;
  details: Record<string, unknown>;
}

/** Word 文档的一段：段落号与文字。 */
interface Paragraph {
  paragraph: number;
  text: string;
}

/** 表格一行里的一格：格里各段的段落号；合并格是占位的字；空格是空文字。 */
type RowCell = number[] | string;

/** 任务服务回的一个片段（backend/src/knowledge_search.ts 的 SearchHit）。 */
interface Hit {
  score: number;
  score_kind: string;
  rank_semantic: number | null;
  rank_keyword: number | null;
  library: string;
  library_name: string;
  name: string;
  index: number;
  title: string | null;
  first_paragraph: number | null;
  last_paragraph: number | null;
  first_line: number | null;
  last_line: number | null;
  partial: boolean;
  /** 片段里存的文字（页面显示用）；给助手的是下面的原文。 */
  text: string;
  locator: string;
  /** Markdown 与纯文本：逐字节的原文。 */
  body: string | null;
  /** Word 文档：各段。 */
  paragraphs: Paragraph[] | null;
  table: RowCell[][] | null;
  header: { first_paragraph: number | null; last_paragraph: number | null; cells: RowCell[]; paragraphs: Paragraph[] } | null;
}

export interface SearchOptions {
  /** 助手取消这次工具调用时中止它。 */
  signal?: AbortSignal;
  /** 发请求用的函数，缺省是自带的 fetch（测试里换成假的）。 */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** 任务服务的地址，按先后试：本机回环地址上的那个端口，再是占用标记里写的主机名。没有标记或标记里没有端口时是空的。 */
export function backendAddresses(taskDir: string): string[] {
  let lock: { port?: unknown; host?: unknown };
  try {
    lock = JSON.parse(readFileSync(join(taskDir, LOCK_NAME), "utf-8"));
  } catch {
    return [];
  }
  const port = lock?.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return [];
  const out = [`http://127.0.0.1:${port}`];
  if (typeof lock.host === "string" && lock.host && lock.host !== "127.0.0.1" && lock.host !== "localhost") out.push(`http://${lock.host}:${port}`);
  return out;
}

/** 把参数整理好；写得不对时抛异常。 */
export function searchParams(params: { query?: unknown; limit?: unknown }): { query: string; limit: number } {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) throw new Error("query 要写要找的内容，用一句完整的话写出来，不能是空的。");
  const limit = params.limit === undefined || params.limit === null ? SEARCH_DEFAULT_LIMIT : params.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
    throw new Error(`limit 要写 1 到 ${SEARCH_MAX_LIMIT} 的整数，不写是 ${SEARCH_DEFAULT_LIMIT}。`);
  }
  return { query, limit };
}

const range = (from: number, to: number, unit: string) => (from === to ? `第 ${from} ${unit}` : `第 ${from} 到 ${to} ${unit}`);
const bytesOf = (text: string) => Buffer.byteLength(text, "utf-8");

/** 助手收到的全部文字（连同说明）最多多少字节；超过时从末尾去掉片段，第 1 个永不去掉。 */
export const BUDGET_BYTES = 8192;
/** 正文前后的记号：正文夹在这两行之间，摘录从这里面逐字抄。 */
export const BODY_OPEN = "<<<原文开始";
export const BODY_CLOSE = "原文结束>>>";

/** 去掉了几个片段时的那一行。 */
export const trimmedText = (removed: number) => `（这一次的结果超过了 ${BUDGET_BYTES} 字节的上限：还有 ${removed} 条没有列出，缩小问题再查。）`;
/** 第 1 个片段的正文也放不下、只显示了前几个字时的那一行。 */
export const truncatedText = (chars: number) => `（正文只显示了前 ${chars} 字；要看后面的内容，把问题缩小再查。）`;

/** 片段在哪里：Word 文档是段落号，别的是行号。 */
function positionOf(hit: Hit): string {
  if (hit.first_paragraph !== null && hit.last_paragraph !== null) return range(hit.first_paragraph, hit.last_paragraph, "段");
  if (hit.first_line !== null && hit.last_line !== null) return range(hit.first_line, hit.last_line, "行");
  return "位置不详";
}

/** 表格的一行写成「p36｜p37、p38｜（同上）」：竖线隔开各格，格里是它的段落号。 */
const rowShape = (cells: RowCell[]) => cells.map((cell) => (Array.isArray(cell) ? cell.map((n) => `p${n}`).join("、") : cell || "（空）")).join("｜");
const paragraphLines = (paragraphs: Paragraph[]) => paragraphs.map((one) => `[p${one.paragraph}] ${one.text}`);

/** 它在两路里各排第几。keywordOnly 为真是这一次只按字面找了。 */
function ranksText(hit: Hit, keywordOnly: boolean): string {
  if (keywordOnly) return `按字面排第 ${hit.rank_keyword}`;
  if (hit.rank_semantic !== null && hit.rank_keyword !== null) return `按意思排第 ${hit.rank_semantic}，按字面排第 ${hit.rank_keyword}`;
  if (hit.rank_semantic !== null) return `按意思排第 ${hit.rank_semantic}，按字面没有命中`;
  return `按字面排第 ${hit.rank_keyword}，按意思没有比（这份文档还没有换算好）`;
}

/** 一个片段排成的几部分：正文之前的各行、正文、正文之后的一行。 */
interface Block {
  head: string[];
  body: string;
  tail: string[];
}

function hitBlock(no: number, hit: Hit, keywordOnly: boolean): Block {
  const word = hit.paragraphs !== null;
  const head = [
    `【第 ${no} 个片段】知识库「${hit.library_name}」《${hit.name}》${hit.title ? ` · 标题：${hit.title}` : ""} · ${ranksText(hit, keywordOnly)}`,
    `位置：${positionOf(hit)}${hit.partial ? "（这一段很长，切成了几个片段，这里是其中的一截，不是全文）" : ""}`,
    word ? `引用时出处写：${hit.locator}#p段落号（写摘录所在那一段的段落号）` : `引用时出处写：${hit.locator}`,
  ];
  if (hit.table?.length) {
    head.push(`表格结构（每个分号是表格的一行，竖线隔开各格，格里写的是它的段落号；一条来源只抄一格里的字，不要把一行的几格连起来抄）：${hit.table.map(rowShape).join("；")}`);
  }
  if (hit.header) {
    const h = hit.header;
    const where = h.first_paragraph !== null && h.last_paragraph !== null ? range(h.first_paragraph, h.last_paragraph, "段") : "位置不详";
    head.push(`这张表的表头（出自${where}，只帮你看懂各列，不在这个片段的位置范围里；要引用表头里的字，出处写它自己的段落号）：${rowShape(h.cells)}`,
      BODY_OPEN, ...paragraphLines(h.paragraphs), BODY_CLOSE);
  }
  head.push(word ? "正文（每行是一段，开头方括号里是这一段的段落号，摘录不带它）：" : "正文：", BODY_OPEN);
  return { head, body: word ? paragraphLines(hit.paragraphs!).join("\n") : hit.body ?? hit.text, tail: [BODY_CLOSE] };
}

/**
 * 把查到的片段排成助手收到的文字，并按 BUDGET_BYTES 裁剪：全部文字（开头一句、各片段、裁剪的说明与末尾的说明）按 UTF-8 的字节数算。
 * 超过时从末尾一个一个去掉片段并写明还有几条没有列出；第 1 个永不去掉，只剩它仍然超过时截短它的正文并写明只显示了前几个字。
 * opening 是开头的一句。返回文字、列出了几个、去掉了几个，与第 1 个的正文显示了几个字（没有截短是 null）。
 */
export function assemble(opening: string, hits: Hit[], keywordOnly: boolean, budget: number = BUDGET_BYTES):
  { text: string; shown: number; removed: number; truncated_chars: number | null } {
  const blocks = hits.map((hit, i) => hitBlock(i + 1, hit, keywordOnly));
  const render = (shown: number, truncate: number | null) => {
    const lines = [opening, ""];
    blocks.slice(0, shown).forEach((block, i) => {
      const cut = i === 0 && truncate !== null;
      lines.push(...block.head, cut ? Array.from(block.body).slice(0, truncate!).join("") : block.body, ...block.tail);
      if (cut) lines.push(truncatedText(truncate!));
      lines.push("");
    });
    if (shown < blocks.length) lines.push(trimmedText(blocks.length - shown), "");
    lines.push(CLOSING_TEXT);
    return lines.join("\n");
  };
  for (let shown = blocks.length; shown >= 1; shown--) {
    const text = render(shown, null);
    if (bytesOf(text) <= budget) return { text, shown, removed: blocks.length - shown, truncated_chars: null };
  }
  // 只剩第 1 个仍然超过：截短它的正文，取放得下的最多的字数。
  let low = 0;
  let high = Array.from(blocks[0].body).length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytesOf(render(1, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  return { text: render(1, low), shown: 1, removed: blocks.length - 1, truncated_chars: low };
}

/**
 * 查找。taskDir 是任务目录，knowledgeRoot 是知识库根目录（没有知识库时为 null），params 是工具收到的参数。
 */
export async function searchKnowledge(
  taskDir: string, knowledgeRoot: string | null, params: { query?: unknown; limit?: unknown }, options: SearchOptions = {},
): Promise<SearchOutcome> {
  const { query, limit } = searchParams(params);
  const refused = (text: string, reason: string): SearchOutcome => ({ text, details: { ok: false, ready: false, query, limit, reason, hits: [] } });
  if (!knowledgeRoot) return refused(NO_KNOWLEDGE_TEXT, "no_knowledge");
  const selected = selectedKnowledge(taskDir, knowledgeRoot);
  if (!selected.some((lib) => lib.documents.length > 0)) return refused(NO_DOCUMENTS_TEXT, "no_documents");
  const addresses = backendAddresses(taskDir);
  if (!addresses.length) return refused(UNREACHABLE_TEXT, "unreachable");

  const send = options.fetch ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? SEARCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let status = 0;
  let body: any = null;
  for (const address of addresses) {
    try {
      const res = await send(address + SEARCH_PATH, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, libraries: selected.map((lib) => lib.id), limit }), signal,
      });
      status = res.status;
      body = await res.json().catch(() => null);
      break;
    } catch {
      // 这个地址连不上（或者到时间没有回答）：试下一个
      if (signal.aborted) break;
    }
  }
  // 助手取消了这次调用：不说成联系不上。
  if (options.signal?.aborted) return refused(CANCELLED_TEXT, "cancelled");
  if (status === 0) return refused(UNREACHABLE_TEXT, "unreachable");
  if (status !== 200 || !body?.ok) {
    const message = typeof body?.error?.message === "string" && body.error.message ? body.error.message : `系统回答了错误（HTTP ${status}）`;
    return refused(failedText(message), typeof body?.error?.code === "string" ? body.error.code : "error");
  }
  const model = typeof body.model === "string" ? body.model : null;
  const hits: Hit[] = Array.isArray(body.hits) ? body.hits : [];
  const keywordOnly = body.mode === "keyword";
  const base = {
    ok: true, ready: body.ready === true, query, limit, model, pending: Number(body.pending) || 0,
    mode: typeof body.mode === "string" ? body.mode : "hybrid", reason: typeof body.reason === "string" ? body.reason : null,
    uncovered_semantic: Array.isArray(body.uncovered_semantic) ? body.uncovered_semantic : [], uncovered: Array.isArray(body.uncovered) ? body.uncovered : [],
    // 取结果之前考虑过的片段，原样留在结果里：评估用（agent/eval/knowledge）。
    candidates: body.candidates && typeof body.candidates === "object" ? body.candidates : { semantic: [], keyword: [] },
  };
  const opening = openingText(query, body, selected.length);
  if (!hits.length) return { text: `${opening}\n${NOT_FOUND_TEXT}`, details: { ...base, hits: [], shown: 0, bytes: bytesOf(`${opening}\n${NOT_FOUND_TEXT}`), truncated_chars: null } };
  const done = assemble(`${opening}下面是最相关的 ${hits.length} 个片段。排在前面不等于就是你要找的规定：逐个看正文，对得上的才引用；一个片段里有多条规定时逐条看。`, hits, keywordOnly);
  // 结构化的那一份不带片段的文字与原文；shown 是这一次实际列给助手的个数（排在前面的那几个）。
  const brief = hits.map(({ text: _text, body: _body, paragraphs: _paragraphs, table: _table, header: _header, ...rest }) => rest);
  return { text: done.text, details: { ...base, hits: brief, shown: done.shown, bytes: bytesOf(done.text), truncated_chars: done.truncated_chars } };
}
