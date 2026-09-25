/** 用户 agent 眼里的界面与「回应」的翻译：渲染回复与条目区、按钮、参数核对、按约定第 5.4 节走 actions 还是 messages。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buttonsOf, planRespond, renderItems, renderMessages, renderReply } from "../lib/screen.ts";

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
  assert.match(renderReply(chooseReply), /选项 a：借书\n选项 b：还书\n可以点：a／b/);
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
  assert.throws(() => planRespond({ click: "这几条都看过了" }, chooseReply, "c"), /没有「这几条都看过了」这个按钮，可以点的是：a／b/);
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
