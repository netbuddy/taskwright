/**
 * 阶段的移动怎样进对话区的消息（真的后端进程与真的 pi，模型换成进程内的假端点）：
 * 助手在回复里把任务退回前面的阶段，那条回复带 stage_move（从哪到哪、理由）；用户在卡片上点了「进入」下一段，那句「我选：……」带
 * stage_move（从哪到哪）。实时推的消息与重开页面时读的消息都带，形状相同；没有移动阶段的回复与用户的话不带这一项。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { request } from "node:http";
import { after, test } from "node:test";
import { clickStageMove, clickStageUnmoved, replyStageMove } from "../src/conversation.ts";
import { captureConsole, tempDir } from "./helpers.ts";
import { type Dict, NO_PI, TOPIC_CALL, reply, sleep, withStack } from "./consent_stack.ts";

captureConsole();
process.env.PI_OFFLINE = "1";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

test("两个取值的函数：移成了才有；阶段名不对、没有移成、没有这一项时都是 null", () => {
  assert.deepEqual(replyStageMove({ stage: { moved: true, from: "modeling", requested: "clarifying", why: null } }, " 「预约」没说清。 "),
    { from: "modeling", to: "clarifying", actor: "executor", reason: "「预约」没说清。" });
  assert.equal(replyStageMove({ stage: { moved: false, from: "modeling", requested: "writing", why: "user_only" } }, "可以写了。"), null);
  assert.equal(replyStageMove({}, "没有写 stage。"), null);
  assert.equal(replyStageMove({ stage: { moved: true, from: "modeling", requested: "别的" } }, ""), null);
  assert.deepEqual(clickStageMove({ stage_move: { from: "reading", to: "clarifying" } }), { from: "reading", to: "clarifying", actor: "user" });
  assert.equal(clickStageMove({ stage_event_seq: 12 }), null);
  assert.equal(clickStageMove({ stage_move: { from: "reading", to: "别的" } }), null);
  // 点了进入的卡片而阶段没有移动：带任务当时所在的阶段；记了移动的点击与早先版本留下的点击都没有这一项。
  assert.deepEqual(clickStageUnmoved({ stage_unmoved: { at: "reading" } }), { at: "reading" });
  assert.equal(clickStageUnmoved({ stage_move: { from: "reading", to: "clarifying" } }), null);
  assert.equal(clickStageUnmoved({ stage_event_seq: 12 }), null);
  assert.equal(clickStageUnmoved({ stage_unmoved: { at: "别的" } }), null);
});

const MODEL_CARD = { kind: "choose", text: "要问的都问到了。现在进入整理建模吗？", items: [{ item_id: "OA-001", revision_no: 1 }],
  options: [{ key: "enter_consolidate", text: "进入整理建模" }, { key: "continue_clarify", text: "继续本阶段" }] };
const SCRIPT = {
  sequence: [
    // 第一句话（任务已被用户移到整理建模）：立一页主题，在回复里退回澄清。
    { tool_calls: [TOPIC_CALL] },
    { tool_calls: [{ id: "call-back", name: "reply", arguments: { informs: [], act: null, text: "「自助机」这个词还没说清，先退回澄清。", stage: "澄清", reason: "「自助机」这个词还没说清。" } }] },
    // 第二句话（澄清）：发「进入整理建模」的卡片。
    reply("要问的都问到了。现在进入整理建模吗？", "call-card", MODEL_CARD),
    // 用户点了之后。
    reply("好，我开始通读主题页。", "call-go"),
    // 用户又点了一次那张已经答过的卡片之后。
    reply("任务已经在整理建模了，我接着通读。", "call-again"),
  ],
};

/** 订阅任务的事件连接，把对话的两种消息收进来。 */
function conversationEvents(port: number, taskId: string): { events: [string, Dict][]; close: () => void } {
  const events: [string, Dict][] = [];
  let buffer = "";
  const req = request({ host: "127.0.0.1", port, path: `/api/v1/tasks/${taskId}/events` }, (res) => {
    res.setEncoding("utf-8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const name = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if ((name === "assistant_reply" || name === "user_message") && data) events.push([name, JSON.parse(data)]);
      }
    });
    res.on("error", () => {});
  });
  req.on("error", () => {});
  req.end();
  return { events, close: () => req.destroy() };
}

test("助手退回阶段的那条回复、用户点卡片进入下一段的那句话，都带 stage_move；点了进入的卡片而阶段没有移动的那句话带 stage_unmoved；实时推的与重读的相同，别的消息不带", { skip: NO_PI, timeout: 180000 }, () =>
  withStack(tmp, "stage-conversation", SCRIPT, async ({ call, taskId, session, port, send, action, entryOfCall }) => {
    const pushed = conversationEvents(port, taskId);
    try {
      assert.equal((await action({ kind: "move_stage", targets: [], fields: { stage: "整理建模" } })).status, 200);
      await send({ text: "自助机是什么？", client_id: "c-1" });
      await send({ text: "就是门口那台机器。", client_id: "c-2" });
      await send({ text: "我选：进入整理建模", client_id: "c-3", origin: "card_choice", card: { reply_message_id: entryOfCall("call-card"), kind: "choose", choice: "enter_consolidate" } });
      // 再点一次那张卡片：任务已经在整理建模，这次点击不记移动。
      await send({ text: "我选：进入整理建模", client_id: "c-4", origin: "card_choice", card: { reply_message_id: entryOfCall("call-card"), kind: "choose", choice: "enter_consolidate" } });
      for (const end = Date.now() + 10000; pushed.events.filter(([, data]) => data.session_id === session).length < 8 && Date.now() < end;) await sleep(100);

      const wanted = {
        back: { from: "modeling", to: "clarifying", actor: "executor", reason: "「自助机」这个词还没说清。" },
        enter: { from: "clarifying", to: "modeling", actor: "user" },
      };
      // 实时推的。
      const live = pushed.events.filter(([, data]) => data.session_id === session);
      const liveMoves = live.map(([name, data]) => [name, data.text, data.stage_move ?? null, data.stage_unmoved ?? null]);
      assert.deepEqual(liveMoves, [
        ["user_message", "自助机是什么？", null, null],
        ["assistant_reply", "「自助机」这个词还没说清，先退回澄清。", wanted.back, null],
        ["user_message", "就是门口那台机器。", null, null],
        ["assistant_reply", "要问的都问到了。现在进入整理建模吗？", null, null],
        ["user_message", "我选：进入整理建模", wanted.enter, null],
        ["assistant_reply", "好，我开始通读主题页。", null, null],
        ["user_message", "我选：进入整理建模", null, { at: "modeling" }],
        ["assistant_reply", "任务已经在整理建模了，我接着通读。", null, null],
      ]);
      // 没有移动的消息里没有这个键（不是写成 null）。
      assert.equal("stage_move" in live[0][1], false);
      assert.equal("stage_move" in live[3][1], false);
      assert.equal("stage_unmoved" in live[4][1], false);

      // 重开页面时读的。
      const read = (await call("GET", `/api/v1/tasks/${taskId}/conversation?session=${session}`)).body.messages as Dict[];
      const spoken = read.filter((m) => m.type === "user_message" || m.type === "assistant_reply");
      assert.deepEqual(spoken.map((m) => [m.type, m.text, m.stage_move ?? null, m.stage_unmoved ?? null]), liveMoves);
      assert.equal("stage_move" in spoken[0], false);
    } finally {
      pushed.close();
    }
  }, { seed: false }));
