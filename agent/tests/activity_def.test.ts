/**
 * 活动的声明与流程的声明：任务类型里的七项活动与两条流程读得出来、取值照表；缺栏、取值不认、标识符不对、阶段对不上都报错；
 * 任务目录里没有声明时回退读产品自带的；拼系统提示时声明去掉。
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ACTIVITIES, ASSETS, CONDITIONS, CONDITION_TEXTS, DefinitionHeadError, MODE_NAMES, NO_PREREQUISITE_TEXT,
  parseActivityDef, parseFlowDef, prerequisiteText, splitHead,
} from "../src/lib/activity_def.ts";
import { definitionsFor, readDefinitions, templateWritesAllowed } from "../src/lib/activity_def_read.ts";
import { STAGES } from "../src/lib/stage.ts";
import { composeContext } from "../src/lib/context_assemble.ts";
import { SRS_SKILL_DIR } from "./helpers.ts";

const HEAD = ["name: 核读材料", "mode: batch", "purpose: 通读材料。", "reads: materials, knowledge", "writes: description", "writes_allowed: page, problem",
  "requires: has_materials", "example: 一句例子。", "template: reading", "stage: reading"];
const withHead = (lines: readonly string[], body = "# 正文\n") => `---\n${lines.join("\n")}\n---\n\n${body}`;
const SKILL_PATH = ".pi/skills/requirements-engineering/SKILL.md";

test("需求工程的八项活动：方式、读、写、前置条件、模板与阶段照表；逆向解析排在发布之后", () => {
  const { activities, fallback } = readDefinitions(SRS_SKILL_DIR);
  assert.equal(fallback, false);
  assert.deepEqual(activities.map((one) => one.key), [...ACTIVITIES, "parse_spec"]);
  const table = Object.fromEntries(activities.map((one) => [one.key, [one.name, one.mode, one.reads.join(" "), one.writes.join(" "), one.requires.join(" "), one.template, one.stage]]));
  assert.deepEqual(table, {
    reading: ["核读材料", "batch", "materials knowledge", "description", "has_materials", "reading", "reading"],
    clarifying: ["澄清", "dialogue", "description", "description", "", "clarifying", "clarifying"],
    modeling: ["整理建模", "batch", "description", "models description", "has_pages", "modeling", "modeling"],
    writing: ["写条目", "batch", "description models", "items", "has_pages diagrams_viewed", "writing", "writing"],
    reviewing: ["评审确认", "dialogue", "items", "review items", "has_items", "reviewing", "reviewing"],
    document: ["编写文档", "batch", "all", "description versions", "has_confirmed_items", "document", "document"],
    publish: ["发布", "user_only", "all", "versions", "no_open_findings confirmations_clear", null, null],
    parse_spec: ["逆向解析", "batch", "materials", "description", "has_materials", "reading", "reading"],
  });
  for (const one of activities) assert.ok(one.purpose.endsWith("。") && one.example.endsWith("。"), one.key);
});

test("获准能力表由活动声明生成：六个阶段取各自代表活动的 writes_allowed，空闲取空闲模板头；与原来手写的表相同", () => {
  const { activities, allowed } = readDefinitions(SRS_SKILL_DIR);
  assert.deepEqual(Object.fromEntries(activities.map((one) => [one.key, one.writesAllowed.join(" ")])), {
    reading: "page problem", clarifying: "page problem", modeling: "page problem diagram", writing: "page problem diagram item review",
    reviewing: "page problem diagram item review publish", document: "page problem publish", publish: "", parse_spec: "page problem",
  });
  assert.deepEqual(allowed, {
    reading: ["page", "problem"], clarifying: ["page", "problem"], modeling: ["page", "problem", "diagram"],
    writing: ["page", "problem", "diagram", "item", "review"], reviewing: ["page", "problem", "diagram", "item", "review", "publish"],
    document: ["page", "problem", "publish"], idle: ["page", "problem"],
  });
  for (const one of activities) if (one.template !== null) assert.ok(one.writesAllowed.every((kind) => templateWritesAllowed(one.template!).includes(kind)), one.key);
});

test("活动声明的 writes_allowed 超出它所用模板头里的那一栏时，读声明报错，说明是哪份文件、多写了什么", () => {
  const dir = mkdtempSync(join(tmpdir(), "allowed-"));
  try {
    cpSync(SRS_SKILL_DIR, dir, { recursive: true });
    const file = join(dir, "activities", "reading.md");
    writeFileSync(file, readFileSync(file, "utf-8").replace("writes_allowed: page, problem", "writes_allowed: page, problem, item"));
    assert.throws(() => readDefinitions(dir), (error: Error) => error instanceof DefinitionHeadError
      && error.message === "activities/reading.md 的声明里「writes_allowed」写了 item，超出了它所用的模板 reading.md 头里写的（page、problem）。");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("需求工程的三条流程：各步与前置条件；需求分析与改写既有规格说明没有前置条件，需求变更要有已发布的版本", () => {
  const { flows } = readDefinitions(SRS_SKILL_DIR);
  assert.deepEqual(flows.map((one) => one.key), ["analysis", "change", "rewrite"]);
  const [analysis, change, rewrite] = flows;
  assert.deepEqual([analysis.key, analysis.name], ["analysis", "需求分析"]);
  assert.deepEqual(analysis.steps, [...STAGES, "publish"]);
  assert.deepEqual(analysis.requires, []);
  assert.ok(!analysis.applies.includes("首次") && !analysis.purpose.includes("首次"), analysis.applies);
  assert.equal(change.name, "需求变更");
  assert.deepEqual(change.steps, ["reading", "modeling", "writing", "reviewing", "document", "publish"]);
  assert.deepEqual(change.requires, ["has_version"]);
  assert.equal(rewrite.name, "改写既有规格说明");
  assert.deepEqual(rewrite.steps, ["parse_spec", ...STAGES, "publish"]);
  assert.deepEqual(rewrite.requires, []);
  assert.deepEqual(rewrite.slots.map((one) => [one.key, one.accepts, one.required, one.role]),
    [["spec", "materials", true, "既有规格说明"], ["evidence", "materials", false, "证据"], ["goal", "text", false, null]]);
  assert.deepEqual([analysis.slots, change.slots], [[], []]);
  for (const one of flows) for (const field of [one.purpose, one.applies, one.inputs, one.example]) assert.ok(field.length > 0, one.key);
});

test("逆向解析算作核读材料阶段、用核读模板，但核读材料阶段的代表仍是 reading：前六项仍是六个阶段的键", () => {
  const { activities, allowed } = readDefinitions(SRS_SKILL_DIR);
  const parse = activities.find((one) => one.key === "parse_spec")!;
  assert.deepEqual([parse.name, parse.stage, parse.template, parse.requires], ["逆向解析", "reading", "reading", ["has_materials"]]);
  assert.deepEqual(activities.slice(0, STAGES.length).map((one) => one.key), [...STAGES]);
  assert.deepEqual(allowed.reading, ["page", "problem"]);
});

test("六类资产的键是平台定的、名字由任务定义给；前置条件各有给人看的名字；几个前置条件合成一句", () => {
  assert.deepEqual(ASSETS, ["materials", "description", "models", "items", "review", "versions"]);
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

test("活动的声明缺栏、取值不认、标识符不对都报错，说明是哪份文件的哪一栏；前置条件可以是空的，读与写不能", () => {
  const got = parseActivityDef(withHead(HEAD), "reading", "activities/reading.md");
  assert.deepEqual([got.key, got.name, got.template, got.stage], ["reading", "核读材料", "reading", "reading"]);
  const without = (field: string) => HEAD.filter((line) => !line.startsWith(`${field}:`));
  for (const field of ["name", "mode", "purpose", "reads", "writes", "writes_allowed", "requires", "example", "template", "stage"]) {
    assert.throws(() => parseActivityDef(withHead(without(field)), "reading", "activities/reading.md"), (error: Error) =>
      error instanceof DefinitionHeadError && error.message.includes(`缺「${field}」一栏`), field);
  }
  const replaced = (field: string, value: string) => HEAD.map((line) => (line.startsWith(`${field}:`) ? `${field}: ${value}` : line));
  const parse = (lines: string[]) => parseActivityDef(withHead(lines), "reading", "activities/reading.md");
  assert.deepEqual(parse(replaced("requires", "")).requires, []);
  assert.throws(() => parse(replaced("reads", "")), /「reads」一栏是空的/);
  assert.throws(() => parse(replaced("writes", "")), /「writes」一栏是空的/);
  assert.throws(() => parse(replaced("mode", "auto")), /「mode」写的是「auto」，只能是 batch、dialogue、user_only 之一/);
  assert.throws(() => parse(replaced("writes", "description, knowledge")), /「writes」写了「knowledge」/);
  assert.throws(() => parse(replaced("writes_allowed", "")), /「writes_allowed」一栏是空的/);
  assert.throws(() => parse(replaced("writes_allowed", "page, items")), /「writes_allowed」写了「items」，只能是 page、problem、diagram、item、review、publish 里的/);
  assert.deepEqual(parse(replaced("writes_allowed", "page，problem")).writesAllowed, ["page", "problem"]);
  assert.throws(() => parse(replaced("requires", "ran_reading")), /「requires」写了「ran_reading」/);
  assert.throws(() => parse(replaced("stage", "testing")), /「stage」写的是「testing」/);
  assert.throws(() => parse(replaced("template", "")), /两栏都要写/);
  assert.throws(() => parse([...HEAD, "activity: reading"]), /不认的栏：activity/);
  assert.throws(() => parseActivityDef(withHead(HEAD), "Reading", "activities/Reading.md"), /不能当活动的标识符/);
  assert.throws(() => parseActivityDef("# 没有头\n", "reading", "activities/reading.md"), /reading.md 开头没有头/);
  // 只能由用户发起的活动：模板与阶段都空着。
  const publish = ["name: 发布", "mode: user_only", "purpose: 发布。", "reads: all", "writes: versions", "writes_allowed:", "requires:", "example: 发布第 1 版。", "template:", "stage:"];
  const parsed = parseActivityDef(withHead(publish), "publish", "activities/publish.md");
  assert.deepEqual([parsed.template, parsed.stage, parsed.writesAllowed], [null, null, []]);
  assert.throws(() => parseActivityDef(withHead(publish.map((line) => (line === "writes_allowed:" ? "writes_allowed: publish" : line))), "publish", "activities/publish.md"),
    /「writes_allowed」：只能由用户发起的活动不经助手，这一栏空着/);
  assert.throws(() => parseActivityDef(withHead(publish.map((line) => (line === "stage:" ? "stage: document" : line))), "publish", "activities/publish.md"), /两栏都空着/);
});

test("流程的声明缺栏、各步不认、同一项写两次、提示指到不在的一步，都报错", () => {
  const head = ["flow: analysis", "name: 需求分析", "purpose: 目的。", "applies: 适用。", "steps: reading, clarifying", "inputs: 输入。", "requires:", "example: 示例。", "note.clarifying: 一次只问一件。"];
  const parse = (lines: string[]) => parseFlowDef(withHead(lines), "analysis", "flows/analysis.md", ["reading", "clarifying", "publish"]);
  const got = parse(head);
  assert.deepEqual([got.steps, got.notes], [["reading", "clarifying"], { clarifying: "一次只问一件。" }]);
  for (const field of ["flow", "name", "purpose", "applies", "steps", "inputs", "requires", "example"]) {
    assert.throws(() => parse(head.filter((line) => !line.startsWith(`${field}:`))), new RegExp(`缺「${field}」一栏`), field);
  }
  const replaced = (field: string, value: string) => head.map((line) => (line.startsWith(`${field}:`) ? `${field}: ${value}` : line));
  assert.throws(() => parse(replaced("steps", "reading, testing")), /「steps」写了「testing」/);
  assert.throws(() => parse(replaced("steps", "reading, clarifying, reading")), /写了两次「reading」/);
  assert.throws(() => parse(replaced("flow", "change")), /「flow」写的是「change」，应当与文件名相同/);
  assert.throws(() => parse([...head, "note.publish: 不在里面。"]), /「note.publish」说的「publish」不在「steps」里/);
});

test("流程的槽位：slot.<键> 一行一个，按头里的先后；没有槽位行的流程是空的；重键、accepts 不认、收材料缺角色、required 不认、收文字带角色都报错", () => {
  const head = ["flow: analysis", "name: 需求分析", "purpose: 目的。", "applies: 适用。", "steps: reading, clarifying", "inputs: 输入。",
    "slot.spec: name=既有规格说明; accepts=materials; required=true; role=既有规格说明", "slot.goal: name=目标系统描述; accepts=text; required=false; role=",
    "slot.note: name=备注; accepts=text; required=false", "requires:", "example: 示例。"];
  const parse = (lines: string[]) => parseFlowDef(withHead(lines), "analysis", "flows/analysis.md", ["reading", "clarifying", "publish"]);
  assert.deepEqual(parse(head).slots, [
    { key: "spec", name: "既有规格说明", accepts: "materials", required: true, role: "既有规格说明" },
    { key: "goal", name: "目标系统描述", accepts: "text", required: false, role: null },
    { key: "note", name: "备注", accepts: "text", required: false, role: null }]);
  assert.deepEqual(parse(head.filter((line) => !line.startsWith("slot."))).slots, []);
  const spec = (value: string) => head.map((line) => (line.startsWith("slot.spec:") ? `slot.spec: ${value}` : line));
  const wrong = (lines: string[], pattern: RegExp) => assert.throws(() => parse(lines), (error: Error) => error instanceof DefinitionHeadError && pattern.test(error.message), String(pattern));
  wrong([...head.slice(0, 7), "slot.spec: name=又一个; accepts=materials; required=false; role=证据", ...head.slice(7)], /「slot\.spec」写了两次/);
  wrong(spec("name=既有规格说明; accepts=files; required=true; role=既有规格说明"), /「slot\.spec」的 accepts 写的是「files」/);
  wrong(spec("name=既有规格说明; accepts=materials; required=true; role="), /「slot\.spec」收材料，要写 role/);
  wrong(spec("name=既有规格说明; accepts=materials; required=yes; role=既有规格说明"), /「slot\.spec」的 required 写的是「yes」/);
  wrong(head.map((line) => (line.startsWith("slot.goal:") ? "slot.goal: name=目标系统描述; accepts=text; required=false; role=证据" : line)), /「slot\.goal」收文字，role 要空着/);
  wrong(spec("accepts=materials; name=既有规格说明; required=true; role=既有规格说明"), /「slot\.spec」第 1 项应当是「name=…」/);
});

/** 产品自带的需求工程 skill 目录的一份拷贝，在一个临时的任务目录里。 */
function skillCopy(): { root: string; skill: string } {
  const root = mkdtempSync(join(tmpdir(), "activity-def-"));
  const skill = join(root, ".pi", "skills", "requirements-engineering");
  mkdirSync(skill, { recursive: true });
  for (const sub of ["activities", "flows"]) cpSync(join(SRS_SKILL_DIR, sub), join(skill, sub), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# 说明\n");
  return { root, skill };
}

test("从目录里读：六个阶段各至少要有一项活动（可以有几项）、要有发布", () => {
  const { root, skill } = skillCopy();
  try {
    assert.deepEqual(readDefinitions(skill).activities, readDefinitions(SRS_SKILL_DIR).activities);
    const modeling = join(skill, "activities", "modeling.md");
    // 再加一项也算作核读材料的活动：可以，排在发布之后；按文件名它排在 reading 前面，核读材料的代表仍是标识符相同的 reading。
    const interview = join(skill, "activities", "interview.md");
    writeFileSync(interview, readFileSync(join(skill, "activities", "reading.md"), "utf-8").replace("name: 核读材料", "name: 访谈"));
    const both = readDefinitions(skill).activities;
    const added = both.findIndex((one) => one.key === "interview");
    assert.deepEqual([both[0].key, both[added].stage], ["reading", "reading"]);
    assert.ok(added > both.findIndex((one) => one.key === "publish"), "排在发布之后");
    rmSync(interview);
    rmSync(modeling);
    assert.throws(() => readDefinitions(skill), /没有算作「modeling」这个阶段的活动/);
    cpSync(join(SRS_SKILL_DIR, "activities", "modeling.md"), modeling);
    rmSync(join(skill, "activities", "publish.md"));
    assert.throws(() => readDefinitions(skill), /只能由用户发起的「publish」/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("任务目录里的 skill 没有 activities/ 时回退读产品自带的同一相对路径那一份；有就读自己的", () => {
  const { root, skill } = skillCopy();
  try {
    assert.equal(definitionsFor(root, SKILL_PATH).fallback, false);
    rmSync(join(skill, "activities"), { recursive: true });
    rmSync(join(skill, "flows"), { recursive: true });
    const back = definitionsFor(root, SKILL_PATH);
    assert.equal(back.fallback, true);
    assert.equal(back.dir, SRS_SKILL_DIR);
    assert.throws(() => definitionsFor(root, ".pi/skills/no-such-type/SKILL.md"), /都没有这份 skill 的活动定义/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("拼系统提示时声明去掉：活动模板从标题起，各步之间的转移由程序填好，整份文字里没有声明的任何一栏", () => {
  const { root, skill } = skillCopy();
  try {
    const skills = [{ name: "requirements-engineering", filePath: join(skill, "SKILL.md") }];
    const fields = /^(activity|flow|mode|reads|writes|requires|steps|template|writes_allowed|based_on|stage|name|order|when): /m;
    for (const stage of STAGES) {
      const prompt = composeContext({ stage, workspaceDir: root, skills, tail: "" });
      assert.ok(prompt.parts.find((one) => one.part === "template")!.text.startsWith("# 现在这个阶段："), stage);
      assert.ok(prompt.parts.find((one) => one.module === "flow_transitions")!.text.startsWith("## 各步之间的转移\n"), stage);
      assert.doesNotMatch(prompt.text, fields, stage);
      assert.doesNotMatch(prompt.text, /^---$/m, stage);
    }
    assert.doesNotMatch(composeContext({ stage: "idle", workspaceDir: root, skills, tail: "" }).text, fields);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
