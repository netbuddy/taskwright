/**
 * 只读读库与拼装：整份数据的序号与各表同一时刻、删掉的条目不在里面；评审、发现、批次、保留在整份数据里的样子；
 * 任务定义视图的评审部分与规则指纹；修订日志；修订带上用户行为；WAL 模式下的只读打开；读事务不留着。
 * 对应服务端 Python 测试 test_service_units、test_revision_intent、test_wal_read 的读取部分。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { openReadonly } from "../../agent/src/lib/task_read.ts";
import * as library from "../src/library.ts";
import * as render from "../src/render.ts";
import { ROOT, copyWorkspace, makeWorkspace, sqlGet, sqlRun, tempDir } from "./helpers.ts";

let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = makeWorkspace(tmp, "ws", true);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const lib = (dir: string) => library.libraryOf(dir);

test("整份数据的序号与各表同一时刻，删掉的条目不在里面，完成条件的形状", () => {
  const [seq, task] = library.taskSnapshot(ws);
  assert.equal(seq, 4);
  assert.deepEqual(task!.items.map((i) => i.item_id), ["UC-001", "TBD-001"]);
  const uc = task!.items[0];
  assert.deepEqual([uc.revision_no, uc.revisions, uc.revision_by, uc.reviews, uc.confirmations, uc.confirmation_stale], [2, [1, 2], "executor", [], [], false]);
  assert.ok(!Object.keys(uc).some((k) => k.startsWith("version_")), "修订统一之后不再带旧键名");
  assert.deepEqual(task!.definition.collections[0].fields[0], { name: "名称", type: "文本", required: true, values: null });
  const comp = task!.completion!;
  assert.deepEqual(Object.keys(comp).sort(), ["all_met", "brief", "conditions", "hints", "unmet_count"]);
  assert.deepEqual(comp.hints, [], "这个任务没有领域说明集合，没有提示");
  assert.deepEqual(Object.keys(comp.conditions[0]).sort(), ["collection", "done", "met", "missing", "name", "note", "state", "total"]);
});

test("读事务显式开、读完即提交，连接上不留读事务", () => {
  const db = library.openRo(ws)!;
  try {
    const data = library.readAll(db);
    assert.equal(data.seq, 4);
    assert.equal(db.isTransaction, false);
  } finally {
    db.close();
  }
});

test("评审记录带发现（规则编号与级别）进整份数据；旧库的发现表没有规则编号两列时读作空", () => {
  const copy = copyWorkspace(ws, join(tmp, "ws-reviewed"));
  const taskId = sqlGet(copy, "SELECT task_id FROM task")!.task_id;
  const findings = [
    { rule_id: "D-R1", level: "必选", field: "步骤", index: 1, problem: "没有主语", suggestion: "写明谁做" },
    { rule_id: "D-R2", level: "可选", field: "名称", index: null, problem: "举了例子", suggestion: null },
  ];
  sqlRun(copy, [["INSERT INTO review (task_id, item_id, revision_no, verdict, reason, rules_digest, reviewer_session_id, call_id, event_seq, created_at) " +
    "VALUES (?, 'UC-001', 2, '不合规', '问题 1 处，建议 1 条。', 'x', 'x', 'ui-op-r', 4, '2026-09-24 10:00:00')", taskId]]);
  const reviewId = sqlGet(copy, "SELECT MAX(review_id) AS id FROM review")!.id;
  sqlRun(copy, findings.map((f, i) => ["INSERT INTO review_finding (review_id, task_id, ordinal, field, item_index, problem, suggestion, rule_id, level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    reviewId, taskId, i + 1, f.field, f.index, f.problem, f.suggestion, f.rule_id, f.level] as [string, ...unknown[]]));
  const [, task] = library.taskSnapshot(copy);
  assert.deepEqual(task!.items.find((i) => i.item_id === "UC-001")!.reviews[0].findings, findings);

  const old = copyWorkspace(ws, join(tmp, "ws-old-findings"));
  sqlRun(old, [["DROP TABLE review_finding"],
    ["CREATE TABLE review_finding (review_id INTEGER NOT NULL, task_id TEXT NOT NULL, ordinal INTEGER NOT NULL, field TEXT NOT NULL, item_index INTEGER, problem TEXT NOT NULL, suggestion TEXT, PRIMARY KEY (review_id, ordinal))"],
    ["INSERT INTO review_finding VALUES (1, 't', 1, '步骤', NULL, '没有主语', NULL)"]]);
  const db = library.openRo(old)!;
  try {
    assert.deepEqual([...library.readFindings(db, "t")], [[1, [{ rule_id: null, level: null, field: "步骤", index: null, problem: "没有主语", suggestion: null }]]]);
  } finally {
    db.close();
  }
});

test("任务定义视图带上各集合要不要评审与生效的规则清单", () => {
  const dir = join(tmp, "ws-rules");
  mkdirSync(join(dir, "docs", "review-rules"), { recursive: true });
  writeFileSync(join(dir, "docs", "review-rules", "demo.json"), JSON.stringify([
    { 编号: "D-R1", 级别: "必选", 条文: "甲", 反例: "乙", 正例: "丙" },
    { 编号: "D-R2", 级别: "可选", 条文: "丁", 反例: "戊", 正例: "己" },
    { 编号: "D-R3", 级别: "可选", 条文: "庚", 反例: "辛", 正例: "壬" }]), "utf-8");
  const raw = { 交付物: { 条目集合: [{ 名称: "用例", 评审规矩: { 规则文件: "docs/review-rules/demo.json", 关闭: ["D-R3"], 升为必选: ["D-R2"] } }, { 名称: "问题" }] } };
  const parsed: any = { 集合: [{ 名称: "用例", 编号前缀: "UC", 字段: [] }, { 名称: "问题", 编号前缀: "TBD", 字段: [] }],
    完成条件: { 用例: ["每个条目评审通过"], 问题: ["没有状态为未解决的条目"] } };
  const [uc, tbd] = library.definitionView(parsed, JSON.stringify(raw), dir).collections;
  assert.equal(uc.needs_review, true);
  assert.deepEqual(uc.review_rules!.map((r: any) => [r.id, r.level]), [["D-R1", "必选"], ["D-R2", "必选"]]);
  assert.deepEqual(uc.review_rules![0], { id: "D-R1", level: "必选", text: "甲", counter_example: "乙", example: "丙" });
  assert.deepEqual([tbd.needs_review, tbd.review_rules], [false, null]);
});

test("规则指纹与 agent 同一个算法；全部规则带开关状态", () => {
  const text = JSON.stringify([{ 编号: "D-R1", 级别: "必选", 条文: "甲", 反例: "乙", 正例: "丙" }]);
  const script = `import('${join(ROOT, "agent", "src", "lib", "review_state.ts")}').then((m) => process.stdout.write(m.rulesHashText(process.argv[1], { off: ["D-R2"], promote: ["D-R3"] })))`;
  const agent = spawnSync(process.execPath, ["--input-type=module", "-e", script, text], { encoding: "utf-8" }).stdout;
  assert.equal(library.rulesHashText(text, ["D-R2"], ["D-R3"]), agent);
  const dir = join(tmp, "ws-all-rules");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "r.json"), JSON.stringify(["A", "B", "C", "D"].map((id, n) => ({ 编号: id, 级别: n === 0 ? "必选" : "可选", 条文: "", 反例: "", 正例: "" }))), "utf-8");
  const states = library.allRules(dir, { 规则文件: "docs/r.json", 关闭: ["B"], 升为必选: ["C"] })!.map((r) => r.state);
  assert.deepEqual(states, ["required", "off", "promoted", "optional"]);
});

test("评审批次、保留进整份数据；导出时写「评审不通过，用户保留（理由）」", () => {
  const copy = copyWorkspace(ws, join(tmp, "ws-lifecycle"));
  const taskId = sqlGet(copy, "SELECT task_id FROM task")!.task_id;
  const batch = { batch_id: "ui-op-b", started_by: "user", scope: "pending", items: [{ item_id: "UC-001", revision_no: 2 }],
    forced: [], total: 1, passed: 0, failed: 1, unfinished: 0, problems: 1, advice: 0 };
  sqlRun(copy, [
    ["INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) VALUES (5, ?, 's', 'ui-op-b', 'REVIEW_RECORDED', ?, 'user', '2026-09-24 10:00:00')",
      taskId, JSON.stringify({ item_id: "UC-001", revision_no: 2, verdict: "不合规", reason: "r", findings: [] })],
    ["INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) VALUES (6, ?, 's', 'ui-op-b', 'REVIEW_BATCH', ?, 'user', '2026-09-24 10:00:00')", taskId, JSON.stringify(batch)],
    ["INSERT INTO review (task_id, item_id, revision_no, verdict, reason, rules_digest, reviewer_session_id, call_id, event_seq, created_at, batch_id, rules_hash, forced) " +
      "VALUES (?, 'UC-001', 2, '不合规', 'r', 'x', 'x', 'ui-op-b', 5, '2026-09-24 10:00:00', 'ui-op-b', 'abc', 0)", taskId],
    ["INSERT INTO review_waiver (task_id, item_id, revision_no, reason, source, op_id, event_seq, created_at) VALUES (?, 'UC-001', 2, '材料原话如此', 'panel', 'ui-op-w', 7, '2026-09-24 10:01:00')", taskId],
  ]);
  const [, task] = library.taskSnapshot(copy);
  const uc1 = task!.items.find((i) => i.item_id === "UC-001")!;
  assert.equal(uc1.reviews[0].batch_id, "ui-op-b");
  assert.deepEqual(uc1.waivers, [{ revision_no: 2, reason: "材料原话如此", source: "panel", at: uc1.waivers[0].at, revoked: false }]);
  assert.deepEqual(task!.review_batches.map((b) => [b.no, b.batch_id, b.started_by, b.total, b.failed, b.problems]), [[1, "ui-op-b", "user", 1, 1, 1]]);
  assert.equal(render.reviewState(lib(copy), "UC-001", 2), "评审不通过，用户保留（理由：材料原话如此）");
});

test("修订日志最新在前，每项列出碰到的条目与改了哪些字段", () => {
  const log = library.revisionLog(ws)!;
  assert.deepEqual(log.map((r) => r.revision_no), [3, 2, 1]);
  assert.deepEqual(log[0].operations.map((op) => [op.op, op.item_id, op.revision_before, op.revision_after]), [["delete", "UC-002", 2, null]]);
  assert.equal(log[0].operations[0].title, "撤销申请", "删除的条目标题取删除前的内容");
  const second = Object.fromEntries(log[1].operations.map((op) => [op.item_id, op]));
  assert.deepEqual([second["UC-001"].op, second["UC-001"].fields_changed], ["update", ["名称"]]);
  assert.deepEqual([second["UC-002"].op, second["UC-002"].fields_changed], ["add", []], "新增不列字段");
  assert.deepEqual([log[2].by, log[2].undo_of_revision], ["executor", null]);
  assert.ok(log[2].call_id && log[2].session_id);
});

test("修订带上触发它的用户行为；对不上的与没有对话行为表的旧库为空", () => {
  const copy = copyWorkspace(ws, join(tmp, "ws-intent"));
  const taskId = sqlGet(copy, "SELECT task_id FROM task")!.task_id;
  sqlRun(copy, [
    ["INSERT INTO dialogue_act (task_id, session_id, act_id, run_id, speaker, function, targets, responds_to, expects_response, confidence, summary, source_entry, origin, event_seq, created_at) " +
      "VALUES (?, 'session-fixture', 'r2-1', 'r2', 'user', 'correct', '[]', NULL, 0, 'high', 'UC-001 的名称改为买家申请退款', 'entry-9', 'understanding', 3, '2026-01-01T00:00:09.000')", taskId],
    ["UPDATE revision SET intent_act_id = 'r2-1' WHERE revision_no = 2"],
  ]);
  const log = Object.fromEntries(library.revisionLog(copy)!.map((r) => [r.revision_no, r]));
  assert.deepEqual(log[2].intent, { act_id: "r2-1", function: "correct", function_name: "纠正", summary: "UC-001 的名称改为买家申请退款" });
  assert.equal(log[1].intent, null);

  const old = copyWorkspace(ws, join(tmp, "ws-no-acts"));
  sqlRun(old, [["DROP TABLE dialogue_act"], ["ALTER TABLE revision DROP COLUMN intent_act_id"]]);
  const oldLog = library.revisionLog(old)!;
  assert.deepEqual(oldLog.map((r) => r.revision_no), [3, 2, 1]);
  assert.ok(oldLog.every((r) => r.intent === null));
});

// ───────────── WAL 模式下的只读打开 ─────────────

const revisionCount = (dir: string) => {
  const db = openReadonly(join(dir, "task.sqlite"));
  try {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM revision").get() as any).n);
  } finally {
    db.close();
  }
};

test("写入工具写出的库是 WAL 模式；只读打开读得到只在 -wal 文件里的最新数据", () => {
  const copy = copyWorkspace(ws, join(tmp, "ws-wal"));
  assert.equal(sqlGet(copy, "PRAGMA journal_mode")!.journal_mode, "wal");
  const beforeCount = revisionCount(copy);
  const writer = new DatabaseSync(join(copy, "task.sqlite"));
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.exec("INSERT INTO revision (task_id, revision_no, session_id, call_id, event_seq, created_at, summary) " +
      "SELECT task_id, revision_no + 100, session_id, call_id || '-copy', event_seq, created_at, summary FROM revision LIMIT 1");
    assert.ok(existsSync(join(copy, "task.sqlite-wal")));
    assert.equal(revisionCount(copy), beforeCount + 1);
  } finally {
    writer.close();
  }
});

test("任务目录不可写、两个附属文件都不在时照样读得出", { skip: process.getuid?.() === 0 ? "root 不受目录权限限制" : false }, () => {
  const copy = copyWorkspace(ws, join(tmp, "ws-readonly-dir"));
  const clear = () => ["-wal", "-shm"].forEach((s) => rmSync(join(copy, `task.sqlite${s}`), { force: true }));
  clear();
  const expected = revisionCount(copy);
  clear();
  chmodSync(copy, 0o555);
  try {
    assert.equal(revisionCount(copy), expected);
    assert.equal(library.taskSnapshot(copy)[0], 4);
  } finally {
    chmodSync(copy, 0o755);
  }
});
