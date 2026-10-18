// Word 来源的摘录不在写的那一段、只在同一表格行的另一格里（全文件只此一处）：不拒绝，出处改到那一段写入，保存结果末尾说一句。
// 同一行里有好几处、命中在别的行，照旧拒绝。

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { DEFINITION_PATH, callIn, count, makeWorkspace, query } from "./helpers.ts";

/** 一份 Word 材料的投影：一段标题，接一张三行的表（表头算第 1 行）。 */
const PROJECTION = [
  "<!--",
  "由 指标.docx 生成，供助手阅读。段落总数：10。",
  "-->",
  "",
  "[p1] 指标表",
  "",
  "| [p2] 指标 | [p3] 目标 | [p4] 下限 |",
  "| --- | --- | --- |",
  "| [p5] 可用性 | [p6] 100% | [p7] 99.9% |",
  "| [p8] 响应 | [p9] 2 秒 | [p10] 2 秒 |",
  "",
].join("\n");

function workspace(): string {
  const dir = makeWorkspace(undefined, { material: false });
  mkdirSync(join(dir, "inputs"), { recursive: true });
  writeFileSync(join(dir, "inputs/指标.docx"), "占位");
  writeFileSync(join(dir, "inputs/指标.docx.md"), PROJECTION, "utf-8");
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}

const add = (dir: string, locator: string, excerpt: string) =>
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "可用性", 步骤: ["达到指标"] }, sources: [{ kind: "文档原文", locator, excerpt }] }] });
const refused = (dir: string, locator: string, excerpt: string): string => {
  try {
    add(dir, locator, excerpt);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("没有被拒绝");
};

test("摘录在同一行的另一格、全文件只此一处：出处改到那一段写入，保存结果末尾说一句", () => {
  const dir = workspace();
  const outcome = add(dir, "inputs/指标.docx#p5", "100%");
  assert.ok(outcome.text.endsWith("\n第 1 个操作的第 1 条来源的出处 inputs/指标.docx#p5 已改为 #p6：摘录「100%」在同一行的另一格里。"), outcome.text);
  assert.deepEqual(query<{ locator: string }>(dir, "SELECT locator FROM item_source WHERE kind = '文档原文'").map((row) => row.locator), ["inputs/指标.docx#p6"]);
});

test("同一行里有好几处：不代改，照旧拒绝并列出几处", () => {
  const dir = workspace();
  const before = count(dir, "revision");
  assert.match(refused(dir, "inputs/指标.docx#p8", "2 秒"), /在 指标\.docx 第 8 段·表 1 行 3 列 1里找不到；这段文字在第 9 段·表 1 行 3 列 2、第 10 段·表 1 行 3 列 3都有/);
  assert.equal(count(dir, "revision"), before);
});

test("命中在别的行：不代改，照旧拒绝并指给那一段", () => {
  const dir = workspace();
  assert.match(refused(dir, "inputs/指标.docx#p2", "可用性"), /在 指标\.docx 第 2 段·表 1 行 1 列 1里找不到，它在第 5 段·表 1 行 2 列 1[\s\S]*出处改写成 inputs\/指标\.docx#p5/);
});
