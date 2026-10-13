/**
 * 用户在界面上移动工作阶段（直接操作 move_stage，lib/user_ops.ts）：想移到哪个阶段都可以；记一条阶段记录，
 * 往会话里追加一句说明；不产生修订、不能撤销。早先建的任务没有阶段，拒绝。
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { STAGES, STAGE_NAMES } from "../src/lib/stage.ts";
import { UserOpError, runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, callIn, count, demoDefinition, makeWorkspace, moveRows, overallDefinition, query } from "./helpers.ts";

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

test("用户想移到哪个阶段都可以：新任务空闲，第一次移动是启动首次分析；之后直接到评审确认，再退回澄清；每次记一条、追加一句说明", () => {
  const dir = workspace();
  const first = move(dir, { stage: "写条目" });
  assert.deepEqual([first.kind, first.results, first.revision_no, first.undoable, first.notify_text, first.event_seqs.length], ["move_stage", [], null, false, null, 1]);
  assert.equal(first.note, "界面操作（不是用户打的字）：用户启动首次分析，从写条目开始。");
  assert.equal(move(dir, { stage: "评审确认", reason: " 条目我都看过了。 " }).note, "界面操作（不是用户打的字）：用户把任务从写条目移到评审确认。理由：条目我都看过了。");
  assert.equal(move(dir, { stage: "clarifying" }).note, "界面操作（不是用户打的字）：用户把任务从评审确认移到澄清。");
  assert.deepEqual(moveRows(dir).map(({ event_seq: _seq, ...r }) => r), [
    { stage: "writing", from_stage: null, actor: "user", reason: "", run_id: null, call_id: `ui-op-${n - 2}`, session_id: "sess-ui" },
    { stage: "reviewing", from_stage: "writing", actor: "user", reason: "条目我都看过了。", run_id: null, call_id: `ui-op-${n - 1}`, session_id: "sess-ui" },
    { stage: "clarifying", from_stage: "reviewing", actor: "user", reason: "", run_id: null, call_id: `ui-op-${n}`, session_id: "sess-ui" },
  ]);
  assert.equal(count(dir, "revision"), 0, "移动阶段不产生修订");
  assert.deepEqual(query<{ actor: string; name: string }>(dir, "SELECT DISTINCT actor, name FROM event WHERE name IN ('ACTIVITY_STARTED', 'ACTIVITY_ENDED') ORDER BY name").map((e) => [e.name, e.actor]), [["ACTIVITY_ENDED", "user"], ["ACTIVITY_STARTED", "user"]]);
});

test("任务本来就在那个阶段：不记、不追加说明，也不算出错", () => {
  const dir = workspace(overallDefinition(), false);
  assert.equal(move(dir, { stage: "澄清" }).note, "界面操作（不是用户打的字）：用户启动首次分析，从澄清开始。");
  const same = move(dir, { stage: "澄清" });
  assert.deepEqual([same.note, same.event_seqs], ["", []]);
  assert.equal(count(dir, "activity_record"), 1);
  // 另外五个阶段各移一遍，每一步都从上一步所在的阶段出发。
  const order = ["reading", "modeling", "writing", "reviewing", "document"] as const;
  let from = "澄清";
  for (const to of order) {
    assert.equal(move(dir, { stage: STAGE_NAMES[to] }).note, `界面操作（不是用户打的字）：用户把任务从${from}移到${STAGE_NAMES[to]}。`);
    from = STAGE_NAMES[to];
  }
  assert.equal(count(dir, "activity_record"), STAGES.length);
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
