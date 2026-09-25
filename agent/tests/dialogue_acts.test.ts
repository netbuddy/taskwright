/**
 * 对话理解：理解格式的核对、从助手消息里解析并记下理解、三个工具的门禁、回复记执行者的行为、
 * 保存修订记理解编号与规范化值、三个派生事实，以及 schema 是唯一来源（主行为枚举、平台 skill 的生成区）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { ACT_KINDS, consecutiveReplyRejections } from "../src/lib/reply.ts";
import { databasePath } from "../src/lib/db.ts";
import { withTaskDatabase } from "../src/lib/schema.ts";
import { EXECUTOR_FUNCTIONS, INTENT_SCHEMA, schemaErrors } from "../src/lib/intent_schema.ts";
import {
  currentRun,
  extractUnderstanding,
  readDialogueFacts,
  recordFromAssistantMessage,
  recordReplyActs,
  requireUnderstanding,
} from "../src/lib/dialogue_acts.ts";
import { getItem, getTaskStatus } from "../src/lib/task_query.ts";
import { taskStatusMessage } from "../src/lib/task_status.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { GATED_TOOLS } from "../src/hooks/intent_record.ts";
import { FALLBACK_TEXT } from "../src/hooks/reply_fallback.ts";
import { renderDocument } from "../../scripts/render-intent-schema.mjs";
import { DEFINITION_PATH, SOURCE, callIn, makeWorkspace, query } from "./helpers.ts";

const SESSION = "session-test";

// ───────────── 夹具 ─────────────

/** 建任务并新增两个用例 UC-001、UC-002（修订 1）。 */
function workspaceWithItems(): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), {
    operations: [
      { op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [SOURCE] },
      { op: "add", collection: "用例", fields: { 名称: "退出", 步骤: ["点退出"] }, sources: [SOURCE] },
    ],
  });
  return dir;
}

type Entry = { id: string; type: string; customType?: string; details?: any; message?: any };
let serial = 0;
const userEntry = (text: string, id = `u${++serial}`): Entry => ({ id, type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistantEntry = (id = `a${++serial}`): Entry => ({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text: "……" }] } });
const fenced = (acts: unknown[]) => "```json\n" + JSON.stringify({ acts }) + "\n```";
const assistantMessage = (text: string | null, calls: string[] = []) => ({
  role: "assistant",
  stopReason: calls.length ? "toolUse" : "stop",
  content: [...(text === null ? [] : [{ type: "text", text }]), ...calls.map((name, i) => ({ type: "toolCall", id: `call-${name}-${i}`, name, arguments: {} }))],
});

const record = (dir: string, branch: Entry[], text: string | null, calls: string[] = []) =>
  recordFromAssistantMessage(dir, SESSION, branch, assistantMessage(text, calls), GATED_TOOLS);

const acts = (dir: string) => query<any>(dir, "SELECT * FROM dialogue_act ORDER BY rowid");
const events = (dir: string, name: string) => query<any>(dir, "SELECT * FROM event WHERE name = ? ORDER BY seq", name);

const AFFIRM = { function: "affirm", targets: [{ item_id: "UC-001" }], confidence: "high", summary: "接受 UC-001" };

/** 执行者回复过一次（一条告知、一个请确认 UC-001、UC-002），返回那一轮的分支。 */
function withExecutorAsk(dir: string, userText = "把材料整理成用例"): { branch: Entry[]; askId: string } {
  const branch = [userEntry(userText)];
  record(dir, branch, fenced([{ function: "request", confidence: "high", summary: "整理材料" }]), ["save_revision"]);
  branch.push(assistantEntry("reply-msg-1"));
  const out = recordReplyActs(dir, SESSION, branch, {
    informs: ["我新增了 UC-001、UC-002。"],
    act: { kind: "confirm", text: "请确认 UC-001、UC-002", items: [{ item_id: "UC-001" }, { item_id: "UC-002" }] },
  }, "reply-msg-1", "call-reply-1");
  return { branch, askId: out!.acts.find((one) => one.expects_response)!.act_id };
}

// ───────────── schema 与解析 ─────────────

test("schema 核对：合格的理解没有问题；缺项、多项、枚举不对、空列表、超长、负序号逐条报出", () => {
  assert.deepEqual(schemaErrors({ acts: [AFFIRM] }), []);
  assert.deepEqual(schemaErrors(INTENT_SCHEMA.examples[0].value), []);
  const cases: [unknown, RegExp][] = [
    [[], /整份理解 应当是一个对象/],
    [{}, /缺少 acts/],
    [{ acts: [] }, /acts 至少要有 1 项/],
    [{ acts: [AFFIRM], extra: 1 }, /多了「extra」这一项/],
    [{ acts: [{ ...AFFIRM, function: "agree" }] }, /acts\[0\]\.function 写的是 "agree"，只能是 inform、request、affirm/],
    [{ acts: [{ function: "affirm", summary: "x" }] }, /acts\[0\] 缺少 confidence/],
    [{ acts: [{ ...AFFIRM, confidence: "sure" }] }, /confidence 写的是 "sure"/],
    [{ acts: [{ ...AFFIRM, summary: "长".repeat(121) }] }, /summary 超过了 120 个字/],
    [{ acts: [{ ...AFFIRM, targets: [{ field: "名称" }] }] }, /targets\[0\] 缺少 item_id/],
    [{ acts: [{ ...AFFIRM, targets: [{ item_id: "UC-001", index: -1 }] }] }, /index 不能小于 0/],
    [{ acts: [{ ...AFFIRM, responds_to: 3 }] }, /responds_to 应当是文字/],
    [{ acts: [{ ...AFFIRM, why: "因为" }] }, /acts\[0\] 多了「why」这一项/],
  ];
  for (const [value, pattern] of cases) {
    const errors = schemaErrors(value);
    assert.ok(errors.some((one) => pattern.test(one)), `${JSON.stringify(value)} 应当报出 ${pattern}，实际是 ${errors.join(" | ")}`);
  }
});

test("用户向助手要信息记 question（询问）：schema 收这一种，clarify 只留给没听懂助手上一句话", () => {
  const ask = { function: "question", targets: [{ item_id: "X-004" }], confidence: "high", summary: "材料里有没有写预约的书保留几天" };
  assert.deepEqual(schemaErrors({ acts: [ask] }), []);
  assert.ok(INTENT_SCHEMA.$defs.user_function.enum.includes("question"));
  assert.equal(INTENT_SCHEMA.$defs.user_function["x-names"].question, "询问");
  assert.match(INTENT_SCHEMA.$defs.user_function["x-usage"].clarify, /没听懂你上一句话/);
  assert.ok(INTENT_SCHEMA.examples.some((one: any) => one.value.acts.some((act: any) => act.function === "question")));
  // 执行者侧的 ask 仍然不能写在用户侧。
  assert.match(schemaErrors({ acts: [{ ...ask, function: "ask" }] }).join(" | "), /function 写的是 "ask"，只能是 .*clarify、question 之一/);
});

test("取理解：```json 围栏、没写语言的围栏、整段就是 JSON 都认；没有围栏、JSON 写坏各给原因", () => {
  assert.deepEqual(extractUnderstanding('```json\n{"acts": []}\n```'), { ok: true, value: { acts: [] } });
  assert.deepEqual(extractUnderstanding('```\n{"acts": []}\n```'), { ok: true, value: { acts: [] } });
  assert.deepEqual(extractUnderstanding('{"acts": []}'), { ok: true, value: { acts: [] } });
  const none = extractUnderstanding("好的，我这就去改。");
  assert.equal(none.ok, false);
  assert.match((none as { reason: string }).reason, /没有用 ```json 围栏包住的理解/);
  const broken = extractUnderstanding('```json\n{"acts": [}\n```');
  assert.equal(broken.ok, false);
  assert.match((broken as { reason: string }).reason, /JSON 解析不了/);
  assert.match((extractUnderstanding(null) as { reason: string }).reason, /不是文字/);
});

test("运行号：分支上第几句用户的话，兜底那句提醒不算；界面点击与界面操作之后那句固定的话认作合成的", () => {
  const branch: Entry[] = [
    { id: "s", type: "custom_message", customType: "taskwright-task-status", details: {} },
    userEntry("整理一下", "u-a"),
    assistantEntry(),
    userEntry(FALLBACK_TEXT, "u-fb"),
    assistantEntry(),
  ];
  const first = currentRun(branch)!;
  assert.equal(first.runId, "r1");
  assert.equal(first.userEntryId, "u-a");
  assert.equal(first.assistantCount, 2);
  assert.equal(first.synthesized, null);

  branch.push(
    { id: "c1", type: "custom_message", customType: "taskwright-ui-click", details: { reply_entry: "reply-msg-1", option_text: "允许", text: "我选：允许" } },
    userEntry("我选：允许", "u-b"),
  );
  const click = currentRun(branch)!;
  assert.equal(click.runId, "r2");
  assert.deepEqual(click.synthesized, { kind: "card_choice", items: [], replyEntry: "reply-msg-1", option: "允许" });

  branch.push(
    { id: "c2", type: "custom_message", customType: "taskwright-user-edit", details: { kind: "mark_viewed", results: [{ item_id: "UC-001", revision_no: 1 }] } },
    userEntry("我已经看过了：UC-001（修订 1）。请接着往下做。", "u-c"),
  );
  assert.deepEqual(currentRun(branch)!.synthesized, { kind: "viewed", items: ["UC-001"] });

  branch.push(
    { id: "c3", type: "custom_message", customType: "taskwright-user-edit", details: { kind: "keep_pending", results: [{ item_id: "TBD-001" }] } },
    userEntry("我先不管 TBD-001，请接着往下做。", "u-d"),
  );
  assert.equal(currentRun(branch)!.synthesized?.kind, "keep_pending");
  // 用户自己打的一模一样的字，前面没有界面操作的说明，不算合成的。
  branch.push(userEntry("我已经看过了：UC-001（修订 1）。请接着往下做。", "u-e"));
  assert.equal(currentRun(branch)!.synthesized, null);
  assert.equal(currentRun(branch)!.runId, "r5");
});

// ───────────── 记下理解 ─────────────

test("合格的理解写进对话行为表并记 USER_INTENT_RECORDED；编号是运行号-序号", () => {
  const dir = workspaceWithItems();
  const branch = [userEntry("第一条可以，第二条的名称应该是注销", "u-1")];
  const outcome = record(dir, branch, fenced([
    AFFIRM,
    { function: "correct", targets: [{ item_id: "UC-002", field: "名称" }], confidence: "high", summary: "名称改为注销" },
  ]), ["save_revision"]);
  assert.equal(outcome.kind, "recorded");
  const rows = acts(dir);
  assert.deepEqual(rows.map((r) => [r.act_id, r.run_id, r.speaker, r.function, r.origin, r.source_entry, r.expects_response]), [
    ["r1-1", "r1", "user", "affirm", "understanding", "u-1", 0],
    ["r1-2", "r1", "user", "correct", "understanding", "u-1", 0],
  ]);
  assert.deepEqual(JSON.parse(rows[1].targets), [{ item_id: "UC-002", field: "名称" }]);
  const [event] = events(dir, "USER_INTENT_RECORDED");
  assert.equal(rows[0].event_seq, event.seq);
  assert.equal(JSON.parse(event.payload).user_entry, "u-1");
  // 同一句话再写一份，不再记。
  assert.equal(record(dir, branch, fenced([AFFIRM])).kind, "skipped");
  assert.equal(acts(dir).length, 2);
});

test("形式不合格时不写表，记 USER_INTENT_INVALID 带原因；这一轮之后的助手消息没写理解也没调门禁工具时不再记", () => {
  const dir = workspaceWithItems();
  const branch = [userEntry("整理一下", "u-1")];
  const bad = record(dir, branch, fenced([{ function: "agree", confidence: "high", summary: "x" }]), ["save_revision"]);
  assert.equal(bad.kind, "invalid");
  assert.equal(acts(dir).length, 0);
  const [event] = events(dir, "USER_INTENT_INVALID");
  assert.match(JSON.parse(event.payload).reason, /function 写的是 "agree"/);

  branch.push(assistantEntry());
  assert.equal(record(dir, branch, null, ["get_item"]).kind, "skipped");
  assert.equal(events(dir, "USER_INTENT_INVALID").length, 1);
  // 调了门禁工具却没写理解：记一条。
  assert.equal(record(dir, branch, null, ["reply"]).kind, "invalid");
  assert.equal(events(dir, "USER_INTENT_INVALID").length, 2);
  // 第一条助手消息就没写理解：记一条。
  const other = workspaceWithItems();
  assert.equal(record(other, [userEntry("你好")], "你好，我是助手。", ["reply"]).kind, "invalid");
});

test("responds_to 指向不存在的、用户自己的、已经被回应过的行为时被拒；targets 指向没有的条目时被拒", () => {
  const dir = workspaceWithItems();
  const { branch, askId } = withExecutorAsk(dir);
  assert.equal(askId, "r1-3");

  const run2 = [...branch, userEntry("可以", "u-2")];
  const missing = record(dir, run2, fenced([{ ...AFFIRM, responds_to: "r9-9" }]));
  assert.match((missing as { reason: string }).reason, /r9-9，这条会话里没有这个编号/);
  const userAct = record(dir, run2, fenced([{ ...AFFIRM, responds_to: "r1-1" }]));
  assert.match((userAct as { reason: string }).reason, /那是用户的行为/);
  const noItem = record(dir, run2, fenced([{ ...AFFIRM, targets: [{ item_id: "UC-009" }] }]));
  assert.match((noItem as { reason: string }).reason, /UC-009 在这个任务里没有/);

  assert.equal(record(dir, run2, fenced([{ ...AFFIRM, responds_to: askId }])).kind, "recorded");
  // 一份理解里两项指向同一条：可以（例子里的同意与纠正都回应 r12-1）。
  // 下一句话再指向已经被回应的那一条：被拒。
  const run3 = [...run2, assistantEntry(), userEntry("还是可以", "u-3")];
  const again = record(dir, run3, fenced([{ ...AFFIRM, responds_to: askId }]));
  assert.match((again as { reason: string }).reason, /已经被 r2-1 回应过了/);
});

test("复合回答：同意两条、纠正一条、一条先不管，入表三条，前两条回应同一个请确认", () => {
  const dir = workspaceWithItems();
  const { branch, askId } = withExecutorAsk(dir);
  const run2 = [...branch, userEntry("UC-001 可以，UC-002 名称应该叫注销登录，另外备注先不管", "u-2")];
  const outcome = record(dir, run2, fenced([
    { function: "affirm", responds_to: askId, targets: [{ item_id: "UC-001" }], confidence: "high", summary: "接受 UC-001" },
    { function: "correct", responds_to: askId, targets: [{ item_id: "UC-002", field: "名称" }], confidence: "high", summary: "名称改为注销登录" },
    { function: "inform", targets: [{ item_id: "UC-002", field: "备注" }], confidence: "medium", summary: "备注先不管" },
  ]), ["save_revision"]);
  assert.equal(outcome.kind, "recorded");
  const rows = acts(dir).filter((r) => r.run_id === "r2");
  assert.deepEqual(rows.map((r) => [r.act_id, r.function, r.responds_to]), [
    ["r2-1", "affirm", askId],
    ["r2-2", "correct", askId],
    ["r2-3", "inform", null],
  ]);
});

test("界面点击合成的话：执行者不写理解，按点击直接记一条告知，回应那张卡片的主行为", () => {
  const dir = workspaceWithItems();
  const { branch, askId } = withExecutorAsk(dir);
  const run2: Entry[] = [
    ...branch,
    { id: "click", type: "custom_message", customType: "taskwright-ui-click", details: { reply_entry: "reply-msg-1", option_text: "允许", text: "我选：允许" } },
    userEntry("我选：允许", "u-2"),
  ];
  const outcome = record(dir, run2, null, ["save_revision"]);
  assert.equal(outcome.kind, "recorded");
  const row = acts(dir).find((r) => r.run_id === "r2")!;
  assert.equal(row.origin, "ui");
  assert.equal(row.function, "inform");
  assert.equal(row.responds_to, askId);
  assert.deepEqual(JSON.parse(row.targets), [{ item_id: "UC-001" }, { item_id: "UC-002" }]);
  assert.match(row.summary, /选了「允许」/);
  assert.equal(JSON.parse(events(dir, "USER_INTENT_RECORDED").at(-1).payload).origin, "ui");
  assert.equal(events(dir, "USER_INTENT_RECORDED").at(-1).actor, "user");
  // 门禁放行。
  requireUnderstanding(dir, SESSION, run2, "保存修订", "save_revision");
});

// ───────────── 门禁 ─────────────

test("门禁：这一轮没有有效理解时三个工具的拒绝理由相同，附上次解析失败的原因；有理解放行；没有库、没有用户的话不拦", () => {
  const dir = workspaceWithItems();
  const branch = [userEntry("整理一下", "u-1")];
  assert.throws(() => requireUnderstanding(dir, SESSION, branch, "保存修订", "save_revision"),
    /保存修订没有执行：先按 schema 写下你对用户这句话的理解。这一轮（自用户最近一句话起）还没有一份有效的理解。/);
  record(dir, branch, "我去整理。", ["save_revision"]);
  assert.throws(() => requireUnderstanding(dir, SESSION, branch, "完成任务", "complete_task"),
    /完成任务没有执行：先按 schema.*上一次的问题是：这一轮第一段文字里没有用 ```json 围栏包住的理解/s);
  branch.push(assistantEntry());
  record(dir, branch, fenced([{ function: "request", confidence: "high", summary: "整理" }]), ["reply"]);
  requireUnderstanding(dir, SESSION, branch, "回复", "reply");
  requireUnderstanding(dir, SESSION, [...branch, userEntry(FALLBACK_TEXT)], "回复", "reply");
  // 新的一句话：又要一份新的理解。
  assert.throws(() => requireUnderstanding(dir, SESSION, [...branch, userEntry("再改改")], "回复", "reply"), /先按 schema/);
  requireUnderstanding(makeWorkspace(), SESSION, [userEntry("你好")], "回复", "reply");
  requireUnderstanding(dir, SESSION, [], "回复", "reply");
});

test("门禁拒绝「回复」不算回复的形式被拒：连续被拒的计数跳过它", () => {
  const rejection = (text: string) => ({ id: `t${++serial}`, type: "message", message: { role: "toolResult", toolName: "reply", isError: true, content: [{ type: "text", text }] } });
  const branch = [
    userEntry("你好"),
    rejection("这次回复的形式不对，没有送达。"),
    rejection("回复没有执行：先按 schema 写下你对用户这句话的理解。"),
    rejection("这次回复的形式不对，没有送达。"),
  ];
  assert.equal(consecutiveReplyRejections(branch as never), 2);
});

// ───────────── 回复记执行者的行为 ─────────────

test("回复记执行者的行为：每条告知一条 inform 不期待回应，主行为一条期待回应，编号写进返回的话", () => {
  const dir = workspaceWithItems();
  const branch = [userEntry("整理一下", "u-1")];
  record(dir, branch, fenced([{ function: "request", confidence: "high", summary: "整理" }]), ["save_revision"]);
  const out = recordReplyActs(dir, SESSION, branch, {
    informs: ["我新增了 UC-001。", "我新增了 UC-002。"],
    act: { kind: "choose", text: "要不要现在完成？", items: [] },
  }, "reply-msg", "call-reply")!;
  assert.deepEqual(out.acts.map((a) => [a.act_id, a.function, a.expects_response]), [
    ["r1-2", "inform", false], ["r1-3", "inform", false], ["r1-4", "choose", true],
  ]);
  assert.match(out.text, /^本轮记了 r1-2（告知：我新增了 UC-001。）、r1-3（告知：我新增了 UC-002。）、r1-4（请选择：要不要现在完成？）。用户回应时，你下一轮理解里的 responds_to 写 r1-4。$/);
  const rows = acts(dir).filter((r) => r.speaker === "executor");
  assert.ok(rows.every((r) => r.origin === "reply" && r.source_entry === "reply-msg" && r.event_seq === out.eventSeq));
  assert.equal(events(dir, "EXECUTOR_ACTS_RECORDED")[0].call_id, "call-reply");
  // 纯文字回复没有要记的行为；没有库时什么都不记。
  assert.deepEqual(recordReplyActs(dir, SESSION, branch, { informs: [], act: null }, "m", "c")!.acts, []);
  assert.equal(recordReplyActs(makeWorkspace(), SESSION, branch, { informs: ["x"], act: null }, "m", "c"), null);
});

// ───────────── 保存修订 ─────────────

test("保存修订的 intent_act_id：取本轮与操作条目相同的用户行为；新增条目时取没写 targets 的请求；对不上留空", () => {
  const dir = workspaceWithItems();
  const branch = [userEntry("UC-002 的名称应该叫注销登录，再加一个找回口令的用例", "u-1")];
  record(dir, branch, fenced([
    { function: "correct", targets: [{ item_id: "UC-002", field: "名称" }], confidence: "high", summary: "名称改为注销登录" },
    { function: "request", confidence: "high", summary: "新增找回口令用例" },
  ]), ["save_revision"]);
  const edit = saveRevision({ ...callIn(dir), intentEntry: "u-1" }, {
    operations: [{ op: "update", item: "UC-002", base_revision: 1, fields: { 名称: "注销登录" } }],
  });
  assert.equal(edit.details.intent_act_id, "r1-1");
  const add = saveRevision({ ...callIn(dir), intentEntry: "u-1" }, {
    operations: [{ op: "add", collection: "用例", fields: { 名称: "找回口令", 步骤: ["点忘记口令"] }, sources: [SOURCE] }],
  });
  assert.equal(add.details.intent_act_id, "r1-2");
  const none = saveRevision({ ...callIn(dir), intentEntry: "u-nothing" }, {
    operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "账号登录" } }],
  });
  assert.equal(none.details.intent_act_id, null);
  assert.deepEqual(query<any>(dir, "SELECT revision_no, intent_act_id FROM revision ORDER BY revision_no").map((r) => r.intent_act_id), [null, "r1-1", "r1-2", null]);
  const event = query<any>(dir, "SELECT payload FROM event WHERE name = 'REVISION_SAVED' ORDER BY seq DESC LIMIT 1 OFFSET 2")[0];
  assert.equal(JSON.parse(event.payload).intent_act_id, "r1-1");
});

test("规范化修订：用户的话带 normalized_value，存进来源表，摘录仍逐字核对；别的种类写它被拒", () => {
  const dir = workspaceWithItems();
  const userMessages = [{ entryId: "u-1", text: "名称应该是注销登录吧" }];
  const out = saveRevision({ ...callIn(dir), userMessages }, {
    operations: [{ op: "update", item: "UC-002", base_revision: 1, fields: { 名称: "注销登录" },
      sources: [{ kind: "用户的话", excerpt: "应该是注销登录", normalized_value: "注销登录", supports: [{ field: "名称" }] }] }],
  });
  const row = query<any>(dir, "SELECT kind, excerpt, normalized_value FROM item_source WHERE item_id = 'UC-002' AND revision_no = ? AND kind = '用户的话'", out.details.revision_no)[0];
  assert.deepEqual({ ...row }, { kind: "用户的话", excerpt: "应该是注销登录", normalized_value: "注销登录" });
  const shown = getItem(dir, { item_id: "UC-002" }).details.sources as { kind: string; normalized_value?: string }[];
  assert.equal(shown.find((one) => one.kind === "用户的话")?.normalized_value, "注销登录");
  assert.throws(() => saveRevision({ ...callIn(dir), userMessages }, {
    operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "账号登录" },
      sources: [{ ...SOURCE, normalized_value: "账号登录", supports: [{ field: "名称" }] }] }],
  }), /normalized_value；它只用于种类为「用户的话」的来源/);
  assert.throws(() => saveRevision({ ...callIn(dir), userMessages }, {
    operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "注销" },
      sources: [{ kind: "用户的话", excerpt: "注销登录吧呀", normalized_value: "注销", supports: [{ field: "名称" }] }] }],
  }), /在对话里没有找到/);
});

// ───────────── 三个派生事实 ─────────────

test("派生事实：还在等回应的执行者行为；被回应之后不再列", () => {
  const dir = workspaceWithItems();
  const { branch, askId } = withExecutorAsk(dir);
  let facts = readDialogueFacts(dir, SESSION)!;
  assert.deepEqual(facts.unanswered.map((one) => [one.act_id, one.function, one.items]), [[askId, "confirm", ["UC-001", "UC-002"]]]);
  assert.match(getTaskStatus(dir, SESSION).text, /还在等回应的执行者行为 1 条.*r1-3 请确认「请确认 UC-001、UC-002」（UC-001、UC-002）/);
  assert.equal(getItem(dir, { item_id: "UC-001" }, SESSION).details.dialogue.unanswered.length, 1);
  record(dir, [...branch, userEntry("可以", "u-2")], fenced([{ ...AFFIRM, responds_to: askId }]));
  facts = readDialogueFacts(dir, SESSION)!;
  assert.deepEqual(facts.unanswered, []);
  assert.doesNotMatch(getTaskStatus(dir, SESSION).text, /还在等回应/);
  // 别的会话看不到这条会话的行为。
  assert.deepEqual(readDialogueFacts(dir, "session-other")!.unanswered, []);
});

test("派生事实：连续追问——同一条目连着两次运行问了都没回应数 2；得到回应后清零", () => {
  const dir = workspaceWithItems();
  const branch: Entry[] = [];
  const ask = (runText: string, entry: string) => {
    branch.push(userEntry(runText, entry));
    record(dir, branch, fenced([{ function: "other", confidence: "high", summary: runText }]), ["reply"]);
    recordReplyActs(dir, SESSION, branch, { informs: [], act: { kind: "ask", text: "UC-001 的步骤还缺什么？", items: [{ item_id: "UC-001" }] } }, `m-${entry}`, `c-${entry}`);
    branch.push(assistantEntry());
  };
  ask("你好", "u-1");
  ask("今天天气不错", "u-2");
  let facts = readDialogueFacts(dir, SESSION)!;
  assert.deepEqual(facts.follow_ups, [{ item_id: "UC-001", runs: 2, act_ids: ["r1-2", "r2-2"] }]);
  assert.match(getItem(dir, { item_id: "UC-001" }, SESSION).text, /连续追问：UC-001 已经连续 2 次运行问了都没有得到回应（r1-2、r2-2）/);
  branch.push(userEntry("步骤缺一步输入口令", "u-3"));
  record(dir, branch, fenced([{ function: "inform", responds_to: "r2-2", targets: [{ item_id: "UC-001" }], confidence: "high", summary: "缺输入口令" }]));
  facts = readDialogueFacts(dir, SESSION)!;
  // 只有最后一问被回应：从被回应的那一次起重数，之前那次未回应的不再连着算。
  assert.deepEqual(facts.follow_ups, []);
});

test("派生事实：改口——同一字段按用户的意思（直接操作或带理解编号的修订）改过两次，列出历次的值", () => {
  const dir = workspaceWithItems();
  const branch = [userEntry("UC-002 名称叫注销", "u-1")];
  record(dir, branch, fenced([{ function: "correct", targets: [{ item_id: "UC-002", field: "名称" }], confidence: "high", summary: "名称改为注销" }]), ["save_revision"]);
  saveRevision({ ...callIn(dir), intentEntry: "u-1" }, { operations: [{ op: "update", item: "UC-002", base_revision: 1, fields: { 名称: "注销" } }] });
  // 执行者自己改（没有理解编号）不算。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-002", base_revision: 2, fields: { 步骤: ["点退出", "确认"] } }] });
  assert.deepEqual(readDialogueFacts(dir, SESSION)!.rephrasings, []);
  runUserOperation({ workspaceDir: dir, sessionId: SESSION }, {
    op_id: "ui-op-1", kind: "edit_fields", targets: [{ item_id: "UC-002", base_revision: 3 }], fields: { 名称: "退出登录" },
  });
  const facts = readDialogueFacts(dir, SESSION)!;
  assert.deepEqual(facts.rephrasings, [{ item_id: "UC-002", field: "名称", times: 2, values: [{ revision_no: 2, value: "注销" }, { revision_no: 4, value: "退出登录" }] }]);
  assert.match(getTaskStatus(dir, SESSION).text, /改口：UC-002 的「名称」在这条会话里按用户的意思改过 2 次，历次是 修订 2："注销"，修订 4："退出登录"/);
});

test("续接会话时，任务现状消息列出还在等回应的执行者行为", () => {
  const dir = workspaceWithItems();
  withExecutorAsk(dir);
  const message = taskStatusMessage(dir, { hasUserMessage: true, hasStatusMessage: true, lastMessageAt: 0 }, SESSION)!;
  assert.match(message.text, /还在等回应的执行者行为 1 条（你问过、用户还没有回应的）：r1-3 请确认「请确认 UC-001、UC-002」。$/);
  assert.deepEqual(message.details.open_acts, [{ act_id: "r1-3", function: "confirm", summary: "请确认 UC-001、UC-002" }]);
});

// ───────────── 库表与唯一来源 ─────────────

test("对话理解之前建的库：打开时补建对话行为表、给修订表与来源表补列，原有的行都在", () => {
  const dir = workspaceWithItems();
  const db = new DatabaseSync(databasePath(dir));
  db.exec("DROP TABLE dialogue_act; ALTER TABLE revision DROP COLUMN intent_act_id; ALTER TABLE item_source DROP COLUMN normalized_value;");
  db.close();
  withTaskDatabase(dir, { createIfMissing: false }, () => null);
  const columns = (table: string) => query<{ name: string }>(dir, `PRAGMA table_info(${table})`).map((r) => r.name);
  assert.ok(columns("dialogue_act").includes("responds_to"));
  assert.ok(columns("revision").includes("intent_act_id"));
  assert.ok(columns("item_source").includes("normalized_value"));
  assert.equal(query(dir, "SELECT * FROM revision").length, 1);
});

test("唯一来源：回复的五种主行为取自 schema；平台 skill 的生成区与 schema 一致", () => {
  assert.deepEqual([...ACT_KINDS], [...EXECUTOR_FUNCTIONS]);
  assert.deepEqual([...EXECUTOR_FUNCTIONS], ["ask", "confirm", "suggest", "choose", "propose"]);
  const path = join(import.meta.dirname, "..", "prompts", "skills", "taskwright-executor", "SKILL.md");
  const text = readFileSync(path, "utf-8");
  assert.match(text, /<!-- 理解格式生成区 开始：agent\/prompts\/schemas\/user_intent.schema.json -->/);
  assert.equal(renderDocument(text), text, "SKILL.md 的理解格式生成区过期了，跑 node scripts/render-intent-schema.mjs");
  for (const fn of INTENT_SCHEMA.$defs.user_function.enum) assert.match(text, new RegExp("`" + fn + "`"));
});
