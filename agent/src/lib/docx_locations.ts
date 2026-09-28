/**
 * Word 材料的位置表（「文件名.docx.locations.json」）：文件的格式、由它得出来源标签里的章节（chapterOf）、分页标记的个数。
 * 后端上传时写它（lib/docx_location_input.ts），页面显示来源标签时读它。不依赖任何模块（也不依赖 Node 自带模块），前端直接引用。
 *
 * 位置表记的标题就是投影里写成标题行的那些段落（lib/docx_markdown.ts 的 docxProjection 返回的 headings），标题文字与投影的
 * 标题行出自同一个函数：自动编号（任何格式）加标题文字。表格里的段落不写成标题。章节是这一段（含）之前最近的标题，任何级别都算，
 * 与分段参数无关。页码与页内位置不在位置表里（页面从显示结果里数出）。
 *
 * 规则版本 LOCATION_RULES_VERSION：哪些段落算标题、标题文字怎样写、章节怎样推出，任何一条改变时加一；位置表文件头里记着它。
 * 版本 2：标题与标题文字改为取投影的（以前另有一套取法，只带十进制编号）。
 */

/** 位置规则的版本；规则任何一条改变时加一（见开头的说明）。 */
export const LOCATION_RULES_VERSION = 2;

/** 一段里分页标记的情况：段落号、材料区的排版库画不画它（customXml 里的、单元格里内容控件中的段落不画）、其中分页标记的个数。 */
export interface LayoutParagraph { n: number; drawn: boolean; marks: number }

/** 分页标记（w:lastRenderedPageBreak）的个数：在排版库画的段落里数，含表格里的，与页面 prepare 里的 marks 相同。 */
export function pageMarks(paragraphs: LayoutParagraph[]): number {
  let marks = 0;
  for (const p of paragraphs) if (p.drawn) marks += p.marks;
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
  /** 每个标题段：段落号、级别（1 是一级）、标题文字（与投影的标题行相同：编号加标题文字）。 */
  headings: { paragraph: number; level: number; title: string }[];
}

const NOTE = "Word 材料的位置表：由段落号得出来源标签里的章节；规则见 agent/src/lib/docx_locations.ts。"
  + "headings 列出投影里写成标题行的段落，level 1 是一级标题，title 与投影的标题行相同（编号加标题文字）；一段的章节是它（含）之前最近的标题。不含正文的文字。";

/** 写成位置表文件的内容。headings 是投影算出的标题段（docxProjection 的 headings）。 */
export function locationFile(meta: { source: string; paragraphs: number; application: string; page_marks: number; headings: LocationFile["headings"] }): LocationFile {
  return {
    version: LOCATIONS_FORMAT_VERSION, rules_version: LOCATION_RULES_VERSION, 说明: NOTE, source: meta.source, paragraphs: meta.paragraphs,
    page_marks: meta.page_marks, application: meta.application, headings: meta.headings,
  };
}

/**
 * 来源标签里的章节：这一段（含）之前最近的标题，任何级别都算；
 * 最近的标题文字为空、或者之前没有标题时为 null。
 */
export function chapterOf(table: Pick<LocationFile, "headings">, n: number): string | null {
  let heading: { paragraph: number; title: string } | undefined;
  for (const h of table.headings) if (h.paragraph <= n && (!heading || h.paragraph > heading.paragraph)) heading = h;
  return heading?.title || null;
}
