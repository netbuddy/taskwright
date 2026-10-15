// 工作台「分析模型」页签的索引表要的东西：图按种类分组排好，每张图写它放在业务说明的哪里（所属节或章首）、
// 用户看没看过现在的内容、是不是刚改的、被哪些条目依据；表上一行的计数。只算，不画（components/work/ModelsTab.tsx）。
// 图本身仍画在它说明的那一节或章首里；这一页只是索引。

import type { DiagramRow, Item, Task } from "../api/types";
import { type Toc, chapterByNo, sectionLabel } from "./chapters";
import { SOURCE_FIGURE, sourceKindNow } from "./items";
import { isOverall } from "./overall";
import { figureHome } from "./sectionDiagrams";

/** 种类在表里的先后：先是章首的三种（系统边界、用例、对象关系），再是放在节里的几种。 */
export const KIND_ORDER = ["context", "use_case", "class", "flowchart", "state", "sequence"];

export interface ModelRow {
  row: DiagramRow;
  /** 放在业务说明的哪里，例如「3.1 借书」「第 4 章 业务对象 章首」「未归入节」。 */
  home: string;
  /** 用户看过它现在的内容。 */
  viewed: boolean;
  /** 刚改：图在新画之后又改过（图自己的修订号大于 1），而用户还没有看过改后的内容。 */
  fresh: boolean;
  /** 依据这张图写的条目（来源里种类为「图」、出处是这张图的编号），业务说明的页不算。 */
  basedOn: Item[];
}

/** 一张图放在业务说明的哪里，写给人看。 */
export function homeText(task: Task, contents: Toc, diagramId: string): string {
  const home = figureHome(task, contents, diagramId);
  if (!home || home.where === "loose") return "未归入节";
  if (home.where === "chapter") return `第 ${home.chapter} 章 ${chapterByNo(home.chapter).name} 章首`;
  const page = task.items.find((one) => one.item_id === home.itemId);
  return page ? sectionLabel(contents, page) : "未归入节";
}

/** 依据这张图写的条目（业务说明的页不算），按编号。 */
export function basedOnDiagram(task: Task, diagramId: string): Item[] {
  return task.items
    .filter((one) => !isOverall(one.collection) && one.sources.some((source) => sourceKindNow(String(source.kind)) === SOURCE_FIGURE && source.locator === diagramId))
    .sort((a, b) => a.item_id.localeCompare(b.item_id, undefined, { numeric: true }));
}

/** 索引表的各组：每种一组，组里按编号。 */
export function modelGroups(task: Task, contents: Toc): { kind: string; kindName: string; rows: ModelRow[] }[] {
  const rows = [...(task.diagrams ?? [])].sort((a, b) => a.diagram_id.localeCompare(b.diagram_id, undefined, { numeric: true }));
  const kinds = [...new Set(rows.map((one) => one.kind))].sort((a, b) => rank(a) - rank(b));
  return kinds.map((kind) => {
    const mine = rows.filter((one) => one.kind === kind);
    return {
      kind, kindName: mine[0].kind_name,
      rows: mine.map((row) => ({
        row, home: homeText(task, contents, row.diagram_id), viewed: row.viewed === true,
        fresh: row.viewed !== true && row.revision_no > 1, basedOn: basedOnDiagram(task, row.diagram_id),
      })),
    };
  });
}
const rank = (kind: string) => (KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length);

/** 表上一行：共几张、已查看几张、刚改几张、被条目依据的几张。 */
export function modelCountLine(groups: { rows: ModelRow[] }[]): string {
  const all = groups.flatMap((one) => one.rows);
  return `共 ${all.length} 张 · 已查看 ${all.filter((one) => one.viewed).length} · 刚改 ${all.filter((one) => one.fresh).length} · 被条目依据 ${all.filter((one) => one.basedOn.length > 0).length}`;
}
