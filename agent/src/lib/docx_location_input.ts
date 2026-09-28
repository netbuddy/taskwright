/**
 * Word 文件 → 位置规则（lib/docx_locations.ts）的输入，以及位置表文件「文件名.docx.locations.json」的内容。
 * 上传 Word 材料时后端在写投影与分段清单的同一处调用 locationTable。
 *
 * 段落号用投影的计数规则（lib/docx_markdown.ts 的 numberParagraphs），编号用投影的数法（paragraphNumbering 与 numberingLevels）。
 * 段落的结构照材料区的排版库 docx-preview 0.4.1 解析 Word 文件的方式整理（它的 parseBodyElements、parseParagraph、parseRun），
 * 因为标题文字与页面现有推导要一致：
 * - 正文里它只收段落、表格与内容控件（摊平）；表格行只收单元格，单元格只收段落与表格。别的容器（例如 w:customXml、
 *   单元格里的内容控件）里的段落它不画，这些段落 drawn 为假，标题照记；
 * - 段落的直接子节点只收文字块、超链接、智能标记、书签与批注范围的首尾、公式、修订插入与删除，内容控件摊平；别的（例如 w:fldSimple）丢掉；
 * - 文字块里只收它认得的子节点；备选内容（mc:AlternateContent）一律取后备（mc:Fallback）的第一个元素；
 * - 带域代码（w:fldChar、w:instrText）的文字块整块不画，但其中的字算进标题文字（页面取标题文字时不管画不画）。
 * 只用 Node 自带模块。
 */

import { type LayoutChild, type LayoutItem, type LayoutParagraph, type LayoutStyle, type LocationFile, type LocationInput, type PageShape, locationFile } from "./docx_locations.ts";
import { type XmlElement, Styles, at, child, elements, numberParagraphs, numberingLevels, paragraphNumbering, parseXml, valOf, zipEntries } from "./docx_markdown.ts";

/** 排版库读开关属性的方式（convertBoolean）：没写为 true；"1"、"true"、"on" 为真，"0"、"false"、"off" 为假。 */
function flag(el: XmlElement | undefined): boolean | undefined {
  if (!el) return undefined;
  const v = el.attrs["w:val"];
  if (v === undefined) return true;
  if (["1", "true", "on"].includes(v)) return true;
  if (["0", "false", "off"].includes(v)) return false;
  return true;
}

const shape = (sect: XmlElement | undefined): PageShape | undefined => {
  if (!sect) return undefined;
  const size = child(sect, "w:pgSz");
  return { width: size?.attrs["w:w"], height: size?.attrs["w:h"], orientation: size?.attrs["w:orient"] };
};

/** 一个元素里全部 w:t 的字（给文本框：它的字不画、不计数，但页面取标题文字时算进去）。 */
function textsIn(el: XmlElement): string {
  let out = "";
  for (const c of elements(el)) out += c.name === "w:t" ? c.children.filter((x): x is string => typeof x === "string").join("") : textsIn(c);
  return out;
}
const textOf = (el: XmlElement) => el.children.filter((x): x is string => typeof x === "string").join("");

/** 备选内容取后备的第一个元素（排版库的 checkAlternateContent，它不认任何 Choice）。 */
const resolve = (c: XmlElement): XmlElement | undefined =>
  c.name === "mc:AlternateContent" ? elements(child(c, "mc:Fallback") ?? { name: "", attrs: {}, children: [] })[0] : c;

/** VML 图（w:pict）里排版库认得的形状：有就画成 svg，算画出来的内容。 */
const VML_SHAPES = new Set(["v:rect", "v:oval", "v:line", "v:shape", "v:textbox"]);

/** 一个文字块的子节点（排版库 parseRun 收的那些，顺序不变）。drawn 为假时整块不画（带域代码，或在修订删除里）。 */
function runItems(r: XmlElement, deleted: boolean): LayoutItem[] {
  const kids = elements(r).map(resolve).filter((c): c is XmlElement => !!c);
  const fieldRun = kids.some((c) => c.name === "w:fldChar" || c.name === "w:instrText");
  const drawn = !fieldRun && !deleted;
  const out: LayoutItem[] = [];
  for (const c of kids) {
    switch (c.name) {
      case "w:t": out.push({ kind: "text", text: textOf(c), drawn, titled: true }); break;
      case "w:sym": {
        const code = parseInt(c.attrs["w:char"] ?? "", 16);
        out.push(Number.isNaN(code) ? { kind: "other" } : { kind: "text", text: String.fromCharCode(code), drawn, titled: false });
        break;
      }
      case "w:br": {
        const type = c.attrs["w:type"];
        out.push(type === "page" ? { kind: "pageBreak" } : { kind: "other" });
        break;
      }
      case "w:lastRenderedPageBreak": out.push({ kind: "mark" }); break;
      case "w:footnoteReference": case "w:endnoteReference": out.push(drawn ? { kind: "solid" } : { kind: "other" }); break;
      case "w:drawing": {
        const wrapper = elements(c).find((e) => e.name === "wp:inline" || e.name === "wp:anchor");
        if (!wrapper) break; // 排版库解析不出东西，不算一个子节点
        const picture = at(wrapper, "a:graphic/a:graphicData/pic:pic");
        out.push(drawn && picture ? { kind: "solid" } : { kind: "other" });
        break;
      }
      case "w:pict": {
        const shown = elements(c).some((e) => VML_SHAPES.has(e.name));
        out.push(drawn && shown ? { kind: "solid" } : { kind: "other" });
        const boxed = textsIn(c);
        if (boxed) out.push({ kind: "text", text: boxed, drawn: false, titled: true });
        break;
      }
      case "w:delText": case "w:commentReference": case "w:fldSimple": case "w:instrText": case "w:fldChar":
      case "w:noBreakHyphen": case "w:tab":
        out.push({ kind: "other" });
        break;
      default:
        break; // 排版库不收的子节点（w:rPr、w:cr、w:softHyphen、w:ptab、w:object 等）
    }
  }
  return out;
}

/** 公式里的字（m:t）：画出来，也算进标题文字。公式自己添的括号等符号不在其中。 */
function mathItems(el: XmlElement): LayoutItem[] {
  const out: LayoutItem[] = [];
  for (const c of elements(el)) {
    if (c.name === "m:t") out.push({ kind: "text", text: textOf(c), drawn: true, titled: true });
    else out.push(...mathItems(c));
  }
  return out;
}

/** 段落（或插入、删除、内容控件这类按段落内容解析的容器）的直接子节点，按排版库 parseParagraph 的收法。 */
function paragraphChildren(el: XmlElement, deleted: boolean): LayoutChild[] {
  const out: LayoutChild[] = [];
  for (const c of elements(el)) {
    switch (c.name) {
      case "w:r": out.push({ run: true, items: runItems(c, deleted) }); break;
      case "w:hyperlink":
        out.push({ run: false, items: elements(c).filter((e) => e.name === "w:r").flatMap((e) => runItems(e, deleted)) });
        break;
      case "w:smartTag": {
        const walk = (tag: XmlElement): LayoutItem[] => elements(tag).flatMap((e) => (e.name === "w:r" ? runItems(e, deleted) : e.name === "w:smartTag" ? walk(e) : []));
        out.push({ run: false, items: walk(c) });
        break;
      }
      case "w:bookmarkStart": case "w:bookmarkEnd": case "w:commentRangeStart": case "w:commentRangeEnd":
        out.push({ run: false, items: [] });
        break;
      case "m:oMath": case "m:oMathPara": out.push({ run: false, items: mathItems(c) }); break;
      case "w:sdt": {
        const content = child(c, "w:sdtContent");
        if (content) out.push(...paragraphChildren(content, deleted));
        break;
      }
      case "w:ins": out.push({ run: false, items: paragraphChildren(c, deleted).flatMap((x) => x.items) }); break;
      case "w:del": out.push({ run: false, items: paragraphChildren(c, true).flatMap((x) => x.items) }); break;
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
  const para = (p: XmlElement, drawn: boolean, inTable: boolean) => {
    const ppr = child(p, "w:pPr");
    const which = paragraphNumbering(p, styles);
    const section = shape(child(ppr, "w:sectPr"));
    paragraphs.push({
      n: numbers.get(p) ?? 0, drawn, inTable,
      style: valOf(p, "w:pPr/w:pStyle"), outline: valOf(p, "w:pPr/w:outlineLvl"),
      ...(which ? { numbering: { numId: which.numId, level: which.ilvl } } : {}),
      ...(flag(child(ppr, "w:pageBreakBefore")) ? { pageBreakBefore: true } : {}),
      ...(section ? { section } : {}),
      children: paragraphChildren(p, false),
    });
  };
  // 按文件里的先后找段落（与投影的 blocksOf 一样：备选内容只看 Choice，不进文本框）；drawn 记排版库画不画它。
  const walk = (el: XmlElement, where: "body" | "row" | "cell" | "table" | "lost", inTable: boolean) => {
    for (const c of elements(el)) {
      if (c.name === "w:p") { para(c, where === "body" || where === "cell", inTable); continue; }
      if (c.name === "w:tbl") { walk(c, where === "body" || where === "cell" ? "table" : "lost", true); continue; }
      if (c.name === "w:tr") { walk(c, where === "table" ? "row" : "lost", inTable); continue; }
      if (c.name === "w:tc") { walk(c, where === "row" ? "cell" : "lost", inTable); continue; }
      if (c.name === "w:sdt" && where === "body") { const content = child(c, "w:sdtContent"); if (content) walk(content, "body", inTable); continue; }
      if (c.name === "mc:AlternateContent") { const choice = child(c, "mc:Choice"); if (choice) walk(choice, "lost", inTable); continue; }
      if (["w:sectPr", "w:tblPr", "w:tblGrid", "mc:Fallback", "w:txbxContent"].includes(c.name)) continue;
      walk(c, "lost", inTable);
    }
  };
  if (body) walk(body, "body", false);

  const styleList: LayoutStyle[] = [];
  const styleRoot = stylesXml ? child(parseXml(stylesXml), "w:styles") : undefined;
  for (const s of styleRoot ? elements(styleRoot) : []) {
    if (s.name !== "w:style" || s.attrs["w:styleId"] === undefined) continue;
    const ppr = child(s, "w:pPr");
    const pbb = flag(child(ppr, "w:pageBreakBefore"));
    styleList.push({
      id: s.attrs["w:styleId"], name: valOf(s, "w:name"), basedOn: valOf(s, "w:basedOn"), outline: valOf(s, "w:pPr/w:outlineLvl"),
      hasParagraphProps: !!ppr, ...(pbb !== undefined ? { pageBreakBefore: pbb } : {}),
    });
  }

  const appXml = read("docProps/app.xml");
  const app = appXml ? child(child(parseXml(appXml), "Properties"), "Application") : undefined;
  return {
    input: {
      paragraphs, styles: styleList,
      levels: [...levels].map(([key, lv]) => { const [numId, level] = key.split(":"); return { ...lv, numId, level: Number(level) }; }),
      bodySection: shape(body ? child(body, "w:sectPr") : undefined) ?? null,
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
