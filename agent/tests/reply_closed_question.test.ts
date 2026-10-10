/**
 * 提问（ask）只给开放问题：写成了是非题或者征求同意的话，「回复」拒绝，请助手改用请选择或提议（lib/reply.ts 的 closedQuestion）。
 * 这是一条只看字面的规则，有误伤也有漏掉的，各留例子在这里；误伤的照拒绝里说的把问句改写一下就过。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSED_QUESTION_GUIDANCE, checkReply, closedQuestion, type ReplyFacts } from "../src/lib/reply.ts";
import { rejectionOf } from "../src/lib/tool_rejection.ts";

const facts: ReplyFacts = { toolCallId: "call-reply", callsThisTurn: [{ id: "call-reply", name: "reply" }], revisionFact: () => "还没有库" };
const ask = (text: string) => ({ informs: [], act: { kind: "ask", text, scope: "general" }, text });

test("是非题或征求同意的句式：句子里任何位置有是否、能不能、要不要、可不可以、对不对、行不行，或者以吗收尾；结尾的标点不算", () => {
  for (const text of [
    // 这几个词在句首、句中、句尾都算。
    "是否允许读者续借两次", "逾期未还的读者是否还能借书？", "这一页先这样定，你看是否",
    "逾期未还的读者能不能续借？", "读者丢了借书证，还能不能", "要不要把罚款单列成一条约束？", "把罚款单列成一条约束，要不要？",
    "教师可不可以代学生借书？", "保留期按 3 天算，对不对？", "续借只许一次，行不行",
    // 以「吗」收尾，后面跟着标点、引号、括号、空白也算。
    "逾期未还的读者可以续借吗？", "这样可以吗？", "保留期是 3 天，对吗", "这条规定现在还有效吗。", "「预约」是这个意思吗？）", "  续借一次，行吗？ ",
  ]) {
    assert.equal(closedQuestion(text), true, text);
  }
  for (const text of ["逾期罚款的上限是多少？", "保留期是几天", "读者有哪几类？", "寒暑假期间的借期怎样规定？", "吗啡类药品怎样登记？", "请说一个续借被拒的例子。",
    "借书证丢了以后怎么补办？", "请说说借书的流程。"]) {
    assert.equal(closedQuestion(text), false, text);
  }
});

test("误伤两例：其实是开放问题，却带着这些词；把问句改写成不带这些词的形式就过。漏掉一例：「A 还是 B」认不出", () => {
  assert.equal(closedQuestion("能不能说说借书的流程？"), true);
  assert.equal(closedQuestion("请说说借书的流程。"), false);
  assert.equal(closedQuestion("逾期罚款的上限是多少，你那边有规定吗"), true);
  assert.equal(closedQuestion("逾期罚款的上限是多少？"), false);
  assert.equal(closedQuestion("罚款在服务台交还是在线上交？"), false);
});

test("提问写成是非题：回复被拒，原话写明改用请选择或提议，并给开放问题留一条路；同一句话用请选择或提议发就送达", () => {
  const text = "逾期未还的读者能不能续借？";
  let error: unknown;
  try {
    checkReply(ask(text), facts);
  } catch (caught) {
    error = caught;
  }
  const layers = rejectionOf(error)!;
  assert.match((error as Error).message, /没有送达/);
  assert.match(layers.fact, /提问（ask）写的是一句是非题或者征求同意的话：「逾期未还的读者能不能续借？」/);
  assert.ok(layers.guidance.includes(CLOSED_QUESTION_GUIDANCE));
  assert.equal(CLOSED_QUESTION_GUIDANCE, "是非题用请选择，征求同意用提议，把答案写成按钮；提问只给开放问题。确是开放问题的，把问句改写成不带这些词的形式");
  assert.match((error as Error).message, /怎么办：是非题用请选择，征求同意用提议，把答案写成按钮；提问只给开放问题。确是开放问题的，把问句改写成不带这些词的形式。/);
  // 长的问句在原话里截短。
  const long = `${"材料里写了逾期要罚款，但没说逾期期间的事，".repeat(3)}逾期未还的读者可以续借吗？`;
  assert.throws(() => checkReply(ask(long), facts), /话：「材料里写了逾期要罚款，但没说逾期期间的事，材料里写了逾期要罚款，但没说逾期期间的…」/);

  const choose = { informs: [], act: { kind: "choose", text, options: [{ key: "yes", text: "能" }, { key: "no", text: "不能" }] }, text };
  assert.equal(checkReply(choose, facts).act!.kind, "choose");
  const propose = { informs: [], act: { kind: "propose", text: "把罚款单列成一条约束，可以吗？", scope: "general" }, text: "把罚款单列成一条约束，可以吗？" };
  assert.equal(checkReply(propose, facts).act!.kind, "propose");
});

test("开放问题照常送达；被误伤的开放问题照拒绝里说的改写之后送达", () => {
  const open = "逾期罚款的上限是多少？";
  assert.equal(checkReply(ask(open), facts).act!.text, open);
  assert.throws(() => checkReply(ask("能不能说说借书的流程？"), facts), /确是开放问题的，把问句改写成不带这些词的形式/);
  assert.equal(checkReply(ask("请说说借书的流程。"), facts).act!.kind, "ask");
});
