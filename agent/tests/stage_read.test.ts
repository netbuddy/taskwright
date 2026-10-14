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
import { databasePath } from "../src/lib/db.ts";
import { validateDefinition } from "../src/lib/definition.ts";
import { TASK_DB_VERSION, upgradeTaskDatabase, withTaskDatabase } from "../src/lib/schema.ts";
import {
  EVENT_ACTIVITY_ENDED, EVENT_ACTIVITY_STARTED, EVENT_NODE_ENTERED, EVENT_STAGE_MOVED, activityRecords, attachSession, currentStage, endWorkItem, enterNode, hasActivityTable, hasSessionTable,
  launchWorkItem, moveStage, openActivityRecord, sessionWorkItem, stageOf, taskHasMaterials, workItemSessions,
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

test("三种写入各记什么：启动插一行、挂上会话、记一条带记录号的事件；换站只改这一行、记一条换站的事件；结束填上状态与时刻、记一条结束的事件", () => {
  const { dir, taskId } = workspace();
  const who = { taskId, sessionId: "sess-1", runId: null, callId: "ui-op-1", actor: "user" as const };
  const started = write(dir, (db) => launchWorkItem(db, { ...who, to: "clarifying", inFlow: true, reason: "", scope: " 只做借阅 " }));
  assert.equal(started.record_id, write(dir, (db) => sessionWorkItem(db, taskId, "sess-1"))!.record_id);
  // 每次写之前在同一个事务里现取这一行，写函数照它现在的活动与所在的一站记。
  const entered = write(dir, (db) => enterNode(db, sessionWorkItem(db, taskId, "sess-1")!, "writing", { ...who, callId: "ui-op-2" }, "澄清够了"));
  const back = write(dir, (db) => enterNode(db, sessionWorkItem(db, taskId, "sess-1")!, "modeling", { ...who, runId: "r2", callId: "call-reply-1", actor: "executor" }, ""));
  write(dir, (db) => attachSession(db, taskId, started.record_id, "sess-2"));
  const ended = write(dir, (db) => endWorkItem(db, sessionWorkItem(db, taskId, "sess-1")!, "abandoned", { taskId, sessionId: "sess-2", callId: "ui-op-3", actor: "user" }, "不做了"));
  const events = query<{ seq: number; name: string; actor: string; session_id: string; call_id: string; payload: string }>(dir,
    "SELECT seq, name, actor, session_id, call_id, payload FROM event WHERE name IN (?, ?, ?, ?) ORDER BY seq", EVENT_ACTIVITY_STARTED, EVENT_ACTIVITY_ENDED, EVENT_NODE_ENTERED, EVENT_STAGE_MOVED);
  assert.deepEqual(events.map((e) => [e.seq, e.name, e.actor, e.session_id, e.call_id, JSON.parse(e.payload)]), [
    [started.event_seq, "ACTIVITY_STARTED", "user", "sess-1", "ui-op-1",
      { record_id: started.record_id, activity: "clarifying", node: "clarifying", flow: "initial", from: null, actor: "user", reason: "", run_id: null, scope: "只做借阅" }],
    [entered, "ACTIVITY_NODE_ENTERED", "user", "sess-1", "ui-op-2",
      { record_id: started.record_id, flow: "initial", node: "writing", from: "clarifying", direction: "forward", actor: "user", reason: "澄清够了", run_id: null }],
    [back, "ACTIVITY_NODE_ENTERED", "executor", "sess-1", "call-reply-1",
      { record_id: started.record_id, flow: "initial", node: "modeling", from: "writing", direction: "back", actor: "executor", reason: "", run_id: "r2" }],
    [ended, "ACTIVITY_ENDED", "user", "sess-2", "ui-op-3",
      { record_id: started.record_id, activity: "modeling", node: "modeling", flow: "initial", outcome: "abandoned", reason: "不做了", actor: "user" }],
  ]);
  // 自始至终只有一行；两条会话都属于它；结束之后两条会话都不在做哪个工作项。
  const rows = write(dir, (db) => activityRecords(db, taskId));
  assert.deepEqual(rows.map((r) => [r.record_id, r.activity, r.node, r.flow, r.status, r.scope, r.session_id, r.started_seq, r.ended_seq, r.from]),
    [[started.record_id, "modeling", "modeling", "initial", "abandoned", "只做借阅", "sess-1", started.event_seq, ended, null]]);
  assert.ok(rows[0].ended_at !== null);
  assert.deepEqual(write(dir, (db) => workItemSessions(db, taskId)).map((one) => [one.session_id, one.record_id]), [["sess-1", started.record_id], ["sess-2", started.record_id]]);
  assert.deepEqual(write(dir, (db) => [sessionWorkItem(db, taskId, "sess-2")?.status, openActivityRecord(db, taskId, "sess-1"), currentStage(db, taskId, "sess-2")]), ["abandoned", null, "idle"]);
  // 一条会话只属于一个工作项：已经挂过的会话再挂别的不改。
  const other = write(dir, (db) => launchWorkItem(db, { ...who, sessionId: "sess-3", callId: "ui-op-4", to: "clarifying", inFlow: false, reason: "" }));
  write(dir, (db) => attachSession(db, taskId, other.record_id, "sess-1"));
  assert.equal(write(dir, (db) => sessionWorkItem(db, taskId, "sess-1"))!.record_id, started.record_id);
  assert.deepEqual(write(dir, (db) => [currentStage(db, taskId, "sess-3"), currentStage(db, taskId, null), currentStage(db, taskId, "没有这条会话")]), ["clarifying", "idle", "idle"]);
});

test("早先建的任务（任务定义里没有总体分析集合）没有阶段", () => {
  const { dir, taskId } = workspace(demoDefinition());
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, validateDefinition(demoDefinition()))), null);
});

test("格式版本 1 的库没有活动记录表：只读的一侧当作没有记录；写入一侧打开时升到现在的版本并补上表，原有的行都还在", () => {
  const { dir, taskId } = workspace();
  write(dir, (db) => db.exec("DROP TABLE activity_record; PRAGMA user_version = 1"));
  const ro = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    assert.equal(hasActivityTable(ro), false);
    assert.equal(openActivityRecord(ro, taskId), null);
    assert.deepEqual(activityRecords(ro, taskId), []);
    assert.equal(currentStage(ro, taskId), "idle");
  } finally {
    ro.close();
  }
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 1, to: TASK_DB_VERSION });
  assert.equal(query<{ user_version: number }>(dir, "PRAGMA user_version")[0].user_version, TASK_DB_VERSION);
  assert.equal(query(dir, "SELECT task_id FROM task").length, 1, "任务那一行还在");
  write(dir, (db) => launchWorkItem(db, { taskId, sessionId: "s", runId: null, callId: "c", actor: "user", to: "clarifying", inFlow: true, reason: "读完了。" }));
  assert.equal(query(dir, "SELECT * FROM activity_record").length, 1);
  // 再升一次：已经是现在的版本，什么都不做。
  assert.deepEqual(upgradeTaskDatabase(dir), { from: TASK_DB_VERSION, to: TASK_DB_VERSION });
});

const tableThere = (dir: string, name: string) => query(dir, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).length === 1;

test("没有编过版本号的库一次升到现在的版本，活动记录表一并补上；早先的阶段记录表不留", () => {
  const { dir } = workspace();
  write(dir, (db) => db.exec("DROP TABLE activity_record; PRAGMA user_version = 0"));
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 0, to: TASK_DB_VERSION });
  assert.deepEqual([tableThere(dir, "activity_record"), tableThere(dir, "stage_record")], [true, false]);
});

test("新建的库：有活动记录表，没有早先的阶段记录表", () => {
  const { dir } = workspace();
  assert.deepEqual([tableThere(dir, "activity_record"), tableThere(dir, "stage_record")], [true, false]);
  assert.equal(query<{ user_version: number }>(dir, "PRAGMA user_version")[0].user_version, TASK_DB_VERSION);
});

/** 格式版本 4 的阶段记录表（0.5.0 的建表语句）与往里放的一次移动。 */
const V4_STAGE_RECORD_SQL = `
CREATE TABLE stage_record (
  record_id    INTEGER PRIMARY KEY,
  task_id      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  run_id       TEXT,
  call_id      TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('executor', 'user')),
  stage        TEXT NOT NULL,
  from_stage   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  event_seq    INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);`;

/**
 * 把一个现在的库改回格式版本 4 的样子，放进几次移动：每次一条 STAGE_MOVED 事件加一行阶段记录。flow 给 null 的那一次，事件里不写所属流程；
 * dropEvents 为真时放完再把这几条事件删掉。直接开库改，不经 withTaskDatabase（它一打开就会升级）。返回各条事件的序号。
 */
function asVersion4(dir: string, taskId: string, moves: { from: string; to: string; at: string; reason?: string; flow?: string | null; record_id?: number }[],
  dropEvents = false): number[] {
  const db = new DatabaseSync(databasePath(dir));
  try {
    db.exec(`DROP TABLE activity_record; ${V4_STAGE_RECORD_SQL}`);
    const seqs = moves.map((move, index) => {
      const payload = { stage: move.to, from: move.from, actor: "user", reason: move.reason ?? "", run_id: null, ...(move.flow === null ? {} : { flow: move.flow ?? "initial" }) };
      const seq = Number(db.prepare(
        "INSERT INTO event (task_id, session_id, call_id, name, actor, payload, at) VALUES (?, 'sess-old', ?, 'STAGE_MOVED', 'user', ?, ?)",
      ).run(taskId, `ui-op-${index + 1}`, JSON.stringify(payload), move.at).lastInsertRowid);
      db.prepare(
        "INSERT INTO stage_record (record_id, task_id, session_id, run_id, call_id, actor, stage, from_stage, reason, event_seq, created_at) VALUES (?, ?, 'sess-old', NULL, ?, 'user', ?, ?, ?, ?, ?)",
      ).run(move.record_id ?? null, taskId, `ui-op-${index + 1}`, move.to, move.from, move.reason ?? "", seq, move.at);
      return seq;
    });
    if (dropEvents) db.exec("DELETE FROM event WHERE name = 'STAGE_MOVED'");
    db.exec("PRAGMA user_version = 4");
    return seqs;
  } finally {
    db.close();
  }
}

test("格式版本 4 升到现在的版本：阶段记录先逐行改写成活动记录，再归并成工作项——同一条流程的并成一行、取最晚的一站，还在进行；阶段记录表删掉，事件一条不动", () => {
  const { dir, taskId } = workspace();
  const seqs = asVersion4(dir, taskId, [
    { from: "reading", to: "clarifying", at: "2026-10-10T09:00:00", reason: "材料读完了。", record_id: 3 },
    { from: "clarifying", to: "writing", at: "2026-10-10T10:30:00", flow: null, record_id: 7 },   // 早先的移动事件里没有写所属流程
    { from: "writing", to: "clarifying", at: "2026-10-11T08:15:00", reason: "借期要重新问。", flow: "change", record_id: 8 },
  ]);
  const events = query(dir, "SELECT seq, name, payload, at FROM event ORDER BY seq").map((row) => ({ ...row }));
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 4, to: TASK_DB_VERSION });
  assert.deepEqual([tableThere(dir, "activity_record"), tableThere(dir, "stage_record"), tableThere(dir, "work_item_session")], [true, false, true]);
  // 首次分析的两行并成一行（留最早那一行的记录号与启动的时刻，活动与所在的一站取最晚那一行的）；另一条流程的那一行自己是一个工作项。
  assert.deepEqual(query(dir, "SELECT * FROM activity_record ORDER BY started_seq").map((row) => ({ ...row })), [
    { record_id: 3, task_id: taskId, session_id: "sess-old", run_id: null, call_id: "ui-op-1", actor: "user", activity: "writing", node: "writing", flow: "initial",
      reason: "材料读完了。", started_at: "2026-10-10T09:00:00", ended_at: null, started_seq: seqs[0], ended_seq: null, scope: null, status: "active" },
    { record_id: 8, task_id: taskId, session_id: "sess-old", run_id: null, call_id: "ui-op-3", actor: "user", activity: "clarifying", node: "clarifying", flow: "change",
      reason: "借期要重新问。", started_at: "2026-10-11T08:15:00", ended_at: null, started_seq: seqs[2], ended_seq: null, scope: null, status: "active" },
  ]);
  assert.deepEqual(query(dir, "SELECT seq, name, payload, at FROM event ORDER BY seq").map((row) => ({ ...row })), events, "事件表原样不动，早先的移动事件仍叫 STAGE_MOVED");
  // 那条旧会话挂到它最晚启动的那一行归入的工作项上：现在在澄清。
  assert.deepEqual(query(dir, "SELECT session_id, record_id, attached_at FROM work_item_session").map((row) => ({ ...row })), [{ session_id: "sess-old", record_id: 8, attached_at: "2026-10-11T08:15:00" }]);
  const definition = validateDefinition(overallDefinition());
  assert.deepEqual(write(dir, (db) => [stageOf(db, dir, taskId, definition, "sess-old"), stageOf(db, dir, taskId, definition, "sess-new")]), ["clarifying", "idle"]);
  assert.deepEqual(write(dir, (db) => activityRecords(db, taskId)).map((r) => [r.from, r.activity, r.flow]), [["reading", "writing", "initial"], ["writing", "clarifying", "change"]]);
  // 升级之后照常换一站：还是那一行，记的是现在的换站事件。
  const moved = write(dir, (db) => moveStage(db, dir, { taskId, sessionId: "sess-old", runId: null, callId: "ui-op-9", actor: "user" }, "modeling", ""));
  assert.deepEqual(query<{ seq: number; name: string }>(dir, "SELECT seq, name FROM event WHERE seq > ? ORDER BY seq", seqs[2]).map((e) => [e.seq, e.name]), [[moved.event_seq, "ACTIVITY_NODE_ENTERED"]]);
  assert.deepEqual(query<{ record_id: number; activity: string; status: string }>(dir, "SELECT record_id, activity, status FROM activity_record ORDER BY started_seq").map((r) => [r.record_id, r.activity, r.status]),
    [[3, "writing", "active"], [8, "modeling", "active"]]);
  // 再升一次：已经是现在的版本，什么都不做。
  assert.deepEqual(upgradeTaskDatabase(dir), { from: TASK_DB_VERSION, to: TASK_DB_VERSION });
});

test("格式版本 4 升到现在的版本：一次都没有移动过的库只换表，没有工作项，升级之后会话都是空闲；记下移动的事件已经不在时所属流程写首次分析", () => {
  const empty = workspace();
  asVersion4(empty.dir, empty.taskId, []);
  assert.deepEqual(upgradeTaskDatabase(empty.dir), { from: 4, to: TASK_DB_VERSION });
  assert.deepEqual([tableThere(empty.dir, "activity_record"), tableThere(empty.dir, "stage_record"), query(empty.dir, "SELECT * FROM activity_record").length, query(empty.dir, "SELECT * FROM work_item_session").length],
    [true, false, 0, 0]);
  // 0.5 里这样的任务按有没有材料算在核读材料或澄清；升级之后它没有工作项，哪条会话都是空闲。
  assert.equal(write(empty.dir, (db) => stageOf(db, empty.dir, empty.taskId, validateDefinition(overallDefinition()), "sess-old")), "idle");

  const { dir, taskId } = workspace();
  asVersion4(dir, taskId, [{ from: "reading", to: "clarifying", at: "2026-10-10T09:00:00" }, { from: "clarifying", to: "modeling", at: "2026-10-10T10:00:00", flow: "change" }], true);
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 4, to: TASK_DB_VERSION });
  // 两行都算首次分析（事件不在了，无从知道第二行写过别的流程），并成一行；从哪个阶段来也无从知道。
  assert.deepEqual(write(dir, (db) => activityRecords(db, taskId)).map((r) => [r.from, r.activity, r.flow, r.status]), [[null, "modeling", "initial", "active"]]);
});

/** 格式版本 6 的活动记录表（没有状态一列），库里也没有工作项的会话表。 */
const V6_ACTIVITY_RECORD_SQL = `
CREATE TABLE activity_record (
  record_id    INTEGER PRIMARY KEY,
  task_id      TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  run_id       TEXT,
  call_id      TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('executor', 'user')),
  activity     TEXT NOT NULL,
  node         TEXT,
  flow         TEXT,
  reason       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  started_seq  INTEGER NOT NULL,
  ended_seq    INTEGER,
  scope        TEXT
);`;

type V6Row = { session: string; activity: string; inFlow: boolean; at: string; until: string | null; scope?: string };
/**
 * 把一个现在的库改回格式版本 6 的样子：活动记录表没有状态一列，一行是一项活动的一段；没有工作项的会话表。rows 按先后放进去，记录号从 1 起。
 * status 与 endedAt 是任务的状态与结束的时刻。直接开库改，不经 withTaskDatabase（它一打开就会升级）。
 */
function asVersion6(dir: string, taskId: string, rows: V6Row[], status = "进行中", endedAt: string | null = null): void {
  const db = new DatabaseSync(databasePath(dir));
  try {
    db.exec(`DROP TABLE activity_record; DROP TABLE work_item_session; ${V6_ACTIVITY_RECORD_SQL}`);
    rows.forEach((row, index) => {
      db.prepare(
        "INSERT INTO activity_record (record_id, task_id, session_id, run_id, call_id, actor, activity, node, flow, reason, started_at, ended_at, started_seq, ended_seq, scope) VALUES (?, ?, ?, NULL, ?, 'user', ?, ?, ?, '', ?, ?, ?, ?, ?)",
      ).run(index + 1, taskId, row.session, `ui-op-${index + 1}`, row.activity, row.inFlow ? row.activity : null, row.inFlow ? "initial" : null, row.at, row.until,
        1000 + index * 2, row.until === null ? null : 1001 + index * 2, row.scope ?? null);
    });
    db.prepare("UPDATE task SET status = ?, ended_at = ?").run(status, endedAt);
    db.exec("PRAGMA user_version = 6");
  } finally {
    db.close();
  }
}

/** 早先一个任务走过的一段：首次分析走了两站，改做了一次单项的整理建模，在另一条会话里接着走首次分析，又改做单项的澄清（还在进行）。 */
const V6_ROWS: V6Row[] = [
  { session: "s1", activity: "reading", inFlow: true, at: "2026-10-10T09:00:00", until: "2026-10-10T10:00:00" },
  { session: "s1", activity: "clarifying", inFlow: true, at: "2026-10-10T10:00:00", until: "2026-10-10T11:00:00", scope: "只做借阅" },
  { session: "s2", activity: "modeling", inFlow: false, at: "2026-10-10T11:00:00", until: "2026-10-10T12:00:00" },
  { session: "s3", activity: "writing", inFlow: true, at: "2026-10-10T12:00:00", until: "2026-10-10T13:00:00" },
  { session: "s2", activity: "clarifying", inFlow: false, at: "2026-10-10T13:00:00", until: null },
];
const workItems = (dir: string) => query<{ record_id: number; activity: string; node: string | null; flow: string | null; status: string; started_at: string; ended_at: string | null; scope: string | null }>(dir,
  "SELECT record_id, activity, node, flow, status, started_at, ended_at, scope FROM activity_record ORDER BY started_seq").map((r) => [r.record_id, r.activity, r.node, r.flow, r.status, r.started_at, r.ended_at, r.scope]);

test("格式版本 6 升到 7：同一条流程的各行并成一个工作项（被单项活动隔开的也并），单项活动的每行各一个；流程的工作项还在进行、位置取最晚一行；会话挂到它最晚启动的那一行归入的工作项上", () => {
  const { dir, taskId } = workspace();
  asVersion6(dir, taskId, V6_ROWS);
  // 只读的一侧遇到还没有升级的库：没有工作项的会话表，哪条会话都当作空闲，不出错。
  const ro = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    assert.deepEqual([hasSessionTable(ro), sessionWorkItem(ro, taskId, "s1"), currentStage(ro, taskId, "s2"), activityRecords(ro, taskId).map((r) => r.status)],
      [false, null, "idle", ["done", "done", "done", "done", "active"]]);
  } finally {
    ro.close();
  }
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 6, to: TASK_DB_VERSION });
  // 五行变三个工作项：首次分析一个（留第 1 行，现在在写条目，范围说明取最晚写了的，仍在进行、结束的时刻清空），整理建模已做完，澄清在进行。
  assert.deepEqual(workItems(dir), [
    [1, "writing", "writing", "initial", "active", "2026-10-10T09:00:00", null, "只做借阅"],
    [3, "modeling", null, null, "done", "2026-10-10T11:00:00", "2026-10-10T12:00:00", null],
    [5, "clarifying", null, null, "active", "2026-10-10T13:00:00", null, null],
  ]);
  assert.deepEqual(query(dir, "SELECT ended_seq FROM activity_record ORDER BY started_seq").map((r) => r.ended_seq), [null, 1005, null]);
  // 会话：s1 只启动过流程里的行；s2 先后启动过两个单项活动，挂到最晚的那一个；s3 是接着走流程的那一条。别的会话不属于任何工作项。
  assert.deepEqual(query(dir, "SELECT session_id, record_id, attached_at FROM work_item_session ORDER BY session_id").map((row) => ({ ...row })), [
    { session_id: "s1", record_id: 1, attached_at: "2026-10-10T10:00:00" }, { session_id: "s2", record_id: 5, attached_at: "2026-10-10T13:00:00" },
    { session_id: "s3", record_id: 1, attached_at: "2026-10-10T12:00:00" }]);
  const definition = validateDefinition(overallDefinition());
  assert.deepEqual(write(dir, (db) => ["s1", "s2", "s3", "s-free"].map((one) => stageOf(db, dir, taskId, definition, one))), ["writing", "clarifying", "writing", "idle"]);
  // 再升一次：已经是现在的版本，什么都不改。
  assert.deepEqual(upgradeTaskDatabase(dir), { from: TASK_DB_VERSION, to: TASK_DB_VERSION });
  assert.equal(workItems(dir).length, 3);
});

test("格式版本 6 升到 7 时任务已经结束：已完成的任务工作项都记已做完；已放弃的任务里还没有结束的记已放弃、结束了的记已做完；没有结束时刻的补上任务结束的时刻", () => {
  const done = workspace();
  asVersion6(done.dir, done.taskId, V6_ROWS, "已完成", "2026-10-11T08:00:00");
  assert.deepEqual(upgradeTaskDatabase(done.dir), { from: 6, to: TASK_DB_VERSION });
  assert.deepEqual(workItems(done.dir).map((one) => [one[0], one[4], one[6]]), [[1, "done", "2026-10-10T13:00:00"], [3, "done", "2026-10-10T12:00:00"], [5, "done", "2026-10-11T08:00:00"]]);
  const abandoned = workspace();
  asVersion6(abandoned.dir, abandoned.taskId, V6_ROWS, "已放弃", "2026-10-11T09:00:00");
  assert.deepEqual(upgradeTaskDatabase(abandoned.dir), { from: 6, to: TASK_DB_VERSION });
  assert.deepEqual(workItems(abandoned.dir).map((one) => [one[0], one[4], one[6]]), [[1, "done", "2026-10-10T13:00:00"], [3, "done", "2026-10-10T12:00:00"], [5, "abandoned", "2026-10-11T09:00:00"]]);
  // 一行记录都没有的库：只加列与表。
  const empty = workspace();
  asVersion6(empty.dir, empty.taskId, []);
  assert.deepEqual(upgradeTaskDatabase(empty.dir), { from: 6, to: TASK_DB_VERSION });
  assert.deepEqual([workItems(empty.dir).length, tableThere(empty.dir, "work_item_session"), query<{ name: string }>(empty.dir, "PRAGMA table_info(activity_record)").some((one) => one.name === "status")], [0, true, true]);
});
