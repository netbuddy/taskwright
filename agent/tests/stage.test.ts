/**
 * 工作的阶段里不读库的那几样（src/lib/stage.ts）：五个阶段的名字与次序、谁能从哪里移到哪里、每个阶段助手能写什么与被拦时的原话。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canWrite, completeRefusal, CONTINUE_CLARIFY_KEY, defaultStage, diagramRefusal, ENTER_OPTIONS, forwardCardGuidance, isStage, itemRefusal, judgeMove, moveText, nextStage, NO_STAGES_TEXT, pageRefusal, reviewRefusal, type Stage, STAGE_NAMES, stageByName, stageEnteredBy, STAGES, START_ITEMS_KEY, STAY_OPTIONS,
} from "../src/lib/stage.ts";

test("六个阶段：次序、给人看的名字、由名字认回来；没有记录时有材料先核读、没有材料从澄清开始", () => {
  assert.deepEqual([...STAGES], ["reading", "clarifying", "modeling", "writing", "reviewing", "document"]);
  assert.deepEqual(STAGES.map((one) => STAGE_NAMES[one]), ["核读材料", "澄清", "整理建模", "写条目", "评审确认", "编写文档"]);
  assert.deepEqual(["核读材料", " 澄清 ", "整理建模", "写条目", "评审确认", "编写文档"].map(stageByName), [...STAGES]);
  assert.deepEqual([stageByName("writing"), stageByName("发布"), stageByName(""), stageByName(3)], ["writing", null, null, null]);
  assert.deepEqual([isStage("modeling"), isStage("澄清"), isStage(null)], [true, false, false]);
  assert.deepEqual([defaultStage(true), defaultStage(false)], ["reading", "clarifying"]);
});

test("移动：助手只能退回前面的阶段，往前一律要由用户在卡片上点；用户不设限；原地不动不算移动", () => {
  const verdict = (from: Stage, to: Stage, actor: "executor" | "user") => {
    const one = judgeMove(from, to, actor);
    return one.ok ? "ok" : one.why;
  };
  // 助手：三十六格逐格对。
  const expected: Record<Stage, string[]> = {
    //            到核读      到澄清   到整理建模    到写条目      到评审确认    到编写文档
    reading:    ["same",     "user_only", "user_only", "user_only", "user_only", "user_only"],
    clarifying: ["ok",       "same",      "user_only", "user_only", "user_only", "user_only"],
    modeling:   ["ok",       "ok",        "same",      "user_only", "user_only", "user_only"],
    writing:    ["ok",       "ok",        "ok",        "same",      "user_only", "user_only"],
    reviewing:  ["ok",       "ok",        "ok",        "ok",        "same",      "user_only"],
    document:   ["ok",       "ok",        "ok",        "ok",        "ok",        "same"],
  };
  for (const from of STAGES) assert.deepEqual(STAGES.map((to) => verdict(from, to, "executor")), expected[from], `助手从${STAGE_NAMES[from]}`);
  // 用户：除了原地不动，哪里都能去。
  for (const from of STAGES) assert.deepEqual(STAGES.map((to) => verdict(from, to, "user")), STAGES.map((to) => (to === from ? "same" : "ok")));
});

test("移动的说明：成功写从哪里到哪里；被退回时写明现在在哪个阶段、要先做什么、谁能移动", () => {
  const text = (from: Stage, to: Stage) => moveText(from, to, judgeMove(from, to, "executor"));
  assert.equal(text("writing", "clarifying"), "任务已从写条目移到澄清。");
  assert.equal(text("reviewing", "reading"), "任务已从评审确认移到核读材料。");
  assert.equal(text("clarifying", "clarifying"), "任务本来就在澄清阶段，没有记移动。");
  // 往前一段：告诉助手用哪张卡片，两个选项怎样写。
  assert.equal(text("reading", "clarifying"),
    "阶段没有移动：往前移动要由用户在卡片上点。请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 enter_clarify「进入澄清」、continue_reading「继续本阶段」。");
  assert.equal(text("clarifying", "modeling"),
    "阶段没有移动：往前移动要由用户在卡片上点。请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 enter_consolidate「进入整理建模」、continue_clarify「继续本阶段」。");
  assert.equal(text("modeling", "writing"),
    "阶段没有移动：往前移动要由用户在卡片上点。请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 start_items「开始写条目」、continue_consolidate「继续本阶段」。");
  assert.equal(text("writing", "reviewing"),
    "阶段没有移动：往前移动要由用户在卡片上点。请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 enter_review「进入评审确认」、continue_writing「继续本阶段」。");
  // 往前不止一段：另说明一次只进入下一段，卡片仍是进入下一段的那一张。
  assert.equal(text("reading", "modeling"),
    "阶段没有移动：往前移动要由用户在卡片上点。一次只进入下一段，核读材料的下一段是澄清。请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 enter_clarify「进入澄清」、continue_reading「继续本阶段」。");
  assert.match(text("clarifying", "reviewing"), /^阶段没有移动：往前移动要由用户在卡片上点。一次只进入下一段，澄清的下一段是整理建模。请用请选择卡片提议/);
  assert.equal(NO_STAGES_TEXT, "阶段没有移动：这个任务没有阶段，不要写 stage。");
  assert.deepEqual([START_ITEMS_KEY, CONTINUE_CLARIFY_KEY], ["start_items", "continue_clarify"]);
  // 五张卡片的两个选项：进入下一段的键与文字，留在这一段的键与文字。
  assert.deepEqual(ENTER_OPTIONS, { clarifying: { key: "enter_clarify", text: "进入澄清" }, modeling: { key: "enter_consolidate", text: "进入整理建模" },
    writing: { key: "start_items", text: "开始写条目" }, reviewing: { key: "enter_review", text: "进入评审确认" }, document: { key: "enter_document", text: "进入编写文档" } });
  assert.equal(text("reviewing", "document"),
    "阶段没有移动：往前移动要由用户在卡片上点。请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 enter_document「进入编写文档」、continue_review「继续本阶段」。");
  assert.deepEqual(STAY_OPTIONS, { reading: { key: "continue_reading", text: "继续本阶段" }, clarifying: { key: "continue_clarify", text: "继续本阶段" },
    modeling: { key: "continue_consolidate", text: "继续本阶段" }, writing: { key: "continue_writing", text: "继续本阶段" },
    reviewing: { key: "continue_review", text: "继续本阶段" } });
  assert.deepEqual(["enter_clarify", "enter_consolidate", "start_items", "enter_review", "enter_document", "continue_clarify", "别的键", null].map(stageEnteredBy),
    ["clarifying", "modeling", "writing", "reviewing", "document", null, null, null]);
  assert.deepEqual(STAGES.map(nextStage), ["clarifying", "modeling", "writing", "reviewing", "document", null]);
  // 编写文档是最后一段，没有往前的卡片。
  assert.equal(forwardCardGuidance("document"), "");
});

test("每个阶段助手能写什么：页与问题一直可以，图从整理建模起，别的集合的条目与请求评审从写条目起，完成任务在评审确认与编写文档；编写文档只写页与问题", () => {
  const row = (stage: Stage) => (["page", "problem", "diagram", "item", "review", "complete"] as const).map((kind) => canWrite(stage, kind));
  assert.deepEqual(row("reading"), [true, true, false, false, false, false]);
  assert.deepEqual(row("clarifying"), [true, true, false, false, false, false]);
  assert.deepEqual(row("modeling"), [true, true, true, false, false, false]);
  assert.deepEqual(row("writing"), [true, true, true, true, true, false]);
  assert.deepEqual(row("reviewing"), [true, true, true, true, true, true]);
  // 编写文档排在最后，却不能画图、不能写条目、不能请求评审：守门表一个阶段一个阶段列，不按先后推。
  assert.deepEqual(row("document"), [true, true, false, false, false, true]);
  const leave = (back: string) => `编写文档阶段只补写主题页的文字。要做这件事，先用请选择卡片提议退回${back}并写明原因，由用户在卡片上点`;
  assert.deepEqual(itemRefusal("document", "update", "功能用例"), ["任务现在在编写文档阶段，这个阶段不能修改「功能用例」的条目", leave("评审确认")]);
  assert.deepEqual(diagramRefusal("document"), ["任务现在在编写文档阶段，这个阶段不能画图、改图或删图", leave("整理建模")]);
  assert.deepEqual(reviewRefusal("document"), ["任务现在在编写文档阶段，这个阶段不能请求评审", leave("评审确认")]);
  assert.deepEqual([completeRefusal("document"), completeRefusal("reviewing"), pageRefusal("document", "add"), pageRefusal("document", "update", ["它是什么"])], [null, null, null, null]);
});

test("被拦时的原话：事实写现在在哪个阶段、拦下的是什么；怎么办写这一步要先做什么、谁能移动", () => {
  assert.deepEqual(itemRefusal("clarifying", "add", "功能用例"), [
    "任务现在在澄清阶段，这个阶段不能新增「功能用例」的条目",
    "「功能用例」的条目要到写条目阶段才能写。进入写条目要由用户在卡片上选「开始写条目」：你可以先立页、请用户看，觉得理解够了就用请选择卡片提议",
  ]);
  assert.match(itemRefusal("reading", "update", "约束")![0], /^任务现在在核读材料阶段，这个阶段不能修改「约束」的条目$/);
  assert.equal(itemRefusal("reading", "update", "约束")![1], itemRefusal("clarifying", "update", "约束")![1]);
  assert.match(itemRefusal("modeling", "delete", "非功能需求")![0], /不能删除「非功能需求」的条目$/);
  assert.deepEqual([itemRefusal("writing", "add", "功能用例"), itemRefusal("reviewing", "delete", "功能用例")], [null, null]);

  assert.match(diagramRefusal("reading")![0], /^任务现在在核读材料阶段，这个阶段不能画图、改图或删图$/);
  // 怎样走到整理建模：往前由用户在卡片上点，助手只能发卡片提议；指引里没有「在回复里把任务移到」这种说法。
  assert.match(diagramRefusal("reading")![1], /往前进入下一段要由用户在卡片上点，你只能提议：材料读完之后先提议进入澄清，请用请选择卡片提议/);
  assert.match(diagramRefusal("reading")![1], /enter_clarify「进入澄清」、continue_reading「继续本阶段」；澄清告一段落之后，再照同样的办法提议「进入整理建模」$/);
  assert.match(diagramRefusal("clarifying")![1], /进入整理建模要由用户在卡片上选「进入整理建模」，你只能提议：澄清告一段落之后，请用请选择卡片提议/);
  assert.match(diagramRefusal("clarifying")![1], /enter_consolidate「进入整理建模」、continue_clarify「继续本阶段」$/);
  for (const stage of ["reading", "clarifying"] as const) assert.doesNotMatch(diagramRefusal(stage)![1], /在回复里把任务移到|自己移到/);
  assert.deepEqual([diagramRefusal("modeling"), diagramRefusal("writing"), diagramRefusal("reviewing")], [null, null, null]);

  for (const stage of ["reading", "clarifying", "modeling"] as const) {
    assert.equal(reviewRefusal(stage)![0], `任务现在在${STAGE_NAMES[stage]}阶段，评审要到写条目阶段才能请求`);
    assert.match(reviewRefusal(stage)![1], /^条目写出来之后再评审。进入写条目要由用户在卡片上选「开始写条目」/);
  }
  assert.deepEqual([reviewRefusal("writing"), reviewRefusal("reviewing")], [null, null]);

  assert.deepEqual(completeRefusal("writing"), ["任务现在在写条目阶段，完成任务要在评审确认阶段",
    "条目写完之后，要由用户在卡片上选「进入评审确认」进入评审确认，再完成任务。请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 enter_review「进入评审确认」、continue_writing「继续本阶段」"]);
  assert.match(completeRefusal("clarifying")![1], /^要先写条目、再由用户进入评审确认，才能完成任务。进入写条目要由用户在卡片上选「开始写条目」/);
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
