/**
 * 工作的阶段里读写库的那一半（src/lib/stage_read.ts）：没有记录时的缺省、记一次移动（结束前一条活动记录、开始新的一条）、读还在进行的那一条；
 * 以及活动记录表怎样补到已有的库里（更早格式的库升级时补上）。
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
import { EVENT_ACTIVITY_ENDED, EVENT_ACTIVITY_STARTED, EVENT_STAGE_MOVED, activityRecords, currentStage, hasActivityTable, openActivityRecord, recordStageMove, stageOf, taskHasMaterials } from "../src/lib/stage_read.ts";
import { DEFINITION_PATH, callIn, demoDefinition, makeWorkspace, overallDefinition, query } from "./helpers.ts";

function workspace(definition: unknown = overallDefinition(), material = true): { dir: string; taskId: string } {
  const dir = makeWorkspace(definition, { material });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return { dir, taskId: query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id };
}
const write = <T>(dir: string, body: (db: DatabaseSync) => T) => withTaskDatabase(dir, { createIfMissing: false }, body);

test("没有在进行的活动记录时任务空闲：刚建好的任务有没有材料都是空闲，空闲不落库，上传材料也不改变它", () => {
  const { dir, taskId } = workspace(overallDefinition(), false);
  const definition = validateDefinition(overallDefinition());
  assert.equal(taskHasMaterials(dir, definition.materialsDir), false);
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, definition)), "idle");
  mkdirSync(join(dir, "inputs"), { recursive: true });
  writeFileSync(join(dir, "inputs/材料.md"), "读者凭借书证借书。", "utf-8");
  assert.equal(taskHasMaterials(dir, definition.materialsDir), true);
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, definition)), "idle");
  assert.equal(query(dir, "SELECT * FROM activity_record").length, 0, "空闲不落库");
  rmSync(join(dir, "inputs/材料.md"));
});

test("记一次移动：结束前一条活动记录、开始新的一条，各记一条事件，序号对得上；第一次移动没有可结束的；有了记录之后只看还在进行的那一条，不再看有没有材料", () => {
  const { dir, taskId } = workspace();
  const first = write(dir, (db) => recordStageMove(db, { taskId, sessionId: "sess-1", runId: "r2", callId: "call-reply-1", actor: "executor",
    from: "reading", to: "clarifying", reason: "材料读完了，先问借期。" }));
  const second = write(dir, (db) => recordStageMove(db, { taskId, sessionId: "sess-1", runId: null, callId: "ui-op-7", actor: "user",
    from: "clarifying", to: "writing", reason: "" }));
  assert.ok(second > first);
  const events = query<{ seq: number; name: string; actor: string; call_id: string; payload: string }>(dir,
    "SELECT seq, name, actor, call_id, payload FROM event WHERE name IN (?, ?, ?) ORDER BY seq", EVENT_ACTIVITY_STARTED, EVENT_ACTIVITY_ENDED, EVENT_STAGE_MOVED);
  // 第一次移动之前任务没有记录（核读材料是缺省的位置），只记开始；第二次先结束澄清、再开始写条目，两条紧挨着。早先的事件名不再记。
  assert.deepEqual(events.map((e) => [e.seq, e.name, e.actor, e.call_id, JSON.parse(e.payload)]), [
    [first, "ACTIVITY_STARTED", "executor", "call-reply-1",
      { activity: "clarifying", node: "clarifying", flow: "initial", from: "reading", actor: "executor", reason: "材料读完了，先问借期。", run_id: "r2" }],
    [second - 1, "ACTIVITY_ENDED", "user", "ui-op-7", { activity: "clarifying", node: "clarifying", reason: "", actor: "user" }],
    [second, "ACTIVITY_STARTED", "user", "ui-op-7", { activity: "writing", node: "writing", flow: "initial", from: "clarifying", actor: "user", reason: "", run_id: null }],
  ]);
  const rows = write(dir, (db) => activityRecords(db, taskId));
  assert.deepEqual(rows.map((r) => [r.activity, r.from, r.actor, r.reason, r.run_id, r.session_id, r.call_id, r.started_seq]), [
    ["clarifying", "reading", "executor", "材料读完了，先问借期。", "r2", "sess-1", "call-reply-1", first],
    ["writing", "clarifying", "user", "", null, "sess-1", "ui-op-7", second],
  ]);
  // 每条记录的节点与活动同一个写法，所属流程是首次分析；前一条在后一条开始的那一刻结束，最后一条还在进行。
  assert.deepEqual(rows.map((r) => [r.node, r.flow, r.ended_seq, r.ended_at]), [["clarifying", "initial", second - 1, rows[1].started_at], ["writing", "initial", null, null]]);
  assert.deepEqual(write(dir, (db) => openActivityRecord(db, taskId))!.activity, "writing");
  assert.equal(write(dir, (db) => openActivityRecord(db, taskId))!.record_id, rows[1].record_id);
  assert.deepEqual(write(dir, (db) => currentStage(db, taskId)), "writing");
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
  write(dir, (db) => recordStageMove(db, { taskId, sessionId: "s", runId: "r1", callId: "c", actor: "executor", from: "reading", to: "clarifying", reason: "读完了。" }));
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

test("格式版本 4 升到 5：每条阶段记录改写成一条活动记录，前一条在后一条的时刻结束，最后一条还在进行；阶段记录表删掉，事件一条不动", () => {
  const { dir, taskId } = workspace();
  const seqs = asVersion4(dir, taskId, [
    { from: "reading", to: "clarifying", at: "2026-10-10T09:00:00", reason: "材料读完了。", record_id: 3 },
    { from: "clarifying", to: "writing", at: "2026-10-10T10:30:00", flow: null, record_id: 7 },   // 早先的移动事件里没有写所属流程
    { from: "writing", to: "clarifying", at: "2026-10-11T08:15:00", reason: "借期要重新问。", flow: "change", record_id: 8 },
  ]);
  const events = query(dir, "SELECT seq, name, payload, at FROM event ORDER BY seq").map((row) => ({ ...row }));
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 4, to: TASK_DB_VERSION });
  assert.deepEqual([tableThere(dir, "activity_record"), tableThere(dir, "stage_record")], [true, false]);
  assert.deepEqual(query(dir, "SELECT * FROM activity_record ORDER BY started_seq").map((row) => ({ ...row })), [
    { record_id: 3, task_id: taskId, session_id: "sess-old", run_id: null, call_id: "ui-op-1", actor: "user", activity: "clarifying", node: "clarifying", flow: "initial",
      reason: "材料读完了。", started_at: "2026-10-10T09:00:00", ended_at: "2026-10-10T10:30:00", started_seq: seqs[0], ended_seq: seqs[1], scope: null },
    { record_id: 7, task_id: taskId, session_id: "sess-old", run_id: null, call_id: "ui-op-2", actor: "user", activity: "writing", node: "writing", flow: "initial",
      reason: "", started_at: "2026-10-10T10:30:00", ended_at: "2026-10-11T08:15:00", started_seq: seqs[1], ended_seq: seqs[2], scope: null },
    { record_id: 8, task_id: taskId, session_id: "sess-old", run_id: null, call_id: "ui-op-3", actor: "user", activity: "clarifying", node: "clarifying", flow: "change",
      reason: "借期要重新问。", started_at: "2026-10-11T08:15:00", ended_at: null, started_seq: seqs[2], ended_seq: null, scope: null },
  ]);
  assert.deepEqual(query(dir, "SELECT seq, name, payload, at FROM event ORDER BY seq").map((row) => ({ ...row })), events, "事件表原样不动，早先的移动事件仍叫 STAGE_MOVED");
  // 读出来：现在在澄清；每条记录从哪个阶段来取自那条移动事件。
  const definition = validateDefinition(overallDefinition());
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, definition)), "clarifying");
  assert.deepEqual(write(dir, (db) => activityRecords(db, taskId)).map((r) => [r.from, r.activity, r.flow]),
    [["reading", "clarifying", "initial"], ["clarifying", "writing", "initial"], ["writing", "clarifying", "change"]]);
  // 升级之后照常再移一次：接在后面，前一条随之结束；这一次记的是现在的两种事件。
  const moved = write(dir, (db) => recordStageMove(db, { taskId, sessionId: "s", runId: null, callId: "ui-op-9", actor: "user", from: "clarifying", to: "modeling", reason: "" }));
  assert.deepEqual(query<{ seq: number; name: string }>(dir, "SELECT seq, name FROM event WHERE seq > ? ORDER BY seq", seqs[2]).map((e) => [e.seq, e.name]),
    [[moved - 1, "ACTIVITY_ENDED"], [moved, "ACTIVITY_STARTED"]]);
  assert.deepEqual(query(dir, "SELECT ended_seq, started_seq FROM activity_record WHERE record_id IN (8, 9) ORDER BY record_id").map((r) => ({ ...r })),
    [{ ended_seq: moved - 1, started_seq: seqs[2] }, { ended_seq: null, started_seq: moved }]);
  assert.deepEqual(query<{ activity: string; open: number }>(dir, "SELECT activity, ended_at IS NULL AS open FROM activity_record ORDER BY started_seq").map((r) => [r.activity, r.open]),
    [["clarifying", 0], ["writing", 0], ["clarifying", 0], ["modeling", 1]]);
  // 再升一次：已经是现在的版本，什么都不做。
  assert.deepEqual(upgradeTaskDatabase(dir), { from: TASK_DB_VERSION, to: TASK_DB_VERSION });
});

test("格式版本 4 升到 5：一次都没有移动过的库只换表，没有记录，升级之后是空闲；记下移动的事件已经不在时所属流程写首次分析、从哪里来取前一条记录", () => {
  const empty = workspace();
  asVersion4(empty.dir, empty.taskId, []);
  assert.deepEqual(upgradeTaskDatabase(empty.dir), { from: 4, to: TASK_DB_VERSION });
  assert.deepEqual([tableThere(empty.dir, "activity_record"), tableThere(empty.dir, "stage_record"), query(empty.dir, "SELECT * FROM activity_record").length], [true, false, 0]);
  // 0.5 里这样的任务按有没有材料算在核读材料或澄清；升级之后它没有活动记录，是空闲。
  assert.equal(write(empty.dir, (db) => stageOf(db, empty.dir, empty.taskId, validateDefinition(overallDefinition()))), "idle");

  const { dir, taskId } = workspace();
  asVersion4(dir, taskId, [{ from: "reading", to: "clarifying", at: "2026-10-10T09:00:00" }, { from: "clarifying", to: "modeling", at: "2026-10-10T10:00:00", flow: "change" }], true);
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 4, to: TASK_DB_VERSION });
  assert.deepEqual(write(dir, (db) => activityRecords(db, taskId)).map((r) => [r.from, r.activity, r.flow]), [[null, "clarifying", "initial"], ["clarifying", "modeling", "initial"]]);
});
