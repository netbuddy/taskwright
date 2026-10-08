// PDF 材料的定位符与位置表的格式（lib/pdf_locations.ts）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  PDF_ANCHOR, PDF_LOCATIONS_FORMAT_VERSION, PDF_LOCATION_RULES_VERSION, type PdfLocationFile, isPdfLocationTable, parsePdfLocator, pdfAnchor,
  pdfBlockBox, pdfChapterOf, pdfLocationFile, pdfLocationsJson,
} from "../src/lib/pdf_locations.ts";

const table: PdfLocationFile = pdfLocationFile({
  source: "inputs/办法.pdf", engine: "pdfjs-dist 6.4.299", producer: "Writer",
  pages: [
    { page: 1, width: 595.3, height: 841.9, rotate: 0, no_text: false, blocks: [{ block: 1, bbox: [72, 700.5, 504, 712] }, { block: 2, bbox: [72, 640, 504.2, 690.9] }] },
    { page: 2, width: 595.3, height: 841.9, rotate: 0, no_text: true, blocks: [] },
    { page: 3, width: 841.9, height: 595.3, rotate: 90, no_text: false, blocks: [{ block: 1, bbox: [-3.5, 10, 20, 30] }] },
  ],
  headings: [{ page: 1, level: 1, title: "第一章 总则" }, { page: 3, level: 1, title: "第二章 \"借阅\"" }, { page: 3, level: 2, title: "第一节 期限" }],
});

test("定位符：出处拆成路径、页与块；没写页与块的、不是 PDF 的各有各的结果", () => {
  assert.deepEqual(parsePdfLocator("inputs/办法.pdf#p3-7"), { path: "inputs/办法.pdf", page: 3, block: 7 });
  assert.deepEqual(parsePdfLocator("inputs/Scan.PDF#p12-0"), { path: "inputs/Scan.PDF", page: 12, block: 0 });
  assert.deepEqual(parsePdfLocator("inputs/办法.pdf"), { path: "inputs/办法.pdf", page: null, block: null });
  // Word 材料的出处、只写了页没写块的，都不是 PDF 的定位符
  assert.equal(parsePdfLocator("inputs/办法.docx#p3"), null);
  assert.equal(parsePdfLocator("inputs/办法.pdf#p3"), null);
  assert.equal(parsePdfLocator("inputs/办法.pdf#p3-"), null);
});

test("定位符：投影一行开头的写法，写出来的能认回去；Word 投影的段落号不认", () => {
  assert.equal(pdfAnchor(3, 7), "[p3-7]");
  const m = PDF_ANCHOR.exec("[p3-7] 读者凭借书证借书。");
  assert.deepEqual(m && [m[1], m[2], "[p3-7] 读者凭借书证借书。".slice(m[0].length)], ["3", "7", "读者凭借书证借书。"]);
  assert.equal(PDF_ANCHOR.exec("[p12] Word 投影的一段"), null);
  assert.equal(PDF_ANCHOR.exec("> （页眉页脚）[p3-7] 不在行首的不算"), null);
});

test("位置表：文件头带格式版本与规则版本；文件名的判断不分大小写", () => {
  assert.equal(table.version, PDF_LOCATIONS_FORMAT_VERSION);
  assert.equal(table.rules_version, PDF_LOCATION_RULES_VERSION);
  assert.ok(isPdfLocationTable("办法.pdf.locations.json"));
  assert.ok(isPdfLocationTable("SCAN.PDF.Locations.JSON"));
  assert.ok(!isPdfLocationTable("办法.docx.locations.json"));
  assert.ok(!isPdfLocationTable("办法.pdf.segments.json"));
});

test("位置表：查一块的矩形；没有这一页或这一块时为 null", () => {
  assert.deepEqual(pdfBlockBox(table, 1, 2), [72, 640, 504.2, 690.9]);
  assert.equal(pdfBlockBox(table, 1, 3), null);
  assert.equal(pdfBlockBox(table, 2, 1), null);
  assert.equal(pdfBlockBox(table, 9, 1), null);
});

test("位置表：一页的章节是书签目录里指向它（含）之前最近的一项，同一页有几项时取最后一项", () => {
  assert.equal(pdfChapterOf(table, 1), "第一章 总则");
  assert.equal(pdfChapterOf(table, 2), "第一章 总则");
  assert.equal(pdfChapterOf(table, 3), "第一节 期限");
  assert.equal(pdfChapterOf({ headings: [{ page: 2, level: 1, title: "第一章" }] }, 1), null);
  assert.equal(pdfChapterOf({ headings: [] }, 5), null);
  assert.equal(pdfChapterOf({ headings: [{ page: 1, level: 1, title: "" }] }, 1), null);
});

test("位置表写成文件：是合法的 JSON，读回来与原来相同；每一块、书签目录的每一项各占一行；末尾换行", () => {
  const text = pdfLocationsJson(table);
  assert.deepEqual(JSON.parse(text), table);
  assert.ok(text.endsWith("}\n"));
  const lines = text.split("\n");
  assert.ok(lines.includes('        { "block": 2, "bbox": [72, 640, 504.2, 690.9] }'), text);
  assert.ok(lines.includes('        { "block": 1, "bbox": [-3.5, 10, 20, 30] }'), text);
  // 标题里有引号的也写在一行里，读回来不变
  assert.ok(lines.includes('    { "page": 3, "level": 1, "title": "第二章 \\"借阅\\"" },'), text);
  assert.equal(lines.filter((line) => line.includes('"bbox"')).length, 3);
});

test("本文件不导入任何模块（页面也要导入它）", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "lib", "pdf_locations.ts"), "utf-8");
  assert.doesNotMatch(source, /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']|(?:^|\n)\s*import\s*["']|\bimport\(/);
});
