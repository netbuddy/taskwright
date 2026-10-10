/**
 * 「回复」工具交给模型看的参数说明里的几句话（tools/reply.ts）：哪种回应用在什么时候、提议的 preview 什么时候写、
 * 移动工作阶段的两项怎么用。模型只看得到这些说明，所以改它们要有意为之。
 * 工具文件依赖随 pi 一起装的包，单元测试里导入不了，所以这里读源文件的文字来核对。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/** 源文件里相邻的字符串字面量是用加号接起来的，核对之前先接成连续的文字。 */
const SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "tools", "reply.ts"), "utf-8").replace(/"\s*\+\s*\n\s*"/g, "");

test("kind 的说明写明是非题用请选择、征求同意用提议、提问只给开放问题；preview 不只在改条目时才写", () => {
  assert.ok(SOURCE.includes("propose 是提议下一步怎么做。必须写。是非题用 choose（把答案写成选项）、征求同意或下一步怎么做用 propose、ask 只给用户要自己说出内容的开放问题。"));
  assert.ok(SOURCE.includes("effect 是 remove、add、change 之一。做下去会改动条目时写，撤掉或大改时必须写。"));
  assert.equal(SOURCE.includes("提议会撤掉条目或大改条目时必须写"), false);
});

test("stage 与 reason 的说明写明五个阶段名、自己只能退回前面的阶段、往前要用卡片提议", () => {
  assert.ok(SOURCE.includes("写阶段的名字，「核读材料」「澄清」「整理建模」「写条目」「评审确认」之一。"));
  assert.ok(SOURCE.includes("你自己只能把任务退回前面的阶段（例如整理时发现一个词没说清，退回澄清）。"));
  assert.ok(SOURCE.includes("往前进入下一个阶段要由用户在卡片上点：这时不要写 stage，改用请选择卡片提议，说清下一段要做什么。"));
  assert.ok(SOURCE.includes("写了 stage 时必须写：一句话，说明为什么现在退回这个阶段。"));
});
