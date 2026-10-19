/**
 * 「回复」工具交给模型看的参数说明里的几句话（模板 agent/prompts/tools/reply.md）：哪种回应用在什么时候、提议的 preview 什么时候写、
 * 移动工作阶段的两项怎么用。模型只看得到这些说明，所以改它们要有意为之。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { templates } from "../src/lib/texts.ts";

/** 回复工具的全部说明文字，一段一行。 */
const SOURCE = [...templates().values()].filter((one) => one.key.startsWith("reply.")).map((one) => one.body).join("\n");

test("kind 的说明写明是非题用请选择、征求同意用提议、提问只给开放问题；preview 不只在改条目时才写", () => {
  assert.ok(SOURCE.includes("propose 是提议下一步怎么做。必须写。是非题用 choose（把答案写成选项）、征求同意或下一步怎么做用 propose、ask 只给用户要自己说出内容的开放问题。"));
  assert.ok(SOURCE.includes("effect 是 remove、add、change 之一。做下去会改动条目时写，撤掉或大改时必须写。"));
  assert.equal(SOURCE.includes("提议会撤掉条目或大改条目时必须写"), false);
});

test("回复的参数里没有 stage 与 reason：阶段的移动一律用卡片提议由用户点", () => {
  assert.ok(!templates().has("reply.param.stage") && !templates().has("reply.param.reason") && !templates().has("reply.stage_param_retired"));
  assert.ok(!SOURCE.includes("你自己只能把任务退回前面的阶段"));
});
