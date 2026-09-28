// 位置表（lib/docx_locations.ts 的格式与章节查法，lib/docx_location_input.ts 写文件内容）：标题段与标题文字直接取投影算出的，
// 与投影的标题行逐段相同（编号任何格式都写，表格里的段落不算标题）；分页标记的个数照排版库的解析方式数。不经过排版库。
// 分页标记个数与页面的比较在 web/src/test/docxLocations.test.tsx。

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { LOCATIONS_SUFFIX, chapterOf, isLocationTable } from "../src/lib/docx_locations.ts";
import { layoutParagraphs, locationTable } from "../src/lib/docx_location_input.ts";
import { docxProjection } from "../src/lib/docx_markdown.ts";
import { prepareReviews } from "../src/lib/review.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { getTaskStatus } from "../src/lib/task_query.ts";
import { listMaterials, taskStatusMessage } from "../src/lib/task_status.ts";
import { headingFixtures } from "./heading_fixtures.ts";
import { DEFINITION_PATH, SAMPLE_DOCX, SOURCE, callIn, demoDefinition, makeDocx, makeWorkspace, putSampleDocx } from "./helpers.ts";
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
  assert.deepEqual([t.version, t.rules_version, t.source, t.paragraphs, t.page_marks, t.application], [1, 2, "inputs/x.docx", 114, 4, "Microsoft Macintosh Word"]);
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

/** 投影里的标题行：段落号 → 去掉井号与段落号之后的文字。 */
function projectedHeadings(data: Buffer): Record<number, string> {
  const md = docxProjection(data, "inputs/x.docx").markdown;
  return Object.fromEntries([...md.matchAll(/^#{1,6} (.*)$/gm)].flatMap((m) => {
    const a = /\[p(\d+)\]/.exec(m[1]);
    return a ? [[Number(a[1]), m[1].replace(/\[p\d+\]\s?/, "").trim()]] : [];
  }));
}

test("位置表的标题段与标题文字，与投影的标题行逐段相同（全部样例）", () => {
  const all: [string, Buffer][] = [["requirements-styled.docx", SAMPLE], ...Object.entries(headingFixtures()), ...Object.entries(locationFixtures())];
  for (const [name, data] of all) {
    const table = Object.fromEntries(locationTable(data, "inputs/x.docx").headings.map((h) => [h.paragraph, h.title]));
    assert.deepEqual(table, projectedHeadings(data), name);
  }
});

test("编号：任何格式都写进标题文字，数法与投影相同（起始值覆盖、法律式编号、样式里没写级别按第 0 级）；项目符号不写", () => {
  assert.deepEqual(tableOf("loc-style-no-level.docx").headings, [{ paragraph: 1, level: 2, title: "1 样式里没写级别的标题" }]);
  const t = tableOf("loc-numbering.docx");
  assert.equal(t.page_marks, 0);
  assert.deepEqual(t.headings.map((h) => [h.paragraph, h.level, h.title]), [
    [1, 1, "1 总则"],
    [3, 2, "1.1 适用范围"],
    [5, 1, "第一章 中文编号的一章"],
    [6, 2, "一.1 章下的一节"],
    [8, 1, "I. 罗马数字的一章"],
    [9, 2, "带项目符号的标题"],
    [10, 1, "2 编号来自样式的一章"],
    [11, 2, "2.1 编号来自样式的一节"],
    [13, 2, "3 起始值是三的标题"],
    [14, 2, "编号写成零的标题"],
    [15, 1, "7 起始值被覆盖成七的一章"],
    [16, 1, "I 罗马数字的一章，下一级是法律式编号"],
    [17, 2, "1.1 法律式编号的一节"],
    [18, 1, "带超链接的标题"],
    [19, 1, "带域结果的标题，第3页"],
    [20, 1, "带补充平面字符𠀋的标题"],
  ]);
});

test("排版库不画的段落（w:customXml 里的、单元格里内容控件中的）：投影照写它们，标题照记，章节推导照常用它", () => {
  const data = readFileSync(join(FIXTURES, "loc-hidden.docx"));
  assert.deepEqual(layoutParagraphs(data).paragraphs.filter((p) => !p.drawn).map((p) => p.n), [3, 4, 7]);
  const t = tableOf("loc-hidden.docx");
  assert.deepEqual(t.headings.map((h) => [h.paragraph, h.title]), [[1, "1 总则"], [3, "2 包在自定义标记里的一章"], [9, "3 正文里内容控件中的一章"]]);
  assert.equal(chapterOf(t, 5), "2 包在自定义标记里的一章");
});

test("表格里用了标题样式的段落不算标题，与投影、分段清单一致", () => {
  const cell = (s: string) => `<w:tc><w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>${s}</w:t></w:r></w:p></w:tc>`;
  const body = '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>正文里的标题</w:t></w:r></w:p>'
    + `<w:tbl><w:tr>${cell("表格里的标题")}</w:tr></w:tbl><w:p><w:r><w:t>表格之后的正文。</w:t></w:r></w:p>`;
  const t = locationTable(makeDocx(body), "inputs/t.docx");
  assert.deepEqual(t.headings, [{ paragraph: 1, level: 1, title: "正文里的标题" }]);
  assert.equal(chapterOf(t, 3), "正文里的标题");
});

test("分页标记的个数：超链接、插入、删除里的也数，排版库不画的段落里的不数", () => {
  const mark = "<w:lastRenderedPageBreak/>";
  const body = `<w:p><w:r>${mark}<w:t>一</w:t></w:r><w:hyperlink w:anchor="a"><w:r>${mark}</w:r></w:hyperlink></w:p>`
    + `<w:p><w:del w:id="1" w:author="x"><w:r>${mark}</w:r></w:del></w:p>`
    + `<w:customXml w:element="x"><w:p><w:r>${mark}<w:t>不画</w:t></w:r></w:p></w:customXml>`;
  assert.equal(locationTable(makeDocx(body), "inputs/m.docx").page_marks, 3);
});

test("同一份文件算两次，位置表逐字相同；读不到软件名时为空文字；不记正文的文字", () => {
  const a = JSON.stringify(locationTable(SAMPLE, "inputs/x.docx"));
  assert.equal(JSON.stringify(locationTable(SAMPLE, "inputs/x.docx")), a);
  assert.ok(!a.includes("逾期的每本每天"));
  assert.equal(locationTable(makeDocx("<w:p><w:r><w:t>一段</w:t></w:r></w:p>"), "inputs/y.docx").application, "");
});

test("位置表的判断：以 .docx.locations.json 结尾（不分大小写）", () => {
  assert.equal(isLocationTable("x.docx" + LOCATIONS_SUFFIX), true);
  assert.equal(isLocationTable("X.DOCX.LOCATIONS.JSON"), true);
  assert.equal(isLocationTable("x.locations.json"), false);
  assert.equal(isLocationTable("x.docx.segments.json"), false);
});

test("助手一侧不列位置表：任务现状、查询任务状态、评审取材料里都没有它；分段清单照旧列出", () => {
  const definition = demoDefinition() as any;
  definition.交付物.条目集合[0].评审规矩 = { 规则文件: "docs/review-rules/demo.json" };
  const dir = makeWorkspace(definition);
  mkdirSync(join(dir, "docs/review-rules"), { recursive: true });
  writeFileSync(join(dir, "docs/review-rules/demo.json"), JSON.stringify([{ 编号: "D-R1", 级别: "必选", 条文: "步骤写明谁做了什么。", 反例: "校验。", 正例: "系统校验。" }]), "utf-8");
  putSampleDocx(dir);
  writeFileSync(join(dir, SAMPLE_DOCX + LOCATIONS_SUFFIX), JSON.stringify(locationTable(SAMPLE, SAMPLE_DOCX)), "utf-8");
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["用户输入口令"] }, sources: [SOURCE] }] });
  const fresh = { hasUserMessage: false, hasStatusMessage: false, lastMessageAt: null };
  taskStatusMessage(dir, fresh, "s"); // 第一次读时补写分段清单
  const listed = listMaterials(dir, "inputs/").files.map((f) => f.path);
  assert.ok(listed.includes(SAMPLE_DOCX + ".segments.json") && !listed.some((p) => p.endsWith(LOCATIONS_SUFFIX)), listed.join(" "));
  const status = taskStatusMessage(dir, fresh, "s")!.text;
  assert.match(status, /requirements-styled\.docx\.segments\.json/);
  assert.doesNotMatch(status, /locations/);
  const later = taskStatusMessage(dir, { hasUserMessage: true, hasStatusMessage: true, lastMessageAt: 0 }, "s")?.text ?? "";
  assert.doesNotMatch(later, /locations/, "「新放进来的」那一句里也没有");
  assert.doesNotMatch(getTaskStatus(dir).text, /locations/);
  assert.doesNotMatch(prepareReviews(dir, null).items[0].user, /locations/);
});
