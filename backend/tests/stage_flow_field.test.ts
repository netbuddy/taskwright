/**
 * 所属流程在后端的三处：整份数据的 stage.flow、库事件 activity_started 的 flow、调试用的阶段记录流水里每条的 flow。
 * 现在只有一条流程，值恒为 initial（首次分析）；早先记下的移动事件里没有写它，推出去时补上。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import * as library from "../src/library.ts";
import { sqlRun, tempDir } from "./helpers.ts";
import { DEFINITION, build, page } from "./overall_stack.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const FLOW = page({ 标题: "预约取书", 标签: ["流程"], 例子: ["小王周六预约了一本书。"] });

test("整份数据、库事件与启动换站的流水都带所属流程：流程的工作项是流程的键，单项活动的是 null；早先没有写它的移动事件补首次分析", () => {
  // 夹具在会话 s 上启动首次分析、从写条目开始，再把工作项移到评审确认。
  const ws = build(tmp, "flow", DEFINITION, [[FLOW], { stage: "评审确认" }]);
  assert.equal(library.taskSnapshot(ws, null, "s")[1]!.stage!.flow, "initial");
  const flows = () => library.libraryEvents(ws, 0, "s")[0].filter(([name]) => name === "activity_started" || name === "node_entered").map(([name, data]) => [name, data.to ?? data.node, data.flow]);
  assert.deepEqual(flows(), [["activity_started", "writing", "initial"], ["node_entered", "reviewing", "initial"]]);
  assert.deepEqual(library.stageDebugView(ws).records.map((one) => [one.to, one.flow, one.kind]), [["writing", "initial", "launch"], ["reviewing", "initial", "move"]]);
  // 早先的移动事件里没有写所属流程，也没有工作项的记录号：推出去的事件与流水都补首次分析。
  sqlRun(ws, [["INSERT INTO event (task_id, session_id, call_id, name, actor, payload, at) SELECT task_id, 'sess-old', 'ui-op-old', 'STAGE_MOVED', 'user', ?, '2026-10-10T09:00:00' FROM task",
    JSON.stringify({ stage: "modeling", from: "reviewing", actor: "user", reason: "", run_id: null })]]);
  assert.deepEqual(flows().at(-1), ["activity_started", "modeling", "initial"]);
  assert.deepEqual(library.stageDebugView(ws).records.map((one) => [one.to, one.flow, one.kind]).at(-1), ["modeling", "initial", "move"]);
  // 启动一项单项活动的那一条：不在流程里，所属流程是 null。
  sqlRun(ws, [["INSERT INTO event (task_id, session_id, call_id, name, actor, payload, at) SELECT task_id, 's2', 'ui-op-alone', 'ACTIVITY_STARTED', 'user', ?, '2026-10-12T09:00:00' FROM task",
    JSON.stringify({ record_id: 2, activity: "clarifying", node: null, flow: null, from: null, actor: "user", reason: "", run_id: null })]]);
  assert.deepEqual(flows().at(-1), ["activity_started", "clarifying", null]);
  assert.deepEqual(library.stageDebugView(ws).records.map((one) => [one.to, one.flow, one.kind, one.record_id]).at(-1), ["clarifying", null, "launch", 2]);
  // 整份数据里的所属流程读的是这条会话的工作项的那一列。
  sqlRun(ws, [["UPDATE activity_record SET flow = 'change'"]]);
  assert.equal(library.taskSnapshot(ws, null, "s")[1]!.stage!.flow, "change");
});
