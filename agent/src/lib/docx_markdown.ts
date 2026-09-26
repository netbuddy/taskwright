/**
 * Word 材料（.docx）的 Markdown 投影：上传 .docx 时在同一目录生成「文件名.docx.md」，执行者读它，保存修订时逐字核对也对着它。
 * 文件里的图片抽到「文件名.docx.media/」下，投影里写成图片链接。后端经 cli/docx_projection.mts 调用这里。
 *
 * 段落号的计数规则与 scripts/docx_paragraphs.mjs、材料区渲染后的回填相同，三处必须一致：
 * - 数 word/document.xml 里 w:body 下的每个 w:p，表格与嵌套表格里的段落也数，纵向合并续格里的空段落照数；
 * - 文本框里的段落（w:txbxContent，wps 一份与 VML 后备一份）不数；脚注、尾注、批注、页眉页脚在别的部件里，不读。
 * 一段的文字是它自己的 w:t（插入的字算，删除的字在 w:delText 里不算，域代码在 w:instrText 里不算，锚在它里面的文本框的字不算）。
 *
 * 投影的写法（每段一行，段落号 [pN] 写在正文前面，它右边就是这一段的正文）：
 * - 标题（大纲级别 0 到 8，取自段落或沿样式继承）写 # 到 ######；Word 自动编号算出的编号写在段落号左边，不算正文；
 * - 列表项写「- 」，编号本身是「1.」这类有序列表标记时直接当标记；下一级缩进三个空格；
 * - 表格一行写一行，第一行当表头；一格里的几段用 <br> 隔开、各带段落号；横向合并跨过的列写（同左），
 *   纵向合并续格写（同上）；嵌在格里的小表格拆开写进外层格子，前面注明（小表第 r 行第 c 列）；
 * - 图片写 ![图 k](文件名.docx.media/imageN.png)，占所在段落的段落号；Word 图表、SmartArt 写一行没有段落号的占位；
 * - 文本框里的字写在所在段落下面的引用块里（> （文本框）……），没有段落号；
 * - 空段落（没有文字也没有图片）不写，段落号照数；段内换行与制表符写成一个空格。
 * 只用 Node 自带模块。
 */

import { inflateRawSync } from "node:zlib";

// ───────────── zip 与 XML ─────────────

/** zip 里的全部文件名 → 读取函数（.docx 只用不压缩与 deflate 两种）。不是 zip 时抛错。 */
export function zipEntries(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const out = new Map<string, () => Buffer>();
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? data : inflateRawSync(data);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export interface XmlElement { name: string; attrs: Record<string, string>; children: XmlNode[] }
export type XmlNode = XmlElement | string;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m);

/** 很小的 XML 解析：元素、属性、文字（含 CDATA）；注释、处理指令、文档类型声明跳过。 */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, cdata, close, name, attrText, selfClose, text] = m;
    const top = stack[stack.length - 1];
    if (cdata !== undefined) top.children.push(cdata);
    else if (text !== undefined) top.children.push(decode(text));
    else if (name) {
      if (close) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of attrText.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? "");
      const el: XmlElement = { name, attrs, children: [] };
      top.children.push(el);
      if (!selfClose) stack.push(el);
    }
  }
  return root;
}

const elements = (el: XmlElement) => el.children.filter((c): c is XmlElement => typeof c !== "string");
const child = (el: XmlElement | undefined, name: string) => el ? elements(el).find((c) => c.name === name) : undefined;
/** 按路径往下找第一个（如 "w:pPr/w:numPr/w:numId"）。 */
function at(el: XmlElement | undefined, path: string): XmlElement | undefined {
  for (const part of path.split("/")) el = child(el, part);
  return el;
}
const valOf = (el: XmlElement | undefined, path: string) => at(el, path)?.attrs["w:val"];
function* descendants(el: XmlElement): Generator<XmlElement> {
  for (const c of elements(el)) { yield c; yield* descendants(c); }
}

// ───────────── 样式、编号、关系 ─────────────

class Styles {
  private byId = new Map<string, XmlElement>();
  constructor(xml: string | null) {
    if (!xml) return;
    const root = child(parseXml(xml), "w:styles");
    for (const s of root ? elements(root) : []) if (s.name === "w:style") this.byId.set(s.attrs["w:styleId"], s);
  }
  /** 段落属性里的一项（如 "w:outlineLvl"），沿 basedOn 往上找。 */
  prop(styleId: string | undefined, path: string): string | undefined {
    for (let id = styleId, i = 0; id && this.byId.has(id) && i < 10; i++) {
      const s = this.byId.get(id)!;
      const v = valOf(s, `w:pPr/${path}`);
      if (v !== undefined) return v;
      id = valOf(s, "w:basedOn");
    }
    return undefined;
  }
}

const CN = "〇一二三四五六七八九";
const chinese = (n: number) => n < 10 ? CN[n] : n < 20 ? "十" + (n % 10 ? CN[n % 10] : "") : n < 100 ? CN[Math.floor(n / 10)] + "十" + (n % 10 ? CN[n % 10] : "") : String(n);
function roman(n: number): string {
  let out = "";
  for (const [v, s] of [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]] as const) {
    while (n >= v) { out += s; n -= v; }
  }
  return out;
}
/** 编号数字按 Word 的编号格式写出来；认不出的格式写十进制。 */
export function formatNumber(n: number, format: string | undefined): string {
  switch (format) {
    case "decimalZero": return String(n).padStart(2, "0");
    case "lowerLetter": return String.fromCharCode(97 + (n - 1) % 26).repeat(Math.floor((n - 1) / 26) + 1);
    case "upperLetter": return String.fromCharCode(65 + (n - 1) % 26).repeat(Math.floor((n - 1) / 26) + 1);
    case "lowerRoman": return roman(n).toLowerCase();
    case "upperRoman": return roman(n);
    case "chineseCounting": case "chineseCountingThousand": case "japaneseCounting": case "taiwaneseCounting": return chinese(n);
    case "ideographTraditional": return "甲乙丙丁戊己庚辛壬癸"[(n - 1) % 10];
    case "decimalEnclosedCircle": case "decimalEnclosedCircleChinese": return n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : String(n);
    case "decimalFullWidth": case "decimalFullWidth2": return [...String(n)].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
    default: return String(n);
  }
}

interface Level { start: number; format?: string; text: string; legal: boolean }

class Numbering {
  private levels = new Map<string, Level>();
  private counters = new Map<string, (number | undefined)[]>();
  constructor(xml: string | null) {
    const root = xml ? child(parseXml(xml), "w:numbering") : undefined;
    if (!root) return;
    const abstract = new Map(elements(root).filter((e) => e.name === "w:abstractNum").map((a) => [a.attrs["w:abstractNumId"], a]));
    for (const num of elements(root).filter((e) => e.name === "w:num")) {
      const a = abstract.get(valOf(num, "w:abstractNumId") ?? "");
      if (!a) continue;
      const overrides = new Map(elements(num).filter((e) => e.name === "w:lvlOverride").map((o) => [o.attrs["w:ilvl"], o]));
      for (const lvl of elements(a).filter((e) => e.name === "w:lvl")) {
        const il = lvl.attrs["w:ilvl"];
        const start = valOf(overrides.get(il), "w:startOverride") ?? valOf(lvl, "w:start") ?? "1";
        this.levels.set(`${num.attrs["w:numId"]}:${il}`, {
          start: Number(start), format: valOf(lvl, "w:numFmt"), text: valOf(lvl, "w:lvlText") ?? "", legal: !!child(lvl, "w:isLgl"),
        });
      }
    }
  }
  /** 这一段的编号文字与是不是项目符号。每套编号（numId）各自计数，上一级加一时更深的级别重新数，与材料区相同。 */
  next(numId: string, ilvl: number): { label: string; bullet: boolean } {
    const lv = this.levels.get(`${numId}:${ilvl}`);
    if (!lv) return { label: "", bullet: false };
    const c = this.counters.get(numId) ?? [];
    this.counters.set(numId, c);
    c[ilvl] = (c[ilvl] ?? lv.start - 1) + 1;
    c.length = ilvl + 1;
    if (lv.format === "bullet") return { label: "", bullet: true };
    if (lv.format === "none") return { label: "", bullet: false };
    const label = lv.text.replace(/%(\d)/g, (_, k: string) => {
      const i = Number(k) - 1;
      const l = this.levels.get(`${numId}:${i}`);
      return formatNumber(c[i] ?? l?.start ?? 1, lv.legal ? "decimal" : l?.format);
    });
    return { label: label.trim(), bullet: false };
  }
}

function relations(xml: string | null): Map<string, string> {
  const out = new Map<string, string>();
  const root = xml ? child(parseXml(xml), "Relationships") : undefined;
  for (const r of root ? elements(root) : []) if (r.attrs.Id && r.attrs.Target) out.set(r.attrs.Id, r.attrs.Target);
  return out;
}

// ───────────── 正文结构 ─────────────

type Piece = { text: string } | { image: number; target: string; alt: string } | { chart: string };
interface Para { kind: "p"; n: number; pieces: Piece[]; boxes: string[][]; heading: number | null; label: string; bullet: boolean; numbered: boolean; ilvl: number }
interface Cell { items: (Para | Table)[]; merged?: "left" | "up" }
interface Table { kind: "table"; rows: Cell[][] }
type Block = Para | Table;

/** 按计数规则给段落编号：w:body 下每个不在文本框里的 w:p，按结束标记的先后（与另两处相同）。 */
function numberParagraphs(body: XmlElement): Map<XmlElement, number> {
  const out = new Map<XmlElement, number>();
  const walk = (el: XmlElement, skip: boolean) => {
    for (const c of elements(el)) {
      const inBox = skip || c.name === "w:txbxContent";
      walk(c, inBox);
      if (c.name === "w:p" && !inBox) out.set(c, out.size + 1);
    }
  };
  walk(body, false);
  return out;
}

interface Parts { styles: Styles; numbering: Numbering; rels: Map<string, string>; numbers: Map<XmlElement, number> }

function paragraph(p: XmlElement, parts: Parts, images: { count: number }): Para {
  const pieces: Piece[] = [];
  const boxes: string[][] = [];
  let alt = "";
  const walk = (el: XmlElement) => {
    for (const c of el.children) {
      if (typeof c === "string") continue;
      switch (c.name) {
        case "w:pPr": case "w:rPr": case "w:delText": case "w:instrText": case "mc:Fallback":
          break;
        case "w:txbxContent": {
          const lines = [...descendants(c)].filter((e) => e.name === "w:p")
            .map((q) => [...descendants(q)].filter((e) => e.name === "w:t").map(textOf).join(""))
            .map(oneLine).filter((s) => s.trim());
          if (lines.length) boxes.push(lines);
          break;
        }
        case "w:t": pieces.push({ text: textOf(c) }); break;
        case "w:tab": if (el.name === "w:r") pieces.push({ text: "\t" }); break;
        case "w:br": case "w:cr":
          if (el.name === "w:r" && c.attrs["w:type"] !== "page" && c.attrs["w:type"] !== "column") pieces.push({ text: "\n" });
          break;
        case "wp:docPr": alt = c.attrs.descr || c.attrs.title || ""; break;
        case "a:blip": case "v:imagedata": {
          const target = parts.rels.get(c.attrs["r:embed"] ?? c.attrs["r:id"] ?? "");
          if (target) pieces.push({ image: ++images.count, target, alt });
          alt = "";
          break;
        }
        case "a:graphicData": {
          const uri = c.attrs.uri ?? "";
          if (/\/chart$/.test(uri)) { pieces.push({ chart: "Word 图表" }); break; }
          if (/\/diagram$/.test(uri)) { pieces.push({ chart: "SmartArt 图示" }); break; }
          walk(c);
          break;
        }
        default: walk(c);
      }
    }
  };
  walk(p);
  const sid = valOf(p, "w:pPr/w:pStyle");
  const outline = valOf(p, "w:pPr/w:outlineLvl") ?? parts.styles.prop(sid, "w:outlineLvl");
  const numId = valOf(p, "w:pPr/w:numPr/w:numId") ?? parts.styles.prop(sid, "w:numPr/w:numId");
  const ilvl = Number(valOf(p, "w:pPr/w:numPr/w:ilvl") ?? parts.styles.prop(sid, "w:numPr/w:ilvl") ?? 0);
  const numbered = !!numId && numId !== "0";
  const { label, bullet } = numbered ? parts.numbering.next(numId!, ilvl) : { label: "", bullet: false };
  return {
    kind: "p", n: parts.numbers.get(p) ?? 0, pieces, boxes, heading: outline !== undefined && Number(outline) < 9 ? Number(outline) : null,
    label, bullet, numbered, ilvl,
  };
}

const textOf = (el: XmlElement): string => el.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
/** 段内换行、制表符写成一个空格（核对时本来就不计空白），保证一段一行。 */
const oneLine = (s: string) => s.replace(/[\t\r\n]+/g, " ");

/** 不进表格的容器（内容控件、修订插入等）里的块，与段落、表格按原顺序摊平。 */
function blocksOf(el: XmlElement, parts: Parts, images: { count: number }, out: Block[] = []): Block[] {
  for (const c of elements(el)) {
    if (c.name === "w:p") out.push(paragraph(c, parts, images));
    else if (c.name === "w:tbl") out.push(table(c, parts, images));
    else if (c.name === "mc:AlternateContent") { const ch = child(c, "mc:Choice"); if (ch) blocksOf(ch, parts, images, out); }
    else if (!["w:sectPr", "w:tblPr", "w:tblGrid", "mc:Fallback"].includes(c.name)) blocksOf(c, parts, images, out);
  }
  return out;
}

/** 在 el 下找某种元素，不进嵌套表格。 */
function within(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of elements(el)) {
    if (c.name === name) out.push(c);
    else if (c.name !== "w:tbl") within(c, name, out);
  }
  return out;
}

function table(tbl: XmlElement, parts: Parts, images: { count: number }): Table {
  const rows: Cell[][] = [];
  for (const tr of within(tbl, "w:tr")) {
    const row: Cell[] = [];
    for (const tc of within(tr, "w:tc")) {
      const span = Number(valOf(tc, "w:tcPr/w:gridSpan") ?? 1);
      const vm = at(tc, "w:tcPr/w:vMerge");
      const up = vm !== undefined && (vm.attrs["w:val"] === undefined || vm.attrs["w:val"] === "continue");
      const items = blocksOf(tc, parts, images).filter((b) => b.kind === "p" || b.kind === "table");
      row.push({ items, ...(up ? { merged: "up" as const } : {}) });
      for (let i = 1; i < span; i++) row.push({ items: [], merged: "left" });
    }
    rows.push(row);
  }
  return { kind: "table", rows };
}

// ───────────── 写 Markdown ─────────────

export const PROJECTION_SUFFIX = ".md";
export const MEDIA_SUFFIX = ".media";

const anchor = (n: number) => `[p${n}]`;

function inline(p: Para, media: string, cell: boolean): string {
  const s = oneLine(p.pieces.map((x) =>
    "text" in x ? x.text : "image" in x ? ` ![图 ${x.image}${x.alt ? `：${oneLine(x.alt)}` : ""}](${media}/${basename(x.target)}) ` : "").join("")).trim();
  return cell ? s.replace(/\|/g, "\\|") : s;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const hasImage = (p: Para) => p.pieces.some((x) => "image" in x);
const charts = (p: Para) => p.pieces.filter((x): x is { chart: string } => "chart" in x).map((x) => `（这里有一个 ${x.chart}，投影里没有转出）`);

/** 一段写成「编号 [pN] 正文」；空段落（没有文字也没有图片）返回 null。 */
function paraLine(p: Para, media: string, cell: boolean, where = ""): string | null {
  const text = inline(p, media, cell);
  if (!text.replace(/\s+/g, "") && !hasImage(p)) return null;
  const label = [where, p.label || (cell && p.bullet ? "•" : "")].filter(Boolean).join(" ");
  return `${label ? label + " " : ""}${anchor(p.n)} ${text}`.trimEnd();
}

function prefix(p: Para): string {
  if (p.heading !== null) return "#".repeat(Math.min(p.heading + 1, 6)) + " ";
  if (p.numbered) return "   ".repeat(p.ilvl) + (/^\d+[.)]$/.test(p.label) ? "" : "- ");
  return "";
}

function cellText(cell: Cell, media: string, where = ""): string {
  if (cell.merged === "left") return "（同左）";
  const segs: string[] = [];
  for (const it of cell.items) {
    if (it.kind === "p") {
      const line = paraLine(it, media, true, where);
      if (line) segs.push(line);
      segs.push(...charts(it));
    } else {
      it.rows.forEach((row, r) => row.forEach((sub, c) => {
        if (sub.merged) return;
        const s = cellText(sub, media, `（小表第 ${r + 1} 行第 ${c + 1} 列）`);
        if (s) segs.push(s);
      }));
    }
  }
  if (!segs.length && cell.merged === "up") return "（同上）";
  return segs.join("<br>");
}

const header = (name: string, rel: string, total: number) => `<!--
由 ${name} 生成，供助手阅读。段落总数：${total}。
每段一行；方括号里的 p 加数字（例如 [p12]）是这一段在 Word 文件里的段落号，它右边到行尾是这一段的正文（表格里到本格的下一个段落号或本格结束）。
# 表示标题级别；段落号左边的编号是 Word 自动编号算出来的，不是正文。空段落不写，段落号照数。
引用这份材料作来源时，出处写 ${rel}#p段落号（例如 ${rel}#p12），摘录逐字抄段落号右边的正文，不带编号、段落号和 #、- 这些标记。
表格按行写；（同左）（同上）是合并单元格；（小表第 r 行第 c 列）是嵌在单元格里的小表格。
![图 k](...) 是文件里的图片，能读图时用 read 读它；以「> （文本框）」开头的行是文本框里的字，没有段落号，不能作出处。
-->
`;

export interface DocxProjection {
  /** 投影全文。 */
  markdown: string;
  /** 按计数规则的段落总数。 */
  paragraphs: number;
  /** 投影里链接到的图片：word/media/ 下的文件名 → 字节。 */
  media: Map<string, Buffer>;
}

/**
 * .docx 的字节 → Markdown 投影。rel 是这份 .docx 相对任务目录的路径（写进开头的说明与图片链接）。
 * 不是合法的 .docx 时抛错，消息是给人看的一句中文。
 */
export function docxProjection(data: Buffer, rel: string): DocxProjection {
  let entries: Map<string, () => Buffer>;
  let doc: XmlElement | undefined;
  try {
    entries = zipEntries(data);
    const main = entries.get("word/document.xml");
    if (!main) throw new Error("no document.xml");
    doc = child(parseXml(main().toString("utf8")), "w:document");
  } catch {
    throw new Error("不是 Word 文件（.docx），或者文件已损坏");
  }
  const read = (name: string) => { const e = entries.get(name); return e ? e().toString("utf8") : null; };
  const body = child(doc, "w:body");
  const numbers = body ? numberParagraphs(body) : new Map<XmlElement, number>();
  const parts: Parts = { styles: new Styles(read("word/styles.xml")), numbering: new Numbering(read("word/numbering.xml")), rels: relations(read("word/_rels/document.xml.rels")), numbers };
  const blocks = body ? blocksOf(body, parts, { count: 0 }) : [];
  const media = rel + MEDIA_SUFFIX;
  const out: string[] = [header(basename(rel), rel, numbers.size)];
  const used = new Map<string, Buffer>();
  let prev: "list" | "other" | null = null;
  const blank = () => { if (out.length) out.push("\n"); };
  const collectImages = (b: Block) => {
    if (b.kind === "p") {
      for (const x of b.pieces) if ("image" in x) { const e = entries.get(`word/${x.target.replace(/^\.?\//, "")}`) ?? entries.get(x.target.replace(/^\//, "")); if (e) used.set(basename(x.target), e()); }
    } else for (const row of b.rows) for (const c of row) c.items.forEach(collectImages);
  };
  for (const b of blocks) {
    collectImages(b);
    if (b.kind === "p") {
      const line = paraLine(b, media, false);
      const extra = charts(b);
      if (line === null && !b.boxes.length && !extra.length) continue;
      const kind = b.numbered && b.heading === null ? "list" : "other";
      if (!(kind === "list" && prev === "list")) blank();
      if (line !== null) out.push(prefix(b) + line + "\n");
      for (const c of extra) out.push(`\n${c}\n`);
      for (const box of b.boxes) out.push("\n" + box.map((t, i) => (i === 0 ? "> （文本框）" : "> ") + t).join("\n") + "\n");
      prev = line !== null && !b.boxes.length && !extra.length ? kind : "other";
    } else {
      blank();
      const width = Math.max(1, ...b.rows.map((r) => r.length));
      if (!b.rows.length) out.push("| （空表格） |\n|---|\n");
      b.rows.forEach((r, i) => {
        const cells = [...r.map((c) => cellText(c, media)), ...Array(width - r.length).fill("")];
        out.push(`| ${cells.join(" | ")} |\n`);
        if (i === 0) out.push(`|${"---|".repeat(width)}\n`);
      });
      prev = "other";
    }
  }
  return { markdown: out.join(""), paragraphs: numbers.size, media: used };
}
