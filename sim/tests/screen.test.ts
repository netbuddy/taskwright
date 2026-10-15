/** 用户 agent 眼里的界面与「回应」的翻译：渲染回复与条目区、按钮、参数核对、按约定第 5.4 节走 actions 还是 messages。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTINUE_STAGE, DOCUMENT_REVISE_TEXT, LAUNCH_SKIP, START_ACTIVITY, STAY_HERE_TEXT, STAY_TEXT, type LaunchView, launchOption, planLaunch, renderLaunch, buttonLabels, buttonsOf, isReviewedOption, isStageCard, isStayOption, optionKeyOf, pendingCount, planRespond, proposalKind, renderItems, renderMessages, renderReply,
  viewOnLook, viewedNow,
} from "../lib/screen.ts";

const confirmReply = {
  type: "assistant_reply", message_id: "a1", text: "三个用例整理好了，请看看。", informs: ["存了 3 个用例。"],
  act: { kind: "confirm" as const, text: "请确认这三个用例", items: [{ item_id: "UC-001", revision_no: 1 }, { item_id: "UC-002", revision_no: 2 }] },
};
const chooseReply = {
  type: "assistant_reply", message_id: "a2", text: "先定哪个？",
  act: { kind: "choose" as const, text: "先做哪一块", options: [{ key: "a", text: "借书" }, { key: "b", text: "还书" }] },
};

test("回复渲染成用户看到的样子：告知、正文、卡片与可以点的按钮", () => {
  assert.equal(renderReply(confirmReply),
    "助手告诉你：存了 3 个用例。\n助手说：三个用例整理好了，请看看。\n【卡片：请确认】请确认这三个用例\n" +
    "涉及的条目：UC-001（修订 1）、UC-002（修订 2）\n可以点：这几条都看过了／不对（也可以直接回一句话）");
  assert.match(renderReply(chooseReply), /选项 a：借书\n选项 b：还书\n可以点：借书／还书（写选项的文字或者它前面的键都行；也可以直接回一句话）/);
  assert.equal(renderReply({ type: "assistant_reply", message_id: "x", text: "好的。", act: null }), "助手说：好的。");
  assert.deepEqual(buttonsOf({ kind: "suggest", text: "t" }), ["采纳", "换一个"]);
  assert.deepEqual(buttonsOf({ kind: "ask", text: "t" }), []);
});

test("新消息里只写助手的话、系统说明与界面操作；自己说的话不复述", () => {
  const text = renderMessages([
    { type: "system_note", message_id: "s", text: "任务现状" },
    { type: "user_message", message_id: "u", text: "我说的" },
    { type: "assistant_reply", message_id: "a", text: "收到", act: null },
  ]);
  assert.equal(text, "系统说明：任务现状\n\n助手说：收到");
  assert.equal(renderMessages([]), "（助手这次没有说新的话。）");
});

test("条目区：清单与单个条目的字段；不给完成条件与版本历史", () => {
  const task = {
    definition: { collections: [{ name: "功能用例", fields: [{ name: "用例名称" }, { name: "基本流程" }] }, { name: "约束", fields: [{ name: "需求语句" }] }] },
    items: [{ item_id: "UC-001", collection: "功能用例", title: "提交申请", revision_no: 2, fields: { 用例名称: "提交申请", 基本流程: ["填表", "提交"] },
              confirmations: [{ revision_no: 2, accepted: true }] }],
  };
  assert.equal(renderItems(task), "条目区：\n  功能用例 1 个：UC-001「提交申请」\n  约束 0 个");
  assert.equal(renderItems(task, "UC-001"), "UC-001「提交申请」，集合「功能用例」，修订 2（你正在看它现在的内容，看过就算确认）：\n  用例名称：提交申请\n  基本流程：1. 填表；2. 提交");
  assert.equal(renderItems(task, "UC-009"), "条目区里没有 UC-009。");
  // 当前修订上没有接受标记的条目在清单里标「未读」。
  const unread = { ...task, items: [{ ...task.items[0], viewed: false }] };
  assert.equal(renderItems(unread), "条目区：\n  功能用例 1 个：UC-001「提交申请」（未读）\n  约束 0 个");
});

test("回应的翻译：「这几条都看过了」走 actions 的 mark_viewed 带通知；其余按钮走 messages 带 card 与模板句；说话走 messages", () => {
  assert.deepEqual(planRespond({ click: "这几条都看过了" }, confirmReply, "c1"), { kind: "action", body: {
    client_id: "c1", kind: "mark_viewed", notify_executor: true,
    targets: [{ item_id: "UC-001", base_revision: 1 }, { item_id: "UC-002", base_revision: 2 }] } });
  assert.deepEqual(planRespond({ click: "不对" }, confirmReply, "c2"), { kind: "message", body: {
    text: "这个不对。", client_id: "c2", origin: "card_choice", card: { reply_message_id: "a1", kind: "confirm", choice: "不对" } } });
  assert.equal((planRespond({ click: "不对", text: "UC-002 少了风控" }, confirmReply, "c3") as any).body.text, "UC-002 少了风控");
  assert.equal((planRespond({ click: "b" }, chooseReply, "c4") as any).body.text, "我选：还书");
  assert.deepEqual(planRespond({ text: "先做借书" }, null, "c5"), { kind: "message", body: { text: "先做借书", client_id: "c5" } });
  assert.deepEqual(planRespond({ done: true }, null, "c6"), { kind: "none" });
});

test("回应的形式核对：逐条说明哪里不对", () => {
  assert.throws(() => planRespond({}, null, "c"), /要么写 text 说一句话/);
  assert.throws(() => planRespond({ give_up: true }, null, "c"), /give_up 要配一句 reason/);
  assert.throws(() => planRespond({ done: true, give_up: true, reason: "烦" }, null, "c"), /done 与 give_up 不能同时为真/);
  assert.throws(() => planRespond({ click: "这几条都看过了" }, chooseReply, "c"), /没有「这几条都看过了」这个按钮，可以点的是：借书／还书/);
  assert.throws(() => planRespond({ click: "这几条都看过了" }, null, "c"), /没有可以点的按钮/);
  assert.throws(() => planRespond({ click: "确认", text: "好" }, confirmReply, "c"), /点这个按钮时不要同时写 text/);
});

test("告知点名的条目：有卡片时跟在那条告知后面；没有卡片时正文下方一行「提到的条目」，同一个条目只列一次", () => {
  const informs = [{ text: "材料写明保留 3 天。", items: [{ item_id: "UC-004" }] }, { text: "也牵涉 UC-004 与 UC-001。", items: [{ item_id: "UC-004" }, { item_id: "UC-001" }] }];
  assert.equal(renderReply({ type: "assistant_reply", message_id: "n", text: "有，保留 3 天。", informs, act: null }),
    "助手说：有，保留 3 天。\n提到的条目：UC-004、UC-001");
  assert.equal(renderReply({ type: "assistant_reply", message_id: "w", text: "问一件事。", informs: [informs[0], { text: "没点名。" }],
    act: { kind: "ask", text: "你希望保留几天？", scope: "general" } }).split("\n").slice(0, 2).join("\n"),
    "助手告诉你：材料写明保留 3 天。（UC-004）\n助手告诉你：没点名。");
});

test("scope 为 general 的提问不列涉及的条目；degraded 的回复照普通文字显示加一行说明，不画卡片、不能点按钮", () => {
  const general = renderReply({ type: "assistant_reply", message_id: "g", text: "先问个总体的事。", informs: ["存了 1 个用例。"],
    act: { kind: "ask", text: "这次的范围包括售后吗？", scope: "general" } });
  assert.equal(general, "助手告诉你：存了 1 个用例。\n助手说：先问个总体的事。\n【卡片：提问】这次的范围包括售后吗？\n这张卡片没有按钮，直接回一句话。");

  const degraded = { type: "assistant_reply", message_id: "d", text: "请确认 UC-001。", informs: ["改了 UC-001。"], degraded: true,
    act: { kind: "confirm" as const, text: "请确认", items: [{ item_id: "UC-001", revision_no: 2 }] } };
  assert.equal(renderReply(degraded), "（界面注明：这条回复没有按结构发出。）\n助手说：请确认 UC-001。");
  assert.throws(() => planRespond({ click: "确认" }, degraded, "sim-1"), /没有可以点的按钮/);
});

test("提问挂在条目上时与前端一样有「先不管」与「我不知道，你按常识补」两类按钮，翻译成 keep_pending 直接操作与模板句", () => {
  const task = {
    definition: { collections: [
      { name: "功能用例", fields: [{ name: "用例名称", type: "文本", values: null }] },
      { name: "问题", fields: [{ name: "事项", type: "文本" }, { name: "状态", type: "枚举", values: ["未解决", "已解决", "用户决定保留"] }] },
    ] },
    items: [
      { item_id: "UC-001", collection: "功能用例", title: "借书", revision_no: 2, fields: {} },
      { item_id: "TBD-001", collection: "问题", title: "续借几次", revision_no: 3, fields: {} },
      { item_id: "TBD-002", collection: "问题", title: "罚款", revision_no: 1, fields: {} },
    ],
  };
  const ask = (items: { item_id: string; revision_no: number }[]) =>
    ({ type: "assistant_reply", message_id: "q1", text: "问一件事。", act: { kind: "ask" as const, text: "续借几次？", items } });

  const one = ask([{ item_id: "TBD-001", revision_no: 3 }]);
  assert.deepEqual(buttonsOf(one.act, task), ["先不管这条", "我不知道，你按常识补"]);
  assert.match(renderReply(one, task), /可以点：先不管这条／我不知道，你按常识补（也可以直接回一句话）$/);
  assert.deepEqual(planRespond({ click: "先不管这条" }, one, "sim-1", task),
    { kind: "action", body: { client_id: "sim-1", kind: "keep_pending", notify_executor: true, targets: [{ item_id: "TBD-001", base_revision: 3 }] } });
  assert.deepEqual(planRespond({ click: "我不知道，你按常识补" }, one, "sim-2", task),
    { kind: "message", body: { text: "关于 TBD-001，我不知道，你按常识补上并标明是你补的。", client_id: "sim-2", origin: "card_choice",
      card: { reply_message_id: "q1", kind: "ask", choice: "不知道" } } });

  const many = ask([{ item_id: "UC-001", revision_no: 2 }, { item_id: "TBD-001", revision_no: 3 }, { item_id: "TBD-002", revision_no: 1 }]);
  assert.deepEqual(buttonsOf(many.act, task), ["先不管 TBD-001", "先不管 TBD-002", "我不知道，你按常识补"]);
  assert.deepEqual((planRespond({ click: "先不管 TBD-002" }, many, "sim-3", task) as any).body.targets, [{ item_id: "TBD-002", base_revision: 1 }]);

  // 只挂功能用例：没有「先不管」，只有「不知道」；scope general 与不挂条目的提问没有按钮。
  assert.deepEqual(buttonsOf(ask([{ item_id: "UC-001", revision_no: 2 }]).act, task), ["我不知道，你按常识补"]);
  assert.deepEqual(buttonsOf({ kind: "ask", text: "t", scope: "general" }, task), []);
  assert.throws(() => planRespond({ click: "先不管这条" }, ask([{ item_id: "UC-001", revision_no: 2 }]), "sim-4", task), /没有「先不管这条」这个按钮/);
});

const page = (id: string, title: string, more: Record<string, unknown> = {}) => ({
  item_id: id, collection: "业务说明", title, revision_no: 2, fields: { 标题: title, 标签: [], 状态: "在用" }, ...more,
});
const overallTask = (items: ReturnType<typeof page>[]) => ({
  definition: { collections: [{ name: "功能用例", fields: [{ name: "用例名称" }] }, { name: "业务说明", fields: [{ name: "标题" }, { name: "标签" }, { name: "状态" }] }] },
  items: [{ item_id: "UC-001", collection: "功能用例", title: "借书", revision_no: 1, fields: { 用例名称: "借书" }, viewed: false }, ...items],
});

test("业务说明在条目区里写成提纲：每页一行，写标签与四种状态之一；别的集合照旧", () => {
  const seen = { revision_no: 2, accepted: true, basis: "viewed" };
  const text = renderItems(overallTask([
    page("OA-001", "借书", { fields: { 标题: "借书", 标签: ["流程"], 状态: "在用" }, confirmations: [seen], viewed: true }),
    page("OA-002", "读者", { fields: { 标题: "读者", 标签: ["角色", "概念"], 状态: "在用" }, confirmations: [{ ...seen, revision_no: 1 }], viewed: true }),
    page("OA-003", "预约保留期", { pending_verification: true, pending_sources: 2, confirmations: [] }),
    page("OA-004", "旧说法", { fields: { 标题: "旧说法", 标签: ["概念"], 状态: "已废弃" }, pending_verification: true }),
  ]));
  assert.equal(text, [
    "条目区：",
    "  功能用例 1 个：UC-001「借书」（未读）",
    "  业务说明 4 页：",
    "    OA-001「借书」〔流程〕：你看过现在这一版了",
    "    OA-002「读者」〔角色、概念〕：你还没看过现在这一版",      // 看过的是修订 1，现在是修订 2
    "    OA-003「预约保留期」：有 2 处是助手补的，等你确认",
    "    OA-004「旧说法」〔概念〕：已废弃",
  ].join("\n"));
  assert.equal(renderItems(overallTask([])).split("\n")[2], "  业务说明 0 页");
});

test("看没看过现在这一版：只看当前修订上最近一条不是亲手改的标记；待核实的处数与网页同一个算法", () => {
  const item = (confirmations: { revision_no: number; accepted: boolean; basis?: string }[]) => page("OA-001", "借书", { confirmations });
  assert.equal(viewedNow(item([{ revision_no: 2, accepted: true, basis: "viewed" }])), true);
  assert.equal(viewedNow(item([{ revision_no: 2, accepted: true, basis: "viewed" }, { revision_no: 2, accepted: false, basis: "ui_click" }])), false);   // 最近一条是撤回
  assert.equal(viewedNow(item([{ revision_no: 2, accepted: true, basis: "ui_edit" }])), false);                                                        // 亲手改不算看过
  assert.equal(viewedNow(item([{ revision_no: 1, accepted: true, basis: "viewed" }])), false);                                                         // 看的是旧修订
  assert.equal(viewedNow(item([])), false);
  assert.deepEqual([pendingCount(page("OA-001", "借书")), pendingCount(page("OA-001", "借书", { pending_verification: true })),
    pendingCount(page("OA-001", "借书", { pending_verification: true, pending_sources: 3 }))], [0, 1, 3]);
});

test("打开一个条目记不记已读与网页同一个规矩：待核实的主题页打开不记，带确认才记；别的照旧打开就记", () => {
  const task = overallTask([
    page("OA-001", "借书"),
    page("OA-002", "预约保留期", { fields: { 标题: "预约保留期", 标签: ["概念"], 状态: "在用", 例子: ["保留 3 天"], 它是什么: "书为预约的人留着的那段时间。" },
      pending_verification: true, pending_sources: 2, pending_places: [{ field: "例子", index: 0 }, { field: "它是什么", index: null }] }),
  ]);
  task.definition.collections[1].fields.push({ name: "它是什么" }, { name: "例子" });
  task.items[0].pending_verification = true;      // 用例上有助手补的内容：不是主题页，照旧打开就记
  assert.deepEqual(viewOnLook(task, "OA-001"), { item_id: "OA-001", base_revision: 2 });
  assert.equal(viewOnLook(task, "OA-002"), null);
  assert.deepEqual(viewOnLook(task, "OA-002", true), { item_id: "OA-002", base_revision: 2 });
  assert.deepEqual(viewOnLook(task, "OA-001", true), { item_id: "OA-001", base_revision: 2 });      // 不待核实的页带了确认：照普通的看
  assert.deepEqual(viewOnLook(task, "UC-001"), { item_id: "UC-001", base_revision: 1 });
  assert.equal(viewOnLook(task, "OA-009"), null);
  // 看到的文字：待核实的页写明还有哪几处等确认、怎样确认；确认之后写确认了几处。
  const looked = renderItems(task, "OA-002");
  assert.match(looked, /^OA-002「预约保留期」，集合「业务说明」，修订 2（你正在看它现在的内容）：/);
  assert.match(looked, /\n这一页有 2 处是助手补的，还没有确认：「例子」第 1 项、「它是什么」。你看了觉得对，就再看一次这一页并把 confirm 设为 true；觉得不对，直接说哪里不对。$/);
  const confirmed = renderItems(task, "OA-002", true);
  assert.match(confirmed, /修订 2（你正在看它现在的内容，并确认了助手补的 2 处）：/);
  assert.doesNotMatch(confirmed, /还没有确认/);
  assert.match(renderItems(task, "OA-001", true), /修订 2（你正在看它现在的内容，看过就算确认）：/);
});

test("请选择卡片的选项按键点或按文字点都行，发出去的请求相同；别的卡片的按钮名不受影响", () => {
  const startReply = { type: "assistant_reply", message_id: "a9", text: "现在开始写条目吗？",
    act: { kind: "choose" as const, text: "这几页你看过之后，现在开始写条目吗？", items: [{ item_id: "OA-001", revision_no: 1 }],
      options: [{ key: "start_items", text: "开始写条目" }, { key: "continue_clarify", text: "继续澄清" }] } };
  const byKey = planRespond({ click: "start_items" }, startReply, "c1");
  assert.deepEqual(byKey, { kind: "message", body: { text: "我选：开始写条目", client_id: "c1", origin: "card_choice",
    card: { reply_message_id: "a9", kind: "choose", choice: "start_items" } } });
  assert.deepEqual(planRespond({ click: "开始写条目" }, startReply, "c1"), byKey);
  // 这是一张进入卡片：留在这一段的那一项照助手写的文字点也认，发的是界面操作（见下一例）。
  assert.equal((planRespond({ click: " 继续澄清 " }, startReply, "c2") as any).body.fields.option_key, "continue_clarify");
  assert.throws(() => planRespond({ click: "先看看再说" }, startReply, "c"), /没有「先看看再说」这个按钮，可以点的是：开始写条目／继续本阶段/);
  assert.deepEqual([optionKeyOf(startReply.act, "开始写条目"), optionKeyOf(confirmReply.act, "不对"), optionKeyOf(null, "x")], ["start_items", "不对", "x"]);
  assert.deepEqual([buttonLabels(startReply.act), buttonLabels(confirmReply.act)], [["开始写条目", "继续本阶段"], ["这几条都看过了", "不对"]]);
  // 请确认卡片照旧。
  assert.equal((planRespond({ click: "这几条都看过了" }, confirmReply, "c3") as any).body.kind, "mark_viewed");
});

test("提议进入下一个阶段的卡片上留在这一段的那一项：显示成「继续本阶段」，点了发界面操作 continue_stage，不发话；别的请选择卡片不受影响", () => {
  // 助手把这一项写成了早先的说法：界面上照样显示「继续本阶段」，按键、按「继续本阶段」、按助手写的文字点都认。
  const card = { kind: "choose" as const, text: "材料核读完了，进入澄清吗？", items: [{ item_id: "OA-001", revision_no: 1 }],
    options: [{ key: "enter_clarify", text: "进入澄清" }, { key: "continue_reading", text: "再核读一遍" }] };
  const reply = { type: "assistant_reply", message_id: "a7", text: "进入澄清吗？", act: card };
  assert.deepEqual([isStageCard(card), isStayOption(card, "continue_reading"), isStayOption(card, "enter_clarify")], [true, true, false]);
  assert.deepEqual(buttonLabels(card), ["进入澄清", "继续本阶段"]);
  const shown = renderReply(reply as any);
  assert.match(shown, /\n选项 continue_reading：继续本阶段\n/);
  assert.match(shown, /\n可以点：进入澄清／继续本阶段（/);
  const stay = { kind: "action", body: { client_id: "c1", kind: "continue_stage", targets: [], notify_executor: false,
    fields: { reply_message_id: "a7", option_key: "continue_reading" } } };
  assert.deepEqual(planRespond({ click: "continue_reading" }, reply, "c1"), stay);
  assert.deepEqual(planRespond({ click: "继续本阶段" }, reply, "c1"), stay);
  assert.deepEqual(planRespond({ click: "再核读一遍" }, reply, "c1"), stay);
  assert.equal(CONTINUE_STAGE, "continue_stage");
  assert.equal(STAY_TEXT, "继续本阶段");
  // 进入的那一项照旧发话；点「继续本阶段」时也不能同时写一句话。
  assert.equal((planRespond({ click: "进入澄清" }, reply, "c2") as any).body.card.choice, "enter_clarify");
  assert.throws(() => planRespond({ click: "继续本阶段", text: "还有一件事" }, reply, "c3"), /点这个按钮时不要同时写 text/);
  // 以后才有的键也认：进入的键以 enter_ 开头，留在这一段的键以 continue_ 开头。
  const later = { kind: "choose" as const, text: "进入编写文档吗？", options: [{ key: "enter_document", text: "进入编写文档" }, { key: "continue_reviewing", text: "再看看" }] };
  assert.deepEqual(buttonLabels(later), ["进入编写文档", "继续本阶段"]);
  // 不是进入卡片：键以 continue_ 开头的选项照它写的显示，照旧发话（完成任务那张卡片的两个键是 complete 与 continue）。
  const other = { type: "assistant_reply", message_id: "a8", text: "",
    act: { kind: "choose" as const, text: "要不要接着读？", options: [{ key: "continue_reading", text: "接着读" }, { key: "stop", text: "先停" }] } };
  assert.deepEqual([isStageCard(other.act), buttonLabels(other.act)], [false, ["接着读", "先停"]]);
  assert.equal((planRespond({ click: "接着读" }, other, "c4") as any).body.text, "我选：接着读");
});

test("提议退回前面阶段的卡片：「留在本段」不管助手写成什么都显示这四个字，点了发界面操作 continue_stage；退回的那一项照旧发话", () => {
  const card = { kind: "choose" as const, text: "你放进了一份新材料，前面几页要重来。退回澄清吗？", items: [],
    options: [{ key: "back_to_clarify", text: "退回澄清" }, { key: "stay_in_stage", text: "先不退" }] };
  const reply = { type: "assistant_reply", message_id: "b1", text: "退回澄清吗？", act: card };
  assert.deepEqual([proposalKind(card), isStageCard(card), isStayOption(card, "stay_in_stage"), isStayOption(card, "back_to_clarify")], ["back", false, true, false]);
  assert.deepEqual(buttonLabels(card), ["退回澄清", "留在本段"]);
  assert.match(renderReply(reply as any), /\n选项 stay_in_stage：留在本段\n/);
  const stay = { kind: "action", body: { client_id: "c1", kind: "continue_stage", targets: [], notify_executor: false, fields: { reply_message_id: "b1", option_key: "stay_in_stage" } } };
  assert.deepEqual([planRespond({ click: "留在本段" }, reply, "c1"), planRespond({ click: "先不退" }, reply, "c1"), planRespond({ click: "stay_in_stage" }, reply, "c1")], [stay, stay, stay]);
  assert.deepEqual(planRespond({ click: "退回澄清" }, reply, "c2"), { kind: "message", body: { text: "我选：退回澄清", client_id: "c2", origin: "card_choice",
    card: { reply_message_id: "b1", kind: "choose", choice: "back_to_clarify" } } });
  assert.equal(STAY_HERE_TEXT, "留在本段");
});

test("编写文档阶段请过目的卡片：「看过了，生成文档」不发话，先发 continue_stage、再把卡片点名的页标为已读；「需要修改」只发 continue_stage", () => {
  const card = { kind: "choose" as const, text: "补写了两章的导语，请过目。", items: [{ item_id: "OA-020", revision_no: 1 }, { item_id: "OA-021", revision_no: 2 }],
    options: [{ key: "document_reviewed", text: "看过了，生成文档" }, { key: "document_revise", text: "要改" }] };
  const reply = { type: "assistant_reply", message_id: "d1", text: "请过目。", act: card };
  assert.deepEqual([proposalKind(card), isReviewedOption(card, "document_reviewed"), isStayOption(card, "document_revise"), isStayOption(card, "document_reviewed")],
    ["review", true, true, false]);
  assert.deepEqual(buttonLabels(card), ["看过了，生成文档", "需要修改"]);
  assert.deepEqual(planRespond({ click: "看过了，生成文档" }, reply, "c1"), {
    kind: "action",
    body: { client_id: "c1", kind: "continue_stage", targets: [], notify_executor: false, fields: { reply_message_id: "d1", option_key: "document_reviewed" } },
    then: { client_id: "c1-viewed", kind: "mark_viewed", notify_executor: false, targets: [{ item_id: "OA-020", base_revision: 1 }, { item_id: "OA-021", base_revision: 2 }] },
  });
  assert.deepEqual(planRespond({ click: "需要修改" }, reply, "c2"),
    { kind: "action", body: { client_id: "c2", kind: "continue_stage", targets: [], notify_executor: false, fields: { reply_message_id: "d1", option_key: "document_revise" } } });
  // 卡片没有点名页：只发那一个界面操作。
  const bare = { ...reply, act: { ...card, items: [] } };
  assert.equal("then" in planRespond({ click: "document_reviewed" }, bare, "c3"), false);
  assert.equal(DOCUMENT_REVISE_TEXT, "需要修改");
  // 不是提议的卡片上同名的键不算。
  assert.equal(proposalKind({ kind: "ask", text: "？" } as any), null);
  assert.equal(isReviewedOption({ kind: "choose", text: "", options: [{ key: "enter_clarify", text: "进入澄清" }, { key: "document_reviewed", text: "看过了" }] } as any, "document_reviewed"), false);
});

/** 空闲的新任务（有材料）在任务状况卡上的「开展一项活动」一节。 */
const LAUNCH: LaunchView = {
  current: null,
  flows: [{ activity: "reading", in_flow: true, label: "启动需求分析", enabled: true, state: "从核读材料开始" }],
  activities: [
    { activity: "reading", in_flow: false, label: "核读材料", enabled: true, state: "可以开展" }, { activity: "clarifying", in_flow: false, label: "澄清", enabled: true, state: "可以开展" },
    { activity: "writing", in_flow: false, label: "写条目", enabled: false, state: "业务说明还没有页" },
  ],
  later: [{ label: "发布", state: "0.6 后续" }],
};
const RESUME: LaunchView = { ...LAUNCH, current: { activity: "clarifying", in_flow: false, label: "继续澄清" },
  flows: [{ activity: "writing", in_flow: true, label: "继续需求分析（从写条目接着）", enabled: true, state: "可以开展" }] };

test("看界面里「开展一项活动」一节：写正在进行什么、流程与单独开展的各项，不能选的写明缺什么；没有这一节时什么都不写", () => {
  assert.equal(renderLaunch(LAUNCH), [
    "任务状况卡上的「开展一项活动」（不是必须选；想选就在 respond 的 launch 里照下面的写法写一项，不选可以直接说话）：",
    "  现在没有在进行的活动，任务空闲。",
    "  流程：启动需求分析",
    "  单独开展：单独开展：核读材料、单独开展：澄清、单独开展：写条目（现在不能选：业务说明还没有页）",
  ].join("\n"));
  assert.match(renderLaunch(RESUME), /\n  正在进行：继续澄清\n  流程：继续需求分析（从写条目接着）\n/);
  assert.deepEqual([renderLaunch(null), renderLaunch(undefined)], ["", ""]);
});

test("在这一节里选一项：流程写按钮上的字（「继续需求分析」后面的括号可以不写），单独开展写「单独开展：活动名」，写「不选」是不选；找不到、不能选时写明原因", () => {
  assert.deepEqual(launchOption(LAUNCH, "启动需求分析"), LAUNCH.flows[0]);
  assert.deepEqual(launchOption(RESUME, " 继续需求分析 "), RESUME.flows[0]);
  assert.deepEqual(launchOption(RESUME, "继续需求分析（从写条目接着）"), RESUME.flows[0]);
  assert.deepEqual(launchOption(LAUNCH, "单独开展：澄清"), LAUNCH.activities[1]);
  assert.equal(launchOption(LAUNCH, LAUNCH_SKIP), null);
  assert.equal(LAUNCH_SKIP, "不选");
  assert.throws(() => launchOption(LAUNCH, "继续需求分析"), /「开展一项活动」里没有「继续需求分析」这一项，可以写的是：启动需求分析／单独开展：核读材料／单独开展：澄清／单独开展：写条目／不选/);
  assert.throws(() => launchOption(LAUNCH, "单独开展：写条目"), /「单独开展：写条目」现在不能选：业务说明还没有页/);
  assert.throws(() => launchOption(LAUNCH, "澄清"), /没有「澄清」这一项/);
  assert.throws(() => launchOption(null, "启动需求分析"), /现在没有「开展一项活动」这一节/);
});

test("选一项发的是界面操作 start_activity：不发话，助手不因此运行；不选什么都不发；不与说话、点按钮同时写", () => {
  assert.equal(START_ACTIVITY, "start_activity");
  assert.deepEqual(planLaunch(LAUNCH, "启动需求分析", "c1"), { kind: "action",
    body: { client_id: "c1", kind: "start_activity", targets: [], notify_executor: false, fields: { activity: "reading", in_flow: true } } });
  assert.deepEqual(planLaunch(LAUNCH, "不选", "c1"), { kind: "none" });
  const task = { definition: { collections: [] }, items: [], stage: { current: "idle", launch: LAUNCH } };
  assert.deepEqual(planRespond({ launch: "单独开展：澄清" }, null, "c2", task), { kind: "action",
    body: { client_id: "c2", kind: "start_activity", targets: [], notify_executor: false, fields: { activity: "clarifying", in_flow: false } } });
  assert.deepEqual(planRespond({ launch: "不选" }, null, "c3", task), { kind: "none" });
  assert.throws(() => planRespond({ launch: "启动需求分析", text: "开始吧" }, null, "c4", task), /选「开展一项活动」里的一项时不要同时写 text 或 click；要说话就另外回一次/);
  assert.throws(() => planRespond({ launch: "单独开展：写条目" }, null, "c5", task), /这次回应的形式不对，没有发出去：「单独开展：写条目」现在不能选：业务说明还没有页。/);
  assert.throws(() => planRespond({ launch: "启动需求分析" }, null, "c6", { definition: { collections: [] }, items: [] }), /现在没有「开展一项活动」这一节/);
});
