/** 工具拒绝的留痕：被拒一次记一行（事实与指引分两层、被拒输入只留前 2000 个字符），通过的调用不记，不是输入问题的不记。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { GATE_CODES, INPUT_EXCERPT_LIMIT, ToolRejection, notInputProblem, reasonKindOf, recordRejection, rejectionOf } from "../src/lib/tool_rejection.ts";
import { ReviewError } from "../src/lib/review.ts";
import { archiveRefusal } from "../src/lib/publish_version.ts";
import { getItem } from "../src/lib/task_query.ts";
import { searchParams } from "../src/lib/knowledge_search.ts";
import { templates } from "../src/lib/texts.ts";
import { decideReply, openRevisionLookup } from "../src/lib/reply.ts";
import { preparePublish } from "../src/lib/publish_version.ts";
import { checkReviewParams, prepareReviews } from "../src/lib/review.ts";
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
  return withRejectionRecord({ workspaceDir: dir, sessionId: SESSION, callId, toolName: "publish_version" }, {}, () =>
    preparePublish({ workspaceDir: dir, sessionId: SESSION, callId }));
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
  assert.match(row.guidance, /^请按平台说明「先写理解」一节的格式.*写完接着调用 save_revision。$/);
});

test("回复、发布版本、请求评审被拒各记一行", async () => {
  const dir = workspaceWithTask();
  await assert.rejects(replyTool(dir, "call-reply", { informs: [], act: null }), /这次回复的形式不对/);
  await assert.rejects(completeTool(dir, "call-complete"), /第 1 版没有发布/);
  await assert.rejects(reviewTool(dir, "call-review", { items: [] }, { provider: "p", id: "m" }), /什么都没有评/);
  const rows = rejections(dir);
  assert.deepEqual(rows.map((r) => [r.tool_name, r.call_id]),
    [["reply", "call-reply"], ["publish_version", "call-complete"], ["request_review", "call-review"]]);
  assert.match(rows[0].fact, /^这次回复的形式不对，没有送达：\n1\. 缺少 text/);
  assert.equal(rows[0].guidance, "请按这几处改好后重新单独调用 reply");
  assert.match(rows[1].fact, /^第 1 版没有发布。/);
  assert.match(rows[1].guidance, /补齐之后再调用「发布版本」。$/);
  assert.equal(rows[2].guidance, null);
});

test("不是输入问题的拒绝不记：没有可用的模型、库被锁之类的系统错误", async () => {
  const dir = workspaceWithTask();
  await assert.rejects(reviewTool(dir, "call-nomodel", {}, undefined), /现在没有可用的模型/);
  assert.equal(count(dir, "tool_rejection"), 0);
  assert.equal(rejectionOf(notInputProblem(new ReviewError("上一批评审还没有做完"))), null);
  assert.equal(rejectionOf(Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" })), null);
  assert.deepEqual(rejectionOf(new Error("一段话")), { fact: "一段话", guidance: "", codes: [], reasonKind: "input" });
});

test("任务目录里还没有库时不记，也不建库", () => {
  const dir = makeWorkspace();
  const id = recordRejection({ workspaceDir: dir, sessionId: SESSION, callId: "c", toolName: "save_revision" }, new Error("x"), {});
  assert.equal(id, null);
  assert.throws(() => saveRevision(callIn(dir), { operations: [] }), /还没有任务记录/);
});


test("原因码写进库：reason_code 是第一个，reason_codes 是全部（JSON 数组）；第一个原因码是守门类的记作 gate，别的记作 input", () => {
  const dir = workspaceWithTask();
  const call = (callId: string) => ({ workspaceDir: dir, sessionId: SESSION, callId, toolName: "request_review" });
  recordRejection(call("c-1"), new ReviewError("什么都没有评，因为：库里没有条目 UC-009；条目 UC-001 已经删除了。", ["request_review.item_not_found", "request_review.item_deleted"]), {});
  recordRejection(call("c-2"), new ToolRejection("什么都没有评：……", "事实", "指引", ["gate.stage_review"]), {});
  recordRejection(call("c-3"), new Error("一段话"), {});
  assert.deepEqual(rejections(dir).map((one) => [one.call_id, one.reason_code, one.reason_codes, one.reason_kind]), [
    ["c-1", "request_review.item_not_found", JSON.stringify(["request_review.item_not_found", "request_review.item_deleted"]), "input"],
    ["c-2", "gate.stage_review", JSON.stringify(["gate.stage_review"]), "gate"],
    ["c-3", null, null, "input"],
  ]);
  // 守门类十八种：共用的守门十四种，加发布版本的完成条件与用户同意四种；每一种都有拒绝语模板。
  assert.equal(GATE_CODES.size, 18);
  for (const code of GATE_CODES) assert.ok([...templates().keys()].some((key) => key === code || key.startsWith(`${code}.`)), code);
  assert.deepEqual([reasonKindOf(["publish_version.consent_none", "x.y"]), reasonKindOf(["x.y", "gate.stage_review"]), reasonKindOf([])], ["gate", "input", "input"]);
});

test("查看条目、查找知识库的拒绝带原因码；存档没有做成不是输入的问题，不记", () => {
  const dir = workspaceWithTask();
  const codeOf = (fn: () => unknown) => { try { fn(); } catch (error) { return rejectionOf(error)?.codes ?? "not recorded"; } return "passed"; };
  assert.deepEqual(codeOf(() => getItem(dir, {})), ["get_item.item_id_missing"]);
  assert.deepEqual(codeOf(() => getItem(dir, { item_id: "UC-009" })), ["get_item.item_not_found"]);
  assert.deepEqual(codeOf(() => getItem(dir, { item_id: "D-009" })), ["get_item.diagram_not_found"]);
  assert.deepEqual(codeOf(() => getItem(dir, { item_id: "UC-001", revision_no: 0 })), ["get_item.revision_no_invalid"]);
  assert.deepEqual(codeOf(() => getItem(makeWorkspace(), { item_id: "UC-001" })), "not recorded", "没有任务记录不是输入的问题");
  assert.deepEqual(codeOf(() => searchParams({ query: "  " })), ["search_knowledge.query_empty"]);
  assert.deepEqual(codeOf(() => searchParams({ query: "罚款", limit: 99 })), ["search_knowledge.limit_invalid"]);
  assert.equal(rejectionOf(archiveRefusal(1, "联系不上任务服务")), null);
  assert.deepEqual(archiveRefusal(1, "联系不上任务服务").codes, ["publish_version.archive_failed"]);
});

test("发布与评审被拒时记下的原因码：完成条件没满足是守门类；评审点名的几个条目各有原因，按出现的先后都记下", async () => {
  const dir = workspaceWithTask();
  await assert.rejects(() => completeTool(dir, "c-publish"));
  await assert.rejects(() => withRejectionRecord({ workspaceDir: dir, sessionId: SESSION, callId: "c-review", toolName: "request_review" }, {},
    () => prepareReviews(dir, [{ item_id: "UC-009", revision_no: 1 }, { item_id: "UC-008", revision_no: 1 }], "executor", SESSION)));
  assert.deepEqual(rejections(dir).map((one) => [one.call_id, one.reason_code, one.reason_codes, one.reason_kind]), [
    ["c-publish", "publish_version.completion_unmet", JSON.stringify(["publish_version.completion_unmet"]), "gate"],
    ["c-review", "request_review.item_not_found", JSON.stringify(["request_review.item_not_found", "request_review.item_not_found"]), "input"],
  ]);
});
