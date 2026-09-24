/**
 * 「回复」的核对函数：五种主行为各一个合格样例，每条核对规则各一个被拒样例，
 * 以及「请确认」引用不存在的条目、已删除的条目或条目不在的修订时被拒。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { checkReply, consecutiveReplyRejections, decideReply, lastAssistantTurn, openRevisionLookup, type ReplyFacts } from "../src/lib/reply.ts";
import { FALLBACK_TEXT } from "../src/hooks/reply_fallback.ts";
import { DEFINITION_PATH, SOURCE, callIn, makeWorkspace } from "./helpers.ts";

/** 只有自己一个调用、库里什么都没有时的事实。 */
function alone(revisionFact: ReplyFacts["revisionFact"] = () => "还没有库"): ReplyFacts {
  return { toolCallId: "call-reply", callsThisTurn: [{ id: "call-reply", name: "reply" }], revisionFact };
}

/** 按一张表回答条目与修订的事实：UC-001 在修订 1、2 改动过，当前在修订 2；TBD-001 只在修订 1；UC-002 已删除。 */
const table: ReplyFacts["revisionFact"] = (itemId, revisionNo) => {
  if (itemId === "UC-002") return "条目已删除";
  if (itemId === "TBD-001") return revisionNo === 1 ? "是当前所在的修订" : "这次修订没有改动它";
  if (itemId !== "UC-001") return "没有这个条目";
  return revisionNo === 2 ? "是当前所在的修订" : revisionNo === 1 ? "不是当前所在的修订" : "这次修订没有改动它";
};

function rejected(params: unknown, facts: ReplyFacts, pattern: RegExp): void {
  assert.throws(() => checkReply(params, facts), (error: Error) => {
    assert.match(error.message, pattern);
    assert.match(error.message, /没有送达/);
    return true;
  });
}

const BASIS = [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: "退款须在七天内处理完毕。" }];

// ───────────── 合格样例 ─────────────

test("没有主行为：只有告知与成文的话", () => {
  const reply = checkReply({ informs: ["我记下了两条约束。"], act: null, text: "我记下了两条约束。" }, alone());
  assert.deepEqual(reply, { informs: ["我记下了两条约束。"], act: null, text: "我记下了两条约束。" });
});

test("提问 ask 合格：点名关联的问题与它当前所在的修订", () => {
  const act = { kind: "ask", text: "退款由谁审批？", items: [{ item_id: "TBD-001", revision_no: 1 }] };
  const reply = checkReply({ informs: [], act, text: "材料里没写审批人。退款由谁审批？" }, alone(table));
  assert.deepEqual(reply.act, act);
});

test("提问 ask 合格：与条目无关的问题写 scope: general，不写 items", () => {
  const act = { kind: "ask", text: "今天先整理到哪里为止？", scope: "general" };
  assert.deepEqual(checkReply({ informs: [], act, text: "今天先整理到哪里为止？" }, alone()).act, act);
});

test("请确认 confirm 合格：点名的条目与修订号都在库里", () => {
  const params = {
    informs: ["UC-001 已经按你的意思改好了。"],
    act: { kind: "confirm", text: "请确认 UC-001（修订 2）。", items: [{ item_id: "UC-001", revision_no: 2 }] },
    text: "UC-001 已经改好了，请确认。",
  };
  assert.deepEqual(checkReply(params, alone(table)).act?.items, [{ item_id: "UC-001", revision_no: 2 }]);
});

test("给建议值 suggest 合格：带值与依据", () => {
  const params = {
    informs: [],
    act: { kind: "suggest", text: "处理时限建议写成七天。", value: "七天", basis: BASIS, items: [{ item_id: "UC-001", revision_no: 2 }] },
    text: "处理时限我建议写成七天，材料里是这样写的。",
  };
  const reply = checkReply(params, alone(table));
  assert.equal(reply.act?.value, "七天");
  assert.deepEqual(reply.act?.basis, BASIS);
});

test("请选择 choose 合格：两个以上选项、key 不重复", () => {
  const params = {
    informs: [],
    act: { kind: "choose", text: "先整理哪一块？", options: [{ key: "a", text: "退货流程" }, { key: "b", text: "退款到账" }] },
    text: "先整理哪一块？",
  };
  assert.equal(checkReply(params, alone()).act?.options?.length, 2);
});

test("提议 propose 合格：带预览", () => {
  const params = {
    informs: [],
    act: {
      kind: "propose", text: "把两条重复的用例合成一条。", items: [{ item_id: "UC-001", revision_no: 2 }],
      preview: [{ effect: "remove", text: "删掉 UC-001" }, { effect: "change", text: "改写 UC-003" }],
    },
    text: "UC-001 与 UC-003 说的是一件事，我提议合成一条。",
  };
  assert.equal(checkReply(params, alone(table)).act?.preview?.length, 2);
});

test("提议 propose 不带预览也合格：会不会撤掉或大改条目属于内容判断，代码不查", () => {
  const params = { informs: [], act: { kind: "propose", text: "下一步先整理约束。", scope: "general" }, text: "下一步我先整理约束，可以吗？" };
  assert.equal(checkReply(params, alone()).act?.kind, "propose");
});

// ───────────── 第 1 条：单独调用 ─────────────

test("同一轮里有别的工具调用时拒绝，并列出那些调用", () => {
  const facts: ReplyFacts = {
    toolCallId: "call-reply",
    callsThisTurn: [{ id: "call-save", name: "save_revision" }, { id: "call-reply", name: "reply" }],
    revisionFact: table,
  };
  rejected({ informs: [], act: null, text: "好了。" }, facts, /回复必须单独调用，不能与其他工具同一轮.*save_revision/);
});

// ───────────── 第 2 条：各种类的必填项与多余项 ─────────────

test("缺 informs、act、text 三项时逐条说明", () => {
  assert.throws(() => checkReply({}, alone()), (error: Error) => {
    assert.match(error.message, /缺少 informs/);
    assert.match(error.message, /缺少 act/);
    assert.match(error.message, /缺少 text/);
    return true;
  });
});

test("顶层多了一项时拒绝", () => {
  rejected({ informs: [], act: null, text: "好。", extra: 1 }, alone(), /多了「extra」这一项/);
});

test("键名写坏了（带引号与冒号）时，拒绝理由点明像是 JSON 写坏了", () => {
  // 取自本地模型试跑里的真实参数：items 很长之后，text 的键名被写成了「text': 」。
  rejected(
    { informs: [], act: { kind: "confirm", items: [{ item_id: "UC-001", revision_no: 1 }], "text': ": ", " }, text: "请确认。" },
    alone(table),
    /act 里有一个键名写成了「text': 」[^。]*像是 JSON 写坏了[\s\S]*act\.text 是空的/,
  );
  // kind 的键名也写坏时，照样先报出写坏的键名，而不只是说「kind 是 undefined」。
  rejected(
    { informs: [], act: { items: [], "kind': ": "", "text': ": ", " }, text: "请确认。" },
    alone(table),
    /键名写成了「kind': 」[\s\S]*键名写成了「text': 」[\s\S]*act\.kind 写的是 undefined/,
  );
});

test("act.kind 不在五种之内时拒绝", () => {
  rejected({ informs: [], act: { kind: "inform", text: "x" }, text: "x" }, alone(), /act\.kind 写的是 "inform"/);
});

test("act.text 为空时拒绝", () => {
  rejected({ informs: [], act: { kind: "ask", text: "  " }, text: "x" }, alone(), /act\.text 是空的/);
});

test("请确认没有写 items 时拒绝", () => {
  rejected({ informs: [], act: { kind: "confirm", text: "请确认。" }, text: "请确认。" }, alone(table), /请确认（confirm）要写 act\.items/);
});

test("请确认的条目没有写修订号时拒绝", () => {
  rejected(
    { informs: [], act: { kind: "confirm", text: "请确认。", items: [{ item_id: "UC-001" }] }, text: "请确认。" },
    alone(table),
    /UC-001）缺少 revision_no/,
  );
});

test("修订号不是正整数时拒绝", () => {
  rejected(
    { informs: [], act: { kind: "confirm", text: "请确认。", items: [{ item_id: "UC-001", revision_no: 0 }] }, text: "请确认。" },
    alone(table),
    /revision_no 应当是一个从 1 起的整数/,
  );
});

test("请选择只有一个选项时拒绝", () => {
  rejected(
    { informs: [], act: { kind: "choose", text: "选哪个？", options: [{ key: "a", text: "甲" }] }, text: "选哪个？" },
    alone(),
    /至少两个选项/,
  );
});

test("请选择的 key 重复时拒绝", () => {
  rejected(
    { informs: [], act: { kind: "choose", text: "选哪个？", options: [{ key: "a", text: "甲" }, { key: "a", text: "乙" }] }, text: "选哪个？" },
    alone(),
    /key「a」重复了/,
  );
});

test("给建议值没有写值时拒绝", () => {
  rejected({ informs: [], act: { kind: "suggest", text: "建议如下。", basis: BASIS }, text: "x" }, alone(), /要写 act\.value/);
});

test("给建议值没有写依据时拒绝", () => {
  rejected({ informs: [], act: { kind: "suggest", text: "建议如下。", value: "七天" }, text: "x" }, alone(), /要写 act\.basis/);
});

test("依据的种类不对或缺摘录时拒绝", () => {
  rejected(
    { informs: [], act: { kind: "suggest", text: "建议。", value: "七天", basis: [{ kind: "猜的", locator: "x", excerpt: "" }] }, text: "x" },
    alone(),
    /basis 的第 1 条的 kind 写的是 "猜的"[\s\S]*缺少 excerpt/,
  );
});

test("提议的预览 effect 不对时拒绝", () => {
  rejected(
    { informs: [], act: { kind: "propose", text: "提议。", preview: [{ effect: "merge", text: "合并" }] }, text: "x" },
    alone(),
    /effect 写的是 "merge"/,
  );
});

test("不属于这种主行为的项写了就拒绝：提问写了 options", () => {
  rejected(
    { informs: [], act: { kind: "ask", text: "问？", options: [{ key: "a", text: "甲" }, { key: "b", text: "乙" }] }, text: "问？" },
    alone(),
    /提问（ask）不写 act\.options；options 只属于请选择（choose）/,
  );
});

// ───────────── 第 3 条：成文的话与告知不能是空白 ─────────────

test("text 全是空白时拒绝", () => {
  rejected({ informs: [], act: null, text: "   " }, alone(), /text 全是空白/);
});

test("某条告知是空白时拒绝", () => {
  rejected({ informs: ["记下了。", " "], act: null, text: "记下了。" }, alone(), /informs 的第 2 条是空的/);
});

// ───────────── 请确认引用库里的条目 ─────────────

test("请确认引用不存在的条目、已删除的条目或条目不在的修订时被拒", () => {
  const act = (items: unknown) => ({ informs: [], act: { kind: "confirm", text: "请确认。", items }, text: "请确认。" });
  rejected(act([{ item_id: "UC-009", revision_no: 1 }]), alone(table), /库里没有条目 UC-009/);
  rejected(act([{ item_id: "UC-002", revision_no: 1 }]), alone(table), /UC-002 已经删除了/);
  rejected(act([{ item_id: "UC-001", revision_no: 3 }]), alone(table), /条目 UC-001 现在不是修订 3/);
  rejected(act([{ item_id: "UC-001", revision_no: 1 }]), alone(), /还没有任务数据库/);
});

test("按真实的库核对：条目在保存过的修订里查得到，没有改动它的修订查不到", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision({ ...callIn(dir), userMessages: [] }, {
    operations: [{ op: "add", collection: "用例", fields: { 名称: "买家申请退款", 步骤: ["提交申请"] }, sources: [SOURCE] }],
  });
  const lookup = openRevisionLookup(dir);
  try {
    assert.equal(lookup.revisionFact("UC-001", 1), "是当前所在的修订");
    assert.equal(lookup.revisionFact("UC-001", 2), "这次修订没有改动它");
    assert.equal(lookup.revisionFact("UC-404", 1), "没有这个条目");
  } finally {
    lookup.close();
  }
  assert.equal(openRevisionLookup(makeWorkspace()).revisionFact("UC-001", 1), "还没有库");
});

// ───────────── 从会话当前分支读这一轮 ─────────────

test("从会话分支找到最后一条助手消息与它的全部工具调用", () => {
  const branch = [
    { id: "u1", type: "message", message: { role: "user", content: "你好" } },
    { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read" }] } },
    { id: "t1", type: "message", message: { role: "toolResult", content: [] } },
    {
      id: "a2",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "" }, { type: "toolCall", id: "c2", name: "save_revision" }, { type: "toolCall", id: "c3", name: "reply" }] },
    },
  ];
  assert.deepEqual(lastAssistantTurn(branch), {
    entryId: "a2",
    calls: [{ id: "c2", name: "save_revision" }, { id: "c3", name: "reply" }],
  });
  assert.deepEqual(lastAssistantTurn([]), { entryId: null, calls: [] });
});

// ───────────── 提问、给建议值、提议必须挂条目 ─────────────

test("提问、给建议值、提议不点名条目又没写 scope: general 时拒绝，理由说明怎样改", () => {
  rejected({ informs: [], act: { kind: "ask", text: "退款由谁审批？" }, text: "退款由谁审批？" }, alone(table),
    /提问要写明问的是哪个条目或问题条目.*与条目无关的问题请写 scope: "general"/);
  rejected({ informs: [], act: { kind: "ask", text: "问。", items: [] }, text: "问。" }, alone(table), /提问要写明问的是哪个条目或问题条目/);
  rejected({ informs: [], act: { kind: "suggest", text: "建议七天。", value: "七天", basis: BASIS }, text: "建议七天。" }, alone(table),
    /建议要写明说的是哪个条目或问题条目/);
  rejected({ informs: [], act: { kind: "propose", text: "合成一条。" }, text: "合成一条。" }, alone(table), /提议要写明说的是哪个条目或问题条目/);
});

test("提问点名的条目要在库里、要写修订号、修订号要是条目当前所在的修订", () => {
  const ask = (items: unknown) => ({ informs: [], act: { kind: "ask", text: "问。", items }, text: "问。" });
  rejected(ask([{ item_id: "TBD-009", revision_no: 1 }]), alone(table), /库里没有条目 TBD-009/);
  rejected(ask([{ item_id: "TBD-001" }]), alone(table), /TBD-001）缺少 revision_no/);
  rejected(ask([{ item_id: "UC-001", revision_no: 1 }]), alone(table), /条目 UC-001 现在不是修订 1/);
});

test("scope 只能写 general；写了 general 就不能再点名条目；请确认不认 scope", () => {
  rejected({ informs: [], act: { kind: "ask", text: "问。", scope: "all" }, text: "问。" }, alone(table), /act\.scope 写的是 "all"/);
  rejected({ informs: [], act: { kind: "ask", text: "问。", scope: "general", items: [{ item_id: "TBD-001", revision_no: 1 }] }, text: "问。" },
    alone(table), /二者只能选一个/);
  rejected({ informs: [], act: { kind: "confirm", text: "请确认。", scope: "general" }, text: "请确认。" }, alone(table),
    /请确认（confirm）不写 act\.scope/);
});

test("请选择不点名条目也合格；点名了只核对形状", () => {
  const act = { kind: "choose", text: "发票已红冲的订单能退款吗？", options: [{ key: "a", text: "允许" }, { key: "b", text: "不允许" }] };
  assert.equal(checkReply({ informs: [], act, text: "问一件事。" }, alone()).act?.kind, "choose");
});

// ───────────── 请确认只允许条目当前所在的修订 ─────────────

test("请确认的修订号不是条目当前所在的修订时拒绝，并写明它现在在哪次修订", () => {
  const facts = { ...alone(table), currentRevisionOf: () => 2 };
  rejected({ informs: [], act: { kind: "confirm", text: "请确认。", items: [{ item_id: "UC-001", revision_no: 1 }] }, text: "请确认。" }, facts,
    /条目 UC-001 现在不是修订 1，它现在是修订 2；只能点名条目当前所在的修订/);
});

test("按真实的库核对：改过之后旧修订查出来是「不是当前所在的修订」", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision({ ...callIn(dir), userMessages: [] }, {
    operations: [{ op: "add", collection: "用例", fields: { 名称: "买家申请退款", 步骤: ["提交申请"] }, sources: [SOURCE] }],
  });
  saveRevision({ ...callIn(dir), userMessages: [] }, { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "申请退款" } }] });
  const lookup = openRevisionLookup(dir);
  try {
    assert.equal(lookup.revisionFact("UC-001", 1), "不是当前所在的修订");
    assert.equal(lookup.revisionFact("UC-001", 2), "是当前所在的修订");
    assert.equal(lookup.currentRevisionOf("UC-001"), 2);
  } finally {
    lookup.close();
  }
});

// ───────────── 连续被拒的上限 ─────────────

const BAD = { informs: [], act: { kind: "ask", text: "退款由谁审批？" }, text: "退款由谁审批？" };

test("第 1、2 次被拒照常给出逐条的理由", () => {
  for (const prior of [0, 1]) {
    assert.throws(() => decideReply(BAD, { ...alone(table), priorRejections: prior }), (error: Error) => {
      assert.match(error.message, /^这次回复的形式不对/);
      return true;
    });
  }
});

test("第 3 次起拒绝理由改为只写成文正文、主行为写 null，并附上一次的问题", () => {
  for (const prior of [2, 3]) {
    assert.throws(() => decideReply(BAD, { ...alone(table), priorRejections: prior }), (error: Error) => {
      assert.match(error.message, new RegExp(`连续第 ${prior + 1} 次没有送达。请不要再写告知与主行为：只写成文的话 text，informs 写 \\[\\]，act 写 null`));
      assert.match(error.message, /提问要写明问的是哪个条目/);
      return true;
    });
  }
});

test("第 5 次仍不合格时放行纯文字回复，标 degraded；正文取 text，没有 text 就取告知与主行为", () => {
  assert.deepEqual(decideReply(BAD, { ...alone(table), priorRejections: 4 }), {
    reply: { informs: [], act: null, text: "退款由谁审批？" },
    degraded: true,
  });
  const noText = { informs: ["我存好了 UC-001。"], act: { kind: "tell", text: "请看一下。" } };
  assert.deepEqual(decideReply(noText, { ...alone(table), priorRejections: 4 }).reply.text, "我存好了 UC-001。\n请看一下。");
  // 合格的回复不论之前被拒几次都照常送达，不标 degraded。
  const good = { informs: [], act: null, text: "好的。" };
  assert.deepEqual(decideReply(good, { ...alone(), priorRejections: 4 }), { reply: good, degraded: false });
  // 同一轮混入别的工具时不放行。
  assert.throws(() => decideReply(good, { ...alone(), callsThisTurn: [{ id: "call-reply", name: "reply" }, { id: "x", name: "ls" }], priorRejections: 4 }),
    /必须单独调用/);
});

test("从会话分支数连续被拒的次数：成功的回复与用户消息为界，兜底那句话不算界，别的工具不打断", () => {
  const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
  const replyResult = (isError: boolean) => ({ type: "message", message: { role: "toolResult", toolName: "reply", isError } });
  const other = { type: "message", message: { role: "toolResult", toolName: "ls", isError: false } };
  const custom = { type: "custom_message" };
  assert.equal(consecutiveReplyRejections([]), 0);
  assert.equal(consecutiveReplyRejections([user("你好"), replyResult(true), other, replyResult(true), custom]), 2);
  assert.equal(consecutiveReplyRejections([user("你好"), replyResult(true), user(FALLBACK_TEXT), replyResult(true)]), 2);
  assert.equal(consecutiveReplyRejections([replyResult(true), user("再说一句"), replyResult(true)]), 1);
  assert.equal(consecutiveReplyRejections([replyResult(true), replyResult(false), replyResult(true)]), 1);
});
