/**
 * Word 材料的位置规则：由段落号得出给人看的「第几页 · 哪一节 · 页上中下」。后端上传时用它算好位置表
 * （「文件名.docx.locations.json」，lib/docx_location_input.ts 从文件整理输入并写文件），页面显示来源标签时查这张表。
 * 这是这几条规则唯一的一份；不依赖任何模块（也不依赖 Node 自带模块），前端可以直接引用。
 *
 * 现在的位置表只写章节（headingsOf 与 locationFile）：页码与页内位置（locate）的规则还没有与页面现有推导逐段比较验证过，
 * 后端不调用它，位置表不写页码。
 *
 * 规则版本 LOCATION_RULES_VERSION：标题识别规则、章节推导规则、页码规则、页内位置规则任何一条改变时加一。位置表文件头里记着它。
 *
 * 三样东西怎样算：
 * 1. 标题：级别用 lib/docx_heading.ts 的 headingLevel；标题文字是「编号 + 段落文字」，编号由 lib/docx_numbering.ts 数
 *    （与投影同一份数法），只有引用到的各级都写十进制阿拉伯数字时才带进标题文字，项目符号、中文数字、罗马数字等都不带。
 *    章节是这一段（含）之前最近的标题，任何级别都算，与分段参数无关。
 * 2. 页码：材料区用排版库 docx-preview 0.4.1 按原版式分页显示，页码必须与用户在那里看到的一致，所以这里照那个排版库
 *    在 ignoreWidth、ignoreHeight、breakPages 打开时的行为分页（它的 splitBySection 与 groupByPageBreaks），再照页面现有的
 *    整理（web/src/model/docx.ts 的 arrangePages）去掉空的前一半与因此变空的页。下面几条是排版库的行为，不是 Word 的规则，
 *    排版库升级时要重新核对：
 *    - 只看正文顶层的段落：表格里的分页标记与手动分页符都不换页；
 *    - 一段只认第一个分页信号，而且只认段落直接子节点「文字块」（w:r）里的 w:lastRenderedPageBreak 与 w:br type="page"，
 *      超链接、修订插入等容器里的不认；
 *    - 信号不是文字块的最后一个子节点时，这段从信号处拆成两半；信号是文字块的最后一个子节点时，整个文字块挪到后一半；
 *      信号在最后一个文字块的末尾时这段不拆，只在它之后换页；
 *    - 段前分页（w:pageBreakBefore，段落自己写的或样式里的）在这段之前换页；样式继承的合并方式见 effectivePageBreakBefore；
 *    - 分节符不看类型（下一页、连续都一样），只在相邻两节的纸张宽、高或方向不同时换页，而且换在后一节之后。
 *    文件里没有任何 w:lastRenderedPageBreak 时不写页码（手动分页符照样分页，只影响页内位置）。
 * 3. 页内位置：这一部分在本页全部段落（含表格里的，不含文本框里的）里的次序 i，(i + 0.5) / 本页段落数小于三分之一是页上，
 *    小于三分之二是页中，否则是页下。按次序算，不按高度。
 *
 * 字按 UTF-16 码元计数（与页面的 charsOf 相同）：一个补充平面的字（例如表情符号、扩展区的汉字）算两个。空白不计。
 */

import { headingLevel } from "./docx_heading.ts";
import { type NumberingLevel, NumberingCounter } from "./docx_numbering.ts";

/** 位置规则的版本，从 1 起；规则任何一条改变时加一（见开头的说明）。 */
export const LOCATION_RULES_VERSION = 1;

// ───────────── 输入：从 Word 文件整理出来的段落序列（与解析方式无关） ─────────────

/** 纸张（w:pgSz 的原值），只用来比较两节是否相同。 */
export interface PageShape { width?: string; height?: string; orientation?: string }

/**
 * 段落里的一个子节点，按原顺序：
 * - text：字。drawn 为真时画出来并计数；titled 为真时算进标题文字（例如域代码所在文字块里的字不画但算进标题文字，
 *   符号字 w:sym 画出来但不算进标题文字，文本框里的字不画不计数但算进标题文字）；
 * - solid：画出来但不计字，让所在的这一半不算空：图片、文本框、脚注尾注引用号；
 * - mark：分页标记 w:lastRenderedPageBreak；pageBreak：手动分页符 w:br type="page"；
 * - other：别的子节点，只占位置（制表符、换行、不间断连字符、域符号、没画出来的图片等），拆段时的位置要算上它们。
 */
export type LayoutItem =
  | { kind: "text"; text: string; drawn: boolean; titled: boolean }
  | { kind: "solid" }
  | { kind: "mark" }
  | { kind: "pageBreak" }
  | { kind: "other" };

/** 段落的一个直接子节点：run 为真时是文字块（w:r，内容控件里的已摊平），为假时是超链接、修订插入与删除、公式等容器，里面的子节点摊平。 */
export interface LayoutChild { run: boolean; items: LayoutItem[] }

export interface LayoutParagraph {
  /** 段落号（投影的计数规则）。 */
  n: number;
  /** 排版库画不画这一段：customXml 里的、单元格里内容控件中的段落不画，它们没有页码与页内位置，但标题照记。 */
  drawn: boolean;
  /** 在表格里（含嵌套表格）：不参与分页，所在的页不算空。 */
  inTable: boolean;
  /** 段落样式（w:pStyle）。 */
  style?: string;
  /** 段落自身的大纲级别（w:outlineLvl）。 */
  outline?: string;
  /** 这一段的编号，已按投影的做法沿样式找好（numId 为 0 或没有编号时不写）。 */
  numbering?: { numId: string; level: number };
  /** 段落自己写的段前分页。 */
  pageBreakBefore?: boolean;
  /** 段落属性里带分节（w:sectPr）时，这一节的纸张；这一段是这一节的最后一段。 */
  section?: PageShape;
  children: LayoutChild[];
}

/** 样式表里的一个段落样式，按样式文件里的先后给出。 */
export interface LayoutStyle {
  id: string;
  name?: string;
  basedOn?: string;
  /** 样式里写的大纲级别。 */
  outline?: string;
  /** 样式有没有段落属性（w:pPr）；段前分页的继承与它有关，见 effectivePageBreakBefore。 */
  hasParagraphProps: boolean;
  /** 样式自己写的段前分页（没写为 undefined）。 */
  pageBreakBefore?: boolean;
}

/** numbering.xml 里某套编号（numId）的某一级，已按 w:startOverride 覆盖起始值。 */
export interface LayoutLevel extends NumberingLevel { numId: string; level: number }

export interface LocationInput {
  /** 按文件里的先后：正文与表格（含嵌套表格）里的段落，文本框里的除外；排版库不画的段落也在内（drawn 为假）。 */
  paragraphs: LayoutParagraph[];
  styles: LayoutStyle[];
  levels: LayoutLevel[];
  /** w:body 末尾那个 w:sectPr 的纸张；没有时为 null。 */
  bodySection: PageShape | null;
}

// ───────────── 输出 ─────────────

export type Position = "top" | "middle" | "bottom";

/** 一段里的一部分（分页拆开的一段有两部分）：从第几个非空白字符起、在第几页、页内位置。所在的页被整理掉时 page 与 position 为 null。 */
export interface LocatedPart { from: number; page: number | null; position: Position | null }

export interface LocatedParagraph {
  n: number;
  /** 标题级别，1 是一级；不是标题为 null。 */
  heading: number | null;
  /** 「编号 段落文字」，只对标题有意义。 */
  title: string;
  /** 有几个非空白字符（画出来的）。 */
  chars: number;
  /** 排版库不画的段落为 null。 */
  parts: LocatedPart[] | null;
}

export interface LocationResult {
  /** 文件里 w:lastRenderedPageBreak 的个数（在排版库画的段落里数，含表格里的）。为 0 时不写页码。 */
  marks: number;
  /** 整理之后的页数。 */
  pages: number;
  paragraphs: LocatedParagraph[];
}

// ───────────── 规则 ─────────────

/**
 * 样式里的段前分页在排版库里的实际效果。这是为了与排版库 docx-preview 0.4.1 的行为一致，不是 Word 的规则：
 * 排版库合并样式继承时（processStyles），按样式文件里的先后，对每个有上级的样式做 mergeDeep(自己的段落属性, 上级的段落属性)，
 * 上级已有的项会盖掉自己的；自己没有段落属性时什么都不并进来；上级在前面已经被合并过时，并进来的是合并过的。
 * 所以：样式没写段落属性时不继承上级的段前分页；写了段落属性时，上级写了段前分页（含它自己继承到的）就以上级的为准。
 * 排版库升级时要重新核对这一段。
 */
export function effectivePageBreakBefore(styles: LayoutStyle[]): Map<string, boolean | undefined> {
  const merged = new Map<string, { props: boolean; value: boolean | undefined }>();
  for (const s of styles) merged.set(s.id, { props: s.hasParagraphProps, value: s.pageBreakBefore });
  for (const s of styles) {
    if (!s.basedOn) continue;
    const self = merged.get(s.id)!;
    const base = merged.get(s.basedOn);
    if (!base || !self.props || !base.props) continue;
    if (base.value !== undefined) self.value = base.value;
  }
  return new Map([...merged].map(([id, v]) => [id, v.value]));
}

/** 两节的纸张是否不同（排版库的 isPageBreakSection）：任一边没有时算相同。 */
const shapeChanged = (a: PageShape | null | undefined, b: PageShape | null | undefined) =>
  !!a && !!b && (a.orientation !== b.orientation || a.width !== b.width || a.height !== b.height);

/** 一个字是不是空白（与页面 charsOf 用的 /\s/ 相同）。 */
const isSpace = (ch: string) => /\s/.test(ch);
const countChars = (s: string) => { let k = 0; for (let i = 0; i < s.length; i++) if (!isSpace(s[i])) k++; return k; };

/** 排版中的一半段落（没拆开的一段只有一半）。 */
interface Half { para: number; items: LayoutItem[]; table: boolean; page: number }

/** 一半有没有画出来的内容（页面 isEmpty 的反面：有非空白的字，或有图片、文本框、脚注引用号）。 */
const solid = (items: LayoutItem[]) => items.some((x) => x.kind === "solid" || (x.kind === "text" && x.drawn && x.text.trim() !== ""));

/** 每一段的标题级别、标题文字与画出来的字数（排版库不画的段落也算，编号照样往下数）。parts 都是 null，由 locate 补上。 */
export function headingsOf(input: LocationInput): LocatedParagraph[] {
  const styleMap = new Map(input.styles.map((s) => [s.id, s]));
  const counter = new NumberingCounter(new Map(input.levels.map((l) => [`${l.numId}:${l.level}`, l])));
  return input.paragraphs.map((p) => {
    const flat = p.children.flatMap((c) => c.items);
    const level = headingLevel(p.outline, p.style, (id) => {
      const s = styleMap.get(id);
      return s && { name: s.name, basedOn: s.basedOn, outline: s.outline };
    });
    const num = p.numbering ? counter.next(p.numbering.numId, p.numbering.level) : null;
    const label = num && num.decimal ? num.label : "";
    const text = flat.map((x) => (x.kind === "text" && x.titled ? x.text : "")).join("").trim();
    return {
      n: p.n, heading: level === null ? null : level + 1, title: [label, text].filter(Boolean).join(" "),
      chars: countChars(flat.map((x) => (x.kind === "text" && x.drawn ? x.text : "")).join("")), parts: null,
    };
  });
}

/** 分页标记（w:lastRenderedPageBreak）的个数：在排版库画的段落里数，含表格里的，与页面 prepare 里的 marks 相同。 */
export function pageMarks(input: LocationInput): number {
  let marks = 0;
  for (const p of input.paragraphs) if (p.drawn) for (const c of p.children) marks += c.items.filter((x) => x.kind === "mark").length;
  return marks;
}

/** 页码与页内位置（照排版库分页，见开头的说明）。还没有逐段比较验证，后端暂不调用。 */
export function locate(input: LocationInput): LocationResult {
  const breaks = effectivePageBreakBefore(input.styles);
  const marks = pageMarks(input);
  const out = headingsOf(input);

  // 分节与分页（排版库的 splitBySection）：顶层段落逐个放进当前一节，表格里的段落跟着放，不看其中的信号。
  interface Section { shape: PageShape | null | undefined; halves: Half[]; pageBreak: boolean }
  const sections: Section[] = [{ shape: null, halves: [], pageBreak: false }];
  let cur = sections[0];
  const cut = (shape: PageShape | undefined, pageBreak: boolean) => {
    cur.shape = shape;
    cur.pageBreak = pageBreak;
    cur = { shape: null, halves: [], pageBreak: false };
    sections.push(cur);
  };
  const halvesOf: Half[][] = input.paragraphs.map(() => []);
  let lastShape: PageShape | undefined; // 排版库里这个变量跨段保留（var 提升），段前分页时用的是上一段的节
  input.paragraphs.forEach((p, i) => {
    if (!p.drawn) return;
    const put = (half: Half) => { cur.halves.push(half); halvesOf[i].push(half); };
    if (p.inTable) { put({ para: i, items: p.children.flatMap((c) => c.items), table: true, page: 0 }); return; }
    if (p.pageBreakBefore || (p.style !== undefined && breaks.get(p.style))) cut(lastShape, true);
    const whole: Half = { para: i, items: p.children.flatMap((c) => c.items), table: false, page: 0 };
    put(whole);
    lastShape = p.section;
    let childAt = -1;
    let itemAt = -1;
    for (let k = 0; k < p.children.length && childAt < 0; k++) {
      const c = p.children[k];
      if (!c.run) continue;
      const j = c.items.findIndex((x) => x.kind === "mark" || x.kind === "pageBreak");
      if (j >= 0) { childAt = k; itemAt = j; }
    }
    if (p.section || childAt >= 0) cut(p.section, childAt >= 0);
    if (childAt < 0) return;
    const child = p.children[childAt];
    const splitRun = itemAt < child.items.length - 1;
    if (childAt < p.children.length - 1 || splitRun) {
      const before = p.children.slice(0, childAt).flatMap((c) => c.items);
      if (splitRun) before.push(...child.items.slice(0, itemAt));
      const after = [...(splitRun ? child.items.slice(itemAt) : child.items), ...p.children.slice(childAt + 1).flatMap((c) => c.items)];
      whole.items = before;
      put({ para: i, items: after, table: false, page: 0 });
    }
  });
  // 没写节的一节用后面最近一节的；都没有时用 w:body 的。
  let following: PageShape | null | undefined;
  for (let k = sections.length - 1; k >= 0; k--) {
    if (sections[k].shape == null) sections[k].shape = following ?? input.bodySection;
    else following = sections[k].shape;
  }
  // 分页（排版库的 groupByPageBreaks）。
  const pages: Section[][] = [[]];
  let prevShape: PageShape | null | undefined;
  for (const s of sections) {
    pages[pages.length - 1].push(s);
    if (s.pageBreak || shapeChanged(prevShape, s.shape)) pages.push([]);
    prevShape = s.shape;
  }
  const sheets = pages.filter((pg) => pg.length > 0).map((pg) => pg.flatMap((s) => s.halves));

  // 页面现有的整理（arrangePages）：拆成两半的段落去掉没有内容的一半（至少留一半）；因此变空的页整页去掉。
  const removed = new Set<Half>();
  const touched = new Set<number>();
  sheets.forEach((list, k) => list.forEach((h) => { h.page = k; }));
  for (const hs of halvesOf) {
    if (hs.length < 2) continue;
    const left = [...hs];
    for (const h of hs) {
      if (left.length > 1 && !solid(h.items)) { removed.add(h); touched.add(h.page); left.splice(left.indexOf(h), 1); }
    }
  }
  const dropped = new Set([...touched].filter((k) => sheets[k].every((h) => removed.has(h) || (!h.table && !solid(h.items)))));
  const kept = sheets.map((list, k) => (dropped.has(k) ? null : list.filter((h) => !removed.has(h))));

  // 页码与页内位置。
  const place = new Map<Half, { page: number; position: Position }>();
  let number = 0;
  for (const list of kept) {
    if (!list) continue;
    number++;
    list.forEach((h, i) => {
      const f = (i + 0.5) / list.length;
      place.set(h, { page: number, position: f < 1 / 3 ? "top" : f < 2 / 3 ? "middle" : "bottom" });
    });
  }
  input.paragraphs.forEach((p, i) => {
    if (!p.drawn) return;
    let from = 0;
    out[i].parts = halvesOf[i].filter((h) => !removed.has(h)).map((h) => {
      const at = place.get(h);
      const part: LocatedPart = { from, page: at?.page ?? null, position: at?.position ?? null };
      from += countChars(h.items.map((x) => (x.kind === "text" && x.drawn ? x.text : "")).join(""));
      return part;
    });
  });
  return { marks, pages: number, paragraphs: out };
}

// ───────────── 位置表文件（「文件名.docx.locations.json」） ─────────────

/** 位置表文件的格式版本（字段怎样写）；与规则版本 LOCATION_RULES_VERSION 分开。 */
export const LOCATIONS_FORMAT_VERSION = 1;
export const LOCATIONS_SUFFIX = ".locations.json";

export interface LocationFile {
  version: number;
  rules_version: number;
  说明: string;
  /** 来源文件相对任务目录的路径。 */
  source: string;
  /** 段落总数（投影的计数规则）。 */
  paragraphs: number;
  /** 分页标记（w:lastRenderedPageBreak）的个数。 */
  page_marks: number;
  /** 保存文件的软件名（docProps/app.xml 的 Application），读不到时为空文字。只作记录。 */
  application: string;
  /** 每个标题段：段落号、级别（1 是一级）、标题文字（含十进制编号）。 */
  headings: { paragraph: number; level: number; title: string }[];
}

const NOTE = "Word 材料的位置表：由段落号得出来源标签里的章节；规则见 agent/src/lib/docx_locations.ts。"
  + "headings 列出每个标题段，level 1 是一级标题；一段的章节是它（含）之前最近的标题。不含正文的文字。";

/** 写成位置表文件的内容。 */
export function locationFile(input: LocationInput, meta: { source: string; paragraphs: number; application: string }): LocationFile {
  return {
    version: LOCATIONS_FORMAT_VERSION, rules_version: LOCATION_RULES_VERSION, 说明: NOTE, source: meta.source, paragraphs: meta.paragraphs,
    page_marks: pageMarks(input), application: meta.application,
    headings: headingsOf(input).filter((p) => p.heading !== null).map((p) => ({ paragraph: p.n, level: p.heading!, title: p.title })),
  };
}

/**
 * 来源标签里的章节（与页面现有 whereOf 的章节一段相同）：这一段（含）之前最近的标题，任何级别都算；
 * 最近的标题文字为空、或者之前没有标题时为 null。
 */
export function chapterOf(table: Pick<LocationFile, "headings">, n: number): string | null {
  let heading: { paragraph: number; title: string } | undefined;
  for (const h of table.headings) if (h.paragraph <= n && (!heading || h.paragraph > heading.paragraph)) heading = h;
  return heading?.title || null;
}
