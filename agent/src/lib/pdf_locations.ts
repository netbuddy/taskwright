/**
 * PDF 材料的定位符与位置表（「文件名.pdf.locations.json」）：两样的格式，以及由位置表查一块在页上的位置、查一页所在的章节。
 * 后端解析 PDF 时写位置表（backend/src/pdf_projection.ts）。不依赖任何模块（也不依赖 Node 自带模块），页面可以直接引用。
 *
 * 定位符「p页-块」：PDF 里没有文件自己声明的段落，投影把每页的文字按版面接成若干块，页从 1 起，块在每页里从 1 起。
 * 投影里每块一行，行首写「[p页-块]」；来源的出处写「文件.pdf#p页-块」。块号 0 不是一块文字，只用在「这一页没有文字」那一行上，不能作出处。
 *
 * 位置表记每一页的宽高、每一块在页上的矩形，以及文件的书签目录。矩形是 PDF 的坐标（原点在页面左下角，单位是点），
 * 四个数依次是左、下、右、上；页面把它换成屏幕上的位置来滚动与标出这一块。每页重复的页眉页脚不算块，不在位置表里。
 * 章节只来自书签目录：文件没有书签目录时 headings 为空，不按字号猜标题。
 *
 * 规则版本 PDF_LOCATION_RULES_VERSION：怎样把文字接成行与块、哪些算页眉页脚、哪些页算没有文字，任何一条改变时加一；
 * 位置表文件头里记着它。一份文件的块号在上传时定下，以后不重算，规则改变只影响以后上传的文件。
 */

/** 分块规则的版本；规则任何一条改变时加一（见开头的说明）。 */
export const PDF_LOCATION_RULES_VERSION = 1;
/** 位置表文件的格式版本（字段怎样写）；与规则版本分开。 */
export const PDF_LOCATIONS_FORMAT_VERSION = 1;
export const PDF_LOCATIONS_SUFFIX = ".locations.json";
/** 文件名是不是 PDF 材料的位置表（x.pdf.locations.json，不分大小写）。 */
export const isPdfLocationTable = (name: string) => name.toLowerCase().endsWith(".pdf" + PDF_LOCATIONS_SUFFIX);

// ───────────── 定位符 ─────────────

/** 出处是 PDF 材料时的形状：路径，加可选的「#p页-块」。 */
export const PDF_LOCATOR = /^(.+\.pdf)(?:#p(\d+)-(\d+))?$/i;
/** 投影一行开头的定位符「[p页-块]」，后面可以跟一个空格。 */
export const PDF_ANCHOR = /^\[p(\d+)-(\d+)\] ?/;

/** 投影里写在一块前面的定位符。 */
export const pdfAnchor = (page: number, block: number) => `[p${page}-${block}]`;

/** 出处拆成路径、页与块；没写「#p页-块」时页与块是 null；不是 PDF 材料的出处返回 null。 */
export function parsePdfLocator(locator: string): { path: string; page: number | null; block: number | null } | null {
  const m = PDF_LOCATOR.exec(locator);
  if (!m) return null;
  return { path: m[1], page: m[2] === undefined ? null : Number(m[2]), block: m[3] === undefined ? null : Number(m[3]) };
}

// ───────────── 位置表文件（「文件名.pdf.locations.json」） ─────────────

/** 一块在页上的矩形：左、下、右、上（PDF 坐标，原点在页面左下角，单位是点）。 */
export type PdfBox = [number, number, number, number];

export interface PdfPageLocation {
  /** 第几页，从 1 起。 */
  page: number;
  /** 页面的宽与高（点；已经按页面自己的旋转方向算好，就是显示出来的宽高）。 */
  width: number;
  height: number;
  /** 页面自己的旋转角度（0、90、180、270）；矩形是旋转之前的坐标，页面显示时由显示库一并换算。 */
  rotate: number;
  /** 这一页没有读出文字而且画了图片（多半是扫描件）。 */
  no_text: boolean;
  /** 这一页的各块：块号（从 1 起）与矩形。 */
  blocks: { block: number; bbox: PdfBox }[];
}

export interface PdfLocationFile {
  version: number;
  rules_version: number;
  说明: string;
  /** 来源文件相对任务目录的路径。 */
  source: string;
  /** 解析用的库与版本。只作记录。 */
  engine: string;
  /** 文件自己记的生成软件（PDF 信息里的 Producer，没有时取 Creator），读不到时为空文字。只作记录。 */
  producer: string;
  pages: PdfPageLocation[];
  /** 书签目录的各项：指向第几页、级别（1 是一级）、标题文字；按文件里的先后。没有书签目录时为空。 */
  headings: { page: number; level: number; title: string }[];
}

const NOTE = "PDF 材料的位置表：由定位符「p页-块」得出这一块在页上的位置与所在的章节；规则见 agent/src/lib/pdf_locations.ts。"
  + "pages 列出每一页的宽高与各块的矩形（左、下、右、上，PDF 坐标，原点在页面左下角）；no_text 为真的页没有读出文字。"
  + "headings 取自文件的书签目录，level 1 是一级；一页的章节是指向它（含）之前最近的一项。不含正文的文字。";

/** 写成位置表文件的内容。 */
export function pdfLocationFile(meta: Pick<PdfLocationFile, "source" | "engine" | "producer" | "pages" | "headings">): PdfLocationFile {
  return {
    version: PDF_LOCATIONS_FORMAT_VERSION, rules_version: PDF_LOCATION_RULES_VERSION, 说明: NOTE, source: meta.source,
    engine: meta.engine, producer: meta.producer, pages: meta.pages, headings: meta.headings,
  };
}

/** 位置表写成文件的文字：两格缩进的 JSON，每一块（块号与矩形）、书签目录的每一项各写在一行里，末尾换行。 */
export function pdfLocationsJson(table: PdfLocationFile): string {
  return JSON.stringify(table, null, 2)
    .replace(/\{\s+"block": (\d+),\s+"bbox": \[\s+([-\d.]+),\s+([-\d.]+),\s+([-\d.]+),\s+([-\d.]+)\s+\]\s+\}/g, '{ "block": $1, "bbox": [$2, $3, $4, $5] }')
    .replace(/\{\s+"page": (\d+),\s+"level": (\d+),\s+"title": ("(?:[^"\\]|\\.)*")\s+\}/g, '{ "page": $1, "level": $2, "title": $3 }') + "\n";
}

/** 一块在页上的矩形；位置表里没有这一页或这一块时为 null。 */
export function pdfBlockBox(table: Pick<PdfLocationFile, "pages">, page: number, block: number): PdfBox | null {
  return table.pages.find((p) => p.page === page)?.blocks.find((b) => b.block === block)?.bbox ?? null;
}

/**
 * 来源标签里的章节：书签目录里指向这一页（含）之前最近的一项，任何级别都算；同一页有几项时取最后一项。
 * 那一项的标题文字为空、之前没有任何一项、或者文件没有书签目录时为 null。
 */
export function pdfChapterOf(table: Pick<PdfLocationFile, "headings">, page: number): string | null {
  let heading: { page: number; title: string } | undefined;
  for (const h of table.headings) if (h.page <= page && (!heading || h.page >= heading.page)) heading = h;
  return heading?.title || null;
}
