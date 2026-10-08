/**
 * 知识库目录对自带的搜索与列目录工具关门：助手查知识库只经按意思查找（search_knowledge）。grep、find、ls 要搜或要看的范围
 * 包含知识库目录时，这次调用不执行，助手拿到一句话，告诉它改用 search_knowledge。read 不在这里管。
 *
 * 「包含」两个方向都算：范围就是知识库目录、范围在知识库目录之下（它的某个知识库、某份文档），或者知识库目录在范围之下
 * （范围是知识库目录的上级）。范围按自带工具的办法解析：不写就是任务目录；开头的 @ 去掉；`~` 展开成用户主目录；相对路径接在
 * 任务目录后面。解析之后两边都换成真实路径再比，免得经一个指向知识库目录的符号链接绕过去。自带的搜索工具不会跟着范围里面的
 * 符号链接走进别的目录，所以只看范围本身指到哪里。
 *
 * 没有知识库根目录（不经任务服务直接起的助手、单元测试）时什么都不拦。
 *
 * 本模块不依赖 pi，单元测试可以直接调用；订阅工具调用事件的接线在 hooks/knowledge_gate.ts。
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** 归这里管的工具：自带的搜索与列目录工具。 */
export const GATED_TOOLS: readonly string[] = ["grep", "find", "ls"];

/** 拦下一次调用这件事经状态栏报给后端用的键名（记在助手输出的归档里，观测台看得到）。 */
export const BLOCKED_STATUS_KEY = "taskwright-knowledge-blocked";

/** 拦下时交还助手的那句话。 */
export const blockedText = (toolName: string) =>
  `知识库请用 search_knowledge：${toolName} 不能用于知识库目录（搜索范围包含知识库目录时也一样）。材料目录照常可以用 ${toolName}。`;

/** 一条路径的真实路径；它不存在（或者读不到）时照原样返回。 */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 工具收到的 path 指到哪里：解析办法与自带工具相同，再换成真实路径。不写（或者不是文字）就是任务目录。 */
export function scopeOf(cwd: string, path: unknown, home: string = homedir()): string {
  let given = typeof path === "string" && path ? path : ".";
  if (given.startsWith("@")) given = given.slice(1);
  if (given === "~") given = home;
  else if (given.startsWith("~/")) given = join(home, given.slice(2));
  return real(isAbsolute(given) ? resolve(given) : resolve(cwd, given));
}

/** below 是不是 above 本身或者在它之下。 */
const within = (below: string, above: string) => below === above || below.startsWith(above.endsWith(sep) ? above : above + sep);

/** 范围是不是包含知识库目录：两个方向都算。两个参数都要是解析好的绝对路径。 */
export function coversKnowledge(scope: string, knowledgeRoot: string): boolean {
  return within(scope, knowledgeRoot) || within(knowledgeRoot, scope);
}

export interface Blocked {
  /** 交还助手的那句话。 */
  reason: string;
  /** 这次调用要搜或要看的范围（解析之后的绝对路径），留痕用。 */
  scope: string;
}

/**
 * 这次工具调用该不该拦。该拦时返回交还助手的话与范围；不该拦返回 null。
 * knowledgeRoot 是知识库根目录，没有知识库时为 null（什么都不拦）。
 */
export function blockedCall(
  toolName: string, input: { path?: unknown } | null | undefined, cwd: string, knowledgeRoot: string | null, home: string = homedir(),
): Blocked | null {
  if (!knowledgeRoot || !GATED_TOOLS.includes(toolName)) return null;
  const scope = scopeOf(cwd, input?.path, home);
  if (!coversKnowledge(scope, real(resolve(knowledgeRoot)))) return null;
  return { reason: blockedText(toolName), scope };
}

/** 经状态栏报一行「拦下了一次调用」的事实。ui 是扩展上下文的 ui；报不出去不影响拦下。 */
export function reportBlocked(ui: { setStatus: (key: string, text: string) => void } | undefined, toolName: string, blocked: Blocked): void {
  try {
    ui?.setStatus(BLOCKED_STATUS_KEY, JSON.stringify({ 结果: "搜索范围包含知识库目录，已经拦下", 工具: toolName, 搜索范围: blocked.scope, 时刻: Date.now() }));
  } catch {
    // 报不出去不影响拦下
  }
}
