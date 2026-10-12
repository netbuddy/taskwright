/**
 * 助手在回复里移动工作阶段（「回复」的 stage 与 reason）：形式的核对在 lib/reply.ts，判与记在 lib/stage_read.ts 的 replyStageMove，
 * 与记对话行为同一个事务（lib/dialogue_acts.ts 的 recordReplyActs）。移不成时回复照常送达，不算被拒。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { recordReplyActs } from "../src/lib/dialogue_acts.ts";
import { checkReply, type ReplyFacts } from "../src/lib/reply.ts";
import { withTaskDatabase } from "../src/lib/schema.ts";
import type { Stage } from "../src/lib/stage.ts";
import { recordStageMove, replyStageMove } from "../src/lib/stage_read.ts";
import { DEFINITION_PATH, callIn, count, demoDefinition, makeWorkspace, overallDefinition, query } from "./helpers.ts";

const SESSION = "session-test";
const facts: ReplyFacts = { toolCallId: "call-reply", callsThisTurn: [{ id: "call-reply", name: "reply" }], revisionFact: () => "还没有库" };
const base = { informs: [], act: null, text: "材料读完了。" };

function workspace(definition: unknown = overallDefinition(), material = true): { dir: string; taskId: string } {
  const dir = makeWorkspace(definition, { material });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return { dir, taskId: query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id };
}
const branch = [{ id: "u-1", type: "message", message: { role: "user", content: "读一下材料" } }] as never;
let call = 0;
/** 发一次带 stage 的回复（informs 缺省一条告知），返回记下的东西。 */
function reply(dir: string, to: Stage, reason = "材料读完了，先问借期。", informs: string[] = ["我立了两页。"]) {
  const callId = `call-reply-${++call}`;
  return recordReplyActs(dir, SESSION, branch, { informs, act: null }, `m-${call}`, callId,
    (db, taskId, runId) => replyStageMove(db, dir, { taskId, sessionId: SESSION, runId, callId }, to, reason))!;
}
const events = (dir: string) => query<{ name: string; payload: string }>(dir, "SELECT name, payload FROM event WHERE name IN ('STAGE_MOVED', 'EXECUTOR_ACTS_RECORDED') ORDER BY seq")
  .map((e) => [e.name, JSON.parse(e.payload)] as [string, Record<string, any>]);
/** 直接把任务放到某个阶段（当作用户移过去的），好从那里试下一步。 */
function put(dir: string, taskId: string, from: Stage, to: Stage): void {
  withTaskDatabase(dir, { createIfMissing: false }, (db) => recordStageMove(db, { taskId, sessionId: SESSION, runId: null, callId: `ui-op-${++call}`, actor: "user", from, to, reason: "" }));
}

test("形式：stage 写五个阶段名之一并带一句理由；名字不对、缺理由各报一条；不写就是不移动，回复的形状与原来相同", () => {
  assert.deepEqual(checkReply({ ...base, stage: "澄清", reason: " 材料读完了。 " }, facts).stage, { to: "clarifying", reason: "材料读完了。" });
  assert.deepEqual(checkReply({ ...base, stage: "writing", reason: "用户说可以写了。" }, facts).stage, { to: "writing", reason: "用户说可以写了。" });
  for (const none of [{}, { stage: null }, { stage: "", reason: "" }, { stage: null, reason: "只写了理由。" }]) {
    assert.deepEqual(checkReply({ ...base, ...none }, facts), base);
  }
  assert.throws(() => checkReply({ ...base, stage: "发布", reason: "条目都写完了。" }, facts),
    /没有送达[^]*stage 写的是 "发布"，不是阶段的名字。\n\s+怎么办：stage 只能是「核读材料」「澄清」「整理建模」「写条目」「评审确认」之一；不移动阶段时不要写 stage。/);
  assert.throws(() => checkReply({ ...base, stage: "澄清" }, facts), /写了 stage 没有写 reason。\n\s+怎么办：reason 写一句话，说明为什么现在移到这个阶段。/);
  assert.throws(() => checkReply({ ...base, stage: "澄清", reason: "   " }, facts), /写了 stage 没有写 reason/);
  assert.throws(() => checkReply({ ...base, stages: "澄清" }, facts), /多了「stages」这一项，回复只有 informs、act、text 三项（要移动工作阶段时另写 stage 与 reason）/);
});

test("助手自己能做的移动只有退回：记一条阶段记录（带运行号与这次回复的调用编号），说明接在返回文字的前面；对话行为照常记", () => {
  const { dir, taskId } = workspace();
  put(dir, taskId, "reading", "modeling");
  const out = reply(dir, "clarifying", "「预约」这个词还没说清。");
  assert.equal(out.text, "任务已从整理建模移到澄清。本轮记了 r1-1（告知：我立了两页。）。");
  assert.deepEqual([out.extra!.moved, out.extra!.from, out.extra!.requested, out.extra!.why], [true, "modeling", "clarifying", null]);
  assert.deepEqual(query(dir, "SELECT stage, from_stage, actor, reason, run_id, call_id, session_id FROM stage_record WHERE actor = 'executor'").map((r) => ({ ...r })), [
    { stage: "clarifying", from_stage: "modeling", actor: "executor", reason: "「预约」这个词还没说清。", run_id: "r1", call_id: `call-reply-${call}`, session_id: SESSION },
  ]);
  const log = events(dir);
  assert.deepEqual(log.map(([name]) => name), ["STAGE_MOVED", "STAGE_MOVED", "EXECUTOR_ACTS_RECORDED"]);
  assert.equal(out.extra!.event_seq, query<{ event_seq: number }>(dir, "SELECT event_seq FROM stage_record WHERE actor = 'executor'")[0].event_seq);
  assert.equal("stage_declined" in log[2][1], false, "移成了，回复那条事件里不留退回的说明");
  // 再退一段到核读材料也可以；从评审确认可以一下退回澄清。
  assert.equal(reply(dir, "reading", "用户放进了新材料。").text.startsWith("任务已从澄清移到核读材料。"), true);
  put(dir, taskId, "reading", "reviewing");
  assert.equal(reply(dir, "clarifying", "评审发现一个词的意思不对。").extra!.moved, true);
  assert.equal(count(dir, "stage_record"), 5);
});

test("助手不能自己做的移动：回复照常送达、对话行为照常记，阶段不动，原因写在返回文字与回复那条事件里", () => {
  const { dir, taskId } = workspace();
  put(dir, taskId, "reading", "modeling");
  // 往前一段（进入写条目）：要由用户在卡片上点。
  const writing = reply(dir, "writing", "主题都理清了。");
  assert.equal(writing.text, "阶段没有移动：往前移动要由用户在卡片上点。请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 start_items「开始写条目」、continue_consolidate「继续本阶段」。" +
    "本轮记了 r1-1（告知：我立了两页。）。");
  assert.deepEqual([writing.extra!.moved, writing.extra!.why, writing.acts.length], [false, "user_only", 1]);
  // 往前不止一段。
  const skip = reply(dir, "reviewing", "直接评审。");
  assert.match(skip.text, /^阶段没有移动：往前移动要由用户在卡片上点。一次只进入下一段，整理建模的下一段是写条目。/);
  // 原地不动。
  const same = reply(dir, "modeling", "还在整理。");
  assert.match(same.text, /^任务本来就在整理建模阶段，没有记移动。/);
  assert.equal(count(dir, "stage_record"), 1, "只有开头放过去的那一条");
  const declined = events(dir).filter(([name]) => name === "EXECUTOR_ACTS_RECORDED").map(([, payload]) => payload.stage_declined);
  assert.deepEqual(declined, [
    { stage: "writing", from: "modeling", why: "user_only" }, { stage: "reviewing", from: "modeling", why: "user_only" }, { stage: "modeling", from: "modeling", why: "same" },
  ]);
  // 核读材料到澄清、澄清到整理建模、写条目到评审确认，助手也都不能自己移。
  for (const [from, to] of [["reading", "clarifying"], ["clarifying", "modeling"], ["writing", "reviewing"]] as const) {
    put(dir, taskId, "modeling", from);
    const forward = reply(dir, to, "这一段做完了。");
    assert.deepEqual([forward.extra!.moved, forward.extra!.why, forward.extra!.from], [false, "user_only", from], `${from} 到 ${to}`);
    put(dir, taskId, from, "modeling");
  }
  // 从评审确认退回写条目可以。
  put(dir, taskId, "modeling", "reviewing");
  assert.equal(reply(dir, "writing", "评审发现缺一条用例。").extra!.moved, true);
});

test("回复里没有告知也没有要的回应：移成了只记阶段那一条事件；移不成才为留下原因记一条回复的事件", () => {
  const { dir, taskId } = workspace();
  put(dir, taskId, "reading", "modeling");
  const moved = reply(dir, "clarifying", "还有一个词要问。", []);
  assert.deepEqual([moved.text, moved.acts, moved.eventSeq, moved.extra!.moved], ["任务已从整理建模移到澄清。", [], null, true]);
  assert.deepEqual(events(dir).map(([name]) => name), ["STAGE_MOVED", "STAGE_MOVED"]);
  const declined = reply(dir, "writing", "可以写了。", []);
  assert.match(declined.text, /^阶段没有移动：往前移动要由用户在卡片上点。/);
  assert.deepEqual(events(dir).map(([name, payload]) => [name, payload.acts, payload.stage_declined]).at(-1),
    ["EXECUTOR_ACTS_RECORDED", [], { stage: "writing", from: "clarifying", why: "user_only" }]);
  assert.equal(count(dir, "dialogue_act"), 0);
});

test("早先建的任务没有阶段：写了 stage 时回复照常送达，说明这个任务没有阶段，什么都不记", () => {
  const { dir } = workspace(demoDefinition());
  const out = reply(dir, "clarifying");
  assert.equal(out.text, "阶段没有移动：这个任务没有阶段，不要写 stage。本轮记了 r1-1（告知：我立了两页。）。");
  assert.deepEqual([out.extra!.moved, out.extra!.from, out.extra!.why], [false, null, "no_stages"]);
  assert.equal(count(dir, "stage_record"), 0);
  assert.deepEqual(events(dir).map(([name, payload]) => [name, payload.stage_declined]), [["EXECUTOR_ACTS_RECORDED", { stage: "clarifying", why: "no_stages" }]]);
});
