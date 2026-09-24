/** 用户在界面上的直接操作：每种操作与每种拒绝。直接测 lib/user_ops.ts，不经 pi。 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { checkCompletion } from "../src/lib/conditions.ts";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { UserOpError, runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, demoDefinition, makeWorkspace, query } from "./helpers.ts";

/** 演示任务定义，待定事项的状态多一个「用户决定保留」，好测「标为先不管」。 */
function definitionWithKeep() {
  const raw = demoDefinition() as any;
  raw.交付物.条目集合[1].字段[1].取值 = ["未解决", "已解决", "用户决定保留"];
  return raw;
}

function taskWithItems(definition: unknown = definitionWithKeep()) {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), {
    operations: [
      { op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面", "输入口令"] }, sources: [{ ...SOURCE, supports: [{ field: "步骤", index: 1 }] }] },
      { op: "add", collection: "用例", fields: { 名称: "注销", 步骤: ["点注销"] }, sources: [SOURCE] },
      { op: "add", collection: "待定事项", fields: { 事项: "口令长度？", 状态: "未解决" }, sources: [SOURCE] },
    ],
  });
  return dir;
}
const ctx = (dir: string) => ({ workspaceDir: dir, sessionId: "sess-ui" });
let n = 0;
const op = (dir: string, body: Record<string, unknown>) => runUserOperation(ctx(dir), { op_id: `ui-op-${++n}`, ...body });
function refused(fn: () => unknown): UserOpError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof UserOpError, String(error));
    return error;
  }
  assert.fail("应当被拒绝");
}

test("edit_fields：发起方 user、编号是操作编号，字段整体换成新值，追加用的正文用固定句式", () => {
  const dir = taskWithItems();
  const result = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_version: 1 }], fields: { 步骤: ["打开页面", "输入口令", "点登录"] } });
  assert.deepEqual(result.results, [{ item_id: "UC-001", version_no: 2 }]);
  assert.equal(result.note, "界面操作（不是用户打的字）：用户把 UC-001 的「步骤」改成了第 2 版。改后的内容是：\n「步骤」：\n  1. 打开页面\n  2. 输入口令\n  3. 点登录");
  assert.equal(result.undoable, true);
  const event = query<any>(dir, "SELECT actor, call_id, name FROM event WHERE seq = ?", result.event_seqs[0])[0];
  assert.deepEqual({ ...event }, { actor: "user", call_id: result.op_id, name: "REVISION_SAVED" });
  assert.deepEqual(JSON.parse(query<any>(dir, "SELECT fields FROM item_version WHERE item_id='UC-001' AND version_no=2")[0].fields).步骤, ["打开页面", "输入口令", "点登录"]);
});

test("delete_item 与 keep_pending：可以一次多个条目", () => {
  const dir = taskWithItems();
  const del = op(dir, { kind: "delete_item", targets: [{ item_id: "UC-001", base_version: 1 }, { item_id: "UC-002", base_version: 1 }] });
  assert.match(del.note, /用户删除了 UC-001（删除前是第 1 版）、UC-002（删除前是第 1 版）/);
  assert.equal(count(dir, "revision"), 2);
  const keep = op(dir, { kind: "keep_pending", targets: [{ item_id: "TBD-001", base_version: 1 }] });
  assert.match(keep.note, /TBD-001 标为先不管（状态改为「用户决定保留」），现在是TBD-001 第 2 版/);
  assert.equal(JSON.parse(query<any>(dir, "SELECT fields FROM item_version WHERE item_id='TBD-001' AND version_no=2")[0].fields).状态, "用户决定保留");
});

test("keep_pending 用在没有这种状态的集合上被拒；状态取值里没有「用户决定保留」时也被拒", () => {
  const dir = taskWithItems();
  assert.equal(refused(() => op(dir, { kind: "keep_pending", targets: [{ item_id: "UC-001", base_version: 1 }] })).code, "rejected");
  // 原样的演示任务定义里待定事项的状态只有「未解决」「已解决」两种。
  const plain = taskWithItems(demoDefinition());
  assert.equal(refused(() => op(plain, { kind: "keep_pending", targets: [{ item_id: "TBD-001", base_version: 1 }] })).code, "rejected");
});

test("confirm 与 unconfirm：写判读与明细（依据界面点击），记 CONFIRMATION_RECORDED；撤回之后不再算确认", () => {
  const dir = taskWithItems();
  const result = op(dir, { kind: "confirm", targets: [{ item_id: "UC-001", base_version: 1 }, { item_id: "UC-002", base_version: 1 }], notify_executor: true });
  assert.equal(result.notify_text, "我已经在界面上确认了：UC-001 第 1 版，UC-002 第 1 版。请接着往下做。");
  assert.equal(result.undoable, false);
  const event = query<any>(dir, "SELECT name, actor, call_id, payload FROM event WHERE seq = ?", result.event_seqs[0])[0];
  assert.equal(event.name, "CONFIRMATION_RECORDED");
  assert.deepEqual(JSON.parse(event.payload), { items: [{ item_id: "UC-001", version_no: 1, accepted: true }, { item_id: "UC-002", version_no: 1, accepted: true }], basis: "ui_click" });
  assert.equal(count(dir, "judgement_item"), 2);
  const db = new DatabaseSync(databasePath(dir), { readOnly: true });
  const confirmed = () => checkCompletion(db, "TASK-001", { 用例: ["每个条目用户确认"] })[0].satisfied;
  assert.equal(confirmed(), true);
  const back = op(dir, { kind: "unconfirm", targets: [{ item_id: "UC-002", base_version: 1 }] });
  assert.equal(back.note, "界面操作（不是用户打的字）：用户在界面上撤回了对 UC-002 第 1 版的确认。");
  assert.equal(confirmed(), false);
  db.close();
  const noNotify = op(dir, { kind: "confirm", targets: [{ item_id: "UC-002", base_version: 1 }] });
  assert.equal(noNotify.notify_text, null);
});

test("版本过期整批拒绝 stale_version，逐条写明现在第几版、是谁改的；过期的那批一行都不写", () => {
  const dir = taskWithItems();
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-002", base_version: 1, fields: { 名称: "退出登录" } }] });
  const before = count(dir, "event");
  const error = refused(() => op(dir, { kind: "confirm", targets: [{ item_id: "UC-001", base_version: 1 }, { item_id: "UC-002", base_version: 1 }] }));
  assert.equal(error.code, "stale_version");
  assert.deepEqual(error.data.items, [{ item_id: "UC-002", base_version: 1, current_version: 2, changed_by: "executor", version_no: 2, by: "executor" }]);
  assert.equal(count(dir, "event"), before);
});

test("undo：改回之前的内容（连同字段一级的来源），新增的删掉，删除的恢复；事件写 undo_of_revision", () => {
  const dir = taskWithItems();
  const edit = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_version: 1 }], fields: { 名称: "用口令登录" } });
  const back = op(dir, { kind: "undo", targets: [{ revision_no: edit.revision_no }] });
  assert.deepEqual(back.results, [{ item_id: "UC-001", version_no: 3 }]);
  assert.equal(JSON.parse(query<any>(dir, "SELECT fields FROM item_version WHERE item_id='UC-001' AND version_no=3")[0].fields).名称, "登录");
  assert.deepEqual(query<any>(dir, "SELECT field, field_index FROM item_source WHERE item_id='UC-001' AND version_no=3").map((r) => [r.field, r.field_index]), [["步骤", 1]]);
  const payload = JSON.parse(query<any>(dir, "SELECT payload FROM event WHERE seq = ?", back.event_seqs[0])[0].payload);
  assert.equal(payload.undo_of_revision, edit.revision_no);
  // 删除的改回去就是恢复；新增的（第 1 次修订）改回去就是删除。
  const del = op(dir, { kind: "delete_item", targets: [{ item_id: "UC-002", base_version: 1 }] });
  const restore = op(dir, { kind: "undo", targets: [{ revision_no: del.revision_no }] });
  assert.deepEqual(restore.results, [{ item_id: "UC-002", version_no: 2 }]);
  assert.equal(query<any>(dir, "SELECT deleted_in_revision FROM item WHERE item_id='UC-002'")[0].deleted_in_revision, null);
  assert.match(restore.note, /恢复 UC-002（现在是第 2 版）/);
});

test("undo_conflict：那次修订之后同一个条目又被改过", () => {
  const dir = taskWithItems();
  const edit = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_version: 1 }], fields: { 名称: "用口令登录" } });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_version: 2, fields: { 名称: "用短信登录" } }] });
  const error = refused(() => op(dir, { kind: "undo", targets: [{ revision_no: edit.revision_no }] }));
  assert.equal(error.code, "undo_conflict");
  assert.equal((error.data.items as any[])[0].item_id, "UC-001");
});

test("task_closed、no_task、bad_request、rejected", () => {
  const empty = makeWorkspace();
  assert.equal(refused(() => op(empty, { kind: "confirm", targets: [{ item_id: "UC-001", base_version: 1 }] })).code, "no_task");
  const dir = taskWithItems();
  assert.equal(refused(() => runUserOperation(ctx(dir), { op_id: "call-1", kind: "confirm", targets: [{ item_id: "UC-001", base_version: 1 }] })).code, "bad_request");
  assert.equal(refused(() => op(dir, { kind: "frobnicate", targets: [{}] })).code, "bad_request");
  assert.equal(refused(() => op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_version: 1 }] })).code, "bad_request");
  assert.equal(refused(() => op(dir, { kind: "confirm", targets: [{ item_id: "UC-404", base_version: 1 }] })).code, "rejected");
  const bad = refused(() => op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_version: 1 }], fields: { 步骤: "不是列表" } }));
  assert.equal(bad.code, "rejected");
  assert.match((bad.data.reasons as string[])[0], /字段「步骤」是文本列表类型/);
  assert.match(bad.message, /^这次修改没有通过核对：操作 1（修改，条目 UC-001）：字段「步骤」是文本列表类型/);
  const db = new DatabaseSync(databasePath(dir));
  db.exec("UPDATE task SET status = '已完成'");
  db.close();
  assert.equal(refused(() => op(dir, { kind: "confirm", targets: [{ item_id: "UC-001", base_version: 1 }] })).code, "task_closed");
});

test("restore 只给用户的撤销用：执行者用它被拒", () => {
  const dir = taskWithItems();
  saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-002", base_version: 1 }] });
  assert.throws(() => saveRevision(callIn(dir), { operations: [{ op: "restore", item: "UC-002", base_version: 1, fields: { 名称: "注销", 步骤: ["点注销"] }, sources: [SOURCE] }] }),
    /restore（恢复删掉的条目）只给用户在界面上的撤销用/);
  assert.ok(demoDefinition());
});
