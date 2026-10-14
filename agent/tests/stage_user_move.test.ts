/**
 * 用户在界面上移动工作阶段（直接操作 move_stage，lib/user_ops.ts）：这条会话的工作项是流程的工作项时，想移到哪一站都可以；
 * 记一条换站的事件，往会话里追加一句说明；不产生修订、不能撤销。会话不在做流程的工作项、早先建的任务没有阶段，拒绝。
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { STAGES, STAGE_NAMES } from "../src/lib/stage.ts";
import { UserOpError, runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, callIn, count, demoDefinition, makeWorkspace, moveRows, nodeMoves, overallDefinition, query } from "./helpers.ts";

function workspace(definition: unknown = overallDefinition(), material = true): string {
  const dir = makeWorkspace(definition, { material });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
let n = 0;
const move = (dir: string, fields: unknown, extra: Record<string, unknown> = {}) =>
  runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-${++n}`, kind: "move_stage", fields, ...extra });
function refused(fn: () => unknown): UserOpError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof UserOpError, String(error));
    return error;
  }
  assert.fail("应当被拒绝");
}

/** 在界面操作的那条会话上启动一个首次分析的工作项，从某一站开始。移动阶段只在流程的工作项里做。 */
const launch = (dir: string, stage: string) =>
  runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-${++n}`, kind: "start_activity", fields: { activity: stage, in_flow: true } });

test("流程的工作项想移到哪一站都可以：直接到评审确认，再退回澄清；每次记一条换站的事件、追加一句说明，工作项还是那一行", () => {
  const dir = workspace();
  launch(dir, "写条目");
  const first = move(dir, { stage: "评审确认", reason: " 条目我都看过了。 " });
  assert.deepEqual([first.kind, first.results, first.revision_no, first.undoable, first.notify_text, first.event_seqs.length], ["move_stage", [], null, false, null, 1]);
  assert.equal(first.note, "界面操作（不是用户打的字）：用户把工作项从写条目移到评审确认。理由：条目我都看过了。");
  assert.equal(move(dir, { stage: "clarifying" }).note, "界面操作（不是用户打的字）：用户把工作项从评审确认移到澄清。");
  assert.deepEqual(nodeMoves(dir).map(({ event_seq: _seq, record_id: _id, ...r }) => r), [
    { node: "reviewing", from: "writing", direction: "forward", actor: "user", reason: "条目我都看过了。", session_id: "sess-ui" },
    { node: "clarifying", from: "reviewing", direction: "back", actor: "user", reason: "", session_id: "sess-ui" },
  ]);
  assert.deepEqual(moveRows(dir).map((r) => [r.stage, r.actor, r.session_id]), [["clarifying", "user", "sess-ui"]]);
  assert.equal(count(dir, "revision"), 0, "移动阶段不产生修订");
  assert.deepEqual(query<{ name: string }>(dir, "SELECT name FROM event WHERE name LIKE 'ACTIVITY_%' ORDER BY seq").map((e) => e.name),
    ["ACTIVITY_STARTED", "ACTIVITY_NODE_ENTERED", "ACTIVITY_NODE_ENTERED"]);
});

test("工作项本来就在那一站：不记、不追加说明，也不算出错；六个阶段都能去", () => {
  const dir = workspace(overallDefinition(), false);
  launch(dir, "澄清");
  const same = move(dir, { stage: "澄清" });
  assert.deepEqual([same.note, same.event_seqs], ["", []]);
  // 另外五个阶段各移一遍，每一步都从上一步所在的阶段出发。
  const order = ["reading", "modeling", "writing", "reviewing", "document"] as const;
  let from = "澄清";
  for (const to of order) {
    assert.equal(move(dir, { stage: STAGE_NAMES[to] }).note, `界面操作（不是用户打的字）：用户把工作项从${from}移到${STAGE_NAMES[to]}。`);
    from = STAGE_NAMES[to];
  }
  assert.equal(count(dir, "activity_record"), 1, "换站不另开一行");
  assert.equal(nodeMoves(dir).length, STAGES.length - 1);
});

test("这条会话不在做流程的工作项：移动阶段被拒，原话请用户从任务起点页启动一个工作项，什么都不记", () => {
  const dir = workspace();
  const free = refused(() => move(dir, { stage: "写条目" }));
  assert.deepEqual([free.code, free.message], ["rejected", "本会话不在做工作流程的工作项，不能移动阶段。要做哪一项活动，请从任务起点页启动一个工作项。"]);
  assert.deepEqual([count(dir, "activity_record"), count(dir, "event")], [0, count(dir, "event")]);
  assert.equal(count(dir, "activity_record"), 0);
});

test("拒绝：没有写阶段或名字不对；任务编号对不上；任务已经完成；早先建的任务没有阶段", () => {
  const dir = workspace();
  for (const fields of [undefined, {}, { stage: "发布" }, { stage: 3 }]) {
    const error = refused(() => move(dir, fields));
    assert.equal(error.code, "bad_request");
    assert.equal(error.message, "move_stage 要在 fields 里写 stage：「核读材料」「澄清」「整理建模」「写条目」「评审确认」「编写文档」之一；可以另写一句 reason。");
  }
  assert.equal(refused(() => move(dir, { stage: "澄清" }, { task_id: "TASK-别的" })).code, "bad_request");
  assert.equal(count(dir, "activity_record"), 0);

  const old = workspace(demoDefinition());
  const none = refused(() => move(old, { stage: "澄清" }));
  assert.deepEqual([none.code, none.message, none.data], ["rejected", "这个任务没有阶段。", { reasons: ["这个任务没有阶段"] }]);
  assert.equal(count(old, "activity_record"), 0);

  // 已完成的任务：演示任务定义的完成条件在一个条目都没有时不满足，所以直接把状态改掉来试。
  const done = workspace();
  const db = new DatabaseSync(databasePath(done));
  db.exec("UPDATE task SET status = '已完成'");
  db.close();
  const closed = refused(() => move(done, { stage: "澄清" }));
  assert.deepEqual([closed.code, closed.message], ["task_closed", "任务已经已完成，不能再移动阶段。"]);
});
