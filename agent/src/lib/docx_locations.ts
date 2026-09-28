/**
 * Word 材料的位置规则：由段落号得出来源标签里给人看的位置。后端上传时用它算好位置表
 * （「文件名.docx.locations.json」，lib/docx_location_input.ts 从文件整理输入并写文件），页面显示来源标签时查这张表。
 * 这是这几条规则唯一的一份；不依赖任何模块（也不依赖 Node 自带模块），前端可以直接引用。
 *
 * 现在只有章节：标题级别用 lib/docx_heading.ts 的 headingLevel；标题文字是「编号 + 段落文字」，编号由 lib/docx_numbering.ts 数
 * （与投影同一份数法），只有引用到的各级都写十进制阿拉伯数字时才带进标题文字，项目符号、中文数字、罗马数字等都不带。
 * 段落文字与页面取标题文字的方式相同：超链接、修订插入与删除里的 w:t、域代码所在文字块里的 w:t、文本框里的字都算，符号字 w:sym 不算。
 * 章节是这一段（含）之前最近的标题，任何级别都算，与分段参数无关。页码与页内位置还没有定下规则，位置表不写它们。
 *
 * 规则版本 LOCATION_RULES_VERSION：标题识别规则、章节推导规则（以及将来加进来的页码、页内位置规则）任何一条改变时加一。
 * 位置表文件头里记着它。
 */

import { headingLevel } from "./docx_heading.ts";
import { type NumberingLevel, NumberingCounter } from "./docx_numbering.ts";

/** 位置规则的版本，从 1 起；规则任何一条改变时加一（见开头的说明）。 */
export const LOCATION_RULES_VERSION = 1;

// ───────────── 输入：从 Word 文件整理出来的段落序列（与解析方式无关） ─────────────

/** 段落里与位置有关的一项，按原顺序：text 是算进标题文字的字；mark 是分页标记 w:lastRenderedPageBreak（只数个数）。 */
export type LayoutItem = { kind: "text"; text: string } | { kind: "mark" };

export interface LayoutParagraph {
  /** 段落号（投影的计数规则）。 */
  n: number;
  /** 材料区的排版库画不画这一段：customXml 里的、单元格里内容控件中的段落不画；标题照记，分页标记不数。 */
  drawn: boolean;
  /** 段落样式（w:pStyle）。 */
  style?: string;
  /** 段落自身的大纲级别（w:outlineLvl）。 */
  outline?: string;
  /** 这一段的编号，已按投影的做法沿样式找好（numId 为 0 或没有编号时不写）。 */
  numbering?: { numId: string; level: number };
  items: LayoutItem[];
}

/** 样式表里的一个样式：标题判断要的三项。 */
export interface LayoutStyle { id: string; name?: string; basedOn?: string; outline?: string }

/** numbering.xml 里某套编号（numId）的某一级，已按 w:startOverride 覆盖起始值。 */
export interface LayoutLevel extends NumberingLevel { numId: string; level: number }

export interface LocationInput {
  /** 按文件里的先后：正文与表格（含嵌套表格）里的段落，文本框里的除外；排版库不画的段落也在内（drawn 为假）。 */
  paragraphs: LayoutParagraph[];
  styles: LayoutStyle[];
  levels: LayoutLevel[];
}

// ───────────── 规则 ─────────────

/** 一段的标题级别（1 是一级，不是标题为 null）与标题文字（「编号 段落文字」，只对标题有意义）。 */
export interface LocatedParagraph { n: number; heading: number | null; title: string }

/** 每一段的标题级别与标题文字（排版库不画的段落也算，编号照样往下数）。 */
export function headingsOf(input: LocationInput): LocatedParagraph[] {
  const styleMap = new Map(input.styles.map((s) => [s.id, s]));
  const counter = new NumberingCounter(new Map(input.levels.map((l) => [`${l.numId}:${l.level}`, l])));
  return input.paragraphs.map((p) => {
    const level = headingLevel(p.outline, p.style, (id) => {
      const s = styleMap.get(id);
      return s && { name: s.name, basedOn: s.basedOn, outline: s.outline };
    });
    const num = p.numbering ? counter.next(p.numbering.numId, p.numbering.level) : null;
    const label = num && num.decimal ? num.label : "";
    const text = p.items.map((x) => (x.kind === "text" ? x.text : "")).join("").trim();
    return { n: p.n, heading: level === null ? null : level + 1, title: [label, text].filter(Boolean).join(" ") };
  });
}

/** 分页标记（w:lastRenderedPageBreak）的个数：在排版库画的段落里数，含表格里的，与页面 prepare 里的 marks 相同。 */
export function pageMarks(input: LocationInput): number {
  let marks = 0;
  for (const p of input.paragraphs) if (p.drawn) marks += p.items.filter((x) => x.kind === "mark").length;
  return marks;
}

// ───────────── 位置表文件（「文件名.docx.locations.json」） ─────────────

/** 位置表文件的格式版本（字段怎样写）；与规则版本 LOCATION_RULES_VERSION 分开。 */
export const LOCATIONS_FORMAT_VERSION = 1;
export const LOCATIONS_SUFFIX = ".locations.json";
/**
 * 文件名是不是位置表（x.docx.locations.json，不分大小写）。后端标派生文件、把它列为保留文件名，任务现状与评审列材料时跳过它，
 * 都用这一个判断。
 */
export const isLocationTable = (name: string) => name.toLowerCase().endsWith(".docx" + LOCATIONS_SUFFIX);

export interface LocationFile {
  version: number;
  rules_version: number;
  说明: string;
  /** 来源文件相对任务目录的路径。 */
  source: string;
  /** 段落总数（投影的计数规则）。 */
  paragraphs: number;
  /** 分页标记（w:lastRenderedPageBreak）的个数。 */
  page_marks: number;
  /** 保存文件的软件名（docProps/app.xml 的 Application），读不到时为空文字。只作记录。 */
  application: string;
  /** 每个标题段：段落号、级别（1 是一级）、标题文字（含十进制编号）。 */
  headings: { paragraph: number; level: number; title: string }[];
}

const NOTE = "Word 材料的位置表：由段落号得出来源标签里的章节；规则见 agent/src/lib/docx_locations.ts。"
  + "headings 列出每个标题段，level 1 是一级标题；一段的章节是它（含）之前最近的标题。不含正文的文字。";

/** 写成位置表文件的内容。 */
export function locationFile(input: LocationInput, meta: { source: string; paragraphs: number; application: string }): LocationFile {
  return {
    version: LOCATIONS_FORMAT_VERSION, rules_version: LOCATION_RULES_VERSION, 说明: NOTE, source: meta.source, paragraphs: meta.paragraphs,
    page_marks: pageMarks(input), application: meta.application,
    headings: headingsOf(input).filter((p) => p.heading !== null).map((p) => ({ paragraph: p.n, level: p.heading!, title: p.title })),
  };
}

/**
 * 来源标签里的章节（与页面现有 whereOf 的章节一段相同）：这一段（含）之前最近的标题，任何级别都算；
 * 最近的标题文字为空、或者之前没有标题时为 null。
 */
export function chapterOf(table: Pick<LocationFile, "headings">, n: number): string | null {
  let heading: { paragraph: number; title: string } | undefined;
  for (const h of table.headings) if (h.paragraph <= n && (!heading || h.paragraph > heading.paragraph)) heading = h;
  return heading?.title || null;
}
