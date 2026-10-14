/**
 * 空闲在后端的几处：整份数据的 stage、任务状况的当前活动、库事件里从空闲开始一项活动的那一条。
 * 会话不属于任何工作项就是空闲：自由讨论的会话，或者工作项被删除之后归档的会话。这里直接改夹具的库，把工作项删掉、它的会话归档
 * （与删除工作项的直接操作改的是同样两处）。
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
/** 夹具一建好任务就由用户在会话 s 上启动需求分析、从写条目开始；这里再写两页、两条用例。 */
const STEPS = [[FLOW, RETURN], { view: ["OA-001"] }, [USE_CASE, USE_CASE_2]];
/** 把工作项都删掉、它们的会话都归档：这些会话此后空闲。 */
const DELETE_ALL = ["UPDATE work_item_session SET record_id = NULL, archived_at = '2026-10-13T20:00:00'", "DELETE FROM activity_record"];

test("空闲的会话：整份数据里 stage.current 是 idle，谁、什么时候、为什么三项为 null，灯还是六个阶段的；归档的会话与自由讨论的会话都是；与没有阶段的任务（null）不是一回事", () => {
  const ws = build(tmp, "idle", DEFINITION, STEPS);
  const before = library.taskSnapshot(ws, null, "s")[1]!.stage!;
  assert.deepEqual([before.current, before.moved_by], ["writing", "user"]);
  assert.ok(before.lamps.writing.some((lamp) => lamp.ok === false));
  // 同一时刻别的会话不属于那个工作项：自由讨论的会话，空闲，灯照算。
  const free = library.taskSnapshot(ws, null, "sess-free")[1]!.stage!;
  assert.deepEqual([free.current, free.work_item, free.moved_by, free.moved_at, free.reason, free.flow, free.proposal], ["idle", null, null, null, null, null, null]);
  assert.deepEqual(free.lamps, before.lamps, "灯照算，不因空闲而变");
  sqlRun(ws, DELETE_ALL.map((one) => [one]));
  // 工作项删除之后，原来属于它的那条会话归档、空闲，整份数据里没有工作项。
  const stage = library.taskSnapshot(ws, null, "s")[1]!.stage!;
  assert.deepEqual([stage.current, stage.moved_by, stage.moved_at, stage.reason, stage.flow, stage.proposal, stage.work_item],
    ["idle", null, null, null, null, null, null]);
  assert.deepEqual(stage.lamps, before.lamps, "灯照算，不因空闲而变");
  // 调试用的记录流水照旧列出那一次启动。
  assert.deepEqual(library.stageDebugView(ws).records.map((one) => [one.from, one.to, one.kind]), [[null, "writing", "launch"]]);
});

test("空闲的会话的任务状况：当前活动的种类与写法是 idle，名字是「空闲」，第几站为 null；这一段还差什么是空的", () => {
  const ws = build(tmp, "idle-status", DEFINITION, STEPS);
  assert.ok(taskStatus(ws, "s")!.missing.length > 0, "在写条目时有没通过的灯");
  sqlRun(ws, DELETE_ALL.map((one) => [one]));
  const status = taskStatus(ws, "s")!;
  assert.deepEqual(status.activity, { kind: "idle", key: "idle", name: "空闲", ordinal: null, flow: null, moved_by: null, moved_at: null, reason: null });
  assert.deepEqual([status.work_items, "recent_done" in status], [[], false]);
  assert.deepEqual(status.missing, []);
  // 别的各项照任务记录算，不因空闲而变。
  assert.deepEqual([status.description.sections, status.items.map((one) => [one.collection, one.total]), status.proposal, status.versions],
    [2, [["用例", 2], ["待定事项", 0]], null, []]);
});

test("库事件：早先（会话与工作项绑定之前）从空闲开始一项活动的那一条，from 是 null，没有工作项的记录号", () => {
  const ws = build(tmp, "idle-events", DEFINITION, [[FLOW]]);
  sqlRun(ws, DELETE_ALL.map((one) => [one]));
  const max = library.libraryEvents(ws, 0)[1];
  sqlRun(ws, [["INSERT INTO event (task_id, session_id, call_id, name, actor, payload, at) SELECT task_id, 'sess-ui', 'ui-op-idle', 'ACTIVITY_STARTED', 'user', ?, '2026-10-12T09:00:00' FROM task",
    JSON.stringify({ activity: "modeling", node: "modeling", flow: "initial", from: null, actor: "user", reason: "", run_id: null })]]);
  const [events] = library.libraryEvents(ws, max);
  assert.deepEqual(events.map(([name, d]) => [name, d.record_id, d.to, d.from, d.actor, d.node, d.flow, d.op_id]), [["activity_started", null, "modeling", null, "user", "modeling", "analysis", "ui-op-idle"]]);
});
