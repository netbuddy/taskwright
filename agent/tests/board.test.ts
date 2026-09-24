/**
 * 交付物看板（lib/board.ts）：对一个夹具库打印整个看板与一个条目的详情，逐行比对。
 * 夹具库经真实的核心函数建：建任务、保存两次修订、用户在界面上确认一个条目、再直接写一条评审记录
 * （「请求评审」工具尚未提供，这里照库表的形状写一行）。看板只读，最后核对库没有被改动。
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { boardCommandLines, boardLines, itemLines, parseBoardArgs } from "../src/lib/board.ts";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, makeWorkspace } from "./helpers.ts";

function fixture(): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH, task_name: "看板夹具" });
  saveRevision(callIn(dir), {
    operations: [
      { op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面", "输入口令"] }, sources: [{ ...SOURCE, supports: [{ field: "步骤", index: 1 }] }] },
      { op: "add", collection: "用例", fields: { 名称: "注销", 步骤: ["点注销"] }, sources: [SOURCE] },
      { op: "add", collection: "用例", fields: { 名称: "改口令", 步骤: ["输入旧口令"] }, sources: [SOURCE] },
      { op: "add", collection: "问题", fields: { 事项: "口令长度？", 状态: "未解决" }, sources: [SOURCE] },
    ],
  });
  runUserOperation({ workspaceDir: dir, sessionId: "s" }, { op_id: "ui-op-b1", kind: "mark_viewed", targets: [{ item_id: "UC-002", base_revision: 1 }] });
  saveRevision(callIn(dir), {
    operations: [
      { op: "update", item: "UC-001", base_revision: 1, fields: { 备注: "只支持口令" } },
      { op: "delete", item: "UC-003", base_revision: 1 },
    ],
  });
  const db = new DatabaseSync(databasePath(dir));
  db.prepare(
    "INSERT INTO review (task_id, item_id, revision_no, verdict, reason, rules_digest, reviewer_session_id, call_id, event_seq, created_at) " +
      "VALUES ('TASK-001', 'UC-002', 1, '合规', '齐全', 'x', 'r', 'c', 4, '2026-09-21T10:00:00.000')",
  ).run();
  db.close();
  return dir;
}

test("整个看板：条目的编号、标题、所在的修订、评审与确认，已删除的条目，完成条件逐项，事件表最后的序号", () => {
  const dir = fixture();
  const lines = boardLines(dir);
  const at = lines.pop()!;
  assert.match(at, /^事件表的最后一个序号是 4（REVISION_SAVED，发起方 executor，时刻 \d{4}-\d\d-\d\dT[\d:.]+）。$/);
  assert.deepEqual(lines, [
    "任务 TASK-001「看板夹具」（类型：演示任务），状态是进行中。",
    "",
    "用例（现有 2 个）",
    "  UC-001　登录　修订 2　评审：还没有评审记录　确认：未读（用户从没看过）",
    "  UC-002　注销　修订 1　评审：评审通过　确认：已确认，用户打开看过（已读）",
    "  已删除：UC-003（修订 2 删除）",
    "",
    "问题（现有 1 个）",
    "  TBD-001　口令长度？　修订 1　评审：还没有评审记录　确认：未读（用户从没看过）　状态：未解决",
    "",
    "要完成任务，还差 3 项：",
    "  [已满足] 用例：至少一个条目。现在有 2 个条目。",
    "  [还差] 用例：每个条目评审通过。有 1 个条目在当前所在的修订还没有评审通过的记录。它们是：UC-001。",
    "  [还差] 用例：每个条目用户确认。有 1 个条目用户还没看过这个条目（未读）。它们是：UC-001。",
    "  [还差] 问题：没有状态为未解决的条目。还有 1 个状态为未解决的条目。它们是：TBD-001。",
    "",
  ]);
});

test("条目详情：全部字段、来源支持的字段与第几项、改动过的修订；可以看截至某次修订的内容", () => {
  const dir = fixture();
  assert.deepEqual(itemLines(dir, "UC-001"), [
    "条目 UC-001（集合「用例」），修订 2，是最新内容。",
    "  评审：还没有评审记录　确认：未读（用户从没看过）",
    "  改动过的修订：修订 1（发起方 executor）、修订 2（发起方 executor）。",
    "",
    "字段：",
    "  名称（文本）：登录",
    "  步骤（文本列表）：",
    "    1. 打开页面",
    "    2. 输入口令",
    "  备注（文本）：只支持口令",
    "",
    "来源（1 条）：",
    "  1. 文档原文，出处 inputs/材料.md",
    "     摘录：「用户可以登录。」",
    "     支持：「步骤」第 2 项",
  ]);
  assert.equal(itemLines(dir, "UC-001", 1)[0], "条目 UC-001（集合「用例」），修订 1，最新内容在修订 2。");
  assert.equal(itemLines(dir, "UC-001", 1)[9], "  备注（文本）：（没有填）");
  assert.equal(itemLines(dir, "UC-003")[0], "条目 UC-003（集合「用例」），修订 1，是最新内容；这个条目已在修订 2 删除。");
  assert.deepEqual(itemLines(dir, "UC-009"), ["没有条目 UC-009。条目编号要写全，例如 UC-001。"]);
  assert.deepEqual(itemLines(dir, "UC-001", 5), ["这个任务还没有修订 5，最新是修订 2。"]);
});

test("已读是条目级、单向的：条目在后来的修订里改过之后仍是已读，看板写明用户最后看过哪次修订，门禁不再挡它", () => {
  const dir = fixture();
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-002", base_revision: 1, fields: { 备注: "改一下" } }] });
  const lines = boardLines(dir);
  assert.ok(lines.includes("  UC-002　注销　修订 3　评审：还没有评审记录　确认：已读（用户最后看过修订 1，之后又改过）"));
  assert.ok(lines.includes("  [还差] 用例：每个条目用户确认。有 1 个条目用户还没看过这个条目（未读）。它们是：UC-001。"));
});

test("参数解析与没有库时的说明；看板不改库", () => {
  assert.deepEqual(parseBoardArgs(""), {});
  assert.deepEqual(parseBoardArgs("uc-001"), { itemId: "UC-001", revisionNo: undefined });
  assert.deepEqual(parseBoardArgs("UC-001 修订2"), { itemId: "UC-001", revisionNo: 2 });
  assert.deepEqual(parseBoardArgs("UC-001 2"), { itemId: "UC-001", revisionNo: 2 });
  assert.equal(parseBoardArgs("UC-001 x"), null);
  assert.match(boardCommandLines(makeWorkspace(), "")[0], /还没有任务数据库/);
  const dir = fixture();
  const before = count(dir, "event");
  boardCommandLines(dir, "");
  boardCommandLines(dir, "UC-001");
  assert.equal(count(dir, "event"), before);
});
