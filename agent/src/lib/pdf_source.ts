/**
 * PDF 材料的来源：从投影取各块、带对照的比较层规范化、摘录落在哪几块的第几个字到第几个字。
 *
 * 两处用同一份规则：保存修订时核对一条 PDF 来源（lib/save_revision.ts），页面在材料区里把摘录逐字标出来。两处各写一份的话，
 * 会出现核对通过而页面标不出来的来源。
 *
 * 出处写成「x.pdf#p页-块」（lib/pdf_locations.ts）。摘录要在那一块里，或者从那一块开始、在同一页之内往后接相邻的至多
 * PDF_SPAN_LIMIT 块；页眉页脚行没有块号，不在各块里，所以天然被跳过。摘录不能跨页：一页写一条来源。
 * 比较之前两边都过比较层的规范化（lib/pdf_normalize.ts 的 comparablePdfText：部首字符换成通用汉字、全角半角归一、去掉空白与连字符），
 * 规范化之后逐字比较。
 *
 * 页面要把规范化之后的位置换回原文的位置，所以另有带对照的版本（comparableWithMap）：规范化之后的每个码元出自原文的哪一截。
 *
 * 页面也导入本文件，所以这里只导入同样不导入任何模块的两个文件，不用 Node 的模块。位置一律是 UTF-16 码元的下标，`string.slice` 可以直接用。
 */

import { PDF_ANCHOR } from "./pdf_locations.ts";
import { comparablePdfText } from "./pdf_normalize.ts";

/** 摘录从出处那一块起，最多再往后接这么多块（与 Word 材料「往后最多接 5 段」相同）。 */
export const PDF_SPAN_LIMIT = 5;

/** 投影里的一块：页、块号、文字、在投影文件的第几行（从 1 起）。块号 0 是「这一页没有文字」那一行，不能作出处。 */
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

// ───────────── 带对照的规范化 ─────────────

/**
 * 一段文字过比较层规范化的结果，连同对照：text 与 comparablePdfText(原文) 逐字相同；text 的第 k 个码元出自原文的
 * start[k] 到 end[k]（不含 end[k]）这一截。原文的一个字规范化成几个字时（例如连字 ﬁ 成了 fi），这几个字指向同一截；
 * 原文里被去掉的字（空白、连字符、看不见的字符）不属于任何一截。
 */
export interface ComparableWithMap { text: string; start: number[]; end: number[] }

const MARK = /^\p{M}$/u;

/** 原文切成一小截一小截：一个字连同跟在它后面的组合记号算一截，规范化不会把它们拆开。返回各截的起点，末尾另加原文的长度。 */
function clusterStarts(original: string): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const ch of original) {
    if (starts.length === 0 || !MARK.test(ch)) starts.push(at);
    at += ch.length;
  }
  starts.push(original.length);
  return starts;
}

/** 带对照的比较层规范化（见 ComparableWithMap）。 */
export function comparableWithMap(original: string): ComparableWithMap {
  const whole = comparablePdfText(original);
  const starts = clusterStarts(original);
  const start: number[] = [];
  const end: number[] = [];
  // 通常的情形：各截各自规范化，接起来就是整段的规范化结果（去空白、去连字符、换部首字符、全角半角归一都只看一个字）。
  let text = "";
  for (let i = 0; i + 1 < starts.length; i++) {
    const piece = comparablePdfText(original.slice(starts[i], starts[i + 1]));
    for (let k = 0; k < piece.length; k++) {
      start.push(starts[i]);
      end.push(starts[i + 1]);
    }
    text += piece;
  }
  if (text === whole) return { text, start, end };
  // 少见的情形：相邻的两截规范化时合成了一个字（例如拆开写的谚文字母合成一个音节），各截自己算的接不成整段的结果。
  // 这时按「原文的前多少截规范化之后有多长」来分：多出来的码元记在刚加进来的那一截上；没有多出来、而这一截自己是有字的，
  // 说明它并进了前一个字，把前一个字的那一截延长到这里。
  start.length = 0;
  end.length = 0;
  for (let i = 0; i + 1 < starts.length; i++) {
    const length = Math.min(whole.length, comparablePdfText(original.slice(0, starts[i + 1])).length);
    if (length > start.length) {
      while (start.length < length) {
        start.push(starts[i]);
        end.push(starts[i + 1]);
      }
    } else if (end.length && comparablePdfText(original.slice(starts[i], starts[i + 1]))) {
      end[end.length - 1] = starts[i + 1];
    }
  }
  // 兜底：万一还少，剩下的记在原文的末尾，不让调用的一方读到没有的下标。
  while (start.length < whole.length) {
    start.push(Math.max(0, original.length - 1));
    end.push(original.length);
  }
  return { text: whole, start, end };
}

// ───────────── 摘录落在哪里 ─────────────

/** 摘录在一块里占的那一截：这一块是各块里的第几个（从 0 起）、它的页与块号、原文里从 start 到 end（不含 end）。 */
export interface PdfExcerptRange { index: number; page: number; block: number; start: number; end: number }

/**
 * 摘录落在哪里：
 * - in：在出处那一块之内；
 * - span：从出处那一块开始，接到了同一页后面的块（ranges 里每块一项，按先后）；
 * - cross_page：在同一页之内找不到，但接上后面几页的块就能找到，也就是摘录跨了页；
 * - miss：找不到（出处那一块不存在、块号是 0、摘录是空的，也都是这一种）。
 */
export type PdfExcerptPlace = { kind: "in" | "span"; ranges: PdfExcerptRange[] } | { kind: "cross_page" } | { kind: "miss" };

/** 各块里页与块号对得上的那一块是第几个（从 0 起）；没有时是 -1。块号 0 不算。 */
export function pdfUnitIndex(units: readonly PdfUnit[], page: number, block: number): number {
  return block < 1 ? -1 : units.findIndex((unit) => unit.page === page && unit.block === block);
}

/** 从第 index 块起往后接：同一页的（samePage 为真时）或者不管哪一页的，块号 0 的不接，最多接 PDF_SPAN_LIMIT 块。 */
function following(units: readonly PdfUnit[], index: number, samePage: boolean): number[] {
  const out: number[] = [];
  for (let i = index + 1; i < units.length && out.length < PDF_SPAN_LIMIT; i++) {
    if (samePage && units[i].page !== units[index].page) break;
    if (units[i].block >= 1) out.push(i);
  }
  return out;
}

/** 在规范化之后的文字上找摘录：落在哪一种、摘录在接起来的文字里从第几个码元开始、接了哪几块（出处那一块在最前）。 */
type Found = { kind: "in" | "span"; at: number; parts: number[] } | { kind: "cross_page" } | { kind: "miss" };

/** textOf(i) 是第 i 块规范化之后的文字，want 是规范化之后的摘录。 */
function find(units: readonly PdfUnit[], textOf: (index: number) => string, index: number, want: string): Found {
  const own = textOf(index);
  const inside = own.indexOf(want);
  if (inside >= 0) return { kind: "in", at: inside, parts: [index] };
  // 摘录要从出处那一块开始：接上后面的块之后，摘录的起点必须落在出处那一块之内。
  const spanning = (others: number[]): { at: number; parts: number[] } | null => {
    let joined = own;
    for (let used = 0; used < others.length; used++) {
      joined += textOf(others[used]);
      const at = joined.indexOf(want);
      if (at >= 0 && at < own.length) return { at, parts: [index, ...others.slice(0, used + 1)] };
    }
    return null;
  };
  const within = spanning(following(units, index, true));
  if (within) return { kind: "span", ...within };
  return spanning(following(units, index, false)) ? { kind: "cross_page" } : { kind: "miss" };
}

/**
 * 摘录在第 page 页第 block 块的哪里（规则见文件开头）。units 是 pdfProjectionUnits 取出的各块。
 * 摘录在这一块里出现不止一次时取第一次。
 */
export function placePdfExcerpt(units: readonly PdfUnit[], page: number, block: number, excerpt: string): PdfExcerptPlace {
  const want = comparablePdfText(excerpt);
  const index = pdfUnitIndex(units, page, block);
  if (!want || index < 0) return { kind: "miss" };
  const found = find(units, (i) => comparablePdfText(units[i].text), index, want);
  if (found.kind === "cross_page" || found.kind === "miss") return found;
  // 找到了才算对照：摘录在接起来的文字里从 at 到 at + want.length，分到各块各自的原文上。
  const ranges: PdfExcerptRange[] = [];
  let offset = 0;
  for (const i of found.parts) {
    const mapped = comparableWithMap(units[i].text);
    const from = Math.max(found.at, offset) - offset;
    const to = Math.min(found.at + want.length, offset + mapped.text.length) - offset;
    if (to > from) ranges.push({ index: i, page: units[i].page, block: units[i].block, start: mapped.start[from], end: mapped.end[to - 1] });
    offset += mapped.text.length;
  }
  return { kind: found.kind, ranges };
}

/** 按上面的规则能找到这段摘录的全部块（摘录从那一块开始、不跨页），按文件里的先后。拒绝一条来源时用它指出摘录其实在哪里。 */
export function pdfUnitsWith(units: readonly PdfUnit[], excerpt: string): { page: number; block: number }[] {
  const want = comparablePdfText(excerpt);
  if (!want) return [];
  // 各块规范化之后的文字只算一遍。
  const texts = units.map((unit) => comparablePdfText(unit.text));
  return units.flatMap((unit, index) => {
    if (unit.block < 1) return [];
    const kind = find(units, (i) => texts[i], index, want).kind;
    return kind === "in" || kind === "span" ? [{ page: unit.page, block: unit.block }] : [];
  });
}
