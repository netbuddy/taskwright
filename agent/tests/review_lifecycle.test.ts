/**
 * 评审的生命周期：规则指纹与规则改动后回到待评审、内容与规则都没变时重评要带 force、保留写法（写入、撤销、改出新修订后失效）、
 * 完成条件三类文字、材料全文与超长时按段落回退、改评审规则时必选规则关不掉、批次摘要事件、查询任务状态列出发现、温度 0 与回退。
 * 评审者的模型调用一律用假的。
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { ReviewError, prepareReviews } from "../src/lib/review.ts";
import { type Complete, runReviews } from "../src/lib/review_run.ts";
import { piComplete } from "../src/lib/review_ui.ts";
import { rulesHashText } from "../src/lib/review_state.ts";
import { UserOpError, runUserOperation } from "../src/lib/user_ops.ts";
import { completeTask } from "../src/lib/complete_task.ts";
import { getTaskStatus } from "../src/lib/task_query.ts";
import { DEFINITION_PATH, SOURCE, callIn, demoDefinition, makeWorkspace, query } from "./helpers.ts";

const RULES = [
  { 编号: "D-R1", 级别: "必选", 条文: "步骤写明谁做了什么。", 反例: "校验。", 正例: "系统校验口令。" },
  { 编号: "D-R2", 级别: "可选", 条文: "步骤里不举例。", 反例: "例如输错三次。", 正例: "输错三次锁定。" },
];

function workspace(): string {
  const definition = demoDefinition() as any;
  definition.交付物.条目集合[0].评审规矩 = { 规则文件: "docs/review-rules/demo.json" };
  const dir = makeWorkspace(definition);
  mkdirSync(join(dir, "docs/review-rules"), { recursive: true });
  writeFileSync(join(dir, "docs/review-rules/demo.json"), JSON.stringify(RULES), "utf-8");
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["用户输入口令", "校验"] }, sources: [SOURCE] },
    { op: "add", collection: "用例", fields: { 名称: "注销", 步骤: ["用户点注销"] }, sources: [SOURCE] },
  ] });
  return dir;
}

const FAIL = JSON.stringify({ 发现: [{ 规则: "D-R1", 字段: "步骤", 序号: 2, 问题: "第 2 步没有主语。", 建议: "写明是系统校验。" }] });
const PASS = JSON.stringify({ 发现: [] });

function reviewer(outputs: Record<string, string> = {}): { complete: Complete; users: string[]; options: unknown[] } {
  const users: string[] = [];
  return {
    users, options: [],
    complete: async (_s, user, _sig, _a, item) => { users.push(user); return { text: outputs[item.item_id] ?? PASS, inputTokens: 1, outputTokens: 1 }; },
  };
}

let op = 0;
const ui = (dir: string, body: Record<string, unknown>) => runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-t${++op}`, ...body });
const review = (dir: string, items: { item_id: string; revision_no: number }[] | null, outputs: Record<string, string> = {}, force = false) =>
  runReviews({ ...callIn(dir), callId: `ui-op-r${++op}`, actor: "user" }, items, { complete: reviewer(outputs).complete, model: "假", force });

test("规则改动后待评审集合变化，指纹写进评审记录", async () => {
  const dir = workspace();
  await review(dir, null, { "UC-001": FAIL });
  const fileText = readFileSync(join(dir, "docs/review-rules/demo.json"), "utf-8");
  const before = rulesHashText(fileText, { off: [], promote: [] });
  assert.deepEqual(query(dir, "SELECT DISTINCT rules_hash FROM review").map((r) => r.rules_hash), [before]);
  assert.throws(() => prepareReviews(dir, null), /没有需要评审的条目/);
  ui(dir, { kind: "set_review_rules", targets: [], fields: { collection: "用例", off: ["D-R2"], promote: [] } });
  assert.deepEqual(prepareReviews(dir, null).items.map((i) => i.item_id), ["UC-001", "UC-002"]);
  assert.equal(query(dir, "SELECT COUNT(*) AS n FROM review")[0].n, 2, "已有评审记录不变");
  const after = rulesHashText(fileText, { off: ["D-R2"], promote: [] });
  assert.notEqual(after, before);
  assert.equal(prepareReviews(dir, null).items[0].rulesHash, after);
  assert.ok(!prepareReviews(dir, null).items[0].user.includes("D-R2"), "关掉的规则不进清单");
  const changed = JSON.parse(query<{ payload: string }>(dir, "SELECT payload FROM event WHERE name = 'REVIEW_RULES_CHANGED'")[0].payload);
  assert.deepEqual([changed.collection, changed.off, changed.before.off, changed.rules_hash], ["用例", ["D-R2"], [], after]);
  assert.match(readFileSync(join(dir, DEFINITION_PATH), "utf-8"), /"关闭": \[\s*"D-R2"\s*\]/, "任务目录里的任务定义副本同步改了");
});

test("改评审规则：必选规则关不掉，不存在的编号被拒，与现在一样也被拒", () => {
  const dir = workspace();
  assert.throws(() => ui(dir, { kind: "set_review_rules", targets: [], fields: { collection: "用例", off: ["D-R1"], promote: [] } }),
    (e: UserOpError) => e.code === "rejected" && /D-R1，它是必选规则/.test(e.message));
  assert.throws(() => ui(dir, { kind: "set_review_rules", targets: [], fields: { collection: "用例", off: ["D-R9"], promote: [] } }), /没有这条规则/);
  assert.throws(() => ui(dir, { kind: "set_review_rules", targets: [], fields: { collection: "用例", off: [], promote: [] } }), /没有改动/);
  assert.throws(() => ui(dir, { kind: "set_review_rules", targets: [], fields: { collection: "问题", off: [], promote: [] } }), /没有评审规则/);
});

test("重评：点名一个在当前规则下评过、内容没变的条目，不带 force 拒绝并写明第几次评审；带 force 才评，记 forced", async () => {
  const dir = workspace();
  await review(dir, null);
  await assert.rejects(() => review(dir, [{ item_id: "UC-001", revision_no: 1 }]),
    (e: ReviewError) => /UC-001 在当前修订上已经评过（第 1 次评审），内容和规则都没变/.test(e.message));
  await review(dir, [{ item_id: "UC-001", revision_no: 1 }], {}, true);
  assert.deepEqual(query(dir, "SELECT item_id, forced FROM review ORDER BY review_id").map((r) => [r.item_id, r.forced]),
    [["UC-001", 0], ["UC-002", 0], ["UC-001", 1]]);
  const batches = query<{ payload: string }>(dir, "SELECT payload FROM event WHERE name = 'REVIEW_BATCH' ORDER BY seq").map((r) => JSON.parse(r.payload));
  assert.deepEqual(batches.map((b) => [b.scope, b.total, b.passed, b.started_by, b.forced]), [["pending", 2, 2, "user", []], ["named", 1, 1, "user", ["UC-001"]]]);
});

test("批次摘要：合规、不合规、问题、建议各几条；评审记录带批次编号与评审者版本", async () => {
  const dir = workspace();
  await review(dir, null, { "UC-001": FAIL });
  const batch = JSON.parse(query<{ payload: string; call_id: string }>(dir, "SELECT payload, call_id FROM event WHERE name = 'REVIEW_BATCH'")[0].payload);
  assert.deepEqual([batch.total, batch.passed, batch.failed, batch.unfinished, batch.problems, batch.advice], [2, 1, 1, 0, 1, 0]);
  const rows = query(dir, "SELECT batch_id, call_id, reviewer_version FROM review");
  assert.ok(rows.every((r) => r.batch_id === r.call_id && batch.batch_id === r.batch_id && String(r.reviewer_version).length === 16));
});

test("保留写法：只能保留评审不合规的；完成条件把它算作通过并单独写一类；撤销之后回到不通过；改出新修订后保留失效", async () => {
  const dir = workspace();
  await review(dir, null, { "UC-001": FAIL });
  assert.throws(() => ui(dir, { kind: "waive_review", targets: [{ item_id: "UC-002", base_revision: 1 }], fields: { reason: "x" } }), /没有评审不合规的记录/);
  const kept = ui(dir, { kind: "waive_review", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { reason: "材料原话如此", source: "panel" } });
  assert.match(kept.note, /用户保留了 UC-001（修订 1）现在的写法，理由：「材料原话如此」。这条按用户的决定算通过；条目再改动，评审要重做。/);
  assert.deepEqual(query(dir, "SELECT item_id, revision_no, reason, source, revoked_at FROM review_waiver").map((r) => [r.item_id, r.revision_no, r.reason, r.source, r.revoked_at]),
    [["UC-001", 1, "材料原话如此", "panel", null]]);
  assert.throws(() => ui(dir, { kind: "waive_review", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: {} }), /已经保留过了/);
  const status = getTaskStatus(dir).text;
  assert.match(status, /每个条目都评审通过，或由你保留了写法（UC-001 评审不合规但你保留了，按你的决定算通过）/);
  assert.match(status, /用户保留了写法的条目（这些按用户的决定算通过，不用改；条目再改动，评审要重做）：UC-001（修订 1，理由：材料原话如此）/);

  ui(dir, { kind: "unwaive_review", targets: [{ item_id: "UC-001", base_revision: 1 }] });
  assert.match(getTaskStatus(dir).text, /UC-001 评审不合规。/);
  assert.equal(query(dir, "SELECT name FROM event WHERE name LIKE 'REVIEW_%WAIVED' ORDER BY seq").map((r) => r.name).join(","), "REVIEW_WAIVED,REVIEW_UNWAIVED");

  ui(dir, { kind: "waive_review", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: {} });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "登录系统" } }] });
  assert.match(getTaskStatus(dir).text, /UC-001 还没评审。/, "改出新修订之后保留不再作数，条目回到待评审");
});

test("完成条件三类分开写：还没评审、评审不合规、评审不合规但你保留了", async () => {
  const definition = demoDefinition() as any;
  definition.交付物.条目集合[0].评审规矩 = { 规则文件: "docs/review-rules/demo.json" };
  const dir = makeWorkspace(definition);
  mkdirSync(join(dir, "docs/review-rules"), { recursive: true });
  writeFileSync(join(dir, "docs/review-rules/demo.json"), JSON.stringify(RULES), "utf-8");
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: ["甲", "乙", "丙"].map((name) => ({ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["一", "二"] }, sources: [SOURCE] })) });
  await review(dir, [{ item_id: "UC-002", revision_no: 1 }, { item_id: "UC-003", revision_no: 1 }], { "UC-002": FAIL, "UC-003": FAIL });
  ui(dir, { kind: "waive_review", targets: [{ item_id: "UC-003", base_revision: 1 }], fields: {} });
  assert.throws(() => completeTask(callIn(dir)), /UC-001 还没评审；UC-002 评审不合规；UC-003 评审不合规但你保留了。/);
});

test("材料全文：总长不超过上限时给全文；超过时只给来源所在的自然段，并写明不是全文", () => {
  const dir = workspace();
  const short = prepareReviews(dir, null).items[0].user;
  assert.match(short, /【材料全文】这个任务的全部材料：\n--- inputs\/材料.md ---\n# 登录与退款/);
  writeFileSync(join(dir, "inputs/附录.md"), "无关的段落。\n\n".repeat(3000), "utf-8");
  const long = prepareReviews(dir, null).items[0].user;
  assert.match(long, /【材料摘段】材料太长，你看到的不是材料全文，只是这个条目的来源所引的段落：\n--- inputs\/材料.md ---\n用户可以登录。登录总要输入口令。/);
  assert.ok(!long.includes("无关的段落"));
  assert.ok(!long.includes("退款须在七天内"), "没被引用的自然段不给");
});

test("查询任务状态列出评审不通过、还没处理的条目与发现（带规则编号与第几次评审）", async () => {
  const dir = workspace();
  await review(dir, null, { "UC-001": FAIL });
  assert.match(getTaskStatus(dir).text, /UC-001（修订 1，第 1 次评审）：\n    1\. 【问题 D-R1】步骤第 2 项：第 2 步没有主语。（改法：写明是系统校验。）/);
});

test("评审者调用温度设为 0；模型服务因为温度参数报错时去掉温度再调一次，之后不再传", async () => {
  const seen: unknown[] = [];
  let first = true;
  const ctx = {
    model: { provider: "假", id: `不认温度-${Date.now()}` },
    modelRegistry: {
      complete: async (_m: unknown, _c: unknown, options: any) => {
        seen.push(options.temperature);
        if (first && options.temperature !== undefined) { first = false; return { stopReason: "error", errorMessage: "Unsupported parameter: 'temperature'", content: [] }; }
        return { stopReason: "stop", usage: {}, content: [{ type: "text", text: PASS }] };
      },
    },
  } as any;
  const { complete } = piComplete(ctx, "ui-op-temp");
  const item = { item_id: "UC-001" } as any;
  await complete("s", "u", new AbortController().signal, 1, item);
  await complete("s", "u", new AbortController().signal, 1, item);
  assert.deepEqual(seen, [0, undefined, undefined]);
});
