// 用户在页面上直接改字段时的来源（lib/user_ops.ts 的 withUserEditSources）：条目上的话都算用户自己的，来源只标注引用了哪些原始片段。
// 没动的内容来源保留、位置跟着内容走；用户改写了的内容（普通字段，列表里原地改了文字的项）原来的来源去掉；指整个列表的来源留着；
// 删掉的项上的来源去掉；不加任何新来源，改完之后条目可以没有来源。
// 早期版本写下的「用户直接修改」：新修订里不沿用（用户改、执行者改、执行者重新标注都一样），撤销时照原样恢复。
// 起点：「步骤」三项「甲、乙、丙」。来源一支持「名称」；来源二支持步骤第 2 项「乙」；来源三支持步骤第 3 项「丙」；
// 来源四支持整个「步骤」；来源五支持整个条目。

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { ACTOR_USER, databasePath } from "../src/lib/db.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, callIn, makeWorkspace, query } from "./helpers.ts";

const S = (excerpt: string, supports: unknown[]) => ({ kind: "文档原文", locator: "inputs/材料.md", excerpt, supports });
const STEPS = ["甲：打开页面", "乙：输入口令", "丙：点登录"];
const FIVE = [
  S("用户可以登录。", [{ field: "名称" }]), S("登录总要输入口令。", [{ field: "步骤", index: 1 }]), S("用口令登录", [{ field: "步骤", index: 2 }]),
  S("退款须在七天内处理完毕。", [{ field: "步骤" }]), S("系统要支持并发访问", []),
];

function start(legacy = false): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: STEPS }, sources: FIVE }] });
  if (legacy) {
    // 把来源表换成加入「用户直接修改」之前的建表语句，模拟较早建的库。
    const db = new DatabaseSync(databasePath(dir));
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'item_source'").get() as { sql: string }).sql;
    db.exec("ALTER TABLE item_source RENAME TO item_source_new");
    db.exec(sql.replace(", '用户直接修改'", ""));
    db.exec("INSERT INTO item_source SELECT * FROM item_source_new; DROP TABLE item_source_new;");
    db.close();
  }
  return dir;
}

let n = 0;
const edit = (dir: string, base: number, fields: Record<string, unknown>) =>
  runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-us-${++n}`, kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: base }], fields });

/** 某次修订里每条来源「位置 种类「摘录」→ 支持哪几处（列表项写成那一项的文字）」。 */
function shown(dir: string, revision: number): string[] {
  const now = JSON.parse(query<any>(dir, "SELECT fields FROM item_version WHERE item_id = 'UC-001' AND revision_no = ?", revision)[0].fields);
  return query<any>(dir, "SELECT position, kind, excerpt, field, field_index FROM item_source WHERE item_id = 'UC-001' AND revision_no = ? ORDER BY position, support_no", revision)
    .map((r) => `${r.position} ${r.kind === "文档原文" ? "原文" : r.kind}「${r.excerpt}」→ ` +
      `${r.field === null ? "整个条目" : r.field_index === null ? r.field : `${r.field}「${now[r.field][r.field_index]}」`}`);
}
function after(fields: Record<string, unknown>, legacy = false): string[] {
  const dir = start(legacy);
  edit(dir, 1, fields);
  return shown(dir, 2);
}

const KEPT_HEAD = ["1 原文「用户可以登录。」→ 名称"];
const WHOLE = ["4 原文「退款须在七天内处理完毕。」→ 步骤", "5 原文「系统要支持并发访问」→ 整个条目"];

test("列表末尾加一项：原有各项的来源都留着；新加的那一项不加来源", () => {
  assert.deepEqual(after({ 步骤: [...STEPS, "丁：看到首页"] }), [
    ...KEPT_HEAD, "2 原文「登录总要输入口令。」→ 步骤「乙：输入口令」", "3 原文「用口令登录」→ 步骤「丙：点登录」", ...WHOLE,
  ]);
});

test("列表开头插一项：原有来源跟着原来那一项挪位置，不指错", () => {
  assert.deepEqual(after({ 步骤: ["零：打开应用", ...STEPS] }), [
    ...KEPT_HEAD, "2 原文「登录总要输入口令。」→ 步骤「乙：输入口令」", "3 原文「用口令登录」→ 步骤「丙：点登录」", ...WHOLE,
  ]);
});

test("原地改写「乙」：乙原来的来源去掉，不加新来源；指整个列表的来源留着", () => {
  assert.deepEqual(after({ 步骤: ["甲：打开页面", "乙：扫码", "丙：点登录"] }), [
    ...KEPT_HEAD, "2 原文「用口令登录」→ 步骤「丙：点登录」", "3 原文「退款须在七天内处理完毕。」→ 步骤", "4 原文「系统要支持并发访问」→ 整个条目",
  ]);
});

test("删掉「乙」：指到它的来源去掉，其余跟着挪", () => {
  assert.deepEqual(after({ 步骤: ["甲：打开页面", "丙：点登录"] }), [
    ...KEPT_HEAD, "2 原文「用口令登录」→ 步骤「丙：点登录」", "3 原文「退款须在七天内处理完毕。」→ 步骤", "4 原文「系统要支持并发访问」→ 整个条目",
  ]);
});

test("调换先后：来源跟着原来那一项走", () => {
  assert.deepEqual(after({ 步骤: ["丙：点登录", "乙：输入口令", "甲：打开页面"] }), [
    ...KEPT_HEAD, "2 原文「登录总要输入口令。」→ 步骤「乙：输入口令」", "3 原文「用口令登录」→ 步骤「丙：点登录」", ...WHOLE,
  ]);
});

test("改普通字段：这个字段原来的来源去掉，不加新来源；支持整个条目的来源保留", () => {
  assert.deepEqual(after({ 名称: "扫码登录" }), [
    "1 原文「登录总要输入口令。」→ 步骤「乙：输入口令」", "2 原文「用口令登录」→ 步骤「丙：点登录」", "3 原文「退款须在七天内处理完毕。」→ 步骤",
    "4 原文「系统要支持并发访问」→ 整个条目",
  ]);
});

test("一条来源同时支持被改写的字段与没动的项：只去掉被改写的那一处", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: STEPS },
    sources: [S("用户可以登录。", [{ field: "名称" }, { field: "步骤", index: 0 }])] }] });
  edit(dir, 1, { 名称: "扫码登录" });
  assert.deepEqual(query<any>(dir, "SELECT kind, field, field_index FROM item_source WHERE revision_no = 2 ORDER BY position, support_no").map((r) => [r.kind, r.field, r.field_index]),
    [["文档原文", "步骤", 0]]);
});

test("用户改完之后条目一条来源都没有：照样保存", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: STEPS }, sources: [S("用户可以登录。", [{ field: "名称" }])] }] });
  const result = edit(dir, 1, { 名称: "扫码登录" });
  assert.equal(result.revision_no, 2);
  assert.equal(query<any>(dir, "SELECT COUNT(*) AS n FROM item_source WHERE revision_no = 2")[0].n, 0);
});

test("加入「用户直接修改」之前建的库：与新库同样处理", () => {
  assert.deepEqual(after({ 步骤: ["零：打开应用", "甲：打开页面", "乙：扫码", "丙：点登录"] }, true), [
    ...KEPT_HEAD, "2 原文「用口令登录」→ 步骤「丙：点登录」", "3 原文「退款须在七天内处理完毕。」→ 步骤", "4 原文「系统要支持并发访问」→ 整个条目",
  ]);
});

// ───────────── 早期版本写下的「用户直接修改」 ─────────────

/** 修订 2 由早期版本的页面修改写成：给的来源之外，另有一条「用户直接修改」指着步骤第 4 项「丁」。 */
function withOldRecord(sources = FIVE): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: STEPS }, sources }] });
  saveRevision({ workspaceDir: dir, sessionId: "sess-ui", callId: "ui-op-old", actor: ACTOR_USER }, { operations: [{ op: "update", item: "UC-001", base_revision: 1,
    fields: { 步骤: [...STEPS, "丁：看到首页"] },
    sources: [...sources, { kind: "用户直接修改", locator: "ui-op-old", excerpt: "丁：看到首页", supports: [{ field: "步骤", index: 3 }] }] }] });
  return dir;
}
const hasOld = (dir: string, revision: number) => shown(dir, revision).some((one) => one.includes("用户直接修改"));

test("旧记录：用户在页面上再改时不沿用", () => {
  const dir = withOldRecord();
  assert.ok(hasOld(dir, 2));
  edit(dir, 2, { 名称: "扫码登录" });
  assert.ok(!hasOld(dir, 3));
});

test("旧记录：执行者修改字段时不沿用，改写提醒里也不提它", () => {
  const dir = withOldRecord();
  const outcome = saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 2, fields: { 步骤: [...STEPS, "丁：看到首页并提示成功"] } }] });
  assert.ok(!hasOld(dir, 3));
  assert.doesNotMatch(outcome.text, /用户直接修改/);
});

test("旧记录：执行者整体重新标注时不沿用，也不算进去掉的条数", () => {
  const dir = withOldRecord();
  // 看得见的五条原样给回，就算没有改动（旧记录当作不存在），被拒。
  assert.throws(() => saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 2, sources: FIVE }] }), /完全一样，没有改动任何东西/);
  const outcome = saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 2, sources: FIVE.slice(0, 4) }] });
  assert.ok(!hasOld(dir, 3));
  assert.match(outcome.text, /去掉了原来的 1 条：「系统要支持并发访问」（文档原文）。$/);
});

test("旧记录：条目只剩这种记录时，执行者不给来源去改它，被拒，说明说得通", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: STEPS }, sources: [S("用户可以登录。", [])] }] });
  // 早期版本的页面修改：用户改了「名称」，来源整体换成一条「用户直接修改」。
  saveRevision({ workspaceDir: dir, sessionId: "sess-ui", callId: "ui-op-old", actor: ACTOR_USER }, { operations: [{ op: "update", item: "UC-001", base_revision: 1,
    fields: { 名称: "刷脸登录" }, sources: [{ kind: "用户直接修改", locator: "ui-op-old", excerpt: "刷脸登录", supports: [] }] }] });
  assert.throws(
    () => saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 2, fields: { 步骤: [...STEPS, "丁：看到首页"] } }] }),
    /UC-001 改完之后一条来源也没有。\n  怎么办：请在这个操作里给出 sources，每个条目至少一条来源/,
  );
  // 给了来源就放行，旧记录不沿用。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 2, fields: { 步骤: [...STEPS, "丁：看到首页"] }, sources: [S("用户可以登录。", [])] }] });
  assert.ok(!hasOld(dir, 3));
});

test("旧记录：用户撤销时照原样恢复", () => {
  const dir = withOldRecord();
  const changed = edit(dir, 2, { 名称: "扫码登录" });
  runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: "ui-op-undo", kind: "undo", targets: [{ revision_no: changed.revision_no }] });
  assert.deepEqual(shown(dir, 4), shown(dir, 2));
  assert.ok(hasOld(dir, 4));
});
