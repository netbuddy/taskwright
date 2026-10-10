/**
 * 工作的阶段里不读库的那几样（src/lib/stage.ts）：五个阶段的名字与次序、谁能从哪里移到哪里、每个阶段助手能写什么与被拦时的原话。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTINUE_CLARIFY_KEY, NO_STAGES_TEXT, STAGES, STAGE_NAMES, START_ITEMS_KEY, type Stage, canWrite, completeRefusal, defaultStage, diagramRefusal,
  isStage, itemRefusal, judgeMove, moveText, pageRefusal, reviewRefusal, stageByName,
} from "../src/lib/stage.ts";

test("五个阶段：次序、给人看的名字、由名字认回来；没有记录时有材料先核读、没有材料从澄清开始", () => {
  assert.deepEqual([...STAGES], ["reading", "clarifying", "modeling", "writing", "reviewing"]);
  assert.deepEqual(STAGES.map((one) => STAGE_NAMES[one]), ["核读材料", "澄清", "整理建模", "写条目", "评审确认"]);
  assert.deepEqual(["核读材料", " 澄清 ", "整理建模", "写条目", "评审确认"].map(stageByName), [...STAGES]);
  assert.deepEqual([stageByName("writing"), stageByName("发布"), stageByName(""), stageByName(3)], ["writing", null, null, null]);
  assert.deepEqual([isStage("modeling"), isStage("澄清"), isStage(null)], [true, false, false]);
  assert.deepEqual([defaultStage(true), defaultStage(false)], ["reading", "clarifying"]);
});

test("移动：助手往后一次移一段、进入写条目只能由用户、可以退回前面任何阶段；用户不设限；原地不动不算移动", () => {
  const verdict = (from: Stage, to: Stage, actor: "executor" | "user") => {
    const one = judgeMove(from, to, actor);
    return one.ok ? "ok" : one.why;
  };
  // 助手：二十五格逐格对。
  const expected: Record<Stage, string[]> = {
    //            到核读      到澄清   到整理建模    到写条目      到评审确认
    reading:    ["same",     "ok",    "skip",      "user_only", "skip"],
    clarifying: ["ok",       "same",  "ok",        "user_only", "skip"],
    modeling:   ["ok",       "ok",    "same",      "user_only", "skip"],
    writing:    ["ok",       "ok",    "ok",        "same",      "ok"],
    reviewing:  ["ok",       "ok",    "ok",        "ok",        "same"],
  };
  for (const from of STAGES) assert.deepEqual(STAGES.map((to) => verdict(from, to, "executor")), expected[from], `助手从${STAGE_NAMES[from]}`);
  // 用户：除了原地不动，哪里都能去。
  for (const from of STAGES) assert.deepEqual(STAGES.map((to) => verdict(from, to, "user")), STAGES.map((to) => (to === from ? "same" : "ok")));
});

test("移动的说明：成功写从哪里到哪里；被退回时写明现在在哪个阶段、要先做什么、谁能移动", () => {
  const text = (from: Stage, to: Stage) => moveText(from, to, judgeMove(from, to, "executor"));
  assert.equal(text("reading", "clarifying"), "任务已从核读材料移到澄清。");
  assert.equal(text("writing", "clarifying"), "任务已从写条目移到澄清。");
  assert.equal(text("clarifying", "clarifying"), "任务本来就在澄清阶段，没有记移动。");
  assert.equal(text("modeling", "writing"),
    "阶段没有移动：进入写条目要由用户决定。请用请选择卡片提议，两个选项的键与文字是 start_items「开始写条目」、continue_clarify「继续澄清」。");
  assert.equal(text("reading", "modeling"), "阶段没有移动：任务现在在核读材料阶段，一次只能往后移一段，请先移到澄清。");
  assert.equal(text("clarifying", "writing"), text("modeling", "writing"));
  assert.equal(text("reading", "writing"), text("modeling", "writing"));
  assert.match(text("clarifying", "reviewing"), /^阶段没有移动：任务现在在澄清阶段，评审确认要先经过写条目，进入写条目要由用户决定。请用请选择卡片提议/);
  assert.match(text("modeling", "reviewing"), /^阶段没有移动：任务现在在整理建模阶段，评审确认要先经过写条目/);
  assert.equal(NO_STAGES_TEXT, "阶段没有移动：这个任务没有阶段，不要写 stage。");
  assert.deepEqual([START_ITEMS_KEY, CONTINUE_CLARIFY_KEY], ["start_items", "continue_clarify"]);
});

test("每个阶段助手能写什么：页与问题一直可以，图从整理建模起，别的集合的条目与请求评审从写条目起，完成任务只在评审确认", () => {
  const row = (stage: Stage) => (["page", "problem", "diagram", "item", "review", "complete"] as const).map((kind) => canWrite(stage, kind));
  assert.deepEqual(row("reading"), [true, true, false, false, false, false]);
  assert.deepEqual(row("clarifying"), [true, true, false, false, false, false]);
  assert.deepEqual(row("modeling"), [true, true, true, false, false, false]);
  assert.deepEqual(row("writing"), [true, true, true, true, true, false]);
  assert.deepEqual(row("reviewing"), [true, true, true, true, true, true]);
});

test("被拦时的原话：事实写现在在哪个阶段、拦下的是什么；怎么办写这一步要先做什么、谁能移动", () => {
  assert.deepEqual(itemRefusal("clarifying", "add", "功能用例"), [
    "任务现在在澄清阶段，这个阶段不能新增「功能用例」的条目",
    "「功能用例」的条目要到写条目阶段才能写。进入写条目要由用户在卡片上选「开始写条目」：你可以先立页、请用户看，觉得理解够了就用请选择卡片提议",
  ]);
  assert.match(itemRefusal("reading", "update", "约束")![0], /^任务现在在核读材料阶段，这个阶段不能修改「约束」的条目$/);
  assert.match(itemRefusal("reading", "update", "约束")![1], /现在还在核读材料，读完先在回复里移到澄清/);
  assert.match(itemRefusal("modeling", "delete", "非功能需求")![0], /不能删除「非功能需求」的条目$/);
  assert.deepEqual([itemRefusal("writing", "add", "功能用例"), itemRefusal("reviewing", "delete", "功能用例")], [null, null]);

  assert.match(diagramRefusal("reading")![0], /^任务现在在核读材料阶段，这个阶段不能画图、改图或删图$/);
  assert.match(diagramRefusal("reading")![1], /先在回复里把任务移到澄清/);
  assert.match(diagramRefusal("clarifying")![1], /在回复里把任务移到整理建模$/);
  assert.deepEqual([diagramRefusal("modeling"), diagramRefusal("writing"), diagramRefusal("reviewing")], [null, null, null]);

  for (const stage of ["reading", "clarifying", "modeling"] as const) {
    assert.equal(reviewRefusal(stage)![0], `任务现在在${STAGE_NAMES[stage]}阶段，评审要到写条目阶段才能请求`);
    assert.match(reviewRefusal(stage)![1], /^条目写出来之后再评审。进入写条目要由用户在卡片上选「开始写条目」/);
  }
  assert.deepEqual([reviewRefusal("writing"), reviewRefusal("reviewing")], [null, null]);

  assert.deepEqual(completeRefusal("writing"), ["任务现在在写条目阶段，完成任务要在评审确认阶段", "条目写完之后，在回复里把任务移到评审确认，再完成任务"]);
  assert.match(completeRefusal("clarifying")![1], /^要先写条目、再移到评审确认，才能完成任务。进入写条目要由用户在卡片上选「开始写条目」/);
  assert.equal(completeRefusal("reviewing"), null);
});

test("总体分析的页：前四个阶段随便写；评审确认阶段只能改状态与改看，不能新立、不能删", () => {
  for (const stage of ["reading", "clarifying", "modeling", "writing"] as const) {
    assert.deepEqual([pageRefusal(stage, "add"), pageRefusal(stage, "update", ["它是什么"]), pageRefusal(stage, "delete")], [null, null, null]);
  }
  assert.deepEqual(pageRefusal("reviewing", "add"), ["任务现在在评审确认阶段，这个阶段不能新立主题页", "要动主题页的内容，先在回复里把任务移回澄清或整理建模"]);
  assert.equal(pageRefusal("reviewing", "delete")![0], "任务现在在评审确认阶段，这个阶段不能删除主题页");
  assert.deepEqual([pageRefusal("reviewing", "update", ["状态"]), pageRefusal("reviewing", "update", ["状态", "改看"]), pageRefusal("reviewing", "update", [])], [null, null, null]);
  assert.equal(pageRefusal("reviewing", "update", ["状态", "它是什么", "例子"])![0],
    "任务现在在评审确认阶段，这个阶段主题页只能改「状态」与「改看」，这次还改了「它是什么」、「例子」");
});
