/**
 * 阶段记录的「所属流程」：写在阶段移动那条事件的内容里（现在恒为首次分析 initial），读阶段记录时带出来；
 * 早先记下的移动事件里没有写它，读出来补首次分析。不加列，任务库的格式版本不变。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { TASK_DB_VERSION, withTaskDatabase } from "../src/lib/schema.ts";
import { FLOW_INITIAL, FLOW_NAMES } from "../src/lib/stage.ts";
import { lastStageRecord, stageRecords } from "../src/lib/stage_read.ts";
import { DEFINITION_PATH, callIn, enterStage, makeWorkspace, overallDefinition, query } from "./helpers.ts";

function workspace(): string {
  const dir = makeWorkspace(overallDefinition());
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
const read = <T>(dir: string, run: (db: any, taskId: string) => T): T => withTaskDatabase(dir, { createIfMissing: false }, (db) =>
  run(db, (db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string }).task_id));

test("记一次移动：事件的内容里写所属流程；读记录时带出来；表里没有多一列，格式版本没有变", () => {
  const dir = workspace();
  enterStage(dir, "clarifying");
  enterStage(dir, "modeling");
  assert.deepEqual([FLOW_INITIAL, FLOW_NAMES[FLOW_INITIAL]], ["initial", "首次分析"]);
  const payloads = query<{ payload: string }>(dir, "SELECT payload FROM event WHERE name = 'STAGE_MOVED' ORDER BY seq").map((row) => JSON.parse(row.payload));
  assert.deepEqual(payloads.map((one) => [one.stage, one.from, one.flow]), [["clarifying", "reading", "initial"], ["modeling", "clarifying", "initial"]]);
  assert.deepEqual(read(dir, (db, id) => stageRecords(db, id)).map((one) => [one.stage, one.flow]), [["clarifying", "initial"], ["modeling", "initial"]]);
  assert.deepEqual(read(dir, (db, id) => [lastStageRecord(db, id)!.stage, lastStageRecord(db, id)!.flow]), ["modeling", "initial"]);
  assert.equal(query<{ name: string }>(dir, "SELECT name FROM pragma_table_info('stage_record')").some((column) => column.name === "flow"), false);
  assert.equal(query<{ user_version: number }>(dir, "PRAGMA user_version")[0].user_version, TASK_DB_VERSION);
  assert.equal(TASK_DB_VERSION, 3);
});

test("早先记下的移动事件里没有写所属流程：读出来补首次分析；事件里写了别的流程的照它写的读", () => {
  const dir = workspace();
  enterStage(dir, "clarifying");
  enterStage(dir, "modeling");
  withTaskDatabase(dir, { createIfMissing: false }, (db) => {
    const rows = db.prepare("SELECT seq, payload FROM event WHERE name = 'STAGE_MOVED' ORDER BY seq").all() as { seq: number; payload: string }[];
    const { flow: _gone, ...old } = JSON.parse(rows[0].payload);
    db.prepare("UPDATE event SET payload = ? WHERE seq = ?").run(JSON.stringify(old), rows[0].seq);
    db.prepare("UPDATE event SET payload = ? WHERE seq = ?").run(JSON.stringify({ ...JSON.parse(rows[1].payload), flow: "change" }), rows[1].seq);
  });
  assert.deepEqual(read(dir, (db, id) => stageRecords(db, id)).map((one) => [one.stage, one.flow]), [["clarifying", "initial"], ["modeling", "change"]]);
});
