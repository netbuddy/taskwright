/**
 * 工作的阶段里不读库的那几样（src/lib/stage.ts）：五个阶段的名字与次序、谁能从哪里移到哪里、每个阶段助手能写什么与被拦时的原话。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backCardGuidance, canWrite, completeRefusal, CONTINUE_CLARIFY_KEY, defaultStage, diagramRefusal, ENTER_OPTIONS, forwardCardGuidance, isStage, itemRefusal, judgeMove, nextStage, pageRefusal, reviewRefusal, type Stage, STAGE_NAMES, stageByName, stageEnteredBy, STAGES, START_ITEMS_KEY, STAY_OPTIONS,
} from "../src/lib/stage.ts";

test("六个阶段：次序、给人看的名字、由名字认回来；没有记录时有材料先核读、没有材料从澄清开始", () => {
  assert.deepEqual([...STAGES], ["reading", "clarifying", "modeling", "writing", "reviewing", "document"]);
  assert.deepEqual(STAGES.map((one) => STAGE_NAMES[one]), ["核读材料", "澄清", "整理建模", "写条目", "评审确认", "编写文档"]);
  assert.deepEqual(["核读材料", " 澄清 ", "整理建模", "写条目", "评审确认", "编写文档"].map(stageByName), [...STAGES]);
  assert.deepEqual([stageByName("writing"), stageByName("发布"), stageByName(""), stageByName(3)], ["writing", null, null, null]);
  assert.deepEqual([isStage("modeling"), isStage("澄清"), isStage(null)], [true, false, false]);
  assert.deepEqual([defaultStage(true), defaultStage(false)], ["reading", "clarifying"]);
});

test("移动：助手一律不能自己移动阶段，往前、往后都要由用户决定；用户不设限；原地不动不算移动", () => {
  const verdict = (from: Stage, to: Stage, actor: "executor" | "user") => {
    const one = judgeMove(from, to, actor);
    return one.ok ? "ok" : one.why;
  };
  // 助手：三十六格里除了原地不动，都是「要由用户决定」。
  for (const from of STAGES) assert.deepEqual(STAGES.map((to) => verdict(from, to, "executor")), STAGES.map((to) => (to === from ? "same" : "user_only")), `助手从${STAGE_NAMES[from]}`);
  // 用户：除了原地不动，哪里都能去。
  for (const from of STAGES) assert.deepEqual(STAGES.map((to) => verdict(from, to, "user")), STAGES.map((to) => (to === from ? "same" : "ok")));
});

test("提议的卡片怎样写：往前一段一张、两个选项的键与文字固定；退回的卡片写明原因，第二项是「留在本段」", () => {
  assert.equal(forwardCardGuidance("reading"), "请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 enter_clarify「进入澄清」、continue_reading「继续本阶段」");
  assert.equal(forwardCardGuidance("clarifying"), "请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 enter_consolidate「进入整理建模」、continue_clarify「继续本阶段」");
  assert.equal(forwardCardGuidance("modeling"), "请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 start_items「开始写条目」、continue_consolidate「继续本阶段」");
  assert.equal(forwardCardGuidance("writing"), "请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 enter_review「进入评审确认」、continue_writing「继续本阶段」");
  assert.equal(forwardCardGuidance("reviewing"), "请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 enter_document「进入编写文档」、continue_review「继续本阶段」");
  assert.equal(backCardGuidance("clarifying"), "请用请选择卡片提议，在问句里写明为什么要退回，两个选项的键与文字是 back_to_clarify「退回澄清」、stay_in_stage「留在本段」");
  assert.equal(backCardGuidance("reviewing"), "请用请选择卡片提议，在问句里写明为什么要退回，两个选项的键与文字是 back_to_review「退回评审确认」、stay_in_stage「留在本段」");
  assert.deepEqual([START_ITEMS_KEY, CONTINUE_CLARIFY_KEY], ["start_items", "continue_clarify"]);
  // 五张卡片的两个选项：进入下一段的键与文字，留在这一段的键与文字。
  assert.deepEqual(ENTER_OPTIONS, { clarifying: { key: "enter_clarify", text: "进入澄清" }, modeling: { key: "enter_consolidate", text: "进入整理建模" },
    writing: { key: "start_items", text: "开始写条目" }, reviewing: { key: "enter_review", text: "进入评审确认" }, document: { key: "enter_document", text: "进入编写文档" } });
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
  const leave = (back: "reviewing" | "modeling") => `编写文档阶段只补写主题页的文字。要做这件事，得先回到${STAGE_NAMES[back]}：${backCardGuidance(back)}，由用户在卡片上点`;
  assert.deepEqual(itemRefusal("document", "update", "功能用例"), ["任务现在在编写文档阶段，这个阶段不能修改「功能用例」的条目", leave("reviewing")]);
  assert.deepEqual(diagramRefusal("document"), ["任务现在在编写文档阶段，这个阶段不能画图、改图或删图", leave("modeling")]);
  assert.deepEqual(reviewRefusal("document"), ["任务现在在编写文档阶段，这个阶段不能请求评审", leave("reviewing")]);
  assert.equal(leave("reviewing"), "编写文档阶段只补写主题页的文字。要做这件事，得先回到评审确认：请用请选择卡片提议，在问句里写明为什么要退回，两个选项的键与文字是 back_to_review「退回评审确认」、stay_in_stage「留在本段」，由用户在卡片上点");
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
  assert.deepEqual(pageRefusal("reviewing", "add"), ["任务现在在评审确认阶段，这个阶段不能新立主题页", "要动主题页的内容，得先回到澄清或整理建模：请用请选择卡片提议，在问句里写明为什么要退回，两个选项的键与文字是 back_to_clarify「退回澄清」、stay_in_stage「留在本段」，由用户在卡片上点"]);
  assert.equal(pageRefusal("reviewing", "delete")![0], "任务现在在评审确认阶段，这个阶段不能删除主题页");
  assert.deepEqual([pageRefusal("reviewing", "update", ["状态"]), pageRefusal("reviewing", "update", ["状态", "改看"]), pageRefusal("reviewing", "update", [])], [null, null, null]);
  assert.equal(pageRefusal("reviewing", "update", ["状态", "它是什么", "例子"])![0],
    "任务现在在评审确认阶段，这个阶段主题页只能改「状态」与「改看」，这次还改了「它是什么」、「例子」");
});
