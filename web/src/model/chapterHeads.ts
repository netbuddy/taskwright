// 章首页上要算的东西。这里只算不画。
//   · 角色与用例对照表（第 2 章）：从用例图的节点与连线算。列是角色（第 2 章在用的各节）；行是图里与角色的节点有连线、自己不是角色的节点
//     （写了编号的是那一页或那个条目，没有写编号的照节点上的字）；格子是角色与这一行之间连线上写的字，没有写字的写「参与」，
//     几根线写的字不同就都列出来；末列是这一行所属的流程（它自己是流程节，或者它是依据流程节写的条目）。
//   · 业务目标摘要（第 1 章）：目标树的前两层。

import type { Item, Task } from "../api/types";
import type { DiagramGraph, GraphNode } from "../../../agent/src/lib/diagram_scan.ts";
import type { GoalTree } from "../../../agent/src/lib/overall_views.ts";
import { CHAPTER_FLOWS, CHAPTER_ROLES, type Toc, sectionOf } from "./chapters";
import { SOURCE_ITEM, sourceKindNow } from "./items";
import { isDeprecated, isOverall, titleOf } from "./overall";

/** 连线上没有写字时格子里写的字。 */
export const CELL_TAKES_PART = "参与";

export interface UseCaseRow {
  /** 这一行的叫法：节点上的字去掉条目编号；写了编号、任务里有这个条目的，用它的标题。 */
  label: string;
  /** 这一行是哪一页或哪个条目；节点上没有写编号（或者任务里没有这个编号）是 null。 */
  item: Item | null;
  /** 各列角色的格子，与 roles 同序；这个角色与这一行没有连线是空文字。 */
  cells: string[];
  /** 所属的流程（第 3 章的节）。 */
  flows: Item[];
}

export interface UseCaseTable {
  roles: Item[];
  rows: UseCaseRow[];
}

const cleanText = (node: GraphNode): string => node.items.reduce((text, id) => text.replace(id, ""), node.text).replace(/\s+/g, " ").trim();

/** 角色与用例对照表。graphs 是任务里各张用例图解析出来的节点与连线；图里没有画任何角色时 rows 是空的。 */
export function useCaseTable(task: Task, contents: Toc, graphs: readonly DiagramGraph[]): UseCaseTable {
  const roles = (contents.chapters.find((one) => one.chapter.no === CHAPTER_ROLES)?.sections ?? []).map((one) => one.item).filter((page) => !isDeprecated(page));
  const byId = new Map(task.items.map((item) => [item.item_id, item]));
  /** 一个节点是哪个角色：写了角色页的编号，或者节点上的字正好是角色页的标题；不是角色是 -1。 */
  const roleOf = (node: GraphNode): number => roles.findIndex((role) => node.items.includes(role.item_id) || (node.items.length === 0 && node.text.trim() === titleOf(role)));
  const flowsOf = (item: Item | null): Item[] => {
    if (!item) return [];
    if (sectionOf(contents, item.item_id)?.chapter === CHAPTER_FLOWS) return [item];
    if (isOverall(item.collection)) return [];
    return item.sources.filter((source) => sourceKindNow(String(source.kind)) === SOURCE_ITEM).map((source) => byId.get(source.locator))
      .filter((page): page is Item => page !== undefined && sectionOf(contents, page.item_id)?.chapter === CHAPTER_FLOWS && !isDeprecated(page))
      .filter((page, i, all) => all.indexOf(page) === i);
  };
  const rows = new Map<string, { row: UseCaseRow; labels: Set<string>[] }>();
  for (const graph of graphs) {
    const nodeOf = (name: string) => graph.nodes.find((node) => node.name === name);
    for (const edge of graph.edges) {
      const a = nodeOf(edge.from), b = nodeOf(edge.to);
      if (!a || !b) continue;
      const ra = roleOf(a), rb = roleOf(b);
      // 只收一头是角色、另一头不是角色的线。
      if ((ra >= 0) === (rb >= 0)) continue;
      const role = ra >= 0 ? ra : rb;
      const other = ra >= 0 ? b : a;
      const item = other.items.map((id) => byId.get(id)).find((one) => one !== undefined) ?? null;
      const key = item ? item.item_id : `text:${cleanText(other)}`;
      if (!rows.has(key)) {
        const label = item ? (isOverall(item.collection) ? titleOf(item) : item.title || item.item_id) : cleanText(other);
        rows.set(key, { row: { label, item, cells: roles.map(() => ""), flows: flowsOf(item) }, labels: roles.map(() => new Set<string>()) });
      }
      rows.get(key)!.labels[role].add(edge.label.trim() || CELL_TAKES_PART);
    }
  }
  return {
    roles,
    rows: [...rows.values()].map(({ row, labels }) => ({ ...row, cells: labels.map((set) => [...set].join("、")) })),
  };
}

/** 业务目标摘要：目标树的前两层（最上层的目标与它们各自下面一层的目标）。 */
export function goalSummary(goals: GoalTree | undefined): { item_id: string; title: string; goals: { item_id: string; title: string }[] }[] {
  return (goals?.roots ?? []).map((root) => ({ item_id: root.item_id, title: root.title, goals: root.goals.map((one) => ({ item_id: one.item_id, title: one.title })) }));
}
