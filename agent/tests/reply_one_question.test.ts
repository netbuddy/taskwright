/**
 * 一张提问卡片只问一件事（lib/reply.ts 的 askedCount）：点名的问题条目多于一个、正文里列了两个以上序号起头的分句或者两个以上问号，
 * 「回复」都拒绝，请助手先用告知列出全部问题条目、再只问第一条。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { askedCount, checkReply, type ReplyFacts } from "../src/lib/reply.ts";

/** TBD 开头的是问题条目；条目都在、修订号都是当前的。 */
const facts: ReplyFacts = {
  toolCallId: "call-reply", callsThisTurn: [{ id: "call-reply", name: "reply" }],
  revisionFact: () => "是当前所在的修订", problemItem: (itemId) => itemId.startsWith("TBD-"),
};
const ask = (text: string, ids: string[]) => ({ informs: [], act: { kind: "ask", text, items: ids.map((item_id) => ({ item_id, revision_no: 1 })) }, text });
const refusal = (reply: unknown) => {
  try {
    checkReply(reply, facts);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("没有被拒绝");
};
/** 整段拒绝文字：问了 count 件事。 */
const whole = (count: number) => "这次回复的形式不对，没有送达。请按下面几处改好后重新单独调用 reply：\n" +
  `1. 这张提问卡片问了 ${count} 件事。\n` +
  "   怎么办：一次只问一条：先用告知列出全部问题条目（items 写它们的编号），再用提问只问第一条；用户答完改条目再问下一条。";

test("提问点名了多于一个问题条目：拒绝，说问了几件事", () => {
  assert.equal(refusal(ask("借书证丢失的读者怎样处理？", ["TBD-001", "TBD-002", "UC-001"])), whole(2));
});

test("正文里列了几问：序号起头的分句或者几个问号，都拒绝", () => {
  assert.equal(refusal(ask("还有几件事要你定：1）借书证丢失时怎样处理；2）续借几次；3）罚款上限多少。", ["TBD-001"])), whole(3));
  assert.equal(askedCount("1. 借书证丢失时怎样处理 2. 续借几次", []), 2);
  assert.equal(askedCount("借书证丢失时怎样处理？续借几次？", []), 2);
  // 小数、一个序号、一个问号都不算多问。
  assert.equal(askedCount("罚款按每天 0.5 元算，上限是多少？", []), 1);
  assert.equal(askedCount("1）借书证丢失时怎样处理？", []), 1);
});

test("只问一条问题条目、正文只问一件事：送达", () => {
  const done = checkReply(ask("借书证丢失的读者还能借书，要先补办借书证，还是另有办法？", ["TBD-001", "UC-001"]), facts);
  assert.equal(done.act!.kind, "ask");
});
