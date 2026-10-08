// 启动配置里「材料分段」一节：读取的结果（缺项用默认值、写错时报清楚），参数经环境变量交给 pi 里的扩展。

import assert from "node:assert/strict";
import { test } from "node:test";
import { LaunchError, PDF_RUN_DEFAULTS, buildEnvironment, loadProfile, pdfLimitsOf, segmentParamsOf } from "../src/launch.ts";
import { SEGMENTS_ENV, SEGMENT_DEFAULTS } from "../../agent/src/lib/segments.ts";

test("两份启动配置的材料分段参数等于默认值，白名单里有 grep 与 find", () => {
  for (const name of ["dev", "fake"]) {
    const profile = loadProfile(name);
    assert.deepEqual(segmentParamsOf(profile), SEGMENT_DEFAULTS);
    assert.ok(profile.tools.includes("grep") && profile.tools.includes("find"), name);
  }
});

test("缺项用默认值，写错时报清楚，环境变量的写法", () => {
  assert.deepEqual(segmentParamsOf({}), SEGMENT_DEFAULTS);
  assert.deepEqual(segmentParamsOf({ 材料分段: { max_paragraphs: 120 } }), { ...SEGMENT_DEFAULTS, max_paragraphs: 120 });
  for (const bad of [0, -1, 2.5, "3", true]) {
    assert.throws(() => segmentParamsOf({ 材料分段: { heading_depth: bad } }),
      (e: unknown) => e instanceof LaunchError && (e as Error).message.includes("heading_depth 应当是正整数"));
  }
  const env = buildEnvironment({ 材料分段: { min_paragraphs: 1 } });
  assert.equal(env[SEGMENTS_ENV], '{"heading_depth":3,"max_paragraphs":300,"min_paragraphs":1}');
});

test("启动配置「PDF 解析」一节：三份配置写的都等于缺省值；缺项用缺省值，写错时报清楚", () => {
  assert.deepEqual(PDF_RUN_DEFAULTS, { max_pages: 1000, max_chars: 3_000_000, max_seconds: 60, stop_after_seconds: 75 });
  for (const name of ["dev", "fake", "desktop"]) assert.deepEqual(pdfLimitsOf(loadProfile(name)), PDF_RUN_DEFAULTS, name);
  assert.deepEqual(pdfLimitsOf({}), PDF_RUN_DEFAULTS);
  assert.deepEqual(pdfLimitsOf({ "PDF 解析": { max_pages: 200, stop_after_seconds: 0.5 } }), { ...PDF_RUN_DEFAULTS, max_pages: 200, stop_after_seconds: 0.5 });
  for (const [name, bad, word] of [["max_pages", 2.5, "正整数"], ["max_chars", 0, "正整数"], ["max_seconds", -1, "正数"], ["stop_after_seconds", "75", "正数"]] as const) {
    assert.throws(() => pdfLimitsOf({ "PDF 解析": { [name]: bad } }),
      (e: unknown) => e instanceof LaunchError && (e as Error).message === `启动配置「PDF 解析」一节的 ${name} 应当是${word}，现在写的是 ${JSON.stringify(bad)}。`);
  }
});
