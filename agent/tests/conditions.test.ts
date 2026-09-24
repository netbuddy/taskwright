/** 完成条件的核对函数、三种状态（已满足、还差、暂无条目）与概括句。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CONDITIONS, checkCompletion, completionBrief } from "../src/lib/conditions.ts";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { DEFINITION_PATH, SOURCE, callIn, makeWorkspace } from "./helpers.ts";

function withDb<T>(dir: string, body: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    return body(db);
  } finally {
    db.close();
  }
}

test("「至少一个条目」：没有条目时不满足，有了就满足，删光又不满足", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const check = () => withDb(dir, (db) => CONDITIONS["至少一个条目"](db, "TASK-001", "用例"));
  assert.equal(check().satisfied, false);
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "甲", 步骤: ["一"] }, sources: [SOURCE] }] });
  assert.equal(check().satisfied, true);
  saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-001", base_version: 1 }] });
  assert.equal(check().satisfied, false);
});

test("「没有状态为未解决的条目」只看每个条目的当前版本", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const check = () => withDb(dir, (db) => CONDITIONS["没有状态为未解决的条目"](db, "TASK-001", "待定事项"));
  assert.equal(check().satisfied, true);
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "待定事项", fields: { 事项: "问", 状态: "未解决" }, sources: [SOURCE] }] });
  const unmet = check();
  assert.equal(unmet.satisfied, false);
  assert.deepEqual(unmet.unmet.map((u) => u.item), ["TBD-001"]);
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "TBD-001", base_version: 1, fields: { 状态: "已解决" } }] });
  assert.equal(check().satisfied, true);
});

test("评审表与判读表为空时，有条目的集合在两个条件上都不满足", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "甲", 步骤: ["一"] }, sources: [SOURCE] }] });
  const results = withDb(dir, (db) =>
    checkCompletion(db, "TASK-001", { 用例: ["至少一个条目", "每个条目评审通过", "每个条目用户确认"] }),
  );
  assert.deepEqual(results.map((r) => r.satisfied), [true, false, false]);
  assert.match(results[1].unmet[0].reason, /UC-001 的当前版本第 1 版还没有评审通过的记录/);
  // 说明只讲事实，不带集合名：集合名由调用方（看板的分组标题、工具的拒绝理由）自己带。
  assert.deepEqual(results.map((r) => r.summary), [
    "现在有 1 个条目。",
    "有 1 个条目的当前版本还没有评审通过的记录。",
    "有 1 个条目的当前版本还没有用户接受的记录。",
  ]);
  assert.ok(results.every((r) => !r.summary.includes("用例") && r.unmet.every((u) => !u.reason.includes("集合"))));
});

// ───────────── 三种状态与概括句：空集合不算「已满足」，门禁照旧放行 ─────────────


const COMPLETION = { 用例: ["至少一个条目", "每个条目评审通过", "每个条目用户确认"], 待定事项: ["没有状态为未解决的条目"] };

test("空交付物：「至少一个条目」是还差，其余是暂无条目；门禁上暂无条目仍算满足；概括句只说还差什么", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const results = withDb(dir, (db) => checkCompletion(db, "TASK-001", COMPLETION));
  assert.deepEqual(results.map((r) => [r.collection, r.condition, r.state, r.satisfied]), [
    ["用例", "至少一个条目", "unmet", false],
    ["用例", "每个条目评审通过", "empty", true],
    ["用例", "每个条目用户确认", "empty", true],
    ["待定事项", "没有状态为未解决的条目", "empty", true],
  ]);
  assert.equal(results[1].summary, "这个集合现在没有条目，这一条暂不需要核对。");
  assert.equal(completionBrief(results), "要完成任务，还差 1 项：用例至少要有一个条目。");
});

test("有条目的集合按事实判，空集合写暂无条目并在概括句里另起一句说明", () => {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["一步"] }, sources: [SOURCE] }] });
  const results = withDb(dir, (db) => checkCompletion(db, "TASK-001", COMPLETION));
  assert.deepEqual(results.map((r) => r.state), ["met", "unmet", "unmet", "empty"]);
  assert.equal(completionBrief(results),
    "要完成任务，还差 2 项：用例每个条目评审通过（还差 UC-001）；用例每个条目用户确认（还差 UC-001）。" +
    "待定事项现在没有条目，这几个集合的条件暂不需要核对。");
});

test("都满足时概括句写可以完成任务；还差的条目多于上限时只写个数", () => {
  const met = [{ condition: "至少一个条目", collection: "用例", satisfied: true, state: "met" as const, summary: "", unmet: [] }];
  assert.equal(completionBrief(met), "完成条件都已满足，可以完成任务。");
  const many = [{ condition: "每个条目用户确认", collection: "用例", satisfied: false, state: "unmet" as const, summary: "",
    unmet: Array.from({ length: 7 }, (_, i) => ({ item: `UC-00${i + 1}`, reason: "" })) }];
  assert.equal(completionBrief(many), "要完成任务，还差 1 项：用例每个条目用户确认（还差 7 个）。");
});
