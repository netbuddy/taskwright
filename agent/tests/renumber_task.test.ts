/** 给任务换编号（数据包导入时用）：十六张表里的编号都换掉、行数不变；换完照常存修订；写法不对、没有库、比程序新时不动库。 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { renumberTask } from "../src/lib/renumber_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { NewerTaskDatabase, NoDatabaseYet, TABLE_NAMES, TASK_DB_VERSION, withTaskDatabase } from "../src/lib/schema.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, makeWorkspace, query } from "./helpers.ts";

const addUseCase = (name: string) => ({ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["打开页面", "输入口令"] }, sources: [SOURCE] });

/** 一个建好任务、存过两次修订的任务目录。 */
function workspaceWithRevisions(taskId: string): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH, task_id: taskId });
  saveRevision(callIn(dir), { operations: [addUseCase("登录")] });
  saveRevision(callIn(dir), { operations: [addUseCase("退款")] });
  return dir;
}

/** 各张表里带着某个编号的行数（只列有行的表）。 */
function rowsWith(dir: string, taskId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of TABLE_NAMES) {
    const n = Number(query<{ n: number }>(dir, `SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ?`, taskId)[0].n);
    if (n > 0) out[table] = n;
  }
  return out;
}

test("十六张表每一张都有 task_id 这一列（换编号是逐张表改的，靠这一条）", () => {
  const dir = workspaceWithRevisions("TASK-OLD-1");
  for (const table of TABLE_NAMES) {
    const columns = query<{ name: string }>(dir, `PRAGMA table_info(${table})`).map((c) => c.name);
    assert.ok(columns.includes("task_id"), `${table} 表没有 task_id 列`);
  }
});

test("换编号：各张表里旧编号的行都成了新编号的，行数不变；换完照常存修订", () => {
  const dir = workspaceWithRevisions("TASK-OLD-1");
  const before = rowsWith(dir, "TASK-OLD-1");
  const totals = Object.fromEntries(TABLE_NAMES.map((table) => [table, count(dir, table)]));
  assert.ok(Object.keys(before).length >= 5, "任务、修订、条目、条目内容、来源、事件这几张表都有行");

  const outcome = renumberTask(dir, "TASK-NEW-2");
  assert.deepEqual([outcome.from, outcome.to], ["TASK-OLD-1", "TASK-NEW-2"]);
  assert.equal(outcome.rows, Object.values(before).reduce((a, b) => a + b, 0));
  assert.deepEqual(rowsWith(dir, "TASK-OLD-1"), {});
  assert.deepEqual(rowsWith(dir, "TASK-NEW-2"), before);
  assert.deepEqual(Object.fromEntries(TABLE_NAMES.map((table) => [table, count(dir, table)])), totals);

  // 换完的库照常用：再存一次修订，记在新编号下。
  saveRevision(callIn(dir), { operations: [addUseCase("对账")] });
  assert.deepEqual(query(dir, "SELECT task_id, revision_no FROM revision ORDER BY revision_no").map((r) => ({ ...r })),
    [1, 2, 3].map((revision_no) => ({ task_id: "TASK-NEW-2", revision_no })));

  // 与现在的编号相同：什么都不改。
  assert.deepEqual(renumberTask(dir, "TASK-NEW-2"), { from: "TASK-NEW-2", to: "TASK-NEW-2", rows: 0 });
});

test("新编号的写法不对、库里没有任务、没有库文件、库比程序新：都拒绝，库原样不动", () => {
  const dir = workspaceWithRevisions("TASK-OLD-1");
  for (const bad of ["task-new", "TASK-", "TASK-带中文", "../TASK-X", ""]) assert.throws(() => renumberTask(dir, bad), /写法不对/);
  assert.deepEqual(rowsWith(dir, "TASK-OLD-1").task, 1);

  const empty = makeWorkspace();
  withTaskDatabase(empty, { createIfMissing: true }, () => null);
  assert.throws(() => renumberTask(empty, "TASK-NEW-2"), /库里没有任务/);

  const none = makeWorkspace();
  assert.throws(() => renumberTask(none, "TASK-NEW-2"), NoDatabaseYet);
  assert.equal(existsSync(databasePath(none)), false, "不为了拒绝而建一个空库");

  const raw = new DatabaseSync(databasePath(dir));
  raw.exec(`PRAGMA user_version = ${TASK_DB_VERSION + 1}`);
  raw.close();
  assert.throws(() => renumberTask(dir, "TASK-NEW-2"), NewerTaskDatabase);
  assert.deepEqual(rowsWith(dir, "TASK-OLD-1").task, 1);
});
