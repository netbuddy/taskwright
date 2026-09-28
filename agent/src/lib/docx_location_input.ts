/**
 * Word 文件 → 位置表文件「文件名.docx.locations.json」的内容（格式与章节的查法在 lib/docx_locations.ts）。
 * 上传 Word 材料时后端在写投影与分段清单的同一处调用 locationTable。
 *
 * 标题段与标题文字直接取投影算出的（lib/docx_markdown.ts 的 docxProjection 返回的 headings），这里不另算。
 * 这里只数分页标记（w:lastRenderedPageBreak）的个数，数法照材料区的排版库 docx-preview 0.4.1 解析 Word 文件的方式
 * （它的 parseBodyElements、parseParagraph、parseRun），与页面里的计数相同：
 * - 正文里它只收段落、表格与内容控件（摊平）；表格行只收单元格，单元格只收段落与表格。别的容器（例如 w:customXml、
 *   单元格里的内容控件）里的段落它不画，其中的分页标记不数；
 * - 段落里只看文字块、超链接、智能标记、修订插入与删除、内容控件（摊平）里的文字块；备选内容（mc:AlternateContent）取后备。
 * 只用 Node 自带模块。
 */

import { type LayoutParagraph, type LocationFile, locationFile, pageMarks } from "./docx_locations.ts";
import { type DocxProjection, type XmlElement, child, docxProjection, elements, numberParagraphs, parseXml, zipEntries } from "./docx_markdown.ts";

const textOf = (el: XmlElement) => el.children.filter((x): x is string => typeof x === "string").join("");

/** 备选内容取后备的第一个元素（排版库的 checkAlternateContent，它不认任何 Choice）。 */
const resolve = (c: XmlElement): XmlElement | undefined =>
  c.name === "mc:AlternateContent" ? elements(child(c, "mc:Fallback") ?? { name: "", attrs: {}, children: [] })[0] : c;

const runMarks = (r: XmlElement) => elements(r).map(resolve).filter((c) => c?.name === "w:lastRenderedPageBreak").length;

/** 段落（或插入、删除、内容控件这类按段落内容解析的容器）里分页标记的个数，按排版库 parseParagraph 收的子节点。 */
function paragraphMarks(el: XmlElement): number {
  let marks = 0;
  for (const c of elements(el)) {
    switch (c.name) {
      case "w:r": marks += runMarks(c); break;
      case "w:hyperlink": for (const e of elements(c)) if (e.name === "w:r") marks += runMarks(e); break;
      case "w:smartTag": {
        const walk = (tag: XmlElement): number => elements(tag).reduce((k, e) => k + (e.name === "w:r" ? runMarks(e) : e.name === "w:smartTag" ? walk(e) : 0), 0);
        marks += walk(c);
        break;
      }
      case "w:sdt": { const content = child(c, "w:sdtContent"); if (content) marks += paragraphMarks(content); break; }
      case "w:ins": case "w:del": marks += paragraphMarks(c); break;
      default: break;
    }
  }
  return marks;
}

/** 各段的分页标记情况与段落总数。data 是 .docx 的字节；不是合法的 .docx 时抛错。 */
export function layoutParagraphs(data: Buffer): { paragraphs: LayoutParagraph[]; total: number; application: string } {
  const entries = zipEntries(data);
  const read = (name: string) => { const e = entries.get(name); return e ? e().toString("utf8") : null; };
  const main = read("word/document.xml");
  if (main === null) throw new Error("no document.xml");
  const body = child(child(parseXml(main), "w:document"), "w:body");
  const numbers = body ? numberParagraphs(body) : new Map<XmlElement, number>();
  const paragraphs: LayoutParagraph[] = [];
  // 按文件里的先后找段落（与投影一样：备选内容只看 Choice，不进文本框）；drawn 记排版库画不画它。
  const walk = (el: XmlElement, where: "body" | "row" | "cell" | "table" | "lost") => {
    for (const c of elements(el)) {
      if (c.name === "w:p") { paragraphs.push({ n: numbers.get(c) ?? 0, drawn: where === "body" || where === "cell", marks: paragraphMarks(c) }); continue; }
      if (c.name === "w:tbl") { walk(c, where === "body" || where === "cell" ? "table" : "lost"); continue; }
      if (c.name === "w:tr") { walk(c, where === "table" ? "row" : "lost"); continue; }
      if (c.name === "w:tc") { walk(c, where === "row" ? "cell" : "lost"); continue; }
      if (c.name === "w:sdt" && where === "body") { const content = child(c, "w:sdtContent"); if (content) walk(content, "body"); continue; }
      if (c.name === "mc:AlternateContent") { const choice = child(c, "mc:Choice"); if (choice) walk(choice, "lost"); continue; }
      if (["w:sectPr", "w:tblPr", "w:tblGrid", "mc:Fallback", "w:txbxContent"].includes(c.name)) continue;
      walk(c, "lost");
    }
  };
  if (body) walk(body, "body");
  const appXml = read("docProps/app.xml");
  const app = appXml ? child(child(parseXml(appXml), "Properties"), "Application") : undefined;
  return { paragraphs, total: numbers.size, application: app ? textOf(app).trim() : "" };
}

/** 位置表文件的内容。rel 是 .docx 相对任务目录的路径（写进文件头）；projection 是已经算好的投影（不给时现算一份）。 */
export function locationTable(data: Buffer, rel: string, projection: DocxProjection = docxProjection(data, rel)): LocationFile {
  const { paragraphs, total, application } = layoutParagraphs(data);
  return locationFile({ source: rel, paragraphs: total, application, page_marks: pageMarks(paragraphs), headings: projection.headings });
}
