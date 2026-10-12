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
import { CHAPTER_FLOWS, CHAPTER_OBJECTS, CHAPTER_OVERVIEW, CHAPTER_ROLES, type Toc, sectionOf, tocOrder } from "./chapters";
import { SOURCE_FIGURE } from "./items";
import { isOverall } from "./overall";

export const KIND_CONTEXT = "context", KIND_USE_CASE = "use_case", KIND_CLASS = "class", KIND_FLOWCHART = "flowchart", KIND_STATE = "state";

/** 一节里放图的四块：流程步骤、状态图、与其他对象的关系、其他图。 */
export type FigureSlot = "steps" | "state" | "relations" | "other";
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

/** 一张图在它的一个来源页的节里放进哪一块；不放进这一节是 null。pages 是这张图的全部来源页（sourcePages）。 */
function slotIn(contents: Toc, row: DiagramRow, page: Item, pages: Item[]): FigureSlot | null {
  const chapter = sectionOf(contents, page.item_id)?.chapter ?? null;
  const fits = (wanted: number) => pages.some((one) => sectionOf(contents, one.item_id)?.chapter === wanted);
  const first = pages[0]?.item_id === page.item_id;
  if (row.kind === KIND_CONTEXT || row.kind === KIND_USE_CASE) return null;
  if (row.kind === KIND_CLASS) return chapter === CHAPTER_OBJECTS ? "relations" : null;
  if (row.kind === KIND_FLOWCHART) return chapter === CHAPTER_FLOWS ? "steps" : !fits(CHAPTER_FLOWS) && first ? "other" : null;
  if (row.kind === KIND_STATE) return chapter === CHAPTER_OBJECTS ? "state" : !fits(CHAPTER_OBJECTS) && first ? "other" : null;
  return first ? "other" : null;
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
  if (row.kind === KIND_CONTEXT) return { where: "chapter", chapter: CHAPTER_OVERVIEW };
  if (row.kind === KIND_USE_CASE) return { where: "chapter", chapter: CHAPTER_ROLES };
  if (row.kind === KIND_CLASS) return { where: "chapter", chapter: CHAPTER_OBJECTS };
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
