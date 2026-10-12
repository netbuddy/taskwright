/**
 * 把生成出来的文档切成块（lib/document_blocks.ts）：预览与 Word 两处照同一批块排。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { docRuns, documentBlocks, figureIds, plainText } from "../src/lib/document_blocks.ts";

test("标题、段落、引用：标题认一到四个井号；段落里的换行留着；行内只认加粗", () => {
  const blocks = documentBlocks("# 文档\n\n> 本文档按修订 3 生成。\n> 第二行。\n\n## 1 概述\n这一章讲什么。\n第二行 **重点** 在这里。\n\n##### 五个井号不是标题\n#没有空格也不是\n");
  assert.deepEqual(blocks, [
    { kind: "heading", level: 1, text: "文档" },
    { kind: "quote", runs: [{ text: "本文档按修订 3 生成。\n第二行。", bold: false }] },
    { kind: "heading", level: 2, text: "1 概述" },
    { kind: "paragraph", runs: [{ text: "这一章讲什么。\n第二行 ", bold: false }, { text: "重点", bold: true }, { text: " 在这里。", bold: false }] },
    { kind: "paragraph", runs: [{ text: "##### 五个井号不是标题\n#没有空格也不是", bold: false }] },
  ]);
  assert.deepEqual(docRuns("**流程步骤**（D-004 借书）"), [{ text: "流程步骤", bold: true }, { text: "（D-004 借书）", bold: false }]);
  // 星号没有成对：原样当文字。
  assert.deepEqual(docRuns("2 ** 3"), [{ text: "2 ** 3", bold: false }]);
  assert.equal(plainText("**角色。** 有两种"), "角色。 有两种");
});

test("列表：短横线与数字两种，缩进两个空格是下一层；有序与否看第一项", () => {
  const blocks = documentBlocks("- 借还更省事\n  - 决定：只在自助机上办\n    - 更深一层\n- 第二个目标\n\n1. 学生一次最多借 5 本。\n2. **【待定】**待定：能不能借\n段落紧跟着\n");
  assert.deepEqual(blocks[0], { kind: "list", ordered: false, items: [
    { depth: 0, runs: [{ text: "借还更省事", bold: false }] }, { depth: 1, runs: [{ text: "决定：只在自助机上办", bold: false }] },
    { depth: 2, runs: [{ text: "更深一层", bold: false }] }, { depth: 0, runs: [{ text: "第二个目标", bold: false }] }] });
  assert.deepEqual(blocks[1], { kind: "list", ordered: true, items: [
    { depth: 0, runs: [{ text: "学生一次最多借 5 本。", bold: false }] }, { depth: 0, runs: [{ text: "【待定】", bold: true }, { text: "待定：能不能借", bold: false }] }] });
  assert.deepEqual(blocks[2], { kind: "paragraph", runs: [{ text: "段落紧跟着", bold: false }] });
});

test("表格：第二行是分隔行才算；格子里转义的竖线还原；格子里的加粗去掉记号；表格后面紧跟的一行是段落", () => {
  const blocks = documentBlocks("| 用例 | 读者 | 所属流程 |\n|---|---|---|\n| 自助借书 | 发起 | 3.1 自助借书 |\n| a \\| b | — | **粗** |\n依据用例图：D-002。\n\n| 只有一行竖线 |\n");
  assert.deepEqual(blocks, [
    { kind: "table", head: ["用例", "读者", "所属流程"], rows: [["自助借书", "发起", "3.1 自助借书"], ["a | b", "—", "粗"]] },
    { kind: "paragraph", runs: [{ text: "依据用例图：D-002。", bold: false }] },
    { kind: "paragraph", runs: [{ text: "| 只有一行竖线 |", bold: false }] },
  ]);
});

test("代码块：写着 mermaid 的是图，后面跟的是图的编号；别的是代码；图里以井号、竖线、短横线开头的行不被当成别的块", () => {
  const blocks = documentBlocks("**流程步骤**（D-004 借书）\n\n```mermaid D-004\nflowchart TD\n  a --> b\n## 不是标题\n- 不是列表\n| 不是 | 表格 |\n```\n\n```mermaid\nstateDiagram-v2\n```\n\n```json\n{\"a\": 1}\n```\n");
  assert.deepEqual(blocks.map((one) => one.kind), ["paragraph", "figure", "figure", "code"]);
  assert.deepEqual(blocks[1], { kind: "figure", diagram_id: "D-004", mermaid: "flowchart TD\n  a --> b\n## 不是标题\n- 不是列表\n| 不是 | 表格 |" });
  assert.deepEqual(blocks[2], { kind: "figure", diagram_id: null, mermaid: "stateDiagram-v2" });
  assert.deepEqual(blocks[3], { kind: "code", text: '{"a": 1}' });
  // 文档里用到的图：写了编号的，不重复。
  assert.deepEqual(figureIds([...blocks, blocks[1]]), ["D-004"]);
  // 没有收尾的代码块：到文末为止。
  assert.deepEqual(documentBlocks("```mermaid D-1\nflowchart TD"), [{ kind: "figure", diagram_id: "D-1", mermaid: "flowchart TD" }]);
});

test("空文档与只有空行的文档没有块", () => {
  assert.deepEqual([documentBlocks(""), documentBlocks("\n\n  \n")], [[], []]);
});
