// 按原样显示的 Word 与 PDF 从哪里读：任务的材料，或者知识库里的文档。显示部件（DocxPaper、PdfPaper、PdfOutline）与两份缓存
// （docxStore、pdfStore）只认「所属」这一个字符串：材料写任务编号，知识库文档写 knowledgeOwner(知识库编号)，也就是「knowledge/知识库编号」，
// 与知识库来源的出处同一个开头。任务编号里没有斜杠，两种写法不会混。
// 文件名照两边各自的写法：材料是相对路径（inputs/x.pdf），知识库文档是文档名（x.pdf）；由它生成的投影、位置表跟在文件名后面，两边一样。

import { api } from "../api/client";
import { KNOWLEDGE_PREFIX } from "../../../agent/src/lib/knowledge_locator.ts";

/** 知识库文档的所属写法。 */
export const knowledgeOwner = (library: string) => `${KNOWLEDGE_PREFIX}${library}`;

/** 所属是知识库时给出知识库编号，是任务时为 null。 */
const libraryOf = (owner: string): string | null => (owner.startsWith(KNOWLEDGE_PREFIX) ? owner.slice(KNOWLEDGE_PREFIX.length) : null);

/** 一个文件的文字：材料取 …/materials/content，知识库文档取 …/documents/content。 */
export function fileText(owner: string, path: string): Promise<{ text: string }> {
  const library = libraryOf(owner);
  return library !== null ? api.documentText(library, path) : api.materialContent(owner, path);
}

/** 一个文件的原始字节。 */
export function fileRaw(owner: string, path: string): Promise<ArrayBuffer> {
  const library = libraryOf(owner);
  return library !== null ? api.documentRaw(library, path) : api.materialRaw(owner, path);
}

/** 一个文件原始字节的地址（PDF 的退路用 <iframe> 显示时要一个真实地址）。 */
export function fileRawUrl(owner: string, path: string): string {
  const library = libraryOf(owner);
  return library !== null ? api.documentRawUrl(library, path) : api.materialRawUrl(owner, path);
}
