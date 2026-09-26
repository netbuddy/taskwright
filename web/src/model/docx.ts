// Word 材料（.docx）在材料区按原版式分页显示（docx-preview 0.4.1，版本钉死），以及由段落号派生给人看的「第几页 · 哪一节 · 页上中下」。
//
// 段落号的计数规则与投影（agent 的 lib/docx_markdown.ts）、scripts/docx_paragraphs.mjs 相同：正文里的段落，
// 含表格与嵌套表格里的，不含文本框里的。库里的来源存段落号（inputs/x.docx#p37），页、章节、位置只在这里派生，不入库。
//
// 分页开着时 docx-preview 有几处要修补（渲染前改解析树、渲染后整理页面，详见 prepare 与 arrangePages 的说明）：
// 分页标记处把一段拆成两个元素、空的前一半与空页、后面的节不沿用页眉页脚、页码域照抄、带上标的注释引用登记两次。

import { defaultOptions, parseAsync, renderDocument } from "docx-preview";

/** 注释引用的上标数字与普通上标都画成 sup；注释引用的唯一子节点是字符串，据此加 class，回填与查找时跳过。 */
function h(props: Parameters<typeof defaultOptions.h>[0]): Node {
  const el = defaultOptions.h(props);
  if (typeof props === "object" && !(props instanceof Node) && props.tagName === "sup" && props.children?.length === 1
    && typeof props.children[0] === "string" && el instanceof Element) el.classList.add("tw-noteref");
  return el;
}

export const RENDER_OPTIONS = {
  h, inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false, ignoreWidth: true, ignoreHeight: true,
  renderChanges: false, renderComments: false, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
};

/** 一段是不是标题（大纲级别）与标题怎么写（「3.2 借阅规则」）。 */
export interface ParagraphInfo { heading: number | null; title: string }

export interface RenderedDocx {
  root: HTMLElement;
  /** paras[N]：第 N 段渲染出来的元素，一般一个，被分页拆开的两个。下标 0 不用。 */
  paras: HTMLElement[][];
  info: (ParagraphInfo | null)[];
  /** 文件里分页标记的个数；为 0 时不写「第几页」。 */
  marks: number;
}

// docx-preview 的解析树没有类型声明，这里只用到几个字段。
/* eslint-disable @typescript-eslint/no-explicit-any */
type Node0 = any;

/**
 * 渲染之前，在解析树上：
 * 1. 按计数规则给每段打上 class「tw-p tw-pn-N」；分页拆开的后一半是前一半的浅拷贝，带着同一个 class，渲染后据此认回同一段；
 * 2. 记下每段的大纲级别与标题编号（只认十进制编号，如 3.2；别的编号格式只取标题文字）；
 * 3. 后面的节没写自己的页眉页脚时沿用前一节的（Word 这样显示，docx-preview 不沿用）；
 * 4. 页眉页脚里 PAGE、NUMPAGES 域的显示结果打上 class，渲染后填真页码与总页数（docx-preview 照抄保存时的结果）；
 * 5. 脚注尾注引用所在文字块的上标格式去掉：带上标的文字块会被渲染两次，注释因此登记两次（引用号变 2、注释列两遍）；引用本来就画成上标。
 */
export function prepare(d: Node0): { info: (ParagraphInfo | null)[]; marks: number } {
  const styles = new Map<string, Node0>((d.stylesPart?.styles ?? []).map((s: Node0) => [s.id, s]));
  const fromStyle = (id: string | undefined, key: string) => {
    for (let s = id ? styles.get(id) : undefined, i = 0; s && i < 10; s = styles.get(s.basedOn), i++) {
      if (s.paragraphProps?.[key] != null) return s.paragraphProps[key];
    }
    return undefined;
  };
  const levels = new Map<string, Node0>((d.numberingPart?.domNumberings ?? []).map((l: Node0) => [`${l.id}:${l.level}`, l]));
  const counters = new Map<string, number[]>();
  const info: (ParagraphInfo | null)[] = [null];
  let marks = 0;
  const textOf = (e: Node0): string => (e.type === "text" ? e.text : e.type === "deletedText" ? "" : (e.children ?? []).map(textOf).join(""));
  const countMarks = (e: Node0) => {
    if (e.type === "break" && e.break === "lastRenderedPageBreak") marks++;
    (e.children ?? []).forEach(countMarks);
  };
  const para = (p: Node0) => {
    const n = info.length;
    p.className = [p.className, "tw-p", `tw-pn-${n}`].filter(Boolean).join(" ");
    countMarks(p);
    const num = p.numbering ?? fromStyle(p.styleName, "numbering");
    let label = "";
    if (num) {
      const c = counters.get(num.id) ?? [];
      counters.set(num.id, c);
      const lv = levels.get(`${num.id}:${num.level}`);
      c[num.level] = (c[num.level] ?? Number(lv?.start ?? 1) - 1) + 1;
      c.length = num.level + 1;
      let decimal = !!lv;
      label = String(lv?.levelText ?? "").replace(/%(\d)/g, (_, k: string) => {
        const l = levels.get(`${num.id}:${Number(k) - 1}`);
        if (l?.format !== "decimal") decimal = false;
        return String(c[Number(k) - 1] ?? l?.start ?? 1);
      });
      if (!decimal) label = "";
    }
    const outline = p.outlineLevel ?? fromStyle(p.styleName, "outlineLevel");
    info.push({ heading: outline != null && outline < 9 ? outline : null, title: [label, textOf(p).trim()].filter(Boolean).join(" ") });
  };
  const blocks = (els: Node0[] | undefined) => {
    for (const e of els ?? []) {
      if (e.type === "paragraph") para(e);
      else if (e.type === "table" || e.type === "row" || e.type === "cell") blocks(e.children);
    }
  };
  const body = d.documentPart.body;
  blocks(body.children);

  const dropNoteVertAlign = (e: Node0) => {
    if (e.type === "run" && e.verticalAlign && e.children?.some((c: Node0) => c.type === "footnoteReference" || c.type === "endnoteReference")) delete e.verticalAlign;
    (e.children ?? []).forEach(dropNoteVertAlign);
  };
  dropNoteVertAlign(body);

  const sects = [...body.children.filter((c: Node0) => c.type === "paragraph" && c.sectionProps).map((c: Node0) => c.sectionProps), body.props].filter(Boolean);
  for (let i = 1; i < sects.length; i++) {
    for (const k of ["headerRefs", "footerRefs"]) if (!sects[i][k]?.length) sects[i][k] = sects[i - 1][k];
  }

  for (const part of d.parts ?? []) {
    const root = part.rootElement;
    if (root?.type !== "header" && root?.type !== "footer") continue;
    let instr = "";
    let state = "";
    const walk = (e: Node0) => {
      if (e.type === "complexField") {
        if (e.charType === "begin") { state = "instr"; instr = ""; } else if (e.charType === "separate") state = "result"; else if (e.charType === "end") state = "";
        return;
      }
      if (e.type === "instruction" && state === "instr") instr += e.text;
      if (e.type === "run" && !e.fieldRun && state === "result") {
        const kind = instr.trim().split(/\s+/)[0].toUpperCase();
        if (kind === "PAGE" || kind === "NUMPAGES") e.className = [e.className, `tw-fld-${kind.toLowerCase()}`].filter(Boolean).join(" ");
      }
      (e.children ?? []).forEach(walk);
    };
    walk(root);
  }
  return { info, marks };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const isEmpty = (el: Element) => !el.textContent?.trim() && !el.querySelector("img, svg, table, .tw-textbox");

/**
 * 渲染之后按页整理（只动结构，不看样式，页面外的元素里也能做）：
 * 1. 分页标记在段首时（Word 的常态），docx-preview 在上一页留下一个没有内容的前一半（空标题还带编号），去掉；
 * 2. 因此变空的页（硬分页符后面紧跟分页标记时，会多出一张只有空标题的页）整页去掉；
 * 3. 每页记下页号（data-page），页眉页脚里的页码域填真页码与总页数。
 * 返回 paras：paras[N] 是第 N 段渲染出来的元素。
 */
export function arrangePages(root: HTMLElement): HTMLElement[][] {
  const paras: HTMLElement[][] = [];
  for (const el of root.querySelectorAll<HTMLElement>("section.docx > article p.tw-p")) {
    const n = Number(/\btw-pn-(\d+)\b/.exec(el.className)?.[1]);
    (paras[n] ??= []).push(el);
  }
  const touched = new Set<Element>();
  for (const parts of paras) {
    if (!parts || parts.length < 2) continue;
    for (const el of [...parts]) {
      if (parts.length > 1 && isEmpty(el)) {
        const sheet = el.closest("section.docx");
        if (sheet) touched.add(sheet);
        el.remove();
        parts.splice(parts.indexOf(el), 1);
      }
    }
  }
  for (const s of touched) if ([...s.querySelectorAll(":scope > article")].every(isEmpty)) s.remove();
  const pages = [...root.querySelectorAll<HTMLElement>("section.docx")];
  pages.forEach((s, i) => {
    s.dataset.page = String(i + 1);
    s.querySelectorAll(".tw-fld-page").forEach((e) => { e.textContent = String(i + 1); });
    s.querySelectorAll(".tw-fld-numpages").forEach((e) => { e.textContent = String(pages.length); });
  });
  return paras;
}

/**
 * 只为显示的修补（要在挂到页面上之后做，行高要读计算后的样式）：
 * 1. 文本框：docx-preview 只画 VML 那一份，画成 svg 里的 rect 套 foreignObject，字显示不出来，还绝对定位压在正文上；
 *    换成一个靠右浮动的普通方框，宽度、底色照原样，里面的段落搬进来（不带 tw-p，不计数）。
 * 2. 行距：段落与文字的行高低于字号的 1.4 倍时抬到 1.4 倍（中文单倍行距太挤），更大的照原样。
 * 3. 顶层表格套一层可横向滚动的框：比材料区宽的表格出横向滚动条，不缩放（图片由样式按比例缩小）。
 */
export function polish(root: HTMLElement): void {
  for (const svg of root.querySelectorAll<SVGElement>("section.docx > article svg")) {
    const fo = svg.querySelector("foreignObject");
    if (!fo) continue;
    const box = document.createElement("div");
    box.className = "tw-textbox";
    box.style.width = svg.style.width || "12rem";
    box.style.background = svg.querySelector("rect")?.getAttribute("fill") || "#fff";
    box.style.borderColor = svg.querySelector("rect")?.getAttribute("stroke") || "#c8c8c8";
    box.append(...fo.childNodes);
    svg.replaceWith(box);
  }
  for (const el of root.querySelectorAll<HTMLElement>("section.docx p, section.docx p span")) {
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight);
    const fs = parseFloat(cs.fontSize);
    if (fs && (!lh || lh / fs < 1.4)) el.style.lineHeight = "1.4";
  }
  for (const t of root.querySelectorAll("section.docx > article > table")) {
    const wrap = document.createElement("div");
    wrap.className = "tw-tablewrap";
    t.replaceWith(wrap);
    wrap.append(t);
  }
}

/** 解析、修补、渲染进 into（清空原有内容），按页整理。into 可以不在页面上。 */
export async function renderDocx(data: ArrayBuffer | Uint8Array, into: HTMLElement): Promise<RenderedDocx> {
  const d = await parseAsync(data instanceof Uint8Array ? data : new Uint8Array(data), RENDER_OPTIONS);
  const { info, marks } = prepare(d);
  const nodes = await renderDocument(d, RENDER_OPTIONS);
  into.replaceChildren(...nodes);
  return { root: into, paras: arrangePages(into), info, marks };
}

export interface CharAt { node: Text; i: number; ch: string }

/** 一段的非空白字符与每个字在哪个文本节点的第几个；分页拆开的两半接起来算。跳过嵌套的段、svg、注释引用、文本框。 */
export function charsOf(parts: Element[] | undefined): CharAt[] {
  const chars: CharAt[] = [];
  const walk = (n: Node) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) {
        const v = (c as Text).nodeValue ?? "";
        for (let i = 0; i < v.length; i++) if (!/\s/.test(v[i])) chars.push({ node: c as Text, i, ch: v[i] });
      } else if (c instanceof Element && c.tagName.toLowerCase() !== "p" && c.namespaceURI !== "http://www.w3.org/2000/svg"
        && !c.classList.contains("tw-noteref") && !c.classList.contains("tw-textbox")) walk(c);
    }
  };
  for (const p of parts ?? []) walk(p);
  return chars;
}

const squeeze = (s: string) => s.replace(/\s+/g, "");
/** 跨段时往后最多接几段（与助手侧保存修订时的核对相同）。 */
export const SPAN_LIMIT = 5;

export type Place = { kind: "in"; start: number; end: number } | { kind: "span"; start: number; last: number } | { kind: "miss" };

/**
 * 摘录在第 n 段的哪里（texts[N] 是第 N 段去掉空白后的文字）：段内（第几个字到第几个字）、从第 n 段里开始跨到第 last 段、或找不到。
 * 规则：去掉空白比较；段内找不到就把这一段和后面最多 5 段接起来找，摘录从第 n 段里开始才算跨段。
 */
export function placeExcerpt(texts: string[], n: number, excerpt: string): Place {
  const want = squeeze(excerpt);
  const own = texts[n];
  if (!want || own == null) return { kind: "miss" };
  const at = own.indexOf(want);
  if (at >= 0) return { kind: "in", start: at, end: at + want.length };
  let joined = own;
  for (let m = n + 1; m < texts.length && m <= n + SPAN_LIMIT; m++) {
    joined += texts[m] ?? "";
    const k = joined.indexOf(want);
    if (k >= 0 && k < own.length) return { kind: "span", start: k, last: m };
  }
  return { kind: "miss" };
}

/** 派生表：由段落号查页、章节、位置要用的一切，纯数据，渲染出来的元素没了也能用。 */
export interface DocxTable {
  marks: number;
  pages: number;
  info: (ParagraphInfo | null)[];
  /** texts[N]：第 N 段去掉空白后的文字。 */
  texts: string[];
  /** parts[N]：第 N 段的各部分从第几个字起、在第几页、页上中下。 */
  parts: { from: number; page: number; pos: string }[][];
}

export function tableOf(r: RenderedDocx): DocxTable {
  const where = new Map<Element, { page: number; pos: string }>();
  const sheets = [...r.root.querySelectorAll<HTMLElement>("section.docx")];
  for (const sheet of sheets) {
    const list = [...sheet.querySelectorAll(":scope > article p.tw-p")];
    list.forEach((el, i) => {
      const f = (i + 0.5) / list.length;
      where.set(el, { page: Number(sheet.dataset.page), pos: f < 1 / 3 ? "页上" : f < 2 / 3 ? "页中" : "页下" });
    });
  }
  const texts: string[] = [];
  const parts: DocxTable["parts"] = [];
  r.paras.forEach((els, n) => {
    if (!els) return;
    let from = 0;
    texts[n] = "";
    parts[n] = els.map((el) => {
      const text = charsOf([el]).map((c) => c.ch).join("");
      const part = { from, ...(where.get(el) ?? { page: 0, pos: "" }) };
      texts[n] += text;
      from += text.length;
      return part;
    });
  });
  return { marks: r.marks, pages: sheets.length, info: r.info, texts, parts };
}

/**
 * 给人看的三段：「第 3 页」「3.1.1 逾期罚款」「页下」，取不到的段省略。
 * 页：摘录第一个字所在的那部分落在第几页（找不到摘录时按这一段的第一部分）；文件里没有分页标记时不写。
 * 章节：这一段（含）之前最近的标题。位置：这一段在本页正文段落（含表格里的）里排在前、中、后三分之一。
 */
export function whereOf(t: DocxTable, n: number, excerpt?: string): string[] {
  const parts = t.parts[n];
  if (!parts?.length) return [];
  const place = excerpt ? placeExcerpt(t.texts, n, excerpt) : { kind: "miss" as const };
  const start = place.kind === "miss" ? 0 : place.start;
  const part = [...parts].reverse().find((p) => p.from <= start) ?? parts[0];
  const out: string[] = [];
  if (t.marks > 0 && part.page) out.push(`第 ${part.page} 页`);
  for (let m = n; m >= 1; m--) {
    const i = t.info[m];
    if (i?.heading != null) { if (i.title) out.push(i.title); break; }
  }
  if (part.pos) out.push(part.pos);
  return out;
}

/** 出处「inputs/x.docx#p37」拆成路径与段落号；不是 .docx 时段落号为 null。 */
export function docxLocator(locator: string): { path: string; paragraph: number | null } | null {
  const m = /^(.+\.docx)(?:#p(\d+))?$/i.exec(locator);
  return m ? { path: m[1], paragraph: m[2] ? Number(m[2]) : null } : null;
}

/** 用户自己的材料：去掉由别的材料生成的文件（Word 材料的投影 x.docx.md 等，后端在 derived_from 里写明来源）。 */
export function ownMaterials<T extends { derived_from?: string | null }>(materials: T[]): T[] {
  return materials.filter((m) => !m.derived_from);
}

/**
 * 投影里各段的表格位置，写成「表 3 第 2 行第 2 列」（嵌套表只写外层）。
 * Markdown 投影（agent 的 lib/docx_markdown.ts 生成）：连续以竖线开头的行是一张表，表头算第 1 行、分隔行不算；
 * 一格里用 <br> 隔开的每截带一个段落号 [pN]，横向合并跨过的列写了占位，所以第几格就是第几列。
 * 0.2 的纯文本投影：行首「[第 N 段 · 表 t 行 r 列 c]」。
 */
export function tablePositions(projection: string): Map<number, string> {
  const out = new Map<number, string>();
  if (/^\[第 \d+ 段/m.test(projection)) {
    for (const line of projection.split("\n")) {
      const m = /^\[第 (\d+) 段 · 表 (\d+) 行 (\d+) 列 (\d+)/.exec(line);
      if (m) out.set(Number(m[1]), `表 ${m[2]} 第 ${m[3]} 行第 ${m[4]} 列`);
    }
    return out;
  }
  let table = 0;
  let row = 0;
  let inTable = false;
  for (const line of projection.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    if (!line.startsWith("|")) { inTable = false; continue; }
    if (!inTable) { inTable = true; table++; row = 0; }
    if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) continue;
    row++;
    const cells = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/);
    cells.forEach((cell, i) => {
      for (const seg of cell.split("<br>")) {
        const m = /\[p(\d+)\]/.exec(seg);
        if (m) out.set(Number(m[1]), `表 ${table} 第 ${row} 行第 ${i + 1} 列`);
      }
    });
  }
  return out;
}

/** 把一段里第 start 到 end 个非空白字符包进 make() 造出的元素（可跨多个文本节点，也可跨分页拆开的两半）。 */
export function wrapChars(parts: Element[], start: number, end: number, make: () => HTMLElement): HTMLElement[] {
  const byNode = new Map<Text, [number, number]>();
  for (const c of charsOf(parts).slice(start, end)) {
    const r = byNode.get(c.node) ?? [c.i, c.i];
    r[1] = c.i;
    byNode.set(c.node, r);
  }
  const out: HTMLElement[] = [];
  for (const [node, [a, b]] of byNode) {
    const range = document.createRange();
    range.setStart(node, a);
    range.setEnd(node, b + 1);
    const el = make();
    range.surroundContents(el);
    out.push(el);
  }
  return out;
}
