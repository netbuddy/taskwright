// 图表页签里几处文字的算法：列表里「最近修订」一栏、详情顶上那一句、图里画了谁的说明、改图没有保存成时的话。

import type { ApiError } from "../api/client";
import type { DiagramRow, DrawnItem } from "../api/types";
import { errorText } from "../components/work/errors";
import { formatTime } from "./format";

/** 一张图都没有时的引导。 */
export const DIAGRAMS_EMPTY_TEXT = "在对话里让助手画一张图，例如『把这几个用例画成用例图』";
/** 文本有没保存的改动时，「导出 PNG」灰掉的原因。 */
export const EXPORT_NEEDS_SAVE_TEXT = "文本有没保存的改动，先保存或者放弃改动再导出。";
/** 改图时右边那张图上方的提示。 */
export const PREVIEW_TEXT = "预览：改动还没有保存";
/** 图的文本里一个条目编号都没有时的话。 */
export const NOTHING_DRAWN_TEXT = "这张图的文本里没有写条目编号。";
/** 详情开着的时候这张图被删了。 */
export const DIAGRAM_DELETED_TEXT = "这张图已经删除。";

/** 谁改的：助手或者用户。 */
export const byName = (by: string): string => (by === "user" ? "用户" : "助手");

/** 列表里「最近修订」一栏：修订 2 · 助手 · 10-08 14:03（今年之内不写年份）。 */
export function revisionText(row: Pick<DiagramRow, "revision_no" | "revision_by" | "revision_at">, now: Date = new Date()): string {
  const full = formatTime(row.revision_at);
  const when = full.startsWith(`${now.getFullYear()}-`) ? full.slice(5) : full;
  return `修订 ${row.revision_no} · ${byName(row.revision_by)} · ${when}`;
}

/** 详情顶上那一句：现在是修订几、谁在什么时候改的。修订 1 是画出来的那一次。 */
export function revisionLine(row: Pick<DiagramRow, "revision_no" | "revision_by" | "revision_at">): string {
  const who = row.revision_by === "user" ? "由你改的" : row.revision_no === 1 ? "由助手画的" : "由助手改的";
  return `现在是修订 ${row.revision_no}，${who} · ${formatTime(row.revision_at)}`;
}

/** 图里画的一个条目不可点时写在后面的说明；还在的条目没有说明。 */
export function drawnNote(one: DrawnItem): string | null {
  return one.state === "deleted" ? "已经删除" : one.state === "missing" ? "任务里没有这个条目" : null;
}

/**
 * 改图没有保存成时写在文本框下面的话。校验不过、校验没有做成，任务服务给的话已经是完整的一句；
 * 页面看到的修订号过时了，写明现在是修订几、请放弃改动之后重新改；别的照通用的说法。
 */
export function saveFailedText(diagramId: string, error: ApiError): string {
  if (error.code === "stale_revision") {
    const now = ((error.data.diagrams as { current_revision?: number }[] | undefined) ?? [])[0]?.current_revision;
    return `${diagramId} ${now != null ? `已经被改到修订 ${now}` : "刚被改过"}，你的改动没有保存。点「放弃改动」看现在的内容，再重新改。`;
  }
  if (error.code === "rejected" && error.message) return error.message;
  return `没有保存：${errorText(error)}`;
}
