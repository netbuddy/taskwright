/**
 * 一轮里连续被拒的上限：自用户最近一句话起，助手连续被拒到第 REJECTION_LIMIT 次，就停下这次运行。
 *
 * 为什么要它：工具拒绝之后模型会再试，没有任何东西限制它试几次。「回复」因为形式不对被拒有放行规则（lib/reply.ts 的
 * decideReply：第 3 次起只要成文正文，第 5 次放行纯文字回复），但「这一轮还没有写理解」这道门（lib/dialogue_acts.ts 的
 * requireUnderstanding）排在它前面，理解是留痕的根据，不能放行；模型要是一直不写理解、或者写的一直不合格，就会一直转下去，
 * 每一圈都是一次模型请求。
 *
 * 数什么（consecutiveRefusals，从会话当前分支的末尾往回数）：
 * - 「回复」的每一次被拒，不论原因：没有写理解、理解不合格、形式不对；
 * - 「保存修订」「完成任务」因为没有合格的理解而被拒（它们过的是同一道门）；这两个工具因为输入不合规被拒不算，
 *   那是正常的改正过程。
 * 数到哪里为止：一条用户消息（兜底扩展追加的那句固定的话不算，兜底之后的续跑仍是同一轮），或者这三个工具里任何一个
 * 做成了的一次。别的工具调用不打断。
 *
 * 到了上限怎么停（stopAtLimit）：这一次仍要被拒、而且是连续的第 REJECTION_LIMIT 次时，工具不再抛异常，改为返回一个
 * 「出错并结束本次运行」的结果（isError 与 terminate 都为真）：模型看到的仍是一次出错的结果，但 pi 跑完这一批工具就结束
 * 这次运行，不再请求模型。结果的 details 带 stopped: true，后端据此把这一轮的结局记成「连续被拒到上限，已经停下」并告诉用户，
 * 兜底扩展据此不再追加那句话。能放行的那种（形式不对的第 5 次）在此之前已经放行，走不到这里。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { FALLBACK_TEXT } from "../hooks/reply_fallback.ts";
import { GATE_MISSING_TEXT, INTENT_GATE_TEXT } from "./intent_schema.ts";
import { REPLY_TOOL_NAME } from "./reply.ts";
import { ToolRejection } from "./tool_rejection.ts";

/** 连续被拒到第几次就停下这次运行。 */
export const REJECTION_LIMIT = 5;

/** 与「回复」过同一道「先写理解」的门的另外两个工具。 */
export const GATED_TOOL_NAMES: readonly string[] = ["save_revision", "complete_task"];

/** 停下时接在拒绝原因后面的那句话。模型此后不会再被请求，这句话留在会话记录里给人看。 */
export const STOPPED_TEXT = `这一轮已经连续 ${REJECTION_LIMIT} 次没有按规矩回答，这次运行到此停下。`;

/** 停下这件事经状态栏报给后端用的键名（后端补记，观测台看得到）。 */
export const STOPPED_STATUS_KEY = "taskwright-reply-stopped";

/** 一次拒绝是哪一种：没有写理解、理解写得不合格，或者别的（回复的形式不对）。 */
export type RefusalKind = "understanding_missing" | "understanding_invalid" | "form";

/** 按拒绝的文字认它是哪一种。 */
export function refusalKind(text: string): RefusalKind {
  if (!text.includes(INTENT_GATE_TEXT)) return "form";
  return text.includes(GATE_MISSING_TEXT) ? "understanding_missing" : "understanding_invalid";
}

type BranchEntry = { type: string; message?: { role?: string; toolName?: string; isError?: boolean; content?: unknown } };

function textOfContent(content: unknown): string {
  return typeof content === "string"
    ? content
    : (Array.isArray(content) ? content : []).map((part: any) => (part?.type === "text" ? part.text : "")).join("");
}

/** 自用户最近一句话起，助手已经连续被拒了几次（数法见文件开头）。 */
export function consecutiveRefusals(branch: BranchEntry[]): number {
  let count = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || !entry.message) continue;
    const { role, toolName } = entry.message;
    if (role === "toolResult" && toolName === REPLY_TOOL_NAME) {
      if (entry.message.isError !== true) break;
      count += 1;
    } else if (role === "toolResult" && GATED_TOOL_NAMES.includes(toolName ?? "")) {
      if (entry.message.isError !== true) break;
      if (textOfContent(entry.message.content).includes(INTENT_GATE_TEXT)) count += 1;
    } else if (role === "user") {
      if (textOfContent(entry.message.content).trim() !== FALLBACK_TEXT) break;
    }
  }
  return count;
}

/** 这个异常是不是「先写理解」那道门的拒绝。 */
export function isUnderstandingGate(error: unknown): boolean {
  return error instanceof ToolRejection && error.reasonKind === "gate" && error.message.includes(INTENT_GATE_TEXT);
}

/** 「出错并结束本次运行」的工具结果。 */
export interface StoppedResult {
  content: { type: "text"; text: string }[];
  details: { stopped: true; rejections: number; reason_kind: RefusalKind };
  isError: true;
  terminate: true;
}

/**
 * 这一次被拒是不是到了上限。error 是工具这一次要抛出的异常；branch 是会话当前分支（不含这一次的结果）；
 * counts 为假表示这一次拒绝不算数（保存修订、完成任务因为输入不合规被拒）。到了上限返回要交还的结果，没到返回 null（照常抛异常）。
 */
export function stopAtLimit(error: unknown, branch: BranchEntry[], counts = true): StoppedResult | null {
  if (!counts) return null;
  const rejections = consecutiveRefusals(branch) + 1;
  if (rejections < REJECTION_LIMIT) return null;
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `${message}\n${STOPPED_TEXT}` }],
    details: { stopped: true, rejections, reason_kind: refusalKind(message) },
    isError: true,
    terminate: true,
  };
}

const KIND_NAMES: Record<RefusalKind, string> = { understanding_missing: "没有写理解", understanding_invalid: "理解写得不合格", form: "回复的形式不对" };

/** 经状态栏报一行「已经停下」的事实。ui 是扩展上下文的 ui；出错不影响停下。 */
export function reportStopped(ui: { setStatus: (key: string, text: string) => void } | undefined, toolName: string, result: StoppedResult): void {
  try {
    ui?.setStatus(STOPPED_STATUS_KEY, JSON.stringify({
      结果: `这一轮连续被拒 ${result.details.rejections} 次，已经停下这次运行`, 工具: toolName,
      最后一次的原因: KIND_NAMES[result.details.reason_kind], 时刻: Date.now(),
    }));
  } catch {
    // 报不出去不影响停下
  }
}

/** 一次运行是不是以「连续被拒到上限，已经停下」的工具结果收尾（兜底扩展据此不再追加那句话）。 */
export function endedStopped(messages: { role?: string; details?: unknown }[]): boolean {
  const last = messages[messages.length - 1];
  return last?.role === "toolResult" && (last.details as { stopped?: unknown } | undefined)?.stopped === true;
}
