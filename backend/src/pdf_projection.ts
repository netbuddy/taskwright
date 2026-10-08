/**
 * PDF 材料的投影：把一份 .pdf 解析成三样——投影「文件名.pdf.md」（每块一行，行首「[p页-块]」，助手读它，核对摘录也对着它）、
 * 分段清单「文件名.pdf.segments.json」（agent/src/lib/pdf_segments.ts）与位置表「文件名.pdf.locations.json」
 * （agent/src/lib/pdf_locations.ts）。与 Word 材料的那三样是同一个用途，写法尽量相同；不同之处是 PDF 里没有文件自己声明的段落，
 * 块是这里按版面推出来的，定位符是「p页-块」。
 *
 * 用 pdf.js（pdfjs-dist，版本固定为 PDFJS_VERSION）读每页的文字条目：每个条目有文字、位置与字号。只取文字，不画页面。
 *
 * 行与块怎样推（规则版本是 lib/pdf_locations.ts 的 PDF_LOCATION_RULES_VERSION，任何一条改变时那里加一）：
 * - 按文件里写字的先后走，基线相差不到半个字高、横向接得上的条目接成一行；行里横向空隙超过两个字宽的地方切成「格」。
 * - 有两格以上的行是表格的一行：整行单独成一块，各格之间隔两个空格。只按行写，不分列，合并单元格与一格里折成几行的文字不还原。
 * - 其余的行先按版面切成几段连着的行：往上跳（换栏）、字号相差超过 12%、行距超过这一页常见行距的 1.3 倍、横向跳开很远，都另起一段。
 *   再在每段里找段落的分界：这一行缩进了一个字而上下两行都没有缩进（段落的第一行），或者上一行后面还放得下这一行开头的词
 *   （上一行是段落的最后一行）。分出来的每一截是一块。块不跨页，也不跨栏。
 * - 行接成一块时，前后有一边是中日韩字符就直接接上，否则中间加一个空格；行末的连字符原样留着。接好以后做一次整理
 *   （lib/pdf_normalize.ts 的 tidyPdfText：部首字符换成通用汉字等）。
 * - 页眉页脚：整块落在页面上边或下边 12% 以内（A4 纸上约 3.5 厘米，常见的页边距都在这以内），去掉数字与空白后的文字相同，并且在三分之二以上的页里出现（至少 3 页的文件才判），
 *   写成「> （页眉页脚）……」，没有定位符，不占块号，不能作出处。
 * - 一页除了页眉页脚一块文字都没有时，写一行「[p页-0] （这一页没有文字，可能是扫描件）」，位置表里这一页的 no_text 为真。
 *   这里不看这一页有没有图片（要知道就得把图片解出来，扫描件一页要多花零点几秒），所以空白页也算没有文字。
 * - 不按字号猜标题：投影里不写 #。文件带书签目录时，书签记进位置表的 headings，分段清单按它分段。
 *
 * 上限（PDF_LIMITS）：页数、字数与用时，超过任何一项就抛 PdfProjectionError。用时是在页与页之间检查的，某一页自己卡住时停不下来；
 * 要能强行停下，调用的一方得把解析放到另外起的一次运行里（命令行入口 pdf_projection_cli.mts 就是为此准备的）。
 *
 * pdf.js 的文件从哪里来：仓库里是根目录 node_modules/pdfjs-dist，安装包里是 payload/node_modules/pdfjs-dist，两处都从本文件往上找得到，
 * 所以只写包名。要用到包里四样：legacy/build 下压缩过的主库与解析库、cmaps/（字符映射表，不嵌入字体的中文 PDF 必需，
 * 少了它中文读出来是空的而且不报错）、standard_fonts/（标准字体的数据）。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type PdfBox, type PdfLocationFile, type PdfPageLocation, PDF_LOCATIONS_SUFFIX, pdfAnchor, pdfLocationFile, pdfLocationsJson } from "../../agent/src/lib/pdf_locations.ts";
import { tidyPdfText } from "../../agent/src/lib/pdf_normalize.ts";
import { PDF_SEGMENTS_SUFFIX, buildPdfSegments, writePdfSegments } from "../../agent/src/lib/pdf_segments.ts";
import { SEGMENT_DEFAULTS, type SegmentParams } from "../../agent/src/lib/segments.ts";

/** 投影跟在 PDF 文件路径后面的后缀：x.pdf → x.pdf.md。 */
export const PDF_PROJECTION_SUFFIX = ".md";
/** 解析用的 pdf.js 版本。行与块的规则是照这个版本返回的文字条目定的，换版本要把测试重新过一遍。 */
export const PDFJS_VERSION = "6.4.299";
/** 没有文字的页在投影里写的那一行（定位符之后的部分）。 */
export const NO_TEXT_LINE = "（这一页没有文字，可能是扫描件）";

/** 上限：页数、去掉空白后的字数、用时（秒）。 */
export interface PdfLimits { pages: number; chars: number; seconds: number }
export const PDF_LIMITS: Readonly<PdfLimits> = Object.freeze({ pages: 1000, chars: 3_000_000, seconds: 60 });

/** 解析失败（不是合法的 PDF、设了口令、超过上限，或者三样里有一样没写成）。消息是给人看的一句中文。 */
export class PdfProjectionError extends Error {}

export interface PdfProjection {
  /** 投影全文。 */
  markdown: string;
  /** 总页数。 */
  pages: number;
  /** 块的总数（有定位符、块号不是 0 的行）。 */
  units: number;
  /** 去掉空白后的字数。 */
  chars: number;
  /** 没有读出文字的页，从小到大。 */
  no_text_pages: number[];
  /** 位置表文件的内容。 */
  locations: PdfLocationFile;
}

// ───────────── pdf.js ─────────────

interface TextItem { str?: string; transform: number[]; width: number; height: number }
interface Viewport { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] }
interface PdfPage { rotate: number; getViewport(options: { scale: number }): Viewport; getTextContent(): Promise<{ items: TextItem[] }>; cleanup(): void }
interface OutlineNode { title: string; dest: string | unknown[] | null; items?: OutlineNode[] }
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  getOutline(): Promise<OutlineNode[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
}
interface Pdfjs {
  version: string;
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
}

const MAIN = "pdfjs-dist/legacy/build/pdf.min.mjs";
const WORKER = "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
/**
 * 这里用到的 pdfjs-dist 包里的文件与目录（相对包的根目录）：安装包只需要带这几样，包里别的东西（画页面的部分、类型声明、
 * 没压缩的构建文件与它们的对照文件）都用不到。测试按这份清单摆出一个只有这几样的目录，确认够用。
 */
export const PDFJS_FILES: readonly string[] = ["package.json", "LICENSE", "legacy/build/pdf.min.mjs", "legacy/build/pdf.worker.min.mjs", "cmaps", "standard_fonts"];

let loading: Promise<{ lib: Pdfjs; cmaps: string; fonts: string }> | undefined;

/** 第一次用到时才加载 pdf.js（后端启动时不加载）。 */
function loadPdfjs() {
  loading ??= (async () => {
    let main: string;
    try {
      main = fileURLToPath(import.meta.resolve(MAIN));
    } catch {
      throw new PdfProjectionError("解析 PDF 要用的 pdfjs-dist 没有装上。");
    }
    const root = join(dirname(main), "..", "..");
    const cmaps = join(root, "cmaps") + sep;
    const fonts = join(root, "standard_fonts") + sep;
    if (!existsSync(cmaps) || !existsSync(fonts)) throw new PdfProjectionError("pdfjs-dist 里缺字符映射表（cmaps）或标准字体（standard_fonts）目录，中文 PDF 会读不出字。");
    // pdf.js 一导入就试着加载画页面用的原生模块（@napi-rs/canvas）。这里只取文字，不带那个模块，它加载不到就往标准错误输出写三行
    // 「Cannot load "@napi-rs/canvas"……rendering may be broken」的警告，看上去像出了错。只在导入的这一下关掉 console.warn。
    const warn = console.warn;
    console.warn = () => {};
    let lib: Pdfjs;
    try {
      lib = await import(MAIN);
    } finally {
      console.warn = warn;
    }
    if (lib.version !== PDFJS_VERSION) throw new PdfProjectionError(`pdfjs-dist 的版本是 ${lib.version}，应当是 ${PDFJS_VERSION}。`);
    // 压缩过的主库默认去找没压缩的解析库文件名，要明说。
    lib.GlobalWorkerOptions.workerSrc = import.meta.resolve(WORKER);
    return { lib, cmaps, fonts };
  })();
  loading.catch(() => { loading = undefined; });
  return loading;
}

// ───────────── 行与块 ─────────────

interface Cell { x0: number; x1: number; text: string }
interface Line { y: number; x0: number; x1: number; right: number; size: number; rotated: boolean; top: number; bottom: number; cells: Cell[]; space: boolean }
interface Block { lines: Line[]; x0: number; x1: number; row: boolean }

/** 文字条目 → 行（规则见开头的说明）。 */
function linesOf(items: TextItem[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    if (!it.str.trim()) {
      if (cur && it.str) cur.space = true;
      continue;
    }
    const [a, b, , d, x, y] = it.transform;
    const size = Math.hypot(a, b) || Math.abs(d) || it.height || 10;
    const rotated = Math.abs(b) > 0.01 * Math.max(Math.abs(a), 1);
    const right = x + it.width;
    const same: boolean = !!cur && !rotated && !cur.rotated && Math.abs(y - cur.y) <= 0.5 * Math.max(size, cur.size) && x >= cur.right - 1.2 * size;
    if (cur && same) {
      const gap = x - cur.right;
      if (gap > 2 * size) cur.cells.push({ x0: x, x1: right, text: it.str });
      else {
        const cell = cur.cells[cur.cells.length - 1];
        cell.text += (cur.space || gap > 0.25 * size ? " " : "") + it.str;
        cell.x1 = right;
      }
      cur.right = right;
      cur.x1 = Math.max(cur.x1, right);
      cur.size = Math.max(cur.size, size);
      cur.top = Math.max(cur.top, y + size * 0.85);
      cur.bottom = Math.min(cur.bottom, y - size * 0.2);
      cur.space = false;
    } else {
      cur = { y, x0: x, x1: right, right, size, rotated, top: y + size * 0.85, bottom: y - size * 0.2, cells: [{ x0: x, x1: right, text: it.str }], space: false };
      lines.push(cur);
    }
  }
  for (const line of lines) {
    for (const cell of line.cells) cell.text = cell.text.replace(/\s+/g, " ").trim();
    line.cells = line.cells.filter((cell) => cell.text);
  }
  return lines.filter((line) => line.cells.length);
}

const median = (values: number[]) => values.length ? [...values].sort((p, q) => p - q)[Math.floor(values.length / 2)] : 0;

/** 中日韩字符（部首、标点、假名、汉字、兼容汉字、全角形式）：行与行相接时它的旁边不加空格。 */
function isCjk(ch: string | undefined): boolean {
  const c = ch?.codePointAt(0) ?? 0;
  return (c >= 0x2e80 && c <= 0x9fff && c !== 0x3000) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || c >= 0x20000;
}

/** 一行开头那个词排出来大约多宽：中日韩文字是一个字，别的是到第一个空格为止的一截（按字数占这一行的比例估）。 */
function firstWordWidth(line: Line): number {
  const text = line.cells[0].text;
  if (isCjk([...text][0])) return line.size;
  const word = text.split(" ")[0];
  return (line.cells[0].x1 - line.cells[0].x0) * (word.length / Math.max(text.length, 1));
}

/**
 * 行 → 块，分两步（规则见开头的说明）。
 * 头一步按版面切成几段连着的行：表格的一行自成一段；往上跳、字号变了、行距明显变大、横向跳开很远、遇到转了方向的字，都另起一段。
 * 后一步在每段连着的行里找段落的分界：首行缩进，或者上一行后面还放得下这一行开头的词（上一行是它那一段的最后一行）。
 */
function blocksOf(lines: Line[]): Block[] {
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const dy = lines[i - 1].y - lines[i].y;
    if (dy > 0 && dy < 3 * lines[i].size && Math.abs(lines[i].size - lines[i - 1].size) < 0.5) pitches.push(dy);
  }
  const pitch = median(pitches);
  const runs: Line[][] = [];
  let run: Line[] | null = null;
  let rowRun = false;
  for (const ln of lines) {
    const row = ln.cells.length > 1;
    let brk = !run || row || rowRun;
    if (run && !brk) {
      const prev = run[run.length - 1];
      const dy = prev.y - ln.y;
      const left = Math.min(...run.map((l) => l.x0));
      brk = ln.rotated || prev.rotated
        || dy < -0.5 * ln.size // 往上跳：换栏
        || Math.abs(ln.size - prev.size) > 0.12 * prev.size // 字号变了
        || (pitch ? dy > 1.3 * pitch : dy > 2.2 * ln.size) // 行距明显变大
        || Math.abs(ln.x0 - left) > 12 * ln.size; // 横向跳开很远
    }
    if (!run || brk) {
      run = [];
      runs.push(run);
      rowRun = row;
    }
    run.push(ln);
  }
  const blocks: Block[] = [];
  for (const each of runs) {
    const left = Math.min(...each.map((l) => l.x0));
    let blk: Block | null = null;
    each.forEach((ln, i) => {
      let brk = !blk;
      if (i > 0 && !brk) {
        const prev = each[i - 1];
        const size = ln.size;
        const indented = (l: Line) => l.x0 > left + 0.9 * size;
        // 上一行后面还放得下这一行开头的词：上一行是段落的最后一行。右边排到哪里只看前三行与后两行（同一段连着的行里栏宽可能中途变化）。
        const right = Math.max(...each.slice(Math.max(0, i - 3), i + 3).map((l) => l.x1));
        const prevEnded = prev.x1 + 0.3 * size + firstWordWidth(ln) < right - 0.3 * size;
        // 首行缩进：这一行缩进而上一行没有缩进，并且下一行回到左边（下一行也缩进的是悬挂缩进的续行，不算）。
        const firstLine = indented(ln) && !indented(prev) && (i + 1 >= each.length || !indented(each[i + 1]));
        brk = prevEnded || firstLine;
      }
      if (!blk || brk) {
        blk = { lines: [], x0: ln.x0, x1: ln.x1, row: ln.cells.length > 1 };
        blocks.push(blk);
      }
      blk.lines.push(ln);
      blk.x0 = Math.min(blk.x0, ln.x0);
      blk.x1 = Math.max(blk.x1, ln.x1);
    });
  }
  return blocks;
}

/** 一块里的各行接成一段文字。 */
function joinLines(texts: string[]): string {
  let out = "";
  for (const t of texts) {
    if (!out) out = t;
    else out += (isCjk([...out].pop()) || isCjk([...t][0]) ? "" : " ") + t;
  }
  return out;
}

const round = (v: number) => Math.round(v * 10) / 10;
/** 页眉页脚只在页面上下各这么宽的边上找（占页高的比例）。 */
const EDGE = 0.12;

interface PageBlock { text: string; bbox: PdfBox; running: boolean; key: string | null }
interface PageResult { page: number; width: number; height: number; rotate: number; blocks: PageBlock[] }

/** 一页的文字条目 → 这一页的各块（还没有判页眉页脚、没有编块号）。 */
function pageBlocks(items: TextItem[], viewport: Viewport): PageBlock[] {
  return blocksOf(linesOf(items)).map((b) => {
    const text = tidyPdfText(b.row ? b.lines[0].cells.map((c) => c.text).join("  ") : joinLines(b.lines.map((l) => l.cells[0].text)));
    const bbox: PdfBox = [
      round(Math.min(...b.lines.map((l) => l.x0))), round(Math.min(...b.lines.map((l) => l.bottom))),
      round(Math.max(...b.lines.map((l) => l.x1))), round(Math.max(...b.lines.map((l) => l.top))),
    ];
    // 显示出来的纵向位置（页面可能自己带旋转，所以换成显示坐标再看）：整块在上边 12% 以内或下边 12% 以内才可能是页眉页脚。
    const ys = [viewport.convertToViewportPoint(bbox[0], bbox[1])[1], viewport.convertToViewportPoint(bbox[2], bbox[3])[1]];
    const edge = Math.max(...ys) <= EDGE * viewport.height ? "top" : Math.min(...ys) >= (1 - EDGE) * viewport.height ? "bottom" : null;
    const key = edge ? `${edge}|${text.replace(/\s+/g, "").replace(/\d+/g, "#")}` : null;
    return { text, bbox, running: false, key };
  }).filter((b) => b.text);
}

/** 判页眉页脚：同一条边上、去掉数字与空白后文字相同的块，在三分之二以上的页里出现（至少 3 页）。 */
function markRunningHeads(pages: PageResult[]): void {
  if (pages.length < 3) return;
  const seen = new Map<string, number>();
  for (const pg of pages) for (const key of new Set(pg.blocks.map((b) => b.key).filter((k): k is string => k !== null))) seen.set(key, (seen.get(key) ?? 0) + 1);
  const enough = Math.ceil((pages.length * 2) / 3);
  for (const pg of pages) for (const b of pg.blocks) if (b.key !== null && (seen.get(b.key) ?? 0) >= enough) b.running = true;
}

// ───────────── 书签目录 ─────────────

/** 书签目录 → 位置表的 headings：每项指向第几页、级别、标题；指不到页的项不要。最多取 5000 项。 */
async function outlineHeadings(doc: PdfDocument, expired: () => boolean): Promise<PdfLocationFile["headings"]> {
  const out: PdfLocationFile["headings"] = [];
  let outline: OutlineNode[] | null = null;
  try {
    outline = await doc.getOutline();
  } catch {
    return out;
  }
  const walk = async (nodes: OutlineNode[], level: number): Promise<void> => {
    for (const node of nodes) {
      if (out.length >= 5000 || expired()) return;
      try {
        const dest = typeof node.dest === "string" ? await doc.getDestination(node.dest) : node.dest;
        const target = Array.isArray(dest) ? dest[0] : null;
        const index = typeof target === "number" ? target : target ? await doc.getPageIndex(target) : -1;
        const title = tidyPdfText(String(node.title ?? "")).replace(/\s+/g, " ").trim();
        if (index >= 0 && index < doc.numPages) out.push({ page: index + 1, level, title });
      } catch {
        // 这一项指不到页，跳过
      }
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };
  if (outline) await walk(outline, 1);
  return out;
}

// ───────────── 写投影 ─────────────

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

const header = (name: string, rel: string, pages: number, units: number) => `<!--
由 ${name} 生成，供助手阅读。页数：${pages}。块总数：${units}。
每块一行；方括号里的 p 加「页-块」（例如 [p3-7]）是这一块在 PDF 里的位置：第 3 页的第 7 块，它右边到行尾是这一块的文字。
块是按版面把相邻的几行接起来得到的，不一定正好是一个自然段；表格的一行是一块，各格之间隔两个空格，不分列。
引用这份材料作来源时，出处写 ${rel}#p页-块（例如 ${rel}#p3-7），摘录逐字抄定位符右边的文字，不带定位符；摘录不要跨页。
以「> （页眉页脚）」开头的行是每页重复的页眉页脚，没有定位符，不能作出处。
「${NO_TEXT_LINE}」的那一行说明这一页读不出文字，块号 0 不能作出处。
-->
`;

/** 各页的块 → 投影全文与位置表里的各页。块号在这里编：每页从 1 起，页眉页脚不占号。 */
function render(pages: PageResult[], rel: string): { markdown: string; units: number; locations: PdfPageLocation[]; noText: number[] } {
  const body: string[] = [];
  const locations: PdfPageLocation[] = [];
  const noText: number[] = [];
  let units = 0;
  for (const pg of pages) {
    const blocks: PdfPageLocation["blocks"] = [];
    const empty = pg.blocks.every((b) => b.running);
    if (empty) {
      noText.push(pg.page);
      body.push(`${pdfAnchor(pg.page, 0)} ${NO_TEXT_LINE}`);
    }
    for (const b of pg.blocks) {
      if (b.running) {
        body.push(`> （页眉页脚）${b.text}`);
        continue;
      }
      const block = blocks.length + 1;
      blocks.push({ block, bbox: b.bbox });
      body.push(`${pdfAnchor(pg.page, block)} ${b.text}`);
      units++;
    }
    locations.push({ page: pg.page, width: round(pg.width), height: round(pg.height), rotate: pg.rotate, no_text: empty, blocks });
  }
  const markdown = header(basename(rel), rel, pages.length, units) + body.map((line) => `\n${line}\n`).join("");
  return { markdown, units, locations, noText };
}

function failure(error: unknown): PdfProjectionError {
  if (error instanceof PdfProjectionError) return error;
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "PasswordException") return new PdfProjectionError("这份 PDF 设了打开口令，读不了");
  if (name === "InvalidPDFException" || name === "FormatError") return new PdfProjectionError("不是 PDF 文件，或者文件已损坏");
  return new PdfProjectionError(`这份 PDF 读不出来：${(error as Error)?.message ?? String(error)}`);
}

/**
 * .pdf 的字节 → 投影与位置表。rel 是这份 .pdf 相对任务目录的路径（写进开头的说明与位置表）。
 * 不是合法的 PDF、设了口令、超过上限时抛 PdfProjectionError，消息是给人看的一句中文。
 */
export async function pdfProjection(data: Uint8Array, rel: string, limits: PdfLimits = PDF_LIMITS): Promise<PdfProjection> {
  const started = performance.now();
  const expired = () => performance.now() - started > limits.seconds * 1000;
  const { lib, cmaps, fonts } = await loadPdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(data), cMapUrl: cmaps, cMapPacked: true, standardFontDataUrl: fonts,
    useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0,
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > limits.pages) throw new PdfProjectionError(`这份 PDF 有 ${doc.numPages} 页，超过上限 ${limits.pages} 页`);
    const pages: PageResult[] = [];
    let chars = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      if (expired()) throw new PdfProjectionError(`解析这份 PDF 超过了 ${limits.seconds} 秒，在第 ${n} 页停下了`);
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const { items } = await page.getTextContent();
      const own = items.reduce((sum, it) => sum + (it.str ?? "").replace(/\s+/g, "").length, 0);
      chars += own;
      if (chars > limits.chars) throw new PdfProjectionError(`这份 PDF 的文字超过上限 ${limits.chars} 字，在第 ${n} 页停下了`);
      pages.push({ page: n, width: viewport.width, height: viewport.height, rotate: page.rotate, blocks: pageBlocks(items, viewport) });
      page.cleanup();
    }
    markRunningHeads(pages);
    const headings = await outlineHeadings(doc, expired);
    const info = (await doc.getMetadata().catch(() => ({ info: undefined }))).info ?? {};
    const producer = [info.Producer, info.Creator].find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim() ?? "";
    const { markdown, units, locations, noText } = render(pages, rel);
    return {
      markdown, pages: pages.length, units, chars, no_text_pages: noText,
      locations: pdfLocationFile({ source: rel, engine: `pdfjs-dist ${PDFJS_VERSION}`, producer, pages: locations, headings }),
    };
  } catch (error) {
    throw failure(error);
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** 写出的三个文件的路径与几个数。 */
export interface WrittenPdfProjection { projection: string; segments: string; locations: string; pages: number; units: number; chars: number; no_text_pages: number[] }

/**
 * 在 .pdf 旁边写投影、分段清单与位置表。pdf 是文件路径，rel 是它相对任务目录的路径。
 * 解析不了，或者三样里有一样没写成时抛 PdfProjectionError，已经写下的由 removePdfProjection 清掉。
 */
export async function writePdfProjection(pdf: string, rel: string, segments: SegmentParams = SEGMENT_DEFAULTS, limits: PdfLimits = PDF_LIMITS): Promise<WrittenPdfProjection> {
  let data: Buffer;
  try {
    data = readFileSync(pdf);
  } catch {
    throw new PdfProjectionError(`读不到文件 ${pdf}。`);
  }
  const result = await pdfProjection(data, rel, limits);
  const out = { projection: pdf + PDF_PROJECTION_SUFFIX, segments: pdf + PDF_SEGMENTS_SUFFIX, locations: pdf + PDF_LOCATIONS_SUFFIX };
  try {
    try {
      writeFileSync(out.projection, result.markdown, "utf-8");
    } catch (error) {
      throw new PdfProjectionError(`投影没有写成：${(error as Error).message}`);
    }
    try {
      writePdfSegments(out.segments, buildPdfSegments(result.markdown, segments, rel, rel + PDF_PROJECTION_SUFFIX, result.locations.headings));
    } catch (error) {
      throw new PdfProjectionError(`分段清单没有写成：${(error as Error).message}`);
    }
    try {
      writeFileSync(out.locations, pdfLocationsJson(result.locations), "utf-8");
    } catch (error) {
      throw new PdfProjectionError(`位置表没有写成：${(error as Error).message}`);
    }
  } catch (error) {
    removePdfProjection(pdf);
    throw error;
  }
  return { ...out, pages: result.pages, units: result.units, chars: result.chars, no_text_pages: result.no_text_pages };
}

/** 删掉这份 .pdf 的投影、分段清单与位置表（写到一半失败时清理）。 */
export function removePdfProjection(pdf: string): void {
  for (const file of [pdf + PDF_PROJECTION_SUFFIX, pdf + PDF_SEGMENTS_SUFFIX, pdf + PDF_LOCATIONS_SUFFIX]) {
    try {
      unlinkSync(file);
    } catch {
      // 本来就没有
    }
  }
}
