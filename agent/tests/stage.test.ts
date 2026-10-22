/**
 * 工作的阶段里不读库的那几样（src/lib/stage.ts）：五个阶段的名字与次序、谁能从哪里移到哪里、每个阶段助手能写什么与被拦时的原话。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { activityDoneRefusal, activityDoneSentence, activityStartSentence, backCardGuidance, canWrite, publishRefusal, flowStartNode, launchView, workItemContinuedSentence, workItemDeletedSentence, flowExistsText, diagramRefusal, forwardCardGuidance, gateStage, IDLE, IDLE_NAME, isPosition, isStage, itemRefusal, judgeMove, nextStage, pageRefusal, positionName, reviewRefusal, type Stage, STAGE_NAMES, stageByName, stageEnteredBy, STAGES,
  GOTO_PREFIX, LEGACY_CARD_MOVES, NEXT_STEP_KEY, STAY_KEY, STAY_OPTION, cardMove, gotoOption, isStayCardKey, nextStepOption, stageBackedBy } from "../src/lib/stage.ts";
import { STAY_IDLE_OPTION, CONTINUE_CLARIFY_KEY, ENTER_OPTIONS, START_ITEMS_KEY, STAY_OPTIONS } from "./old_cards.ts";
import { readDefinitions } from "../src/lib/activity_def_read.ts";
import { SRS_SKILL_DIR as SKILL_DIR_FOR_ALLOWED } from "./helpers.ts";

/** 获准能力表：取真实任务类型的活动声明生成的那一份。 */
const ALLOWED = readDefinitions(SKILL_DIR_FOR_ALLOWED).allowed;

/** 拒绝的两层文字，照「[事实, 指引]」比；原因码另比。 */
const pair = (r: { fact: string; guidance: string } | null | undefined) => (r ? [r.fact, r.guidance] : r);

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

test("提议的卡片怎样写：键是通用的三种，进入下一步、转到某一步、继续本步；早先按阶段的固定键照换算表认，自带方向", () => {
  assert.equal(forwardCardGuidance("reading"), "请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 next_step「进入下一步：澄清」、stay「继续本步」");
  assert.equal(forwardCardGuidance("modeling"), "请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 next_step「进入下一步：写条目」、stay「继续本步」");
  assert.equal(forwardCardGuidance("reviewing"), "请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 next_step「进入下一步：编写文档」、stay「继续本步」");
  assert.equal(backCardGuidance("clarifying"), "请用请选择卡片提议，在问句里写明为什么要退回，两个选项的键与文字是 goto:clarifying「回到：澄清」、stay「继续本步」");
  assert.equal(backCardGuidance("reviewing", "document"), "请用请选择卡片提议，在问句里写明为什么要退回，两个选项的键与文字是 goto:reviewing「回到：评审确认」、stay「继续本步」");
  assert.deepEqual([NEXT_STEP_KEY, STAY_KEY, GOTO_PREFIX, STAY_OPTION], ["next_step", "stay", "goto:", { key: "stay", text: "继续本步" }]);
  assert.deepEqual([nextStepOption("clarifying"), gotoOption("reading", "modeling"), gotoOption("writing", "clarifying"), gotoOption("writing", IDLE)],
    [{ key: "next_step", text: "进入下一步：澄清" }, { key: "goto:reading", text: "回到：核读材料" }, { key: "goto:writing", text: "转到：写条目" }, { key: "goto:writing", text: "转到：写条目" }]);
  // 三种键的意思；goto 后面要是阶段的键。
  assert.deepEqual(["next_step", "stay", "goto:modeling", "goto:testing", "别的键", null].map(cardMove),
    [{ kind: "next" }, { kind: "stay" }, { kind: "goto", to: "modeling" }, null, null, null]);
  // 进入下一步看现在在哪一步；转到某一步按前后分进入与退回。
  assert.deepEqual([stageEnteredBy("next_step", "clarifying"), stageEnteredBy("next_step", "document"), stageEnteredBy("next_step", IDLE), stageEnteredBy("next_step", null)],
    ["modeling", null, null, null]);
  assert.deepEqual([stageEnteredBy("goto:writing", "clarifying"), stageEnteredBy("goto:reading", "modeling"), stageBackedBy("goto:reading", "modeling"), stageBackedBy("goto:writing", "clarifying")],
    ["writing", null, "reading", null]);
  assert.deepEqual([stageEnteredBy("goto:reading", IDLE), stageBackedBy("goto:reading", IDLE), stageEnteredBy("stay", "reading"), isStayCardKey("stay")], ["reading", null, null, true]);
  // 早先的固定键：自带方向，与现在在哪一步无关；留在这一段的几种都算 stay。
  assert.deepEqual(["enter_clarify", "enter_consolidate", "start_items", "enter_review", "enter_document", "enter_reading"].map((key) => stageEnteredBy(key, "reviewing")),
    ["clarifying", "modeling", "writing", "reviewing", "document", "reading"]);
  assert.deepEqual(["back_to_reading", "back_to_clarify", "back_to_consolidate", "back_to_writing", "back_to_review"].map((key) => [stageBackedBy(key, "reading"), stageEnteredBy(key, "reading")]),
    [["reading", null], ["clarifying", null], ["modeling", null], ["writing", null], ["reviewing", null]]);
  assert.deepEqual(["continue_reading", "continue_clarify", "continue_consolidate", "continue_writing", "continue_review", "stay_in_stage", "stay_idle"].map(isStayCardKey),
    [true, true, true, true, true, true, true]);
  assert.deepEqual(Object.keys(LEGACY_CARD_MOVES).sort(), [...Object.values(ENTER_OPTIONS).map((one) => one.key), ...Object.values(STAY_OPTIONS).map((one) => one.key), START_ITEMS_KEY,
    CONTINUE_CLARIFY_KEY, STAY_IDLE_OPTION.key, "stay_in_stage", "back_to_reading", "back_to_clarify", "back_to_consolidate", "back_to_writing", "back_to_review"]
    .filter((key, i, all) => all.indexOf(key) === i).sort());
  assert.deepEqual(STAGES.map(nextStage), ["clarifying", "modeling", "writing", "reviewing", "document", null]);
  // 编写文档是最后一段，没有往前的卡片。
  assert.equal(forwardCardGuidance("document"), "");
});

test("每个阶段助手能写什么：页与问题一直可以，图从整理建模起，别的集合的条目与请求评审从写条目起，发布版本在评审确认与编写文档；编写文档只写页与问题", () => {
  const row = (stage: Stage) => (["page", "problem", "diagram", "item", "review", "publish"] as const).map((kind) => canWrite(ALLOWED[stage], kind));
  assert.deepEqual(row("reading"), [true, true, false, false, false, false]);
  assert.deepEqual(row("clarifying"), [true, true, false, false, false, false]);
  assert.deepEqual(row("modeling"), [true, true, true, false, false, false]);
  assert.deepEqual(row("writing"), [true, true, true, true, true, false]);
  assert.deepEqual(row("reviewing"), [true, true, true, true, true, true]);
  // 编写文档排在最后，却不能画图、不能写条目、不能请求评审：守门表一个阶段一个阶段列，不按先后推。
  assert.deepEqual(row("document"), [true, true, false, false, false, true]);
  const leave = (back: "reviewing" | "modeling") => `编写文档阶段只补写主题页的文字。要做这件事，得先回到${STAGE_NAMES[back]}：${backCardGuidance(back)}，由用户在卡片上点`;
  assert.deepEqual(pair(itemRefusal("document", ALLOWED["document"], "update", "功能用例")), ["任务现在在编写文档阶段，这个阶段不能修改「功能用例」的条目", leave("reviewing")]);
  assert.deepEqual(pair(diagramRefusal("document", ALLOWED["document"])), ["任务现在在编写文档阶段，这个阶段不能画图、改图或删图", leave("modeling")]);
  assert.deepEqual(pair(reviewRefusal("document", ALLOWED["document"])), ["任务现在在编写文档阶段，这个阶段不能请求评审", leave("reviewing")]);
  assert.equal(leave("reviewing"), "编写文档阶段只补写主题页的文字。要做这件事，得先回到评审确认：请用请选择卡片提议，在问句里写明为什么要退回，两个选项的键与文字是 goto:reviewing「回到：评审确认」、stay「继续本步」，由用户在卡片上点");
  assert.deepEqual([publishRefusal("document", ALLOWED["document"]), publishRefusal("reviewing", ALLOWED["reviewing"]), pageRefusal("document", "add"), pageRefusal("document", "update", ["它是什么"])], [null, null, null, null]);
});

test("被拦时的原话：事实写现在在哪个阶段、拦下的是什么；怎么办写这一步要先做什么、谁能移动", () => {
  assert.deepEqual(pair(itemRefusal("clarifying", ALLOWED["clarifying"], "add", "功能用例")), [
    "任务现在在澄清阶段，这个阶段不能新增「功能用例」的条目",
    "「功能用例」的条目要到写条目阶段才能写。进入写条目要由用户在卡片上选「转到：写条目」：你可以先立页、请用户看，觉得理解够了就用请选择卡片提议",
  ]);
  assert.match(itemRefusal("reading", ALLOWED["reading"], "update", "约束")!.fact, /^任务现在在核读材料阶段，这个阶段不能修改「约束」的条目$/);
  assert.equal(itemRefusal("reading", ALLOWED["reading"], "update", "约束")!.guidance, itemRefusal("clarifying", ALLOWED["clarifying"], "update", "约束")!.guidance);
  assert.match(itemRefusal("modeling", ALLOWED["modeling"], "delete", "非功能需求")!.fact, /不能删除「非功能需求」的条目$/);
  assert.deepEqual([itemRefusal("writing", ALLOWED["writing"], "add", "功能用例"), itemRefusal("reviewing", ALLOWED["reviewing"], "delete", "功能用例")], [null, null]);

  assert.match(diagramRefusal("reading", ALLOWED["reading"])!.fact, /^任务现在在核读材料阶段，这个阶段不能画图、改图或删图$/);
  // 怎样走到整理建模：往前由用户在卡片上点，助手只能发卡片提议；指引里没有「在回复里把任务移到」这种说法。
  assert.match(diagramRefusal("reading", ALLOWED["reading"])!.guidance, /往前进入下一段要由用户在卡片上点，你只能提议：材料读完之后先提议进入澄清，请用请选择卡片提议/);
  assert.match(diagramRefusal("reading", ALLOWED["reading"])!.guidance, /next_step「进入下一步：澄清」、stay「继续本步」；澄清告一段落之后，再照同样的办法提议「进入下一步：整理建模」$/);
  assert.match(diagramRefusal("clarifying", ALLOWED["clarifying"])!.guidance, /进入整理建模要由用户在卡片上选「进入下一步：整理建模」，你只能提议：澄清告一段落之后，请用请选择卡片提议/);
  assert.match(diagramRefusal("clarifying", ALLOWED["clarifying"])!.guidance, /next_step「进入下一步：整理建模」、stay「继续本步」$/);
  for (const stage of ["reading", "clarifying"] as const) assert.doesNotMatch(diagramRefusal(stage, ALLOWED[stage])!.guidance, /在回复里把任务移到|自己移到/);
  assert.deepEqual([diagramRefusal("modeling", ALLOWED["modeling"]), diagramRefusal("writing", ALLOWED["writing"]), diagramRefusal("reviewing", ALLOWED["reviewing"])], [null, null, null]);

  for (const stage of ["reading", "clarifying", "modeling"] as const) {
    assert.equal(reviewRefusal(stage, ALLOWED[stage])!.fact, `任务现在在${STAGE_NAMES[stage]}阶段，评审要到写条目阶段才能请求`);
    assert.match(reviewRefusal(stage, ALLOWED[stage])!.guidance, /^条目写出来之后再评审。进入写条目要由用户在卡片上选「转到：写条目」/);
  }
  assert.deepEqual([reviewRefusal("writing", ALLOWED["writing"]), reviewRefusal("reviewing", ALLOWED["reviewing"])], [null, null]);

  assert.deepEqual(pair(publishRefusal("writing", ALLOWED["writing"])), ["任务现在在写条目阶段，发布版本要在评审确认阶段",
    "条目写完之后，要由用户在卡片上选「进入下一步：评审确认」进入评审确认，再发布版本。请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 next_step「进入下一步：评审确认」、stay「继续本步」"]);
  assert.match(publishRefusal("clarifying", ALLOWED["clarifying"])!.guidance, /^要先写条目、再由用户进入评审确认，才能发布版本。进入写条目要由用户在卡片上选「转到：写条目」/);
  assert.equal(publishRefusal("reviewing", ALLOWED["reviewing"]), null);
});

test("业务说明的页：前四个阶段随便写；评审确认阶段只能改状态与改看，不能新立、不能删", () => {
  for (const stage of ["reading", "clarifying", "modeling", "writing"] as const) {
    assert.deepEqual([pageRefusal(stage, "add"), pageRefusal(stage, "update", ["它是什么"]), pageRefusal(stage, "delete")], [null, null, null]);
  }
  assert.deepEqual(pair(pageRefusal("reviewing", "add")), ["任务现在在评审确认阶段，这个阶段不能新立主题页", "要动主题页的内容，得先回到澄清或整理建模：请用请选择卡片提议，在问句里写明为什么要退回，两个选项的键与文字是 goto:clarifying「回到：澄清」、stay「继续本步」，由用户在卡片上点"]);
  assert.equal(pageRefusal("reviewing", "delete")!.fact, "任务现在在评审确认阶段，这个阶段不能删除主题页");
  assert.deepEqual([pageRefusal("reviewing", "update", ["状态"]), pageRefusal("reviewing", "update", ["状态", "改看"]), pageRefusal("reviewing", "update", [])], [null, null, null]);
  assert.equal(pageRefusal("reviewing", "update", ["状态", "它是什么", "例子"])!.fact,
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
  const row = (stage: Stage | typeof IDLE) => (["page", "problem", "diagram", "item", "review", "publish"] as const).map((kind) => canWrite(ALLOWED[stage], kind));
  assert.deepEqual(row(IDLE), [true, true, false, false, false, false]);
  assert.deepEqual(row(IDLE), row("clarifying"));
  const how = (where: string) => `${where}。启动哪一项活动由用户决定：请用户从任务起点页启动一个工作项。本会话里你可以立主题页、改主题页、记问题条目`;
  assert.deepEqual(pair(itemRefusal(IDLE, ALLOWED[IDLE], "add", "功能用例")), ["本会话不属于任何工作项，这时不能新增「功能用例」的条目", how("「功能用例」的条目要在写条目这项活动里写")]);
  assert.equal(itemRefusal(IDLE, ALLOWED[IDLE], "delete", "约束")!.fact, "本会话不属于任何工作项，这时不能删除「约束」的条目");
  assert.deepEqual(pair(diagramRefusal(IDLE, ALLOWED[IDLE])), ["本会话不属于任何工作项，这时不能画图、改图或删图", how("图要在整理建模这项活动里画")]);
  assert.deepEqual(pair(reviewRefusal(IDLE, ALLOWED[IDLE])), ["本会话不属于任何工作项，这时不能请求评审", how("评审要在写条目或评审确认这项活动里请求")]);
  assert.deepEqual(pair(publishRefusal(IDLE, ALLOWED[IDLE])), ["本会话不属于任何工作项，这时不能发布版本", how("发布版本要在评审确认或编写文档这项活动里做")]);
  // 页：空闲时新立、修改、删除都可以。
  assert.deepEqual([pageRefusal(IDLE, "add"), pageRefusal(IDLE, "update", ["它是什么"]), pageRefusal(IDLE, "delete")], [null, null, null]);
  // 空闲时的拒绝里不说「阶段」，也不让助手发进入某一段的卡片：启动哪一项活动由用户在任务起点页上定。
  for (const refusal of [itemRefusal(IDLE, ALLOWED[IDLE], "add", "功能用例"), diagramRefusal(IDLE, ALLOWED[IDLE]), reviewRefusal(IDLE, ALLOWED[IDLE]), publishRefusal(IDLE, ALLOWED[IDLE])]) {
    assert.doesNotMatch(refusal!.fact + refusal!.guidance, /阶段|请选择卡片|enter_|start_items|开展|任务状况卡/);
    assert.match(refusal!.guidance, /从任务起点页启动一个工作项/);
  }
});

test("对话里怎样说启动、换站、接着做与删除：启动流程、启动单项活动、流程换站各一句；早先的对话里另有继续需求分析与句末注明的原来在做什么", () => {
  assert.equal(activityStartSentence("move", "modeling", "clarifying"), "用户把工作项从澄清移到整理建模。");
  assert.equal(activityStartSentence("launch", "reading", IDLE), "用户启动工作流程「需求分析」，从「核读材料」开始。");
  assert.equal(activityStartSentence("alone", "modeling", IDLE), "用户启动活动「整理建模」。");
  // 给了名字（取自声明）就用给的；活动标识符不是阶段键、又没有给名字时写键本身。
  assert.equal(activityStartSentence("launch", "parse_spec", IDLE, { flow: "改写既有规格说明", activity: "逆向解析" }), "用户启动工作流程「改写既有规格说明」，从「逆向解析」开始。");
  assert.equal(activityStartSentence("alone", "parse_spec", IDLE, { activity: "逆向解析" }), "用户启动活动「逆向解析」。");
  assert.equal(activityStartSentence("alone", "parse_spec", IDLE), "用户启动活动「parse_spec」。");
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


test("阶段拒绝带原因码：同一种拒绝不论在哪个阶段、会话空闲与否，原因码相同（键的第三段只是情形）", () => {
  assert.deepEqual([itemRefusal(IDLE, ALLOWED[IDLE], "add", "功能用例")!.code, itemRefusal("document", ALLOWED["document"], "add", "功能用例")!.code, itemRefusal("clarifying", ALLOWED["clarifying"], "add", "功能用例")!.code],
    ["gate.stage_item_write", "gate.stage_item_write", "gate.stage_item_write"]);
  assert.deepEqual([pageRefusal("reviewing", "add")!.code, pageRefusal("reviewing", "update", ["标题"])!.code], ["gate.stage_page_write", "gate.stage_page_write"]);
  assert.deepEqual([diagramRefusal(IDLE, ALLOWED[IDLE])!.code, diagramRefusal("reading", ALLOWED["reading"])!.code, reviewRefusal("reading", ALLOWED["reading"])!.code, publishRefusal("writing", ALLOWED["writing"])!.code, activityDoneRefusal(IDLE).code],
    ["gate.stage_diagram", "gate.stage_diagram", "gate.stage_review", "gate.stage_publish", "gate.activity_done_not_single_activity"]);
});
