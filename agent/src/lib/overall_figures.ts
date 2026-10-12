/**
 * 业务说明里图放在哪里、角色与用例对照表怎样从用例图算：页面与生成文档共用，两边照同一个规则排。只算不存，不碰文件。
 *
 * 图的放置，按图的种类：
 * - 系统边界图在第 1 章章首，用例图在第 2 章章首（渲染成角色与用例对照表），对象关系图在第 4 章章首；
 * - 对象关系图另在把它写成来源的每个业务对象节的「与其他对象的关系」里；
 * - 流程图在它的来源页里属于第 3 章的那几节的「流程步骤」，状态图在它的来源页里属于第 4 章的那几节的「状态图」；
 * - 时序图与认不出种类的图在它第一个来源页那一节末尾的「其他图」；流程图的来源里没有第 3 章的页（状态图的来源里没有
 *   第 4 章的页）时，也放进它第一个来源页的「其他图」。
 */

import type { DiagramGraph, GraphNode } from "./diagram_scan.ts";
import { CHAPTER_FLOWS, CHAPTER_OBJECTS, CHAPTER_OVERVIEW, CHAPTER_ROLES } from "./overall_chapters.ts";

export const KIND_CONTEXT = "context", KIND_USE_CASE = "use_case", KIND_CLASS = "class", KIND_FLOWCHART = "flowchart", KIND_STATE = "state";

/** 一节里放图的四块：流程步骤、状态图、与其他对象的关系、其他图。 */
export type FigureSlot = "steps" | "state" | "relations" | "other";

/** 这一种图放在哪一章的章首；不放在章首是 null。 */
export function headChapterOfKind(kind: string): number | null {
  return kind === KIND_CONTEXT ? CHAPTER_OVERVIEW : kind === KIND_USE_CASE ? CHAPTER_ROLES : kind === KIND_CLASS ? CHAPTER_OBJECTS : null;
}

/**
 * 一张图在它的一个来源页的节里放进哪一块；不放进这一节是 null。pageChapter 是这一页所在的章（未归类是 null），
 * sourceChapters 是这张图全部来源页各自所在的章，first 是这一页是不是它的第一个来源页（照目录从上到下）。
 */
export function figureSlot(kind: string, pageChapter: number | null, sourceChapters: readonly (number | null)[], first: boolean): FigureSlot | null {
  const fits = (wanted: number) => sourceChapters.includes(wanted);
  if (kind === KIND_CONTEXT || kind === KIND_USE_CASE) return null;
  if (kind === KIND_CLASS) return pageChapter === CHAPTER_OBJECTS ? "relations" : null;
  if (kind === KIND_FLOWCHART) return pageChapter === CHAPTER_FLOWS ? "steps" : !fits(CHAPTER_FLOWS) && first ? "other" : null;
  if (kind === KIND_STATE) return pageChapter === CHAPTER_OBJECTS ? "state" : !fits(CHAPTER_OBJECTS) && first ? "other" : null;
  return first ? "other" : null;
}

/** 连线上没有写字时格子里写的字。 */
export const CELL_TAKES_PART = "参与";

/** 对照表里的一行：与角色的节点有连线、自己不是角色的一个节点。 */
export interface UseCaseMatrixRow {
  /** 节点上写着的、任务里有的第一个条目编号；没有写编号（或者任务里没有这个编号）是 null。 */
  item_id: string | null;
  /** 节点上的字去掉条目编号。 */
  text: string;
  /** 各列角色的格子，与 roles 同序：角色与这一行之间连线上写的字，没有写字的写「参与」，几根线写的字不同就用顿号连起来；没有连线是空文字。 */
  cells: string[];
}

const cleanText = (node: GraphNode): string => node.items.reduce((text, id) => text.replace(id, ""), node.text).replace(/\s+/g, " ").trim();

/**
 * 角色与用例对照表的行。roles 是第 2 章在用的各节（编号与标题）；graphs 是任务里各张用例图解析出来的节点与连线；
 * known 说一个编号是不是任务里的条目。一个节点是哪个角色：写了角色页的编号，或者节点上的字正好是角色页的标题。
 * 只收一头是角色、另一头不是角色的线；图里没有画任何角色时没有行。
 */
export function useCaseMatrix(roles: readonly { item_id: string; title: string }[], graphs: readonly DiagramGraph[], known: (itemId: string) => boolean): UseCaseMatrixRow[] {
  const roleOf = (node: GraphNode): number => roles.findIndex((role) => node.items.includes(role.item_id) || (node.items.length === 0 && node.text.trim() === role.title));
  const rows = new Map<string, { row: Omit<UseCaseMatrixRow, "cells">; labels: Set<string>[] }>();
  for (const graph of graphs) {
    const nodeOf = (name: string) => graph.nodes.find((node) => node.name === name);
    for (const edge of graph.edges) {
      const a = nodeOf(edge.from), b = nodeOf(edge.to);
      if (!a || !b) continue;
      const ra = roleOf(a), rb = roleOf(b);
      if ((ra >= 0) === (rb >= 0)) continue;
      const role = ra >= 0 ? ra : rb;
      const other = ra >= 0 ? b : a;
      const itemId = other.items.find(known) ?? null;
      const key = itemId ?? `text:${cleanText(other)}`;
      if (!rows.has(key)) rows.set(key, { row: { item_id: itemId, text: cleanText(other) }, labels: roles.map(() => new Set<string>()) });
      rows.get(key)!.labels[role].add(edge.label.trim() || CELL_TAKES_PART);
    }
  }
  return [...rows.values()].map(({ row, labels }) => ({ ...row, cells: labels.map((set) => [...set].join("、")) }));
}
