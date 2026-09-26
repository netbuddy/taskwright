// Word 材料的分段清单（上传时后端在材料旁边写的 x.docx.segments.json，格式见 agent 的 lib/segments.ts）与每一节被几个条目引用。
// 材料区的「按章节看引用」用它：清单经材料内容接口读来，引用数由这里从快照里各条目的来源（出处 x.docx#pN）现算，两版后端都不改。
// 界面上把清单里的一块叫「一节」；数的是条目个数（一个条目有几条来源落在同一节也只算一个），与文件名旁「被 N 个条目引用过」同一个口径。

import type { Item } from "../api/types";
import { docxLocator } from "./docx";

export interface SegmentBlock {
  index: number;
  heading: string | null;
  first_paragraph: number;
  last_paragraph: number;
  paragraphs: number;
}

export interface SegmentList {
  version: number;
  blocks: SegmentBlock[];
}

/** 分段清单跟在 Word 文件路径后面的后缀。 */
export const SEGMENTS_SUFFIX = ".segments.json";

/** 材料内容接口返回的文字 → 分段清单；不是合法的清单时是 null（界面上就不显示这一栏）。 */
export function parseSegments(text: string): SegmentList | null {
  try {
    const list = JSON.parse(text) as SegmentList;
    return Array.isArray(list?.blocks) && list.blocks.every((b) => Number.isInteger(b.first_paragraph) && Number.isInteger(b.last_paragraph)) ? list : null;
  } catch {
    return null;
  }
}

export interface SectionRow {
  index: number;
  heading: string | null;
  first: number;
  last: number;
  /** 引用到这一节里某一段的条目个数。 */
  items: number;
}

const samePath = (a: string, b: string) => a === b || a.endsWith(b) || b.endsWith(a);

/** 每一节被几个条目引用：条目的「文档原文」来源里出处是这份 Word 文件加段落号的，按段落号落到节里。 */
export function sectionRows(list: SegmentList, items: Item[], path: string): SectionRow[] {
  const byBlock = list.blocks.map(() => new Set<string>());
  for (const item of items) {
    for (const s of item.sources) {
      if (s.kind !== "文档原文") continue;
      const loc = docxLocator(s.locator);
      if (!loc?.paragraph || !samePath(loc.path, path)) continue;
      const k = list.blocks.findIndex((b) => loc.paragraph! >= b.first_paragraph && loc.paragraph! <= b.last_paragraph);
      if (k >= 0) byBlock[k].add(item.item_id);
    }
  }
  return list.blocks.map((b, k) => ({ index: b.index, heading: b.heading, first: b.first_paragraph, last: b.last_paragraph, items: byBlock[k].size }));
}
