/**
 * 空闲在后端的几处：整份数据的 stage、任务状况的当前活动、库事件里从空闲开始一项活动的那一条。
 * 任务有过活动记录而每一条都已经结束就是空闲；产品里现在没有哪条路会这样，这里直接改夹具的库把记录记成已结束。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import * as library from "../src/library.ts";
import { taskStatus } from "../src/task_status.ts";
import { sqlRun, tempDir } from "./helpers.ts";
import { DEFINITION, build, page } from "./overall_stack.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const FLOW = page({ 标题: "预约取书", 标签: ["流程"], 例子: ["小王周六预约了一本书。"] });
const RETURN = page({ 标题: "还书", 标签: ["流程"] });
const USE_CASE = { op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["选书"] }, sources: [{ kind: "条目", locator: "OA-001", excerpt: "读者对在架的书办预约。" }] };
// 第二条用例依据的是用户还没有看过的一页：写条目这一段因此有灯不通过。
const USE_CASE_2 = { op: "add", collection: "用例", fields: { 名称: "归还图书", 步骤: ["还书"] }, sources: [{ kind: "条目", locator: "OA-002", excerpt: "读者对在架的书办预约。" }] };
/** 夹具一建好任务就由用户移到写条目；这里再写两页、两条用例。 */
const STEPS = [[FLOW, RETURN], { view: ["OA-001"] }, [USE_CASE, USE_CASE_2]];
const END_ALL = "UPDATE activity_record SET ended_at = started_at, ended_seq = started_seq WHERE ended_at IS NULL";

test("空闲的任务：整份数据里 stage.current 是 idle，谁移的、什么时候、为什么三项为 null，灯还是六个阶段的；与没有阶段的任务（null）不是一回事", () => {
  const ws = build(tmp, "idle", DEFINITION, STEPS);
  const before = library.taskSnapshot(ws)[1]!.stage!;
  assert.deepEqual([before.current, before.moved_by], ["writing", "user"]);
  assert.ok(before.lamps.writing.some((lamp) => lamp.ok === false));
  sqlRun(ws, [[END_ALL]]);
  const stage = library.taskSnapshot(ws)[1]!.stage!;
  assert.deepEqual([stage.current, stage.moved_by, stage.moved_at, stage.reason, stage.flow, stage.proposal], ["idle", null, null, null, "initial", null]);
  assert.deepEqual(stage.lamps, before.lamps, "灯照算，不因空闲而变");
  // 调试用的记录流水照旧列出那一次移动。
  assert.deepEqual(library.stageDebugView(ws).records.map((one) => [one.from, one.to]), [["reading", "writing"]]);
});

test("空闲的任务状况：当前活动的种类与写法是 idle，名字是「空闲」，第几阶段为 null；这一段还差什么是空的", () => {
  const ws = build(tmp, "idle-status", DEFINITION, STEPS);
  assert.ok(taskStatus(ws)!.missing.length > 0, "在写条目时有没通过的灯");
  sqlRun(ws, [[END_ALL]]);
  const status = taskStatus(ws)!;
  assert.deepEqual(status.activity, { kind: "idle", key: "idle", name: "空闲", ordinal: null, flow: "initial", moved_by: null, moved_at: null, reason: null });
  assert.deepEqual(status.missing, []);
  // 别的各项照任务记录算，不因空闲而变。
  assert.deepEqual([status.description.sections, status.items.map((one) => [one.collection, one.total]), status.proposal, status.versions],
    [2, [["用例", 2], ["待定事项", 0]], null, []]);
});

test("库事件：从空闲开始一项活动的那一条，from 是 null", () => {
  const ws = build(tmp, "idle-events", DEFINITION, [[FLOW]]);
  sqlRun(ws, [[END_ALL]]);
  const max = library.libraryEvents(ws, 0)[1];
  sqlRun(ws, [["INSERT INTO event (task_id, session_id, call_id, name, actor, payload, at) SELECT task_id, 'sess-ui', 'ui-op-idle', 'ACTIVITY_STARTED', 'user', ?, '2026-10-12T09:00:00' FROM task",
    JSON.stringify({ activity: "modeling", node: "modeling", flow: "initial", from: null, actor: "user", reason: "", run_id: null })]]);
  const [events] = library.libraryEvents(ws, max);
  assert.deepEqual(events.map(([name, d]) => [name, d.to, d.from, d.actor, d.node, d.op_id]), [["activity_started", "modeling", null, "user", "modeling", "ui-op-idle"]]);
});
