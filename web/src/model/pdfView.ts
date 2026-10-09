// 材料区显示 PDF 材料时的几样计算，都不碰页面元素，单独测：
// 每一页留多大的位置、哪几页看得见（只画看得见的页）、适应宽度的比例、一块在页上的矩形换成屏幕上的位置、
// 文字层里哪些文字条目属于一块、一段文字落在文字层的哪几个条目的第几个字到第几个字、选中的文字怎样整理。
//
// 位置表与投影是上传时任务服务写的（agent/src/lib/pdf_locations.ts、pdf_source.ts）：位置表里每一块的矩形是 PDF 坐标
// （原点在页面左下角，单位是点，四个数依次是左、下、右、上）；投影里每块一行文字。页面画出来的文字层由 pdf.js 给，
// 它的每个文字条目带着自己在 PDF 坐标里的起点，所以「一块里有哪些条目」按起点落不落在这一块的矩形里来定。

import type { PdfBox, PdfLocationFile } from "../../../agent/src/lib/pdf_locations";
import { comparableWithMap } from "../../../agent/src/lib/pdf_source";

/**
 * 一页属于书签目录的哪一项（各项里的第几个，从 0 起）；说不准、没有时是 -1。
 * 书签只记着它指向第几页，不记在页上的哪里。所以：没有书签指向这一页时，这一页接着前面最近的那一项，是准的；
 * 正好有一个书签指向这一页时取它；有不止一个书签指向这一页时，这一页上的内容分属几项，按页分不出来，不取。
 */
export function headingOfPage(headings: readonly { page: number }[], page: number): number {
  const here = headings.filter((heading) => heading.page === page).length;
  if (here > 1) return -1;
  let at = -1;
  headings.forEach((heading, i) => { if (heading.page <= page && (at < 0 || heading.page >= headings[at].page)) at = i; });
  return at;
}

/** 来源标签里写的章节：这一页属于书签目录的哪一项的标题；说不准、没有、标题是空的时为 null（标签就只写到页）。 */
export function chapterOfPage(headings: readonly { page: number; title: string }[], page: number): string | null {
  const at = headingOfPage(headings, page);
  return at < 0 ? null : headings[at].title || null;
}

/** 一页的宽高（点）。 */
export interface PageSize { width: number; height: number }

/** 位置表读不到、里面也没有这一页时用的大小：A4 竖放。 */
export const A4: PageSize = { width: 595, height: 842 };
/** 页与页之间留的空（像素）。 */
export const PAGE_GAP = 12;
/** 看得见的页之外，上下各多画几页（滚动时不至于先看到白纸）。 */
export const OVERSCAN = 1;
/** 比例的上下限与按一次「放大」「缩小」乘除的倍数。 */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
export const SCALE_STEP = 1.25;

/**
 * 各页的大小：取位置表里记的（显示出来的宽高，已经按页面自己的旋转算好）；位置表读不到、或者里面没有某一页时，
 * 用 first（第一页实际量到的大小，没有就按 A4）。count 是文件的页数。
 */
export function pageSizes(locations: Pick<PdfLocationFile, "pages"> | null, count: number, first: PageSize | null = null): PageSize[] {
  const fallback = first ?? A4;
  const known = new Map((locations?.pages ?? []).map((page) => [page.page, page]));
  return Array.from({ length: count }, (_, i) => {
    const page = known.get(i + 1);
    return page && page.width > 0 && page.height > 0 ? { width: page.width, height: page.height } : fallback;
  });
}

/** 比例收进上下限，并取到百分之一。 */
export const clampScale = (scale: number): number => Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) * 100) / 100;

/**
 * 适应宽度的比例：让多数页正好与 room 一样宽。按出现得最多的那个页宽来定（一样多时取窄的）：一份竖放的文件里夹着一两页横放的
 * 宽表格时，不能为了那一两页把所有页都缩小；横放的那几页比材料区宽，横向滚动着看。量不到 room 时按原始大小。
 */
export function fitScale(sizes: readonly PageSize[], room: number): number {
  const seen = new Map<number, number>();
  for (const size of sizes) seen.set(Math.round(size.width), (seen.get(Math.round(size.width)) ?? 0) + 1);
  let usual = 0;
  let most = 0;
  for (const [width, times] of seen) if (times > most || (times === most && width < usual)) { usual = width; most = times; }
  return room > 0 && usual > 0 ? clampScale(room / usual) : 1;
}

/** 各页在滚动区里的上沿与高度（像素），以及全部页连同间隔的总高度。 */
export function pageLayout(sizes: readonly PageSize[], scale: number): { tops: number[]; heights: number[]; total: number } {
  const tops: number[] = [];
  const heights: number[] = [];
  let at = 0;
  for (const size of sizes) {
    tops.push(at);
    heights.push(Math.round(size.height * scale));
    at += heights[heights.length - 1] + PAGE_GAP;
  }
  return { tops, heights, total: Math.max(0, at - PAGE_GAP) };
}

/**
 * 要画的页：与看得见的那一段（从 top 起、高 view）有交叠的页，上下各再多画 OVERSCAN 页。返回页码（从 1 起）的首尾；
 * 一页都没有时是 null。量不到看得见的高度（view 为 0）时按只看得见 top 所在的那一页算。
 */
export function visiblePages(layout: { tops: number[]; heights: number[] }, top: number, view: number): { first: number; last: number } | null {
  const count = layout.tops.length;
  if (count === 0) return null;
  const bottom = top + Math.max(view, 1);
  let first = -1;
  let last = -1;
  for (let i = 0; i < count; i++) {
    if (layout.tops[i] + layout.heights[i] > top && layout.tops[i] < bottom) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) {
    // 一页都没有交叠：看得见的那一段落在两页之间的间隔里（算下面那一页），或者滚过了最后一页（算最后一页）。
    const next = layout.tops.findIndex((pageTop) => pageTop >= top);
    first = last = next < 0 ? count - 1 : next;
  }
  return { first: Math.max(1, first + 1 - OVERSCAN), last: Math.min(count, last + 1 + OVERSCAN) };
}

/**
 * 现在看的是第几页：看得见的那一段（从 top 起、高 view）的正中间落在哪一页；落在两页之间的间隔里时算下一页。
 * 量不到看得见的高度时按上沿算。
 */
export function currentPage(layout: { tops: number[]; heights: number[] }, top: number, view = 0): number {
  const at = top + Math.max(0, view) / 2;
  for (let i = 0; i < layout.tops.length; i++) if (layout.tops[i] + layout.heights[i] > at) return i + 1;
  return Math.max(1, layout.tops.length);
}

/** 屏幕上的一个矩形（相对这一页的左上角，像素）。 */
export interface ScreenBox { left: number; top: number; width: number; height: number }

/**
 * 位置表里的一块矩形（PDF 坐标）换成它在这一页上的位置。toScreen 是 pdf.js 给这一页的换算（视口的
 * convertToViewportPoint：一个 PDF 坐标里的点换成页面上的点），缩放与页面自己的旋转都由它算；
 * 矩形的两个对角各换一次，换出来不一定是左上与右下，这里摆正。
 */
export function screenBox(bbox: PdfBox, toScreen: (x: number, y: number) => number[]): ScreenBox {
  const [x0, y0] = toScreen(bbox[0], bbox[1]);
  const [x1, y1] = toScreen(bbox[2], bbox[3]);
  return { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/** 页面还没有画出来时估一块的上沿（按没有旋转算）：只用来先滚到附近，画出来之后按 screenBox 的结果再对准。 */
export function roughTop(bbox: PdfBox, size: PageSize, scale: number): number {
  return Math.max(0, (size.height - bbox[3]) * scale);
}

/** 文字层里的一个文字条目：它的文字、在 PDF 坐标里的起点。index 是它在文字层的元素列表里的位置。 */
export interface LayerItem { index: number; text: string; x: number; y: number }

/** 起点落在这一块矩形里的文字条目（矩形四边各放宽 slack 点），照文字层里的先后。 */
export function itemsInBox(items: readonly LayerItem[], bbox: PdfBox, slack = 2): LayerItem[] {
  return items.filter((item) => item.text !== "" && item.x >= bbox[0] - slack && item.x <= bbox[2] + slack && item.y >= bbox[1] - slack && item.y <= bbox[3] + slack);
}

/** 同样这些条目按阅读的先后排：从上到下（y 大的在前，相差不到 tolerance 点的算同一行），同一行里从左到右。 */
export function readingOrder(items: readonly LayerItem[], tolerance = 3): LayerItem[] {
  return [...items].sort((a, b) => (Math.abs(a.y - b.y) > tolerance ? b.y - a.y : a.x - b.x));
}

/** 一段文字在一个文字条目里占的那一截：第几个条目（文字层的元素列表里的位置）、从第几个码元到第几个码元（不含 end）。 */
export interface LayerRange { index: number; start: number; end: number }

/**
 * needle 这段文字落在这些文字条目的哪里。两边都过比较层的规范化再找（部首字符、全角半角、空白、连字符都不比较），
 * 找到之后按对照回到各条目原来的字上，每个条目一截。找不到时为 null。
 * 条目照给进来的先后接起来找；needle 规范化之后是空的也算找不到。
 */
export function findInItems(items: readonly LayerItem[], needle: string): LayerRange[] | null {
  const want = comparableWithMap(needle).text;
  if (!want) return null;
  let joined = "";
  const origin: { item: number; start: number; end: number }[] = [];
  items.forEach((item, i) => {
    const mapped = comparableWithMap(item.text);
    for (let k = 0; k < mapped.text.length; k++) origin.push({ item: i, start: mapped.start[k], end: mapped.end[k] });
    joined += mapped.text;
  });
  const at = joined.indexOf(want);
  if (at < 0) return null;
  const out: LayerRange[] = [];
  for (const one of origin.slice(at, at + want.length)) {
    const last = out[out.length - 1];
    if (last && last.index === items[one.item].index) {
      last.start = Math.min(last.start, one.start);
      last.end = Math.max(last.end, one.end);
    } else {
      out.push({ index: items[one.item].index, start: one.start, end: one.end });
    }
  }
  return out;
}

/**
 * 一块里的一段文字落在文字层的哪里：先照文字层里的先后找，找不到再按阅读的先后排一遍找（有的 PDF 里文字的先后与版面不一致）。
 * 都找不到时为 null，页面就只框出这一块、不逐字标。
 */
export function findInBlock(items: readonly LayerItem[], bbox: PdfBox, needle: string): LayerRange[] | null {
  const inside = itemsInBox(items, bbox);
  return findInItems(inside, needle) ?? findInItems(readingOrder(inside), needle);
}

/** 文字条目里要标出来的一截，连同怎样标：hit 是定位时的高亮，items 是引用了这一句的条目。 */
export interface Mark { start: number; end: number; hit?: boolean; items?: string[] }

/**
 * 一个文字条目的文字按要标的几截切开：没有标的、被引用的、高亮的。几截重叠时高亮的优先，其次先开始的；
 * 被盖住的部分不再单独标。返回的各段接起来就是原来的文字。
 */
export function splitByMarks(text: string, marks: readonly Mark[]): { text: string; hit?: boolean; items?: string[] }[] {
  const ordered = [...marks].filter((mark) => mark.end > mark.start).sort((a, b) => Number(!!b.hit) - Number(!!a.hit) || a.start - b.start);
  const taken: Mark[] = [];
  for (const mark of ordered) {
    let pieces: Mark[] = [{ ...mark, start: Math.max(0, mark.start), end: Math.min(text.length, mark.end) }];
    for (const have of taken) {
      pieces = pieces.flatMap((piece) => {
        if (have.end <= piece.start || have.start >= piece.end) return [piece];
        const out: Mark[] = [];
        if (piece.start < have.start) out.push({ ...piece, end: have.start });
        if (piece.end > have.end) out.push({ ...piece, start: have.end });
        return out;
      });
    }
    taken.push(...pieces.filter((piece) => piece.end > piece.start));
  }
  taken.sort((a, b) => a.start - b.start);
  const out: { text: string; hit?: boolean; items?: string[] }[] = [];
  let at = 0;
  for (const mark of taken) {
    if (mark.start > at) out.push({ text: text.slice(at, mark.start) });
    out.push({ text: text.slice(mark.start, mark.end), ...(mark.hit ? { hit: true } : {}), ...(mark.items ? { items: mark.items } : {}) });
    at = mark.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

const CJK = "\\u2e80-\\u2fff\\u3001-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";
const BETWEEN_CJK = new RegExp(`(?<=[${CJK}]) (?=[${CJK}])`, "g");

/**
 * 用户在文字层里选中的文字整理成一段话：文字层一行是一个元素，选区跨行时浏览器给的文字里带着换行。
 * 换行换成一个空格（西文的行末要有空格），两个中日韩字符之间的空格去掉，首尾的空白去掉。
 */
export function selectedPdfText(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").replace(BETWEEN_CJK, "").trim();
}
