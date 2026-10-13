/**
 * 活动记录的「所属流程」：写在活动记录表的一列与阶段移动那条事件的内容里（现在恒为首次分析 initial），读记录时带出来。
 * 早先记下的移动事件里没有写它的，升级时补成首次分析（那一半在 stage_read.test.ts 里验）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { TASK_DB_VERSION, withTaskDatabase } from "../src/lib/schema.ts";
import { FLOW_INITIAL, FLOW_NAMES } from "../src/lib/stage.ts";
import { activityRecords, openActivityRecord } from "../src/lib/stage_read.ts";
import { DEFINITION_PATH, callIn, enterStage, makeWorkspace, overallDefinition, query } from "./helpers.ts";

function workspace(): string {
  const dir = makeWorkspace(overallDefinition());
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
const read = <T>(dir: string, run: (db: any, taskId: string) => T): T => withTaskDatabase(dir, { createIfMissing: false }, (db) =>
  run(db, (db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string }).task_id));

test("记一次移动：事件的内容里与活动记录的一列都写所属流程；读记录时带出来", () => {
  const dir = workspace();
  enterStage(dir, "clarifying");
  enterStage(dir, "modeling");
  assert.deepEqual([FLOW_INITIAL, FLOW_NAMES[FLOW_INITIAL]], ["initial", "首次分析"]);
  const payloads = query<{ payload: string }>(dir, "SELECT payload FROM event WHERE name = 'STAGE_MOVED' ORDER BY seq").map((row) => JSON.parse(row.payload));
  assert.deepEqual(payloads.map((one) => [one.stage, one.from, one.flow]), [["clarifying", "reading", "initial"], ["modeling", "clarifying", "initial"]]);
  assert.deepEqual(read(dir, (db, id) => activityRecords(db, id)).map((one) => [one.activity, one.node, one.flow]), [["clarifying", "clarifying", "initial"], ["modeling", "modeling", "initial"]]);
  assert.deepEqual(read(dir, (db, id) => [openActivityRecord(db, id)!.activity, openActivityRecord(db, id)!.flow]), ["modeling", "initial"]);
  assert.deepEqual(query<{ flow: string }>(dir, "SELECT flow FROM activity_record ORDER BY started_seq").map((row) => row.flow), ["initial", "initial"]);
  assert.equal(query<{ user_version: number }>(dir, "PRAGMA user_version")[0].user_version, TASK_DB_VERSION);
});

test("所属流程读的是活动记录的那一列：列里写了别的流程的照它写的读", () => {
  const dir = workspace();
  enterStage(dir, "clarifying");
  enterStage(dir, "modeling");
  withTaskDatabase(dir, { createIfMissing: false }, (db) => {
    db.exec("UPDATE activity_record SET flow = 'change' WHERE activity = 'modeling'");
  });
  assert.deepEqual(read(dir, (db, id) => activityRecords(db, id)).map((one) => [one.activity, one.flow]), [["clarifying", "initial"], ["modeling", "change"]]);
});
