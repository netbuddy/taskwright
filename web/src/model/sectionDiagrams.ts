// 图放在业务说明的哪里：图不再有自己的页签，长在它说明的那一章、那一节里。这里只算不画。
// 一张图的来源页：把它写成来源的总体分析的页，取自每一页的 depended_by（整份任务数据里就有，不用另取图的详情）。
// 放置规则，按图的种类：
//   · 系统边界图：第 1 章章首。
//   · 用例图：第 2 章章首（渲染成角色与用例对照表，图本身在表下可以展开看）。
//   · 对象关系图：第 4 章章首；另在把它写成来源的每个业务对象节的「与其他对象的关系」里。
//   · 流程图：它的来源页里属于第 3 章的那几节的「流程步骤」。
//   · 状态图：它的来源页里属于第 4 章的那几节的「状态图」。
//   · 时序图与认不出种类的图：它的第一个来源页那一节末尾的「其他图」。
// 流程图的来源里没有第 3 章的页（状态图的来源里没有第 4 章的页）时，也放进它第一个来源页的「其他图」。
// 一条页来源都没有的图（只依据用户的话）哪一节都放不进，另列在「未归入节的图」里；章首的三种图不受这一条限制。
// 同一处有几张图时，最近修订的排在最前（页面显示第一张，其余收在「另有 N 张」里）。

import type { DiagramRow, Item, Task } from "../api/types";
import { diagramGraph } from "../../../agent/src/lib/diagram_scan.ts";
import { type FigureSlot, KIND_CLASS, KIND_CONTEXT, KIND_FLOWCHART, KIND_STATE, KIND_USE_CASE, figureSlot, headChapterOfKind } from "../../../agent/src/lib/overall_figures.ts";
import { CHAPTER_FLOWS, CHAPTER_OBJECTS, CHAPTER_OVERVIEW, CHAPTER_ROLES, type Toc, sectionOf, tocOrder } from "./chapters";
import { SOURCE_FIGURE } from "./items";
import { isOverall } from "./overall";

export { KIND_CLASS, KIND_CONTEXT, KIND_FLOWCHART, KIND_STATE, KIND_USE_CASE };
export type { FigureSlot };
export type SectionFigures = Record<FigureSlot, DiagramRow[]>;

/** 一张图放在哪里：某一章的章首，或者某一节的某一块；哪里都放不进是 loose。 */
export type FigureHome =
  | { where: "chapter"; chapter: number }
  | { where: "section"; itemId: string; slot: FigureSlot }
  | { where: "loose" };

/** 最近修订的在前；修订时刻相同的，编号大的在前。 */
const newestFirst = (a: DiagramRow, b: DiagramRow) =>
  (a.revision_at === b.revision_at ? 0 : a.revision_at < b.revision_at ? 1 : -1) || b.diagram_id.localeCompare(a.diagram_id, "en", { numeric: true });

/** 以这一页为来源的图（还在的），最近修订的在前。 */
export function diagramsOfPage(task: Task, item: Item): DiagramRow[] {
  const ids = new Set((item.depended_by ?? []).filter((one) => one.element_kind === SOURCE_FIGURE).map((one) => one.id));
  return (task.diagrams ?? []).filter((row) => ids.has(row.diagram_id)).sort(newestFirst);
}

/** 一张图的来源页，照目录从上到下的先后（未归类的页排在最后）。 */
export function sourcePages(task: Task, contents: Toc, diagramId: string): Item[] {
  const cites = (item: Item) => (item.depended_by ?? []).some((one) => one.element_kind === SOURCE_FIGURE && one.id === diagramId);
  const order = tocOrder(contents);
  return task.items.filter((item) => isOverall(item.collection) && cites(item))
    .sort((a, b) => order.findIndex((one) => one.item_id === a.item_id) - order.findIndex((one) => one.item_id === b.item_id));
}

/** 一张图在它的一个来源页的节里放进哪一块；不放进这一节是 null。pages 是这张图的全部来源页（sourcePages）。规则见共用的 figureSlot。 */
function slotIn(contents: Toc, row: DiagramRow, page: Item, pages: Item[]): FigureSlot | null {
  const chapterOf = (one: Item): number | null => sectionOf(contents, one.item_id)?.chapter ?? null;
  return figureSlot(row.kind, chapterOf(page), pages.map(chapterOf), pages[0]?.item_id === page.item_id);
}

/** 一节里各块放哪几张图，每块里最近修订的在前。 */
export function sectionFigures(task: Task, contents: Toc, item: Item): SectionFigures {
  const out: SectionFigures = { steps: [], state: [], relations: [], other: [] };
  for (const row of diagramsOfPage(task, item)) {
    const slot = slotIn(contents, row, item, sourcePages(task, contents, row.diagram_id));
    if (slot) out[slot].push(row);
  }
  return out;
}

/** 某一种图在任务里的全部（章首用：系统边界图、用例图、对象关系图），最近修订的在前。 */
export function diagramsOfKind(task: Task, kind: string): DiagramRow[] {
  return (task.diagrams ?? []).filter((row) => row.kind === kind).sort(newestFirst);
}

/** 一张图放在哪里（地址里带着图的编号时照它打开）；任务里没有这张图是 null。对象关系图以章首为准。 */
export function figureHome(task: Task, contents: Toc, diagramId: string): FigureHome | null {
  const row = (task.diagrams ?? []).find((one) => one.diagram_id === diagramId);
  if (!row) return null;
  const head = headChapterOfKind(row.kind);
  if (head !== null) return { where: "chapter", chapter: head };
  const pages = sourcePages(task, contents, diagramId);
  for (const page of pages) {
    const slot = slotIn(contents, row, page, pages);
    if (slot) return { where: "section", itemId: page.item_id, slot };
  }
  return { where: "loose" };
}

/** 哪一节都放不进的图：不是章首的三种，又一条页来源都没有。最近修订的在前。 */
export function looseDiagrams(task: Task, contents: Toc): DiagramRow[] {
  return (task.diagrams ?? []).filter((row) => figureHome(task, contents, row.diagram_id)?.where === "loose").sort(newestFirst);
}

/** 任务里第一处有图的地方（地址里只说「看图」时停在这里）：有系统边界图是第 1 章章首，否则照目录从上到下找；一张图都没有是 null。 */
export function firstFigureHome(task: Task, contents: Toc): FigureHome | null {
  const rows = task.diagrams ?? [];
  if (rows.length === 0) return null;
  for (const chapter of [CHAPTER_OVERVIEW, CHAPTER_ROLES]) {
    if (rows.some((row) => figureHome(task, contents, row.diagram_id)?.where === "chapter" && (figureHome(task, contents, row.diagram_id) as { chapter: number }).chapter === chapter)) {
      return { where: "chapter", chapter };
    }
  }
  for (const page of tocOrder(contents)) {
    const figures = sectionFigures(task, contents, page);
    const slot = (["steps", "relations", "state", "other"] as FigureSlot[]).find((one) => figures[one].length > 0);
    // 对象关系图以章首为准：只有它的节，先看章首。
    if (slot === "relations" && figures.steps.length + figures.state.length + figures.other.length === 0) return { where: "chapter", chapter: CHAPTER_OBJECTS };
    if (slot) return { where: "section", itemId: page.item_id, slot };
  }
  if (rows.some((row) => row.kind === KIND_CLASS)) return { where: "chapter", chapter: CHAPTER_OBJECTS };
  return { where: "loose" };
}

/** 任务定义里各集合的编号前缀（认图的节点文字里写的条目编号要用）。 */
export const prefixesOf = (task: Task): string[] => task.definition.collections.map((one) => one.prefix);

/** 对象关系图里代表这一页的那几个类的名字：节点文字里写着这一页的编号的类。 */
export function classNamesOf(mermaid: string, task: Task, itemId: string): string[] {
  return diagramGraph(mermaid, prefixesOf(task)).nodes.filter((node) => node.items.includes(itemId)).map((node) => node.name);
}

/** 标出本节对象时用的边框颜色与粗细（Mermaid 的 style 语句）。 */
export const CLASS_MARK_STYLE = "stroke:#2563eb,stroke-width:3px";

/**
 * 在对象关系图的文本后面添几行 style 语句，把这几个类的边框加粗（只影响画出来的样子，不改库里的文本）。
 * 一个类都没有、或者文本不是类图写法时原样返回。
 */
export function markClasses(mermaid: string, names: readonly string[]): string {
  if (names.length === 0 || !/^\s*classDiagram\b/m.test(mermaid)) return mermaid;
  return `${mermaid.replace(/\s+$/, "")}\n${names.map((name) => `  style ${name} ${CLASS_MARK_STYLE}`).join("\n")}\n`;
}

/**
 * 用户看到了一张图：要不要记、记在哪一次修订上。任务进行中、这张图现在的内容用户还没有看过，才返回要记的目标；否则是 null。
 */
export function diagramViewTarget(task: Task | null, row: DiagramRow): { diagram_id: string; base_revision: number } | null {
  if (!task || task.status !== "进行中" || row.viewed === true) return null;
  return { diagram_id: row.diagram_id, base_revision: row.revision_no };
}
