/** 创建任务：通过、库里已有任务时被拒（一库一任务）、任务名与领域标签、任务定义不对时被拒且不留库文件。 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { ACTOR_USER, databasePath } from "../src/lib/db.ts";
import { DEFINITION_PATH, callIn, count, demoDefinition, makeWorkspace, query } from "./helpers.ts";

test("创建任务通过：写一行任务、记一条事件，返回文字写明交付物结构", () => {
  const dir = makeWorkspace();
  const call = callIn(dir, "session-A");
  const outcome = createTask(call, { definition_path: DEFINITION_PATH });
  const [task] = query<any>(dir, "SELECT * FROM task");
  assert.equal(task.task_id, "TASK-001");
  assert.equal(task.status, "进行中");
  assert.equal(task.definition_path, DEFINITION_PATH);
  assert.match(task.definition_text, /演示任务/);
  assert.equal(task.session_id, "session-A");
  assert.equal(task.call_id, call.callId);
  const [event] = query<any>(dir, "SELECT * FROM event");
  assert.equal(event.seq, task.event_seq);
  assert.equal(event.name, "TASK_CREATED");
  assert.equal(event.call_id, call.callId);
  assert.equal(event.session_id, "session-A");
  assert.match(outcome.text, /TASK-001/);
  assert.match(outcome.text, /集合「用例」，条目编号的前缀是 UC/);
  assert.match(outcome.text, /「步骤」：类型是文本列表.*必填/);
  assert.match(outcome.text, /取值只能是「未解决」、「已解决」之一/);
  assert.match(outcome.text, /kind 是种类/);
  assert.match(outcome.text, /「关联条目」：类型是条目引用，写成条目编号的数组/);
});

test("一库一任务：库里已有任务时拒绝（不论状态），给出它的任务编号、任务名与状态，库里不多任何行", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  assert.throws(
    () => createTask(callIn(dir), { definition_path: DEFINITION_PATH }),
    /这个任务目录的库里已经有任务了：任务编号是 TASK-001，任务名是「演示任务」，状态是进行中。一个库只放一个任务/,
  );
  assert.equal(count(dir, "task"), 1);
  assert.equal(count(dir, "event"), 1);
  // 任务已经结束也一样拒绝。
  const db = new DatabaseSync(databasePath(dir));
  db.exec("UPDATE task SET status = '已完成'");
  db.close();
  assert.throws(() => createTask(callIn(dir), { definition_path: DEFINITION_PATH }), /状态是已完成。一个库只放一个任务/);
  assert.equal(count(dir, "task"), 1);
});

test("任务名与领域标签：用户给了就存用户给的；标签没给就取任务定义里的；都没有为空", () => {
  const dir = makeWorkspace({ ...demoDefinition(), 领域标签: "售后" });
  const outcome = createTask(
    { ...callIn(dir), sessionId: "", callId: "ui-op-1", actor: ACTOR_USER },
    { definition_path: DEFINITION_PATH, task_name: "退款模块规格说明" },
  );
  const [task] = query<any>(dir, "SELECT task_name, domain_tag, session_id, call_id FROM task");
  assert.deepEqual({ ...task }, { task_name: "退款模块规格说明", domain_tag: "售后", session_id: "", call_id: "ui-op-1" });
  assert.equal(outcome.details.task_name, "退款模块规格说明");
  assert.equal(outcome.details.task_type, "演示任务");
  const [event] = query<any>(dir, "SELECT actor, call_id FROM event");
  assert.deepEqual({ ...event }, { actor: "user", call_id: "ui-op-1" });
  const other = makeWorkspace();
  createTask(callIn(other), { definition_path: DEFINITION_PATH, domain_tag: "  " });
  assert.deepEqual({ ...query<any>(other, "SELECT task_name, domain_tag FROM task")[0] }, { task_name: null, domain_tag: null });
});

test("任务定义不对时拒绝，逐条说明原因；库是这次新建的，就不留下库文件", () => {
  const dir = makeWorkspace({ 任务名: "缺很多东西" });
  assert.throws(() => createTask(callIn(dir), { definition_path: DEFINITION_PATH }), /形状不对，一共 \d+ 处/);
  assert.equal(existsSync(databasePath(dir)), false);
});

test("任务定义文件不存在时拒绝", () => {
  const dir = makeWorkspace();
  assert.throws(() => createTask(callIn(dir), { definition_path: "docs/task-definitions/没有.json" }), /读不到这个文件/);
});

test("库在调用之前就已存在时，被拒的创建任务绝不删掉这个库", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  assert.throws(() => createTask(callIn(dir), { definition_path: "docs/task-definitions/没有.json" }), /读不到这个文件/);
  assert.equal(existsSync(databasePath(dir)), true);
  assert.equal(count(dir, "task"), 1);
  assert.equal(count(dir, "event"), 1);
});
