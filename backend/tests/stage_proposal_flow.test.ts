/**
 * 常驻的提议从头到尾走一遍（真的后端进程与真的 pi，模型换成进程内的假端点）：
 * 助手发出提议进入澄清的卡片 → 用户选「继续本阶段」（只留一条通知，助手不运行）→ 用户再说两轮，提议一直开着 →
 * 用户新建一条会话，在那里点进入（输入框上方「待决定」一行与任务状况卡上的按钮发的就是这个请求）→ 阶段移动，提议结束。
 * 中间核对整份数据的 stage.proposal、任务状况接口、对话记录里的那条通知，以及助手下一次运行时看得到这条通知。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { captureConsole, movesSql, sendAndWaitTurn, tempDir } from "./helpers.ts";
import { type Dict, NO_PI, TOPIC_CALL, reply, sleep, withStack } from "./consent_stack.ts";

captureConsole();
process.env.PI_OFFLINE = "1";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const CARD = { kind: "choose", text: "材料核读完了，立了一页主题。进入澄清吗？", items: [{ item_id: "OA-001", revision_no: 1 }],
  options: [{ key: "enter_clarify", text: "进入澄清" }, { key: "continue_reading", text: "继续本阶段" }] };
const SCRIPT = {
  sequence: [
    // 第一句话：立一页主题，发提议进入澄清的卡片。
    { tool_calls: [TOPIC_CALL] },
    reply("材料读完了，我立了一页主题。", "call-card", CARD),
    // 用户选了继续本阶段之后又说了两句。
    reply("已补进「自助借书」这一页。", "call-more-1"),
    reply("这一句也记下了。", "call-more-2"),
    // 用户在另一条会话里点了进入澄清之后。
    reply("好，开始澄清。第一件事：借书证丢了怎么办？", "call-go"),
  ],
};

test("发卡片、选继续本阶段、再说两轮、在另一条会话里点进入：提议一直开着直到阶段移动；选继续本阶段不引出助手运行", { skip: NO_PI, timeout: 240000 }, () =>
  withStack(tmp, "proposal-flow", SCRIPT, async ({ call, taskId, session, port, send, action, entryOfCall, requests, db }) => {
    // 阶段、提议、当前活动都是按会话算的：看的是这条会话（它属于夹具启动的那个需求分析的工作项）。
    const stageNow = async () => (await call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${session}`)).body.task.stage as Dict;
    const statusNow = async () => (await call("GET", `/api/v1/tasks/${taskId}/status?session=${session}`)).body.status as Dict;
    assert.equal((await stageNow()).proposal, null);

    // 1. 助手发出进入卡片：提议开着，记着卡片在哪条会话的哪条回复上。
    await send({ text: "读一下材料。", client_id: "c-1" });
    const cardEntry = entryOfCall("call-card");
    const opened = (await stageNow()).proposal as Dict;
    assert.deepEqual([opened.stage, opened.enter, opened.stay, opened.session_id, opened.reply_message_id, opened.items],
      ["clarifying", CARD.options[0], CARD.options[1], session, cardEntry, CARD.items]);
    const first = await statusNow();
    assert.deepEqual([first.activity.key, first.activity.name, first.activity.ordinal, first.activity.flow, first.activity.moved_by],
      ["reading", "核读材料", 1, "analysis", "user"]);
    assert.deepEqual([first.description.sections, first.description.chapters, first.proposal.event_seq], [1, [{ no: 3, name: "业务流程", sections: 1 }], opened.event_seq]);

    // 2. 用户选「继续本阶段」：操作成功，会话里多一条界面操作通知，助手没有因此运行，没有记移动，提议仍然开着。
    const asked = requests().length;
    const stayed = await action({ kind: "continue_stage", targets: [], fields: { reply_message_id: cardEntry, option_key: "continue_reading" }, notify_executor: false });
    assert.equal(stayed.status, 200, JSON.stringify(stayed.body));
    await sleep(1500);
    assert.equal(requests().length, asked, "助手没有被叫起来");
    assert.deepEqual(db("SELECT COUNT(*) AS n FROM activity_record"), [{ n: 1 }], "只有启动需求分析的那一条");
    assert.equal((await stageNow()).proposal.event_seq, opened.event_seq);
    const afterStay = (await call("GET", `/api/v1/tasks/${taskId}/conversation?session=${session}`)).body.messages as Dict[];
    const note = afterStay[afterStay.length - 1];
    assert.deepEqual([note.type, note.kind, note.reply_message_id, note.stage, note.undoable], ["ui_action_noted", "continue_stage", cardEntry, "clarifying", false]);
    // 点的不是留在这一段的选项、卡片认不出：拒绝，什么都不留。
    const wrong = await action({ kind: "continue_stage", targets: [], fields: { reply_message_id: cardEntry, option_key: "enter_clarify" }, notify_executor: false });
    assert.notEqual(wrong.status, 200);

    // 3. 用户再说两轮：助手下一次运行时在上下文里看得到那条通知；提议一直开着。
    await send({ text: "「自助借书」那一节再补一句：教师和学生的上限不一样。", client_id: "c-2" });
    const seen = JSON.stringify(requests()[requests().length - 1]["请求体"].messages);
    assert.match(seen, /用户在提议「进入澄清」的卡片上选了「继续本阶段」，没有进入澄清。这个提议仍然开着/);
    await send({ text: "还有：寒暑假顺延。", client_id: "c-3" });
    assert.equal((await stageNow()).proposal.event_seq, opened.event_seq);
    assert.equal((await stageNow()).current, "reading");

    // 4. 换一条会话接着做这个工作项，在那里点进入：这条会话里没有那张卡片，照这个工作项开着的提议记换站。
    const made = (await call("POST", `/api/v1/tasks/${taskId}/sessions`, { activity_record_id: 1 })).body as Dict;
    const second: string = made.session_id;
    assert.notEqual(second, session);
    assert.equal(made.activity_record_id, 1);
    // 新会话里还没有人说过话：只有界面操作留的一条（接着做哪个工作项），与会话一开头系统放的那条任务现状说明（如果已经写了）。
    const fresh = (await call("GET", `/api/v1/tasks/${taskId}/conversation?session=${second}`)).body.messages as Dict[];
    assert.deepEqual(fresh.filter((m) => m.type === "ui_action_noted").map((m) => [m.kind, m.text]),
      [["continue_activity", "界面操作（不是用户打的字）：用户新建这条会话，接着做工作项「需求分析」，现在在「核读材料」这一站。"]]);
    assert.ok(fresh.every((m) => m.type === "ui_action_noted" || m.type === "system_note"), JSON.stringify(fresh.map((m) => m.type)));
    // 在新会话里问状况，给得出这个工作项开着的提议；一条不属于它的会话里没有。
    assert.equal((await call("GET", `/api/v1/tasks/${taskId}/status?session=${second}`)).body.status.proposal.reply_message_id, cardEntry);
    assert.equal((await call("GET", `/api/v1/tasks/${taskId}/status`)).body.status.proposal, null);
    // 这条新会话在建立时就按工作项起了名。
    const names = Object.fromEntries(((await call("GET", `/api/v1/tasks/${taskId}/sessions`)).body.sessions as Dict[]).map((one) => [one.session_id, [one.name, one.work_item?.record_id, one.work_item?.name]]));
    assert.deepEqual(names[second], ["需求分析 · 核读材料", 1, "需求分析"]);
    await sendAndWaitTurn(port, taskId, second, async () => {
      const sent = await call("POST", `/api/v1/tasks/${taskId}/messages?session=${second}`,
        { text: "我选：进入澄清", client_id: "c-4", origin: "card_choice", card: { reply_message_id: cardEntry, kind: "choose", choice: "enter_clarify" } });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
    });
    assert.deepEqual(db(movesSql(["actor", "from_stage", "stage", "reason", "session_id"])).slice(1),
      [{ actor: "user", from_stage: "reading", stage: "clarifying", reason: "用户在卡片上选了「进入澄清」", session_id: second }]);
    const moved = await stageNow();
    assert.deepEqual([moved.current, moved.moved_by, moved.proposal, moved.flow], ["clarifying", "user", null, "analysis"]);
    const last = await statusNow();
    assert.deepEqual([last.activity.key, last.activity.ordinal, last.activity.moved_by, last.activity.reason, last.proposal],
      ["clarifying", 2, "user", "用户在卡片上选了「进入澄清」", null]);
    // 那句「我选：进入澄清」在新会话里带着从哪到哪；选项的文字取自开着的提议（这条会话里没有那张卡片）。
    const inSecond = (await call("GET", `/api/v1/tasks/${taskId}/conversation?session=${second}`)).body.messages as Dict[];
    const click = inSecond.find((m) => m.type === "user_message")!;
    assert.deepEqual([click.text, click.origin, click.stage_move, click.annotation.option_key, click.annotation.option_text, click.annotation.reply_message_id],
      ["我选：进入澄清", "card_choice", { from: "reading", to: "clarifying", actor: "user", how: "move" }, "enter_clarify", "进入澄清", cardEntry]);
    assert.ok(inSecond.some((m) => m.type === "assistant_reply" && m.text === "好，开始澄清。第一件事：借书证丢了怎么办？"));
  }, { seed: false }));
