/**
 * 业务说明的章与节：总体分析的页按标签归到七章里，章内排出先后、编上节号。只算不存，也不读库。
 *
 * - 七章固定：概述与范围、角色、业务流程、业务对象、业务规则、业务目标、决策记录与待澄清事项。
 *   第 5、7 章没有自己的页，内容是从各页与问题条目算出来的表（lib/overall_views.ts）。
 * - 每一页恰好落在一处：贴了几个标签的，照章的先后取第一个对得上的章；没有贴标签、或者贴的标签一个都对不上任何一章的归「未归类」。
 * - 章内的先后：在这一章的页之间按「上级主题」成树（上级不在这一章的当作顶层，绕成圈的也当作顶层），同级按编号，
 *   树压平之后顺序编节号（3.1、3.2）。第 6 章同级里目标排在前、只贴了「决定」的排在后。
 *   已废弃的页留在它的章里，不占节号，这样在用的节的节号不因为废弃一页而变。
 * - 第 4 章最后一节固定是「术语表」（任务里有标签含「概念」的在用页时才有，不论那一页归在哪一章）。
 *
 * 本文件除了 overall_analysis.ts 不导入别的模块：助手一侧、后端与页面都可以直接导入（agent/tests/web_imports.test.ts 守着）。
 */

import { OVERALL_FIELDS, isDeprecated, tagsOf } from "./overall_analysis.ts";

export interface Chapter {
  /** 章号，从 1 起。 */
  no: number;
  name: string;
  /** 归到这一章的标签；空的是没有自己的页的章。 */
  labels: readonly string[];
}

/** 进术语表的标签。 */
export const LABEL_CONCEPT = "概念";
/** 第 6 章的两个标签；同级里只贴了「决定」的排在目标之后。 */
export const LABEL_GOAL = "目标";
export const LABEL_DECISION = "决定";

export const CHAPTERS: readonly Chapter[] = [
  { no: 1, name: "概述与范围", labels: ["范围", "假设"] },
  { no: 2, name: "角色", labels: ["角色"] },
  { no: 3, name: "业务流程", labels: ["流程", "场景"] },
  { no: 4, name: "业务对象", labels: [LABEL_CONCEPT] },
  { no: 5, name: "业务规则", labels: [] },
  { no: 6, name: "业务目标", labels: [LABEL_GOAL, LABEL_DECISION] },
  { no: 7, name: "决策记录与待澄清事项", labels: [] },
];
export const CHAPTER_OVERVIEW = 1, CHAPTER_ROLES = 2, CHAPTER_FLOWS = 3, CHAPTER_OBJECTS = 4, CHAPTER_RULES = 5, CHAPTER_GOALS = 6, CHAPTER_DECISIONS = 7;
export const GLOSSARY_NAME = "术语表";
export const UNSORTED_NAME = "未归类";

export const chapterByNo = (no: number): Chapter => CHAPTERS.find((one) => one.no === no)!;

/** 一页归哪一章：照章的先后取第一个与它的标签对得上的；一个都对不上（没有贴标签，或者贴的都不是哪一章的标签）是 null。 */
export function chapterOfLabels(labels: readonly string[]): Chapter | null {
  return CHAPTERS.find((chapter) => chapter.labels.some((label) => labels.includes(label))) ?? null;
}

/** 算章与节要的一页：编号、标签、上级主题的编号（没有写是 null）、是不是已废弃。 */
export interface ChapterPage {
  item_id: string;
  labels: readonly string[];
  parent: string | null;
  deprecated: boolean;
}

/** 从一页的字段内容取出算章与节要的几样。「上级主题」写成一个编号或者一个列表都认，取第一个。 */
export function chapterPage(itemId: string, fields: Record<string, unknown>): ChapterPage {
  const up = fields[OVERALL_FIELDS.parent];
  const first = Array.isArray(up) ? up.find((one): one is string => typeof one === "string" && one.trim() !== "") : typeof up === "string" && up.trim() !== "" ? up : undefined;
  return { item_id: itemId, labels: tagsOf(fields), parent: first?.trim() ?? null, deprecated: isDeprecated(fields) };
}

/** 一章里的一节：哪一页、在第几章、节号（已废弃的页没有节号）、在章里缩进几层（顶层是 0）。 */
export interface ChapterSection {
  item_id: string;
  chapter: number;
  no: string | null;
  depth: number;
}

export interface ChapterSections {
  chapter: Chapter;
  sections: ChapterSection[];
  /** 「术语表」这一节的节号；只有第 4 章、而且任务里有标签含「概念」的在用页时才有。 */
  glossaryNo: string | null;
}

export interface ChapterLayout {
  chapters: ChapterSections[];
  /** 没有归到任何一章的页（没有贴标签，或者贴的标签一个都对不上），按编号；不编节号。已废弃的也在里面，带着标记。 */
  unsorted: { item_id: string; deprecated: boolean }[];
}

const byId = (a: ChapterPage, b: ChapterPage): number => a.item_id.localeCompare(b.item_id, undefined, { numeric: true });
const decisionOnly = (page: ChapterPage): boolean => page.labels.includes(LABEL_DECISION) && !page.labels.includes(LABEL_GOAL);

/** 一章里的页排成先后：按上级主题成树（只认本章里的上级，绕圈的当作顶层），同级照 order 排，再压平；每页带上缩进的层数。 */
function ordered(pages: readonly ChapterPage[], order: (a: ChapterPage, b: ChapterPage) => number): { page: ChapterPage; depth: number }[] {
  const known = new Map(pages.map((page) => [page.item_id, page]));
  const up = (page: ChapterPage): string | null => (page.parent && page.parent !== page.item_id && known.has(page.parent) ? page.parent : null);
  // 顺着上级一路往上走又回到这一页，就是绕圈：当它没有上级。
  const parent = (page: ChapterPage): string | null => {
    const seen = new Set<string>();
    for (let at = up(page); at && !seen.has(at); at = up(known.get(at)!)) {
      if (at === page.item_id) return null;
      seen.add(at);
    }
    return up(page);
  };
  const children = new Map<string | null, ChapterPage[]>();
  for (const page of pages) {
    const key = parent(page);
    children.set(key, [...(children.get(key) ?? []), page]);
  }
  const out: { page: ChapterPage; depth: number }[] = [];
  const walk = (key: string | null, depth: number) => {
    for (const page of [...(children.get(key) ?? [])].sort(order)) {
      out.push({ page, depth });
      walk(page.item_id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * 业务说明的章与节：七章各自的节，与没有归到任何一章的页。pages 是总体分析的全部页（含已废弃的）；每一页恰好出现一次，
 * 要么在某一章的 sections 里，要么在 unsorted 里。要数在用的页：章里数节号不是 null 的，unsorted 里数 deprecated 为假的。
 */
export function chapterLayout(pages: readonly ChapterPage[]): ChapterLayout {
  const sorted = [...pages].sort(byId);
  const hasConcept = sorted.some((page) => !page.deprecated && page.labels.includes(LABEL_CONCEPT));
  const chapters = CHAPTERS.map((chapter): ChapterSections => {
    const own = sorted.filter((page) => chapterOfLabels(page.labels)?.no === chapter.no);
    const order = chapter.no === CHAPTER_GOALS ? (a: ChapterPage, b: ChapterPage) => Number(decisionOnly(a)) - Number(decisionOnly(b)) || byId(a, b) : byId;
    let count = 0;
    const sections = ordered(own, order).map(({ page, depth }): ChapterSection =>
      ({ item_id: page.item_id, chapter: chapter.no, depth, no: page.deprecated ? null : `${chapter.no}.${++count}` }));
    return { chapter, sections, glossaryNo: chapter.no === CHAPTER_OBJECTS && hasConcept ? `${chapter.no}.${count + 1}` : null };
  });
  return { chapters, unsorted: sorted.filter((page) => chapterOfLabels(page.labels) === null).map((page) => ({ item_id: page.item_id, deprecated: page.deprecated })) };
}
