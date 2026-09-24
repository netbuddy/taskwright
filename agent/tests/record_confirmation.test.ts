/**
 * 「登记用户确认」的核心逻辑与「完成任务」。判读者的输出用固定文字扮演（接受、部分接受、不接受、坏 JSON 四种），
 * 核对准备、解析、写库三步；工具里真正调模型、重试一次的那一段由集成测试用假模型端点覆盖。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import {
  ConfirmationError,
  type BranchEntry,
  type ModelCallRecord,
  checkParams,
  parseJudgement,
  prepareJudgement,
  writeFailedModelCalls,
  writeJudgement,
} from "../src/lib/record_confirmation.ts";
import { completeTask } from "../src/lib/complete_task.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, makeWorkspace, query } from "./helpers.ts";

/** node:sqlite 返回的行没有原型，逐项比较之前摊成普通对象。 */
const rows = (dir: string, sql: string) => query(dir, sql).map((r) => ({ ...r }));

const SESSION = "session-test";

/** 建一个任务并存两个用例，返回任务目录与存用例那次调用的编号。 */
function setup() {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const save = callIn(dir);
  saveRevision({ ...save, userMessages: [] }, {
    operations: [
      { op: "add", collection: "用例", fields: { 名称: "买家申请退款", 步骤: ["提交申请"] }, sources: [SOURCE] },
      { op: "add", collection: "用例", fields: { 名称: "卖家审核退款", 步骤: ["查看申请", "同意"] }, sources: [SOURCE] },
    ],
  });
  return { dir, saveCall: save.callId };
}

const user = (id: string, text: string): BranchEntry => ({ id, type: "message", message: { role: "user", content: text } });
const assistantCall = (id: string, callId: string): BranchEntry => ({
  id, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "save_revision" }] },
});

/** 分支：用户先说一句（在保存之前），助手保存，然后用户说了几句，中间夹一句兜底扩展追加的话。 */
function branchAfter(saveCall: string, ...words: [string, string][]): BranchEntry[] {
  return [
    user("u0", "帮我整理退款的用例。"),
    assistantCall("a1", saveCall),
    user("fb", "请用 reply 工具把要对用户说的话发出来"),
    ...words.map(([id, text]) => user(id, text)),
  ];
}

const items = [{ item_id: "UC-001", version_no: 1 }, { item_id: "UC-002", version_no: 1 }];
const judge = (list: unknown[]) => JSON.stringify({ 判读: list });
const accept = (id: string, message: string, excerpt: string) => ({ 条目: id, 版本: 1, 态度: "接受", 依据: [{ 消息: message, 摘录: excerpt }], 说明: "用户说可以" });
const reject = (id: string) => ({ 条目: id, 版本: 1, 态度: "不接受", 依据: [], 说明: "用户没表态" });
const modelCall = (output: string, outcome: ModelCallRecord["outcome"] = "采用"): ModelCallRecord =>
  ({ prompt: "{}", output, outcome, model: "fake/fake-model", durationMs: 12, inputTokens: 100, outputTokens: 20 });

test("准备：只取这一版之后的用户原话，兜底扩展追加的那句不算；提示里带条目内容与原话编号", () => {
  const { dir, saveCall } = setup();
  const prepared = prepareJudgement(dir, items, branchAfter(saveCall, ["u1", "这两条都可以。"]));
  assert.deepEqual(prepared.messages, [{ id: "u1", text: "这两条都可以。" }]);
  assert.deepEqual(prepared.items.map((i) => i.after), [["u1"], ["u1"]]);
  assert.match(prepared.user, /UC-001 第 1 版（集合「用例」），内容：.*买家申请退款/);
  assert.match(prepared.user, /编号 u1（在 UC-001、UC-002 的这一版产生之后说的）：这两条都可以。/);
  assert.match(prepared.system, /你是确认判读者/);
});

test("准备的拒绝：版本不是当前版本、条目不存在、这一版之后用户没说过话、参数不对", () => {
  const { dir, saveCall } = setup();
  assert.throws(() => prepareJudgement(dir, [{ item_id: "UC-001", version_no: 2 }], branchAfter(saveCall, ["u1", "可以"])),
    /UC-001 现在是第 1 版，你写的是第 2 版；只能登记当前版本/);
  assert.throws(() => prepareJudgement(dir, [{ item_id: "UC-009", version_no: 1 }], branchAfter(saveCall, ["u1", "可以"])), /库里没有条目 UC-009/);
  assert.throws(() => prepareJudgement(dir, items, branchAfter(saveCall)), /产生之后，用户在这条会话里还没有说过话，无从判读/);
  assert.throws(() => checkParams({ items: [] }), /缺少 items/);
  assert.throws(() => checkParams({ items: [{ item_id: "UC-001" }] }), /要写 version_no/);
});

test("判读者判为都接受：写判读、两条明细、模型调用与事件，依据是会话条目编号加摘录", () => {
  const { dir, saveCall } = setup();
  const prepared = prepareJudgement(dir, items, branchAfter(saveCall, ["u1", "这两条都可以，就这样。"]));
  const output = judge([accept("UC-001", "u1", "这两条都可以"), accept("UC-002", "u1", "这两条都可以")]);
  const verdicts = parseJudgement(output, prepared);
  const outcome = writeJudgement({ workspaceDir: dir, sessionId: SESSION, callId: "call-rc" }, prepared, verdicts, [modelCall(output)]);
  assert.ok(!("changed" in outcome));
  assert.deepEqual(outcome.details.accepted, items);
  assert.match(outcome.text, /判读者判定用户接受了：UC-001 第 1 版（依据：「这两条都可以」）/);
  assert.deepEqual(rows(dir, "SELECT item_id, version_no, attitude FROM judgement_item ORDER BY item_id"),
    [{ item_id: "UC-001", version_no: 1, attitude: "接受" }, { item_id: "UC-002", version_no: 1, attitude: "接受" }]);
  const [j] = query<{ judgement_id: number; basis: string; call_id: string }>(dir, "SELECT judgement_id, basis, call_id FROM judgement");
  assert.equal(j.call_id, "call-rc");
  assert.deepEqual(JSON.parse(j.basis)[0], { 条目: "UC-001", 会话条目: `${SESSION}#u1`, 摘录: "这两条都可以" });
  assert.deepEqual(rows(dir, "SELECT role, judgement_id, outcome, model, duration_ms, input_tokens FROM model_call"),
    [{ role: "判读者", judgement_id: j.judgement_id, outcome: "采用", model: "fake/fake-model", duration_ms: 12, input_tokens: 100 }]);
  const [e] = query<{ name: string; payload: string; actor: string }>(dir, "SELECT name, payload, actor FROM event WHERE call_id = 'call-rc'");
  assert.equal(e.name, "CONFIRMATION_RECORDED");
  assert.equal(e.actor, "executor");
  assert.equal(JSON.parse(e.payload).basis, "user_words");
});

test("部分接受与都不接受：没接受的记「不接受」，返回里分开列", () => {
  const { dir, saveCall } = setup();
  const prepared = prepareJudgement(dir, items, branchAfter(saveCall, ["u1", "第一条可以。"], ["u2", "第二条我还要想想。"]));
  const partial = parseJudgement(judge([accept("UC-001", "u1", "第一条可以"), reject("UC-002")]), prepared);
  const outcome = writeJudgement({ workspaceDir: dir, sessionId: SESSION, callId: "call-p" }, prepared, partial, [modelCall("x")]);
  assert.ok(!("changed" in outcome));
  assert.deepEqual(outcome.details.not_accepted, [{ item_id: "UC-002", version_no: 1 }]);
  assert.match(outcome.text, /没有判为接受的：UC-002 第 1 版（用户没表态）/);
  const none = parseJudgement(judge([reject("UC-001"), reject("UC-002")]), prepared);
  const second = writeJudgement({ workspaceDir: dir, sessionId: SESSION, callId: "call-n" }, prepared, none, [modelCall("y")]);
  assert.ok(!("changed" in second));
  assert.match(second.text, /判读者判定用户没有接受任何一条/);
  assert.equal(count(dir, "judgement"), 2);
});

test("判读者的输出不合格时拒绝：坏 JSON、漏条目、摘录不是原话、引用了这一版之前的话", () => {
  const { dir, saveCall } = setup();
  const prepared = prepareJudgement(dir, items, branchAfter(saveCall, ["u1", "都可以。"]));
  assert.throws(() => parseJudgement("好的，我判读如下：都接受", prepared), ConfirmationError);
  assert.throws(() => parseJudgement("{判读: 坏的}", prepared), /不是合法的 JSON/);
  assert.throws(() => parseJudgement(judge([accept("UC-001", "u1", "都可以")]), prepared), /漏了 UC-002/);
  assert.throws(() => parseJudgement(judge([accept("UC-001", "u1", "完全同意"), reject("UC-002")]), prepared), /没有逐字出现在消息 u1 里/);
  assert.throws(() => parseJudgement(judge([accept("UC-001", "u0", "帮我整理"), reject("UC-002")]), prepared), /不是这一版之后的用户原话/);
  // 代码块包着的 JSON 仍然取得出来。
  const fenced = "```json\n" + judge([accept("UC-001", "u1", "都可以"), reject("UC-002")]) + "\n```";
  assert.equal(parseJudgement(fenced, prepared).length, 2);
});

test("被拒之前的模型调用也记下来，关联判读为空；判读期间条目被改了就不写判读", () => {
  const { dir, saveCall } = setup();
  const prepared = prepareJudgement(dir, items, branchAfter(saveCall, ["u1", "都可以。"]));
  writeFailedModelCalls({ workspaceDir: dir, sessionId: SESSION, callId: "call-bad" }, prepared.taskId, [modelCall("坏", "输出不合格")]);
  assert.deepEqual(rows(dir, "SELECT judgement_id, outcome FROM model_call"), [{ judgement_id: null, outcome: "输出不合格" }]);
  saveRevision({ ...callIn(dir), userMessages: [] }, { operations: [{ op: "update", item: "UC-001", base_version: 1, fields: { 名称: "买家申请全额退款" } }] });
  const verdicts = parseJudgement(judge([accept("UC-001", "u1", "都可以"), accept("UC-002", "u1", "都可以")]), prepared);
  const outcome = writeJudgement({ workspaceDir: dir, sessionId: SESSION, callId: "call-late" }, prepared, verdicts, [modelCall("z")]);
  assert.ok("changed" in outcome);
  assert.deepEqual(outcome.changed, ["UC-001 在判读期间被改到了第 2 版"]);
  assert.equal(count(dir, "judgement"), 0);
  assert.equal(count(dir, "model_call"), 2);
});

test("完成任务：条件没满足时逐条拒绝；开发期开关只放过「每个条目评审通过」；满足后任务变为已完成并记事件", () => {
  const { dir, saveCall } = setup();
  assert.throws(() => completeTask({ workspaceDir: dir, sessionId: SESSION, callId: "c1" }), (error: Error) => {
    assert.match(error.message, /完成条件还有 \d+ 条没有满足/);
    assert.match(error.message, /「用例」每个条目评审通过/);
    assert.match(error.message, /「用例」每个条目用户确认/);
    return true;
  });
  // 用户在对话里确认了两个用例；待定事项集合没有条目，「没有状态为未解决的条目」本来就满足。
  const prepared = prepareJudgement(dir, items, branchAfter(saveCall, ["u1", "都可以。"]));
  writeJudgement({ workspaceDir: dir, sessionId: SESSION, callId: "call-rc" }, prepared,
    parseJudgement(judge([accept("UC-001", "u1", "都可以"), accept("UC-002", "u1", "都可以")]), prepared), [modelCall("ok")]);
  assert.throws(() => completeTask({ workspaceDir: dir, sessionId: SESSION, callId: "c2" }), /每个条目评审通过/);
  const outcome = completeTask({ workspaceDir: dir, sessionId: SESSION, callId: "c3", treatReviewAsMet: true });
  assert.equal(outcome.details.status, "已完成");
  assert.deepEqual(outcome.details.waived, ["「用例」每个条目评审通过"]);
  assert.match(outcome.text, /开发期开关让它视为满足的/);
  assert.deepEqual(rows(dir, "SELECT status FROM task"), [{ status: "已完成" }]);
  const [e] = query<{ name: string; payload: string }>(dir, "SELECT name, payload FROM event WHERE call_id = 'c3'");
  assert.equal(e.name, "TASK_COMPLETED");
  assert.deepEqual(JSON.parse(e.payload).status_after, "已完成");
  assert.throws(() => completeTask({ workspaceDir: dir, sessionId: SESSION, callId: "c4", treatReviewAsMet: true }), /状态是「已完成」，不能再完成一次/);
  assert.throws(() => prepareJudgement(dir, items, branchAfter(saveCall, ["u1", "都可以。"])), /这个任务的状态是「已完成」，不能再登记确认/);
});
