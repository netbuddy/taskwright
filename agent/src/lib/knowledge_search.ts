/**
 * 「按意思查找知识库」工具（search_knowledge）的核心逻辑：在这个任务选用的知识库里找与一句话意思最相近的几个片段。
 *
 * 比远近不在这里算。要把那句话换算成数字串得调嵌入模型，模型服务的地址与密钥只在任务服务那一边；所以这里把要找的话与
 * 任务选用的知识库的编号发给任务服务的查找接口（POST /api/v1/knowledge/search），拿回最相近的片段，排成给助手看的文字。
 *
 * 任务服务在哪里：它接手一个任务时在任务目录里写一份占用标记 service.lock，里面有它监听的端口与所在主机的名字。
 * 助手是任务服务在同一台机器上起的，所以先连本机回环地址上的那个端口；连不上时再按标记里的主机名连一次
 * （任务服务只绑在某一块网卡上时，回环地址连不上）。两处都连不上，或者没有这份标记（不经任务服务直接起的助手），就说这一次没有做成。
 *
 * 这个工具从不让助手停下：知识库的文档还没有换算好、没有选嵌入模型、任务服务联系不上、模型服务出错，都回一句话说明原因与
 * 接下来怎么办；只有参数写错时抛异常（异常文字由 pi 交还模型）。还不能查（没有换算好、没有选嵌入模型）时请助手告诉用户去处理；
 * 这一次没有做成（联系不上、模型服务出错）时请它再查一次，仍然不成就告诉用户并记问题条目。哪一种都不请它改用 grep：
 * 知识库目录对 grep、find、ls 是关着的（lib/knowledge_gate.ts），查知识库只有这一个办法。
 *
 * 给助手的每个片段写着到哪里读原文（路径与行号）。Word 文档的片段存的是起止段落号，行号在这里现找：读由它生成的那份文字，
 * 找这两个段落号所在的行。引用时出处的写法不变：Word 文档要写摘录所在那一段的段落号，所以只告诉助手怎样写，不替它写一个段落号。
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
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 10;
/** 等任务服务回答最多等多久：它换算要找的那句话最多等模型服务 60 秒。 */
export const SEARCH_TIMEOUT_MS = 70_000;

/** 这一次没有做成时接在原因后面的话。 */
export const RETRY_TEXT = "可以再查一次；仍然不成时把这个原因告诉用户，这一处先保留材料的原话并记一条问题条目。";
export const NO_KNOWLEDGE_TEXT = "这个任务没有知识库，没有可查的。";
export const NO_DOCUMENTS_TEXT = "这个任务选用的知识库里没有文档，没有可查的。";
export const NO_CHUNKS_TEXT = "这个任务选用的知识库里的文档没有可比较的文字，没有可查的。";
export const UNREACHABLE_TEXT = `按意思查找这一次没有做成：联系不上系统里负责查找的那一部分。${RETRY_TEXT}`;
export const CLOSING_TEXT = "摘录逐字照抄原文；引用之前按上面给的位置用 read 读原文核对，一次不超过 120 行。";

/** 还有文档没有换算好：任务服务这时一个片段都不给（换算好的那些也不给），所以说整个知识库都还不能查。 */
export const notReadyText = (pending: number) =>
  `这个任务选用的知识库里还有 ${pending} 份文档没有换算好，现在整个知识库都还不能查。请告诉用户到知识库页面点「开始换算」，换算好之后再查。`;
/** 没有选嵌入模型（任务服务以 rejected 拒绝，reason 是它给的那句话）。 */
export const notAvailableText = (reason: string) =>
  `知识库现在还不能查：${reason.replace(/[。.]$/, "")}。请告诉用户到设置里选嵌入模型，再到知识库页面点「开始换算」，换算好之后再查。`;
export const failedText = (reason: string) => `按意思查找这一次没有做成：${reason.replace(/[。.]$/, "")}。${RETRY_TEXT}`;

/** 工具的返回：给模型的一段文字，给读取一侧的结构化内容。 */
export interface SearchOutcome {
  text: string;
  details: Record<string, unknown>;
}

/** 任务服务回的一个片段（backend/src/knowledge_search.ts 的 SearchHit）。 */
interface Hit {
  score: number;
  library: string;
  library_name: string;
  name: string;
  title: string | null;
  first_paragraph: number | null;
  last_paragraph: number | null;
  first_line: number | null;
  last_line: number | null;
  text: string;
  locator: string;
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

/** 由 Word 文档生成的那份文字里，第 first 段与第 last 段各在第几行（从 1 起）；读不到或找不到时是 null。 */
function paragraphLines(path: string, first: number, last: number): [number, number] | null {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf-8").split(/\r?\n/);
  } catch {
    return null;
  }
  const lineOf = (n: number) => lines.findIndex((line) => line.includes(`[p${n}]`)) + 1;
  const from = lineOf(first);
  const to = lineOf(last);
  return from > 0 && to >= from ? [from, to] : null;
}

const range = (from: number, to: number, unit: string) => (from === to ? `第 ${from} ${unit}` : `第 ${from} 到 ${to} ${unit}`);

/** 一个片段排成给助手看的几行。readPath 是助手读原文用的路径。 */
function hitLines(no: number, hit: Hit, readPath: string): string[] {
  const head = `${no}. 相近程度 ${hit.score.toFixed(2)} · 知识库「${hit.library_name}」《${hit.name}》${hit.title ? ` · 片段标题：${hit.title}` : ""}`;
  let where: string;
  let cite: string;
  if (hit.first_paragraph !== null && hit.last_paragraph !== null) {
    const paragraphs = range(hit.first_paragraph, hit.last_paragraph, "段");
    const found = paragraphLines(readPath, hit.first_paragraph, hit.last_paragraph);
    where = found ? `读原文：${readPath} ${range(found[0], found[1], "行")}（${paragraphs}）` : `读原文：${readPath}，${paragraphs}（每段前面方括号里的 p 加数字是段落号）`;
    cite = `引用时出处写：${hit.locator}#p 加段落号，段落号是原文里摘录所在那一段前面方括号中的数字`;
  } else {
    where = hit.first_line !== null && hit.last_line !== null ? `读原文：${readPath} ${range(hit.first_line, hit.last_line, "行")}` : `读原文：${readPath}`;
    cite = `引用时出处写：${hit.locator}`;
  }
  return [head, `   ${where}`, `   ${cite}`, "   正文：", ...hit.text.split("\n").map((line) => `   ${line}`)];
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
  if (status === 0) return refused(UNREACHABLE_TEXT, "unreachable");
  if (status !== 200 || !body?.ok) {
    const message = typeof body?.error?.message === "string" && body.error.message ? body.error.message : `系统回答了错误（HTTP ${status}）`;
    const code = typeof body?.error?.code === "string" ? body.error.code : "error";
    // 没有选嵌入模型：这不是这一次的事，是现在还不能用。
    return refused(code === "rejected" ? notAvailableText(message) : failedText(message), code);
  }
  const model = typeof body.model === "string" ? body.model : null;
  if (!body.ready) {
    const pending = Number(body.pending) || 0;
    return { text: notReadyText(pending), details: { ok: true, ready: false, query, limit, model, pending, hits: [] } };
  }
  const hits: Hit[] = Array.isArray(body.hits) ? body.hits : [];
  const details = {
    ok: true, ready: true, query, limit, model, pending: 0,
    hits: hits.map(({ text: _, ...rest }) => rest),
  };
  if (!hits.length) return { text: NO_CHUNKS_TEXT, details };

  const readPathOf = (hit: Hit) => {
    const known = selected.find((lib) => lib.id === hit.library)?.documents.find((doc) => doc.name === hit.name)?.readPath;
    return known ?? join(knowledgeRoot, hit.library, "files", /\.docx$/i.test(hit.name) ? `${hit.name}.md` : hit.name);
  };
  const lines = [
    `按意思查找「${query}」：在这个任务选用的 ${Number(body.libraries) || selected.length} 个知识库、${Number(body.chunks) || hits.length} 个片段里，最相近的 ${hits.length} 个如下。` +
      "相近程度最大是 1，越大越相近；它只说明意思相近，不说明这就是你要找的规定。",
    "",
  ];
  hits.forEach((hit, i) => lines.push(...hitLines(i + 1, hit, readPathOf(hit)), ""));
  lines.push(CLOSING_TEXT);
  return { text: lines.join("\n"), details };
}
