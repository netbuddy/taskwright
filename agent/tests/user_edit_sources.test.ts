// 用户在页面上直接改字段时的来源（lib/user_ops.ts 的 withUserEditSources）：没动的内容来源保留、位置跟着内容走；
// 用户改写了的内容（普通字段，列表里原地改了文字的项）原来的来源去掉，换成「用户直接修改」；指整个列表的来源留着；
// 删掉的项上的来源去掉；新加的与改写的项合成一条「用户直接修改」，只指这几项；只调换先后或只删项时不加。
// 起点：「步骤」三项「甲、乙、丙」。来源一支持「名称」；来源二支持步骤第 2 项「乙」；来源三支持步骤第 3 项「丙」；
// 来源四支持整个「步骤」；来源五支持整个条目。

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, callIn, makeWorkspace, query } from "./helpers.ts";

const S = (excerpt: string, supports: unknown[]) => ({ kind: "文档原文", locator: "inputs/材料.md", excerpt, supports });
const STEPS = ["甲：打开页面", "乙：输入口令", "丙：点登录"];

function start(legacy = false): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: STEPS }, sources: [
    S("用户可以登录。", [{ field: "名称" }]), S("登录总要输入口令。", [{ field: "步骤", index: 1 }]), S("用口令登录", [{ field: "步骤", index: 2 }]),
    S("退款须在七天内处理完毕。", [{ field: "步骤" }]), S("系统要支持并发访问", []),
  ] }] });
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
/** 用户在页面上改一次，返回改后每条来源「种类·摘录 → 支持哪几处（列表项写成那一项的文字）」。 */
function edit(fields: Record<string, unknown>, legacy = false): string[] {
  const dir = start(legacy);
  runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-us-${++n}`, kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields });
  const now = JSON.parse(query<any>(dir, "SELECT fields FROM item_version WHERE revision_no = 2")[0].fields);
  const rows = query<any>(dir, "SELECT position, kind, excerpt, field, field_index FROM item_source WHERE revision_no = 2 ORDER BY position, support_no");
  return rows.map((r) => `${r.position} ${r.kind === "用户直接修改" ? "用户直接修改" : "原文"}「${r.excerpt}」→ ` +
    `${r.field === null ? "整个条目" : r.field_index === null ? r.field : `${r.field}「${now[r.field][r.field_index]}」`}`);
}

const KEPT_HEAD = ["1 原文「用户可以登录。」→ 名称"];
const WHOLE = ["4 原文「退款须在七天内处理完毕。」→ 步骤", "5 原文「系统要支持并发访问」→ 整个条目"];

test("列表末尾加一项：原有各项的来源都留着；「用户直接修改」只指新加的那一项", () => {
  assert.deepEqual(edit({ 步骤: [...STEPS, "丁：看到首页"] }), [
    ...KEPT_HEAD, "2 原文「登录总要输入口令。」→ 步骤「乙：输入口令」", "3 原文「用口令登录」→ 步骤「丙：点登录」", ...WHOLE,
    "6 用户直接修改「丁：看到首页」→ 步骤「丁：看到首页」",
  ]);
});

test("列表开头插一项：原有来源跟着原来那一项挪位置，不指错", () => {
  assert.deepEqual(edit({ 步骤: ["零：打开应用", ...STEPS] }), [
    ...KEPT_HEAD, "2 原文「登录总要输入口令。」→ 步骤「乙：输入口令」", "3 原文「用口令登录」→ 步骤「丙：点登录」", ...WHOLE,
    "6 用户直接修改「零：打开应用」→ 步骤「零：打开应用」",
  ]);
});

test("原地改写「乙」：乙原来的来源去掉，换成「用户直接修改」；指整个列表的来源留着", () => {
  assert.deepEqual(edit({ 步骤: ["甲：打开页面", "乙：扫码", "丙：点登录"] }), [
    ...KEPT_HEAD, "2 原文「用口令登录」→ 步骤「丙：点登录」", "3 原文「退款须在七天内处理完毕。」→ 步骤", "4 原文「系统要支持并发访问」→ 整个条目",
    "5 用户直接修改「乙：扫码」→ 步骤「乙：扫码」",
  ]);
});

test("删掉「乙」：指到它的来源去掉，其余跟着挪；不加「用户直接修改」", () => {
  assert.deepEqual(edit({ 步骤: ["甲：打开页面", "丙：点登录"] }), [
    ...KEPT_HEAD, "2 原文「用口令登录」→ 步骤「丙：点登录」", "3 原文「退款须在七天内处理完毕。」→ 步骤", "4 原文「系统要支持并发访问」→ 整个条目",
  ]);
});

test("调换先后：来源跟着原来那一项走；不加「用户直接修改」", () => {
  assert.deepEqual(edit({ 步骤: ["丙：点登录", "乙：输入口令", "甲：打开页面"] }), [
    ...KEPT_HEAD, "2 原文「登录总要输入口令。」→ 步骤「乙：输入口令」", "3 原文「用口令登录」→ 步骤「丙：点登录」", ...WHOLE,
  ]);
});

test("改写一项又加一项：两处合成一条「用户直接修改」，只指这两项，摘录是这两项的文字", () => {
  assert.deepEqual(edit({ 步骤: ["甲：打开页面", "乙：扫码", "丙：点登录", "丁：看到首页"] }), [
    ...KEPT_HEAD, "2 原文「用口令登录」→ 步骤「丙：点登录」", "3 原文「退款须在七天内处理完毕。」→ 步骤", "4 原文「系统要支持并发访问」→ 整个条目",
    "5 用户直接修改「乙：扫码；丁：看到首页」→ 步骤「乙：扫码」", "5 用户直接修改「乙：扫码；丁：看到首页」→ 步骤「丁：看到首页」",
  ]);
});

test("改普通字段：这个字段原来的来源换成「用户直接修改」；支持整个条目的来源保留", () => {
  assert.deepEqual(edit({ 名称: "扫码登录" }), [
    "1 原文「登录总要输入口令。」→ 步骤「乙：输入口令」", "2 原文「用口令登录」→ 步骤「丙：点登录」", "3 原文「退款须在七天内处理完毕。」→ 步骤",
    "4 原文「系统要支持并发访问」→ 整个条目", "5 用户直接修改「扫码登录」→ 名称",
  ]);
});

test("一条来源同时支持被改写的字段与没动的项：只去掉被改写的那一处", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: STEPS },
    sources: [S("用户可以登录。", [{ field: "名称" }, { field: "步骤", index: 0 }])] }] });
  runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: "ui-op-both", kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 名称: "扫码登录" } });
  assert.deepEqual(query<any>(dir, "SELECT kind, field, field_index FROM item_source WHERE revision_no = 2 ORDER BY position, support_no").map((r) => [r.kind, r.field, r.field_index]),
    [["文档原文", "步骤", 0], ["用户直接修改", "名称", null]]);
});

test("加入「用户直接修改」之前建的库：不写这种来源，但原来的来源按内容挪到对的位置，不再指错", () => {
  assert.deepEqual(edit({ 步骤: ["零：打开应用", ...STEPS] }, true), [
    ...KEPT_HEAD, "2 原文「登录总要输入口令。」→ 步骤「乙：输入口令」", "3 原文「用口令登录」→ 步骤「丙：点登录」", ...WHOLE,
  ]);
});
