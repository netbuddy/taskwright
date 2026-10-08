/**
 * 查到的片段交给助手时的原文：按片段记下的位置（knowledge_chunks.ts）从源文字现读，不用片段里存的那份改写过的文字。
 * 助手照这份原文逐字抄摘录，保存修订时系统拿摘录到同一份源文字里逐字核对，所以这里给的必须与核对用的一字不差。
 *
 * - Markdown 与纯文本：源文字里从片段的起点到终点的那一段，与原文逐字节相同，连段与段之间的空行（片段里存的文字把各段用一个
 *   换行接了起来，丢了空行，照它抄的摘录跨两段时会对不上）。
 * - Word 文档：逐段给，每段带段落号，文字照 docx_source.ts 取段文字的办法提取，与核对摘录时用的段文字相同。表格的行也逐段给
 *   （片段里存的带竖线的一行是改写文字，不能当摘录）；另给表格的行结构（哪几格是一行、每格里是哪几段）。片段开头重复了表头行时，
 *   表头另给，它不在片段的位置范围里。
 *
 * - PDF 文档：逐块给，每块带页与块号，文字是投影里那一块的原样文字，与核对摘录时用的块文字相同。
 *
 * 源文字与片段对不上（片段是按另一份内容切的）时，Markdown 与纯文本退回片段里存的文字，exact 为假。
 *
 * 本模块只做计算，不读写文件。
 */

import { type Chunk, type RowCell, documentKind, pieceText } from "./knowledge_chunks.ts";

/** Word 文档的一段。 */
export interface PassageParagraph {
  paragraph: number;
  text: string;
}

/** PDF 文档的一块。 */
export interface PassageUnit {
  page: number;
  block: number;
  text: string;
}

export interface Passage {
  /** Markdown 与纯文本：逐字节的原文；Word 文档与 PDF 文档是 null。 */
  body: string | null;
  /** PDF 文档：各块的页、块号与文字；别的文档是 null。 */
  units: PassageUnit[] | null;
  /** Word 文档：各段的段落号与文字；别的文档是 null。 */
  paragraphs: PassageParagraph[] | null;
  /** Word 片段里表格的各行（每行各格里的段落号，合并格是占位，空格是空文字）；没有表格是 null。 */
  table: RowCell[][] | null;
  /** 片段开头重复的表头行；没有是 null。 */
  header: { first_paragraph: number | null; last_paragraph: number | null; cells: RowCell[]; paragraphs: PassageParagraph[] } | null;
  /** 给出的原文是不是按位置从源文字读出来的。 */
  exact: boolean;
}

/** 一个片段的原文。name 是文档名（看它是哪一种文档），source 是源文字（Word 文档是投影全文）。 */
export function passageOf(name: string, chunk: Chunk, source: string): Passage {
  const kind = documentKind(name);
  if (kind === "pdf") {
    const units = chunk.pieces.map((piece) => ({ page: piece.page ?? 0, block: piece.unit ?? 0, text: pieceText(source, piece) }));
    return { body: null, units, paragraphs: null, table: null, header: null, exact: units.map((one) => one.text).join("\n") === chunk.text };
  }
  if (kind !== "word") {
    // 各截接起来要与片段里存的文字相同，才说明位置是对着这份源文字记的。
    const exact = chunk.pieces.map((piece) => pieceText(source, piece)).join("\n") === chunk.text;
    return { body: exact ? source.slice(chunk.start_offset, chunk.end_offset) : chunk.text, units: null, paragraphs: null, table: null, header: null, exact };
  }
  const paragraphsOf = (pieces: Chunk["pieces"]) => pieces.map((piece) => ({ paragraph: piece.paragraph ?? 0, text: pieceText(source, piece) }));
  return {
    body: null,
    units: null,
    paragraphs: paragraphsOf(chunk.pieces),
    table: chunk.rows ?? null,
    header: chunk.header
      ? { first_paragraph: chunk.header.first_paragraph, last_paragraph: chunk.header.last_paragraph, cells: chunk.header.cells, paragraphs: paragraphsOf(chunk.header.pieces) }
      : null,
    exact: true,
  };
}
