/**
 * 整份数据里总体分析的几项：每个条目的 pending_verification 与 pending_sources（待核实）、basis_pending（因依据的那一页而待核实）、
 * 总体分析各页的 mentioned_by（提到它的地方）；完成条件的提示里「还没有贴标签」的那一种。没有总体分析集合的任务不带 mentioned_by。
 * 任务库经子进程里助手一侧真实的保存函数建；用户的确认直接往确认标记的两张表里写（只在临时目录里）。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import * as library from "../src/library.ts";
import { DEMO_DEFINITION, ROOT, makeWorkspace, sqlGet, sqlRun, tempDir } from "./helpers.ts";

const BUILD = join(ROOT, "agent", "tests", "fixtures", "build_task_db.mts");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const MATERIAL = "读者对在架的书办预约。只有在架的书才能预约取书。\n";
const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "读者对在架的书办预约。" };
const SUPPLEMENT = (supports: unknown[]) => ({ kind: "助手补充", excerpt: "高校图书馆常见的做法，等用户确认。", supports });

/** 演示任务定义加一个总体分析集合（字段照产品的任务类型）。 */
const DEFINITION = {
  ...DEMO_DEFINITION,
  交付物: { ...DEMO_DEFINITION.交付物, 条目集合: [...DEMO_DEFINITION.交付物.条目集合, {
    名称: "总体分析", 编号前缀: "OA", 界面: { 右侧栏页签: true, 分组字段: "标签", 靠前的组: ["概念"] },
    字段: [
      { 名: "标题", 类型: "文本", 必填: true }, { 名: "别名", 类型: "文本列表", 必填: false }, { 名: "它是什么", 类型: "文本", 必填: true },
      { 名: "例子", 类型: "文本列表", 必填: false }, { 名: "已经定下的", 类型: "文本列表", 必填: false },
      { 名: "标签", 类型: "文本列表", 必填: false, 取值: ["概念", "角色", "流程", "场景", "目标", "范围", "假设", "决定"] },
      { 名: "上级主题", 类型: "条目引用", 必填: false, 只许本集合: true, 至多一个: true },
      { 名: "状态", 类型: "枚举", 必填: true, 取值: ["在用", "已废弃"] },
      { 名: "改看", 类型: "条目引用", 必填: false, 只许本集合: true, 至多一个: true },
    ],
  }] },
  完成条件: { ...DEMO_DEFINITION.完成条件, 总体分析: ["每个条目用户确认"] },
};

/** 建一个任务目录并按几批保存。 */
function build(name: string, definition: unknown, batches: unknown[]): string {
  const ws = join(tmp, name);
  mkdirSync(join(ws, "docs", "task-definitions"), { recursive: true });
  mkdirSync(join(ws, "inputs"), { recursive: true });
  writeFileSync(join(ws, "docs", "task-definitions", "demo.json"), JSON.stringify(definition), "utf-8");
  writeFileSync(join(ws, "inputs", "材料.md"), MATERIAL, "utf-8");
  const done = spawnSync(process.execPath, [BUILD, ws, "docs/task-definitions/demo.json", JSON.stringify(batches)], { encoding: "utf-8" });
  assert.equal(done.status, 0, done.stderr);
  return ws;
}

/** 记一条用户在某个条目的某次修订上的确认（已读）。 */
function confirm(ws: string, itemId: string, revisionNo: number): void {
  const taskId = sqlGet(ws, "SELECT task_id FROM task")!.task_id;
  const seq = Number(sqlGet(ws, "SELECT MAX(seq) AS seq FROM event")!.seq);
  const id = Number(sqlGet(ws, "SELECT COALESCE(MAX(judgement_id), 0) + 1 AS id FROM judgement")!.id);
  sqlRun(ws, [
    ["INSERT INTO judgement (judgement_id, task_id, basis, call_id, event_seq, created_at) VALUES (?, ?, ?, ?, ?, '2026-10-09 10:00:00')", id, taskId, JSON.stringify([{ 依据: "已读", 操作编号: `ui-op-${id}` }]), `ui-op-${id}`, seq],
    ["INSERT INTO judgement_item (judgement_id, task_id, item_id, revision_no, attitude, event_seq) VALUES (?, ?, ?, ?, '接受', ?)", id, taskId, itemId, revisionNo, seq],
  ]);
}

const page = (fields: Record<string, unknown>, sources: unknown[] = [SOURCE]) =>
  ({ op: "add", collection: "总体分析", fields: { 它是什么: "读者对在架的书办预约。", 状态: "在用", ...fields }, sources });

test("整份数据带待核实、因依据而待核实与提到；用户确认之后待核实消掉；提示里有还没有贴标签的主题", () => {
  const ws = build("overall", DEFINITION, [[
    page({ 标题: "预约取书", 别名: ["预约"], 标签: ["流程"], 已经定下的: ["保留期是 3 天。"] },
      [{ ...SOURCE, supports: [{ field: "它是什么" }] }, SUPPLEMENT([{ field: "已经定下的", index: 0 }])]),
    page({ 标题: "保留期", 它是什么: "预约取书的书在预留架上留着的那几天。" }, [SUPPLEMENT([])]),
    { op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["读者选一本在架的书", "读者办预约取书"] }, sources: [{ kind: "条目", locator: "OA-001", excerpt: "读者对在架的书办预约。" }] },
  ]]);
  const [, task] = library.taskSnapshot(ws);
  const item = (id: string) => task!.items.find((i) => i.item_id === id)! as Record<string, any>;
  assert.deepEqual([item("OA-001").pending_verification, item("OA-001").pending_sources, item("OA-001").basis_pending], [true, 1, null]);
  assert.deepEqual([item("OA-002").pending_verification, item("OA-002").pending_sources], [true, 1]);
  assert.deepEqual([item("UC-001").pending_verification, item("UC-001").pending_sources, item("UC-001").basis_pending], [false, 0, { item_id: "OA-001", reason: "pending", see: null }]);
  // 提到：OA-001 贴了标签，被 OA-002 与用例提到；OA-002 没有贴标签，不进词表，mentioned_by 是空列表；用例不带这一项。
  assert.deepEqual(item("OA-001").mentioned_by, [
    { item_id: "UC-001", collection: "用例", field: "名称", index: null, word: "预约", sentence: "预约图书", revision_no: 1 },
    { item_id: "UC-001", collection: "用例", field: "步骤", index: 1, word: "预约取书", sentence: "读者办预约取书", revision_no: 1 },
    { item_id: "OA-002", collection: "总体分析", field: "它是什么", index: null, word: "预约取书", sentence: "预约取书的书在预留架上留着的那几天。", revision_no: 1 },
  ]);
  assert.deepEqual([item("OA-002").mentioned_by, "mentioned_by" in item("UC-001")], [[], false]);
  assert.deepEqual(task!.completion!.hints.map((h: any) => [h.kind, h.collection, h.items, h.summary]),
    [["untagged_overall_pages", "总体分析", ["OA-002"], "有 1 页主题还没有贴标签：OA-002。贴了标签的主题才会进文档，评审也只认贴了标签的主题。"]]);
  // 定义视图：标签字段带取值，上级主题只许本集合、至多一个，分组字段是标签。
  const collection = task!.definition.collections.find((c) => c.name === "总体分析")!;
  assert.deepEqual(collection.fields.filter((f) => f.same_collection && f.single).map((f) => f.name), ["上级主题", "改看"]);
  assert.deepEqual([collection.fields.find((f) => f.name === "标签")!.values?.length, collection.display?.group_field], [8, "标签"]);

  // 用户确认了 OA-001 当前的修订：它不再待核实，依据它的用例也不再因它而待核实；OA-002 没有确认，照旧。
  confirm(ws, "OA-001", 1);
  const [, after] = library.taskSnapshot(ws);
  const now = (id: string) => after!.items.find((i) => i.item_id === id)! as Record<string, any>;
  assert.deepEqual([now("OA-001").pending_verification, now("OA-001").pending_sources, now("UC-001").basis_pending, now("OA-002").pending_verification], [false, 0, null, true]);
});

test("被依据的那一页已废弃：依据它的条目带 basis_pending，reason 是 deprecated，see 是它写的改看", () => {
  const ws = build("deprecated", DEFINITION, [
    [page({ 标题: "预约" }), page({ 标题: "预约取书" }),
      { op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["选书"] }, sources: [{ kind: "条目", locator: "OA-001", excerpt: "读者对在架的书办预约。" }] }],
    [{ op: "update", item: "OA-001", base_revision: 1, fields: { 状态: "已废弃", 改看: ["OA-002"] } }],
  ]);
  const [, task] = library.taskSnapshot(ws);
  const useCase = task!.items.find((i) => i.item_id === "UC-001")! as Record<string, any>;
  assert.deepEqual(useCase.basis_pending, { item_id: "OA-001", reason: "deprecated", see: "OA-002" });
  // 依据的条目改过了，现有的「依据已变」照旧标着。
  assert.deepEqual(useCase.sources.map((s: any) => [s.locator, s.stale]), [["OA-001", "changed"]]);
});

test("没有总体分析集合的任务：待核实照样算，条目不带 mentioned_by，没有这一种提示", () => {
  const ws = makeWorkspace(tmp, "old", true);
  const [, task] = library.taskSnapshot(ws);
  for (const item of task!.items as Record<string, any>[]) {
    assert.deepEqual([typeof item.pending_verification, typeof item.pending_sources, item.basis_pending, "mentioned_by" in item], ["boolean", "number", null, false], item.item_id);
  }
  assert.deepEqual(task!.completion!.hints, []);
});
