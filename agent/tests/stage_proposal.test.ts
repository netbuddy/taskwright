/**
 * 开着的提议（lib/stage_proposal.ts）：助手发一张提议进入下一个阶段的卡片，「回复」记的那条事件里带上 proposal；
 * 任务的提议开着没有从事件表里推；卡片在另一条会话里发的，用户在这条会话里点进入照样记移动。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { EVENT_EXECUTOR_ACTS_RECORDED, recordReplyActs } from "../src/lib/dialogue_acts.ts";
import { TASK_ACTIVE, withTaskDatabase } from "../src/lib/schema.ts";
import { ENTER_OPTIONS, STAY_OPTIONS, type Stage } from "../src/lib/stage.ts";
import { isStayKey, openProposal, proposalOfAct } from "../src/lib/stage_proposal.ts";
import { moveStage, recordStageCardClick } from "../src/lib/stage_read.ts";
import { DEFINITION_PATH, callIn, count, demoDefinition, enterStage, makeWorkspace, overallDefinition, query } from "./helpers.ts";

const SESSION = "sess-a";
const said = (id: string, text: string) => ({ id, type: "message", message: { role: "user", content: text } });

function workspace(definition: unknown = overallDefinition()): string {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}

/** 进入某个阶段的那张卡片：两个选项是进入它与留在前一段。 */
function enterCard(to: Exclude<Stage, "reading">, from: Exclude<Stage, "reviewing">, items: { item_id: string; revision_no?: number }[] = []) {
  return { kind: "choose", text: `这一段做完了，${ENTER_OPTIONS[to].text}吗？`, items, options: [ENTER_OPTIONS[to], STAY_OPTIONS[from]] };
}

let replies = 0;
/** 助手在某条会话里发一条带这张卡片的回复，返回那条回复的会话条目编号与事件序号。 */
function reply(dir: string, act: Record<string, unknown> | null, session = SESSION): { entry: string; seq: number | null } {
  const entry = `reply-${++replies}`;
  const out = recordReplyActs(dir, session, [said(`u-${replies}`, "接着做")] as never, { informs: act ? [] : ["记下了。"], act: act as never }, entry, `call-${entry}`);
  return { entry, seq: out!.eventSeq };
}

const open = (dir: string) => withTaskDatabase(dir, { createIfMissing: false }, (db) => {
  const task = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string };
  return openProposal(db, task.task_id);
});
const payloadOf = (dir: string, seq: number) => JSON.parse(query<{ payload: string }>(dir, "SELECT payload FROM event WHERE seq = ?", seq)[0].payload);

test("一张卡片是不是进入卡片：请选择里有进入某个阶段的键才是；留在这一段的键按四个固定的键认", () => {
  const fact = proposalOfAct(enterCard("clarifying", "reading", [{ item_id: "OA-001", revision_no: 2 }, { item_id: "OA-002" }]))!;
  assert.deepEqual(fact, {
    stage: "clarifying", enter: ENTER_OPTIONS.clarifying, stay: STAY_OPTIONS.reading, text: "这一段做完了，进入澄清吗？",
    items: [{ item_id: "OA-001", revision_no: 2 }, { item_id: "OA-002", revision_no: null }],
  });
  // 四张卡片各进入一个阶段；没有留在这一段的选项时 stay 是 null。
  assert.deepEqual((["clarifying", "modeling", "writing", "reviewing"] as const).map((to) => proposalOfAct({ kind: "choose", text: "", options: [ENTER_OPTIONS[to]] })),
    (["clarifying", "modeling", "writing", "reviewing"] as const).map((to) => ({ stage: to, enter: ENTER_OPTIONS[to], stay: null, text: "", items: [] })));
  // 不是请选择、没有进入键、选项不成样子：都不是。
  for (const act of [null, { kind: "confirm", text: "请看", items: [] }, { kind: "choose", text: "选一个", options: [{ key: "a", text: "甲" }, STAY_OPTIONS.reading] },
    { kind: "choose", text: "选一个" }, { kind: "ask", text: "进入澄清吗", options: [ENTER_OPTIONS.clarifying] }]) assert.equal(proposalOfAct(act), null);
  assert.deepEqual(Object.values(STAY_OPTIONS).map((one) => isStayKey(one.key)), [true, true, true, true]);
  assert.deepEqual(["enter_clarify", "start_items", "continue", "complete", null].map(isStayKey), [false, false, false, false, false]);
});

test("发出进入卡片：事件里带 proposal，提议就开着，带着卡片在哪条会话的哪条回复上；别的回复不带，也不结束它", () => {
  const dir = workspace();
  assert.equal(open(dir), null, "还没有发过卡片");
  const card = reply(dir, enterCard("clarifying", "reading", [{ item_id: "OA-001", revision_no: 1 }]));
  assert.deepEqual(payloadOf(dir, card.seq!).proposal, { stage: "clarifying", enter: ENTER_OPTIONS.clarifying, stay: STAY_OPTIONS.reading,
    text: "这一段做完了，进入澄清吗？", items: [{ item_id: "OA-001", revision_no: 1 }] });
  const now = open(dir)!;
  assert.deepEqual([now.stage, now.enter.key, now.stay?.key, now.session_id, now.reply_entry, now.event_seq, now.items],
    ["clarifying", "enter_clarify", "continue_reading", SESSION, card.entry, card.seq, [{ item_id: "OA-001", revision_no: 1 }]]);
  assert.match(now.at, /^\d{4}-\d{2}-\d{2}/);
  // 之后助手说别的、发别的卡片（文字里碰巧写着 proposal 也一样）：事件里没有 proposal，提议还是原来那一条。
  const plain = reply(dir, null);
  const other = reply(dir, { kind: "choose", text: "\"proposal\" 这个词怎样译？", options: [{ key: "a", text: "提议" }, { key: "b", text: "建议" }] });
  assert.equal("proposal" in payloadOf(dir, plain.seq!), false);
  assert.equal("proposal" in payloadOf(dir, other.seq!), false);
  assert.equal(open(dir)!.event_seq, card.seq);
});

test("提议结束的三种情形：阶段有过一次移动（向前或者退回）、助手发了新的进入卡片、任务不再进行中", () => {
  // 用户点了进入：阶段向前移动，提议结束。
  const forward = workspace();
  reply(forward, enterCard("clarifying", "reading"));
  enterStage(forward, "clarifying");
  assert.equal(open(forward), null);
  // 助手把任务退回了前面的阶段：早先的提议也结束。
  const back = workspace();
  enterStage(back, "modeling");
  reply(back, enterCard("writing", "modeling"));
  assert.equal(open(back)!.stage, "writing");
  withTaskDatabase(back, { createIfMissing: false }, (db) => {
    const task = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string };
    moveStage(db, back, { taskId: task.task_id, sessionId: SESSION, runId: "r3", callId: "call-back", actor: "executor" }, "clarifying", "有一个词没有说清");
  });
  assert.equal(open(back), null);
  // 移动之后助手又发了一张：新的这一条开着。早先那一条不会回来。
  const again = reply(back, enterCard("modeling", "clarifying"));
  assert.deepEqual([open(back)!.stage, open(back)!.event_seq], ["modeling", again.seq]);
  // 没有移动、助手又发一张新的进入卡片：开着的是新的那一条。
  const newer = reply(back, enterCard("modeling", "clarifying", [{ item_id: "OA-003", revision_no: 4 }]));
  assert.deepEqual([open(back)!.event_seq, open(back)!.items], [newer.seq, [{ item_id: "OA-003", revision_no: 4 }]]);
  // 任务不再进行中：没有开着的提议。
  withTaskDatabase(back, { createIfMissing: false }, (db) => db.prepare("UPDATE task SET status = '已完成' WHERE status = ?").run(TASK_ACTIVE));
  assert.equal(open(back), null);
});

test("早先建的任务没有阶段：发了带进入键的卡片也不记 proposal", () => {
  const dir = workspace(demoDefinition());
  const card = reply(dir, enterCard("writing", "clarifying"));
  assert.equal("proposal" in payloadOf(dir, card.seq!), false);
  assert.equal(open(dir), null);
});

test("卡片在另一条会话里：这条会话的分支上找不到那条回复，点进入照开着的提议记移动；键或回复编号对不上就不记", () => {
  const dir = workspace();
  const card = reply(dir, enterCard("clarifying", "reading"), "sess-first");
  const elsewhere = [said("u-x", "接着昨天的做")] as never;
  // 键不是开着的提议的进入键、回复编号是别的卡片：都不记。
  assert.equal(recordStageCardClick(dir, "sess-second", elsewhere, { opId: "ui-op-1", replyEntry: card.entry, optionKey: "enter_consolidate" }), null);
  assert.equal(recordStageCardClick(dir, "sess-second", elsewhere, { opId: "ui-op-2", replyEntry: "reply-none", optionKey: "enter_clarify" }), null);
  assert.equal(count(dir, "stage_record"), 0);
  // 键与回复编号都对得上：记一条用户的移动，记在点的那条会话上；提议随之结束。
  const moved = recordStageCardClick(dir, "sess-second", elsewhere, { opId: "ui-op-3", replyEntry: card.entry, optionKey: "enter_clarify" })!;
  assert.deepEqual([moved.moved, moved.from, moved.requested], [true, "reading", "clarifying"]);
  assert.deepEqual(query(dir, "SELECT stage, from_stage, actor, session_id, call_id FROM stage_record").map((row) => ({ ...row })),
    [{ stage: "clarifying", from_stage: "reading", actor: "user", session_id: "sess-second", call_id: "ui-op-3" }]);
  assert.equal(open(dir), null);
  // 提议已经结束：同一个请求再来一次不再记。
  assert.equal(recordStageCardClick(dir, "sess-second", elsewhere, { opId: "ui-op-4", replyEntry: card.entry, optionKey: "enter_clarify" }), null);
  // 没有给回复编号、键对得上开着的提议：也算（任务状况卡上的进入按钮不一定知道回复编号）。
  const next = reply(dir, enterCard("modeling", "clarifying"), "sess-first");
  assert.equal(recordStageCardClick(dir, "sess-second", elsewhere, { opId: "ui-op-5", replyEntry: null, optionKey: "enter_consolidate" })!.moved, true);
  assert.equal(open(dir), null);
  assert.ok(next.seq);
  assert.equal(count(dir, "stage_record"), 2);
});

test("事件的名字与「回复」记的是同一个", () => {
  const dir = workspace();
  const card = reply(dir, enterCard("clarifying", "reading"));
  assert.equal(query<{ name: string }>(dir, "SELECT name FROM event WHERE seq = ?", card.seq)[0].name, EVENT_EXECUTOR_ACTS_RECORDED);
});
