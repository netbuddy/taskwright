/**
 * 知识库文档切成片段（src/knowledge_chunks.ts）：Word 文档按分段清单的块、块内按段落接；Markdown 按标题与空行；纯文本只按空行；
 * 超过上限的一段先在句末切、找不到句末就在上限处切；全是空白的段不成片段；送去换算的文字是标题一行加正文。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { docxProjection } from "../../agent/src/lib/docx_markdown.ts";
import { SEGMENT_DEFAULTS, buildSegments } from "../../agent/src/lib/segments.ts";
import { CHUNK_MAX_CHARS, type Chunk, chunkDocument, chunkInput, chunkMarkdown, chunkPlain, chunkWord, splitLong } from "../src/knowledge_chunks.ts";
import { ROOT } from "./helpers.ts";

const SAMPLE = join(ROOT, "examples", "library-lending", "requirements-styled.docx");
const size = (text: string) => Array.from(text).length;
/** 片段的位置与标题，写成一行好比较。 */
const lines = (chunks: Chunk[]) => chunks.map((c) => [c.index, c.heading, c.first_line, c.last_line, c.text]);

test("Word 文档：片段不跨块，带所在块的标题与起止段落号；有文字的段落一段不少、一段不重，正文里没有段落号记号", () => {
  const projection = docxProjection(readFileSync(SAMPLE), "general/files/x.docx").markdown;
  const blocks = buildSegments(projection, SEGMENT_DEFAULTS, "", "").blocks;
  const chunks = chunkWord(projection, SEGMENT_DEFAULTS);
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i + 1));
  // 示例文档每块都不到 800 字，所以正好一块一个片段。
  assert.deepEqual(chunks.map((c) => [c.heading, c.first_paragraph, c.last_paragraph]), blocks.map((b) => [b.heading, b.first_paragraph, b.last_paragraph]));
  assert.deepEqual(chunks.map((c) => c.text.split("\n").length), blocks.map((b) => b.paragraphs));
  for (const c of chunks) {
    assert.ok(size(c.text) <= CHUNK_MAX_CHARS);
    assert.deepEqual([c.first_line, c.last_line], [null, null]);
    assert.doesNotMatch(c.text, /\[p\d+\]/);
  }
  assert.equal(chunks[1].text.split("\n")[0], "概述");
  assert.match(chunks[1].text, /我们学校图书馆现在用纸质登记簿记录借还/);
  // 上限调小之后，一块切成几个片段：标题相同，段落号首尾相接，仍然不跨块。
  const small = chunkWord(projection, { ...SEGMENT_DEFAULTS, max_paragraphs: 1000, min_paragraphs: 1, heading_depth: 1 });
  assert.ok(small.length >= 5);
  for (const c of small) assert.ok(c.first_paragraph! <= c.last_paragraph!);
});

test("Word 文档：一块的字数超过上限时切成几个片段，每个都不超过上限，段落号首尾相接", () => {
  const paragraph = (n: number) => `[p${n}] ${"借".repeat(299)}。`;
  const projection = ["<!--", "段落总数：7。", "-->", "", "# 1 [p1] 规则", "", ...[2, 3, 4, 5, 6, 7].flatMap((n) => [paragraph(n), ""])].join("\n");
  const chunks = chunkWord(projection, SEGMENT_DEFAULTS);
  // 标题 2 个字，每段 300 个字：标题加两段是 2 + 1 + 300 + 1 + 300 = 604，再加一段就超过 800。
  assert.deepEqual(chunks.map((c) => [c.heading, c.first_paragraph, c.last_paragraph, size(c.text)]),
    [["1 规则", 1, 3, 604], ["1 规则", 4, 5, 601], ["1 规则", 6, 7, 601]]);
});

test("超过上限的一段：先在句末的标点后面切；上限的后一半里没有句末的标点就在上限处切；各片位置相同", () => {
  const sentence = "读者凭借书证借书。";   // 9 个字
  const long = sentence.repeat(200);       // 1800 个字
  const pieces = splitLong(long);
  assert.equal(pieces.join(""), long);
  assert.deepEqual(pieces.map(size), [792, 792, 216]);
  for (const piece of pieces) assert.ok(piece.endsWith("。"));
  assert.deepEqual(splitLong("字".repeat(2000)).map(size), [800, 800, 400]);
  // 正好等于上限的不切。
  assert.deepEqual(splitLong("字".repeat(800)).map(size), [800]);
  const chunks = chunkPlain(`开头一段。\n\n${long}\n\n结尾一段。`);
  assert.deepEqual(chunks.map((c) => [c.first_line, c.last_line, size(c.text)]), [[1, 1, 5], [3, 3, 792], [3, 3, 792], [3, 3, 216], [5, 5, 5]]);
});

test("Markdown：标题开始一个小节，标题逐级连起来；空行分段，段落接到上限为止；位置是行号", () => {
  const text = [
    "开头的说明。",          // 1
    "",                      // 2
    "# 退款",                // 3
    "",                      // 4
    "七天之内可以退款。",    // 5
    "第二行接着写。",        // 6
    "",                      // 7
    "超过七天的不退。",      // 8
    "",                      // 9
    "## 时限 ##",            // 10
    "收到货之日起算。",      // 11
    "### 例外",              // 12
    "定制商品不退。",        // 13
    "# 运费",                // 14
    "运费由卖家出。",        // 15
  ].join("\n");
  assert.deepEqual(lines(chunkMarkdown(text)), [
    [1, null, 1, 1, "开头的说明。"],
    [2, "退款", 5, 8, "七天之内可以退款。\n第二行接着写。\n超过七天的不退。"],
    [3, "退款 / 时限", 11, 11, "收到货之日起算。"],
    [4, "退款 / 时限 / 例外", 13, 13, "定制商品不退。"],
    [5, "运费", 15, 15, "运费由卖家出。"],
  ]);
  // 标题跳级时，中间缺的那一级不写。
  assert.deepEqual(lines(chunkMarkdown("# 甲\n### 丙\n正文")), [[1, "甲", 1, 1, "甲"], [2, "甲 / 丙", 3, 3, "正文"]]);
});

test("Markdown：代码围栏里的 # 不算标题，围栏里的空行不分段；小节里除了标题没有别的字时，标题自己算一个片段", () => {
  const text = ["# 用法", "", "```sh", "# 这是注释，不是标题", "", "run --all", "```", "", "## 术语甲", "## 术语乙", "", "乙的解释。"].join("\n");
  assert.deepEqual(lines(chunkMarkdown(text)), [
    [1, "用法", 3, 7, "```sh\n# 这是注释，不是标题\n\nrun --all\n```"],
    [2, "用法 / 术语甲", 9, 9, "术语甲"],
    [3, "用法 / 术语乙", 12, 12, "乙的解释。"],
  ]);
});

test("纯文本：没有标题，以 # 开头的行也是正文；只按空行分段", () => {
  assert.deepEqual(lines(chunkPlain("# 不是标题\n第二行\n\n\n另一段")), [[1, null, 1, 5, "# 不是标题\n第二行\n另一段"]]);
});

test("全是空白的段不成片段：没有文字的文档切出来是零个片段", () => {
  assert.deepEqual(chunkPlain(""), []);
  assert.deepEqual(chunkPlain("  \n\n\t\n　\n"), []);
  assert.deepEqual(chunkMarkdown("\n\n   \n"), []);
  assert.deepEqual(chunkWord("<!--\n段落总数：3。\n-->\n", SEGMENT_DEFAULTS), []);
  assert.deepEqual(lines(chunkPlain("\n\n   \n有字\n \n")), [[1, null, 4, 4, "有字"]]);
});

test("按扩展名选切法；送去换算的文字是标题一行加正文，没有标题或者正文本来就以标题开头时只送正文", () => {
  const text = "# 退款\n七天之内可以退款。";
  assert.deepEqual(chunkDocument("规则.MD", text, SEGMENT_DEFAULTS).map((c) => c.heading), ["退款"]);
  assert.deepEqual(chunkDocument("规则.txt", text, SEGMENT_DEFAULTS).map((c) => c.heading), [null]);
  assert.equal(chunkInput({ heading: "退款", text: "七天之内可以退款。" }), "退款\n七天之内可以退款。");
  assert.equal(chunkInput({ heading: null, text: "七天之内可以退款。" }), "七天之内可以退款。");
  assert.equal(chunkInput({ heading: "术语甲", text: "术语甲" }), "术语甲");
});
