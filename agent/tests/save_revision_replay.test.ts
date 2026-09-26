/** 保存修订按调用编号判重：同一次调用重放只形成一次修订并交回第一次的结果；不同编号照常；旧库补建唯一索引。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { REPLAYED_TEXT, saveRevision } from "../src/lib/save_revision.ts";
import { REVISION_CALL_INDEX, REVISION_CALL_LOOKUP_INDEX, withTaskDatabase } from "../src/lib/schema.ts";
import { completeTask } from "../src/lib/complete_task.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, makeWorkspace, query } from "./helpers.ts";

function workspaceWithTask(): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}

const addUseCase = (name = "登录") => ({
  operations: [{ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["打开页面"] }, sources: [SOURCE] }],
});

const call = (dir: string, callId: string) => ({ workspaceDir: dir, sessionId: "session-test", callId });

const indexes = (dir: string) =>
  query<{ name: string }>(dir, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'revision' AND sql IS NOT NULL")
    .map((r) => r.name);

test("同一调用编号第二次到来：不再写入，交回第一次的结果文字并注明已经保存过", () => {
  const dir = workspaceWithTask();
  const first = saveRevision(call(dir, "call-same"), addUseCase());
  const again = saveRevision(call(dir, "call-same"), addUseCase());
  assert.equal(count(dir, "revision"), 1);
  assert.equal(count(dir, "item"), 1);
  assert.equal(count(dir, "event"), 2);          // 创建任务一条、保存修订一条
  assert.equal(again.text, `${first.text}\n${REPLAYED_TEXT}`);
  assert.equal(again.details.revision_no, 1);
  assert.equal(again.details.event_seq, first.details.event_seq);
  assert.deepEqual(again.details.operations, first.details.operations);
  assert.equal(again.details.replayed, true);
  assert.equal(first.details.replayed, undefined);
});

test("重放时参数不同也不重写：判重只看调用编号", () => {
  const dir = workspaceWithTask();
  saveRevision(call(dir, "call-x"), addUseCase("登录"));
  const again = saveRevision(call(dir, "call-x"), addUseCase("注销"));
  assert.match(again.text, /新增了条目 UC-001/);
  assert.equal(query<any>(dir, "SELECT fields FROM item_version")[0].fields.includes("登录"), true);
  assert.equal(count(dir, "item_version"), 1);
});

test("任务结束之后重放结束之前的调用，仍交回第一次的结果，而不是拒绝", () => {
  const dir = makeWorkspace(undefined);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(call(dir, "call-before-end"), addUseCase());
  withTaskDatabase(dir, { createIfMissing: false }, (db) => db.exec("UPDATE task SET status = '已完成'"));
  const again = saveRevision(call(dir, "call-before-end"), addUseCase());
  assert.match(again.text, new RegExp(`${REPLAYED_TEXT}$`));
  assert.throws(() => completeTask(call(dir, "call-done")), /不能再完成一次/);
});

test("不同调用编号照常各形成一次修订", () => {
  const dir = workspaceWithTask();
  saveRevision(call(dir, "call-a"), addUseCase("登录"));
  const second = saveRevision(call(dir, "call-b"), addUseCase("注销"));
  assert.equal(second.details.revision_no, 2);
  assert.equal(count(dir, "revision"), 2);
});

test("调用编号为空文字（模型服务没给编号）时无从判重，照常各写一次", () => {
  const dir = workspaceWithTask();
  saveRevision(call(dir, ""), addUseCase("登录"));
  const second = saveRevision(call(dir, ""), addUseCase("注销"));
  assert.equal(second.details.revision_no, 2);
  assert.equal(second.details.replayed, undefined);
});

test("用户在界面上的操作不按操作编号交回旧结果", () => {
  const dir = workspaceWithTask();
  saveRevision(call(dir, "call-a"), addUseCase());
  const user = { ...call(dir, "ui-op-1"), actor: "user" as const };
  saveRevision(user, { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "改名" } }] });
  // 同一个操作编号再来一次（后端不会这样做）：唯一索引拒绝写入，不会悄悄形成第二次修订。
  assert.throws(() => saveRevision(user, { operations: [{ op: "update", item: "UC-001", base_revision: 2, fields: { 名称: "再改" } }] }),
    /UNIQUE constraint failed/);
  assert.equal(count(dir, "revision"), 2);
});

test("库上有按任务与调用编号的唯一索引：同一编号的第二行写不进去", () => {
  const dir = workspaceWithTask();
  saveRevision(call(dir, "call-u"), addUseCase());
  assert.ok(indexes(dir).includes(REVISION_CALL_INDEX));
  assert.throws(() => withTaskDatabase(dir, { createIfMissing: false }, (db) =>
    db.exec("INSERT INTO revision (task_id, revision_no, session_id, call_id, event_seq, created_at, summary) " +
      "VALUES ('TASK-001', 9, 's', 'call-u', 2, 'x', '[]')")), /UNIQUE constraint failed/);
});

test("旧库没有这个索引：第一次被写入一侧打开时补上，此后重放不再重写", () => {
  const dir = workspaceWithTask();
  saveRevision(call(dir, "call-old"), addUseCase());
  withTaskDatabase(dir, { createIfMissing: false }, (db) => db.exec(`DROP INDEX ${REVISION_CALL_INDEX}`));
  assert.ok(!indexes(dir).includes(REVISION_CALL_INDEX));
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  assert.ok(indexes(dir).includes(REVISION_CALL_INDEX));
  saveRevision(call(dir, "call-old"), addUseCase());
  assert.equal(count(dir, "revision"), 1);
});

test("旧库里已经有同一调用编号的两次修订：唯一索引建不成，改建普通索引，原有的行不动，判重照样生效", () => {
  const dir = workspaceWithTask();
  saveRevision(call(dir, "call-dup"), addUseCase("登录"));
  saveRevision(call(dir, "call-dup-2"), addUseCase("注销"));
  // 造一个补索引之前重放过的旧库：去掉索引，库里留下同一编号的两次修订。
  withTaskDatabase(dir, { createIfMissing: false }, (db) => {
    db.exec(`DROP INDEX ${REVISION_CALL_INDEX}`);
    db.exec("UPDATE revision SET call_id = 'call-dup' WHERE revision_no = 2");
  });
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  const after = indexes(dir);
  assert.ok(after.includes(REVISION_CALL_LOOKUP_INDEX));
  assert.ok(!after.includes(REVISION_CALL_INDEX));
  assert.equal(count(dir, "revision"), 2);
  const again = saveRevision(call(dir, "call-dup"), addUseCase("第三"));
  assert.equal(again.details.revision_no, 1);
  assert.equal(count(dir, "revision"), 2);
});
