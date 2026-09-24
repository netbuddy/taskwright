/**
 * 只读工具与用户直接修改来源的三部分：
 *   1. 两个只读工具的核心逻辑：查看条目（getItem）、查询任务状态（getTaskStatus）；
 *   2. 界面操作追加进会话的通知正文带改后的字段值；
 *   3. 来源种类「用户直接修改」：直接操作改到的字段写这种来源，没改的沿用；执行者不能填；执行者给新来源时自动带上。
 * 直接测 lib，不经 pi。
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { boardLines } from "../src/lib/board.ts";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { getItem, getTaskStatus } from "../src/lib/task_query.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, demoDefinition, makeWorkspace, query } from "./helpers.ts";

function definitionWithKeep() {
  const raw = demoDefinition() as any;
  raw.交付物.条目集合[1].字段[1].取值 = ["未解决", "已解决", "用户决定保留"];
  return raw;
}

/** 一个任务：UC-001 的「名称」与「步骤」第 2 步各有自己的来源，UC-002 一条支持整个条目的来源，TBD-001 未解决。 */
function fixture(): string {
  const dir = makeWorkspace(definitionWithKeep());
  createTask(callIn(dir), { definition_path: DEFINITION_PATH, task_name: "增量七夹具" });
  saveRevision(callIn(dir), {
    operations: [
      {
        op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面", "输入口令"] },
        sources: [
          { kind: "文档原文", locator: "inputs/材料.md", excerpt: "用户可以登录。", supports: [{ field: "名称" }] },
          { kind: "执行者补充", locator: "执行者补充", excerpt: "登录总要输入口令。", supports: [{ field: "步骤", index: 1 }, { field: "名称" }] },
        ],
      },
      { op: "add", collection: "用例", fields: { 名称: "注销", 步骤: ["点注销"] }, sources: [SOURCE] },
      { op: "add", collection: "问题", fields: { 事项: "口令长度？", 状态: "未解决" }, sources: [SOURCE] },
    ],
  });
  return dir;
}

let n = 0;
const op = (dir: string, body: Record<string, unknown>) => runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-7-${++n}`, ...body });
const sourcesOf = (dir: string, item: string, revision: number) =>
  query<any>(dir, "SELECT position, kind, locator, excerpt, field, field_index FROM item_source WHERE item_id = ? AND revision_no = ? ORDER BY position, support_no", item, revision)
    .map((row) => ({ ...row }));

// ───────────── 查看条目 ─────────────

test("查看条目：最新内容的全部字段、来源、评审与确认；文字里写明改时 base_revision 写几，并附字段原值", () => {
  const dir = fixture();
  const outcome = getItem(dir, { item_id: "uc-001" });
  assert.equal(outcome.details.item_id, "UC-001");
  assert.equal(outcome.details.revision_no, 1);
  assert.equal(outcome.details.current_revision, 1);
  assert.deepEqual(outcome.details.revisions, [1]);
  assert.deepEqual(outcome.details.fields, { 名称: "登录", 步骤: ["打开页面", "输入口令"] });
  assert.deepEqual(outcome.details.sources, [
    { kind: "文档原文", locator: "inputs/材料.md", excerpt: "用户可以登录。", supports: [{ field: "名称" }] },
    { kind: "执行者补充", locator: "执行者补充", excerpt: "登录总要输入口令。", supports: [{ field: "步骤", index: 1 }, { field: "名称" }] },
  ]);
  assert.equal(outcome.details.review, "还没有评审记录");
  assert.equal(outcome.details.confirm, "未读（用户从没看过）");
  assert.match(outcome.text, /^条目 UC-001（集合「用例」），修订 1，是最新内容。/);
  assert.match(outcome.text, /UC-001 现在是修订 1。要修改或删除这个条目时，base_revision 写 1。/);
  assert.match(outcome.text, /这份内容各字段的原值（JSON）：\{"名称":"登录","步骤":\["打开页面","输入口令"\]\}$/);
});

test("查看条目：可以看截至某次修订的内容；没有的条目、删掉的条目、还没有的修订都抛异常说明", () => {
  const dir = fixture();
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } }] });
  const old = getItem(dir, { item_id: "UC-001", revision_no: 1 });
  assert.equal(old.details.revision_no, 1);
  assert.equal(old.details.current_revision, 2);
  assert.deepEqual(old.details.revisions, [1, 2]);
  assert.match(old.text, /这是旧内容；UC-001 现在是修订 2/);
  assert.throws(() => getItem(dir, { item_id: "UC-009" }), /这个任务里没有条目 UC-009。现有的条目是：UC-001、UC-002、TBD-001。/);
  assert.throws(() => getItem(dir, { item_id: "UC-001", revision_no: 5 }), /这个任务还没有修订 5，最新是修订 2。/);
  assert.throws(() => getItem(dir, { item_id: "UC-001", revision_no: 0 }), /revision_no 应当是从 1 起的整数/);
  assert.throws(() => getItem(dir, {}), /item_id 要写条目编号/);
  saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-002", base_revision: 1 }] });
  assert.throws(() => getItem(dir, { item_id: "UC-002" }), /条目 UC-002 已在修订 3 删除/);
  assert.throws(() => getItem(makeWorkspace(), { item_id: "UC-001" }), /还没有任务记录/);
});

// ───────────── 查询任务状态 ─────────────

test("查询任务状态：各集合的条目、完成条件与看板逐行相同、未解决的问题条目、最近一次修订与事件序号", () => {
  const dir = fixture();
  const outcome = getTaskStatus(dir);
  const lines = outcome.text.split("\n");
  assert.deepEqual(lines.slice(0, 4), [
    "任务 TASK-001「增量七夹具」（类型：演示任务），状态是进行中。",
    "",
    "用例 2 个：UC-001（修订 1）、UC-002（修订 1）。",
    "问题 1 个：TBD-001（修订 1）。",
  ]);
  // 完成条件那几行与 /tw-board 打印的一字不差。
  const board = boardLines(dir);
  const from = board.findIndex((line) => line.startsWith("要完成任务") || line.startsWith("完成条件都已满足"));
  const conditions = board.slice(from, board.indexOf("", from));
  assert.ok(conditions.length > 1);
  assert.deepEqual(lines.slice(5, 5 + conditions.length), conditions);
  assert.ok(outcome.text.includes("未解决的问题条目 1 条：\n  TBD-001（修订 1）：口令长度？"));
  assert.ok(outcome.text.includes("最近一次修订是修订 1（事件序号 2）。"));
  assert.equal(lines[lines.length - 1], board[board.length - 1]);
  assert.deepEqual(outcome.details.items, { 用例: ["UC-001", "UC-002"], 问题: ["TBD-001"] });
  assert.equal(outcome.details.last_revision_no, 1);
  assert.equal(outcome.details.last_event_seq, 2);
  assert.deepEqual(outcome.details.unresolved, [{ item_id: "TBD-001", revision_no: 1, title: "口令长度？" }]);
  assert.equal((outcome.details.conditions as unknown[]).length, 4);
});

test("查询任务状态：还没有修订时如实说明", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const outcome = getTaskStatus(dir);
  assert.ok(outcome.text.includes("交付物还没有任何修订。"));
  assert.ok(outcome.text.includes("未解决的问题条目：没有。"));
});

// ───────────── 界面操作的通知带新值，来源换成「用户直接修改」 ─────────────

test("改字段：改到的字段来源换成「用户直接修改」，没改的字段来源沿用，同时支持两处的来源只去掉改到的那一处", () => {
  const dir = fixture();
  const result = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 名称: "用口令登录" } });
  assert.equal(result.note, "界面操作（不是用户打的字）：用户改了 UC-001 的「名称」，产生修订 2，UC-001 现在是修订 2。这次修改同时算作用户看过并认可了 UC-001（修订 2）。改后的内容是：\n「名称」：用口令登录");
  assert.deepEqual(sourcesOf(dir, "UC-001", 2), [
    { position: 1, kind: "执行者补充", locator: "执行者补充", excerpt: "登录总要输入口令。", field: "步骤", field_index: 1 },
    { position: 2, kind: "用户直接修改", locator: result.op_id, excerpt: "用口令登录", field: "名称", field_index: null },
  ]);
});

test("改列表字段：通知逐条列出，摘录取新值前 200 字；支持整个条目的来源保留", () => {
  const dir = fixture();
  const long = "很".repeat(250);
  const result = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-002", base_revision: 1 }], fields: { 步骤: ["点注销", long] } });
  assert.ok(result.note.endsWith(`「步骤」：\n  1. 点注销\n  2. ${long}`));
  const rows = sourcesOf(dir, "UC-002", 2);
  assert.deepEqual(rows[0], { position: 1, kind: "文档原文", locator: "inputs/材料.md", excerpt: "用户可以登录。", field: null, field_index: null });
  assert.equal(rows[1].kind, "用户直接修改");
  assert.equal([...rows[1].excerpt].length, 200);
  assert.ok(rows[1].excerpt.startsWith("点注销；很"));
});

test("清空可选字段：通知写明清空了，不给空字段写来源", () => {
  const dir = fixture();
  op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-002", base_revision: 1 }], fields: { 备注: "临时" } });
  const result = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-002", base_revision: 2 }], fields: { 备注: "" } });
  assert.match(result.note, /「备注」：（清空了）$/);
  assert.deepEqual(sourcesOf(dir, "UC-002", 3).map((row) => row.kind), ["文档原文"]);
});

test("标为先不管：状态字段的来源换成「用户直接修改」；删除的通知写明已删除；撤销的通知写出撤销后的内容", () => {
  const dir = fixture();
  const keep = op(dir, { kind: "keep_pending", targets: [{ item_id: "TBD-001", base_revision: 1 }] });
  const tbd = sourcesOf(dir, "TBD-001", 2);
  assert.deepEqual(tbd.map((row) => [row.kind, row.field]), [["文档原文", null], ["用户直接修改", "状态"]]);
  assert.equal(tbd[1].locator, keep.op_id);
  const del = op(dir, { kind: "delete_item", targets: [{ item_id: "UC-002", base_revision: 1 }] });
  assert.match(del.note, /用户删除了 UC-002（删除前在修订 1），产生修订 3。这些条目已删除，不再算在交付物里。$/);
  const edit = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 名称: "用口令登录" } });
  const undo = op(dir, { kind: "undo", targets: [{ revision_no: edit.revision_no }] });
  assert.match(undo.note, /^界面操作（不是用户打的字）：用户撤销了修订 4，产生修订 5：改回 UC-001（UC-001 退回修订 1 的内容，现在是修订 5）。\nUC-001 现在的内容是：\n「名称」：登录\n「步骤」：\n  1. 打开页面\n  2. 输入口令$/);
  // 撤销把来源也改回去了。
  assert.deepEqual(sourcesOf(dir, "UC-001", 5), sourcesOf(dir, "UC-001", 1));
});

// ───────────── 执行者与「用户直接修改」 ─────────────

test("执行者不能填「用户直接修改」", () => {
  const dir = fixture();
  assert.throws(
    () => saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "x", 步骤: ["y"] }, sources: [{ kind: "用户直接修改", locator: "ui-op-1", excerpt: "x" }] }] }),
    /种类写成了「用户直接修改」，这一种只由系统在用户直接改字段时写/,
  );
});

test("执行者修改时给了新来源：没改到的字段上的「用户直接修改」来源自动带上；改到了就不带", () => {
  const dir = fixture();
  op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 名称: "用口令登录" } });
  saveRevision(callIn(dir), {
    operations: [{ op: "update", item: "UC-001", base_revision: 2, fields: { 步骤: ["打开页面", "输入口令", "点登录"] }, sources: [{ ...SOURCE, supports: [{ field: "步骤" }] }] }],
  });
  assert.deepEqual(sourcesOf(dir, "UC-001", 3).map((row) => [row.kind, row.field]), [["用户直接修改", "名称"], ["文档原文", "步骤"]]);
  saveRevision(callIn(dir), {
    operations: [{ op: "update", item: "UC-001", base_revision: 3, fields: { 名称: "账号登录" }, sources: [{ ...SOURCE, supports: [] }] }],
  });
  // 这次改的正是「名称」：用户直接修改那条不再沿用；「步骤」上的来源沿用。
  assert.deepEqual(sourcesOf(dir, "UC-001", 4).map((row) => [row.kind, row.field]), [["文档原文", "步骤"], ["文档原文", null]]);
});

test("加入第四种来源之前建的库不认它：改字段照旧能改，来源沿用条目当前的来源", () => {
  const dir = fixture();
  // 把来源表换成旧的建表语句（种类检查只有三种），模拟较早建的库。
  const db = new DatabaseSync(databasePath(dir));
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'item_source'").get() as { sql: string }).sql;
  db.exec("ALTER TABLE item_source RENAME TO item_source_new");
  db.exec(sql.replace(", '用户直接修改'", ""));
  db.exec("INSERT INTO item_source SELECT * FROM item_source_new; DROP TABLE item_source_new;");
  db.close();
  const result = op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 名称: "用口令登录" } });
  assert.equal(result.results[0].revision_no, 2);
  assert.deepEqual(sourcesOf(dir, "UC-001", 2).map((row) => row.kind), ["文档原文", "执行者补充", "执行者补充"]);
  assert.ok(count(dir, "event") >= 3);
});

test("查看条目：给一个中间的修订号，看到的是条目截至那次修订的内容（修订号不大于它的最近一次改动）", () => {
  const dir = fixture();
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-002", base_revision: 1, fields: { 名称: "退出" } }] });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } }] });
  const at2 = getItem(dir, { item_id: "UC-001", revision_no: 2 });
  assert.equal(at2.details.revision_no, 1, "修订 2 没有改动 UC-001，它那时的内容来自修订 1");
  assert.deepEqual(at2.details.revisions, [1, 3]);
  assert.equal((at2.details.fields as any).名称, "登录");
  assert.match(at2.text, /^条目 UC-001（集合「用例」），修订 2 时的内容来自修订 1，最新内容在修订 3。/);
});

test("旧写法 base_version 不再被接受：界面直接操作与保存修订都要写 base_revision，什么都不写入", () => {
  const dir = fixture();
  const before = count(dir, "event");
  assert.throws(
    () => op(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_version: 1 }], fields: { 名称: "用口令登录" } }),
    (error: any) => error.code === "bad_request" && /base_revision/.test(error.message),
  );
  assert.throws(
    () => saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_version: 1, fields: { 名称: "用口令登录" } } as any] }),
    /没写它看到的是哪次修订/,
  );
  assert.equal(count(dir, "event"), before);
});
