/** 工具拒绝的留痕：被拒一次记一行（事实与指引分两层、被拒输入只留前 2000 个字符），通过的调用不记，不是输入问题的不记。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { withTaskDatabase } from "../src/lib/schema.ts";
import { INPUT_EXCERPT_LIMIT, notInputProblem, recordRejection, rejectionOf } from "../src/lib/tool_rejection.ts";
import { ReviewError } from "../src/lib/review.ts";
import { decideReply, openRevisionLookup } from "../src/lib/reply.ts";
import { completeTask } from "../src/lib/complete_task.ts";
import { checkReviewParams } from "../src/lib/review.ts";
import { piComplete } from "../src/lib/review_ui.ts";
import { requireUnderstanding } from "../src/lib/dialogue_acts.ts";
import { withRejectionRecord } from "../src/lib/tool_rejection.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, makeWorkspace, query } from "./helpers.ts";

const SESSION = "session-test";

function workspaceWithTask(): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}

/**
 * 仿照四个工具登记处（agent/src/tools/）的写法调用核心函数：外面包 withRejectionRecord，里面先过理解门禁。
 * 登记处本身要 pi 带的 typebox 才加载得起来，接线由后端的集成测试（真 pi 进程）覆盖。
 */
function saveTool(dir: string, callId: string, params: unknown, branch: unknown[] = [], workId: string | null = null) {
  return withRejectionRecord({ workspaceDir: dir, sessionId: SESSION, callId, toolName: "save_revision", workId }, params, () => {
    requireUnderstanding(dir, SESSION, branch as never, "保存修订", "save_revision");
    return saveRevision({ workspaceDir: dir, sessionId: SESSION, callId }, params as never);
  });
}
function replyTool(dir: string, callId: string, params: unknown) {
  return withRejectionRecord({ workspaceDir: dir, sessionId: SESSION, callId, toolName: "reply" }, params, () => {
    const lookup = openRevisionLookup(dir);
    try {
      return decideReply(params, { toolCallId: callId, callsThisTurn: [], revisionFact: lookup.revisionFact, currentRevisionOf: lookup.currentRevisionOf });
    } finally {
      lookup.close();
    }
  });
}
function completeTool(dir: string, callId: string) {
  return withRejectionRecord({ workspaceDir: dir, sessionId: SESSION, callId, toolName: "complete_task" }, {}, () =>
    completeTask({ workspaceDir: dir, sessionId: SESSION, callId }));
}
function reviewTool(dir: string, callId: string, params: unknown, model: unknown) {
  return withRejectionRecord({ workspaceDir: dir, sessionId: SESSION, callId, toolName: "request_review" }, params, () => {
    checkReviewParams(params);
    piComplete({ model, modelRegistry: {} } as never, callId);
  });
}

const rejections = (dir: string) => query<any>(dir, "SELECT * FROM tool_rejection ORDER BY rejection_id");

test("保存修订被拒一次写一行：工具名、调用编号、事实与指引两层、被拒输入；拒绝文字照样交还模型", async () => {
  const dir = workspaceWithTask();
  const params = { operations: [{ op: "add", collection: "没有这个集合", fields: {}, sources: [SOURCE] }] };
  await assert.rejects(saveTool(dir, "call-bad-1", params), /这次「保存修订」什么都没有写入/);
  const [row] = rejections(dir);
  assert.equal(row.tool_name, "save_revision");
  assert.equal(row.call_id, "call-bad-1");
  assert.equal(row.session_id, SESSION);
  assert.equal(row.task_id, "TASK-001");
  assert.equal(row.work_id, null);
  assert.equal(row.reason_kind, "input");
  assert.equal(row.fact, "操作 1（新增，集合「没有这个集合」）：没有名叫「没有这个集合」的集合");
  assert.equal(row.guidance, "操作 1（新增，集合「没有这个集合」）：可用的集合是：「用例」、「问题」");
  assert.deepEqual(JSON.parse(row.input_excerpt), params);
  assert.equal(count(dir, "revision"), 0);
});

test("通过的调用不写拒绝记录", async () => {
  const dir = workspaceWithTask();
  const outcome = await saveTool(dir, "call-ok-1", {
    operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [SOURCE] }],
  });
  assert.match(outcome.text, /已保存为任务 TASK-001 的修订 1/);
  assert.equal(count(dir, "tool_rejection"), 0);
});

test("被拒输入只留前 2000 个字符", async () => {
  const dir = workspaceWithTask();
  const long = "长".repeat(5000);
  await assert.rejects(saveTool(dir, "call-long", { operations: [{ op: "add", collection: "用例", fields: { 名称: long } }] }));
  const [row] = rejections(dir);
  assert.equal(row.input_excerpt.length, INPUT_EXCERPT_LIMIT);
});

test("缺前置步骤（这一轮还没写理解）的拒绝记 gate，工作编号取引出这次运行的那句用户的话", async () => {
  const dir = workspaceWithTask();
  const branch = [{ id: "u-7", type: "message", message: { role: "user", content: [{ type: "text", text: "整理一下" }] } }];
  await assert.rejects(saveTool(dir, "call-gate", { operations: [] }, branch, "w-u-7"), /这一轮还没有写理解/);
  const [row] = rejections(dir);
  assert.equal(row.reason_kind, "gate");
  assert.equal(row.work_id, "w-u-7");
  assert.match(row.fact, /^保存修订没有执行：.*这一轮还没有写理解。$/);
  assert.match(row.guidance, /^请按平台 skill「先写理解」一节的格式.*写完接着调用 save_revision。$/);
});

test("回复、完成任务、请求评审被拒各记一行", async () => {
  const dir = workspaceWithTask();
  await assert.rejects(replyTool(dir, "call-reply", { informs: [], act: null }), /这次回复的形式不对/);
  await assert.rejects(completeTool(dir, "call-complete"), /任务没有标为已完成/);
  await assert.rejects(reviewTool(dir, "call-review", { items: [] }, { provider: "p", id: "m" }), /什么都没有评/);
  const rows = rejections(dir);
  assert.deepEqual(rows.map((r) => [r.tool_name, r.call_id]),
    [["reply", "call-reply"], ["complete_task", "call-complete"], ["request_review", "call-review"]]);
  assert.match(rows[0].fact, /^这次回复的形式不对，没有送达：\n1\. 缺少 text/);
  assert.equal(rows[0].guidance, "请按这几处改好后重新单独调用 reply");
  assert.match(rows[1].fact, /^任务没有标为已完成。/);
  assert.match(rows[1].guidance, /补齐之后再调用「完成任务」。$/);
  assert.equal(rows[2].guidance, null);
});

test("不是输入问题的拒绝不记：没有可用的模型、库被锁之类的系统错误", async () => {
  const dir = workspaceWithTask();
  await assert.rejects(reviewTool(dir, "call-nomodel", {}, undefined), /现在没有可用的模型/);
  assert.equal(count(dir, "tool_rejection"), 0);
  assert.equal(rejectionOf(notInputProblem(new ReviewError("上一批评审还没有做完"))), null);
  assert.equal(rejectionOf(Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" })), null);
  assert.deepEqual(rejectionOf(new Error("一段话")), { fact: "一段话", guidance: "", reasonKind: "input" });
});

test("任务目录里还没有库时不记，也不建库", () => {
  const dir = makeWorkspace();
  const id = recordRejection({ workspaceDir: dir, sessionId: SESSION, callId: "c", toolName: "save_revision" }, new Error("x"), {});
  assert.equal(id, null);
  assert.throws(() => saveRevision(callIn(dir), { operations: [] }), /还没有任务记录/);
});

test("旧库没有工具拒绝表：第一次被写入一侧打开时补上，之后能记", () => {
  const dir = workspaceWithTask();
  withTaskDatabase(dir, { createIfMissing: false }, (db) => db.exec("DROP TABLE tool_rejection"));
  const id = recordRejection({ workspaceDir: dir, sessionId: SESSION, callId: "c-old", toolName: "reply" }, new Error("不对"), { a: 1 });
  assert.equal(id, 1);
  assert.equal(rejections(dir)[0].fact, "不对");
});
