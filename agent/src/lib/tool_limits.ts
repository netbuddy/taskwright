/**
 * 给自带的两个工具的返回定量，免得一次调用把上下文占满：
 *
 * - grep：返回超过 GREP_MAX_LINES 行或 GREP_MAX_BYTES 字节时截短，只留前面的若干行，末尾加一句请助手换更具体的词或者分次搜。
 *   不分搜的是材料还是知识库：危害来自搜得多宽、返回多少，不来自在哪里搜。没有超过的返回一个字都不动。
 *   行按 grep 的返回数：命中的行与 context 带出来的行都算；末尾方括号里的提示（达到条数上限之类）不算行，截短时去掉。
 * - read：读的是知识库目录下的文件、而助手没有写要读几行时，按 KNOWLEDGE_READ_LINES 行读（改参数，不拦）。知识库的文档可以有
 *   几十 KB，助手查知识库该用 search_knowledge；这只是它偶尔直接去读时的保险。材料的 read 不动：材料按块读的办法写在说明里。
 *
 * 不拦任何调用。知识库根目录由环境变量给（lib/knowledge.ts）；没有时 read 不改。
 *
 * 本模块不依赖 pi，单元测试可以直接调用；订阅工具事件的接线在 hooks/tool_limits.ts。
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** grep 的返回最多留几行、最多多少字节（连同末尾加的那句话）。 */
export const GREP_MAX_LINES = 40;
export const GREP_MAX_BYTES = 6144;
/** 读知识库目录下的文件、没有写要读几行时按几行读。 */
export const KNOWLEDGE_READ_LINES = 120;

/** grep 的返回被截短这件事经状态栏报给后端用的键名（记在助手输出的归档里，观测台看得到）。 */
export const GREP_CAPPED_STATUS_KEY = "taskwright-grep-capped";

/** 截短之后加在末尾的那句话。 */
export const cappedText = (shown: number) => `命中太多，只显示了前 ${shown} 行；换更具体的词，或者分次搜。`;

const bytesOf = (text: string) => Buffer.byteLength(text, "utf-8");

/** grep 的返回截短的结果：新的文字，与原来、现在各有几行几个字节。 */
export interface Capped {
  text: string;
  total_lines: number;
  shown_lines: number;
  total_bytes: number;
  shown_bytes: number;
}

/**
 * grep 的返回要不要截短。没有超过限量时返回 null（原样不动）；超过时返回截短之后的文字与前后的行数、字节数。
 * 留前 GREP_MAX_LINES 行，再按整行减到连同末尾那句话不超过 GREP_MAX_BYTES 字节；连第一行都放不下时把第一行截短。
 */
export function capGrep(text: string, maxLines: number = GREP_MAX_LINES, maxBytes: number = GREP_MAX_BYTES): Capped | null {
  // 末尾另起一段的方括号提示不是 grep 的行。
  const notice = /\n\n\[[^\n]*\]$/.exec(text);
  const lines = (notice ? text.slice(0, notice.index) : text).split("\n");
  if (lines.length <= maxLines && bytesOf(text) <= maxBytes) return null;
  let kept = lines.slice(0, maxLines);
  const render = () => `${kept.join("\n")}\n\n${cappedText(kept.length)}`;
  while (kept.length > 1 && bytesOf(render()) > maxBytes) kept = kept.slice(0, -1);
  if (bytesOf(render()) > maxBytes) {
    const chars = Array.from(kept[0]);
    while (chars.length > 0 && bytesOf(`${chars.join("")}\n\n${cappedText(1)}`) > maxBytes) chars.pop();
    kept = [chars.join("")];
  }
  const out = render();
  return { text: out, total_lines: lines.length, shown_lines: kept.length, total_bytes: bytesOf(text), shown_bytes: bytesOf(out) };
}

/** 一条路径的真实路径；它不存在（或者读不到）时照原样返回。 */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 工具收到的 path 指到哪里：解析办法与自带工具相同（开头的 @ 去掉，~ 展开，相对路径接在任务目录后面），再换成真实路径。 */
export function resolvedPath(cwd: string, path: unknown, home: string = homedir()): string | null {
  if (typeof path !== "string" || !path) return null;
  let given = path.startsWith("@") ? path.slice(1) : path;
  if (given === "~") given = home;
  else if (given.startsWith("~/")) given = join(home, given.slice(2));
  return real(isAbsolute(given) ? resolve(given) : resolve(cwd, given));
}

/**
 * 这次 read 要不要补上要读几行：读的是知识库根目录之下的文件、参数里没有写 limit 时返回 KNOWLEDGE_READ_LINES，别的时候返回 null。
 * 两边都按真实路径比，经符号链接指到知识库里的文件也算。knowledgeRoot 为 null（没有知识库）时不补。
 */
export function knowledgeReadLimit(input: { path?: unknown; limit?: unknown } | null | undefined, cwd: string, knowledgeRoot: string | null, home: string = homedir()): number | null {
  if (!knowledgeRoot || !input || (input.limit !== undefined && input.limit !== null)) return null;
  const target = resolvedPath(cwd, input.path, home);
  if (target === null) return null;
  const root = real(resolve(knowledgeRoot));
  return target.startsWith(root.endsWith(sep) ? root : root + sep) ? KNOWLEDGE_READ_LINES : null;
}

/** 经状态栏报一行「grep 的返回截短了」的事实。ui 是扩展上下文的 ui；报不出去不影响截短。 */
export function reportCapped(ui: { setStatus: (key: string, text: string) => void } | undefined, capped: Capped): void {
  try {
    ui?.setStatus(GREP_CAPPED_STATUS_KEY, JSON.stringify({
      结果: "grep 的返回超过了限量，已经截短", 原来几行: capped.total_lines, 显示几行: capped.shown_lines,
      原来字节: capped.total_bytes, 显示字节: capped.shown_bytes, 时刻: Date.now(),
    }));
  } catch {
    // 报不出去不影响截短
  }
}
