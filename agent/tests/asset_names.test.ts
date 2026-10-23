/**
 * 资产显示名由任务定义给（lib/assets.ts 的读法、lib/asset_names.ts 的取用与回退）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { assetNamesOf } from "../src/lib/asset_names.ts";
import { parseAssetNames } from "../src/lib/assets.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateDefinition, withPlatformCollections } from "../src/lib/definition.ts";

/** 产品自带的需求工程任务定义，问题集合的占位已经补全。 */
const SRS_DEFINITION = JSON.stringify(withPlatformCollections(JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "task-types", "requirements-engineering", "docs",
  "task-definitions", "requirements-engineering.json"), "utf-8"))).raw);

const SRS_NAMES = { materials: "输入资料", description: "业务说明", models: "分析模型", items: "需求条目", review: "评审与确认", versions: "文档与版本" };

test("资产显示名的读法：六个键各一段文字，不多不少；去掉两头空白", () => {
  assert.deepEqual(parseAssetNames({ ...SRS_NAMES, items: " 需求条目 " }), SRS_NAMES);
  for (const bad of [null, [], "业务说明", { ...SRS_NAMES, items: "" }, { ...SRS_NAMES, extra: "多的" }, { materials: "材料" }]) {
    assert.equal(parseAssetNames(bad), null, JSON.stringify(bad));
  }
});

test("任务定义里写了资产显示名就用它；写错了定义校验不过；没写是 null", () => {
  const raw = JSON.parse(SRS_DEFINITION) as Record<string, unknown>;
  const given = validateDefinition(raw);
  assert.deepEqual(given.assetNames, SRS_NAMES);
  assert.deepEqual(assetNamesOf(given), SRS_NAMES);
  const other = { ...SRS_NAMES, items: "要求" };
  assert.deepEqual(assetNamesOf(validateDefinition({ ...raw, 资产显示名: other })), other);
  assert.throws(() => validateDefinition({ ...raw, 资产显示名: { materials: "材料" } }), /「资产显示名」是可选项/);
  const { 资产显示名: _dropped, ...older } = raw;
  assert.equal(validateDefinition(older).assetNames, null);
});

test("早先的任务定义没有资产显示名：回退读产品自带的、任务名相同的那份；任务名对不上取第一份；不给定义也取第一份", () => {
  const raw = JSON.parse(SRS_DEFINITION) as Record<string, unknown>;
  const { 资产显示名: _dropped, ...older } = raw;
  assert.deepEqual(assetNamesOf(validateDefinition(older)), SRS_NAMES);
  assert.deepEqual(assetNamesOf({ taskName: "别的任务", assetNames: null }), SRS_NAMES);
  assert.deepEqual(assetNamesOf(null), SRS_NAMES);
});
