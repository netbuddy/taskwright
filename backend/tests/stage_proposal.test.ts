/**
 * 开着的提议在后端的两处：整份数据里的 stage.proposal，与库事件 stage_proposed。
 * 任务库经子进程里助手一侧真实的函数建（保存、「回复」记事件、界面上移动阶段），这里只读。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import * as library from "../src/library.ts";
import { DEMO_DEFINITION, tempDir } from "./helpers.ts";
import { DEFINITION, build, page } from "./overall_stack.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const FLOW = page({ 标题: "预约取书", 标签: ["流程"], 例子: ["小王周六预约了一本书。"] });
const ENTER_REVIEW = { key: "enter_review", text: "进入评审确认" };
const STAY = { key: "continue_writing", text: "继续本阶段" };
/** 助手在写条目阶段发的那张卡片：提议进入评审确认，点名一页请用户先看。 */
const CARD = { kind: "choose", text: "条目写完了，进入评审确认吗？", items: [{ item_id: "OA-001", revision_no: 1 }], options: [ENTER_REVIEW, STAY] };

test("整份数据的 stage 带开着的提议：要进入的阶段、两个选项、问句、点名的条目、卡片在哪条会话的哪条回复上；没有时是 null", () => {
  // 夹具一建好任务就由用户移到写条目。
  const none = build(tmp, "none", DEFINITION, [[FLOW]]);
  assert.equal(library.taskSnapshot(none)[1]!.stage!.proposal, null);
  const ws = build(tmp, "open", DEFINITION, [[FLOW], { reply: CARD, session: "sess-first" }]);
  const proposal = library.taskSnapshot(ws)[1]!.stage!.proposal!;
  assert.deepEqual({ ...proposal, event_seq: null, at: null, reply_message_id: null }, {
    stage: "reviewing", enter: ENTER_REVIEW, stay: STAY, text: "条目写完了，进入评审确认吗？", items: [{ item_id: "OA-001", revision_no: 1 }],
    session_id: "sess-first", reply_message_id: null, event_seq: null, at: null,
  });
  assert.match(proposal.reply_message_id!, /^reply-/);
  assert.match(proposal.at!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.ok(proposal.event_seq > 0);
  // 用户进入了评审确认：阶段移动过，提议结束。
  const moved = build(tmp, "moved", DEFINITION, [[FLOW], { reply: CARD }, { stage: "评审确认" }]);
  const stage = library.taskSnapshot(moved)[1]!.stage!;
  assert.deepEqual([stage.current, stage.proposal], ["reviewing", null]);
});

test("库事件：助手发出进入卡片转成 stage_proposed，这一批最后一条事件上的 stage 带着它；别的回复不推；移动之后这一批的 stage 里没有提议", () => {
  const ws = build(tmp, "events", DEFINITION, [[FLOW], { reply: { kind: "confirm", text: "请看一下这一页。", items: [{ item_id: "OA-001", revision_no: 1 }] } },
    { reply: CARD, session: "sess-first" }]);
  const [events, max] = library.libraryEvents(ws, 0);
  const proposed = events.filter(([name]) => name === "stage_proposed").map(([, data]) => data);
  // 两条回复里只有带进入卡片的那一条推了事件。
  assert.equal(proposed.length, 1);
  assert.deepEqual([proposed[0].proposal.stage, proposed[0].proposal.enter, proposed[0].proposal.session_id, proposed[0].actor, proposed[0].seq],
    ["reviewing", ENTER_REVIEW, "sess-first", "executor", max]);
  const last = events[events.length - 1][1];
  assert.deepEqual(last.stage.proposal, proposed[0].proposal);
  assert.deepEqual(last.stage.proposal, library.taskSnapshot(ws)[1]!.stage!.proposal);
  // 只取卡片之后的事件：一条都没有，不推任何东西。
  assert.deepEqual(library.libraryEvents(ws, max)[0], []);
  // 用户随后进入评审确认：这一批是 stage_changed，它带的 stage 里提议已经是 null。
  const moved = build(tmp, "events-moved", DEFINITION, [[FLOW], { reply: CARD }, { stage: "评审确认" }]);
  const after = library.libraryEvents(moved, library.libraryEvents(moved, 0)[1] - 1)[0];
  assert.deepEqual(after.map(([name, data]) => [name, data.to, data.stage.current, data.stage.proposal]), [["stage_changed", "reviewing", "reviewing", null]]);
});

test("早先建的任务没有阶段：发了带进入键的卡片也没有 stage_proposed，整份数据的 stage 是 null", () => {
  const ws = build(tmp, "old", DEMO_DEFINITION, [{ reply: CARD }]);
  assert.equal(library.taskSnapshot(ws)[1]!.stage, null);
  assert.deepEqual(library.libraryEvents(ws, 0)[0].filter(([name]) => name === "stage_proposed"), []);
});
