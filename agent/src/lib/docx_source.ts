/**
 * Word 材料（.docx）作来源时的出处与摘录核对。
 *
 * 上传 .docx 时后端在旁边生成 Markdown 投影「文件名.docx.md」（lib/docx_markdown.ts，经 cli/docx_projection.mts）：
 * 每段一行，段落号写成「[pN]」，它右边是这一段的正文，左边是 Markdown 标记与 Word 自动编号。执行者读投影，
 * 引用时出处写「inputs/x.docx#pN」，摘录逐字抄第 N 段的正文。0.2 的任务里是纯文本投影「文件名.docx.txt」
 * （每行行首「[第 N 段]」或「[第 N 段 · 表 t 行 r 列 c]」），照旧可读：先找 .md，没有再找 .txt，按各自的格式解析。
 * 材料区按原版式渲染这份 .docx，按同一条计数规则给段落编号，点来源时按段落号定位，所以这里的查找规则与前端一致：
 * - 比较时去掉全部空白字符（制表符、段内换行、全角空格都不影响）；
 * - 先在第 N 段里找；找不到就把第 N 段和后面最多 5 段接起来找，摘录从第 N 段里开始才算（跨段）；
 * - 都找不到就是找不到。
 */

/** 出处是 .docx 时的形状：路径，加可选的「#p段落号」。 */
export const DOCX_LOCATOR = /^(.+\.docx)(?:#p(\d+))?$/i;
/** 跨段时往后最多接几段。 */
export const SPAN_LIMIT = 5;

/** 投影文件跟在 .docx 路径后面的后缀：先找 Markdown 投影，没有再找 0.2 的纯文本投影。 */
export const PROJECTION_SUFFIXES = [".md", ".txt"] as const;

const LEGACY_LINE = /^\[第 (\d+) 段(?: · [^\]]*)?\] ?(.*)$/;
const ANCHOR = /\[p(\d+)\] ?/;
const IMAGE = /\s*!\[[^\]]*\]\([^)]*\)\s*/g;

/** 是不是 0.2 的纯文本投影（有一行以「[第 N 段」开头）。 */
export const isLegacyProjection = (text: string) => /^\[第 \d+ 段/m.test(text);

/** 一截（一行，或表格一格里用 <br> 隔开的一截）里的段落号与正文；没有段落号的返回 null。正文去掉图片链接。 */
function anchored(segment: string, cell: boolean): [number, string] | null {
  const m = ANCHOR.exec(segment);
  if (!m) return null;
  let text = segment.slice(m.index + m[0].length).replace(IMAGE, " ").trim();
  if (cell) text = text.replace(/\\\|/g, "|");
  return [Number(m[1]), text];
}

/** Markdown 投影里一行表格拆成各格（按没有转义的竖线拆，去掉两头）。 */
export function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
}

/**
 * 投影全文 → 各段文字，下标 0 是第 1 段；两种投影都认。开头的说明、没有段落号的行（文本框、占位）不算；
 * 空段落不写进 Markdown 投影，这里是空文字。段数取开头说明里的「段落总数」，没有就取最大的段落号。
 */
export function projectionParagraphs(text: string): string[] {
  const out: string[] = [];
  if (isLegacyProjection(text)) {
    for (const line of text.split("\n")) {
      const m = LEGACY_LINE.exec(line);
      if (m) out[Number(m[1]) - 1] = m[2];
    }
    return Array.from(out, (p) => p ?? "");
  }
  const total = Number(/段落总数：(\d+)/.exec(/<!--[\s\S]*?-->/.exec(text)?.[0] ?? "")?.[1] ?? 0);
  for (const line of text.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    if (line.startsWith(">")) continue;
    const cell = line.startsWith("|");
    for (const segment of cell ? tableCells(line).flatMap((c) => c.split("<br>")) : [line]) {
      const hit = anchored(segment, cell);
      if (hit) out[hit[0] - 1] = hit[1];
    }
  }
  if (out.length < total) out[total - 1] = out[total - 1] ?? "";
  return Array.from(out, (p) => p ?? "");
}

const squeeze = (s: string) => s.replace(/\s+/g, "");

export type ExcerptPlace = { kind: "in" } | { kind: "span"; last: number } | { kind: "miss" };

/** 摘录在第 n 段（从 1 起）的哪里：段内、从这一段起跨到第 last 段、或找不到。 */
export function placeExcerpt(paragraphs: string[], n: number, excerpt: string): ExcerptPlace {
  const want = squeeze(excerpt);
  if (!want || n < 1 || n > paragraphs.length) return { kind: "miss" };
  const own = squeeze(paragraphs[n - 1]);
  if (own.includes(want)) return { kind: "in" };
  let joined = own;
  for (let m = n + 1; m <= Math.min(paragraphs.length, n + SPAN_LIMIT); m++) {
    joined += squeeze(paragraphs[m - 1]);
    const at = joined.indexOf(want);
    if (at >= 0 && at < own.length) return { kind: "span", last: m };
  }
  return { kind: "miss" };
}

/** Markdown 投影里文本框的文字（以「>」开头的行，去掉「> （文本框）」或「> 」），各行接在一起；0.2 的纯文本投影里没有文本框，是空文字。 */
export function textBoxText(text: string): string {
  if (isLegacyProjection(text)) return "";
  return text.replace(/<!--[\s\S]*?-->/g, "").split("\n").filter((l) => l.startsWith(">"))
    .map((l) => l.replace(/^>\s?(（文本框）)?/, "")).join("\n");
}

/** 摘录是不是出自文本框（去掉空白后是文本框文字的一部分）。 */
export function inTextBox(text: string, excerpt: string): boolean {
  const want = squeeze(excerpt);
  return !!want && squeeze(textBoxText(text)).includes(want);
}

/** 按上面的规则能找到这段摘录的全部段落（摘录从那一段开始），从小到大。 */
export function paragraphsWith(paragraphs: string[], excerpt: string): number[] {
  return [...paragraphs.keys()].map((i) => i + 1).filter((n) => placeExcerpt(paragraphs, n, excerpt).kind !== "miss");
}

/**
 * 投影里表格中各段的位置，写成「表 t 行 r 列 c」（嵌在格里的小表格写外层位置）；两种投影都认。
 * Markdown 投影：连续以竖线开头的行是一张表，表头算第 1 行、分隔行不算，第几格就是第几列（横向合并跨过的列写了占位）。
 */
export function projectionTablePositions(text: string): Map<number, string> {
  const out = new Map<number, string>();
  if (isLegacyProjection(text)) {
    for (const line of text.split("\n")) {
      const m = /^\[第 (\d+) 段 · (表 \d+ 行 \d+ 列 \d+)/.exec(line);
      if (m) out.set(Number(m[1]), m[2]);
    }
    return out;
  }
  let table = 0;
  let row = 0;
  let inTable = false;
  for (const line of text.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    if (!line.startsWith("|")) { inTable = false; continue; }
    if (!inTable) { inTable = true; table++; row = 0; }
    if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) continue;
    row++;
    tableCells(line).forEach((cell, i) => {
      for (const segment of cell.split("<br>")) {
        const m = ANCHOR.exec(segment);
        if (m) out.set(Number(m[1]), `表 ${table} 行 ${row} 列 ${i + 1}`);
      }
    });
  }
  return out;
}
