// PDF 材料的分段清单（lib/pdf_segments.ts）：从投影全文与书签目录算出各段的起止页、起止行与块数。

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PDF_SEGMENTS_VERSION, buildPdfSegments, pdfProjectionPages, pdfProjectionUnits, writePdfSegments } from "../src/lib/pdf_segments.ts";
import { SEGMENT_DEFAULTS, paramsDigest } from "../src/lib/segments.ts";

const HEADER = (pages: number, units: number) => `<!--\n由 x.pdf 生成，供助手阅读。页数：${pages}。块总数：${units}。\n出处写 inputs/x.pdf#p页-块（例如 inputs/x.pdf#p3-7）。\n-->\n`;

/** 造一份投影：perPage[k] 是第 k+1 页的块数；0 表示这一页没有文字；每页前面带一行页眉。 */
function projection(perPage: number[]): string {
  const body: string[] = [];
  perPage.forEach((count, k) => {
    body.push("> （页眉页脚）办法（样本）");
    if (count === 0) body.push(`[p${k + 1}-0] （这一页没有文字，可能是扫描件）`);
    for (let b = 1; b <= count; b++) body.push(`[p${k + 1}-${b}] 第${k + 1}页第${b}块的字`);
  });
  return HEADER(perPage.length, perPage.reduce((a, b) => a + b, 0)) + body.map((line) => `\n${line}\n`).join("");
}

const params = (over: Partial<typeof SEGMENT_DEFAULTS> = {}) => ({ ...SEGMENT_DEFAULTS, ...over });

test("读投影：只认行首带定位符的行；说明注释、页眉页脚行不算；块号 0 的行认得出来", () => {
  const text = projection([2, 0, 1]);
  assert.equal(pdfProjectionPages(text), 3);
  const units = pdfProjectionUnits(text);
  assert.deepEqual(units.map((u) => `${u.page}-${u.block}`), ["1-1", "1-2", "2-0", "3-1"]);
  assert.equal(units[0].text, "第1页第1块的字");
  const lines = text.split("\n");
  for (const u of units) assert.ok(lines[u.line - 1].startsWith(`[p${u.page}-${u.block}]`), `第 ${u.line} 行应当是 p${u.page}-${u.block}`);
});

test("没有书签目录：整份一段，覆盖第 1 页到最后一页；块号 0 的行不算块", () => {
  const text = projection([2, 0, 1]);
  const list = buildPdfSegments(text, params(), "inputs/x.pdf", "inputs/x.pdf.md", []);
  assert.equal(list.version, PDF_SEGMENTS_VERSION);
  assert.equal(list.params_digest, paramsDigest(params()));
  assert.deepEqual([list.source, list.projection, list.pages, list.units], ["inputs/x.pdf", "inputs/x.pdf.md", 3, 3]);
  assert.equal(list.blocks.length, 1);
  const lines = text.split("\n");
  const [only] = list.blocks;
  assert.deepEqual({ ...only, first_line: 0, last_line: 0 }, { index: 1, heading: null, first_page: 1, last_page: 3, first_line: 0, last_line: 0, units: 3, chars: 3 * [..."第1页第1块的字"].length });
  // 从正文的第一个非空行（第 1 页的页眉）到最后一个非空行
  assert.equal(lines[only.first_line - 1], "> （页眉页脚）办法（样本）");
  assert.equal(lines[only.last_line - 1], "[p3-1] 第3页第1块的字");
});

test("有书签目录：级别不超过 heading_depth 的书签所指的页开始一段，同一页的几个标题用「；」连起来", () => {
  const text = projection([3, 3, 3, 3, 3]);
  const headings = [
    { page: 2, level: 1, title: "第一章  总则" }, { page: 2, level: 2, title: "第一节 范围" }, { page: 3, level: 4, title: "太深的一级，不分段" },
    { page: 4, level: 1, title: "第二章 借阅" }, { page: 9, level: 1, title: "指到文件之外的页，不算" },
  ];
  const list = buildPdfSegments(text, params(), "inputs/x.pdf", "inputs/x.pdf.md", headings);
  assert.deepEqual(list.blocks.map((b) => [b.heading, b.first_page, b.last_page, b.units]), [
    [null, 1, 1, 3], ["第一章 总则；第一节 范围", 2, 3, 6], ["第二章 借阅", 4, 5, 6],
  ]);
  // 段与段按行首尾相接：每段从它第一页的第一块那一行开始
  const lines = text.split("\n");
  assert.ok(lines[list.blocks[1].first_line - 1].startsWith("[p2-1]"));
  assert.ok(lines[list.blocks[2].first_line - 1].startsWith("[p4-1]"));
  assert.ok(list.blocks[0].last_line < list.blocks[1].first_line && list.blocks[1].last_line < list.blocks[2].first_line);
  assert.equal(lines[list.blocks[2].last_line - 1], "[p5-3] 第5页第3块的字");
  // heading_depth 是 1 时第二级的书签不参加
  const shallow = buildPdfSegments(text, params({ heading_depth: 1 }), "inputs/x.pdf", "inputs/x.pdf.md", headings);
  assert.deepEqual(shallow.blocks.map((b) => b.heading), [null, "第一章 总则", "第二章 借阅"]);
});

test("块数太少的段并入下一段，最后一段不够时并入前一段", () => {
  const text = projection([1, 4, 4, 1]);
  const headings = [{ page: 1, level: 1, title: "甲" }, { page: 2, level: 1, title: "乙" }, { page: 3, level: 1, title: "丙" }, { page: 4, level: 1, title: "丁" }];
  const list = buildPdfSegments(text, params({ min_paragraphs: 3 }), "inputs/x.pdf", "inputs/x.pdf.md", headings);
  assert.deepEqual(list.blocks.map((b) => [b.heading, b.first_page, b.last_page, b.units]), [["甲；乙", 1, 2, 5], ["丙；丁", 3, 4, 5]]);
});

test("块数太多的段在页与页之间切开，标题相同；一页之内不切", () => {
  const text = projection([4, 4, 4, 4, 4]);
  const list = buildPdfSegments(text, params({ max_paragraphs: 8 }), "inputs/x.pdf", "inputs/x.pdf.md", [{ page: 1, level: 1, title: "全文" }]);
  // 20 块、每段最多 8 块：分 3 段，每攒够 7 块就在这一页结束处切开
  assert.deepEqual(list.blocks.map((b) => [b.heading, b.first_page, b.last_page, b.units]), [["全文", 1, 2, 8], ["全文", 3, 4, 8], ["全文", 5, 5, 4]]);
  assert.equal(list.blocks.reduce((sum, b) => sum + b.units, 0), list.units);
  // 单独一页的块数就超过上限：这一页自成一段
  const big = buildPdfSegments(projection([2, 12, 2]), params({ max_paragraphs: 5, min_paragraphs: 1 }), "inputs/x.pdf", "inputs/x.pdf.md", []);
  assert.deepEqual(big.blocks.map((b) => [b.first_page, b.last_page, b.units]), [[1, 2, 14], [3, 3, 2]]);
});

test("没有文字的页也在段里：全是这种页的材料是一段，块数为 0", () => {
  const list = buildPdfSegments(projection([0, 0]), params(), "inputs/scan.pdf", "inputs/scan.pdf.md", []);
  assert.deepEqual(list.blocks.map((b) => [b.first_page, b.last_page, b.units, b.chars]), [[1, 2, 0, 0]]);
  assert.deepEqual([list.pages, list.units], [2, 0]);
});

test("写成文件：两格缩进的 JSON，末尾换行，读回来相同", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskwright-pdf-segments-"));
  try {
    const list = buildPdfSegments(projection([3, 3]), params(), "inputs/x.pdf", "inputs/x.pdf.md", []);
    const file = join(dir, "x.pdf.segments.json");
    writePdfSegments(file, list);
    const text = readFileSync(file, "utf-8");
    assert.ok(text.endsWith("}\n") && text.includes('\n  "pages": 2,'));
    assert.deepEqual(JSON.parse(text), list);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
