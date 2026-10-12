/**
 * 把生成出来的文档（Markdown 文本）切成一块一块：标题、段落、列表、表格、引用、图、代码。页面的文档预览照这些块排版，
 * Word 文件也照同一批块写，所以两处的章节次序与内容必然相同。只做计算，不碰文件，页面也用它。
 *
 * 认的写法只有生成文档用到的这几种，别的原样当段落：
 * - 标题：一到四个井号加一个空格；
 * - 表格：以竖线开头的连续几行，第二行是由短横线组成的分隔行；格子里的竖线写成反斜线加竖线；
 * - 列表：以「- 」或「数字. 」开头的连续几行，前面每两个空格缩进一层；
 * - 引用：以「> 」开头的连续几行；
 * - 代码块：三个反引号围起来。开头那一行写着 mermaid 的是一张图，后面可以跟图的编号（```mermaid D-004）；
 * - 段落：别的连续几行，行与行之间保留换行；
 * - 行内只认加粗（两个星号围起来）。
 */

/** 一段文字里的一截：加粗或者不加粗。 */
export interface DocRun {
  text: string;
  bold: boolean;
}

export type DocBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "paragraph"; runs: DocRun[] }
  | { kind: "list"; ordered: boolean; items: { depth: number; runs: DocRun[] }[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "quote"; runs: DocRun[] }
  | { kind: "figure"; diagram_id: string | null; mermaid: string }
  | { kind: "code"; text: string };

/** 行内的加粗：两个星号围起来的一截。星号没有成对时原样当文字。 */
export function docRuns(text: string): DocRun[] {
  const runs: DocRun[] = [];
  let at = 0;
  for (const m of text.matchAll(/\*\*(.+?)\*\*/gs)) {
    if (m.index! > at) runs.push({ text: text.slice(at, m.index), bold: false });
    runs.push({ text: m[1], bold: true });
    at = m.index! + m[0].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at), bold: false });
  return runs;
}

/** 一段带行内写法的文字去掉记号之后的样子（标题与表格的格子里用）。 */
export const plainText = (text: string): string => docRuns(text).map((run) => run.text).join("");

const HEADING = /^(#{1,4}) (.+)$/;
const ITEM = /^(\s*)(?:- |(\d+)\. )(.*)$/;
const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;
const FENCE = /^```\s*(\S*)\s*(\S*)\s*$/;

/** 表格的一行切成各格：两头的竖线不算，格子里写成反斜线加竖线的还原成竖线。 */
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|\s*$/, "");
  return inner.split(/(?<!\\)\|/).map((one) => plainText(one.trim().replace(/\\\|/g, "|")));
}

export function documentBlocks(markdown: string): DocBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      blocks.push(fence[1] === "mermaid" ? { kind: "figure", diagram_id: fence[2] || null, mermaid: body.join("\n") } : { kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3 | 4, text: plainText(heading[2].trim()) });
      i += 1;
      continue;
    }
    if (line.startsWith("|") && i + 1 < lines.length && SEPARATOR.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].startsWith("|")) rows.push(cells(lines[i++]));
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    if (line.startsWith("> ") || line === ">") {
      const body: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) body.push(lines[i++].replace(/^> ?/, ""));
      blocks.push({ kind: "quote", runs: docRuns(body.join("\n")) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const items: { depth: number; runs: DocRun[] }[] = [];
      const ordered = item[2] !== undefined;
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (!m) break;
        items.push({ depth: Math.floor(m[1].length / 2), runs: docRuns(m[3]) });
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !ITEM.test(lines[i]) && !lines[i].startsWith("> ")
      && !(lines[i].startsWith("|") && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]))) {
      body.push(lines[i++]);
    }
    blocks.push({ kind: "paragraph", runs: docRuns(body.join("\n")) });
  }
  return blocks;
}

/** 文档里放了哪几张图（写了编号的），照出现的先后，不重复。 */
export function figureIds(blocks: readonly DocBlock[]): string[] {
  const ids: string[] = [];
  for (const block of blocks) if (block.kind === "figure" && block.diagram_id && !ids.includes(block.diagram_id)) ids.push(block.diagram_id);
  return ids;
}
