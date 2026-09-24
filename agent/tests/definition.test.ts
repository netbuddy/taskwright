/** 任务定义校验的通过与各类不通过。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DefinitionError, loadDefinition, validateDefinition } from "../src/lib/definition.ts";
import { DEFINITION_PATH, demoDefinition, makeWorkspace } from "./helpers.ts";

function reasonsOf(raw: unknown): string[] {
  try {
    validateDefinition(raw, "demo.json");
  } catch (error) {
    assert.ok(error instanceof DefinitionError);
    return error.reasons;
  }
  assert.fail("应当不通过，实际通过了");
}

test("合格的任务定义通过，返回结构化对象", () => {
  const dir = makeWorkspace();
  const { definition, relativePath } = loadDefinition(dir, DEFINITION_PATH);
  assert.equal(relativePath, DEFINITION_PATH);
  assert.equal(definition.taskName, "演示任务");
  assert.deepEqual(definition.collections.map((c) => c.prefix), ["UC", "TBD"]);
  assert.deepEqual(definition.collections[1].fields[1].values, ["未解决", "已解决"]);
  assert.deepEqual(definition.completion["待定事项"], ["没有状态为未解决的条目"]);
});

test("缺少必有的键时逐条说明", () => {
  const reasons = reasonsOf({});
  assert.ok(reasons.some((r) => r.includes("任务名")));
  assert.ok(reasons.some((r) => r.includes("交付物")));
  assert.ok(reasons.some((r) => r.includes("完成条件")));
  assert.ok(reasons.some((r) => r.includes("执行方法")));
  assert.ok(reasons.some((r) => r.includes("领域规矩")));
});

test("集合名与编号前缀重复时不通过", () => {
  const raw = demoDefinition() as any;
  raw.交付物.条目集合[1].名称 = "用例";
  raw.交付物.条目集合[1].编号前缀 = "UC";
  const reasons = reasonsOf(raw);
  assert.ok(reasons.some((r) => r.includes("集合名「用例」重复")));
  assert.ok(reasons.some((r) => r.includes("编号前缀「UC」重复")));
});

test("字段类型只能是四种之一", () => {
  const raw = demoDefinition() as any;
  raw.交付物.条目集合[0].字段[0].类型 = "数字";
  assert.ok(reasonsOf(raw).some((r) => r.includes("类型「数字」不认识")));
});

test("枚举必须有取值", () => {
  const raw = demoDefinition() as any;
  delete raw.交付物.条目集合[1].字段[1].取值;
  assert.ok(reasonsOf(raw).some((r) => r.includes("枚举类型，必须有「取值」")));
});

test("完成条件里的条件名必须已实现，集合必须存在", () => {
  const raw = demoDefinition() as any;
  raw.完成条件.用例.push("写得漂亮");
  raw.完成条件.不存在的集合 = ["至少一个条目"];
  const reasons = reasonsOf(raw);
  assert.ok(reasons.some((r) => r.includes("「写得漂亮」没有实现")));
  assert.ok(reasons.some((r) => r.includes("集合「不存在的集合」不在")));
});

test("用了「没有状态为未解决的条目」的集合必须有带「未解决」的状态枚举", () => {
  const raw = demoDefinition() as any;
  raw.完成条件.用例.push("没有状态为未解决的条目");
  assert.ok(reasonsOf(raw).some((r) => r.includes("名叫「状态」的枚举字段")));
});

test("文件不存在、不是 JSON、在任务目录之外时各有说明", () => {
  const dir = makeWorkspace();
  assert.throws(() => loadDefinition(dir, "docs/没有这个.json"), /读不到这个文件/);
  assert.throws(() => loadDefinition(dir, "../外面.json"), /必须在任务目录之内/);
});

test("「材料目录」是可选项：不写就是 inputs/，写了就照读并补上结尾的斜杠", () => {
  const raw = demoDefinition() as any;
  delete raw.材料目录;
  assert.equal(validateDefinition(raw, "demo.json").materialsDir, "inputs/");
  raw.材料目录 = "recordings-text";
  assert.equal(validateDefinition(raw, "demo.json").materialsDir, "recordings-text/");
  raw.材料目录 = "materials/raw/";
  assert.equal(validateDefinition(raw, "demo.json").materialsDir, "materials/raw/");
});

test("「材料目录」写了就不能为空，也不能跳出任务目录", () => {
  const raw = demoDefinition() as any;
  raw.材料目录 = "";
  assert.ok(reasonsOf(raw).some((r) => r.includes("「材料目录」是可选项")));
  raw.材料目录 = 42;
  assert.ok(reasonsOf(raw).some((r) => r.includes("「材料目录」是可选项")));
  raw.材料目录 = "/etc";
  assert.ok(reasonsOf(raw).some((r) => r.includes("不能是绝对路径")));
  raw.材料目录 = "inputs/../../外面";
  assert.ok(reasonsOf(raw).some((r) => r.includes("不能用「..」跳出任务目录")));
});

test("领域标签是可选项：不写为空；写了要是不为空的文字", () => {
  assert.equal(validateDefinition(demoDefinition()).domainTag, null);
  assert.equal(validateDefinition({ ...demoDefinition(), 领域标签: " 售后 " }).domainTag, "售后");
  assert.ok(reasonsOf({ ...demoDefinition(), 领域标签: "" }).some((r) => r.includes("「领域标签」是可选项")));
});
