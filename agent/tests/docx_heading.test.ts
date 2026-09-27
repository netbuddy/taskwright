// 标题级别识别（lib/docx_heading.ts）：三步规则逐条一例；三份小 Word 文件（heading_fixtures.ts）的投影里 # 的级数与
// 分段清单的切分点；一级标题只靠样式名时，引用它下面段落的条目算在它这一块。前端推导章节用的是同一个函数，
// web/src/test/docx_heading.test.tsx 用同样三份文件、同样的期望值核对界面推导的章节。

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { type HeadingStyle, headingLevel } from "../src/lib/docx_heading.ts";
import { docxProjection } from "../src/lib/docx_markdown.ts";
import { projectionParagraphs } from "../src/lib/docx_source.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { buildSegments } from "../src/lib/segments.ts";
import { getTaskStatus } from "../src/lib/task_query.ts";
import { headingFixtures } from "./heading_fixtures.ts";
import { DEFINITION_PATH, callIn, makeWorkspace } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "../../web/src/test/fixtures");
const lookup = (table: Record<string, HeadingStyle>) => (id: string) => table[id];

/** 投影里的标题：段落号 → 级别（# 的个数）。 */
function headingsOf(md: string): Record<number, number> {
  const out: Record<number, number> = {};
  for (const m of md.matchAll(/^(#{1,6}) (?:\S+ )?\[p(\d+)\]/gm)) out[Number(m[2])] = m[1].length;
  return out;
}

/** 每个标题都开一块（不合并小块），得出切分点：[起, 止, 标题]。 */
function cuts(name: string): [number, number, string | null][] {
  const md = docxProjection(headingFixtures()[name], `inputs/${name}`).markdown;
  const list = buildSegments(md, { heading_depth: 3, max_paragraphs: 300, min_paragraphs: 1 }, `inputs/${name}`, `inputs/${name}.md`);
  return list.blocks.map((b) => [b.first_paragraph, b.last_paragraph, b.heading]);
}

const projectionOf = (name: string) => docxProjection(headingFixtures()[name], `inputs/${name}`).markdown;

test("存着的三份夹具与 heading_fixtures.ts 现造的逐字节相同（改了定义要运行 fixtures/build_heading_docx.mts），合计不超过 200 KB", () => {
  let total = 0;
  for (const [name, bytes] of Object.entries(headingFixtures())) {
    const saved = readFileSync(join(FIXTURES, name));
    assert.deepEqual(saved, bytes, name);
    total += saved.length;
  }
  assert.ok(total <= 200 * 1024);
});

test("第 1 步：段落自身的大纲级别说了算，写成 9 或别的值就不是标题，不再看样式", () => {
  const styles = lookup({ Heading1: { name: "heading 1", outline: 0 } });
  assert.equal(headingLevel("2", "Heading1", styles), 2);
  assert.equal(headingLevel(0, undefined, styles), 0);
  assert.equal(headingLevel("9", "Heading1", styles), null);
  assert.equal(headingLevel("12", "Heading1", styles), null);
});

test("第 2 步：样式的大纲级别，样式自己没写时沿继承关系往上找；上级写了 9 也就不是标题；大纲级别先于样式名", () => {
  const styles = lookup({
    Base: { name: "章基础", outline: 1 },
    Mid: { name: "章中间", basedOn: "Base" },
    Chapter: { name: "章", basedOn: "Mid" },
    Named: { name: "heading 3", basedOn: "Base" },
    Body: { name: "正文基础", outline: 9 },
    NamedBody: { name: "heading 2", basedOn: "Body" },
  });
  assert.equal(headingLevel(undefined, "Chapter", styles), 1);
  assert.equal(headingLevel(undefined, "Named", styles), 1);
  assert.equal(headingLevel(undefined, "NamedBody", styles), null);
});

test("第 3 步：样式名「heading N」「标题 N」（不分大小写、可以没有空格，N 为 1 到 9），没有名字时用样式编号，沿继承关系同样适用", () => {
  const named = (name: string) => headingLevel(undefined, "S", lookup({ S: { name } }));
  assert.deepEqual(["heading 1", "Heading1", "HEADING 9", "标题 2", "标题3"].map(named), [0, 0, 8, 1, 2]);
  assert.deepEqual(["Heading", "Table Heading", "heading 10", "heading 0", "标题", "Title", "heading 1 Char"].map(named), [null, null, null, null, null, null, null]);
  // 没有名字：用样式编号；样式表里查不到这个样式：也用编号
  assert.equal(headingLevel(undefined, "Heading2", lookup({ Heading2: {} })), 1);
  assert.equal(headingLevel(undefined, "heading3", lookup({})), 2);
  // 有名字而名字不符时不再看编号
  assert.equal(headingLevel(undefined, "Heading1", lookup({ Heading1: { name: "封面大字" } })), null);
  // 自己的名字不符，沿继承关系找到上级的名字
  assert.equal(headingLevel(undefined, "Mine", lookup({ Mine: { name: "我的一级", basedOn: "Heading1" }, Heading1: { name: "heading 1" } })), 0);
  assert.equal(headingLevel(undefined, "Mine", lookup({ Mine: { name: "我的二级", basedOn: "Heading2" } })), 1);
  // 没有样式、样式继承绕成环：不是标题，也不会一直找下去
  assert.equal(headingLevel(undefined, undefined, lookup({})), null);
  assert.equal(headingLevel(undefined, "A", lookup({ A: { name: "甲", basedOn: "B" }, B: { name: "乙", basedOn: "A" } })), null);
});

test("只靠样式名的标题：投影写 #、##、###，名为 Heading、Table Heading、Title 的不是标题；分段在每个标题处切开", () => {
  const md = projectionOf("headings-by-name.docx");
  assert.deepEqual(headingsOf(md), { 2: 1, 5: 2, 7: 3, 9: 1 });
  assert.match(md, /\n# \[p2\] 1 概述\n/);
  assert.match(md, /\n\[p1\] 园区植物养护说明\n/);
  assert.match(md, /\n\[p10\] 按季节安排养护内容\n/);
  assert.match(md, /\n\| \[p12\] 工作 \| \[p13\] 频次 \|\n/);
  assert.deepEqual(cuts("headings-by-name.docx"), [[1, 1, null], [2, 4, "1 概述"], [5, 6, "1.1 适用范围"], [7, 8, "1.1.1 例外"], [9, 16, "2 日常养护"]]);
});

test("大纲级别写在被继承的上级样式里：隔一层、隔两层都认；段落自身的大纲级别先于样式；分段在每个标题处切开", () => {
  const md = projectionOf("headings-inherited.docx");
  assert.deepEqual(headingsOf(md), { 1: 1, 3: 2, 5: 2, 7: 3 });
  assert.deepEqual(cuts("headings-inherited.docx"), [[1, 2, "1 总体安排"], [3, 4, "1.1 春季"], [5, 6, "1.2 夏季"], [7, 9, "1.2.1 防暑"]]);
});

test("大纲级别写成 9：用了标题样式也不是标题，投影不写 #，分段不在那里切开", () => {
  const md = projectionOf("headings-body-level.docx");
  assert.deepEqual(headingsOf(md), { 1: 1, 7: 1 });
  assert.match(md, /\n\[p3\] 这一段取消了标题\n/);
  assert.match(md, /\n\[p5\] 样式写成正文级别的段落\n/);
  assert.deepEqual(cuts("headings-body-level.docx"), [[1, 6, "1 总则"], [7, 8, "2 附则"]]);
});

test("引用情况按块归属：一级标题只靠样式名时，引用它下面段落的条目算在它这一块，不算进前一块", () => {
  const dir = makeWorkspace(undefined, { material: false });
  mkdirSync(join(dir, "inputs"));
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const rel = "inputs/headings-by-name.docx";
  const out = docxProjection(headingFixtures()["headings-by-name.docx"], rel);
  writeFileSync(join(dir, rel), headingFixtures()["headings-by-name.docx"]);
  writeFileSync(join(dir, rel + ".md"), out.markdown, "utf-8");
  const paragraphs = projectionParagraphs(out.markdown);
  const at = (n: number) => ({ kind: "文档原文", locator: `${rel}#p${n}`, excerpt: paragraphs[n - 1] });
  // UC-001 引 p11，UC-002 引 p15（表格里）：都在「2 日常养护」下面；UC-003 引 p6，在「1.1 适用范围」下面。
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "甲", 步骤: ["一步"] }, sources: [at(11)] },
    { op: "add", collection: "用例", fields: { 名称: "乙", 步骤: ["一步"] }, sources: [at(15)] },
    { op: "add", collection: "用例", fields: { 名称: "丙", 步骤: ["一步"] }, sources: [at(6)] },
  ] });
  const facts = (getTaskStatus(dir).details.materials as { blocks: { first_paragraph: number; last_paragraph: number; heading: string | null; items: number }[] }[])[0];
  assert.deepEqual(facts.blocks.map((b) => [b.first_paragraph, b.last_paragraph, b.heading, b.items]), [
    [1, 4, "1 概述", 0],
    [5, 8, "1.1 适用范围；1.1.1 例外", 1],
    [9, 16, "2 日常养护", 2],
  ]);
});
