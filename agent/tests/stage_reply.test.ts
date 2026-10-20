/**
 * 「回复」的参数里已经没有 stage 与 reason：助手不能自己移动阶段，往前、往后都是发卡片由用户点。写了这两项与别的多出来的项一样被拒；
 * 另外核对 activity_done。用户点转移卡片记成移动的测试在 stage_card_click.test.ts。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkReply, type ReplyFacts } from "../src/lib/reply.ts";
import { IDLE, activityDoneRefusal } from "../src/lib/stage.ts";

const facts: ReplyFacts = { toolCallId: "call-reply", callsThisTurn: [{ id: "call-reply", name: "reply" }], revisionFact: () => "还没有库" };
const base = { informs: [], act: null, text: "材料读完了。" };

test("写了 stage 或 reason：与别的多出来的项一样报「多了」，整次回复被拒", () => {
  for (const key of ["stage", "reason"]) {
    assert.throws(() => checkReply({ ...base, [key]: "澄清" }, facts), new RegExp(`多了「${key}」这一项`), key);
  }
});

test("别的多出来的项照旧报「多了」，不再提 stage 与 reason", () => {
  assert.throws(() => checkReply({ ...base, stages: "澄清" }, facts), /多了「stages」这一项，回复只有 informs、act、text 三项/);
  assert.throws(() => checkReply({ ...base, stages: "澄清" }, facts), (error: Error) => !error.message.includes("要移动工作阶段时"));
});

test("activity_done：不写、写 null 或 false 时回复照常，形状里没有这一项；写 true 而本会话的工作项是单项活动时带上它", () => {
  for (const none of [{}, { activity_done: null }, { activity_done: false }]) assert.deepEqual(checkReply({ ...base, ...none }, facts), base);
  assert.deepEqual(checkReply({ ...base, activity_done: true }, { ...facts, activityDoneRefusal: () => null }), { ...base, activity_done: true });
  // 没有给核对函数（直接调用的单元测试）时不核对。
  assert.deepEqual(checkReply({ ...base, activity_done: true }, facts), { ...base, activity_done: true });
  assert.throws(() => checkReply({ ...base, activity_done: "是" }, facts), /activity_done 只能写 true 或 false：本会话的工作项是单项活动、这项活动做够了、要汇报做完时写 true，别的时候不写/);
});

test("activity_done 写了 true 而本会话不在做单项活动的工作项：整次回复被拒；流程的工作项指引用进入下一段的卡片，空闲时说本会话不属于任何工作项", () => {
  const refused = (position: Parameters<typeof activityDoneRefusal>[0]) => {
    try {
      checkReply({ ...base, activity_done: true }, { ...facts, activityDoneRefusal: () => activityDoneRefusal(position) });
    } catch (error) {
      return (error as Error).message;
    }
    assert.fail("应当被拒绝");
  };
  const clarifying = refused("clarifying");
  assert.match(clarifying, /没有送达/);
  assert.ok(clarifying.includes("回复里写了 activity_done，而本会话的工作项是工作流程，现在在澄清阶段：这一项只在工作项是单项活动时用，流程里的阶段做完了不由你汇报。"), clarifying);
  assert.ok(clarifying.includes("怎么办：去掉 activity_done 这一项再回复。这一段做完了要往前走，请用请选择卡片提议，说清下一段要做什么，" +
    "两个选项的键与文字是 next_step「进入下一步：整理建模」、stay「继续本步」，由用户在卡片上点。"), clarifying);
  assert.ok(refused("document").includes("怎么办：去掉 activity_done 这一项再回复。这一段做完了，照这一段的说明请用户过目。"));
  const idle = refused(IDLE);
  assert.ok(idle.includes("回复里写了 activity_done，而本会话不属于任何工作项，没有活动可以汇报做完。"), idle);
  assert.ok(idle.includes("怎么办：去掉 activity_done 这一项再回复。启动哪一项活动由用户从任务起点页决定。"), idle);
});
