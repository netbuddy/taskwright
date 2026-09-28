/**
 * Word 文件 → 位置规则（lib/docx_locations.ts）的输入，以及位置表文件「文件名.docx.locations.json」的内容。
 * 上传 Word 材料时后端在写投影与分段清单的同一处调用 locationTable。
 *
 * 段落号用投影的计数规则（lib/docx_markdown.ts 的 numberParagraphs），编号用投影的数法（paragraphNumbering 与 numberingLevels）。
 * 段落的结构照材料区的排版库 docx-preview 0.4.1 解析 Word 文件的方式整理（它的 parseBodyElements、parseParagraph、parseRun），
 * 因为标题文字与分页标记的个数要与页面现有推导一致：
 * - 正文里它只收段落、表格与内容控件（摊平）；表格行只收单元格，单元格只收段落与表格。别的容器（例如 w:customXml、
 *   单元格里的内容控件）里的段落它不画，这些段落 drawn 为假，标题照记；
 * - 段落的直接子节点只收文字块、超链接、智能标记、公式、修订插入与删除，内容控件摊平；别的（例如 w:fldSimple）丢掉；
 * - 文字块里的 w:t 都算进标题文字（域代码所在的、修订删除里的也算，页面取标题文字时不管画不画），w:sym 与 w:delText 不算；
 *   备选内容（mc:AlternateContent）一律取后备（mc:Fallback）的第一个元素，VML 文本框（w:pict）里的字算进标题文字。
 * 只用 Node 自带模块。
 */

import { type LayoutItem, type LayoutParagraph, type LayoutStyle, type LocationFile, type LocationInput, locationFile } from "./docx_locations.ts";
import { type XmlElement, Styles, child, elements, numberParagraphs, numberingLevels, paragraphNumbering, parseXml, valOf, zipEntries } from "./docx_markdown.ts";

/** 一个元素里全部 w:t 的字（给文本框：页面取标题文字时算进去）。 */
function textsIn(el: XmlElement): string {
  let out = "";
  for (const c of elements(el)) out += c.name === "w:t" ? textOf(c) : textsIn(c);
  return out;
}
const textOf = (el: XmlElement) => el.children.filter((x): x is string => typeof x === "string").join("");

/** 备选内容取后备的第一个元素（排版库的 checkAlternateContent，它不认任何 Choice）。 */
const resolve = (c: XmlElement): XmlElement | undefined =>
  c.name === "mc:AlternateContent" ? elements(child(c, "mc:Fallback") ?? { name: "", attrs: {}, children: [] })[0] : c;

/** 一个文字块里与位置有关的项：w:t 的字、VML 文本框里的字、分页标记。 */
function runItems(r: XmlElement): LayoutItem[] {
  const out: LayoutItem[] = [];
  for (const c of elements(r).map(resolve)) {
    if (!c) continue;
    if (c.name === "w:t") out.push({ kind: "text", text: textOf(c) });
    else if (c.name === "w:lastRenderedPageBreak") out.push({ kind: "mark" });
    else if (c.name === "w:pict") { const boxed = textsIn(c); if (boxed) out.push({ kind: "text", text: boxed }); }
  }
  return out;
}

/** 公式里的字（m:t）也算进标题文字。 */
function mathItems(el: XmlElement): LayoutItem[] {
  return elements(el).flatMap((c) => (c.name === "m:t" ? [{ kind: "text" as const, text: textOf(c) }] : mathItems(c)));
}

/** 段落（或插入、删除、内容控件这类按段落内容解析的容器）里的项，按排版库 parseParagraph 收的子节点。 */
function paragraphItems(el: XmlElement): LayoutItem[] {
  const out: LayoutItem[] = [];
  for (const c of elements(el)) {
    switch (c.name) {
      case "w:r": out.push(...runItems(c)); break;
      case "w:hyperlink": for (const e of elements(c)) if (e.name === "w:r") out.push(...runItems(e)); break;
      case "w:smartTag": {
        const walk = (tag: XmlElement): LayoutItem[] => elements(tag).flatMap((e) => (e.name === "w:r" ? runItems(e) : e.name === "w:smartTag" ? walk(e) : []));
        out.push(...walk(c));
        break;
      }
      case "m:oMath": case "m:oMathPara": out.push(...mathItems(c)); break;
      case "w:sdt": { const content = child(c, "w:sdtContent"); if (content) out.push(...paragraphItems(content)); break; }
      case "w:ins": case "w:del": out.push(...paragraphItems(c)); break;
      default: break;
    }
  }
  return out;
}

/** 位置规则的输入与两项文件头信息。data 是 .docx 的字节；不是合法的 .docx 时抛错。 */
export function locationInput(data: Buffer): { input: LocationInput; paragraphs: number; application: string } {
  const entries = zipEntries(data);
  const read = (name: string) => { const e = entries.get(name); return e ? e().toString("utf8") : null; };
  const main = read("word/document.xml");
  if (main === null) throw new Error("no document.xml");
  const body = child(child(parseXml(main), "w:document"), "w:body");
  const numbers = body ? numberParagraphs(body) : new Map<XmlElement, number>();
  const stylesXml = read("word/styles.xml");
  const styles = new Styles(stylesXml);
  const levels = numberingLevels(read("word/numbering.xml"));

  const paragraphs: LayoutParagraph[] = [];
  const para = (p: XmlElement, drawn: boolean) => {
    const which = paragraphNumbering(p, styles);
    paragraphs.push({
      n: numbers.get(p) ?? 0, drawn,
      style: valOf(p, "w:pPr/w:pStyle"), outline: valOf(p, "w:pPr/w:outlineLvl"),
      ...(which ? { numbering: { numId: which.numId, level: which.ilvl } } : {}),
      items: paragraphItems(p),
    });
  };
  // 按文件里的先后找段落（与投影的 blocksOf 一样：备选内容只看 Choice，不进文本框）；drawn 记排版库画不画它。
  const walk = (el: XmlElement, where: "body" | "row" | "cell" | "table" | "lost") => {
    for (const c of elements(el)) {
      if (c.name === "w:p") { para(c, where === "body" || where === "cell"); continue; }
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

  const styleList: LayoutStyle[] = [];
  const styleRoot = stylesXml ? child(parseXml(stylesXml), "w:styles") : undefined;
  for (const s of styleRoot ? elements(styleRoot) : []) {
    if (s.name !== "w:style" || s.attrs["w:styleId"] === undefined) continue;
    styleList.push({ id: s.attrs["w:styleId"], name: valOf(s, "w:name"), basedOn: valOf(s, "w:basedOn"), outline: valOf(s, "w:pPr/w:outlineLvl") });
  }

  const appXml = read("docProps/app.xml");
  const app = appXml ? child(child(parseXml(appXml), "Properties"), "Application") : undefined;
  return {
    input: {
      paragraphs, styles: styleList,
      levels: [...levels].map(([key, lv]) => { const [numId, level] = key.split(":"); return { ...lv, numId, level: Number(level) }; }),
    },
    paragraphs: numbers.size,
    application: app ? textOf(app).trim() : "",
  };
}

/** 位置表文件的内容。rel 是 .docx 相对任务目录的路径（写进文件头）。 */
export function locationTable(data: Buffer, rel: string): LocationFile {
  const { input, paragraphs, application } = locationInput(data);
  return locationFile(input, { source: rel, paragraphs, application });
}
