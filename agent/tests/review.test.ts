/**
 * 评审门禁：规则文件的校验、评审者输出的核对与结论计算、界面发起的评审（异步返回、三种事件）、
 * 待评审的挑法、旧库补列、领域规矩文档里的生成区与规则文件一致。评审者的模型调用一律用假的。
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { DefinitionError, loadDefinition } from "../src/lib/definition.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { withTaskDatabase } from "../src/lib/schema.ts";
import { ReviewError, prepareReviews } from "../src/lib/review.ts";
import { type Complete, runReviews } from "../src/lib/review_run.ts";
import { reviewSlot } from "../src/lib/review_ui.ts";
import { REVIEW_STATUS_KEY, USER_COMMAND, USER_EDIT_CUSTOM_TYPE, USER_RESULT_KEY, registerUserCommands } from "../src/hooks/user_commands.ts";
import { completeTask } from "../src/lib/complete_task.ts";
// @ts-ignore 仓库根目录的脚本是纯 JavaScript 模块
import { documents, renderDocument } from "../../scripts/render-rules.mjs";
import { DEFINITION_PATH, SOURCE, callIn, demoDefinition, makeWorkspace, query } from "./helpers.ts";

const RULES = [
  { 编号: "D-R1", 级别: "必选", 条文: "步骤写明谁做了什么。", 反例: "校验。", 正例: "系统校验口令。" },
  { 编号: "D-R2", 级别: "可选", 条文: "步骤里不举例。", 反例: "例如输错三次。", 正例: "输错三次锁定。" },
  { 编号: "D-R3", 级别: "可选", 条文: "名称用动词加对象。", 反例: "登录处理。", 正例: "登录系统。" },
];

/** 演示任务定义加上「评审规矩」，规则文件放进任务目录。 */
function reviewWorkspace(spec: Record<string, unknown> = { 规则文件: "docs/review-rules/demo.json" }, rules: unknown = RULES): string {
  const definition = demoDefinition() as any;
  definition.交付物.条目集合[0].评审规矩 = spec;
  const dir = makeWorkspace(definition);
  mkdirSync(join(dir, "docs/review-rules"), { recursive: true });
  writeFileSync(join(dir, "docs/review-rules/demo.json"), JSON.stringify(rules), "utf-8");
  return dir;
}

/** 建好任务并存两个用例（UC-001、UC-002，都在修订 1）。 */
function withTwoItems(dir: string): string {
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["用户输入口令", "校验"] }, sources: [SOURCE] },
    { op: "add", collection: "用例", fields: { 名称: "注销", 步骤: ["用户点注销"] }, sources: [SOURCE] },
  ] });
  return dir;
}

/** 假评审者：按条目编号回事先写好的输出；每次调用记下来。 */
function fakeReviewer(outputs: Record<string, string | string[]>): { complete: Complete; calls: { item: string; attempt: number; user: string }[] } {
  const calls: { item: string; attempt: number; user: string }[] = [];
  return {
    calls,
    complete: async (_system, user, _signal, attempt, item) => {
      calls.push({ item: item.item_id, attempt, user });
      const out = outputs[item.item_id];
      const text = Array.isArray(out) ? out[Math.min(attempt, out.length) - 1] : out ?? JSON.stringify({ 发现: [] });
      return { text, inputTokens: 10, outputTokens: 5 };
    },
  };
}

const finding = (rule: string, extra: Record<string, unknown> = {}) =>
  ({ 规则: rule, 字段: "步骤", 序号: 2, 问题: "第 2 步「校验」没有主语。", 建议: "写明是系统校验口令。", ...extra });

// ───────────── 规则文件的校验 ─────────────

test("任务定义的评审规矩：规则文件缺失、编号重复、关闭不存在的编号、关闭必选规则都被拒，各写明原因", () => {
  const missing = reviewWorkspace({ 规则文件: "docs/review-rules/没有.json" });
  assert.throws(() => loadDefinition(missing, DEFINITION_PATH), (e: DefinitionError) => e.reasons.some((r) => r.includes("没有.json") && r.includes("读不到")));

  const duplicated = reviewWorkspace(undefined, [...RULES, { ...RULES[0] }]);
  assert.throws(() => loadDefinition(duplicated, DEFINITION_PATH), (e: DefinitionError) => e.reasons.some((r) => r.includes("编号 D-R1 重复出现")));

  const unknown = reviewWorkspace({ 规则文件: "docs/review-rules/demo.json", 关闭: ["D-R9"] });
  assert.throws(() => loadDefinition(unknown, DEFINITION_PATH), (e: DefinitionError) => e.reasons.some((r) => r.includes("「关闭」里写了 D-R9") && r.includes("没有这条规则")));

  const required = reviewWorkspace({ 规则文件: "docs/review-rules/demo.json", 升为必选: ["D-R1"] });
  assert.throws(() => loadDefinition(required, DEFINITION_PATH), (e: DefinitionError) => e.reasons.some((r) => r.includes("D-R1，它是必选规则")));

  const badLevel = reviewWorkspace(undefined, [{ ...RULES[0], 级别: "强制" }]);
  assert.throws(() => loadDefinition(badLevel, DEFINITION_PATH), (e: DefinitionError) => e.reasons.some((r) => r.includes("「级别」写的是「强制」")));
});

test("评审规矩写对了能读出来；没有这个键的旧任务定义照旧通过，评审规矩为空", () => {
  const dir = reviewWorkspace({ 规则文件: "docs/review-rules/demo.json", 关闭: ["D-R3"], 升为必选: ["D-R2"] });
  const { definition } = loadDefinition(dir, DEFINITION_PATH);
  assert.deepEqual(definition.collections[0].reviewRules, { file: "docs/review-rules/demo.json", off: ["D-R3"], promote: ["D-R2"] });
  assert.equal(definition.collections[1].reviewRules, null);
  assert.equal(loadDefinition(makeWorkspace(), DEFINITION_PATH).definition.collections[0].reviewRules, null);
});

test("真实的任务类型：三个集合的规则文件都能读，问题集合不评审", () => {
  const typeDir = resolve(import.meta.dirname, "../../task-types/srs-authoring");
  const { definition } = loadDefinition(typeDir, "docs/task-definitions/srs-authoring.json");
  assert.deepEqual(definition.collections.map((c) => c.reviewRules?.file ?? null),
    ["docs/review-rules/use-case.json", "docs/review-rules/ears.json", "docs/review-rules/ears.json", null]);
  const count = (file: string) => (JSON.parse(readFileSync(join(typeDir, file), "utf-8")) as unknown[]).length;
  assert.equal(count("docs/review-rules/use-case.json"), 14);
  assert.equal(count("docs/review-rules/ears.json"), 9);
});

// ───────────── 评审者输出的核对与结论 ─────────────

test("只有可选规则的发现：结论合规，发现记为建议；有必选规则的发现：结论不合规", async () => {
  const dir = withTwoItems(reviewWorkspace());
  const { complete } = fakeReviewer({
    "UC-001": JSON.stringify({ 发现: [finding("D-R1"), finding("D-R2", { 序号: 1, 建议: "" })] }),
    "UC-002": JSON.stringify({ 发现: [finding("D-R3", { 字段: "名称", 序号: null, 问题: "「注销」不是动词加对象。", 建议: "写成「注销登录」。" })] }),
  });
  const outcome = await runReviews(callIn(dir), null, { complete, model: "假/评审者" });
  const byId = Object.fromEntries(outcome.details.results.map((r) => [r.item_id, r]));
  assert.equal(byId["UC-001"].status, "不合规");
  assert.equal(byId["UC-002"].status, "合规");
  assert.match(outcome.text, /UC-001（修订 1）：不合规（问题 1 处，建议 1 条）。/);
  assert.match(outcome.text, /UC-002（修订 1）：合规（建议 1 条）。/);
  assert.match(outcome.text, /【问题 D-R1】步骤第 2 项：第 2 步「校验」没有主语。（改法：写明是系统校验口令。）/);
  const rows = query(dir, "SELECT r.item_id, r.verdict, f.rule_id, f.level, f.field, f.item_index FROM review r JOIN review_finding f ON f.review_id = r.review_id ORDER BY r.item_id, f.ordinal");
  assert.deepEqual(rows.map((r) => [r.item_id, r.verdict, r.rule_id, r.level, r.field, r.item_index]), [
    ["UC-001", "不合规", "D-R1", "必选", "步骤", 1],
    ["UC-001", "不合规", "D-R2", "可选", "步骤", 0],
    ["UC-002", "合规", "D-R3", "可选", "名称", null],
  ]);
  const event = JSON.parse(query<{ payload: string }>(dir, "SELECT payload FROM event WHERE name = 'REVIEW_RECORDED' ORDER BY seq LIMIT 1")[0].payload);
  assert.ok(event.findings.every((f: any) => typeof f.rule_id === "string" && (f.level === "必选" || f.level === "可选")));
});

test("评审者引用清单里没有的编号：这次输出不合格，重来一次；必选规则的发现没写建议也重来", async () => {
  const dir = withTwoItems(reviewWorkspace());
  const { complete, calls } = fakeReviewer({
    "UC-001": [JSON.stringify({ 发现: [finding("UC-R7")] }), JSON.stringify({ 发现: [] })],
    "UC-002": [JSON.stringify({ 发现: [finding("D-R1", { 字段: "步骤", 序号: 1, 建议: "" })] }), JSON.stringify({ 发现: [] })],
  });
  const outcome = await runReviews(callIn(dir), null, { complete, model: "假/评审者" });
  assert.deepEqual(outcome.details.results.map((r) => r.status), ["合规", "合规"]);
  assert.equal(calls.length, 4);
  const rejected = query<{ output: string }>(dir, "SELECT output FROM model_call WHERE outcome = '输出不合格' ORDER BY rowid");
  assert.equal(rejected.length, 2);
  assert.ok(calls[0].user.includes("- D-R1（必选）步骤写明谁做了什么。"), "评审者拿到带编号与级别的规则清单");
});

test("关闭的规则不进清单，升为必选的规则按必选算结论", async () => {
  const dir = withTwoItems(reviewWorkspace({ 规则文件: "docs/review-rules/demo.json", 关闭: ["D-R3"], 升为必选: ["D-R2"] }));
  const { complete, calls } = fakeReviewer({ "UC-001": JSON.stringify({ 发现: [finding("D-R2", { 建议: "去掉例子。" })] }) });
  const outcome = await runReviews(callIn(dir), [{ item_id: "UC-001", revision_no: 1 }], { complete, model: "假/评审者" });
  assert.equal(outcome.details.results[0].status, "不合规");
  assert.ok(!calls[0].user.includes("D-R3"));
  assert.ok(calls[0].user.includes("- D-R2（必选）"));
});

test("不点名时只评待评审的条目：当前修订上已有评审记录的（不合规的也算）不再评；点名问题集合的条目被拒", async () => {
  const dir = withTwoItems(reviewWorkspace());
  await runReviews(callIn(dir), [{ item_id: "UC-001", revision_no: 1 }], { complete: fakeReviewer({ "UC-001": JSON.stringify({ 发现: [finding("D-R1")] }) }).complete, model: "假" });
  assert.deepEqual(prepareReviews(dir, null).items.map((i) => i.item_id), ["UC-002"]);
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "问题", fields: { 事项: "口令多长？", 状态: "未解决" }, sources: [SOURCE] }] });
  assert.throws(() => prepareReviews(dir, [{ item_id: "TBD-001", revision_no: 2 }]), /所在的集合「问题」不要求评审/);
});

test("同一个任务目录同一时刻只跑一批评审", () => {
  const release = reviewSlot("/tmp/某个任务目录", "call-a");
  assert.throws(() => reviewSlot("/tmp/某个任务目录", "ui-op-b"), ReviewError);
  release();
  reviewSlot("/tmp/某个任务目录", "ui-op-b")();
});

// ───────────── 界面发起的评审：异步返回、三种事件 ─────────────

function commandRig(dir: string, complete: (user: string) => Promise<string>) {
  const commands = new Map<string, any>();
  const messages: any[] = [];
  registerUserCommands({ registerCommand: (name: string, spec: any) => commands.set(name, spec), sendMessage: (m: any) => messages.push(m), sendUserMessage() {} } as any);
  const status: Record<string, string[]> = {};
  const ctx = {
    mode: "rpc",
    cwd: dir,
    sessionManager: { getSessionId: () => "sess-ui" },
    model: { provider: "假", id: "评审者" },
    modelRegistry: {
      complete: async (_model: unknown, request: any) => ({
        stopReason: "stop", usage: { input: 1, output: 1 },
        content: [{ type: "text", text: await complete(request.messages[0].content[0].text) }],
      }),
    },
    ui: { setStatus: (key: string, value: string) => (status[key] ??= []).push(value), notify() {} },
  };
  const run = (body: Record<string, unknown>) => commands.get(USER_COMMAND).handler(JSON.stringify(body), ctx) as Promise<void>;
  return { run, status, messages };
}

test("界面发起的评审：核对通过立即回报，评审在后台跑，记 REVIEW_PROGRESS、REVIEW_RECORDED、REVIEW_FINISHED，评完往会话里追加结果", async () => {
  const dir = withTwoItems(reviewWorkspace());
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const { run, status, messages } = commandRig(dir, async (user) => {
    await gate;      // 回报之前评审者一个都没评完
    return JSON.stringify({ 发现: user.includes("UC-001") ? [finding("D-R1")] : [] });
  });
  await run({ op_id: "ui-op-r1", kind: "request_review", targets: [] });
  const reported = JSON.parse(status[USER_RESULT_KEY][0]);
  assert.equal(reported.ok, true);
  assert.deepEqual(reported.results, [{ item_id: "UC-001", revision_no: 1 }, { item_id: "UC-002", revision_no: 1 }]);
  assert.deepEqual(query(dir, "SELECT name FROM event WHERE name LIKE 'REVIEW_%' ORDER BY seq").map((r) => r.name), ["REVIEW_PROGRESS"]);

  open();
  for (let i = 0; i < 200 && !query(dir, "SELECT 1 FROM event WHERE name = 'REVIEW_FINISHED'").length; i++) await new Promise((r) => setTimeout(r, 10));
  const events = query<{ name: string; actor: string; call_id: string; payload: string }>(dir, "SELECT name, actor, call_id, payload FROM event WHERE name LIKE 'REVIEW_%' ORDER BY seq");
  assert.deepEqual(events.map((e) => e.name).filter((n) => n !== "REVIEW_RECORDED"), ["REVIEW_PROGRESS", "REVIEW_PROGRESS", "REVIEW_PROGRESS", "REVIEW_BATCH", "REVIEW_FINISHED"]);
  assert.equal(events.filter((e) => e.name === "REVIEW_RECORDED").length, 2);
  assert.ok(events.every((e) => e.actor === "user" && e.call_id === "ui-op-r1"));
  const progress = events.filter((e) => e.name === "REVIEW_PROGRESS").map((e) => JSON.parse(e.payload));
  assert.deepEqual(progress.map((p) => [p.done, p.total]), [[0, 2], [1, 2], [2, 2]]);
  const finished = JSON.parse(events.at(-1)!.payload);
  assert.deepEqual([finished.op_id, finished.total, finished.passed, finished.failed, finished.unfinished], ["ui-op-r1", 2, 1, 1, 0]);

  for (let i = 0; i < 100 && !messages.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].customType, USER_EDIT_CUSTOM_TYPE);
  assert.equal(messages[0].content, "界面操作（不是用户打的字）：用户在界面上发起的评审结束了。评审完成：1 条合规、1 条不合规（问题 1 处、建议 0 条）。各条发现可以用查询任务状态查看。");
  assert.deepEqual(messages[0].details.review, { total: 2, passed: 1, failed: 1, unfinished: 0, problems: 1, advice: 0 });
  assert.ok((status[REVIEW_STATUS_KEY] ?? []).length >= 3, "每记一条进度或结束事件都提示一次后端");
});

test("界面发起的评审：任务已完成、点名的条目修订号过期、没有待评审的条目都被拒", async () => {
  const dir = withTwoItems(reviewWorkspace());
  const { run, status } = commandRig(dir, async () => JSON.stringify({ 发现: [] }));
  await run({ op_id: "ui-op-s", kind: "request_review", targets: [{ item_id: "UC-001", base_revision: 7 }] });
  const stale = JSON.parse(status[USER_RESULT_KEY].at(-1)!);
  assert.equal(stale.ok, false);
  assert.match(stale.error.message, /UC-001 现在是修订 1/);

  withTaskDatabase(dir, { createIfMissing: false }, (db) => {
    for (const id of ["UC-001", "UC-002"]) {
      db.prepare("INSERT INTO review (task_id, item_id, revision_no, verdict, reason, rules_digest, reviewer_session_id, call_id, event_seq, created_at) VALUES ('TASK-001', ?, 1, '合规', '夹具', 'x', 'x', 'x', 1, 'x')").run(id);
    }
  });
  await run({ op_id: "ui-op-n", kind: "request_review", targets: [] });
  assert.match(JSON.parse(status[USER_RESULT_KEY].at(-1)!).error.message, /没有需要评审的条目/);

  withTaskDatabase(dir, { createIfMissing: false }, (db) => db.prepare("UPDATE task SET status = '已完成'").run());
  await run({ op_id: "ui-op-c", kind: "request_review", targets: [] });
  assert.equal(JSON.parse(status[USER_RESULT_KEY].at(-1)!).error.code, "task_closed");
});

// ───────────── 完成任务：开发期开关已退役，评审一条两类分开写 ─────────────

test("完成任务的拒绝文字把还没评审与评审不合规分开写；环境变量不再能让评审一条视为满足", async () => {
  const dir = withTwoItems(reviewWorkspace());
  await runReviews(callIn(dir), [{ item_id: "UC-002", revision_no: 1 }], { complete: fakeReviewer({ "UC-002": JSON.stringify({ 发现: [finding("D-R1", { 序号: 1 })] }) }).complete, model: "假" });
  process.env.TASKWRIGHT_DEV_REVIEW_AS_MET = "1";
  try {
    assert.throws(() => completeTask(callIn(dir)), /UC-001 还没评审；UC-002 评审不合规。/);
  } finally {
    delete process.env.TASKWRIGHT_DEV_REVIEW_AS_MET;
  }
});

// ───────────── 旧库补列、生成区一致 ─────────────

test("0.1 建的库：评审发现表缺规则编号与级别两列，写入一侧打开时补上", () => {
  const dir = withTwoItems(reviewWorkspace());
  const db = new DatabaseSync(databasePath(dir));
  db.exec("DROP TABLE review_finding; CREATE TABLE review_finding (review_id INTEGER NOT NULL, task_id TEXT NOT NULL, ordinal INTEGER NOT NULL, field TEXT NOT NULL, item_index INTEGER, problem TEXT NOT NULL, suggestion TEXT, PRIMARY KEY (review_id, ordinal))");
  db.close();
  withTaskDatabase(dir, { createIfMissing: false }, () => undefined);
  const columns = query<{ name: string }>(dir, "PRAGMA table_info(review_finding)").map((r) => r.name);
  assert.ok(columns.includes("rule_id") && columns.includes("level"), columns.join(","));
});

test("领域规矩文档里的规则列表与规则文件一致（渲染后没有差别）", () => {
  const docs = documents(resolve(import.meta.dirname, "../.."));
  assert.equal(docs.length, 2);
  for (const [path, typeDir] of docs) {
    const text = readFileSync(path, "utf-8");
    assert.equal(renderDocument(text, typeDir), text, `${path} 的生成区过期了，跑 node scripts/render-rules.mjs`);
  }
});
