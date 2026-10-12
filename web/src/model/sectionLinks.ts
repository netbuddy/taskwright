// 一节末尾的三块在页面上要的数：相关角色与对象、对应的需求条目、追溯。这里只算不画。
//   · 相关角色与对象：与这一页有关的别的页，按它们所在的章分三行（角色、业务对象、相关流程）。「有关」有三种来历：
//     这一页的文字提到了那一页；那一页的文字提到了这一页；用例图或对象关系图里两页的节点之间有连线。
//     已废弃的页与别的章的页不列。
//   · 对应的需求条目：依据这一页写的条目，各带一个状态词（草稿、评审中 · N 处发现、已确认）。
//   · 追溯：材料（这一页引了哪几份材料）、澄清记录（引了用户的几句话）、图（画在这一节里的图有几张）、条目（依据它写的条目）。

import type { Item, Task } from "../api/types";
import type { DiagramGraph } from "../../../agent/src/lib/diagram_scan.ts";
import { CHAPTER_FLOWS, CHAPTER_OBJECTS, CHAPTER_ROLES, type Toc, sectionOf, tocOrder } from "./chapters";
import { mainStatus, sourceKindNow } from "./items";
import { dependents, isDeprecated, isOverall } from "./overall";
import { sectionFigures } from "./sectionDiagrams";

export interface Related {
  roles: Item[];
  objects: Item[];
  flows: Item[];
}

/** 图里与这一页的节点有连线的别的条目的编号（连线不分方向）。 */
export function linkedIds(graphs: readonly DiagramGraph[], itemId: string): string[] {
  const out = new Set<string>();
  for (const graph of graphs) {
    const mine = new Set(graph.nodes.filter((node) => node.items.includes(itemId)).map((node) => node.name));
    if (mine.size === 0) continue;
    const itemsOf = (name: string) => graph.nodes.find((node) => node.name === name)?.items ?? [];
    for (const edge of graph.edges) {
      if (mine.has(edge.from)) for (const id of itemsOf(edge.to)) out.add(id);
      if (mine.has(edge.to)) for (const id of itemsOf(edge.from)) out.add(id);
    }
  }
  out.delete(itemId);
  return [...out];
}

/** 与这一页有关的页，按章分成三行，每行照目录的先后。graphs 是任务里用例图与对象关系图解析出来的节点与连线。 */
export function relatedPages(task: Task, contents: Toc, item: Item, graphs: readonly DiagramGraph[]): Related {
  const ids = new Set<string>(linkedIds(graphs, item.item_id));
  for (const mention of item.mentioned_by ?? []) ids.add(mention.item_id);
  for (const other of task.items) if ((other.mentioned_by ?? []).some((mention) => mention.item_id === item.item_id)) ids.add(other.item_id);
  ids.delete(item.item_id);
  const pages = tocOrder(contents).filter((page) => ids.has(page.item_id) && isOverall(page.collection) && !isDeprecated(page));
  const inChapter = (no: number) => pages.filter((page) => sectionOf(contents, page.item_id)?.chapter === no);
  return { roles: inChapter(CHAPTER_ROLES), objects: inChapter(CHAPTER_OBJECTS), flows: inChapter(CHAPTER_FLOWS) };
}

/** 需求条目的状态词：评审不通过、还没有处理的是 reviewing（带有几处发现）；什么都不缺的是 confirmed；其余是 draft。 */
export type RequirementState = { kind: "draft" } | { kind: "reviewing"; findings: number } | { kind: "confirmed" };

/**
 * 一个需求条目现在的状态，由条目的主状态（model/items.ts 的 mainStatus）得出：
 * 评审不通过、还没有处理 → 评审中；没有欠缺（看过、评审通过或者按用户的决定保留、不要求评审与看过的集合也算），而且没有牵涉它的未解决问题、
 * 依据也不待核实 → 已确认；别的（没看过、等评审、有未解决的问题、依据待核实）→ 草稿。
 */
export function requirementState(task: Task, item: Item): RequirementState {
  const status = mainStatus(task, item);
  if (status.kind === "failed") return { kind: "reviewing", findings: status.review?.state === "failed" ? status.review.problems : 0 };
  const settled = (status.kind === null || status.kind === "kept") && status.issues === 0 && !item.basis_pending;
  return settled ? { kind: "confirmed" } : { kind: "draft" };
}

export function requirementStateText(state: RequirementState): string {
  return state.kind === "reviewing" ? `评审中 · ${state.findings} 处发现` : state.kind === "confirmed" ? "已确认" : "草稿";
}

/** 依据这一页写的需求条目与各自的状态，按编号。 */
export function requirementsOf(task: Task, item: Item): { item: Item; state: RequirementState }[] {
  return dependents(task, item).filter((one) => !isOverall(one.collection)).map((one) => ({ item: one, state: requirementState(task, one) }));
}

export interface Trace {
  /** 这一页引的各份材料：文件名、引了几处、第一处（点了在右边的材料里定位它）。照来源的先后。 */
  materials: { name: string; count: number; first: { excerpt: string; locator: string } }[];
  /** 引了用户的几句话。 */
  clarified: number;
  /** 画在这一节里的图有几张。 */
  figures: number;
  /** 依据这一页写的需求条目。 */
  items: Item[];
}

/** 追溯行的四段；哪一段没有内容由页面决定不画。 */
export function traceOf(task: Task, contents: Toc, item: Item): Trace {
  const materials: Trace["materials"] = [];
  let clarified = 0;
  for (const source of item.sources) {
    const kind = sourceKindNow(String(source.kind));
    if (kind === "用户的话") clarified += 1;
    if (kind !== "文档原文") continue;
    const name = source.locator.split("/").pop() ?? source.locator;
    const known = materials.find((one) => one.name === name);
    if (known) known.count += 1;
    else materials.push({ name, count: 1, first: { excerpt: source.excerpt, locator: source.locator } });
  }
  const figures = Object.values(sectionFigures(task, contents, item)).reduce((n, rows) => n + rows.length, 0);
  return { materials, clarified, figures, items: requirementsOf(task, item).map((one) => one.item) };
}
