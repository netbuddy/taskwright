/**
 * 查到的片段的原文（src/knowledge_passage.ts）：Markdown 与纯文本逐字节相同、连空行；Word 逐段给、带段落号，表格另给行结构与表头；
 * 很长的一段切出来的一截只给这一截；源文字与片段对不上时退回片段里存的文字。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { projectionParagraphs } from "../../agent/src/lib/docx_source.ts";
import { SEGMENT_DEFAULTS } from "../../agent/src/lib/segments.ts";
import { chunkDocument, chunkMarkdown, chunkPlain, chunkWord } from "../src/knowledge_chunks.ts";
import { passageOf } from "../src/knowledge_passage.ts";

const projectionOf = (total: number, body: string[]) => ["<!--", `段落总数：${total}。`, "-->", "", ...body].join("\n");

test("Markdown 与纯文本：原文是源文字里从片段起点到终点的那一段，含空行与行尾的空白；每个片段的原文都是源文字的一部分", () => {
  const source = "# 规范\n\n第 1 条 甲。  \n\n\n第 2 条 乙。\n\n```\n代码里的\n\n空行\n```\n\n## 小节\n\n只有一段。\n";
  const chunks = chunkMarkdown(source);
  const passages = chunks.map((chunk) => passageOf("规范.md", chunk, source));
  assert.equal(passages[0].body, "第 1 条 甲。  \n\n\n第 2 条 乙。\n\n```\n代码里的\n\n空行\n```");
  assert.equal(passages[1].body, "只有一段。");
  for (const [i, one] of passages.entries()) {
    assert.ok(source.includes(one.body!), `第 ${i + 1} 个片段`);
    assert.deepEqual([one.paragraphs, one.table, one.header, one.exact], [null, null, null, true]);
  }
  // 很长的一段切出来的各截：各给各的，接起来是原来那一段。
  const long = `${"借".repeat(799)}。${"还".repeat(799)}。${"续".repeat(100)}`;
  const plain = `开头\n\n${long}\n`;
  const pieces = chunkPlain(plain).filter((chunk) => chunk.partial).map((chunk) => passageOf("长文.txt", chunk, plain).body);
  assert.deepEqual(pieces.map((body) => body!.length), [800, 800, 100]);
  assert.equal(pieces.join(""), long);
});

test("源文字与片段对不上（片段是按另一份内容切的）：退回片段里存的文字，exact 为假", () => {
  const source = "第一段。\n\n第二段。\n";
  const [chunk] = chunkPlain(source);
  const other = "换了内容，长短也不同。\n\n第二段还在。\n";
  assert.deepEqual(passageOf("说明.txt", chunk, other), { body: "第一段。\n第二段。", units: null, paragraphs: null, table: null, header: null, exact: false });
  assert.equal(passageOf("说明.txt", chunk, source).body, "第一段。\n\n第二段。");
});

test("Word 文档：逐段给并带段落号，文字与核对摘录用的段文字相同（带图片链接的段、表格里带转义竖线的格也一样）；表格给行结构；片段开头重复的表头另给", () => {
  const row = (n: number) => `| [p${n}] ${"甲".repeat(180)} | [p${n + 1}] ${"乙".repeat(180)} |`;
  const projection = projectionOf(13, ["# 1 [p1] 表", "", "[p2] 带图 ![图](media/a.png) 的一段", "", "| [p3] 名称 | [p4] 说 \\| 明 |", "|---|---|", row(5), row(7), row(9), row(11), "", "[p13] 表后面的一段。", ""]);
  const wanted = projectionParagraphs(projection);
  const chunks = chunkWord(projection, SEGMENT_DEFAULTS);
  const passages = chunks.map((chunk) => passageOf("表.docx", chunk, projection));
  for (const one of passages) {
    assert.equal(one.body, null);
    for (const p of one.paragraphs!) assert.equal(p.text, wanted[p.paragraph - 1], `第 ${p.paragraph} 段`);
  }
  assert.deepEqual(passages[0].paragraphs!.slice(0, 4), [{ paragraph: 1, text: "表" }, { paragraph: 2, text: "带图 的一段" }, { paragraph: 3, text: "名称" }, { paragraph: 4, text: "说 | 明" }]);
  assert.deepEqual(passages[0].table![0], [[3], [4]]);
  assert.equal(passages[0].header, null);
  // 后面的片段从表中间开始：表头另给，不在这个片段自己的各段里。
  const later = passages.slice(1).filter((one) => one.header);
  assert.ok(later.length >= 1);
  for (const one of later) {
    assert.deepEqual(one.header, { first_paragraph: 3, last_paragraph: 4, cells: [[3], [4]], paragraphs: [{ paragraph: 3, text: "名称" }, { paragraph: 4, text: "说 | 明" }] });
    assert.ok(one.paragraphs!.every((p) => p.paragraph > 4));
  }
  // 每一段都给到了，一段不少。
  assert.deepEqual([...new Set(passages.flatMap((one) => one.paragraphs!.map((p) => p.paragraph)))].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  // 没有表格的片段 table 是 null。
  const only = chunkWord(projectionOf(2, ["# 1 [p1] 规则", "", "[p2] 一段。", ""]), SEGMENT_DEFAULTS);
  assert.deepEqual(passageOf("规则.docx", only[0], projectionOf(2, ["# 1 [p1] 规则", "", "[p2] 一段。", ""])),
    { body: null, units: null, paragraphs: [{ paragraph: 1, text: "规则" }, { paragraph: 2, text: "一段。" }], table: null, header: null, exact: true });
});

test("PDF 文档：逐块给并带页与块号，文字是投影里那一块的原样文字；源文字换过时 exact 为假", () => {
  const projection = ["<!--", "由 规范.pdf 生成。页数：1。", "-->", "", "[p1-1] 第一条 读者凭借书证借书。", "", "[p1-2] 每次最多借五本  借期三十天", ""].join("\n");
  const [chunk] = chunkDocument("规范.pdf", projection, SEGMENT_DEFAULTS);
  assert.deepEqual(passageOf("规范.pdf", chunk, projection), {
    body: null, units: [{ page: 1, block: 1, text: "第一条 读者凭借书证借书。" }, { page: 1, block: 2, text: "每次最多借五本  借期三十天" }],
    paragraphs: null, table: null, header: null, exact: true,
  });
  assert.equal(passageOf("规范.pdf", chunk, projection.replace("借书证", "读者证之类的证件")).exact, false);
});
