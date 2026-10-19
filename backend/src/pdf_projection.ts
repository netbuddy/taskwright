/**
 * PDF 材料的投影：把一份 .pdf 解析成三样——投影「文件名.pdf.md」（每块一行，行首「[p页-块]」，助手读它，核对摘录也对着它）、
 * 分段清单「文件名.pdf.segments.json」（agent/src/lib/pdf_segments.ts）与位置表「文件名.pdf.locations.json」
 * （agent/src/lib/pdf_locations.ts）。与 Word 材料的那三样是同一个用途，写法尽量相同；不同之处是 PDF 里没有文件自己声明的段落，
 * 块是这里按版面推出来的，定位符是「p页-块」。
 * 用户与助手看到的叫法是「文字版」（text version）；「投影」与 projection 只是代码里的名字。
 *
 * 用 pdf.js（pdfjs-dist，版本固定为 PDFJS_VERSION）读每页的文字条目：每个条目有文字、位置与字号。只取文字，不画页面。
 *
 * 行与块怎样推（规则版本是 lib/pdf_locations.ts 的 PDF_LOCATION_RULES_VERSION，任何一条改变时那里加一）：
 * - 按文件里写字的先后走，基线相差不到半个字高、横向接得上的条目接成一行；行里横向空隙超过两个字宽的地方切成「格」。
 * - 有两格以上、又不是两端对齐的正文的行是表格的一行：它连同各格的折行单独成一块，各格之间隔两个空格，同一格的折行按接行的规矩接上
 *   （怎样认折行、列边界从哪里来见 tableRows）。只按行写，不分列，合并单元格不还原；表格行跨页、跨栏时照样断开。
 * - 其余的行先按版面切成几段连着的行：往上跳（换栏）、字号相差超过 12%、行距超过这一页常见行距的 1.3 倍、横向跳开很远，都另起一段。
 *   再在每段里找段落的分界：这一行缩进了一个字而上下两行都没有缩进（段落的第一行），或者上一行后面还放得下这一行开头的词
 *   （上一行是段落的最后一行）。列表项另有三条：一块的第一行以编号或项目符号开头时，比编号靠右的行是悬挂缩进的续行，
 *   不当作首行缩进；续行之后退回编号那一列的行另起一块；又一行以编号开头时另起一块（每行都排满时只能靠这几条分开）。
 *   分出来的每一截是一块。块不跨页，也不跨栏。
 * - 等宽字体的行（多半是代码，怎样认见 monospaceLines）每行单独一块，行首补上缩进的空格（markIndents）；它不当作表格的一行。
 * - 行接成一块时，前后有一边是中日韩字符就直接接上，否则中间加一个空格；行末的连字符原样留着。接好以后做一次整理
 *   （lib/pdf_normalize.ts 的 tidyPdfText：部首字符换成通用汉字等）。
 * - 页眉页脚：整块落在页面上边或下边 12% 以内（A4 纸上约 3.5 厘米，常见的页边距都在这以内），去掉数字与空白后的文字相同，并且在三分之二以上的页里出现（至少 3 页的文件才判），
 *   写成「> （页眉页脚）……」，没有定位符，不占块号，不能作出处。
 * - 一页除了页眉页脚一块文字都没有时，写一行「[p页-0] （这一页没有文字，可能是扫描件）」，位置表里这一页的 no_text 为真。
 *   这里不看这一页有没有图片（要知道就得把图片解出来，扫描件一页要多花零点几秒），所以空白页也算没有文字。
 * - 投影里不按字号猜标题，不写 #。文件带书签目录时，书签记进位置表的 headings，分段清单按它分段；没有书签目录时，
 *   分段清单可以按字号推断出的小节分段（inferHeadings），推断的标题只写进分段清单，不进投影与位置表。
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { type PdfBox, type PdfLocationFile, type PdfPageLocation, PDF_LOCATIONS_SUFFIX, pdfAnchor, pdfLocationFile, pdfLocationsJson } from "../../agent/src/lib/pdf_locations.ts";
import { tidyPdfText } from "../../agent/src/lib/pdf_normalize.ts";
import { PDF_SEGMENTS_SUFFIX, buildPdfSegments, writePdfSegments } from "../../agent/src/lib/pdf_segments.ts";
import { SEGMENT_DEFAULTS, type SegmentParams } from "../../agent/src/lib/segments.ts";
import { fromRoot } from "./paths.ts";

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
  /** 文件没有书签目录时按字号推断出的小节标题（inferHeadings），给分段清单用；有书签目录时为空。不写进位置表。 */
  inferred: { page: number; title: string }[];
}

// ───────────── pdf.js ─────────────

interface TextItem { str?: string; transform: number[]; width: number; height: number; fontName?: string }
/** 文字条目所用字体的说明：pdf.js 只给出字体族（serif、sans-serif、monospace），不给字体的真名。 */
type TextStyles = Record<string, { fontFamily?: string } | undefined>;
interface Viewport { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] }
interface PdfPage { rotate: number; getViewport(options: { scale: number }): Viewport; getTextContent(): Promise<{ items: TextItem[]; styles?: TextStyles }>; cleanup(): void }
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

/** 安装包里放 pdfjs-dist 那几样文件的目录（相对仓根；构建时由 release/build.mjs 照 PDFJS_FILES 拷进去）。 */
export const PDFJS_VENDOR_DIR = "backend/vendor/pdfjs-dist";

/**
 * 主库与解析库两个文件在哪里：安装包里没有 node_modules，用构建时放进随包目录的那一份；仓库里按包名从 node_modules 找。
 * 包没有装上时抛 PdfProjectionError。
 */
export function pdfjsFiles(): { main: string; worker: string } {
  const packed = fromRoot(`${PDFJS_VENDOR_DIR}/legacy/build/pdf.min.mjs`);
  if (existsSync(packed)) return { main: packed, worker: join(dirname(packed), "pdf.worker.min.mjs") };
  try {
    return { main: fileURLToPath(import.meta.resolve(MAIN)), worker: fileURLToPath(import.meta.resolve(WORKER)) };
  } catch {
    throw new PdfProjectionError("解析 PDF 要用的 pdfjs-dist 没有装上。");
  }
}

let loading: Promise<{ lib: Pdfjs; cmaps: string; fonts: string }> | undefined;

/** 第一次用到时才加载 pdf.js（后端启动时不加载）。 */
function loadPdfjs() {
  loading ??= (async () => {
    const { main, worker } = pdfjsFiles();
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
      lib = await import(pathToFileURL(main).href);
    } finally {
      console.warn = warn;
    }
    if (lib.version !== PDFJS_VERSION) throw new PdfProjectionError(`pdfjs-dist 的版本是 ${lib.version}，应当是 ${PDFJS_VERSION}。`);
    // 压缩过的主库默认去找没压缩的解析库文件名，要明说。
    lib.GlobalWorkerOptions.workerSrc = pathToFileURL(worker).href;
    return { lib, cmaps, fonts };
  })();
  loading.catch(() => { loading = undefined; });
  return loading;
}

// ───────────── 行与块 ─────────────

interface Cell { x0: number; x1: number; text: string }
/** 行里隔着空白的一截文字（中日韩文字连着写的一串、一个英文词）：表格行归格时按它的起点归到列。 */
interface Piece { x0: number; x1: number; text: string }
interface Line {
  y: number; x0: number; x1: number; right: number; size: number; rotated: boolean; top: number; bottom: number; cells: Cell[]; pieces: Piece[]; space: boolean;
  /** 这一行的文字条目是不是都用 pdf.js 标为等宽（monospace）的字体。 */
  fixed: boolean;
  /** 这一行里只有拉丁字符的文字条目，各自的字数与每个字占多宽（条目宽度除以字数）。 */
  advances: { n: number; width: number }[];
  /** 这一行里有没有不全是拉丁字符的文字条目。 */
  other: boolean;
  /** 等宽字体的行行首要补的空格数（见 markIndents）；别的行是 0。 */
  indent: number;
}
/** 一块：表格的一行（row 为真）时 text 是已经按列拼好的文字。 */
interface Block { lines: Line[]; x0: number; x1: number; row: boolean; text?: string }

/** 文字条目 → 行（规则见开头的说明）。 */
function linesOf(items: TextItem[], styles: TextStyles = {}): Line[] {
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
    const fixed = styles[it.fontName ?? ""]?.fontFamily === "monospace";
    const latin = /^[\x20-\x7e]+$/.test(it.str) ? { n: it.str.length, width: it.width / it.str.length } : null;
    const same: boolean = !!cur && !rotated && !cur.rotated && Math.abs(y - cur.y) <= 0.5 * Math.max(size, cur.size) && x >= cur.right - 1.2 * size;
    if (cur && same) {
      const gap = x - cur.right;
      if (gap > 2 * size) {
        cur.cells.push({ x0: x, x1: right, text: it.str });
        cur.pieces.push({ x0: x, x1: right, text: it.str });
      } else {
        const cell = cur.cells[cur.cells.length - 1];
        const apart = cur.space || gap > 0.25 * size;
        cell.text += (apart ? " " : "") + it.str;
        cell.x1 = right;
        if (apart) cur.pieces.push({ x0: x, x1: right, text: it.str });
        else {
          const piece = cur.pieces[cur.pieces.length - 1];
          piece.text += it.str;
          piece.x1 = right;
        }
      }
      cur.fixed &&= fixed;
      if (latin !== null) cur.advances.push(latin);
      else cur.other = true;
      cur.right = right;
      cur.x1 = Math.max(cur.x1, right);
      cur.size = Math.max(cur.size, size);
      cur.top = Math.max(cur.top, y + size * 0.85);
      cur.bottom = Math.min(cur.bottom, y - size * 0.2);
      cur.space = false;
    } else {
      cur = { y, x0: x, x1: right, right, size, rotated, top: y + size * 0.85, bottom: y - size * 0.2, cells: [{ x0: x, x1: right, text: it.str }], pieces: [{ x0: x, x1: right, text: it.str }], space: false,
        fixed, advances: latin === null ? [] : [latin], other: latin === null, indent: 0 };
      lines.push(cur);
    }
  }
  for (const line of lines) {
    for (const cell of line.cells) cell.text = cell.text.replace(/\s+/g, " ").trim();
    line.cells = line.cells.filter((cell) => cell.text);
    for (const piece of line.pieces) piece.text = piece.text.replace(/\s+/g, " ").trim();
    line.pieces = line.pieces.filter((piece) => piece.text);
  }
  return lines.filter((line) => line.cells.length);
}

const median = (values: number[]) => values.length ? [...values].sort((p, q) => p - q)[Math.floor(values.length / 2)] : 0;

/** 中日韩字符（部首、标点、假名、汉字、兼容汉字、全角形式）：行与行相接时它的旁边不加空格。 */
function isCjk(ch: string | undefined): boolean {
  const c = ch?.codePointAt(0) ?? 0;
  return (c >= 0x2e80 && c <= 0x9fff && c !== 0x3000) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || c >= 0x20000;
}

/**
 * 一行是不是以列表的编号开头：「1.」「2、」「3)」「（4）」「a.」「1.5」「2.3.1」这样的数字编号与条款号，或者「•」「·」「-」这样的项目符号。
 * 编号后面要跟着空格或者别的字，不认「3.5 万」里的 3.5 以外的写法。
 */
function startsWithMarker(ln: Line): boolean {
  return /^(?:\d{1,3}(?:[.．]\d{1,3})+(?=\s)|\d{1,3}[.．、)）](?!\d)|[（(]\d{1,3}[)）]|[a-zA-Z][.)](?=\s)|[•·▪◦‣●○■□](?=\s|\S)|[-*–](?=\s))/.test(ln.cells[0].text);
}

/** 一行开头那个词排出来大约多宽：中日韩文字是一个字，别的是到第一个空格为止的一截（按字数占这一行的比例估）。 */
function firstWordWidth(line: Line): number {
  const text = line.cells[0].text;
  if (isCjk([...text][0])) return line.size;
  const word = text.split(" ")[0];
  return (line.cells[0].x1 - line.cells[0].x0) * (word.length / Math.max(text.length, 1));
}

/**
 * 各行是不是用等宽字体排的（多半是代码）。两条满足一条就算：
 * - pdf.js 把这一行的文字条目都标为等宽字体（monospace；它依据的是字体自己声明的「定宽」标记。pdf.js 拿不到字体的真名，
 *   没法按名字里有没有 Mono、Courier 判断）；
 * - 有的等宽字体没有声明这个标记（例如 Noto Sans Mono CJK 在一些文件里被标成 sans-serif），所以再看字宽：按文件里写字的先后，
 *   连着几行（遇到往上跳、字号变了就断开）全是拉丁字符的条目，三个以上、至少有两种字数，每个字的宽度（条目宽度除以字数）
 *   彼此相差不到 0.3%，并且在 0.45 到 0.65 个字号之间，这几行都算；夹在等宽的行中间、连着不超过三行、字号相同的行也算（代码里带中文的注释与字符串）。等宽字体每个字一样宽，宽度除以字数严格相等
 *   （西文等宽字体约 0.6 个字号，中日韩等宽字体里的拉丁字符是半角，0.5 个字号）；非等宽字体换一个词就变。
 */
function monospaceLines(lines: Line[]): boolean[] {
  const mono = lines.map((ln) => ln.fixed);
  const latinOnly = (ln: Line) => !ln.other && ln.advances.length > 0;
  for (let i = 0; i < lines.length;) {
    if (!latinOnly(lines[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && latinOnly(lines[j]) && lines[j].y <= lines[j - 1].y + 0.5 * lines[j].size && Math.abs(lines[j].size - lines[i].size) <= 0.01 * lines[i].size) j++;
    const all = lines.slice(i, j).flatMap((l) => l.advances);
    const lo = Math.min(...all.map((a) => a.width));
    const hi = Math.max(...all.map((a) => a.width));
    if (all.length >= 3 && new Set(all.map((a) => a.n)).size >= 2 && hi - lo < 0.003 * lo && lo >= 0.45 * lines[i].size && hi <= 0.65 * lines[i].size) {
      for (let k = i; k < j; k++) mono[k] = true;
    }
    i = j;
  }
  // 代码里夹着带中文的行（例如注释、字符串），它们不全是拉丁字符，量不了字宽：前后都是等宽的行、连着不超过三行、
  // 字号相同、自上而下排着时也算。
  for (let k = 1; k < lines.length; k++) {
    if (mono[k] || !mono[k - 1]) continue;
    let e = k;
    while (e < lines.length && !mono[e] && e - k < 3) e++;
    if (e >= lines.length || !mono[e]) continue;
    const span = lines.slice(k - 1, e + 1);
    if (span.every((l, m) => Math.abs(l.size - lines[k - 1].size) <= 0.01 * l.size && (m === 0 || l.y < span[m - 1].y))) for (let m = k; m < e; m++) mono[m] = true;
  }
  return mono;
}

/**
 * 等宽字体的行要补的行首空格（代码的缩进）：按文件里写字的先后，连着的等宽字体的行算一段代码（遇到别的行、往上跳、字号变了就断开），
 * 每行行首比这一段最靠左的行多出来的横向距离，除以每个字的宽度（这一段里量得到的字宽的中位数，量不到时取 0.6 个字号）后四舍五入。
 * 段里空着的行在 PDF 里本来就没有文字，不打断这一段，所以空行之后缩进着的行照样量得出缩进。
 */
function markIndents(lines: Line[], mono: boolean[]): void {
  for (let i = 0; i < lines.length;) {
    if (!mono[i]) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && mono[j] && lines[j].y <= lines[j - 1].y + 0.5 * lines[j].size && Math.abs(lines[j].size - lines[i].size) <= 0.12 * lines[i].size) j++;
    const run = lines.slice(i, j);
    const left = Math.min(...run.map((l) => l.x0));
    const measured = run.flatMap((l) => l.advances.map((a) => a.width));
    const width = measured.length ? median(measured) : 0.6 * lines[i].size;
    for (const ln of run) ln.indent = Math.max(0, Math.round((ln.x0 - left) / width));
    i = j;
  }
}

/**
 * 这一行是不是表格的一行：有两格以上，并且不是两端对齐的正文。两端对齐的英文正文词距被撑开，撑得多的一行每处都超过两个字宽，
 * 会被切成好几格；认它的办法是词距（相邻两个词段之间的空隙，大小不论）有三处以上、都超过 0.6 个字宽，并且几乎一样大
 * （最大最小相差不到 0.1 个字宽：排版软件把一行剩下的空白平均分给各处词距）。表格各格的宽窄不同，格与格之间的空隙参差不齐。
 */
function isRow(ln: Line): boolean {
  if (ln.cells.length < 2) return false;
  const gaps = ln.pieces.slice(1).map((p, k) => p.x0 - ln.pieces[k].x1);
  const justified = gaps.length >= 3 && Math.min(...gaps) > 0.6 * ln.size && Math.max(...gaps) - Math.min(...gaps) < 0.1 * ln.size;
  return !justified;
}

/** 列边界里不大于 x（差 tol 以内也算）的最后一条的下标；比第一条还靠左时是 0。 */
function columnOf(cols: number[], x: number, tol: number): number {
  let k = 0;
  for (let c = 0; c < cols.length; c++) if (cols[c] <= x + tol) k = c;
  return k;
}

/**
 * 一行能不能作某个表格行的折行，只看横向：第一个词段从某条候选列边界起（差 tol 以内）；其余的词段要么也从某条列边界起，
 * 要么与前一个词段落在同一列里；每个词段都不越过它右边的那条列边界（差 tol 以内）。散文的行一个词段横跨几列，或者词从列中间起，过不了。
 */
function fitsColumns(ln: Line, starts: number[]): boolean {
  const tol = 0.5 * ln.size;
  const at = (x: number) => starts.some((s) => Math.abs(s - x) <= tol);
  let prev = -1;
  for (const p of ln.pieces) {
    const k = columnOf(starts, p.x0, tol);
    if (!at(p.x0) && (prev === -1 || k !== prev)) return false;
    if (k + 1 < starts.length && p.x1 > starts[k + 1] + tol) return false;
    prev = k;
  }
  return true;
}

/** 几个横向位置按 tol 归并（相差 tol 以内的算同一处，取最左的），从小到大。 */
function cluster(xs: number[], tol: number): number[] {
  const out: number[] = [];
  for (const x of [...xs].sort((a, b) => a - b)) if (!out.length || x - out[out.length - 1] > tol) out.push(x);
  return out;
}

/** 一个表格行的文字：各行的词段按列边界归到列，一列里同一行的词段隔一个空格，折行按接行的规矩接上；各列之间隔两个空格，空的列不写。 */
function rowText(lines: Line[], cols: number[]): string {
  const columns: string[][] = cols.map(() => []);
  for (const ln of lines) {
    const here = new Map<number, string[]>();
    for (const p of ln.pieces) {
      const k = columnOf(cols, p.x0, 0.5 * ln.size);
      if (!here.has(k)) here.set(k, []);
      here.get(k)!.push(p.text);
    }
    for (const [k, texts] of here) columns[k].push(texts.join(" "));
  }
  return columns.map(joinLines).filter((text) => text).join("  ");
}

/**
 * 表格：从第 i 行（表格的一行，isRow）起认出连着的几个表格行，每个表格行连同它的折行并成一块，文字按列拼好；返回这几块与表格之后那一行的下标。
 *
 * pdf.js 按文件里写字的先后给文字。常见的写法（LibreOffice 转出的文件就是）一格写完再写下一格：一格里折成几行时，先往下写完这一格，
 * 再往上跳回这一行的第一条基线写下一格。所以一个表格行到这里是交错的几行，例如「R01 账号类 重置用户」「口令」「必须审批 用户直属」「主管」。
 *
 * 列边界从这几样里来（相差半个字以内的算同一处）：各表格行里隔着两个字宽以上空隙的格的起点；在两行以上的行首出现的位置
 * （一格里的各行都从这一列的左边起）；第一行里隔着空白、后面有一行的行首从同一处起的词段起点（只看行首，不看行中间的词：
 * 「查询 ER」「查询 OA」里 ER 与 OA 起点相同，却是一格里的词，不是列）。后两样管的是两格之间空隙不到两个字宽的情形，
 * 例如表头的「审批要求 审批人」。认折行时用的候选列边界，行首位置从表格开头往下数（到往下跳开三个字高以上、字号变了、转了方向、
 * 高过表格第一行为止；往下跳按已经到过的最低一行算），不用第一行的词段起点（「查询 ER」这样一格里的词起点会挡住这一格的折行）。
 * - 一行是下一个表格行：是表格的一行（isRow），从表格的左边起，基线在这一个表格行最低的那条基线之下，相差不到三个字高，
 *   并且各格的起点都对得上已经并进来的行里某一格的起点、某一行的行首或第一行的某个词段起点（为的是不把页眉那种左右两端各有字的一行与紧接着的表格当成同一张表）。
 * - 一行是这一个表格行的折行：没有转方向，基线不高过这一行的第一条基线，排得进列里（fitsColumns），并且摆得下：它起头的那一列里
 *   这一行已经有字时，它紧接在那一列最低的一行之下、不超过一格里折行的行距的 1.15 倍（折行的行距取这张表里同一处起头的相邻两行之差的最小值；
 *   换一个表格行时还要加上格的上下留白，比它大，所以上一页最后一行折到这一页、排在重复的表头之下的那几行不会并进表头）；还没有字时，
 *   在这一行已有的上下范围以内（各格顶端对齐、居中对齐都摆得下）。那一列里已经有字时还要那一列的上一行已经排到这一列的右边、
 *   放不下这一行开头的词（列的右边取这一页上从这一列起点起、不越过下一列起点的词段排到的最右处）：这一条挡住两种误并——
 *   页眉页脚那种左右两端各有字的行把紧接着的下一行当成它的折行；上一页最后一行折到这一页、排在重复的表头之下的那几个字并进表头。
 *   第一列空着、别的列有字的一行照此也并进上一行。从表格的左边起、在这一个表格行之下的行不是折行：有两格以上的只能是下一个表格行，
 *   只有一格的只在这一个表格行到此还只有第一列的字时才算第一列的折行；不然表格到此为止。
 * - 别的行：表格到此为止。
 */
function tableRows(lines: Line[], i: number): { blocks: Block[]; next: number } {
  const first = lines[i];
  const tol = 0.5 * first.size;
  const sameSize = (ln: Line) => !ln.rotated && Math.abs(ln.size - first.size) <= 0.12 * first.size;
  const recurring = (xs: number[]) => cluster(xs, tol).filter((x) => xs.filter((y) => Math.abs(x - y) <= tol).length >= 2);
  let end = i + 1;
  for (let low = first.y; end < lines.length && sameSize(lines[end]) && lines[end].y <= first.y + tol && low - lines[end].y <= 3 * first.size; end++) {
    low = Math.min(low, lines[end].y);
  }
  const window = lines.slice(i, end);
  const candidates = cluster([...window.filter(isRow).flatMap((l) => l.cells.map((c) => c.x0)),
    ...recurring(window.map((l) => l.x0))], tol);
  // 一格里折行的行距：窗口里从同一处起头的行，相邻两行基线之差的最小值（换一个表格行时还要加上格的上下留白，比它大）。
  const pitches: number[] = [];
  for (const x of cluster(window.map((l) => l.x0), tol)) {
    const ys = window.filter((l) => Math.abs(l.x0 - x) <= tol).map((l) => l.y).sort((a, b) => b - a);
    for (let k = 1; k < ys.length; k++) if (ys[k - 1] - ys[k] > tol) pitches.push(ys[k - 1] - ys[k]);
  }
  const wrap = pitches.length ? Math.min(...pitches) : 2 * first.size;
  // 每一列的文字排到的最右处：这一页上从这一列的起点起、又不越过下一列起点的词段，排到的最右处（散文的一行一截横跨几列，不算）。
  const rightOf = (k: number) => Math.max(...lines.flatMap((l) => l.pieces)
    .filter((p) => Math.abs(p.x0 - candidates[k]) <= tol && (k + 1 >= candidates.length || p.x1 <= candidates[k + 1] + tol)).map((p) => p.x1), -Infinity);
  /**
   * 这一行在这一个表格行里摆得下：它起头的那一列里已经有字时，它紧接在那一列最低的一行之下、一个折行的行距以内，
   * 并且那一行已经排到这一列的右边、放不下这一行开头的词（不然那一格在那里就结束了，这一行不是它的折行）；还没有字时，在这一行已有的上下范围以内。
   */
  const placed = (ln: Line, row: Line[]) => {
    const k = columnOf(candidates, ln.pieces[0].x0, tol);
    const inColumn = (l: Line) => l.pieces.filter((p) => columnOf(candidates, p.x0, 0.5 * l.size) === k);
    const same = row.filter((l) => inColumn(l).length);
    if (!same.length) return ln.y <= row[0].y + tol && ln.y >= Math.min(...row.map((l) => l.y)) - tol;
    const above = same.reduce((a, b) => (b.y < a.y ? b : a));
    const dy = above.y - ln.y;
    const end = Math.max(...inColumn(above).map((p) => p.x1));
    const word = isCjk([...ln.pieces[0].text][0]) ? ln.size : (ln.pieces[0].x1 - ln.pieces[0].x0) * (ln.pieces[0].text.split(" ")[0].length / ln.pieces[0].text.length);
    return dy > tol && dy <= 1.15 * wrap && end + 0.3 * ln.size + word > rightOf(k) - 0.3 * ln.size;
  };
  const rows: Line[][] = [[first]];
  // 已经并进来的各行的格起点与行首：下一个表格行的各格要对得上它们。
  const seen = [...first.cells.map((c) => c.x0), ...first.pieces.map((p) => p.x0)];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const ln = lines[j];
    const row = rows[rows.length - 1];
    const lowY = Math.min(...row.map((l) => l.y));
    if (!sameSize(ln)) break;
    const atLeft = Math.abs(ln.x0 - first.x0) <= tol;
    const below = ln.y < lowY - tol;
    if (atLeft && below && isRow(ln)) {
      if (lowY - ln.y >= 3 * ln.size || !ln.cells.every((c) => seen.some((x) => Math.abs(x - c.x0) <= tol))) break;
      rows.push([ln]);
      seen.push(...ln.cells.map((c) => c.x0));
    } else if (atLeft && below && !row.every((l) => Math.abs(l.x0 - first.x0) <= tol)) break;
    else if (ln.y <= row[0].y + tol && fitsColumns(ln, candidates) && placed(ln, row)) {
      row.push(ln);
      seen.push(ln.x0);
    } else break;
  }
  const group = lines.slice(i, j);
  const later = group.slice(1).map((l) => l.x0);
  const cols = cluster([
    ...rows.flatMap((row) => row[0].cells.map((c) => c.x0)),
    ...recurring(group.map((l) => l.x0)),
    ...first.pieces.map((p) => p.x0).filter((x) => later.some((y) => Math.abs(x - y) <= tol)),
  ], tol);
  const blocks = rows.map((row): Block => ({
    lines: row, x0: Math.min(...row.map((l) => l.x0)), x1: Math.max(...row.map((l) => l.x1)), row: true, text: rowText(row, cols),
  }));
  return { blocks, next: j };
}

/**
 * 行 → 块，分两步（规则见开头的说明）。
 * 头一步按版面切成几段连着的行：表格行连同它的折行自成一块（tableRows）；往上跳、字号变了、行距明显变大、横向跳开很远、遇到转了方向的字，都另起一段。
 * 后一步在每段连着的行里找段落的分界：首行缩进，或者上一行后面还放得下这一行开头的词（上一行是它那一段的最后一行）。
 */
function blocksOf(lines: Line[]): Block[] {
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const dy = lines[i - 1].y - lines[i].y;
    if (dy > 0 && dy < 3 * lines[i].size && Math.abs(lines[i].size - lines[i - 1].size) < 0.5) pitches.push(dy);
  }
  const pitch = median(pitches);
  const mono = monospaceLines(lines);
  markIndents(lines, mono);
  const runs: (Line[] | Block[])[] = [];
  let run: Line[] | null = null;
  for (let i = 0; i < lines.length;) {
    const ln = lines[i];
    // 等宽字体的行（代码）每行单独一块，行首补上缩进的空格；代码里为了对齐留的大空隙不当作表格的格。
    if (mono[i]) {
      runs.push([{ lines: [ln], x0: ln.x0, x1: ln.x1, row: false, text: " ".repeat(ln.indent) + ln.cells.map((c) => c.text).join(" ") }]);
      run = null;
      i++;
      continue;
    }
    if (isRow(ln)) {
      const table = tableRows(lines, i);
      runs.push(table.blocks);
      run = null;
      i = table.next;
      continue;
    }
    i++;
    let brk = !run;
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
    }
    run.push(ln);
  }
  const blocks: Block[] = [];
  for (const part of runs) {
    if (part.length && "lines" in part[0]) {
      blocks.push(...(part as Block[]));
      continue;
    }
    const each = part as Line[];
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
        // 列表项：这一块的第一行以编号开头时，比编号那一列靠右的行是悬挂缩进的续行（不是首行缩进）；
        // 续行之后退回编号那一列的行、又以编号开头的行，都是下一项或列表之后的话，另起一块。
        const head = blk!.lines[0];
        const listItem = startsWithMarker(head);
        const hanging = listItem && ln.x0 > head.x0 + 0.5 * size;
        const outdent = listItem && !hanging && blk!.lines.some((l) => l.x0 > head.x0 + 0.5 * size);
        brk = prevEnded || (firstLine && !hanging) || outdent || (listItem && startsWithMarker(ln));
      }
      if (!blk || brk) {
        blk = { lines: [], x0: ln.x0, x1: ln.x1, row: false };
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

/** size 是这一块里最大的字号。 */
interface PageBlock { text: string; bbox: PdfBox; running: boolean; key: string | null; size: number }
interface PageResult { page: number; width: number; height: number; rotate: number; blocks: PageBlock[] }

/** 一页的文字条目 → 这一页的各块（还没有判页眉页脚、没有编块号）。 */
function pageBlocks(items: TextItem[], styles: TextStyles, viewport: Viewport): PageBlock[] {
  return blocksOf(linesOf(items, styles)).map((b) => {
    const text = tidyPdfText(b.text ?? joinLines(b.lines.map((l) => l.cells.map((c) => c.text).join(" "))));
    const bbox: PdfBox = [
      round(Math.min(...b.lines.map((l) => l.x0))), round(Math.min(...b.lines.map((l) => l.bottom))),
      round(Math.max(...b.lines.map((l) => l.x1))), round(Math.max(...b.lines.map((l) => l.top))),
    ];
    // 显示出来的纵向位置（页面可能自己带旋转，所以换成显示坐标再看）：整块在上边 12% 以内或下边 12% 以内才可能是页眉页脚。
    const ys = [viewport.convertToViewportPoint(bbox[0], bbox[1])[1], viewport.convertToViewportPoint(bbox[2], bbox[3])[1]];
    const edge = Math.max(...ys) <= EDGE * viewport.height ? "top" : Math.min(...ys) >= (1 - EDGE) * viewport.height ? "bottom" : null;
    const key = edge ? `${edge}|${text.replace(/\s+/g, "").replace(/\d+/g, "#")}` : null;
    return { text, bbox, running: false, key, size: Math.max(...b.lines.map((l) => l.size)) };
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

// ───────────── 按字号推断小节 ─────────────

/**
 * 没有书签目录的文件，按字号推断小节的标题，只给分段清单用（文字版不写 #，位置表的 headings 仍只收书签）：
 * - 一块算候选的标题：它的字号大于这一页正文字号的 1.2 倍（正文字号是这一页各块按字数算的字号中位数），整块不超过 60 个字，
 *   并且紧接着的下一块（这一页的最后一块就看下一页的第一块）字号比它小。不要求下一块就是正文：大标题下面常紧跟一个小一号的小标题。
 * - 候选按字号分档（相差不到半点的算一档）。只用一档开段：在两页以上出现的各档里字号最大的那一档；没有一档在两页以上出现时，用最大的那一档。
 *   封面上的大字只在一页出现，因此不被选上；各节下面的小标题字号更小，也不选。
 * 页眉页脚不算块。
 */
function inferHeadings(pages: PageResult[]): { page: number; title: string }[] {
  const flat = pages.flatMap((pg) => pg.blocks.filter((b) => !b.running).map((b) => ({ page: pg.page, block: b })));
  const body = new Map<number, number>();
  for (const pg of pages) {
    const sizes = pg.blocks.filter((b) => !b.running).flatMap((b) => Array<number>([...b.text].length).fill(b.size));
    body.set(pg.page, median(sizes));
  }
  const found: { page: number; title: string; size: number }[] = [];
  flat.forEach(({ page, block }, i) => {
    const next = flat[i + 1]?.block;
    if (block.size > 1.2 * (body.get(page) ?? Infinity) && [...block.text].length <= 60 && next !== undefined && next.size < block.size) {
      found.push({ page, title: block.text, size: Math.round(block.size * 2) / 2 });
    }
  });
  if (!found.length) return [];
  const pagesOf = new Map<number, Set<number>>();
  for (const h of found) pagesOf.set(h.size, (pagesOf.get(h.size) ?? new Set()).add(h.page));
  const sizes = [...pagesOf.keys()].sort((a, b) => b - a);
  const chosen = sizes.find((size) => pagesOf.get(size)!.size >= 2) ?? sizes[0];
  return found.filter((h) => h.size === chosen).map(({ page, title }) => ({ page, title }));
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
块是按版面把相邻的几行接起来得到的，不一定正好是一个自然段；表格的一行是一块，一格里折成几行的文字接在一起，各格之间隔两个空格，不分列；
代码（等宽字体排的行）一行是一块，行首的空格是原来的缩进。
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
/** 用了多少秒，写给人看：十秒以上写整数，不到十秒留一位小数。 */
export function secondsText(ms: number): string {
  const seconds = ms / 1000;
  return seconds >= 10 ? String(Math.round(seconds)) : String(Math.round(seconds * 10) / 10);
}

/**
 * 到时限没有做完时的那句话：用了多久、读到了第几页、一共几页。read 是已经读完的页数，total 是总页数；
 * 一页都还没有读完、或者不知道总页数时不写括号里的那一截。
 */
export function tooSlowText(ms: number, read: number | null, total: number | null): string {
  const where = read !== null && total !== null && read > 0 ? `（已读到第 ${read} 页，共 ${total} 页）` : total !== null ? `（共 ${total} 页，第 1 页还没有读完）` : "";
  return `解析用了 ${secondsText(ms)} 秒仍没有完成${where}，这份文件太复杂，本版不支持`;
}

/** 算出 PDF 的投影（用户与助手看到的叫法是「文字版」）与位置表。progress 在每读完一页之后调一次：已经读完几页、一共几页（上传时另起的那一次运行靠它把进度报给任务服务）。 */
export async function pdfProjection(data: Uint8Array, rel: string, limits: PdfLimits = PDF_LIMITS, progress?: (read: number, total: number) => void): Promise<PdfProjection> {
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
      if (expired()) throw new PdfProjectionError(tooSlowText(performance.now() - started, n - 1, doc.numPages));
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const { items, styles = {} } = await page.getTextContent();
      const own = items.reduce((sum, it) => sum + (it.str ?? "").replace(/\s+/g, "").length, 0);
      chars += own;
      if (chars > limits.chars) throw new PdfProjectionError(`这份 PDF 的文字超过上限 ${limits.chars} 字，在第 ${n} 页停下了`);
      pages.push({ page: n, width: viewport.width, height: viewport.height, rotate: page.rotate, blocks: pageBlocks(items, styles, viewport) });
      page.cleanup();
      progress?.(n, doc.numPages);
    }
    markRunningHeads(pages);
    const headings = await outlineHeadings(doc, expired);
    const info = (await doc.getMetadata().catch(() => ({ info: undefined }))).info ?? {};
    const producer = [info.Producer, info.Creator].find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim() ?? "";
    const { markdown, units, locations, noText } = render(pages, rel);
    const inferred = headings.length ? [] : inferHeadings(pages);
    return {
      markdown, pages: pages.length, units, chars, no_text_pages: noText, inferred,
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
 * 在 .pdf 旁边写投影（用户与助手看到的叫法是「文字版」）、分段清单与位置表。pdf 是文件路径，rel 是它相对任务目录的路径。
 * 解析不了，或者三样里有一样没写成时抛 PdfProjectionError，已经写下的由 removePdfProjection 清掉。
 */
export async function writePdfProjection(pdf: string, rel: string, segments: SegmentParams = SEGMENT_DEFAULTS, limits: PdfLimits = PDF_LIMITS,
  progress?: (read: number, total: number) => void): Promise<WrittenPdfProjection> {
  let data: Buffer;
  try {
    data = readFileSync(pdf);
  } catch {
    throw new PdfProjectionError(`读不到文件 ${pdf}。`);
  }
  const result = await pdfProjection(data, rel, limits, progress);
  const out = { projection: pdf + PDF_PROJECTION_SUFFIX, segments: pdf + PDF_SEGMENTS_SUFFIX, locations: pdf + PDF_LOCATIONS_SUFFIX };
  try {
    try {
      writeFileSync(out.projection, result.markdown, "utf-8");
    } catch (error) {
      throw new PdfProjectionError(`文字版没有写成：${(error as Error).message}`);
    }
    try {
      writePdfSegments(out.segments, buildPdfSegments(result.markdown, segments, rel, rel + PDF_PROJECTION_SUFFIX, result.locations.headings, result.inferred));
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
