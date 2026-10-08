/**
 * PDF 材料的分段清单：把一份投影（backend/src/pdf_projection.ts 写的「x.pdf.md」）按页分成若干段，每段记起止页与起止行号，
 * 与 Word 材料的分段清单（lib/segments.ts）是同一个用途、同一套参数，文件是材料旁边的「x.pdf.segments.json」。
 *
 * 与 Word 的不同：PDF 没有段落号，定位符是「p页-块」，所以一段记的是起止页（first_page、last_page），数的是块（units）。
 *
 * 段怎样分（参数见 lib/segments.ts 的 SegmentParams）：
 * - 文件有书签目录时，级别不超过 heading_depth 的书签所指的页开始一段，标题是这一页上这样的书签的标题（有几个时用「；」连起来）；
 *   第一个这样的书签之前的页是一段，标题为 null。没有书签目录的材料整份一段。段按页首尾相接，覆盖第 1 页到最后一页。
 * - 块数少于 min_paragraphs 的段并入下一段，最后一段不够时并入前一段；合并后的标题是各段标题依次用「；」连起来。
 * - 块数多于 max_paragraphs 的段在页与页之间切成 ceil(块数 / max_paragraphs) 段左右：每攒够 ceil(块数 / 段数) 块就在这一页结束处切开，
 *   标题相同。一页之内不切，所以单独一页的块数超过上限时这一页自成一段。
 * 块只数有定位符、块号不是 0 的行：页眉页脚没有定位符；「这一页没有文字」那一行的块号是 0，不能被引用。
 *
 * 清单只由投影全文与书签目录（位置表的 headings）算出，两样都在材料旁边，所以随时可以重算。
 * 本模块只用 Node 自带模块。
 */

import { writeFileSync } from "node:fs";
import { PDF_ANCHOR } from "./pdf_locations.ts";
import { type SegmentParams, paramsDigest } from "./segments.ts";

/** 分段清单跟在 PDF 文件路径后面的后缀：x.pdf → x.pdf.segments.json。 */
export const PDF_SEGMENTS_SUFFIX = ".segments.json";
/** 清单文件的格式版本。 */
export const PDF_SEGMENTS_VERSION = 1;

export interface PdfSegmentBlock {
  /** 第几段，从 1 起。 */
  index: number;
  /** 开始这一段的书签标题，几段合并的用「；」连起来；第一个书签之前的那段、没有书签目录的材料是 null。 */
  heading: string | null;
  first_page: number;
  last_page: number;
  /** 这一段在投影文件里的起止行号（从 1 起，与 read 的 offset 同一个数法）。 */
  first_line: number;
  last_line: number;
  /** 这一段里的块数（有定位符、块号不是 0 的行）。 */
  units: number;
  /** 各块文字的字数之和。 */
  chars: number;
}

export interface PdfSegmentList {
  version: number;
  说明: string;
  params_digest: string;
  /** PDF 文件相对任务目录的路径，例如 inputs/x.pdf。 */
  source: string;
  /** 投影相对任务目录的路径，例如 inputs/x.pdf.md。 */
  projection: string;
  /** 总页数（与投影开头的「页数」相同）。 */
  pages: number;
  /** 块的总数（与投影开头的「块总数」相同）。 */
  units: number;
  blocks: PdfSegmentBlock[];
}

const NOTE = "行号只对同目录里当前这份投影文件有效；units 只数有定位符、块号不是 0 的行。";

/** 投影里的一块：页、块号、文字、在投影文件的第几行（从 1 起）。块号 0 是「这一页没有文字」那一行。 */
export interface PdfUnit { page: number; block: number; text: string; line: number }

/** 投影全文 → 各块，按文件里的先后。开头的说明注释、页眉页脚行（以「>」开头）、没有定位符的行不算。 */
export function pdfProjectionUnits(text: string): PdfUnit[] {
  const out: PdfUnit[] = [];
  let inComment = false;
  text.split("\n").forEach((line, i) => {
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      return;
    }
    if (line.trimStart().startsWith("<!--")) {
      if (!line.includes("-->")) inComment = true;
      return;
    }
    const m = PDF_ANCHOR.exec(line);
    if (m) out.push({ page: Number(m[1]), block: Number(m[2]), text: line.slice(m[0].length), line: i + 1 });
  });
  return out;
}

/** 投影开头说明里写的页数；没有写时是 0。 */
export const pdfProjectionPages = (text: string) => Number(/页数：(\d+)/.exec(/<!--[\s\S]*?-->/.exec(text)?.[0] ?? "")?.[1] ?? 0);

interface Draft { headings: string[]; first: number; last: number }

/**
 * 投影全文与书签目录 → 分段清单。source 与 projection 是写进清单的两个相对路径；
 * headings 是位置表里的书签目录（lib/pdf_locations.ts 的 PdfLocationFile.headings），没有时给空数组。
 */
export function buildPdfSegments(
  text: string, params: SegmentParams, source: string, projection: string, headings: { page: number; level: number; title: string }[],
): PdfSegmentList {
  const all = pdfProjectionUnits(text);
  const units = all.filter((u) => u.block > 0);
  const total = all.reduce((most, u) => Math.max(most, u.page), pdfProjectionPages(text));
  const lines = text.split("\n");
  // 每页有几块、多少字，以及这一页在投影里的第一行（「这一页没有文字」那一行也算这一页的行）。
  const unitsOn = new Map<number, number>();
  const charsOn = new Map<number, number>();
  const lineOf = new Map<number, number>();
  for (const u of all) if (!lineOf.has(u.page)) lineOf.set(u.page, u.line);
  for (const u of units) {
    unitsOn.set(u.page, (unitsOn.get(u.page) ?? 0) + 1);
    charsOn.set(u.page, (charsOn.get(u.page) ?? 0) + [...u.text].length);
  }
  const count = (d: Draft) => {
    let c = 0;
    for (let p = d.first; p <= d.last; p++) c += unitsOn.get(p) ?? 0;
    return c;
  };

  // 按书签切：级别不超过 heading_depth 的书签所指的页开始一段。
  const starts = new Map<number, string[]>();
  for (const h of headings) {
    if (h.level > params.heading_depth || h.page < 1 || h.page > total) continue;
    const title = h.title.replace(/\s+/g, " ").trim();
    if (!starts.has(h.page)) starts.set(h.page, []);
    if (title) starts.get(h.page)!.push(title);
  }
  let drafts: Draft[] = [];
  let start = 1;
  let heading: string[] = starts.get(1) ?? [];
  for (const page of [...starts.keys()].sort((a, b) => a - b)) {
    if (page <= start) continue;
    drafts.push({ headings: heading, first: start, last: page - 1 });
    start = page;
    heading = starts.get(page)!;
  }
  if (total >= start) drafts.push({ headings: heading, first: start, last: total });

  // 太小的并入下一段，最后一段不够时并入前一段。
  const merged: Draft[] = [];
  let carry: Draft | null = null;
  for (const d of drafts) {
    const cur: Draft = carry ? { headings: [...carry.headings, ...d.headings], first: carry.first, last: d.last } : d;
    if (count(cur) < params.min_paragraphs) carry = cur;
    else {
      merged.push(cur);
      carry = null;
    }
  }
  if (carry) {
    const prev = merged.pop();
    merged.push(prev ? { headings: [...prev.headings, ...carry.headings], first: prev.first, last: carry.last } : carry);
  }
  drafts = merged;

  // 太大的在页与页之间切开。
  const cut: Draft[] = [];
  for (const d of drafts) {
    const n = count(d);
    if (n <= params.max_paragraphs) {
      cut.push(d);
      continue;
    }
    const size = Math.ceil(n / Math.ceil(n / params.max_paragraphs));
    let first = d.first;
    let seen = 0;
    for (let p = d.first; p < d.last; p++) {
      seen += unitsOn.get(p) ?? 0;
      if (seen >= size) {
        cut.push({ headings: d.headings, first, last: p });
        first = p + 1;
        seen = 0;
      }
    }
    cut.push({ headings: d.headings, first, last: d.last });
  }

  // 起止行号：段从它第一个有行的页的第一行开始，到下一段开始之前最后一个非空行为止（页眉页脚行算在前面那一段里）。
  let bodyStart = 0;
  let inComment = false;
  for (let i = 0; i < lines.length && !bodyStart; i++) {
    if (inComment) { if (lines[i].includes("-->")) inComment = false; continue; }
    if (lines[i].trimStart().startsWith("<!--")) { if (!lines[i].includes("-->")) inComment = true; continue; }
    if (lines[i].trim() !== "") bodyStart = i + 1;
  }
  const lastNonEmpty = (upTo: number) => {
    let i = upTo;
    while (i > 0 && lines[i - 1].trim() === "") i--;
    return i;
  };
  const firstLineOf = (d: Draft, k: number) => {
    if (k === 0) return bodyStart || 1;
    for (let p = d.first; p <= d.last; p++) if (lineOf.has(p)) return lineOf.get(p)!;
    return 0;
  };
  const firstLines = cut.map(firstLineOf);
  const blocks: PdfSegmentBlock[] = cut.map((d, k) => {
    const first = firstLines[k] || (k > 0 ? firstLines[k - 1] : 1);
    const next = firstLines.slice(k + 1).find((s) => s > 0);
    let chars = 0;
    for (let p = d.first; p <= d.last; p++) chars += charsOn.get(p) ?? 0;
    return {
      index: k + 1,
      heading: d.headings.length ? d.headings.join("；") : null,
      first_page: d.first,
      last_page: d.last,
      first_line: first,
      last_line: Math.max(first, lastNonEmpty(next ? next - 1 : lines.length)),
      units: count(d),
      chars,
    };
  });
  return {
    version: PDF_SEGMENTS_VERSION, 说明: NOTE, params_digest: paramsDigest(params), source, projection,
    pages: total, units: units.length, blocks,
  };
}

/** 把清单写成文件（两格缩进的 JSON，末尾换行）。 */
export function writePdfSegments(file: string, list: PdfSegmentList): void {
  writeFileSync(file, JSON.stringify(list, null, 2) + "\n", "utf-8");
}
