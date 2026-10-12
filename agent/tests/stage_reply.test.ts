/**
 * 「回复」的 stage 与 reason 已经停用：助手不能自己移动阶段，往前、往后都是发卡片由用户点。
 * 这一个版本里两项仍在参数表里；写了就整次回复被拒，并指引改发卡片（lib/reply.ts 的 checkReply、lib/stage.ts 的 STAGE_PARAM_RETIRED）。
 * 用户点回退卡片记成移动的测试在 stage_card_click.test.ts。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkReply, type ReplyFacts } from "../src/lib/reply.ts";
import { BACK_OPTIONS, STAGE_PARAM_RETIRED, STAY_HERE_OPTION } from "../src/lib/stage.ts";

const facts: ReplyFacts = { toolCallId: "call-reply", callsThisTurn: [{ id: "call-reply", name: "reply" }], revisionFact: () => "还没有库" };
const base = { informs: [], act: null, text: "材料读完了。" };

test("不写 stage 与 reason（或写 null、空白）：回复照常，形状里没有 stage 这一项", () => {
  for (const none of [{}, { stage: null }, { stage: "", reason: "" }, { stage: null, reason: null }, { stage: "  ", reason: " " }]) {
    assert.deepEqual(checkReply({ ...base, ...none }, facts), base);
  }
});

test("写了 stage 或 reason：整次回复被拒，说明两项已经停用、任务还在原来的阶段，指引改发卡片；阶段名对不对都一样", () => {
  for (const given of [{ stage: "澄清", reason: "材料读完了。" }, { stage: "writing", reason: "用户说可以写了。" }, { stage: "发布" }, { stage: "澄清" }, { reason: "只写了理由。" }]) {
    assert.throws(() => checkReply({ ...base, ...given }, facts), (error: Error) => {
      assert.match(error.message, /没有送达/);
      assert.ok(error.message.includes("回复里写了 stage（或 reason），这两项已经停用：阶段不由你移动，任务还在原来的阶段。"), error.message);
      assert.ok(error.message.includes("怎么办：往前进入下一段，用进入下一段的请选择卡片提议；这一段的输入大面积不能用、要退回前面的阶段，用请选择卡片提议退回并在问句里写明原因"));
      assert.ok(error.message.includes("只是有一处没弄明白时不要退回：记一条问题条目，在那一处标「待定」，接着做这一段"));
      return true;
    });
  }
  // 指引里列出五个退回的键与「留在本段」，与程序里的常量相同。
  for (const one of [...Object.values(BACK_OPTIONS), STAY_HERE_OPTION]) assert.ok(STAGE_PARAM_RETIRED[1].includes(`${one.key}「${one.text}」`), one.key);
});

test("别的多出来的项照旧报「多了」，不再提 stage 与 reason", () => {
  assert.throws(() => checkReply({ ...base, stages: "澄清" }, facts), /多了「stages」这一项，回复只有 informs、act、text 三项/);
  assert.throws(() => checkReply({ ...base, stages: "澄清" }, facts), (error: Error) => !error.message.includes("要移动工作阶段时"));
});
