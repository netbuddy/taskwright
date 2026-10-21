/**
 * 活动补充分段之后，非常驻的那几段怎样交给助手（分段的写法见 lib/activity_def.ts）：附在工具做成的结果正文后面。
 * after_save 附在这条会话第一次保存修订做成的结果后面，after_reply 附在第一次回复做成的结果后面；同一段一条会话只附一次。
 * 附过没有看会话分支上的工具结果里有没有这一段的分段记号，不靠助手记；会话压缩过的，只看压缩后还留在上下文里的那一截
 * （从最近一次压缩的 firstKeptEntryId 起），找不到就再附一次，免得规则随压缩丢掉。
 * 附上的文字是：一行分段记号（segmentMark）、一句说明（模板 result.activity_segment）、那一段的正文。观测台按分段记号把它与工具本身的结果分开。
 */

import type { SegmentTiming } from "./activity_def.ts";
import { fillText } from "./texts.ts";

/** 附上的那一段前面的分段记号，一行。 */
export function segmentMark(timing: SegmentTiming): string {
  return `<!-- activity-segment: ${timing} -->`;
}

/** 认分段记号的写法：把工具结果拆成工具本身的结果与附上的那一段时用。 */
export const SEGMENT_MARK_PATTERN = /\n*<!-- activity-segment: ([a-z_]+) -->\n/;

type Entry = { id?: string; type: string; firstKeptEntryId?: string; message?: { role?: string; content?: unknown } };

/** 会话分支上还在上下文里的那一截：最近一次压缩之后（从它留下的第一条起）；没有压缩过就是全部。 */
function inContext(branch: readonly Entry[]): readonly Entry[] {
  const at = branch.map((one) => one.type).lastIndexOf("compaction");
  if (at < 0) return branch;
  const kept = branch.findIndex((one) => one.id !== undefined && one.id === branch[at].firstKeptEntryId);
  return branch.slice(kept >= 0 && kept < at ? kept : at + 1);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
}

/** 这一段在还留在上下文里的工具结果里附过没有。 */
export function segmentAttached(branch: readonly Entry[], timing: SegmentTiming): boolean {
  const mark = segmentMark(timing);
  return inContext(branch).some((one) => one.type === "message" && one.message?.role === "toolResult" && textOf(one.message.content).includes(mark));
}

/**
 * 工具做成的结果正文，必要时在后面附上这一段。segment 是取那一段正文的函数（没有这一段时返回 null）：附过了就不调它。
 * 取的时候出错（例如活动文件改坏了）不附，结果照旧；拼系统提示的那一边会把错报出来。
 */
export function withSegment(text: string, timing: SegmentTiming, branch: readonly Entry[], segment: () => string | null): string {
  if (segmentAttached(branch, timing)) return text;
  let body: string | null;
  try {
    body = segment();
  } catch {
    return text;
  }
  return body ? `${text}\n\n${segmentMark(timing)}\n${fillText("result.activity_segment")}\n\n${body}` : text;
}
