// 发布过的版本在页面上怎样读：最近一版、哪些条目与图在它之后改过（「第 N 版后有改动」）、发布的提示条该不该出现、版本表每行写什么。
// 数据都随整份数据来（task.versions，与任务状况里的 versions 相同）；条目与业务说明的页在同一条修订序列上，比修订号；
// 图的修订号各算各的，比改动的时刻与发布的时刻。只算，不画。

import { documentBlocks } from "../../../agent/src/lib/document_blocks.ts";
import type { DiagramRow, Item, Task, VersionView } from "../api/types";
import { shortMoment } from "./taskStatus";

/** 最近发布的一版；还没有发布过是 null。 */
export function latestVersion(task: Pick<Task, "versions"> | null | undefined): VersionView | null {
  const list = task?.versions ?? [];
  return list.length ? list.reduce((a, b) => (b.version_no > a.version_no ? b : a)) : null;
}

/** 这个条目（或业务说明的一页）在最近一版之后改过没有：它现在的修订号大于那一版发布时的修订号。还没有发布过时不算。 */
export function changedAfter(version: VersionView | null, item: Pick<Item, "revision_no">): boolean {
  return version !== null && item.revision_no > version.revision_no;
}

/** 这张图在最近一版之后改过没有：图的修订号各算各的，比改动的时刻与发布的时刻。 */
export function diagramChangedAfter(version: VersionView | null, diagram: Pick<DiagramRow, "revision_at">): boolean {
  if (version === null || !version.published_at || !diagram.revision_at) return false;
  return Date.parse(diagram.revision_at) > Date.parse(version.published_at);
}

/** 最近一版之后改过的条目、页与图（各按编号）；还没有发布过时都是空的。 */
export function changesAfter(task: Task): { version: VersionView | null; items: Item[]; diagrams: DiagramRow[] } {
  const version = latestVersion(task);
  const byId = (a: { item_id?: string; diagram_id?: string }, b: { item_id?: string; diagram_id?: string }) =>
    String(a.item_id ?? a.diagram_id).localeCompare(String(b.item_id ?? b.diagram_id), undefined, { numeric: true });
  return {
    version,
    items: task.items.filter((one) => changedAfter(version, one)).sort(byId),
    diagrams: (task.diagrams ?? []).filter((one) => diagramChangedAfter(version, one)).sort(byId),
  };
}

/** 一份生成的文档里用到的图（每张只取一次），给页面画成 PNG 随发布或「下载 Word」交给任务服务。 */
export function figuresOf(markdown: string): { diagram_id: string; mermaid: string }[] {
  const seen = new Set<string>();
  return documentBlocks(markdown).flatMap((block) => (block.kind === "figure" && block.diagram_id && !seen.has(block.diagram_id) && seen.add(block.diagram_id)
    ? [{ diagram_id: block.diagram_id, mermaid: block.mermaid }] : []));
}

/** 条目徽标上的字。 */
export const changedBadge = (versionNo: number): string => `第 ${versionNo} 版后有改动`;

/** 条目区顶部那一行：「有 3 处改动在第 1 版之后」；没有改动、没有发布过时是 null。 */
export function changesLine(task: Task): string | null {
  const { version, items, diagrams } = changesAfter(task);
  const n = items.length + diagrams.length;
  return version && n > 0 ? `有 ${n} 处改动在第 ${version.version_no} 版之后` : null;
}

/** 下一版是第几版。 */
export const nextVersionNo = (task: Pick<Task, "versions">): number => (latestVersion(task)?.version_no ?? 0) + 1;

/**
 * 有没有东西可以发布成新的一版：还没有发布过；或者交付物在最近一版之后又有了修订（删掉条目也算）、图又改过。
 * 刚发布完、什么都没改时没有，发布的提示条不出现。
 */
export function somethingToPublish(task: Task): boolean {
  const version = latestVersion(task);
  if (!version) return true;
  if ((task.latest_revision ?? 0) > version.revision_no) return true;
  return (task.diagrams ?? []).some((one) => diagramChangedAfter(version, one));
}

/** 版本表一行的小字：「10-12 09:30 · 你发布的」（发布时的修订号另写成可点的一项）。 */
export function versionMeta(version: VersionView): string {
  return [version.published_at ? shortMoment(version.published_at) : "", version.actor === "user" ? "你发布的" : "助手发布的"].filter(Boolean).join(" · ");
}

/**
 * Word 存档里的图是什么样子：文档里有几张图、其中几张是图片，照实写；一张图都没有、没有 Word 存档时不写（null）。
 * 例：「Word 里 3 张图都是图片」「Word 里 3 张图是 Mermaid 文本」「Word 里 3 张图有 1 张是 Mermaid 文本」。
 */
export function figuresText(version: VersionView): string | null {
  const count = version.figure_count;
  if (!version.has_docx || !count) return null;
  const pictures = version.figure_pictures ?? 0;
  if (pictures >= count) return `Word 里 ${count} 张图都是图片`;
  if (pictures === 0) return `Word 里 ${count} 张图是 Mermaid 文本`;
  return `Word 里 ${count} 张图有 ${count - pictures} 张是 Mermaid 文本`;
}

/** 一版没有某种存档时下载按钮旁的说明。 */
export function missingArchiveText(version: VersionView): string {
  return version.has_markdown || version.has_docx ? "这一种没有存下来" : "这一版是升级之前完成的，当时的文档没有存下来";
}
