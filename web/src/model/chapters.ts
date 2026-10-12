// 业务说明的章与节：总体分析的页按标签归到七章里，章内排出先后、编上节号。这里只算不画，也不改任何数据。
//   · 七章固定：概述与范围、角色、业务流程、业务对象、业务规则、业务目标、决策记录与待澄清事项。
//     第 5、7 章没有自己的页，内容是从各页与问题条目算出来的表（整份任务数据里的 overall_views）。
//   · 一页只在一章出现：贴了几个标签的，照章的先后取第一个对得上的章；一个标签都没有的归「未归类」。
//   · 章内的先后：在这一章的页之间按「上级主题」成树（上级不在这一章的当作顶层），同级按编号，树压平之后顺序编节号（3.1、3.2）。
//     第 6 章里目标排在前、挂不到目标下的决定排在后。已废弃的页留在它的章里，不占节号，这样在用的节的节号不因为废弃一页而变。
//   · 第 4 章最后一节固定是「术语表」（有标签含「概念」的页时才有）。
// 目录每行的状态点、每页的字段读法沿用 model/overall.ts。

import type { Item, Task } from "../api/types";
import { keepPendingField } from "./items";
import { CONCEPT_LABEL, isDeprecated, isOverall, labelsOf, pagesOf, parentOf, titleOf } from "./overall";

export interface Chapter {
  /** 章号，从 1 起。 */
  no: number;
  name: string;
  /** 归到这一章的标签；空的是没有自己的页的章。 */
  labels: readonly string[];
}

export const CHAPTERS: readonly Chapter[] = [
  { no: 1, name: "概述与范围", labels: ["范围", "假设"] },
  { no: 2, name: "角色", labels: ["角色"] },
  { no: 3, name: "业务流程", labels: ["流程", "场景"] },
  { no: 4, name: "业务对象", labels: [CONCEPT_LABEL] },
  { no: 5, name: "业务规则", labels: [] },
  { no: 6, name: "业务目标", labels: ["目标", "决定"] },
  { no: 7, name: "决策记录与待澄清事项", labels: [] },
];
export const CHAPTER_OVERVIEW = 1, CHAPTER_ROLES = 2, CHAPTER_FLOWS = 3, CHAPTER_OBJECTS = 4, CHAPTER_RULES = 5, CHAPTER_GOALS = 6, CHAPTER_DECISIONS = 7;
/** 第 6 章里排在目标之后的那个标签。 */
const DECISION_LABEL = "决定";
export const GLOSSARY_NAME = "术语表";
export const UNSORTED_NAME = "未归类";

export const chapterByNo = (no: number): Chapter => CHAPTERS.find((one) => one.no === no)!;

/** 一页归哪一章：照章的先后取第一个与它的标签对得上的；一个都对不上（没有贴标签）是 null。 */
export function chapterOf(item: Item): Chapter | null {
  const labels = labelsOf(item);
  return CHAPTERS.find((chapter) => chapter.labels.some((label) => labels.includes(label))) ?? null;
}

/** 目录里的一节：哪一页、在第几章、节号（已废弃的页没有节号）、在章里缩进几层（顶层是 0）。 */
export interface TocSection {
  item: Item;
  chapter: number;
  no: string | null;
  depth: number;
}

export interface TocChapter {
  chapter: Chapter;
  sections: TocSection[];
  /** 「术语表」这一节的节号；只有第 4 章、而且有标签含「概念」的页时才有。 */
  glossaryNo: string | null;
}

export interface Toc {
  chapters: TocChapter[];
  /** 没有贴标签的页，按编号；不编节号。 */
  unsorted: Item[];
}

const byId = (a: Item, b: Item) => a.item_id.localeCompare(b.item_id, undefined, { numeric: true });

/** 一章里的页排成先后：按上级主题成树（只认本章里的上级，绕圈的当作顶层），同级照 order 排，再压平；每页带上缩进的层数。 */
function ordered(pages: Item[], order: (a: Item, b: Item) => number): { item: Item; depth: number }[] {
  const known = new Map(pages.map((page) => [page.item_id, page]));
  const up = (page: Item): string | null => {
    const id = parentOf(page);
    return id && id !== page.item_id && known.has(id) ? id : null;
  };
  // 顺着上级一路往上走又回到这一页，就是绕圈：当它没有上级。
  const parent = (page: Item): string | null => {
    const seen = new Set<string>();
    for (let at = up(page); at && !seen.has(at); at = up(known.get(at)!)) {
      if (at === page.item_id) return null;
      seen.add(at);
    }
    return up(page);
  };
  const children = new Map<string | null, Item[]>();
  for (const page of pages) {
    const key = parent(page);
    children.set(key, [...(children.get(key) ?? []), page]);
  }
  const out: { item: Item; depth: number }[] = [];
  const walk = (key: string | null, depth: number) => {
    for (const page of [...(children.get(key) ?? [])].sort(order)) {
      out.push({ item: page, depth });
      walk(page.item_id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** 业务说明的目录：七章各自的节，与没有贴标签的页。 */
export function toc(task: Task): Toc {
  const pages = pagesOf(task);
  const chapters = CHAPTERS.map((chapter): TocChapter => {
    const own = pages.filter((page) => chapterOf(page)?.no === chapter.no);
    // 第 6 章：同级里目标在前、决定在后；别的章同级按编号。
    const order = chapter.no === CHAPTER_GOALS
      ? (a: Item, b: Item) => Number(isDecisionOnly(a)) - Number(isDecisionOnly(b)) || byId(a, b)
      : byId;
    let count = 0;
    const sections = ordered(own, order).map(({ item, depth }): TocSection =>
      ({ item, chapter: chapter.no, depth, no: isDeprecated(item) ? null : `${chapter.no}.${++count}` }));
    // 术语表收的是标签含「概念」的页，不论它归在哪一章（例如同时贴了「流程」的归在第 3 章）。
    const glossaryNo = chapter.no === CHAPTER_OBJECTS && pages.some((page) => !isDeprecated(page) && labelsOf(page).includes(CONCEPT_LABEL)) ? `${chapter.no}.${count + 1}` : null;
    return { chapter, sections, glossaryNo };
  });
  return { chapters, unsorted: pages.filter((page) => chapterOf(page) === null) };
}

/** 一页是决定而不是目标（第 6 章里排在目标之后）。 */
function isDecisionOnly(item: Item): boolean {
  const labels = labelsOf(item);
  return labels.includes(DECISION_LABEL) && !labels.includes("目标");
}

/** 目录里的那一节；这一页没有贴标签（在「未归类」下）或者不是总体分析的页时是 null。 */
export function sectionOf(contents: Toc, itemId: string | null | undefined): TocSection | null {
  if (!itemId) return null;
  for (const chapter of contents.chapters) {
    const found = chapter.sections.find((one) => one.item.item_id === itemId);
    if (found) return found;
  }
  return null;
}

/** 目录从上到下的各页（各章的节，再是未归类的页）；「上一条」「下一条」照它走。 */
export function tocOrder(contents: Toc): Item[] {
  return [...contents.chapters.flatMap((chapter) => chapter.sections.map((one) => one.item)), ...contents.unsorted];
}

/** 给人看的一节的叫法：「3.1 借书」；没有节号的（已废弃、未归类）只写标题。 */
export function sectionLabel(contents: Toc, item: Item): string {
  const section = sectionOf(contents, item.item_id);
  return section?.no ? `${section.no} ${titleOf(item)}` : titleOf(item);
}

/** 目录底部的汇总：编了号的节有几节、需求条目有几条（总体分析与问题集合之外的条目）、待澄清的有几处（还没有了结的问题条目）。 */
export function tocTotals(task: Task, contents: Toc): { sections: number; items: number; open: number } {
  const sections = contents.chapters.reduce((n, chapter) => n + chapter.sections.filter((one) => one.no !== null).length, 0);
  let items = 0, open = 0;
  for (const item of task.items) {
    if (isOverall(item.collection)) continue;
    const status = keepPendingField(task, item.collection);
    if (!status) items += 1;
    else if (item.fields[status.name] === (status.values ?? [])[0]) open += 1;
  }
  return { sections, items, open };
}
