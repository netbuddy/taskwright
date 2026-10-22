// Word 与 PDF 材料的分段清单（上传时后端在材料旁边写的 x.docx.segments.json、x.pdf.segments.json，格式见 agent 的 lib/segments.ts
// 与 lib/pdf_segments.ts）与每一节的去向。材料区的「分段去向」用它：清单经材料内容接口读来，去向由这里从快照里各条目的来源现算，后端不改。
// 界面上把清单里的一块叫「一节」；一节的去向是引用到它的条目编号（业务说明页也是条目，一并列出），去重、按编号排序；
// 一个条目有几条来源落在同一节也只列一次，与文件名旁「被 N 个条目引用过」同一个口径。没有条目引用的一节是「未提取」。

import type { Item } from "../api/types";
import { parsePdfLocator } from "../../../agent/src/lib/pdf_locations";
import { docxLocator } from "./docx";

/** Word 材料清单里的一块：起止段落号。 */
export interface SegmentBlock {
  index: number;
  heading: string | null;
  first_paragraph: number;
  last_paragraph: number;
  paragraphs: number;
}

/** PDF 材料清单里的一块：起止页。 */
export interface PdfSegmentBlock {
  index: number;
  heading: string | null;
  first_page: number;
  last_page: number;
  units: number;
}

export type SegmentList = { version: number; blocks: SegmentBlock[] } | { version: number; blocks: PdfSegmentBlock[] };

/** 分段清单跟在 Word、PDF 文件路径后面的后缀。 */
export const SEGMENTS_SUFFIX = ".segments.json";

const isPdfBlock = (b: SegmentBlock | PdfSegmentBlock): b is PdfSegmentBlock => "first_page" in b;

/** 材料内容接口返回的文字 → 分段清单（Word 的按段、PDF 的按页）；不是合法的清单时是 null（界面上就不显示这一栏）。 */
export function parseSegments(text: string): SegmentList | null {
  try {
    const list = JSON.parse(text) as { version: number; blocks: Record<string, unknown>[] };
    if (!Array.isArray(list?.blocks)) return null;
    const by = (first: string, last: string) => list.blocks.every((b) => Number.isInteger(b[first]) && Number.isInteger(b[last]));
    return by("first_paragraph", "last_paragraph") || by("first_page", "last_page") ? list as unknown as SegmentList : null;
  } catch {
    return null;
  }
}

export interface SectionRow {
  index: number;
  heading: string | null;
  /** 起止段落号（Word）或起止页（PDF），单位见 unit。 */
  first: number;
  last: number;
  unit: "段" | "页";
  /** 引用到这一节的条目编号，去重、按编号排序；没有时这一节是「未提取」。 */
  cited: string[];
}

const samePath = (a: string, b: string) => a === b || a.endsWith(b) || b.endsWith(a);
const byId = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/**
 * 每一节的去向：条目的「文档原文」来源里出处是这份材料加位置的，Word 按段落号（x.docx#p37）、PDF 按页（x.pdf#p3-2 的页）落到节里。
 */
export function sectionRows(list: SegmentList, items: Item[], path: string): SectionRow[] {
  const blocks: (SegmentBlock | PdfSegmentBlock)[] = list.blocks;
  const pdf = blocks.length > 0 && isPdfBlock(blocks[0]);
  const range = (b: SegmentBlock | PdfSegmentBlock): [number, number] =>
    isPdfBlock(b) ? [b.first_page, b.last_page] : [b.first_paragraph, b.last_paragraph];
  const byBlock = blocks.map(() => new Set<string>());
  for (const item of items) {
    for (const s of item.sources) {
      if (s.kind !== "文档原文") continue;
      const loc = pdf ? parsePdfLocator(s.locator) : docxLocator(s.locator);
      const at = loc && ("page" in loc ? loc.page : loc.paragraph);
      if (!loc || !at || !samePath(loc.path, path)) continue;
      const k = blocks.findIndex((b) => { const [first, last] = range(b); return at >= first && at <= last; });
      if (k >= 0) byBlock[k].add(item.item_id);
    }
  }
  return blocks.map((b, k) => {
    const [first, last] = range(b);
    return { index: b.index, heading: b.heading, first, last, unit: pdf ? "页" : "段", cited: [...byBlock[k]].sort(byId) };
  });
}
