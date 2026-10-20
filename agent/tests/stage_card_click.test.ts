/**
 * 用户在助手提议转移的那张卡片上点了生效的那一项（进入下一步 next_step、转到某一步 goto:<活动标识符>；早先的 enter_clarify、
 * start_items、back_to_reading 之类照换算表认）：系统替用户记一次移动（lib/stage_read.ts 的 recordStageCardClick），在卡片点击的处理函数
 * （hooks/user_commands.ts 的 /tw-ui）里、发那句固定的话之前记。目标要在流程的各步里，它的前置条件要满足。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { UI_COMMAND, UI_RESULT_KEY, registerUserCommands } from "../src/hooks/user_commands.ts";
import { stageBackedBy, STAGE_NAMES, type Stage } from "../src/lib/stage.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { BACK_OPTIONS, CONTINUE_CLARIFY_KEY, CONTINUE_CLARIFY_TEXT, ENTER_OPTIONS, STAY_HERE_OPTION, START_ITEMS_KEY, START_ITEMS_TEXT, STAY_OPTIONS } from "./old_cards.ts";
import { backReason, enterReason, recordStageCardClick } from "../src/lib/stage_read.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, READY_PAGE, callIn, count, demoDefinition, enterStage, makeWorkspace, overallDefinition, query, stageMoves, viewReadyPage } from "./helpers.ts";

const SESSION = "sess-ui";
const OPTIONS = [{ key: START_ITEMS_KEY, text: START_ITEMS_TEXT }, { key: CONTINUE_CLARIFY_KEY, text: CONTINUE_CLARIFY_TEXT }];
/** 一条助手消息，里面是「回复」工具发的一张请选择卡片。 */
const card = (id: string, options: unknown[] = OPTIONS) => ({
  id, type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name: "reply", id: `call-${id}`,
    arguments: { informs: [], act: { kind: "choose", text: "主题页你都看过了，现在开始写条目吗？", options }, text: "现在开始写条目吗？" } }] },
});
const said = (id: string, text: string) => ({ id, type: "message", message: { role: "user", content: text } });
const BRANCH = [said("u-1", "读一下材料"), card("a-1"), card("a-2", [{ key: "yes", text: "可以" }, { key: "no", text: "不行" }])] as never;

/**
 * 一个已经启动了需求分析、停在核读材料的任务：测试里的两条会话都属于这个流程的工作项（进入与退回的卡片只在流程的工作项里算数）。
 * 早先建的任务没有阶段，没有工作项。
 */
function workspace(definition: unknown = overallDefinition(), { ready = true } = {}): string {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  enterStage(dir, "reading");
  // 写条目的前置条件是业务说明至少一节、图都看过：先放一页用户看过的主题（没有阶段的任务不放）。
  if (ready && definition === undefined || (ready && (definition as { 交付物?: { 条目集合?: { 名称?: string }[] } }).交付物?.条目集合?.some((one) => one.名称 === "业务说明"))) {
    saveRevision(callIn(dir, SESSION), { operations: [READY_PAGE] });
    viewReadyPage(dir);
  }
  return dir;
}
/** 启动之后记下的换站，按先后；列名沿用早先「一次移动一行」的叫法。 */
const records = (dir: string) => stageMoves(dir).map(({ event_seq: _seq, record_id: _id, direction: _direction, ...r }) => r);
/** 启动之后换了几次站。 */
const moves = (dir: string) => stageMoves(dir).length;
/** 换站之后工作项仍是那一行。 */
const moveRows = stageMoves;

test("点「开始写条目」：记一条用户的移动，理由写明是在卡片上选的；点「继续本阶段」什么都不记", () => {
  const dir = workspace();
  assert.equal(recordStageCardClick(dir, SESSION, BRANCH, { opId: "ui-op-1", replyEntry: "a-1", optionKey: CONTINUE_CLARIFY_KEY }), null);
  assert.equal(moves(dir), 0);
  const moved = recordStageCardClick(dir, SESSION, BRANCH, { opId: "ui-op-2", replyEntry: "a-1", optionKey: START_ITEMS_KEY })!;
  assert.deepEqual([moved.moved, moved.from, moved.requested], [true, "reading", "writing"]);
  assert.deepEqual(records(dir), [{ stage: "writing", from_stage: "reading", actor: "user", reason: "用户在卡片上选了「开始写条目」", run_id: null, call_id: "ui-op-2", session_id: SESSION }]);
  // 已经在写条目了再点一次（例如点了一张更早的卡片）：原地不动，不再记。
  const again = recordStageCardClick(dir, SESSION, BRANCH, { opId: "ui-op-3", replyEntry: "a-1", optionKey: START_ITEMS_KEY })!;
  assert.deepEqual([again.moved, again.why], [false, "same"]);
  assert.equal(moves(dir), 1);
});

test("认不出那张卡片就不记：回复不在这条分支上、那条回复不是请选择、卡片上没有这个键、点的不是这个键", () => {
  const dir = workspace();
  const tries = [
    { replyEntry: "a-9", optionKey: START_ITEMS_KEY },   // 分支上没有这条回复
    { replyEntry: "u-1", optionKey: START_ITEMS_KEY },   // 是用户的话，不是卡片
    { replyEntry: "a-2", optionKey: START_ITEMS_KEY },   // 卡片上没有这个键（页面不会这样发，防的是乱写的请求）
    { replyEntry: "a-1", optionKey: "yes" },
    { replyEntry: null, optionKey: START_ITEMS_KEY },
  ];
  for (const one of tries) assert.equal(recordStageCardClick(dir, SESSION, BRANCH, { opId: "ui-op-1", ...one }), null);
  assert.equal(moves(dir), 0);
});

test("早先建的任务没有阶段、已经不在进行中的任务：点了也不记", () => {
  const old = workspace(demoDefinition());
  const none = recordStageCardClick(old, SESSION, BRANCH, { opId: "ui-op-1", replyEntry: "a-1", optionKey: START_ITEMS_KEY })!;
  assert.deepEqual([none.moved, none.why, none.from], [false, "no_stages", null]);
  assert.equal(moves(old), 0);
  assert.equal(recordStageCardClick(makeWorkspace(), SESSION, BRANCH, { opId: "ui-op-1", replyEntry: "a-1", optionKey: START_ITEMS_KEY }), null, "还没有库");
});

test("进入下一步：在流程里每一步点 next_step 移到下一步；点「继续本步」不记；下一步的前置条件不满足时不记并写明缺什么", () => {
  const next = [{ key: "next_step", text: "进入下一步" }, { key: "stay", text: "继续本步" }];
  const branch = [said("u-1", "读一下材料"), card("a-1", next)] as never;
  for (const [from, to] of [["reading", "clarifying"], ["clarifying", "modeling"], ["modeling", "writing"]] as const) {
    const dir = workspace();
    if (from !== "reading") enterStage(dir, from);
    const before = moves(dir);
    assert.equal(recordStageCardClick(dir, SESSION, branch, { opId: "ui-op-1", replyEntry: "a-1", optionKey: "stay" }), null, `${from}：继续本步`);
    assert.equal(moves(dir), before);
    const moved = recordStageCardClick(dir, SESSION, branch, { opId: "ui-op-2", replyEntry: "a-1", optionKey: "next_step" })!;
    assert.deepEqual([moved.moved, moved.from, moved.requested], [true, from, to], `${from} 到 ${to}`);
    assert.deepEqual(records(dir).at(-1), { stage: to, from_stage: from, actor: "user", reason: "用户在卡片上选了「进入下一步」", run_id: null, call_id: "ui-op-2", session_id: SESSION });
  }
  // 写条目的下一步是评审确认，要有需求条目：没有就不记，结果里写缺什么。
  const writing = workspace();
  enterStage(writing, "writing");
  const blocked = recordStageCardClick(writing, SESSION, branch, { opId: "ui-op-3", replyEntry: "a-1", optionKey: "next_step" })!;
  assert.deepEqual([blocked.moved, blocked.why, blocked.from, blocked.requested, blocked.blocked], [false, "not_ready", "writing", "reviewing", "还没有需求条目"]);
  // 写条目的前置条件不满足（业务说明一节都没有）时，从核读材料转到写条目也不记。
  const empty = workspace(overallDefinition(), { ready: false });
  const skip = [said("u-1", "读一下材料"), card("a-1", [{ key: "goto:writing", text: "转到：写条目" }, { key: "stay", text: "继续本步" }])] as never;
  const refused = recordStageCardClick(empty, SESSION, skip, { opId: "ui-op-4", replyEntry: "a-1", optionKey: "goto:writing" })!;
  assert.deepEqual([refused.moved, refused.why, refused.blocked], [false, "not_ready", "业务说明还没有内容"]);
  assert.equal(enterReason("进入下一步：澄清"), "用户在卡片上选了「进入下一步：澄清」");
});

test("早先的固定键照换算表认：进入某段只往后、退回某段只往前；继续本阶段、留在本段都不记", () => {
  for (const [from, to] of [["reading", "clarifying"], ["clarifying", "modeling"], ["modeling", "writing"]] as const) {
    const dir = workspace();
    if (from !== "reading") enterStage(dir, from);
    const options = [ENTER_OPTIONS[to], STAY_OPTIONS[from]];
    const branch = [said("u-1", "读一下材料"), card("a-1", options)] as never;
    assert.equal(recordStageCardClick(dir, SESSION, branch, { opId: "ui-op-1", replyEntry: "a-1", optionKey: STAY_OPTIONS[from].key }), null, `${from}：留在这一段`);
    const moved = recordStageCardClick(dir, SESSION, branch, { opId: "ui-op-2", replyEntry: "a-1", optionKey: ENTER_OPTIONS[to].key })!;
    assert.deepEqual([moved.moved, moved.from, moved.requested], [true, from, to], `${from} 到 ${to}`);
    assert.equal(records(dir).at(-1)!.reason, `用户在卡片上选了「${ENTER_OPTIONS[to].text}」`);
  }
});

test("回退卡片：点「退回某段」记一条用户的移动，理由是点的那一项加卡片的问句；点「留在本段」不记；只能退到前面的阶段", () => {
  const QUESTION = "用户放进了一份新的借阅规定，前面几页的理解要重看。退回核读材料吗？";
  const backCard = (id: string, to: Exclude<Stage, "document">, text = QUESTION) => ({
    id, type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", name: "reply", id: `call-${id}`,
      arguments: { informs: [], act: { kind: "choose", text, options: [BACK_OPTIONS[to], STAY_HERE_OPTION] }, text } }] },
  });
  const dir = workspace();
  enterStage(dir, "modeling");
  const before = moves(dir);
  const branch = [said("u-1", "我放了一份新材料"), backCard("a-1", "reading"), backCard("a-2", "writing"), backCard("a-3", "modeling"), backCard("a-4", "clarifying", "  ")] as never;
  // 留在本段：不记。
  assert.equal(recordStageCardClick(dir, SESSION, branch, { opId: "ui-op-1", replyEntry: "a-1", optionKey: STAY_HERE_OPTION.key }), null);
  // 退到后面的阶段、退到现在所在的阶段：都不记，结果里写明原因。
  for (const [entry, to] of [["a-2", "writing"], ["a-3", "modeling"]] as const) {
    const refused = recordStageCardClick(dir, SESSION, branch, { opId: "ui-op-2", replyEntry: entry, optionKey: BACK_OPTIONS[to].key })!;
    assert.deepEqual([refused.moved, refused.why, refused.from, refused.requested], [false, "not_back", "modeling", to]);
  }
  assert.equal(moves(dir), before);
  // 退回核读材料：记成用户的移动。
  const moved = recordStageCardClick(dir, SESSION, branch, { opId: "ui-op-3", replyEntry: "a-1", optionKey: BACK_OPTIONS.reading.key })!;
  assert.deepEqual([moved.moved, moved.from, moved.requested], [true, "modeling", "reading"]);
  assert.deepEqual(records(dir).at(-1), { stage: "reading", from_stage: "modeling", actor: "user", reason: `用户在卡片上选了「退回核读材料」：${QUESTION}`,
    run_id: null, call_id: "ui-op-3", session_id: SESSION });
  // 卡片的问句是空白时理由里只写点的是哪一项。
  assert.deepEqual([backReason("退回澄清", "  "), backReason("退回澄清", " 两页的理解对不上。 ")], ["用户在卡片上选了「退回澄清」", "用户在卡片上选了「退回澄清」：两页的理解对不上。"]);
  // 五个退回的键与「留在本段」。
  assert.deepEqual(Object.values(BACK_OPTIONS).map((one) => [one.key, one.text, stageBackedBy(one.key, "document")]), [
    ["back_to_reading", "退回核读材料", "reading"], ["back_to_clarify", "退回澄清", "clarifying"], ["back_to_consolidate", "退回整理建模", "modeling"],
    ["back_to_writing", "退回写条目", "writing"], ["back_to_review", "退回评审确认", "reviewing"]]);
  assert.deepEqual([STAY_HERE_OPTION, stageBackedBy("enter_clarify", "document"), stageBackedBy("stay_in_stage", "document"), stageBackedBy(null, "document")], [{ key: "stay_in_stage", text: "留在本段" }, null, null, null]);
});

test("方向不对的旧卡片不记：任务已经过了那一段，再点一张早先的「进入澄清」不会把任务退回去；转到流程里没有的一步也不记", () => {
  const modeling = workspace();
  enterStage(modeling, "modeling");
  const cardFor = (option: { key: string; text: string }) => [said("u-1", "读一下材料"), card("a-1", [option, { key: "stay", text: "继续本步" }])] as never;
  const click = (dir: string, option: { key: string; text: string }) => recordStageCardClick(dir, SESSION, cardFor(option), { opId: "ui-op-x", replyEntry: "a-1", optionKey: option.key });
  assert.deepEqual([click(modeling, ENTER_OPTIONS.clarifying)?.moved, click(modeling, ENTER_OPTIONS.clarifying)?.why, click(modeling, ENTER_OPTIONS.clarifying)?.from], [false, "not_next", "modeling"]);
  // 新键往回转可以：回到澄清。
  const back = click(modeling, { key: "goto:clarifying", text: "回到：澄清" })!;
  assert.deepEqual([back.moved, back.from, back.requested], [true, "modeling", "clarifying"]);
  assert.equal(records(modeling).at(-1)!.reason, "用户在卡片上选了「回到：澄清」：主题页你都看过了，现在开始写条目吗？");
});

/** 登记两个扩展命令，取 /tw-ui 的处理函数；sent 按先后记下它往会话里发的东西。 */
function uiHandler() {
  const commands = new Map<string, any>();
  const sent: [string, any][] = [];
  registerUserCommands({
    registerCommand: (name: string, spec: any) => commands.set(name, spec),
    sendMessage: (message: any) => sent.push(["custom", message]),
    sendUserMessage: (text: string) => sent.push(["user", text]),
  } as any);
  return { handler: commands.get(UI_COMMAND).handler as (args: string, ctx: any) => Promise<void>, sent };
}
function fakeCtx(dir: string) {
  const status: Record<string, string> = {};
  return { status, ctx: { mode: "rpc", cwd: dir, isIdle: () => true, sessionManager: { getSessionId: () => SESSION, getBranch: () => BRANCH },
    ui: { setStatus: (key: string, value: string) => (status[key] = value), notify() {} } } };
}

test("卡片点击的处理函数：点「开始写条目」时先记移动、再发标注与那句固定的话，结果里带那条事件的序号", async () => {
  const dir = workspace();
  const { handler, sent } = uiHandler();
  const { ctx, status } = fakeCtx(dir);
  await handler(JSON.stringify({ op_id: "ui-op-41", reply_entry: "a-1", option_key: START_ITEMS_KEY, option_text: START_ITEMS_TEXT, text: "我选：开始写条目" }), ctx);
  const seq = moveRows(dir).at(-1)!.event_seq;
  assert.deepEqual(JSON.parse(status[UI_RESULT_KEY]), { op_id: "ui-op-41", ok: true, idle: true, stage_event_seq: seq });
  assert.deepEqual(sent.map(([kind]) => kind), ["custom", "user"]);
  assert.equal(sent[0][1].details.stage_event_seq, seq);
  // 标注里另写这次移动从哪个阶段到哪个阶段：对话区据此在用户那句话下面写一行。
  assert.deepEqual(sent[0][1].details.stage_move, { from: "reading", to: "writing", how: "move" });
  assert.equal(sent[1][1], "我选：开始写条目");
  assert.deepEqual(records(dir).map((r) => [r.stage, r.actor, r.call_id]), [["writing", "user", "ui-op-41"]]);

  // 点「继续本阶段」：照常发那两条，不记移动，结果里没有事件序号。
  const other = fakeCtx(dir);
  await handler(JSON.stringify({ op_id: "ui-op-42", reply_entry: "a-1", option_key: CONTINUE_CLARIFY_KEY, option_text: CONTINUE_CLARIFY_TEXT, text: "我选：继续本阶段" }), other.ctx);
  assert.deepEqual(JSON.parse(other.status[UI_RESULT_KEY]), { op_id: "ui-op-42", ok: true, idle: true });
  assert.equal("stage_event_seq" in sent[2][1].details, false);
  assert.equal("stage_move" in sent[2][1].details, false);
  assert.equal("stage_unmoved" in sent[2][1].details, false);
  assert.equal("stage_unmoved" in sent[0][1].details, false);
  assert.equal(moves(dir), 1);

  // 任务已经在写条目，再点一次那张卡片上的「开始写条目」：照常发那两条，不记移动；标注里写任务当时在哪个阶段，
  // 卡片上据此告诉用户这次点击没有改变阶段。
  const again = fakeCtx(dir);
  await handler(JSON.stringify({ op_id: "ui-op-43", reply_entry: "a-1", option_key: START_ITEMS_KEY, option_text: START_ITEMS_TEXT, text: "我选：开始写条目" }), again.ctx);
  assert.deepEqual(JSON.parse(again.status[UI_RESULT_KEY]), { op_id: "ui-op-43", ok: true, idle: true });
  assert.deepEqual(sent.slice(4).map(([kind]) => kind), ["custom", "user"]);
  assert.deepEqual(sent[4][1].details.stage_unmoved, { at: "writing" });
  assert.equal("stage_move" in sent[4][1].details, false);
  assert.equal(moves(dir), 1);
});

test("用户先在界面上把任务移回澄清，再点卡片上的「开始写条目」：又记一条，最近一条说了算", async () => {
  const dir = workspace();
  const { handler } = uiHandler();
  const click = (opId: string) => handler(JSON.stringify({ op_id: opId, reply_entry: "a-1", option_key: START_ITEMS_KEY, option_text: START_ITEMS_TEXT, text: "我选：开始写条目" }), fakeCtx(dir).ctx);
  await click("ui-op-51");
  runUserOperation({ workspaceDir: dir, sessionId: SESSION }, { op_id: "ui-op-52", kind: "move_stage", fields: { stage: "澄清" } });
  await click("ui-op-53");
  assert.deepEqual(records(dir).map((r) => [r.from_stage, r.stage, r.call_id]), [["reading", "writing", "ui-op-51"], ["writing", "clarifying", "ui-op-52"], ["clarifying", "writing", "ui-op-53"]]);
});
