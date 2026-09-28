// 贯穿测试：同一修订上先评审合规、后来强制重评成不合规（只评一次之前留下的数据）。
// 九处（助手一侧的完成条件、保留操作、查询任务状态的发现、看板与查看条目，后端生成文档，页面的状态标签、条目详情的发现与保留、
// 评审页签的角标与发现状态）给出同一个结论：不通过；保留这种写法点得成，之后各处都说已保留。
// 页面的几处用 web/src/model/items.ts 的函数，交给它的是后端给页面的那份任务数据。

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { parseReview, prepareReviews, writeReview } from "../src/lib/review.ts";
import { runReviews } from "../src/lib/review_run.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { getItem, getTaskStatus } from "../src/lib/task_query.ts";
import { boardLines } from "../src/lib/board.ts";
import { databasePath } from "../src/lib/db.ts";
import * as library from "../../backend/src/library.ts";
import * as render from "../../backend/src/render.ts";
import { findingStatus, itemVerdict, openProblems, reviewState } from "../../web/src/model/items.ts";
import type { Task } from "../../web/src/api/types.ts";
import { DEFINITION_PATH, SOURCE, callIn, demoDefinition, makeWorkspace, query } from "./helpers.ts";

const FAIL = JSON.stringify({ 发现: [{ 规则: "D-R1", 字段: "步骤", 序号: 2, 问题: "第 2 步没有主语。", 建议: "写明是系统校验。" }] });
const PASS = JSON.stringify({ 发现: [] });

function workspace(): string {
  const definition = demoDefinition() as any;
  definition.交付物.条目集合[0].评审规矩 = { 规则文件: "docs/review-rules/demo.json" };
  const dir = makeWorkspace(definition);
  mkdirSync(join(dir, "docs/review-rules"), { recursive: true });
  writeFileSync(join(dir, "docs/review-rules/demo.json"),
    JSON.stringify([{ 编号: "D-R1", 级别: "必选", 条文: "步骤写明谁做了什么。", 反例: "校验。", 正例: "系统校验口令。" }]), "utf-8");
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["用户输入口令", "校验"] }, sources: [SOURCE] }] });
  return dir;
}

/** 九处对 UC-001 的说法。 */
function nine(dir: string) {
  const status = getTaskStatus(dir).text;
  const [, snapshot] = library.taskSnapshot(dir);
  const task = snapshot as unknown as Task;
  const item = task.items.find((i) => i.item_id === "UC-001")!;
  const verdict = itemVerdict(item, task);
  const web = reviewState(item, task);
  return {
    condition: status.split("\n").find((l) => l.includes("每个条目评审通过"))!,
    findings: status,
    board: boardLines(dir).find((l) => l.includes("UC-001"))!.split("评审：")[1].split("　")[0],
    item: (getItem(dir, { item_id: "UC-001" }).details as { review: string }).review,
    document: render.reviewState(library.libraryOf(dir), "UC-001", 1),
    badge: web.state === "failed" ? (web.kept ? "不通过，已保留" : "不通过") : web.state,
    detail: { findings: (verdict.basis?.findings ?? []).map((f) => f.problem), keepable: verdict.state === "failed" },
    panel: { open: openProblems(task), status: verdict.basis ? findingStatus(item, verdict.basis, task).kind : null },
  };
}

test("先合规、强制重评成不合规：九处都说不通过；保留点得成，之后九处都说已保留", async () => {
  const dir = workspace();
  const prepared = prepareReviews(dir, null);
  await runReviews({ ...callIn(dir), callId: "ui-op-first", actor: "user" }, null,
    { complete: async () => ({ text: PASS, inputTokens: 1, outputTokens: 1 }), model: "假" });
  // 只评一次之前「仍要重评」写下的那一条：用写评审记录的函数直接写，记作强制重评
  const item = prepared.items[0];
  const written = writeReview({ ...callIn(dir), callId: "ui-op-again", actor: "user" }, prepared.taskId, item, parseReview(FAIL, item), []) as { review_id: number };
  const db = new DatabaseSync(databasePath(dir));
  db.prepare("UPDATE review SET forced = 1 WHERE review_id = ?").run(written.review_id);
  db.close();
  assert.deepEqual(query(dir, "SELECT verdict, forced FROM review ORDER BY event_seq").map((r) => [r.verdict, r.forced]), [["合规", 0], ["不合规", 1]]);

  const before = nine(dir);
  assert.match(before.condition, /UC-001 评审不合规/);
  assert.match(before.findings, /评审不通过、还没处理的条目与发现[^]*UC-001（修订 1）：\n    1\. 【问题 D-R1】步骤第 2 项：第 2 步没有主语。/);
  assert.deepEqual([before.board, before.item, before.document, before.badge], ["评审没有通过", "评审没有通过", "评审不通过", "不通过"]);
  assert.deepEqual(before.detail, { findings: ["第 2 步没有主语。"], keepable: true });
  assert.deepEqual(before.panel, { open: 1, status: "open" });

  runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" },
    { op_id: "ui-op-keep", kind: "waive_review", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { reason: "材料原话如此", source: "detail" } });
  const after = nine(dir);
  assert.match(after.condition, /UC-001 评审不合规但你保留了/);
  assert.match(after.findings, /评审不通过、还没处理的条目：没有。/);
  assert.match(after.findings, /用户保留了写法的条目[^\n]*UC-001（修订 1，理由：材料原话如此）/);
  assert.deepEqual([after.board, after.item, after.document, after.badge],
    ["评审没有通过，用户保留了写法", "评审没有通过，用户保留了写法", "评审不通过，用户保留（理由：材料原话如此）", "不通过，已保留"]);
  assert.deepEqual(after.detail, { findings: ["第 2 步没有主语。"], keepable: false });
  assert.deepEqual(after.panel, { open: 0, status: "kept" });
});
