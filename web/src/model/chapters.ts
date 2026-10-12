// 业务说明的章与节在页面上的样子：七章各自的节（带着那一页的内容）、未归类的页、目录底部的汇总。
// 页按标签归到哪一章、章内怎样排先后与编节号，算法在助手一侧的 agent/src/lib/overall_chapters.ts（它不碰 Node 模块，页面直接导入；
// 助手一侧与后端按章计数用的是同一份），这里只把算出来的编号对回任务数据里的页。目录每行的状态点、每页的字段读法沿用 model/overall.ts。

import type { Item, Task } from "../api/types";
import { type Chapter, chapterLayout, chapterOfLabels, chapterPage } from "../../../agent/src/lib/overall_chapters.ts";
import { keepPendingField } from "./items";
import { isOverall, labelsOf, pagesOf, titleOf } from "./overall";

export {
  CHAPTERS, CHAPTER_DECISIONS, CHAPTER_FLOWS, CHAPTER_GOALS, CHAPTER_OBJECTS, CHAPTER_OVERVIEW, CHAPTER_ROLES, CHAPTER_RULES, GLOSSARY_NAME, UNSORTED_NAME, chapterByNo,
} from "../../../agent/src/lib/overall_chapters.ts";
export type { Chapter };

/** 一页归哪一章：照章的先后取第一个与它的标签对得上的；一个都对不上（没有贴标签）是 null。 */
export function chapterOf(item: Item): Chapter | null {
  return chapterOfLabels(labelsOf(item));
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
  /** 「术语表」这一节的节号；只有第 4 章、而且有标签含「概念」的在用页时才有。 */
  glossaryNo: string | null;
  /** 这一章的导语页（「导语所属章」写着这一章的在用页）；没有是 null。导语页不是节，在目录里排在这一章各节的前面。 */
  intro: Item | null;
  /** 这一章已废弃的、多出来的导语页。 */
  otherIntros: Item[];
}

export interface Toc {
  chapters: TocChapter[];
  /** 没有归到任何一章的页（没有贴标签，或者贴的标签一个都对不上），按编号；不编节号。 */
  unsorted: Item[];
}

/** 业务说明的目录：七章各自的节，与没有贴标签的页。 */
export function toc(task: Task): Toc {
  const pages = pagesOf(task);
  const byId = new Map(pages.map((page) => [page.item_id, page]));
  const layout = chapterLayout(pages.map((page) => chapterPage(page.item_id, page.fields)));
  return {
    chapters: layout.chapters.map((one) => ({
      chapter: one.chapter, glossaryNo: one.glossaryNo,
      intro: one.intro ? byId.get(one.intro) ?? null : null, otherIntros: one.otherIntros.map((id) => byId.get(id)!),
      sections: one.sections.map((section) => ({ item: byId.get(section.item_id)!, chapter: section.chapter, no: section.no, depth: section.depth })),
    })),
    unsorted: layout.unsorted.map((one) => byId.get(one.item_id)!),
  };
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

/** 这一页是哪一章的导语页（在用的那一页，或者已废弃、多出来的）；不是导语页是 null。 */
export function introChapter(contents: Toc, itemId: string | null | undefined): TocChapter | null {
  if (!itemId) return null;
  return contents.chapters.find((one) => one.intro?.item_id === itemId || one.otherIntros.some((page) => page.item_id === itemId)) ?? null;
}

/** 目录里导语那一行的名字。 */
export const INTRO_NAME = "导语";

/** 目录从上到下的各页（每章先是导语页，再是各节；最后是未归类的页）；「上一条」「下一条」照它走。 */
export function tocOrder(contents: Toc): Item[] {
  return [...contents.chapters.flatMap((chapter) => [...(chapter.intro ? [chapter.intro] : []), ...chapter.sections.map((one) => one.item)]), ...contents.unsorted];
}

/** 给人看的一节的叫法：「3.1 借书」；导语页写「业务流程 导语」；没有节号的（已废弃、未归类）只写标题。 */
export function sectionLabel(contents: Toc, item: Item): string {
  const intro = introChapter(contents, item.item_id);
  if (intro) return `${intro.chapter.name} ${INTRO_NAME}`;
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
