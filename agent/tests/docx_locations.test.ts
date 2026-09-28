// 位置规则（lib/docx_locations.ts）的章节部分与从 Word 文件整理输入（lib/docx_location_input.ts）：不经过排版库，直接断言位置表内容。
// 标题级别用 docx_heading.ts 的规则，标题文字只带十进制编号，编号的数法与投影同一份（docx_numbering.ts）。
// 与页面现有推导逐段比较的测试在 web/src/test/docxLocations.test.tsx。页码与页内位置暂不测（位置表暂不写它们）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chapterOf, headingsOf } from "../src/lib/docx_locations.ts";
import { locationInput, locationTable } from "../src/lib/docx_location_input.ts";
import { docxProjection } from "../src/lib/docx_markdown.ts";
import { headingFixtures } from "./heading_fixtures.ts";
import { makeDocx } from "./helpers.ts";
import { locationFixtures, locationTableFixtures } from "./location_fixtures.ts";

const ROOT = join(import.meta.dirname, "../..");
const FIXTURES = join(ROOT, "web/src/test/fixtures");
const SAMPLE = readFileSync(join(ROOT, "examples/library-lending/requirements-styled.docx"));
const tableOf = (name: string) => locationTable(readFileSync(join(FIXTURES, name)), `inputs/${name}`);

test("存着的样例与 location_fixtures.ts 现造的逐字节相同，存着的位置表与现算的逐字相同（改了定义或规则要运行 fixtures/build_location_docx.mts）", () => {
  for (const [name, bytes] of Object.entries(locationFixtures())) assert.ok(readFileSync(join(FIXTURES, name)).equals(bytes), name);
  for (const [name, text] of Object.entries(locationTableFixtures(readFileSync, locationTable))) assert.equal(readFileSync(join(FIXTURES, name), "utf-8"), text, name);
});

test("主样例：文件头与 15 个标题段，章节取之前最近的标题", () => {
  const t = locationTable(SAMPLE, "inputs/x.docx");
  assert.deepEqual([t.version, t.rules_version, t.source, t.paragraphs, t.page_marks, t.application], [1, 1, "inputs/x.docx", 114, 4, "Microsoft Macintosh Word"]);
  assert.equal(t.headings.length, 15);
  assert.deepEqual(t.headings.slice(0, 3), [{ paragraph: 6, level: 1, title: "1 概述" }, { paragraph: 10, level: 2, title: "1.1 范围" }, { paragraph: 12, level: 2, title: "1.2 术语" }]);
  assert.deepEqual(t.headings.find((h) => h.paragraph === 75), { paragraph: 75, level: 3, title: "3.1.1 逾期罚款" });
  assert.equal(chapterOf(t, 5), null, "第一个标题之前没有章节");
  assert.equal(chapterOf(t, 6), "1 概述", "标题段自己的章节是它自己");
  assert.equal(chapterOf(t, 11), "1.1 范围");
  assert.equal(chapterOf(t, 76), "3.1.1 逾期罚款");
});

test("三份标题样例：级别与投影里 # 的级数相同（与 docx_heading.test.ts 同一组期望值）", () => {
  const levels = (name: string) => Object.fromEntries(locationTable(headingFixtures()[name], `inputs/${name}`).headings.map((h) => [h.paragraph, h.level]));
  assert.deepEqual(levels("headings-by-name.docx"), { 2: 1, 5: 2, 7: 3, 9: 1 });
  assert.deepEqual(levels("headings-inherited.docx"), { 1: 1, 3: 2, 5: 2, 7: 3 });
  assert.deepEqual(levels("headings-body-level.docx"), { 1: 1, 7: 1 });
});

test("编号：只有引用到的各级都写十进制时才带进标题文字；数法与投影相同（起始值覆盖、法律式编号、样式里没写级别按第 0 级）", () => {
  assert.deepEqual(tableOf("loc-style-no-level.docx").headings, [{ paragraph: 1, level: 2, title: "1 样式里没写级别的标题" }]);
  const t = tableOf("loc-numbering.docx");
  assert.equal(t.page_marks, 0);
  assert.deepEqual(t.headings.map((h) => [h.paragraph, h.level, h.title]), [
    [1, 1, "1 总则"],
    [3, 2, "1.1 适用范围"],
    [5, 1, "中文编号的一章"],
    [6, 2, "章下的一节"],
    [8, 1, "罗马数字的一章"],
    [9, 2, "带项目符号的标题"],
    [10, 1, "2 编号来自样式的一章"],
    [11, 2, "2.1 编号来自样式的一节"],
    [13, 2, "3 起始值是三的标题"],
    [14, 2, "编号写成零的标题"],
    [15, 1, "7 起始值被覆盖成七的一章"],
    [16, 1, "罗马数字的一章，下一级是法律式编号"],
    [17, 2, "1.1 法律式编号的一节"],
    [18, 1, "带超链接的标题"],
    [19, 1, "带域结果的标题，第3页"],
    [20, 1, "带补充平面字符𠀋的标题"],
  ]);
});

test("已知的不同：投影把非十进制编号也写在标题前面，位置表的标题文字不带（十进制的两边相同）", () => {
  const md = docxProjection(readFileSync(join(FIXTURES, "loc-numbering.docx")), "inputs/loc-numbering.docx").markdown;
  const projected = Object.fromEntries([...md.matchAll(/^#+ (?:(\S+) )?\[p(\d+)\]/gm)].map((m) => [Number(m[2]), m[1] ?? ""]));
  const table = Object.fromEntries(tableOf("loc-numbering.docx").headings.map((h) => [h.paragraph, h.title]));
  assert.deepEqual({ 5: projected[5], 6: projected[6], 8: projected[8], 16: projected[16] }, { 5: "第一章", 6: "一.1", 8: "I.", 16: "I" }, "投影照写");
  for (const n of [5, 6, 8, 16]) assert.ok(!table[n].startsWith(projected[n]), `位置表第 ${n} 段不带 ${projected[n]}`);
  for (const n of [1, 3, 10, 11, 13, 15, 17]) assert.ok(table[n].startsWith(`${projected[n]} `), `十进制的第 ${n} 段两边编号相同`);
});

test("排版库不画的段落（w:customXml 里的、单元格里内容控件中的）：标题照记，章节推导照常用它", () => {
  const { input } = locationInput(readFileSync(join(FIXTURES, "loc-hidden.docx")));
  assert.deepEqual(input.paragraphs.filter((p) => !p.drawn).map((p) => p.n), [3, 4, 7]);
  assert.deepEqual(input.paragraphs.filter((p) => p.inTable).map((p) => p.n), [6, 7, 8]);
  const t = tableOf("loc-hidden.docx");
  assert.deepEqual(t.headings.map((h) => [h.paragraph, h.title]), [[1, "1 总则"], [3, "2 包在自定义标记里的一章"], [9, "3 正文里内容控件中的一章"]]);
  assert.equal(chapterOf(t, 5), "2 包在自定义标记里的一章");
});

test("段落子节点的整理：超链接、插入里的字画出来也进标题文字；删除里的不画；域代码所在的文字块不画但进标题文字；符号字画出来不进标题文字", () => {
  const body = '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr>'
    + '<w:r><w:t>甲</w:t></w:r>'
    + '<w:hyperlink w:anchor="a"><w:r><w:t>乙</w:t></w:r></w:hyperlink>'
    + '<w:ins w:id="1" w:author="x"><w:r><w:t>丙</w:t></w:r></w:ins>'
    + '<w:del w:id="2" w:author="x"><w:r><w:delText>丁</w:delText></w:r></w:del>'
    + '<w:r><w:fldChar w:fldCharType="begin"/><w:t>戊</w:t></w:r>'
    + '<w:r><w:sym w:font="Symbol" w:char="0041"/><w:tab/><w:t xml:space="preserve"> 己 </w:t></w:r>'
    + "</w:p>";
  const { input } = locationInput(makeDocx(body));
  const [p] = headingsOf(input);
  assert.equal(p.title, "甲乙丙戊 己", "标题文字：甲乙丙、域代码块里的戊、己；删除的丁与符号字不算");
  assert.equal(p.chars, 5, "画出来的非空白字符：甲乙丙、符号字 A、己");
  assert.deepEqual(input.paragraphs[0].children.map((c) => c.run), [true, false, false, false, true, true]);
});

test("补充平面的字按 UTF-16 码元计数（与页面相同），标题文字原样保留", () => {
  const { input } = locationInput(makeDocx("<w:p><w:r><w:t>𠀋一</w:t></w:r></w:p>"));
  const [p] = headingsOf(input);
  assert.equal(p.chars, 3);
});

test("同一份文件算两次，位置表逐字相同；读不到软件名时为空文字；不记正文的文字", () => {
  const a = JSON.stringify(locationTable(SAMPLE, "inputs/x.docx"));
  assert.equal(JSON.stringify(locationTable(SAMPLE, "inputs/x.docx")), a);
  assert.ok(!a.includes("逾期的每本每天"));
  assert.equal(locationTable(makeDocx("<w:p><w:r><w:t>一段</w:t></w:r></w:p>"), "inputs/y.docx").application, "");
});
