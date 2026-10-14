/**
 * 工作的阶段里不读库的那几样（src/lib/stage.ts）：五个阶段的名字与次序、谁能从哪里移到哪里、每个阶段助手能写什么与被拦时的原话。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityDoneSentence, activityStartSentence, backCardGuidance, canWrite, completeRefusal, flowStartNode, launchView, startReadingCardGuidance, STAY_IDLE_OPTION, workItemContinuedSentence, workItemDeletedSentence, flowExistsText, CONTINUE_CLARIFY_KEY, diagramRefusal, ENTER_OPTIONS, forwardCardGuidance, gateStage, IDLE, IDLE_NAME, isPosition, isStage,
  itemRefusal, judgeMove, nextStage, pageRefusal, positionName, reviewRefusal, type Stage, STAGE_NAMES, stageByName, stageEnteredBy, STAGES, START_ITEMS_KEY, STAY_OPTIONS,
} from "../src/lib/stage.ts";

test("六个阶段：次序、给人看的名字、由名字认回来", () => {
  assert.deepEqual([...STAGES], ["reading", "clarifying", "modeling", "writing", "reviewing", "document"]);
  assert.deepEqual(STAGES.map((one) => STAGE_NAMES[one]), ["核读材料", "澄清", "整理建模", "写条目", "评审确认", "编写文档"]);
  assert.deepEqual(["核读材料", " 澄清 ", "整理建模", "写条目", "评审确认", "编写文档"].map(stageByName), [...STAGES]);
  assert.deepEqual([stageByName("writing"), stageByName("发布"), stageByName(""), stageByName(3)], ["writing", null, null, null]);
  assert.deepEqual([isStage("modeling"), isStage("澄清"), isStage(null)], [true, false, false]);
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
  // 五张卡片的两个选项：进入下一段的键与文字，留在这一段的键与文字。核读材料的那一项只在任务空闲时用，另一项是「先不开始」。
  assert.deepEqual(ENTER_OPTIONS, { reading: { key: "enter_reading", text: "开始核读材料" },
    clarifying: { key: "enter_clarify", text: "进入澄清" }, modeling: { key: "enter_consolidate", text: "进入整理建模" },
    writing: { key: "start_items", text: "开始写条目" }, reviewing: { key: "enter_review", text: "进入评审确认" }, document: { key: "enter_document", text: "进入编写文档" } });
  assert.deepEqual(STAY_OPTIONS, { reading: { key: "continue_reading", text: "继续本阶段" }, clarifying: { key: "continue_clarify", text: "继续本阶段" },
    modeling: { key: "continue_consolidate", text: "继续本阶段" }, writing: { key: "continue_writing", text: "继续本阶段" },
    reviewing: { key: "continue_review", text: "继续本阶段" } });
  assert.deepEqual(["enter_clarify", "enter_consolidate", "start_items", "enter_review", "enter_document", "continue_clarify", "别的键", null].map(stageEnteredBy),
    ["clarifying", "modeling", "writing", "reviewing", "document", null, null, null]);
  assert.deepEqual([stageEnteredBy("enter_reading"), stageEnteredBy("stay_idle"), STAY_IDLE_OPTION], ["reading", null, { key: "stay_idle", text: "先不开始" }]);
  assert.equal(startReadingCardGuidance(), "请用请选择卡片提议，两个选项的键与文字是 enter_reading「开始核读材料」、stay_idle「先不开始」");
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

test("空闲：写法是 idle、名字是「空闲」，与六个阶段并列而不在次序里，也认不成阶段；按澄清的规矩办", () => {
  assert.deepEqual([IDLE, IDLE_NAME, positionName(IDLE), positionName("writing")], ["idle", "空闲", "空闲", "写条目"]);
  assert.deepEqual([(STAGES as readonly string[]).includes(IDLE), isStage(IDLE), stageByName(IDLE), stageByName(IDLE_NAME), IDLE in STAGE_NAMES], [false, false, null, null, false]);
  assert.deepEqual([isPosition(IDLE), isPosition("modeling"), isPosition(null), isPosition("空闲")], [true, true, false, false]);
  assert.deepEqual([gateStage(IDLE), ...STAGES.map(gateStage)], ["clarifying", ...STAGES]);
  // 移动：用户从空闲移到哪个阶段都行，没有「原地不动」；助手照旧不能自己移。
  assert.deepEqual(STAGES.map((to) => judgeMove(IDLE, to, "user")), STAGES.map(() => ({ ok: true })));
  assert.deepEqual(STAGES.map((to) => judgeMove(IDLE, to, "executor")), STAGES.map(() => ({ ok: false, why: "user_only" })));
});

test("空闲时助手能写什么：与澄清相同，只有页与问题；被拦时事实写本会话不属于任何工作项，怎么办写由用户从任务起点页启动一个工作项", () => {
  const row = (stage: Stage | typeof IDLE) => (["page", "problem", "diagram", "item", "review", "complete"] as const).map((kind) => canWrite(stage, kind));
  assert.deepEqual(row(IDLE), [true, true, false, false, false, false]);
  assert.deepEqual(row(IDLE), row("clarifying"));
  const how = (where: string) => `${where}。启动哪一项活动由用户决定：请用户从任务起点页启动一个工作项。本会话里你可以立主题页、改主题页、记问题条目`;
  assert.deepEqual(itemRefusal(IDLE, "add", "功能用例"), ["本会话不属于任何工作项，这时不能新增「功能用例」的条目", how("「功能用例」的条目要在写条目这项活动里写")]);
  assert.equal(itemRefusal(IDLE, "delete", "约束")![0], "本会话不属于任何工作项，这时不能删除「约束」的条目");
  assert.deepEqual(diagramRefusal(IDLE), ["本会话不属于任何工作项，这时不能画图、改图或删图", how("图要在整理建模这项活动里画")]);
  assert.deepEqual(reviewRefusal(IDLE), ["本会话不属于任何工作项，这时不能请求评审", how("评审要在写条目或评审确认这项活动里请求")]);
  assert.deepEqual(completeRefusal(IDLE), ["本会话不属于任何工作项，这时不能完成任务", how("完成任务要在评审确认或编写文档这项活动里做")]);
  // 页：空闲时新立、修改、删除都可以。
  assert.deepEqual([pageRefusal(IDLE, "add"), pageRefusal(IDLE, "update", ["它是什么"]), pageRefusal(IDLE, "delete")], [null, null, null]);
  // 空闲时的拒绝里不说「阶段」，也不让助手发进入某一段的卡片：启动哪一项活动由用户在任务起点页上定。
  for (const refusal of [itemRefusal(IDLE, "add", "功能用例"), diagramRefusal(IDLE), reviewRefusal(IDLE), completeRefusal(IDLE)]) {
    assert.doesNotMatch(refusal!.join(""), /阶段|请选择卡片|enter_|start_items|开展|任务状况卡/);
    assert.match(refusal![1], /从任务起点页启动一个工作项/);
  }
});

test("对话里怎样说启动、换站、接着做与删除：启动流程、启动单项活动、流程换站各一句；早先的对话里另有继续需求分析与句末注明的原来在做什么", () => {
  assert.equal(activityStartSentence("move", "modeling", "clarifying"), "用户把工作项从澄清移到整理建模。");
  assert.equal(activityStartSentence("launch", "reading", IDLE), "用户启动工作流程「需求分析」，从「核读材料」开始。");
  assert.equal(activityStartSentence("alone", "modeling", IDLE), "用户启动活动「整理建模」。");
  // 早先的对话里留着的两样：继续需求分析，与启动之前任务正在做别的活动时句末的注明。
  assert.equal(activityStartSentence("resume", "writing", IDLE), "用户继续工作流程「需求分析」，从「写条目」接着。");
  assert.equal(activityStartSentence("alone", "clarifying", "writing"), "用户启动活动「澄清」。（原来在做：写条目）");
  assert.equal(workItemContinuedSentence("需求分析", "writing"), "用户新建这条会话，接着做工作项「需求分析」，现在在「写条目」这一站。");
  assert.equal(workItemContinuedSentence("整理建模", null), "用户新建这条会话，接着做工作项「整理建模」。");
  assert.equal(workItemDeletedSentence("整理建模", 2), "用户删除工作项「整理建模」，它的 2 条会话已归档。");
  assert.equal(workItemDeletedSentence("需求分析", 0), "用户删除工作项「需求分析」。");
  // 助手汇报做完只是一句话：不说本会话此后怎样办，工作项照旧留着。
  assert.equal(activityDoneSentence("modeling"), "助手汇报：整理建模做完了。");
  assert.equal(flowExistsText({ record_id: 3, name: "需求分析", node: "writing" }), "已有流程工作项「需求分析」，位于「写条目」");
  assert.deepEqual([flowStartNode(true), flowStartNode(false)], ["reading", "clarifying"]);
  // 对话与界面里不再说「开展」。
  for (const one of [activityStartSentence("launch", "reading", IDLE), activityStartSentence("alone", "modeling", IDLE), activityDoneSentence("modeling")]) assert.doesNotMatch(one, /开展|任务状况卡/);
});

test("开展一项活动的三组选项：正在进行的只是一行；需求分析可以启动或继续；六项活动各带前提，缺什么照交进来的写；发布留到以后", () => {
  // 六项活动各自缺什么前提由读库的一侧按数据算好交进来（lib/activity_catalog.ts），这里只管怎样摆。
  const none = { reading: null, clarifying: null, modeling: null, writing: null, reviewing: null, document: null };
  const blocked = { ...none, reading: "还没有项目材料", modeling: "业务说明还没有内容", writing: "业务说明还没有内容", reviewing: "还没有需求条目", document: "还没有已确认的需求条目" };
  const facts = { position: IDLE, inFlow: false, flowNode: null, hasMaterials: false, blocked } as const;
  // 新任务：空闲，没有材料、没有页、没有条目。
  const fresh = launchView(facts);
  assert.equal(fresh.current, null);
  assert.deepEqual(fresh.flows, [{ activity: "clarifying", in_flow: true, label: "启动需求分析", enabled: true, state: "从澄清开始" }]);
  assert.deepEqual(fresh.activities.map((one) => [one.label, one.enabled, one.state]), [
    ["核读材料", false, "还没有项目材料"], ["澄清", true, "可以启动"], ["整理建模", false, "业务说明还没有内容"],
    ["写条目", false, "业务说明还没有内容"], ["评审确认", false, "还没有需求条目"], ["编写文档", false, "还没有已确认的需求条目"]]);
  assert.ok(fresh.activities.every((one) => one.in_flow === false));
  assert.deepEqual(fresh.later, [{ label: "发布", state: "0.6 后续" }]);
  // 有材料：需求分析从核读材料启动，核读材料可以单独开展。
  const withMaterial = launchView({ ...facts, hasMaterials: true, blocked: { ...blocked, reading: null } });
  assert.deepEqual([withMaterial.flows[0].activity, withMaterial.flows[0].state, withMaterial.activities[0].enabled], ["reading", "从核读材料开始", true]);
  // 在流程里的写条目：第一组写「继续需求分析：写条目」，流程那一项正在进行、不能点；六项单独开展的照前提。
  const writing = launchView({ position: "writing", inFlow: true, flowNode: "writing", hasMaterials: true, blocked: { ...none, reviewing: "还没有需求条目", document: "还没有已确认的需求条目" } });
  assert.deepEqual(writing.current, { activity: "writing", in_flow: true, label: "继续需求分析：写条目" });
  assert.deepEqual(writing.flows, [{ activity: "writing", in_flow: true, label: "继续需求分析（从写条目接着）", enabled: false, state: "正在进行" }]);
  assert.deepEqual(writing.activities.map((one) => one.enabled), [true, true, true, false, false, false]);
  // 流程里正在做的那一项，单独开展一组里同名的不能点，写明它正在工作流程中进行。
  assert.deepEqual(writing.activities.filter((one) => !one.enabled).map((one) => [one.label, one.state]),
    [["写条目", "正在工作流程中进行"], ["评审确认", "还没有需求条目"], ["编写文档", "还没有已确认的需求条目"]]);
  // 流程走到写条目之后改做单独的澄清：第一组写「继续澄清」，流程可以从写条目接着，澄清那一项正在进行。
  const alone = launchView({ position: "clarifying", inFlow: false, flowNode: "writing", hasMaterials: true, blocked: none });
  assert.deepEqual(alone.current, { activity: "clarifying", in_flow: false, label: "继续澄清" });
  assert.deepEqual(alone.flows, [{ activity: "writing", in_flow: true, label: "继续需求分析（从写条目接着）", enabled: true, state: "可以启动" }]);
  assert.deepEqual(alone.activities.map((one) => [one.enabled, one.state]),
    [[true, "可以启动"], [false, "正在进行"], [true, "可以启动"], [true, "可以启动"], [true, "可以启动"], [true, "可以启动"]]);  // 任务里已有流程工作项：流程那一项不能启动，写明是哪一个、在哪一站（一个任务同一时刻至多一个流程工作项）。
  const taken = launchView({ ...facts, flowItem: { record_id: 2, name: "需求分析", node: "modeling" } });
  assert.deepEqual([taken.flows[0].enabled, taken.flows[0].state], [false, "已有流程工作项「需求分析」，位于「整理建模」"]);
});

