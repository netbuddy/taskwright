/**
 * 请求评审按工作阶段守门（lib/review.ts 的 prepareReviews）：助手要到写条目阶段才能请求评审。
 * 用户在页面上发起的评审不看阶段；早先建的任务没有阶段。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { prepareReviews } from "../src/lib/review.ts";
import { STAGES, STAGE_NAMES } from "../src/lib/stage.ts";
import { rejectionOf } from "../src/lib/tool_rejection.ts";
import { DEFINITION_PATH, callIn, demoDefinition, enterStage, makeWorkspace, overallDefinition } from "./helpers.ts";

function workspace(definition: unknown = overallDefinition()): string {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
/**
 * 请求评审（不点名条目）被阶段拦下时的两层文字；没有被阶段拦下返回 null。这里的任务里一个条目都没有，过了阶段这一关之后
 * 评审照样做不成（没有需要评审的条目），那是另一条原因，不算被阶段拦下。
 */
function refusal(dir: string, by?: "executor" | "user"): { fact: string; guidance: string; message: string } | null {
  try {
    prepareReviews(dir, null, by);
  } catch (error) {
    const layers = rejectionOf(error)!;
    if (layers.fact.startsWith("任务现在在")) return { fact: layers.fact, guidance: layers.guidance, message: (error as Error).message };
    assert.match((error as Error).message, /^没有需要评审的条目/);
  }
  return null;
}

test("助手请求评审：核读材料、澄清、整理建模三个阶段被拦；写条目与评审确认阶段可以；编写文档阶段被拦，指引是提议退回评审确认", () => {
  const dir = workspace();
  for (const stage of STAGES) {
    enterStage(dir, stage);
    const out = refusal(dir, "executor");
    if (stage === "writing" || stage === "reviewing") {
      assert.equal(out, null, STAGE_NAMES[stage]);
      continue;
    }
    if (stage === "document") {
      assert.equal(out!.fact, "任务现在在编写文档阶段，这个阶段不能请求评审");
      assert.equal(out!.guidance, "编写文档阶段只补写主题页的文字。要做这件事，得先回到评审确认：请用请选择卡片提议，在问句里写明为什么要退回，" +
        "两个选项的键与文字是 back_to_review「退回评审确认」、stay_in_stage「留在本段」，由用户在卡片上点");
      continue;
    }
    assert.equal(out!.fact, `任务现在在${STAGE_NAMES[stage]}阶段，评审要到写条目阶段才能请求`);
    assert.match(out!.guidance, /^条目写出来之后再评审。进入写条目要由用户在卡片上选「开始写条目」/);
    assert.equal(out!.message, `什么都没有评：${out!.fact}。\n怎么办：${out!.guidance}。`);
  }
});

test("刚建好、有材料的任务在核读材料：助手请求评审被拦；用户在页面上发起的不看阶段", () => {
  const dir = workspace();
  assert.match(refusal(dir, "executor")!.fact, /^任务现在在核读材料阶段/);
  assert.equal(refusal(dir, "user"), null);
  // 不写第三个参数时按用户算：页面那条路照旧。
  assert.equal(refusal(dir), null);
});

test("早先建的任务没有阶段：助手照旧可以请求评审", () => {
  const dir = workspace(demoDefinition());
  assert.equal(refusal(dir, "executor"), null);
});
