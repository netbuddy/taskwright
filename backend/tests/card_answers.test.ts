/**
 * 卡片之外的话不自动算作对卡片的回答：起真的后端进程与真的 pi，模型换成进程内的假端点。
 * 流程：助手问了一问（提问卡片）；用户在底部输入框说了别的事，卡片仍然开着；用户在卡片的文本框里写了回答（与页面一样经发话接口，
 * card.choice 为 typed），这句话仍是打的字、带着卡片的标识，助手的理解要回应那张卡片（没有回应时被拒一次）；
 * 助手发了一张请选择，用户在底部输入框回答，助手的理解指着它，下一条回复带 answers_card；
 * 助手又问一问，用户搁下，助手重发（act.resends），重发的回复带 resends_card，任务状态里只列重发的那一张。
 * 实时推送与刷新后读的对话记录说法相同。
 */

import assert from "node:assert/strict";
import { request } from "node:http";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { captureConsole, tempDir } from "./helpers.ts";
import { type Dict, NO_PI, reply, withStack } from "./consent_stack.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const intent = (...acts: Dict[]) => "```json\n" + JSON.stringify({ acts }) + "\n```";
const withIntent = (text: string, step: Dict) => ({ ...step, text });
const ASK = { kind: "ask", text: "借书证丢了怎样补办", scope: "general" };
const CHOOSE = { kind: "choose", text: "逾期按哪种办法处理", options: [{ key: "fine", text: "罚款" }, { key: "suspend", text: "停借" }] };
const ASK_LIMIT = { kind: "ask", text: "每人最多借几本", scope: "general" };

const SCRIPT = {
  sequence: [
    reply("先问一件事。", "call-ask", ASK),                                    // r1：理解 r1-1，卡片 r1-2
    reply("材料里只写了一句话。", "call-aside"),                               // r2：用户说了别的事
    // r3：用户在卡片的文本框里写了回答；头一份理解没有回应那张卡片，被拒；改过之后送达。
    withIntent(intent({ function: "inform", confidence: "high", summary: "到服务台补办" }), reply("记下了。", "call-typed-bad")),
    withIntent(intent({ function: "inform", responds_to: "r1-2", confidence: "high", summary: "到服务台补办" }), reply("记下了。", "call-typed")),
    reply("再请你选一个。", "call-choose", CHOOSE),                            // r4：理解 r4-1，卡片 r4-2
    withIntent(intent({ function: "inform", responds_to: "r4-2", confidence: "high", summary: "逾期按罚款处理" }), reply("好，按罚款。", "call-chosen")),   // r5
    reply("还有一问。", "call-limit", ASK_LIMIT),                              // r6：卡片 r6-2
    { tool_calls: [{ id: "call-status", name: "get_task_status", arguments: {} }] },                                                              // r7：用户搁下
    reply("前面这个问题还没有答，这一段结束前请确认。", "call-resend", { ...ASK_LIMIT, resends: "r6-2" }),
  ],
};

/** 订阅这个任务的事件流，返回到此为止收到的事件与关掉连接的函数。 */
async function listen(port: number, taskId: string): Promise<{ events: { event: string; data: Dict }[]; close: () => void }> {
  const events: { event: string; data: Dict }[] = [];
  let buffer = "";
  const req = request({ host: "127.0.0.1", port, path: `/api/v1/tasks/${taskId}/events` });
  await new Promise<void>((ok, fail) => {
    req.on("response", (res) => {
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      });
      res.on("error", () => {});
      ok();
    });
    req.on("error", fail);
    req.end();
  });
  return { events, close: () => req.destroy() };
}

test("底部输入框的话不关卡片；卡片文本框里的话带卡片的标识；助手判定回答了卡片时下一条回复带 answers_card；重发的回复带 resends_card", { skip: NO_PI, timeout: 180000 }, () =>
  withStack(tmp, "cards", SCRIPT, async ({ call, taskId, session, port, db, send, entryOfCall, requests }) => {
    const live = await listen(port, taskId);
    try {
      await send({ text: "开始吧。", client_id: "c-1" });
      const askEntry = entryOfCall("call-ask");
      await send({ text: "材料里写了什么？", client_id: "c-2" });
      await send({ text: "到服务台补办。", client_id: "c-3", origin: "card_choice", card: { reply_message_id: askEntry, kind: "ask", choice: "typed" } });
      await send({ text: "接着问。", client_id: "c-4" });
      const chooseEntry = entryOfCall("call-choose");
      await send({ text: "按罚款来。", client_id: "c-5" });
      await send({ text: "还有吗？", client_id: "c-6" });
      const limitEntry = entryOfCall("call-limit");
      await send({ text: "先不说这个，这一段差不多了。", client_id: "c-7" });

      // 卡片文本框里的话：模型收到的说明写明是用户打的字、回应的是哪张卡片；没有回应它的那份理解被拒了一次。
      const told = requests().map((one) => JSON.stringify(one.请求体)).find((text) => text.includes("卡片里的回复（是用户打的字）"))!;
      assert.match(told, /用户在 r1-2（提问「借书证丢了怎样补办」）那张卡片的文本框里写了下面这句话。这句话是在回应这张卡片，理解里要有一项的 responds_to 写 r1-2。/);
      const refused = db("SELECT call_id, fact FROM tool_rejection WHERE tool_name = 'reply'");
      assert.deepEqual(refused.map((one: Dict) => one.call_id), ["call-typed-bad"]);
      assert.match(refused[0].fact, /这句话是用户在 r1-2 那张卡片的文本框里写的，是在回应这张卡片；理解里要有一项的 responds_to 写 r1-2/);
      // 这句话是执行者写的理解记下的，不是按点击合成的。
      assert.deepEqual(db("SELECT origin, responds_to FROM dialogue_act WHERE speaker = 'user' AND run_id = 'r3'"), [{ origin: "understanding", responds_to: "r1-2" }]);
      assert.equal(db("SELECT 1 AS yes FROM event WHERE name = 'USER_INTENT_RECORDED' AND payload LIKE '%\"origin\":\"ui\"%'").length, 0);

      // 助手重发之前查了任务状态：这一段还开着的只有最后那一问（前两张都答过了）；重发的那一行回应原来那一行。
      const status = requests().map((one) => JSON.stringify(one.请求体)).find((text) => text.includes("这一段还开着的提问与请选择 1 张"))!;
      assert.match(status, /r6-2 提问「每人最多借几本」/);
      assert.deepEqual(db("SELECT act_id, responds_to FROM dialogue_act WHERE speaker = 'executor' AND responds_to IS NOT NULL"), [{ act_id: "r7-2", responds_to: "r6-2" }]);

      // 刷新后读的对话记录。
      const messages = (await call("GET", `/api/v1/tasks/${taskId}/conversation?session=${session}`)).body.messages as Dict[];
      const said = (text: string) => messages.find((m) => m.type === "user_message" && m.text === text)!;
      const replied = (callId: string) => messages.find((m) => m.type === "assistant_reply" && m.message_id === entryOfCall(callId))!;
      assert.deepEqual([said("材料里写了什么？").origin, said("材料里写了什么？").annotation], ["typed", null]);
      const typed = said("到服务台补办。");
      assert.equal(typed.origin, "typed");
      assert.deepEqual({ ...typed.annotation, click_message_id: null }, { reply_message_id: askEntry, option_key: "typed", option_text: null, click_message_id: null });
      assert.ok(typed.annotation.click_message_id);
      assert.equal(replied("call-aside").answers_card, undefined, "用户说了别的事，卡片没有被回答");
      assert.deepEqual(replied("call-typed").answers_card, [askEntry]);
      assert.deepEqual(replied("call-chosen").answers_card, [chooseEntry]);
      assert.equal(replied("call-chosen").resends_card, undefined);
      assert.equal(replied("call-resend").resends_card, limitEntry);
      assert.equal(replied("call-resend").answers_card, undefined);
      assert.equal(replied("call-resend").act.resends, "r6-2");

      // 实时推送的说法与刷新后相同。
      const pushed = (event: string) => live.events.filter((one) => one.event === event && one.data.session_id === session).map((one) => one.data);
      const liveTyped = pushed("user_message").find((m) => m.text === "到服务台补办。")!;
      assert.deepEqual([liveTyped.origin, liveTyped.annotation.reply_message_id, liveTyped.annotation.option_key, liveTyped.client_id], ["typed", askEntry, "typed", "c-3"]);
      assert.deepEqual(pushed("user_message").find((m) => m.text === "材料里写了什么？")!.annotation, null);
      const liveReply = (callId: string) => pushed("assistant_reply").find((m) => m.message_id === entryOfCall(callId))!;
      assert.equal(liveReply("call-aside").answers_card, undefined);
      assert.deepEqual(liveReply("call-typed").answers_card, [askEntry]);
      assert.deepEqual(liveReply("call-chosen").answers_card, [chooseEntry]);
      assert.equal(liveReply("call-resend").resends_card, limitEntry);
    } finally {
      live.close();
    }
  }));
