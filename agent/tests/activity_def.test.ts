/**
 * 活动的定义与流程的定义开头的头：产品自带的九份文件读得出来、取值照表；缺栏、取值不认、键与文件名不同都报错；
 * 拼系统提示时头去掉，正文一字不变。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ACTIVITIES, ASSETS, ASSET_NAMES, CONDITIONS, CONDITION_TEXTS, DefinitionHeadError, FLOW_KEYS, MODE_NAMES, NO_PREREQUISITE_TEXT,
  parseActivityDef, parseFlowDef, prerequisiteText, splitHead,
} from "../src/lib/activity_def.ts";
import { definitions, readDefinitions } from "../src/lib/activity_def_read.ts";
import { STAGES } from "../src/lib/stage.ts";
import { PLATFORM_FLOWS_DIR, PLATFORM_STAGES_DIR } from "../src/lib/activity_def_read.ts";
import { composeContext } from "../src/lib/context_assemble.ts";

const HEAD = ["activity: reading", "name: 核读材料", "mode: batch", "purpose: 通读材料。", "reads: materials, knowledge", "writes: description", "requires: has_materials", "example: 一句例子。"];
const withHead = (lines: readonly string[], body = "# 正文\n") => `---\n${lines.join("\n")}\n---\n\n${body}`;

test("产品自带的七项活动：方式、读、写、前置条件照表", () => {
  const { activities } = definitions();
  assert.deepEqual(activities.map((one) => one.key), [...ACTIVITIES]);
  const table = Object.fromEntries(activities.map((one) => [one.key, [one.name, one.mode, one.reads.join(" "), one.writes.join(" "), one.requires.join(" ")]]));
  assert.deepEqual(table, {
    reading: ["核读材料", "batch", "materials knowledge", "description", "has_materials"],
    clarifying: ["澄清", "dialogue", "description", "description", ""],
    modeling: ["整理建模", "batch", "description", "models description", "has_pages"],
    writing: ["写条目", "batch", "description models", "items", "has_pages diagrams_viewed"],
    reviewing: ["评审确认", "dialogue", "items", "review items", "has_items"],
    document: ["编写文档", "batch", "all", "description versions", "has_confirmed_items"],
    publish: ["发布", "user_only", "all", "versions", "no_open_findings confirmations_clear"],
  });
  for (const one of activities) {
    assert.ok(one.purpose.endsWith("。") && one.example.endsWith("。"), one.key);
  }
});

test("产品自带的两条流程：各站与前置条件；需求分析没有前置条件，需求变更要有已发布的版本", () => {
  const { flows } = definitions();
  assert.deepEqual(flows.map((one) => one.key), [...FLOW_KEYS]);
  const [analysis, change] = flows;
  assert.deepEqual([analysis.key, analysis.name], ["analysis", "需求分析"]);
  assert.deepEqual(analysis.nodes, [...STAGES, "publish"]);
  assert.deepEqual(analysis.requires, []);
  // 流程可以反复迭代，适用情形里不再说「首次」。
  assert.ok(!analysis.applies.includes("首次") && !analysis.purpose.includes("首次"), analysis.applies);
  assert.equal(change.name, "需求变更");
  assert.deepEqual(change.nodes, ["reading", "modeling", "writing", "reviewing", "document", "publish"]);
  assert.deepEqual(change.requires, ["has_version"]);
  for (const one of flows) for (const field of [one.purpose, one.applies, one.inputs, one.example]) assert.ok(field.length > 0, one.key);
});

test("六类资产与前置条件各有给人看的名字；几个前置条件合成一句", () => {
  assert.deepEqual(ASSETS.map((one) => ASSET_NAMES[one]), ["材料与证据", "业务说明", "分析模型", "需求条目", "评审与确认", "文档与版本"]);
  for (const one of CONDITIONS) assert.ok(CONDITION_TEXTS[one], one);
  assert.deepEqual(Object.values(MODE_NAMES), ["批处理", "逐项对话", "仅限用户发起"]);
  assert.equal(prerequisiteText([]), NO_PREREQUISITE_TEXT);
  assert.equal(prerequisiteText(["has_pages", "diagrams_viewed"]), "前置条件：业务说明至少一节，分析模型均已查看。");
});

test("拆头：两行 --- 之间一行一栏，值里的冒号不拆；没有头时正文是全文", () => {
  const { head, body } = splitHead(withHead(["name: 核读材料", "example: 例：「逾期后能否续借」答「不能」。", "requires:"]));
  assert.deepEqual(head, { name: "核读材料", example: "例：「逾期后能否续借」答「不能」。", requires: "" });
  assert.equal(body, "# 正文\n");
  assert.deepEqual(splitHead("# 没有头\n"), { head: null, body: "# 没有头\n" });
});

test("活动的头缺栏、取值不认都报错，说明是哪份文件的哪一栏；前置条件可以是空的，读与写不能", () => {
  assert.equal(parseActivityDef(withHead(HEAD), "reading.md").name, "核读材料");
  const without = (field: string) => HEAD.filter((line) => !line.startsWith(`${field}:`));
  for (const field of ["activity", "name", "mode", "purpose", "reads", "writes", "requires", "example"]) {
    assert.throws(() => parseActivityDef(withHead(without(field)), "reading.md"), (error: Error) =>
      error instanceof DefinitionHeadError && error.message === `reading.md 的头里缺「${field}」一栏。`, field);
  }
  const replaced = (field: string, value: string) => HEAD.map((line) => (line.startsWith(`${field}:`) ? `${field}: ${value}` : line));
  assert.deepEqual(parseActivityDef(withHead(replaced("requires", "")), "reading.md").requires, []);
  assert.throws(() => parseActivityDef(withHead(replaced("reads", "")), "reading.md"), /「reads」一栏是空的/);
  assert.throws(() => parseActivityDef(withHead(replaced("writes", "")), "reading.md"), /「writes」一栏是空的/);
  assert.throws(() => parseActivityDef(withHead(replaced("mode", "auto")), "reading.md"), /「mode」写的是「auto」，只能是 batch、dialogue、user_only 之一/);
  assert.throws(() => parseActivityDef(withHead(replaced("writes", "description, knowledge")), "reading.md"), /「writes」写了「knowledge」/);
  assert.throws(() => parseActivityDef(withHead(replaced("requires", "ran_reading")), "reading.md"), /「requires」写了「ran_reading」/);
  assert.throws(() => parseActivityDef("# 没有头\n", "reading.md"), /reading.md 开头没有头/);
});

test("流程的头缺栏、站名不认都报错", () => {
  const head = ["flow: analysis", "name: 需求分析", "purpose: 目的。", "applies: 适用。", "nodes: reading, clarifying", "inputs: 输入。", "requires:", "example: 示例。"];
  assert.deepEqual(parseFlowDef(withHead(head), "analysis.md").nodes, ["reading", "clarifying"]);
  for (const field of ["flow", "name", "purpose", "applies", "nodes", "inputs", "requires", "example"]) {
    assert.throws(() => parseFlowDef(withHead(head.filter((line) => !line.startsWith(`${field}:`))), "analysis.md"), new RegExp(`缺「${field}」一栏`), field);
  }
  assert.throws(() => parseFlowDef(withHead(head.map((line) => (line.startsWith("nodes:") ? "nodes: reading, testing" : line))), "analysis.md"), /「nodes」写了「testing」/);
});

test("从目录里读：文件不在、头里的键与文件名不同都报错", () => {
  const root = mkdtempSync(join(tmpdir(), "activity-def-"));
  try {
    const stages = join(root, "stages"), flows = join(root, "flows");
    mkdirSync(stages);
    mkdirSync(flows);
    for (const key of ACTIVITIES) writeFileSync(join(stages, `${key}.md`), readFileSync(join(PLATFORM_STAGES_DIR, `${key}.md`), "utf-8"));
    for (const key of FLOW_KEYS) writeFileSync(join(flows, `${key}.md`), readFileSync(join(PLATFORM_FLOWS_DIR, `${key}.md`), "utf-8"));
    assert.deepEqual(readDefinitions(stages, flows), definitions());
    writeFileSync(join(stages, "modeling.md"), readFileSync(join(PLATFORM_STAGES_DIR, "writing.md"), "utf-8"));
    assert.throws(() => readDefinitions(stages, flows), /modeling.md 的头里「activity」写的是「writing」，应当与文件名相同/);
    rmSync(join(stages, "modeling.md"));
    assert.throws(() => readDefinitions(stages, flows), /定义文件不在：.*modeling\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("拼系统提示时头去掉：活动那一段从标题起，流程那一段是节点的正文，整份文字里没有头的任何一栏", () => {
  const workspace = mkdtempSync(join(tmpdir(), "activity-def-ws-"));
  try {
    for (const stage of STAGES) {
      const prompt = composeContext({ stage, workspaceDir: workspace, skills: [], tail: "" });
      const activity = prompt.parts.find((one) => one.part === "template")!;
      assert.ok(activity.text.startsWith("# 现在这个阶段："), stage);
      assert.ok(prompt.parts.find((one) => one.part === "node_exit")!.text.startsWith("## 出口\n"), stage);
      assert.doesNotMatch(prompt.text, /^(activity|flow|mode|reads|writes|requires|nodes|template|writes_allowed|name|order|when): /m, stage);
      assert.doesNotMatch(prompt.text, /^---$/m, stage);
    }
    const idle = composeContext({ stage: "idle", workspaceDir: workspace, skills: [], tail: "" });
    assert.doesNotMatch(idle.text, /^(activity|mode|reads|writes|requires|template|writes_allowed|based_on|name|order|when): /m);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
