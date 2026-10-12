/**
 * 工作的阶段里读写库的那一半（src/lib/stage_read.ts）：没有记录时的缺省、记一次移动、读最近一条；
 * 以及阶段记录表怎样补到已有的库里（格式版本 1 的库升级时补上）。
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
import { EVENT_STAGE_MOVED, currentStage, hasStageTable, lastStageRecord, recordStageMove, stageOf, stageRecords, taskHasMaterials } from "../src/lib/stage_read.ts";
import { DEFINITION_PATH, callIn, demoDefinition, makeWorkspace, overallDefinition, query } from "./helpers.ts";

function workspace(definition: unknown = overallDefinition(), material = true): { dir: string; taskId: string } {
  const dir = makeWorkspace(definition, { material });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return { dir, taskId: query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id };
}
const write = <T>(dir: string, body: (db: DatabaseSync) => T) => withTaskDatabase(dir, { createIfMissing: false }, body);

test("没有记录时：有材料在核读材料，没有材料在澄清；这个缺省不落库，上传了材料就跟着变", () => {
  const { dir, taskId } = workspace(overallDefinition(), false);
  const definition = validateDefinition(overallDefinition());
  assert.equal(taskHasMaterials(dir, definition.materialsDir), false);
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, definition)), "clarifying");
  mkdirSync(join(dir, "inputs"), { recursive: true });
  writeFileSync(join(dir, "inputs/材料.md"), "读者凭借书证借书。", "utf-8");
  assert.equal(taskHasMaterials(dir, definition.materialsDir), true);
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, definition)), "reading");
  assert.equal(query(dir, "SELECT * FROM stage_record").length, 0, "缺省不落库");
  // 材料又拿掉：没有记录时照样跟着变回澄清。
  rmSync(join(dir, "inputs/材料.md"));
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, definition)), "clarifying");
});

test("记一次移动：一条事件加一行记录，同一个事件序号；有了记录之后只看最近一条，不再看有没有材料", () => {
  const { dir, taskId } = workspace();
  const first = write(dir, (db) => recordStageMove(db, { taskId, sessionId: "sess-1", runId: "r2", callId: "call-reply-1", actor: "executor",
    from: "reading", to: "clarifying", reason: "材料读完了，先问借期。" }));
  const second = write(dir, (db) => recordStageMove(db, { taskId, sessionId: "sess-1", runId: null, callId: "ui-op-7", actor: "user",
    from: "clarifying", to: "writing", reason: "" }));
  assert.ok(second > first);
  const events = query<{ seq: number; name: string; actor: string; call_id: string; payload: string }>(dir, "SELECT seq, name, actor, call_id, payload FROM event WHERE name = ? ORDER BY seq", EVENT_STAGE_MOVED);
  assert.deepEqual(events.map((e) => [e.seq, e.actor, e.call_id, JSON.parse(e.payload)]), [
    [first, "executor", "call-reply-1", { stage: "clarifying", from: "reading", actor: "executor", reason: "材料读完了，先问借期。", run_id: "r2", flow: "initial" }],
    [second, "user", "ui-op-7", { stage: "writing", from: "clarifying", actor: "user", reason: "", run_id: null, flow: "initial" }],
  ]);
  const rows = write(dir, (db) => stageRecords(db, taskId));
  assert.deepEqual(rows.map((r) => [r.stage, r.from_stage, r.actor, r.reason, r.run_id, r.session_id, r.call_id, r.event_seq]), [
    ["clarifying", "reading", "executor", "材料读完了，先问借期。", "r2", "sess-1", "call-reply-1", first],
    ["writing", "clarifying", "user", "", null, "sess-1", "ui-op-7", second],
  ]);
  assert.equal(write(dir, (db) => lastStageRecord(db, taskId))!.stage, "writing");
  // 有记录之后，有没有材料都不再改变所在的阶段。
  assert.deepEqual(write(dir, (db) => [currentStage(db, taskId, true), currentStage(db, taskId, false)]), ["writing", "writing"]);
});

test("早先建的任务（任务定义里没有总体分析集合）没有阶段", () => {
  const { dir, taskId } = workspace(demoDefinition());
  assert.equal(write(dir, (db) => stageOf(db, dir, taskId, validateDefinition(demoDefinition()))), null);
});

test("格式版本 1 的库没有阶段记录表：只读的一侧当作没有记录；写入一侧打开时升到现在的版本并补上表，原有的行都还在", () => {
  const { dir, taskId } = workspace();
  write(dir, (db) => db.exec("DROP TABLE stage_record; PRAGMA user_version = 1"));
  const ro = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    assert.equal(hasStageTable(ro), false);
    assert.equal(lastStageRecord(ro, taskId), null);
    assert.deepEqual(stageRecords(ro, taskId), []);
    assert.equal(currentStage(ro, taskId, true), "reading");
  } finally {
    ro.close();
  }
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 1, to: TASK_DB_VERSION });
  assert.equal(query<{ user_version: number }>(dir, "PRAGMA user_version")[0].user_version, TASK_DB_VERSION);
  assert.equal(query(dir, "SELECT task_id FROM task").length, 1, "任务那一行还在");
  write(dir, (db) => recordStageMove(db, { taskId, sessionId: "s", runId: "r1", callId: "c", actor: "executor", from: "reading", to: "clarifying", reason: "读完了。" }));
  assert.equal(query(dir, "SELECT * FROM stage_record").length, 1);
  // 再升一次：已经是现在的版本，什么都不做。
  assert.deepEqual(upgradeTaskDatabase(dir), { from: TASK_DB_VERSION, to: TASK_DB_VERSION });
});

test("没有编过版本号的库一次升到现在的版本，阶段记录表一并补上", () => {
  const { dir } = workspace();
  write(dir, (db) => db.exec("DROP TABLE stage_record; PRAGMA user_version = 0"));
  assert.deepEqual(upgradeTaskDatabase(dir), { from: 0, to: TASK_DB_VERSION });
  assert.equal(query(dir, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_record'").length, 1);
});
