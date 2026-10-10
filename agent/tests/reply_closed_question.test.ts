/**
 * 提问（ask）只给开放问题：写成了是非题或者征求同意的话，「回复」拒绝，请助手改用请选择或提议（lib/reply.ts 的 closedQuestion）。
 * 这是一条只看字面的规则，有误伤也有漏掉的，各留一例在这里。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSED_QUESTION_GUIDANCE, checkReply, closedQuestion, type ReplyFacts } from "../src/lib/reply.ts";
import { rejectionOf } from "../src/lib/tool_rejection.ts";

const facts: ReplyFacts = { toolCallId: "call-reply", callsThisTurn: [{ id: "call-reply", name: "reply" }], revisionFact: () => "还没有库" };
const ask = (text: string) => ({ informs: [], act: { kind: "ask", text, scope: "general" }, text });

test("是非题或征求同意的句式：以吗、是否、能不能、要不要、可以吗、对吗收尾，或者以是否开头；结尾的标点不算", () => {
  for (const text of ["逾期未还的读者可以续借吗？", "这样可以吗？", "保留期是 3 天，对吗", "是否允许读者续借两次", "把罚款单列成一条约束，要不要？",
    "这条规定现在还有效吗。", "「预约」是这个意思吗？）", "  续借一次，行吗？ ", "这一页先这样定，你看是否", "读者丢了借书证，还能不能"]) {
    assert.equal(closedQuestion(text), true, text);
  }
  for (const text of ["逾期罚款的上限是多少？", "保留期是几天", "读者有哪几类？", "寒暑假期间的借期怎样规定？", "吗啡类药品怎样登记？", "请说一个续借被拒的例子。"]) {
    assert.equal(closedQuestion(text), false, text);
  }
});

test("误伤一例：问的是要用户说出内容的事，却以「吗」收尾，也被认成是非题；漏掉两例：这几个词不在句尾的、「A 还是 B」的，认不出", () => {
  assert.equal(closedQuestion("逾期罚款的上限是多少，你那边有规定吗"), true);
  // 规则只看收尾：「能不能」后面还跟着别的字时认不出。
  assert.equal(closedQuestion("逾期未还的读者能不能续借？"), false);
  assert.equal(closedQuestion("要不要把罚款单列成一条约束？"), false);
  assert.equal(closedQuestion("罚款在服务台交还是在线上交？"), false);
});

test("提问写成是非题：回复被拒，原话写明改用请选择或提议；同一句话用请选择或提议发就送达", () => {
  const text = "逾期未还的读者可以续借吗？";
  let error: unknown;
  try {
    checkReply(ask(text), facts);
  } catch (caught) {
    error = caught;
  }
  const layers = rejectionOf(error)!;
  assert.match((error as Error).message, /没有送达/);
  assert.match(layers.fact, /提问（ask）写的是一句是非题或者征求同意的话：「逾期未还的读者可以续借吗？」/);
  assert.ok(layers.guidance.includes(CLOSED_QUESTION_GUIDANCE));
  assert.equal(CLOSED_QUESTION_GUIDANCE, "是非题用请选择，征求同意用提议，把答案写成按钮；提问只给开放问题");
  // 长的问句在原话里截短。
  const long = `${"材料里写了逾期要罚款，但没说逾期期间的事，".repeat(3)}逾期未还的读者可以续借吗？`;
  assert.throws(() => checkReply(ask(long), facts), /话：「材料里写了逾期要罚款，但没说逾期期间的事，材料里写了逾期要罚款，但没说逾期期间的…」/);

  const choose = { informs: [], act: { kind: "choose", text, options: [{ key: "yes", text: "能" }, { key: "no", text: "不能" }] }, text };
  assert.equal(checkReply(choose, facts).act!.kind, "choose");
  const propose = { informs: [], act: { kind: "propose", text: "把罚款单列成一条约束，可以吗？", scope: "general" }, text: "把罚款单列成一条约束，可以吗？" };
  assert.equal(checkReply(propose, facts).act!.kind, "propose");
});

test("开放问题照常送达", () => {
  const open = "逾期罚款的上限是多少？";
  assert.equal(checkReply(ask(open), facts).act!.text, open);
});
