/**
 * 活动记录的「所属流程」：写在活动记录表的一列与活动开始那条事件的内容里（现在恒为需求分析 analysis），读记录时带出来。
 * 早先记下的移动事件里没有写它的，升级时补成需求分析；早先的键 initial 读成 analysis（那一半在 stage_read.test.ts 里验）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { TASK_DB_VERSION, withTaskDatabase } from "../src/lib/schema.ts";
import { FLOW_ANALYSIS, FLOW_NAMES, flowKeyOf } from "../src/lib/stage.ts";
import { activityRecords, openActivityRecord } from "../src/lib/stage_read.ts";
import { DEFINITION_PATH, UI_SESSION, callIn, enterStage, makeWorkspace, overallDefinition, query } from "./helpers.ts";

function workspace(): string {
  const dir = makeWorkspace(overallDefinition());
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
const read = <T>(dir: string, run: (db: any, taskId: string) => T): T => withTaskDatabase(dir, { createIfMissing: false }, (db) =>
  run(db, (db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string }).task_id));

test("流程的工作项：启动与换站的事件、活动记录的一列都写所属流程；读记录时带出来", () => {
  const dir = workspace();
  enterStage(dir, "clarifying");
  enterStage(dir, "modeling");
  assert.deepEqual([FLOW_ANALYSIS, FLOW_NAMES[FLOW_ANALYSIS]], ["analysis", "需求分析"]);
  // 早先的键 initial 是同一条流程。
  assert.deepEqual([flowKeyOf("initial"), flowKeyOf("analysis"), flowKeyOf("change"), flowKeyOf(""), flowKeyOf(null)], ["analysis", "analysis", "change", null, null]);
  const payloads = query<{ name: string; payload: string }>(dir, "SELECT name, payload FROM event WHERE name IN ('ACTIVITY_STARTED', 'ACTIVITY_NODE_ENTERED') ORDER BY seq")
    .map((row) => [row.name, JSON.parse(row.payload)] as const);
  // 启动的一条从澄清开始，from 是 null；换站的一条写从哪一站到哪一站。两条都写所属流程。
  assert.deepEqual(payloads.map(([name, one]) => [name, one.activity ?? null, one.node, one.from, one.flow]),
    [["ACTIVITY_STARTED", "clarifying", "clarifying", null, "analysis"], ["ACTIVITY_NODE_ENTERED", null, "modeling", "clarifying", "analysis"]]);
  assert.deepEqual(read(dir, (db, id) => activityRecords(db, id)).map((one) => [one.activity, one.node, one.flow]), [["modeling", "modeling", "analysis"]]);
  assert.deepEqual(read(dir, (db, id) => [openActivityRecord(db, id, UI_SESSION)!.activity, openActivityRecord(db, id, UI_SESSION)!.flow]), ["modeling", "analysis"]);
  assert.equal(query<{ user_version: number }>(dir, "PRAGMA user_version")[0].user_version, TASK_DB_VERSION);
});

test("所属流程读的是活动记录的那一列：列里写了别的流程的照它写的读", () => {
  const dir = workspace();
  enterStage(dir, "clarifying");
  withTaskDatabase(dir, { createIfMissing: false }, (db) => {
    db.exec("UPDATE activity_record SET flow = 'change'");
  });
  assert.deepEqual(read(dir, (db, id) => activityRecords(db, id)).map((one) => [one.activity, one.flow]), [["clarifying", "change"]]);
});
