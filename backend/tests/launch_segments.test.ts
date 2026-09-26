// 启动配置里「材料分段」一节：TypeScript 版读取的结果与 Python 版相同（缺项用默认值、写错时报清楚），参数经环境变量交给 pi 里的扩展。

import assert from "node:assert/strict";
import { test } from "node:test";
import { LaunchError, buildEnvironment, loadProfile, segmentParamsOf } from "../src/launch.ts";
import { SEGMENTS_ENV, SEGMENT_DEFAULTS } from "../../agent/src/lib/segments.ts";

test("两份启动配置的材料分段参数等于默认值，白名单里有 grep 与 find", () => {
  for (const name of ["dev", "fake"]) {
    const profile = loadProfile(name);
    assert.deepEqual(segmentParamsOf(profile), SEGMENT_DEFAULTS);
    assert.ok(profile.tools.includes("grep") && profile.tools.includes("find"), name);
  }
});

test("缺项用默认值，写错时报清楚，环境变量与 Python 版写法相同", () => {
  assert.deepEqual(segmentParamsOf({}), SEGMENT_DEFAULTS);
  assert.deepEqual(segmentParamsOf({ 材料分段: { max_paragraphs: 120 } }), { ...SEGMENT_DEFAULTS, max_paragraphs: 120 });
  for (const bad of [0, -1, 2.5, "3", true]) {
    assert.throws(() => segmentParamsOf({ 材料分段: { heading_depth: bad } }),
      (e: unknown) => e instanceof LaunchError && (e as Error).message.includes("heading_depth 应当是正整数"));
  }
  const env = buildEnvironment({ 材料分段: { min_paragraphs: 1 } });
  assert.equal(env[SEGMENTS_ENV], '{"heading_depth":3,"max_paragraphs":300,"min_paragraphs":1}');
});
