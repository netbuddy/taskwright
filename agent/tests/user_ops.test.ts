/** 用户在界面上的直接操作：每种操作与每种拒绝。直接测 lib/user_ops.ts，不经 pi。 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { checkCompletion } from "../src/lib/conditions.ts";
import { completeTask } from "../src/lib/complete_task.ts";
import { getTaskStatus } from "../src/lib/task_query.ts";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { UserOpError, runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, demoDefinition, makeWorkspace, query } from "./helpers.ts";

/** 演示任务定义，问题的状态多一个「用户决定保留」，好测「标为先不管」。 */
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
      { op: "add", collection: "问题", fields: { 事项: "口令长度？", 状态: "未解决" }, sources: [SOURCE] },
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
  const result = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 步骤: ["打开页面", "输入口令", "点登录"] } });
  assert.deepEqual(result.results, [{ item_id: "UC-001", revision_no: 2 }]);
  assert.equal(result.note, "界面操作（不是用户打的字）：用户改了 UC-001 的「步骤」，产生修订 2，UC-001 现在是修订 2。这次修改同时算作用户看过并认可了 UC-001（修订 2）。改后的内容是：\n「步骤」：\n  1. 打开页面\n  2. 输入口令\n  3. 点登录");
  assert.equal(result.undoable, true);
  const event = query<any>(dir, "SELECT actor, call_id, name FROM event WHERE seq = ?", result.event_seqs[0])[0];
  assert.deepEqual({ ...event }, { actor: "user", call_id: result.op_id, name: "REVISION_SAVED" });
  assert.deepEqual(JSON.parse(query<any>(dir, "SELECT fields FROM item_version WHERE item_id='UC-001' AND revision_no=2")[0].fields).步骤, ["打开页面", "输入口令", "点登录"]);
});

test("改字段与标为先不管随修订自动登记确认（依据界面修改，basis ui_edit）；删除与撤销修订不自动确认", () => {
  const dir = taskWithItems();
  const db = () => new DatabaseSync(databasePath(dir), { readOnly: true });
  const acceptedAt = (item: string, revision: number) =>
    query<any>(dir, "SELECT ji.attitude, j.basis FROM judgement_item ji JOIN judgement j ON j.judgement_id = ji.judgement_id WHERE ji.item_id = ? AND ji.revision_no = ?", item, revision);

  // 改字段：修订事件之后紧跟一条确认事件，同一个操作编号；判读依据「界面修改」，明细是改出来的那次修订、接受。
  const edit = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 名称: "用口令登录" } });
  assert.equal(edit.event_seqs.length, 2);
  const [saved, confirmedEvent] = edit.event_seqs.map((seq) => query<any>(dir, "SELECT name, actor, call_id, payload FROM event WHERE seq = ?", seq)[0]);
  assert.equal(saved.name, "REVISION_SAVED");
  assert.deepEqual({ name: confirmedEvent.name, actor: confirmedEvent.actor, call_id: confirmedEvent.call_id },
    { name: "CONFIRMATION_RECORDED", actor: "user", call_id: edit.op_id });
  assert.deepEqual(JSON.parse(confirmedEvent.payload), { items: [{ item_id: "UC-001", revision_no: 2, accepted: true }], basis: "ui_edit" });
  const rows = acceptedAt("UC-001", 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attitude, "接受");
  assert.deepEqual(JSON.parse(rows[0].basis), [{ 依据: "界面修改", 操作编号: edit.op_id }]);
  let handle = db();
  const onlyUc001 = () => checkCompletion(handle, "TASK-001", { 用例: ["每个条目用户确认"] })[0].unmet;
  assert.ok(!JSON.stringify(onlyUc001()).includes("UC-001"), "改过的 UC-001 已算确认");
  handle.close();

  // 标为先不管：同样自动确认。
  const keep = op(dir, { kind: "keep_pending", targets: [{ item_id: "TBD-001", base_revision: 1 }] });
  assert.equal(keep.event_seqs.length, 2);
  assert.match(keep.note, /这次修改同时算作用户看过并认可了 TBD-001（修订 3）。$/);
  assert.equal(acceptedAt("TBD-001", 3)[0].attitude, "接受");

  // 撤销修订：产生新修订，新修订上没有确认。
  const undo = op(dir, { kind: "undo", targets: [{ revision_no: 2 }] });
  assert.equal(undo.event_seqs.length, 1);
  assert.equal(acceptedAt("UC-001", undo.revision_no!).length, 0);
  assert.doesNotMatch(undo.note, /看过并认可/);

  // 删除：不写确认。
  const before = count(dir, "judgement");
  const del = op(dir, { kind: "delete_item", targets: [{ item_id: "UC-002", base_revision: 1 }] });
  assert.equal(del.event_seqs.length, 1);
  assert.equal(count(dir, "judgement"), before);
  assert.doesNotMatch(del.note, /看过并认可/);
});

test("delete_item 与 keep_pending：可以一次多个条目", () => {
  const dir = taskWithItems();
  const del = op(dir, { kind: "delete_item", targets: [{ item_id: "UC-001", base_revision: 1 }, { item_id: "UC-002", base_revision: 1 }] });
  assert.match(del.note, /用户删除了 UC-001（删除前在修订 1）、UC-002（删除前在修订 1），产生修订 2。/);
  assert.equal(count(dir, "revision"), 2);
  const keep = op(dir, { kind: "keep_pending", targets: [{ item_id: "TBD-001", base_revision: 1 }] });
  assert.match(keep.note, /TBD-001 标为先不管（状态改为「用户决定保留」），产生修订 3，TBD-001 现在是修订 3。/);
  assert.equal(JSON.parse(query<any>(dir, "SELECT fields FROM item_version WHERE item_id='TBD-001' AND revision_no=3")[0].fields).状态, "用户决定保留");
});

test("keep_pending 用在没有这种状态的集合上被拒；状态取值里没有「用户决定保留」时也被拒", () => {
  const dir = taskWithItems();
  assert.equal(refused(() => op(dir, { kind: "keep_pending", targets: [{ item_id: "UC-001", base_revision: 1 }] })).code, "rejected");
  // 原样的演示任务定义里问题的状态只有「未解决」「已解决」两种。
  const plain = taskWithItems(demoDefinition());
  assert.equal(refused(() => op(plain, { kind: "keep_pending", targets: [{ item_id: "TBD-001", base_revision: 1 }] })).code, "rejected");
});

test("mark_viewed：写已读标记（依据已读），记 ITEM_VIEWED；打开详情时不追加说明、不告诉执行者，卡片上点时带固定模板", () => {
  const dir = taskWithItems();
  const opened = op(dir, { kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] });
  assert.equal(opened.note, "");
  assert.equal(opened.notify_text, null);
  assert.equal(opened.undoable, false);
  assert.equal(opened.revision_no, null);
  const event = query<any>(dir, "SELECT name, actor, call_id, payload FROM event WHERE seq = ?", opened.event_seqs[0])[0];
  assert.deepEqual({ name: event.name, actor: event.actor, call_id: event.call_id }, { name: "ITEM_VIEWED", actor: "user", call_id: opened.op_id });
  assert.deepEqual(JSON.parse(event.payload), { items: [{ item_id: "UC-001", revision_no: 1 }], basis: "viewed" });
  const mark = query<any>(dir, "SELECT ji.attitude, j.basis FROM judgement_item ji JOIN judgement j ON j.judgement_id = ji.judgement_id WHERE ji.item_id = 'UC-001'");
  assert.deepEqual(mark.map((row) => ({ attitude: row.attitude, basis: JSON.parse(row.basis) })), [{ attitude: "接受", basis: [{ 依据: "已读", 操作编号: opened.op_id }] }]);

  const card = op(dir, { kind: "mark_viewed", targets: [{ item_id: "UC-002", base_revision: 1 }, { item_id: "TBD-001", base_revision: 1 }], notify_executor: true });
  assert.equal(card.note, "界面操作（不是用户打的字）：用户在卡片上表示看过了 UC-002（修订 1）、TBD-001（修订 1），已记为已读。");
  assert.equal(card.notify_text, "我已经看过了：UC-002（修订 1），TBD-001（修订 1）。请接着往下做。");
  const db = new DatabaseSync(databasePath(dir), { readOnly: true });
  assert.equal(checkCompletion(db, "TASK-001", { 用例: ["每个条目用户确认"] })[0].satisfied, true);
  db.close();
});

test("mark_viewed 幂等：同一条目同一修订已经接受过的不再写、不记事件；撤回之后仍算看过，再打开会重新记一条", () => {
  const dir = taskWithItems();
  op(dir, { kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] });
  const events = count(dir, "event");
  const again = op(dir, { kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] });
  assert.deepEqual(again.event_seqs, []);
  assert.equal(count(dir, "event"), events);
  assert.equal(count(dir, "judgement_item"), 1);
  // 一批里只写还没接受的那几条。
  const mixed = op(dir, { kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }, { item_id: "UC-002", base_revision: 1 }] });
  assert.deepEqual(JSON.parse(query<any>(dir, "SELECT payload FROM event WHERE seq = ?", mixed.event_seqs[0])[0].payload).items,
    [{ item_id: "UC-002", revision_no: 1 }]);
  // 用户亲手改出来的内容已经算认可，再打开不另写已读。
  const edit = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-002", base_revision: 1 }], fields: { 名称: "退出" } });
  assert.deepEqual(op(dir, { kind: "mark_viewed", targets: [{ item_id: "UC-002", base_revision: edit.revision_no }] }).event_seqs, []);
  // 撤回：写一条不接受；已读是条目级、单向的，看过的条目撤回之后仍不算未读。再打开照样重新写一条已读。
  const back = op(dir, { kind: "unconfirm", targets: [{ item_id: "UC-001", base_revision: 1 }] });
  assert.equal(back.note, "界面操作（不是用户打的字）：用户在界面上撤回了对 UC-001（修订 1）的确认。");
  const db = new DatabaseSync(databasePath(dir), { readOnly: true });
  const unread = () => checkCompletion(db, "TASK-001", { 用例: ["每个条目用户确认"] })[0].unmet.map((u) => u.item);
  assert.deepEqual(unread(), []);
  assert.equal(op(dir, { kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] }).event_seqs.length, 1);
  assert.deepEqual(unread(), []);
  db.close();
});

test("已读是条目级、单向的：看过旧修订的条目被改后不算未读；从没看过的才进未读清单，完成任务被拒时写「还有 N 条你从没看过」", () => {
  const dir = taskWithItems();
  op(dir, { kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } }] });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-002", base_revision: 1, fields: { 名称: "退出登录" } }] });
  const status = getTaskStatus(dir);
  // UC-001 看过修订 1、现在是修订 2，当前修订上没有标记，仍不算未读；UC-002 从没看过。
  assert.deepEqual(status.details.unread, [{ item_id: "UC-002", title: "退出登录", revision_no: 3 }]);
  assert.match(status.text, /未读的条目 1 条（用户从没打开看过它们；问用户要不要完成任务之前，先告诉用户还有几条没看）：UC-002「退出登录」。/);
  const refusedText = (() => {
    try {
      completeTask({ workspaceDir: dir, sessionId: "s", callId: "call-done" });
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail("应当被拒绝");
  })();
  assert.match(refusedText, /^任务没有标为已完成。\n还有 1 条你从没看过：UC-002「退出登录」。\n/);
  op(dir, { kind: "mark_viewed", targets: [{ item_id: "UC-002", base_revision: 3 }] });
  assert.deepEqual(getTaskStatus(dir).details.unread, []);
  assert.match(getTaskStatus(dir).text, /未读的条目：没有/);
});

test("修订号过期整批拒绝 stale_revision，逐条写明条目现在在哪次修订、是谁改的；过期的那批一行都不写", () => {
  const dir = taskWithItems();
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-002", base_revision: 1, fields: { 名称: "退出登录" } }] });
  const before = count(dir, "event");
  const error = refused(() => op(dir, { kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }, { item_id: "UC-002", base_revision: 1 }] }));
  assert.equal(error.code, "stale_revision");
  assert.deepEqual(error.data.items, [{ item_id: "UC-002", base_revision: 1, current_revision: 2, changed_by: "executor" }]);
  assert.equal(count(dir, "event"), before);
});

test("undo：改回之前的内容（连同字段一级的来源），新增的删掉，删除的恢复；事件写 undo_of_revision", () => {
  const dir = taskWithItems();
  const edit = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 名称: "用口令登录" } });
  const back = op(dir, { kind: "undo", targets: [{ revision_no: edit.revision_no }] });
  assert.deepEqual(back.results, [{ item_id: "UC-001", revision_no: 3 }]);
  assert.equal(JSON.parse(query<any>(dir, "SELECT fields FROM item_version WHERE item_id='UC-001' AND revision_no=3")[0].fields).名称, "登录");
  assert.deepEqual(query<any>(dir, "SELECT field, field_index FROM item_source WHERE item_id='UC-001' AND revision_no=3").map((r) => [r.field, r.field_index]), [["步骤", 1]]);
  const payload = JSON.parse(query<any>(dir, "SELECT payload FROM event WHERE seq = ?", back.event_seqs[0])[0].payload);
  assert.equal(payload.undo_of_revision, edit.revision_no);
  // 删除的改回去就是恢复；新增的（修订 1）改回去就是删除。
  const del = op(dir, { kind: "delete_item", targets: [{ item_id: "UC-002", base_revision: 1 }] });
  const restore = op(dir, { kind: "undo", targets: [{ revision_no: del.revision_no }] });
  assert.deepEqual(restore.results, [{ item_id: "UC-002", revision_no: 5 }]);
  assert.equal(query<any>(dir, "SELECT deleted_in_revision FROM item WHERE item_id='UC-002'")[0].deleted_in_revision, null);
  assert.match(restore.note, /用户撤销了修订 4，产生修订 5：恢复 UC-002（UC-002 退回修订 1 的内容，现在是修订 5）/);
});

test("undo_conflict：那次修订之后同一个条目又被改过", () => {
  const dir = taskWithItems();
  const edit = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 名称: "用口令登录" } });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 2, fields: { 名称: "用短信登录" } }] });
  const error = refused(() => op(dir, { kind: "undo", targets: [{ revision_no: edit.revision_no }] }));
  assert.equal(error.code, "undo_conflict");
  assert.equal((error.data.items as any[])[0].item_id, "UC-001");
});

test("task_closed、no_task、bad_request、rejected", () => {
  const empty = makeWorkspace();
  assert.equal(refused(() => op(empty, { kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] })).code, "no_task");
  const dir = taskWithItems();
  assert.equal(refused(() => runUserOperation(ctx(dir), { op_id: "call-1", kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] })).code, "bad_request");
  // 界面上的「确认」已经退役，confirm 不再是直接操作的种类。
  assert.equal(refused(() => op(dir, { kind: "confirm", targets: [{ item_id: "UC-001", base_revision: 1 }] })).code, "bad_request");
  assert.equal(refused(() => op(dir, { kind: "frobnicate", targets: [{}] })).code, "bad_request");
  assert.equal(refused(() => op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }] })).code, "bad_request");
  assert.equal(refused(() => op(dir, { kind: "mark_viewed", targets: [{ item_id: "UC-404", base_revision: 1 }] })).code, "rejected");
  const bad = refused(() => op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 步骤: "不是列表" } }));
  assert.equal(bad.code, "rejected");
  assert.match((bad.data.reasons as string[])[0], /字段「步骤」是文本列表类型/);
  assert.match(bad.message, /^这次修改没有通过核对：操作 1（修改，条目 UC-001）：字段「步骤」是文本列表类型/);
  const db = new DatabaseSync(databasePath(dir));
  db.exec("UPDATE task SET status = '已完成'");
  db.close();
  assert.equal(refused(() => op(dir, { kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] })).code, "task_closed");
});

test("restore 只给用户的撤销用：执行者用它被拒", () => {
  const dir = taskWithItems();
  saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-002", base_revision: 1 }] });
  assert.throws(() => saveRevision(callIn(dir), { operations: [{ op: "restore", item: "UC-002", base_revision: 1, fields: { 名称: "注销", 步骤: ["点注销"] }, sources: [SOURCE] }] }),
    /restore（恢复删掉的条目）只给用户在界面上的撤销用/);
  assert.ok(demoDefinition());
});
