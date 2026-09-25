/**
 * Word 材料（.docx）作来源时的出处与摘录核对。
 *
 * 上传 .docx 时后端在旁边生成文本投影「文件名.docx.txt」（server 的 service/docx_text.py）：每段一行，行首是
 * 「[第 N 段]」或「[第 N 段 · 表 t 行 r 列 c]」。执行者读投影，引用时出处写「inputs/x.docx#pN」，摘录逐字抄第 N 段里的文字。
 * 材料区按原版式渲染这份 .docx，按同一条计数规则给段落编号，点来源时按段落号定位，所以这里的查找规则与前端一致：
 * - 比较时去掉全部空白字符（制表符、段内换行、全角空格都不影响）；
 * - 先在第 N 段里找；找不到就把第 N 段和后面最多 5 段接起来找，摘录从第 N 段里开始才算（跨段）；
 * - 都找不到就是找不到。
 */

/** 出处是 .docx 时的形状：路径，加可选的「#p段落号」。 */
export const DOCX_LOCATOR = /^(.+\.docx)(?:#p(\d+))?$/i;
/** 跨段时往后最多接几段。 */
export const SPAN_LIMIT = 5;

const LINE = /^\[第 (\d+) 段(?: · [^\]]*)?\] ?(.*)$/;

/** 投影全文 → 各段文字，下标 0 是第 1 段。开头的说明行与格式不对的行不算。 */
export function projectionParagraphs(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (m) out[Number(m[1]) - 1] = m[2];
  }
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

/** 摘录从哪一段开始（按上面的规则能找到的第一段），先从第 from 段往后找，再从头找到第 from 段之前；都没有是 null。 */
export function findParagraph(paragraphs: string[], excerpt: string, from = 1): number | null {
  const order = [...paragraphs.keys()].map((i) => i + 1);
  for (const n of [...order.slice(from - 1), ...order.slice(0, from - 1)]) {
    if (placeExcerpt(paragraphs, n, excerpt).kind !== "miss") return n;
  }
  return null;
}
