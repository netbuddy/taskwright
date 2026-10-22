/**
 * 工作的阶段里读写库的那一半（src/lib/stage_read.ts）：一条会话没有工作项时空闲、三种写入各记什么、按会话读工作项；
 * 以及活动记录表怎样补到已有的库里、早先一站一行的记录怎样归并成工作项（更早格式的库升级时做）。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTask } from "../src/lib/create_task.ts";
import { validateDefinition } from "../src/lib/definition.ts";
import { TASK_DB_VERSION, withTaskDatabase } from "../src/lib/schema.ts";
import {
  EVENT_ACTIVITY_STARTED, EVENT_NODE_ENTERED, EVENT_STAGE_MOVED, EVENT_WORK_ITEM_DELETED, activityRecords, archivedSessions, attachSession, currentStage, deleteWorkItem, enterNode,
  launchWorkItem, moveStage, nextStepStage, sessionWorkItem, stageOf, taskHasMaterials, workItemSessions,
} from "../src/lib/stage_read.ts";
import { DEFINITION_PATH, callIn, demoDefinition, makeWorkspace, overallDefinition, query } from "./helpers.ts";

function workspace(definition: unknown = overallDefinition(), material = true): { dir: string; taskId: string } {
  const dir = makeWorkspace(definition, { material });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return { dir, taskId: query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id };
}
const write = <T>(dir: string, body: (db: DatabaseSync) => T) => withTaskDatabase(dir, { createIfMissing: false }, body);

test("没有工作项时会话空闲：刚建好的任务有没有材料都是空闲，空闲不落库，上传材料也不改变它", () => {
  const { dir, taskId } = workspace(overallDefinition(), false);
  const definition = validateDefinition(overallDefinition());
  assert.equal(taskHasMaterials(dir, definition.materialsDir), false);
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, definition, "sess-1")), "idle");
  mkdirSync(join(dir, "inputs"), { recursive: true });
  writeFileSync(join(dir, "inputs/材料.md"), "读者凭借书证借书。", "utf-8");
  assert.equal(taskHasMaterials(dir, definition.materialsDir), true);
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, definition, "sess-1")), "idle");
  assert.equal(query(dir, "SELECT * FROM activity_record").length, 0, "空闲不落库");
  rmSync(join(dir, "inputs/材料.md"));
});

test("三种写入各记什么：启动插一行、挂上会话、记一条带记录号的事件；换站只改这一行、记一条换站的事件；删除记一条删除的事件、删掉这一行、它的会话全部归档", () => {
  const { dir, taskId } = workspace();
  const who = { taskId, sessionId: "sess-1", runId: null, callId: "ui-op-1", actor: "user" as const };
  const started = write(dir, (db) => launchWorkItem(db, { ...who, to: "clarifying", flow: "analysis", reason: "", scope: " 只做借阅 " }));
  assert.equal(started.record_id, write(dir, (db) => sessionWorkItem(db, taskId, "sess-1"))!.record_id);
  // 每次写之前在同一个事务里现取这一行，写函数照它现在的活动与所在的一站记。
  const entered = write(dir, (db) => enterNode(db, sessionWorkItem(db, taskId, "sess-1")!, "writing", { ...who, callId: "ui-op-2" }, "澄清够了"));
  const back = write(dir, (db) => enterNode(db, sessionWorkItem(db, taskId, "sess-1")!, "modeling", { ...who, runId: "r2", callId: "call-reply-1", actor: "executor" }, ""));
  write(dir, (db) => attachSession(db, taskId, started.record_id, "sess-2"));
  // 自始至终只有一行；两条会话都属于它，都在做它。
  const rows = write(dir, (db) => activityRecords(db, taskId));
  assert.deepEqual(rows.map((r) => [r.record_id, r.activity, r.node, r.flow, r.scope, r.session_id, r.started_seq, r.from]),
    [[started.record_id, "modeling", "modeling", "analysis", "只做借阅", "sess-1", started.event_seq, null]]);
  assert.deepEqual(write(dir, (db) => workItemSessions(db, taskId)).map((one) => [one.session_id, one.record_id]), [["sess-1", started.record_id], ["sess-2", started.record_id]]);
  assert.deepEqual(write(dir, (db) => [currentStage(db, taskId, "sess-1"), currentStage(db, taskId, "sess-2")]), ["modeling", "modeling"]);
  // 一条会话只属于一个工作项：已经挂过的会话再挂别的不改。
  const other = write(dir, (db) => launchWorkItem(db, { ...who, sessionId: "sess-3", callId: "ui-op-4", to: "clarifying", flow: null, reason: "" }));
  write(dir, (db) => attachSession(db, taskId, other.record_id, "sess-1"));
  assert.equal(write(dir, (db) => sessionWorkItem(db, taskId, "sess-1"))!.record_id, started.record_id);
  assert.deepEqual(write(dir, (db) => [currentStage(db, taskId, "sess-3"), currentStage(db, taskId, null), currentStage(db, taskId, "没有这条会话")]), ["clarifying", "idle", "idle"]);
  // 删除流程的工作项：记一条删除的事件（带随之归档了几条会话），这一行不在了，它的两条会话归档、按自由讨论办；别的工作项不受影响。
  const deleted = write(dir, (db) => deleteWorkItem(db, sessionWorkItem(db, taskId, "sess-1")!, { taskId, sessionId: "sess-2", callId: "ui-op-5", actor: "user" }, "不要了"));
  assert.equal(deleted.archived, 2);
  const events = query<{ seq: number; name: string; actor: string; session_id: string; call_id: string; payload: string }>(dir,
    "SELECT seq, name, actor, session_id, call_id, payload FROM event WHERE name IN (?, ?, ?, ?) ORDER BY seq", EVENT_ACTIVITY_STARTED, EVENT_WORK_ITEM_DELETED, EVENT_NODE_ENTERED, EVENT_STAGE_MOVED);
  assert.deepEqual(events.map((e) => [e.seq, e.name, e.actor, e.session_id, e.call_id, JSON.parse(e.payload)]), [
    [started.event_seq, "ACTIVITY_STARTED", "user", "sess-1", "ui-op-1",
      { record_id: started.record_id, activity: "clarifying", node: "clarifying", flow: "analysis", from: null, actor: "user", reason: "", run_id: null, scope: "只做借阅" }],
    [entered, "ACTIVITY_NODE_ENTERED", "user", "sess-1", "ui-op-2",
      { record_id: started.record_id, flow: "analysis", node: "writing", from: "clarifying", direction: "forward", actor: "user", reason: "澄清够了", run_id: null }],
    [back, "ACTIVITY_NODE_ENTERED", "executor", "sess-1", "call-reply-1",
      { record_id: started.record_id, flow: "analysis", node: "modeling", from: "writing", direction: "back", actor: "executor", reason: "", run_id: "r2" }],
    [other.event_seq, "ACTIVITY_STARTED", "user", "sess-3", "ui-op-4",
      { record_id: other.record_id, activity: "clarifying", node: null, flow: null, from: null, actor: "user", reason: "", run_id: null }],
    [deleted.event_seq, "WORK_ITEM_DELETED", "user", "sess-2", "ui-op-5",
      { record_id: started.record_id, activity: "modeling", node: "modeling", flow: "analysis", scope: "只做借阅", archived_sessions: 2, actor: "user", reason: "不要了" }],
  ]);
  assert.deepEqual(write(dir, (db) => activityRecords(db, taskId)).map((r) => r.record_id), [other.record_id]);
  assert.deepEqual(write(dir, (db) => workItemSessions(db, taskId)).map((one) => [one.session_id, one.record_id]), [["sess-3", other.record_id]]);
  assert.deepEqual(write(dir, (db) => [...archivedSessions(db, taskId)].map(([id, one]) => [id, one.record_id])).sort(), [["sess-1", started.record_id], ["sess-2", started.record_id]]);
  // 子表那一行留着原来的记录号，只多了归档的时刻：说明它曾属于已经删除的这个工作项。
  assert.deepEqual(query<{ session_id: string; record_id: number; archived: number }>(dir, "SELECT session_id, record_id, archived_at IS NOT NULL AS archived FROM work_item_session ORDER BY rowid")
    .map((r) => [r.session_id, r.record_id, r.archived]), [["sess-1", started.record_id, 1], ["sess-2", started.record_id, 1], ["sess-3", other.record_id, 0]]);
  assert.deepEqual(write(dir, (db) => [sessionWorkItem(db, taskId, "sess-1"), currentStage(db, taskId, "sess-2"), currentStage(db, taskId, "sess-3")]), [null, "idle", "clarifying"]);
  // 记录号不重用：删掉的是最大的记录号以外的那一个，再删最大的那一个，新启动的工作项仍然排在后面。
  write(dir, (db) => deleteWorkItem(db, sessionWorkItem(db, taskId, "sess-3")!, { taskId, sessionId: "sess-3", callId: "ui-op-6", actor: "user" }, ""));
  const fresh = write(dir, (db) => launchWorkItem(db, { ...who, sessionId: "sess-4", callId: "ui-op-7", to: "modeling", flow: null, reason: "" }));
  assert.equal(fresh.record_id, other.record_id + 1);
});

test("早先建的任务（任务定义里没有业务说明集合）没有阶段", () => {
  const { dir, taskId } = workspace(demoDefinition());
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, validateDefinition(demoDefinition()))), null);
});

const tableThere = (dir: string, name: string) => query(dir, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).length === 1;

test("新建的库：有活动记录表，没有早先的阶段记录表", () => {
  const { dir } = workspace();
  assert.deepEqual([tableThere(dir, "activity_record"), tableThere(dir, "stage_record")], [true, false]);
  assert.equal(query<{ user_version: number }>(dir, "PRAGMA user_version")[0].user_version, TASK_DB_VERSION);
});


test("活动记录认声明里的活动：逆向解析的行读得出来，位置算作核读；下一站按工作流的各步找；从逆向解析进下一站换到核读，不算原地不动", () => {
  const { dir, taskId } = workspace();
  const definition = validateDefinition(overallDefinition());
  const who = { taskId, sessionId: "sess-r", runId: null, callId: "ui-op-r1", actor: "user" as const };
  write(dir, (db) => launchWorkItem(db, { ...who, to: "parse_spec", flow: "rewrite", reason: "" }));
  assert.deepEqual(write(dir, (db) => activityRecords(db, taskId)).map((one) => [one.activity, one.node, one.flow]), [["parse_spec", "parse_spec", "rewrite"]]);
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, definition, "sess-r")), "reading");
  // 下一站：需求再工程里逆向解析之后是核读、核读之后是澄清；需求分析照旧。
  assert.deepEqual([nextStepStage(dir, definition, "rewrite", "parse_spec"), nextStepStage(dir, definition, "rewrite", "reading"), nextStepStage(dir, definition, "analysis", "reading"),
    nextStepStage(dir, definition, "analysis", "parse_spec")], ["reading", "clarifying", "clarifying", null]);
  // 从逆向解析到核读：两站算作同一个阶段，但不是原地不动；这一行的活动与所在一站都写 reading，方向是往前。
  const moved = write(dir, (db) => moveStage(db, dir, { ...who, callId: "ui-op-r2" }, nextStepStage(dir, definition, "rewrite", "parse_spec")!, ""));
  assert.deepEqual([moved.moved, moved.why, moved.from], [true, null, "reading"]);
  assert.deepEqual(write(dir, (db) => activityRecords(db, taskId)).map((one) => [one.activity, one.node, one.flow]), [["reading", "reading", "rewrite"]]);
  const entered = query<{ payload: string }>(dir, "SELECT payload FROM event WHERE name = ? ORDER BY seq", EVENT_NODE_ENTERED).map((one) => JSON.parse(one.payload));
  assert.deepEqual(entered.map((one) => [one.flow, one.from, one.node, one.direction]), [["rewrite", "parse_spec", "reading", "forward"]]);
  // 再进核读才是原地不动。
  assert.equal(write(dir, (db) => moveStage(db, dir, { ...who, callId: "ui-op-r3" }, "reading", "")).why, "same");
});
