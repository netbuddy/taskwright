/**
 * 开着的提议在后端的两处：整份数据里的 stage.proposal，与库事件 stage_proposed。
 * 任务库经子进程里助手一侧真实的函数建（保存、「回复」记事件、界面上移动阶段），这里只读。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import * as library from "../src/library.ts";
import { DEMO_DEFINITION, tempDir, sqlRun } from "./helpers.ts";
import { DEFINITION, build, page } from "./overall_stack.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const FLOW = page({ 标题: "预约取书", 标签: ["流程"], 例子: ["小王周六预约了一本书。"] });
const ENTER_REVIEW = { key: "enter_review", text: "进入评审确认" };
const STAY = { key: "continue_writing", text: "继续本阶段" };
/** 助手在写条目阶段发的那张卡片：提议进入评审确认，点名一页请用户先看。 */
const CARD = { kind: "choose", text: "条目写完了，进入评审确认吗？", items: [{ item_id: "OA-001", revision_no: 1 }], options: [ENTER_REVIEW, STAY] };

test("整份数据的 stage 带开着的提议：要进入的阶段、两个选项、问句、点名的条目、卡片在哪条会话的哪条回复上；没有时是 null", () => {
  // 夹具一建好任务就由用户在会话 s 上启动需求分析、从写条目开始；助手在这条会话里发卡片。提议属于这个工作项。
  const none = build(tmp, "none", DEFINITION, [[FLOW]]);
  assert.equal(library.taskSnapshot(none, null, "s")[1]!.stage!.proposal, null);
  const ws = build(tmp, "open", DEFINITION, [[FLOW], { reply: CARD }]);
  const proposal = library.taskSnapshot(ws, null, "s")[1]!.stage!.proposal!;
  assert.deepEqual({ ...proposal, event_seq: null, at: null, reply_message_id: null }, {
    kind: "enter", stage: "reviewing", enter: ENTER_REVIEW, stay: STAY, text: "条目写完了，进入评审确认吗？", items: [{ item_id: "OA-001", revision_no: 1 }],
    session_id: "s", reply_message_id: null, event_seq: null, at: null,
  });
  // 别的会话不属于这个工作项：整份数据里没有这条提议；不给会话时也没有。
  assert.deepEqual([library.taskSnapshot(ws, null, "sess-other")[1]!.stage!.proposal, library.taskSnapshot(ws)[1]!.stage!.proposal], [null, null]);
  // 换一条会话接着做这个工作项（直接改库把它挂上）：那条会话里看得到，卡片仍记在原来那条会话上。
  sqlRun(ws, [["INSERT INTO work_item_session (session_id, record_id, task_id, attached_at) SELECT 's-next', 1, task_id, '2099-01-01T00:00:00' FROM task"]]);
  assert.equal(library.taskSnapshot(ws, null, "s-next")[1]!.stage!.proposal!.session_id, "s");
  assert.match(proposal.reply_message_id!, /^reply-/);
  assert.match(proposal.at!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.ok(proposal.event_seq > 0);
  // 用户进入了评审确认：工作项换了一站，提议结束。
  const moved = build(tmp, "moved", DEFINITION, [[FLOW], { reply: CARD }, { stage: "评审确认" }]);
  const stage = library.taskSnapshot(moved, null, "s")[1]!.stage!;
  assert.deepEqual([stage.current, stage.proposal], ["reviewing", null]);
});

test("库事件：助手发出进入卡片转成 stage_proposed，这一批最后一条事件上的 stage（按会话算）带着它；别的回复不推；换站之后这一批的 stage 里没有提议", () => {
  const ws = build(tmp, "events", DEFINITION, [[FLOW], { reply: { kind: "confirm", text: "请看一下这一页。", items: [{ item_id: "OA-001", revision_no: 1 }] } },
    { reply: CARD }]);
  const [events, max] = library.libraryEvents(ws, 0, "s");
  const proposed = events.filter(([name]) => name === "stage_proposed").map(([, data]) => data);
  // 两条回复里只有带进入卡片的那一条推了事件。
  assert.equal(proposed.length, 1);
  assert.deepEqual([proposed[0].proposal.stage, proposed[0].proposal.enter, proposed[0].proposal.session_id, proposed[0].actor, proposed[0].seq],
    ["reviewing", ENTER_REVIEW, "s", "executor", max]);
  const last = events[events.length - 1][1];
  assert.deepEqual(last.stage.proposal, proposed[0].proposal);
  assert.deepEqual(last.stage.proposal, library.taskSnapshot(ws, null, "s")[1]!.stage!.proposal);
  // 给别的会话算的那一份里没有它：stage_proposed 这条事件照样推（带着卡片所在的会话），页面按自己的会话属于的工作项认。
  assert.equal(library.libraryEvents(ws, 0, "sess-other")[0].at(-1)![1].stage.proposal, null);
  // 只取卡片之后的事件：一条都没有，不推任何东西。
  assert.deepEqual(library.libraryEvents(ws, max)[0], []);
  // 用户随后进入评审确认：这一批的最后一条是换站的那一条，它带的 stage 里提议已经是 null。
  const moved = build(tmp, "events-moved", DEFINITION, [[FLOW], { reply: CARD }, { stage: "评审确认" }]);
  const after = library.libraryEvents(moved, library.libraryEvents(moved, 0)[1] - 1, "s")[0];
  assert.deepEqual(after.map(([name, data]) => [name, data.node, data.stage.current, data.stage.proposal]), [["node_entered", "reviewing", "reviewing", null]]);
});

test("早先建的任务没有阶段：发了带进入键的卡片也没有 stage_proposed，整份数据的 stage 是 null", () => {
  const ws = build(tmp, "old", DEMO_DEFINITION, [{ reply: CARD }]);
  assert.equal(library.taskSnapshot(ws)[1]!.stage, null);
  assert.deepEqual(library.libraryEvents(ws, 0)[0].filter(([name]) => name === "stage_proposed"), []);
});
