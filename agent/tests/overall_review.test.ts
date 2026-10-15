/**
 * 评审与总体分析：给评审者的提示里多一节【总体分析的主题】（贴了标签、在用的主题的标题与别名），有自己的字数上限；
 * 没有总体分析集合的任务没有这一节；任务类型的两个规则文件各多一条可选规则「专门名词应当有主题页」，缺省是开着的。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { effectiveRules, validateDefinition } from "../src/lib/definition.ts";
import { OVERALL_COLLECTION, TOPICS_LIMIT, topicLines } from "../src/lib/overall_analysis.ts";
import { prepareReviews } from "../src/lib/review.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { DEFINITION_PATH, READY_PAGE, SOURCE, callIn, demoDefinition, makeWorkspace, overallDefinition, startWriting, viewReadyPage } from "./helpers.ts";

const TASK_TYPE = join(import.meta.dirname, "..", "..", "task-types", "requirements-engineering");
const page = (fields: Record<string, unknown>) =>
  ({ op: "add", collection: "总体分析", fields: { 它是什么: "读者对在架的书办预约。", 状态: "在用", ...fields }, sources: [SOURCE] });
const useCase = { op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["读者选一本在架的书", "馆员把书放到预留架"] }, sources: [SOURCE] };

function workspace(definition: unknown): string {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  startWriting(dir);
  return dir;
}

test("评审提示带【总体分析的主题】：只列贴了标签、在用的主题，写编号、标题与别名；排在别的条目之后、材料之前", () => {
  const dir = workspace(overallDefinition());
  saveRevision(callIn(dir), { operations: [
    READY_PAGE,
    page({ 标题: "预约取书", 别名: ["预约", "预留"], 标签: ["概念", "流程"] }),
    page({ 标题: "排队等书" }),                                     // 没有贴标签
    page({ 标题: "旧说法", 标签: ["概念"], 状态: "已废弃" }),
  ] });
  viewReadyPage(dir);
  saveRevision(callIn(dir), { operations: [useCase] });
  const prompt = prepareReviews(dir, null).items.find((one) => one.item_id === "UC-001")!.user;
  // 这一节自己的几行：没有贴标签的 OA-003 与已废弃的 OA-004 不在里面。
  const section = prompt.slice(prompt.indexOf("【总体分析的主题】")).split("\n\n")[0].split("\n");
  assert.deepEqual(section, ["【总体分析的主题】贴了标签、在用的主题，一行一页（标题，括号里是别名）：", "- OA-001 馆藏范围", "- OA-002 预约取书（又叫：预约、预留）"]);
  const at = (mark: string) => prompt.indexOf(mark);
  assert.ok(at("【相关的条目】") < at("【总体分析的主题】") && at("【总体分析的主题】") < at("【材料"), "排在别的条目之后、材料之前");
});

test("主题清单的上限：超过时从末尾省去并写明还有几页；一页都没有贴标签时照实说；没有总体分析集合时没有这一节", () => {
  const collections = [{ name: OVERALL_COLLECTION }, { name: "用例" }];
  const pages = Array.from({ length: 40 }, (_, n) => ({
    item_id: `OA-${String(n + 1).padStart(3, "0")}`, collection: OVERALL_COLLECTION, revision_no: 1, fields: { 标题: `主题${n + 1}`, 标签: ["概念"], 状态: "在用" },
  }));
  const all = topicLines(collections, pages);
  assert.equal(all.length, 41);
  assert.ok(all.join("\n").length < TOPICS_LIMIT);
  const cut = topicLines(collections, pages, 60);
  assert.deepEqual(cut.slice(1), ["- OA-001 主题1", "- OA-002 主题2", "- OA-003 主题3", "- OA-004 主题4", "（还有 36 页没有列出。）"]);
  assert.deepEqual(topicLines(collections, [{ ...pages[0], fields: { 标题: "草稿" } }]).slice(1), ["（还没有贴了标签的主题。）"]);
  assert.deepEqual(topicLines([{ name: "领域说明" }, { name: "用例" }], pages), []);
});

test("没有总体分析集合的任务（0.4 建的）：评审提示里没有这一节", () => {
  const dir = workspace(demoDefinition());
  saveRevision(callIn(dir), { operations: [useCase] });
  assert.doesNotMatch(prepareReviews(dir, null).items[0].user, /总体分析/);
});

test("任务类型的两个规则文件各有一条「专门名词应当有主题页」：可选，缺省开着，三个要评审的集合都会评到它", () => {
  const read = (name: string) => JSON.parse(readFileSync(join(TASK_TYPE, "docs", "review-rules", name), "utf-8")) as { 编号: string; 级别: string; 条文: string }[];
  for (const [file, id] of [["use-case.json", "UC-R16"], ["ears.json", "EARS-R11"]] as const) {
    const rule = read(file).find((one) => one.编号 === id)!;
    assert.equal(rule.级别, "可选", id);
    assert.match(rule.条文, /专门名词.*应当在总体分析里有一页主题.*「这个词还没有主题页」/, id);
  }
  const definition = validateDefinition(JSON.parse(readFileSync(join(TASK_TYPE, "docs", "task-definitions", "requirements-engineering.json"), "utf-8")), "requirements-engineering.json", { baseDir: TASK_TYPE });
  const effective = (name: string) => effectiveRules(TASK_TYPE, definition.collections.find((c) => c.name === name)!.reviewRules!).map((rule) => rule.编号);
  assert.ok(effective("功能用例").includes("UC-R16"));
  for (const name of ["非功能需求", "约束"]) assert.ok(effective(name).includes("EARS-R11"), name);
});

test("评审提示词说明了第六样东西与怎样检查这条规则", () => {
  const text = readFileSync(join(import.meta.dirname, "..", "prompts", "review.md"), "utf-8");
  assert.match(text, /6\. 总体分析的主题（【总体分析的主题】；有的任务没有这一节）/);
  assert.match(text, /对「专门名词应当有主题页」这类规则：只在给了你【总体分析的主题】时才检查/);
  assert.match(text, /或者是总体分析的一页主题时，说明这件事已经由用户定下或确认/);
});
