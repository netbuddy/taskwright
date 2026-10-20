/**
 * 平台提供的集合（src/lib/definition.ts 的 withPlatformCollections）：任务类型的定义写占位，平台补入整个集合与它的完成条件；
 * 早先的定义里已经有同名集合时照原样；建任务时任务目录里的定义与任务库里的快照都是补全之后的全文。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { KEEP_PENDING_STATUS, PLATFORM_COLLECTION_NAMES, keepPendingField, validateDefinition, withPlatformCollections } from "../src/lib/definition.ts";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "../src/lib/db.ts";
import { DEFINITION_PATH, callIn, makeWorkspace } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SRS = join(ROOT, "task-types", "requirements-engineering", "docs", "task-definitions", "requirements-engineering.json");
const minimal = (collections: unknown[], completion: Record<string, unknown> = {}) => ({
  任务名: "演示", 交付物: { 名称: "交付物", 文档模板: "docs/t.md", 每个条目附带: "来源", 条目集合: collections }, 完成条件: completion, 执行方法: "x/SKILL.md", 领域规矩: ["docs/rules.md"],
});
const page = { 名称: "页", 编号前缀: "PG", 字段: [{ 名: "标题", 类型: "文本", 必填: true }] };

test("占位换成平台的问题集合，位置不变；完成条件按集合的先后补上", () => {
  const got = withPlatformCollections(minimal([page, { 平台集合: "问题" }], { 页: ["每个条目用户确认"] }));
  assert.equal(got.changed, true);
  const raw = got.raw as any;
  assert.deepEqual(raw.交付物.条目集合.map((one: any) => one.名称), ["页", "问题"]);
  assert.deepEqual(Object.entries(raw.完成条件), [["页", ["每个条目用户确认"]], ["问题", ["没有状态为未解决的条目"]]]);
  const definition = validateDefinition(raw);
  const problems = definition.collections.find((one) => one.name === "问题")!;
  assert.equal(problems.prefix, "TBD");
  assert.ok(keepPendingField(problems)!.values!.includes(KEEP_PENDING_STATUS));
  assert.deepEqual(PLATFORM_COLLECTION_NAMES, ["问题"]);
});

test("没有写占位的定义照原样；已经有问题集合的（早先的定义）照原样，不补也不改", () => {
  const plain = minimal([page]);
  assert.deepEqual(withPlatformCollections(plain), { raw: plain, changed: false });
  const own = { 名称: "问题", 编号前缀: "Q", 字段: [{ 名: "状态", 类型: "枚举", 必填: true, 取值: ["未解决", KEEP_PENDING_STATUS] }] };
  const old = minimal([page, own], { 问题: ["没有状态为未解决的条目"] });
  const same = withPlatformCollections(old);
  assert.equal(same.changed, false);
  assert.equal(same.raw, old);
  assert.equal(validateDefinition(old).collections.find((one) => one.name === "问题")!.prefix, "Q");
  // 名字不同的问题集合（状态里有「用户决定保留」）同样算有：写了占位也不补。
  const renamed = { ...own, 名称: "待定事项" };
  assert.deepEqual((withPlatformCollections(minimal([page, renamed, { 平台集合: "问题" }])).raw as any).交付物.条目集合.map((one: any) => one.名称), ["页", "待定事项"]);
  // 有同名集合又写了占位：占位去掉，用原有的那一份。
  const both = withPlatformCollections(minimal([page, own, { 平台集合: "问题" }])).raw as any;
  assert.deepEqual(both.交付物.条目集合.map((one: any) => one.编号前缀), ["PG", "Q"]);
  // 形状不对的原样交回，由校验报错。
  assert.equal(withPlatformCollections(null).changed, false);
  assert.throws(() => validateDefinition({ 任务名: "x" }), /缺少「交付物」/);
});

test("产品自带的需求工程定义只写占位；读出来有完整的问题集合；建任务后任务目录里的定义与库里的快照都是全文", () => {
  const raw = JSON.parse(readFileSync(SRS, "utf-8"));
  assert.deepEqual(raw.交付物.条目集合.filter((one: any) => "平台集合" in one), [{ 平台集合: "问题" }]);
  assert.ok(!raw.交付物.条目集合.some((one: any) => one.名称 === "问题") && !("问题" in raw.完成条件));
  const definition = validateDefinition(raw);
  assert.deepEqual(definition.collections.map((one) => one.name), ["功能用例", "非功能需求", "约束", "问题", "业务说明"]);
  assert.deepEqual(definition.completion.问题, ["没有状态为未解决的条目"]);
  // 建任务：用一份只写了占位的小定义（产品自带的那一份要带规则文件，这里不搬）。
  const dir = makeWorkspace(minimal([page, { 平台集合: "问题" }], { 页: ["每个条目用户确认"] }));
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const onDisk = JSON.parse(readFileSync(join(dir, DEFINITION_PATH), "utf-8"));
  assert.deepEqual(onDisk.交付物.条目集合.map((one: any) => one.名称), ["页", "问题"]);
  const db = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    assert.deepEqual(JSON.parse((db.prepare("SELECT definition_text FROM task").get() as { definition_text: string }).definition_text), onDisk);
  } finally {
    db.close();
  }
});
