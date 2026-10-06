/**
 * 把知识库里的一份文档切成片段。片段是送去换算成数字串的一小段文字，一个片段对应一条数字串；按意思查找时查到的也是片段。
 *
 * 片段的正文最多 CHUNK_MAX_CHARS 个字（按字数，不按词元）。这个数是固定的：模型一次能收多长，产品这边查不到
 * （ollama 的嵌入模型登记时不带上下文长度）；模型连这么长都收不下时，由模型服务报错，那份文档记成换算失败。
 *
 * 三种文档各自的切法：
 * - Word 文档（.docx）：对着它的投影切。先按分段清单（agent/src/lib/segments.ts）分成块，块内把有文字的段落依次接起来，
 *   接到再加一段就超过上限为止；片段不跨块。每个片段记所在块的标题与起止段落号，引用时出处的段落号取起始的那一个。
 *   段落的文字不带段落号记号与图片链接；文本框里的字没有段落号，不在片段里。
 * - Markdown（.md）：标题行（1 到 6 个 # 开头，代码围栏里的不算）开始一个小节，小节内用空行隔开的各段依次接起来；片段不跨小节。
 *   片段的标题是各级标题用「 / 」连起来（「退款 / 时限」），位置记起止行号。小节里除了标题没有别的字时，标题自己算一个片段。
 * - 纯文本（.txt 与别的）：没有标题，只按空行分段再接起来，位置记起止行号。
 * 单独一段就超过上限时，先在句末的标点后面切开，上限的后一半里找不到句末的标点就在上限处切开；切出来的各片位置相同。
 * 全是空白的段不成片段，所以一份没有文字的文档切出来是零个片段。
 *
 * 送去换算的文字（chunkInput）是「标题一行加正文」；没有标题，或者正文本来就以标题开头时只送正文。
 *
 * 本模块只做计算，不读写文件。
 */

import { projectionParagraphs } from "../../agent/src/lib/docx_source.ts";
import { type SegmentParams, buildSegments } from "../../agent/src/lib/segments.ts";

/** 片段的正文最多多少个字。 */
export const CHUNK_MAX_CHARS = 800;

/** 切法的版本：切法改了就加一，已经存下的片段按旧切法算的，要重新换算。 */
export const CHUNK_RULES_VERSION = 1;

export interface Chunk {
  /** 第几个片段，从 1 起。 */
  index: number;
  /** Word 文档是所在块的标题，Markdown 是各级标题连起来；没有标题时是 null。 */
  heading: string | null;
  /** Word 文档的起止段落号；别的文档是 null。 */
  first_paragraph: number | null;
  last_paragraph: number | null;
  /** Markdown 与纯文本的起止行号（从 1 起）；Word 文档是 null。 */
  first_line: number | null;
  last_line: number | null;
  /** 片段的正文，不带标题。 */
  text: string;
}

/** 接起来之前的一段：文字（去掉了首尾空白，不是空的）与它的位置（Word 文档是段落号，别的是行号）。 */
interface Unit {
  text: string;
  first: number;
  last: number;
}

const SENTENCE_END = new Set(["。", "！", "？", "；", "…", ".", "!", "?", ";", "\n"]);

function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** 把超过上限的一段切成各片不超过上限的几片：尽量切在句末的标点后面。 */
export function splitLong(text: string, max: number = CHUNK_MAX_CHARS): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  let start = 0;
  while (chars.length - start > max) {
    let cut = start + max;
    for (let i = cut; i > start + max / 2; i--) {
      if (SENTENCE_END.has(chars[i - 1])) {
        cut = i;
        break;
      }
    }
    out.push(chars.slice(start, cut).join(""));
    start = cut;
  }
  out.push(chars.slice(start).join(""));
  return out.map((piece) => piece.trim()).filter((piece) => piece !== "");
}

/** 把同一个块（或小节）里的各段依次接成片段，追加到 out；word 为真时位置记成段落号，否则记成行号。 */
function pack(units: Unit[], heading: string | null, word: boolean, out: Chunk[]): void {
  const push = (text: string, first: number, last: number) => out.push({
    index: out.length + 1, heading,
    first_paragraph: word ? first : null, last_paragraph: word ? last : null,
    first_line: word ? null : first, last_line: word ? null : last,
    text,
  });
  let parts: string[] = [];
  let size = 0;
  let first = 0;
  let last = 0;
  const flush = () => {
    if (parts.length) push(parts.join("\n"), first, last);
    parts = [];
    size = 0;
  };
  for (const unit of units) {
    const n = charCount(unit.text);
    if (n > CHUNK_MAX_CHARS) {
      flush();
      for (const piece of splitLong(unit.text)) push(piece, unit.first, unit.last);
      continue;
    }
    // 各段之间用一个换行接起来，这个换行也算一个字。
    if (parts.length && size + 1 + n > CHUNK_MAX_CHARS) flush();
    if (!parts.length) first = unit.first;
    size += (parts.length ? 1 : 0) + n;
    parts.push(unit.text);
    last = unit.last;
  }
  flush();
}

/** Word 文档：projection 是它的投影全文，params 是分段参数。 */
export function chunkWord(projection: string, params: SegmentParams): Chunk[] {
  const paragraphs = projectionParagraphs(projection);
  const out: Chunk[] = [];
  for (const block of buildSegments(projection, params, "", "").blocks) {
    const units: Unit[] = [];
    for (let n = block.first_paragraph; n <= block.last_paragraph; n++) {
      const text = (paragraphs[n - 1] ?? "").trim();
      if (text) units.push({ text, first: n, last: n });
    }
    pack(units, block.heading, true, out);
  }
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/** Markdown 与纯文本：headings 为假时不认标题（纯文本）。 */
function chunkLines(text: string, headings: boolean): Chunk[] {
  const out: Chunk[] = [];
  const titles: (string | null)[] = [];
  /** 这个小节自己的标题与它所在的行；文档开头、第一个标题之前的那一节没有。 */
  let own: { text: string; line: number } | null = null;
  let units: Unit[] = [];
  let lines: string[] = [];
  let first = 0;
  let last = 0;
  let fence: string | null = null;
  const add = (line: string, no: number) => {
    if (!lines.length) first = no;
    lines.push(line);
    last = no;
  };
  const endParagraph = () => {
    const joined = lines.join("\n").trim();
    if (joined) units.push({ text: joined, first, last });
    lines = [];
  };
  const endSection = () => {
    endParagraph();
    if (!units.length && own) units.push({ text: own.text, first: own.line, last: own.line });
    pack(units, titles.filter((one) => one).join(" / ") || null, false, out);
    units = [];
  };
  text.split("\n").forEach((line, i) => {
    const no = i + 1;
    const mark = FENCE.exec(line);
    if (fence !== null) {
      add(line, no);
      // 围栏用同一种符号、不少于开头那么多个、后面不带别的字的一行收尾。
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && line.trim() === mark[1]) fence = null;
      return;
    }
    if (mark) {
      add(line, no);
      fence = mark[1];
      return;
    }
    const heading = headings ? HEADING.exec(line) : null;
    if (heading) {
      endSection();
      const level = heading[1].length;
      titles.length = Math.min(titles.length, level - 1);
      while (titles.length < level - 1) titles.push(null);
      titles.push(heading[2] || null);
      own = heading[2] ? { text: heading[2], line: no } : null;
      return;
    }
    if (line.trim() === "") endParagraph();
    else add(line, no);
  });
  endSection();
  return out;
}

export function chunkMarkdown(text: string): Chunk[] {
  return chunkLines(text, true);
}

export function chunkPlain(text: string): Chunk[] {
  return chunkLines(text, false);
}

/**
 * 按文档名的扩展名选切法。text 是文档的正文：Word 文档给投影全文，别的给文件的内容（行尾已经统一成 \n）。
 */
export function chunkDocument(name: string, text: string, params: SegmentParams): Chunk[] {
  const lower = name.toLowerCase();
  if (lower.endsWith(".docx")) return chunkWord(text, params);
  return lower.endsWith(".md") ? chunkMarkdown(text) : chunkPlain(text);
}

/** 这个片段送去换算的文字：标题一行加正文；没有标题，或者正文本来就以标题开头时只送正文。 */
export function chunkInput(chunk: Pick<Chunk, "heading" | "text">): string {
  return chunk.heading && !chunk.text.startsWith(chunk.heading) ? `${chunk.heading}\n${chunk.text}` : chunk.text;
}
