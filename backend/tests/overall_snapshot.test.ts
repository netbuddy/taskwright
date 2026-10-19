/**
 * 整份数据里业务说明的几项：每个条目的 pending_verification 与 pending_sources（待核实）、basis_pending（因依据的那一页而待核实）、
 * 业务说明各页的 mentioned_by（提到它的地方）；完成条件的提示里「还没有贴标签」的那一种。没有业务说明集合的任务不带 mentioned_by。
 * 任务库经子进程里助手一侧真实的保存函数建；用户的确认直接往确认标记的两张表里写（只在临时目录里）。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import * as library from "../src/library.ts";
import { makeWorkspace, tempDir } from "./helpers.ts";
import { DEFINITION, READY, SOURCE, SUPPLEMENT, build as buildIn, confirm, page, userOps } from "./overall_stack.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const build = (name: string, definition: unknown, batches: unknown[]) => buildIn(tmp, name, definition, batches);


test("整份数据带待核实、因依据而待核实与提到；用户确认之后待核实消掉；提示里有还没有贴标签的主题", () => {
  const ws = build("overall", DEFINITION, [[
    page({ 标题: "预约取书", 别名: ["预约"], 标签: ["流程"], 已经定下的: ["保留期是 3 天。"] },
      [{ ...SOURCE, supports: [{ field: "它是什么" }] }, SUPPLEMENT([{ field: "已经定下的", index: 0 }])]),
    page({ 标题: "保留期", 它是什么: "预约取书的书在预留架上留着的那几天。" }, [SUPPLEMENT([{ field: "它是什么" }], "预留架")]),
  ], [READY], { view: ["OA-003"] }, [
    { op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["读者选一本在架的书", "读者办预约取书"] }, sources: [{ kind: "条目", locator: "OA-001", excerpt: "读者对在架的书办预约。" }] },
  ]]);
  const [, task] = library.taskSnapshot(ws);
  const item = (id: string) => task!.items.find((i) => i.item_id === id)! as Record<string, any>;
  assert.deepEqual([item("OA-001").pending_verification, item("OA-001").pending_sources, item("OA-001").pending_places, item("OA-001").basis_pending],
    [true, 1, [{ field: "已经定下的", index: 0 }], null]);
  // OA-002 的助手补充指到「它是什么」。
  assert.deepEqual([item("OA-002").pending_verification, item("OA-002").pending_sources, item("OA-002").pending_places], [true, 1, [{ field: "它是什么", index: null }]]);
  assert.deepEqual([item("UC-001").pending_verification, item("UC-001").pending_sources, item("UC-001").pending_places, item("UC-001").basis_pending],
    [false, 0, [], { item_id: "OA-001", reason: "pending", see: null }]);
  // 提到：OA-001 贴了标签，被 OA-002 与用例提到；OA-002 没有贴标签，不进词表，mentioned_by 是空列表；用例不带这一项。
  assert.deepEqual(item("OA-001").mentioned_by, [
    { item_id: "UC-001", collection: "用例", field: "名称", index: null, word: "预约", sentence: "预约图书", revision_no: 1 },
    { item_id: "UC-001", collection: "用例", field: "步骤", index: 1, word: "预约取书", sentence: "读者办预约取书", revision_no: 1 },
    { item_id: "OA-002", collection: "业务说明", field: "它是什么", index: null, word: "预约取书", sentence: "预约取书的书在预留架上留着的那几天。", revision_no: 1 },
  ]);
  assert.deepEqual([item("OA-002").mentioned_by, "mentioned_by" in item("UC-001")], [[], false]);
  assert.deepEqual(task!.completion!.hints.map((h: any) => [h.kind, h.collection, h.items, h.summary]),
    [["untagged_overall_pages", "业务说明", ["OA-002"], "有 1 页主题还没有贴标签：OA-002。贴了标签的主题才会进文档，评审也只认贴了标签的主题。"]]);
  // 定义视图：标签字段带取值，上级主题只许本集合、至多一个，分组字段是标签。
  const collection = task!.definition.collections.find((c) => c.name === "业务说明")!;
  assert.deepEqual(collection.fields.filter((f) => f.same_collection && f.single).map((f) => f.name), ["上级主题", "改看"]);
  assert.deepEqual([collection.fields.find((f) => f.name === "标签")!.values?.length, collection.display?.group_field], [8, "标签"]);

  // 用户确认了 OA-001 当前的修订：它不再待核实，依据它的用例也不再因它而待核实；OA-002 没有确认，照旧。
  confirm(ws, "OA-001", 1);
  const [, after] = library.taskSnapshot(ws);
  const now = (id: string) => after!.items.find((i) => i.item_id === id)! as Record<string, any>;
  assert.deepEqual([now("OA-001").pending_verification, now("OA-001").pending_sources, now("UC-001").basis_pending, now("OA-002").pending_verification], [false, 0, null, true]);
});

test("用户亲手改只确认他改到的那几处：只贴标签不算；改到助手补充的那一处才消；打开看过之后整页确认，之后再改也不丢", () => {
  const ws = build("by-place", DEFINITION, [[
    page({ 标题: "预约取书", 已经定下的: ["只有在架的书才能预约取书。", "保留期是 3 天。"], 例子: ["小王周六预约了一本书。"] },
      [{ ...SOURCE, supports: [{ field: "它是什么" }] }, { kind: "文档原文", locator: "inputs/材料.md", excerpt: "只有在架的书才能预约取书。", supports: [{ field: "已经定下的", index: 0 }] },
        SUPPLEMENT([{ field: "已经定下的", index: 1 }]), { kind: "助手补充", excerpt: "照材料里的做法举的例子，等用户确认。", supports: [{ field: "例子", index: 0, inserted: ["小王周六预约了一本书"] }] }]),
  ]]);
  const pending = () => {
    const item = library.taskSnapshot(ws)[1]!.items.find((i) => i.item_id === "OA-001")! as Record<string, any>;
    return [item.revision_no, item.pending_verification, item.pending_sources, item.pending_places];
  };
  assert.deepEqual(pending(), [1, true, 2, [{ field: "已经定下的", index: 1 }, { field: "例子", index: 0 }]]);
  // 用户只贴了标签：产生修订 2，这次修订上记着用户修改带来的确认，但助手补充的两处他都没有改到，仍待核实。
  userOps(ws, [{ kind: "edit_fields", targets: [{ item_id: "OA-001", base_revision: 1 }], fields: { 标签: ["流程"] } }]);
  assert.deepEqual(pending(), [2, true, 2, [{ field: "已经定下的", index: 1 }, { field: "例子", index: 0 }]]);
  // 用户亲手改了例子：例子那一处确认了，剩下已经定下的第 2 条。
  userOps(ws, [{ kind: "edit_fields", targets: [{ item_id: "OA-001", base_revision: 2 }], fields: { 例子: ["小李周一预约了《算法导论》。"] } }]);
  assert.deepEqual(pending(), [3, true, 1, [{ field: "已经定下的", index: 1 }]]);
  // 用户打开看过现在这一次修订（这次修订上已经有用户修改带来的接受，已读仍要记下）：整页确认。
  userOps(ws, [{ kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 3 }] }]);
  assert.deepEqual(pending(), [3, false, 0, []]);
  // 看过之后用户自己再改别处：确认不丢。
  userOps(ws, [{ kind: "edit_fields", targets: [{ item_id: "OA-001", base_revision: 3 }], fields: { 别名: ["预约"] } }]);
  assert.deepEqual(pending(), [4, false, 0, []]);
});

test("被依据的那一页已废弃：依据它的条目带 basis_pending，reason 是 deprecated，see 是它写的改看", () => {
  const ws = build("deprecated", DEFINITION, [
    [page({ 标题: "预约" }), page({ 标题: "预约取书" })], [READY], { view: ["OA-003"] },
    [{ op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["选书"] }, sources: [{ kind: "条目", locator: "OA-001", excerpt: "读者对在架的书办预约。" }] }],
    [{ op: "update", item: "OA-001", base_revision: 1, fields: { 状态: "已废弃", 改看: ["OA-002"] } }],
  ]);
  const [, task] = library.taskSnapshot(ws);
  const useCase = task!.items.find((i) => i.item_id === "UC-001")! as Record<string, any>;
  assert.deepEqual(useCase.basis_pending, { item_id: "OA-001", reason: "deprecated", see: "OA-002" });
  // 依据的条目改过了，现有的「依据已变」照旧标着。
  assert.deepEqual(useCase.sources.map((s: any) => [s.locator, s.stale]), [["OA-001", "changed"]]);
});

test("整份数据带从业务说明算出来的三张表：规则表（冲突标在规则上）、业务目标、决策记录与待澄清事项", () => {
  // 问题集合照产品的任务类型：状态里有「用户决定保留」，另有种类与建议的处理两个字段。
  const collections = DEFINITION.交付物.条目集合.map((one) => (one.名称 === "待定事项" ? { ...one, 字段: [
    { 名: "事项", 类型: "文本", 必填: true }, { 名: "种类", 类型: "枚举", 必填: false, 取值: ["待澄清", "范围外"] }, { 名: "建议的处理", 类型: "文本", 必填: false },
    { 名: "状态", 类型: "枚举", 必填: true, 取值: ["未解决", "已解决", "用户决定保留"] }, { 名: "关联条目", 类型: "条目引用", 必填: false }] } : one));
  const definition = { ...DEFINITION, 交付物: { ...DEFINITION.交付物, 条目集合: collections } };
  const rule = (index: number) => ({ ...SOURCE, supports: [{ field: "已经定下的", index }] });
  const what = { ...SOURCE, supports: [{ field: "它是什么" }] };
  const ws = build("views", definition, [[
    page({ 标题: "少排队", 标签: ["目标"] }),
    page({ 标题: "只约在架的书", 标签: ["决定"], 上级主题: ["OA-001"], 已经定下的: ["只有在架的书才能预约。"] }, [what, rule(0)]),
    page({ 标题: "预约取书", 标签: ["流程"], 已经定下的: ["借出的书也可以预约。", "保留期是 3 天。"] }, [what, rule(0), rule(1)]),
    page({ 标题: "不收押金", 标签: ["决定"] }),
  ], [
    { op: "add", collection: "待定事项", fields: { 事项: "规则冲突：借出的书能不能预约", 种类: "待澄清", 建议的处理: "照馆里现在的做法定。", 状态: "未解决", 关联条目: ["OA-002", "OA-003"] },
      sources: [{ kind: "条目", locator: "OA-002", excerpt: "只有在架的书才能预约。", supports: [{ field: "事项" }] }, { kind: "条目", locator: "OA-003", excerpt: "借出的书也可以预约。", supports: [{ field: "事项" }] }] },
    { op: "add", collection: "待定事项", fields: { 事项: "保留期过了怎么办", 种类: "范围外", 状态: "未解决" }, sources: [SOURCE] },
  ]]);
  const views = library.taskSnapshot(ws)[1]!.overall_views!;
  assert.deepEqual(views.rules.rows.map((row) => [row.item_id, row.title, row.index, row.text, row.sources.map((s) => s.kind), row.conflicts]), [
    ["OA-002", "只约在架的书", 0, "只有在架的书才能预约。", ["文档原文"], ["TBD-001"]],
    ["OA-003", "预约取书", 0, "借出的书也可以预约。", ["文档原文"], ["TBD-001"]],
    ["OA-003", "预约取书", 1, "保留期是 3 天。", ["文档原文"], []],
  ]);
  assert.deepEqual([views.rules.conflicts, views.rules.unmatched], [["TBD-001"], []]);
  assert.deepEqual(views.goals, {
    roots: [{ item_id: "OA-001", title: "少排队", goals: [], decisions: [{ item_id: "OA-002", title: "只约在架的书", why: "只有在架的书才能预约。" }] }],
    loose: [{ item_id: "OA-004", title: "不收押金", why: "读者对在架的书办预约。" }],
  });
  // 两页决定与两条还没有了结的问题，按第一次保存的时刻；不是规则冲突的问题不进规则表。
  assert.deepEqual(views.decisions.map((row) => [row.entry, row.item_id, row.title, row.note, row.question_kind]), [
    ["decision", "OA-002", "只约在架的书", "只有在架的书才能预约。", null],
    ["decision", "OA-004", "不收押金", "读者对在架的书办预约。", null],
    ["question", "TBD-001", "规则冲突：借出的书能不能预约", "照馆里现在的做法定。", "待澄清"],
    ["question", "TBD-002", "保留期过了怎么办", "", "范围外"],
  ]);
  assert.ok(views.decisions.every((row) => typeof row.at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(row.at)));
  // 灯与规则表说的是同一回事。
  assert.deepEqual(Object.values(library.taskSnapshot(ws)[1]!.stage!.lamps).flat().find((one) => one.key === "rules_no_conflict")!.items, ["TBD-001"]);
});

test("没有业务说明集合的任务：待核实照样算，条目不带 mentioned_by，没有这一种提示；三张表是 null", () => {
  const ws = makeWorkspace(tmp, "old", true);
  const [, task] = library.taskSnapshot(ws);
  assert.equal(task!.overall_views, null);
  for (const item of task!.items as Record<string, any>[]) {
    assert.deepEqual([typeof item.pending_verification, typeof item.pending_sources, Array.isArray(item.pending_places), item.basis_pending, "mentioned_by" in item],
      ["boolean", "number", true, null, false], item.item_id);
  }
  assert.deepEqual(task!.completion!.hints, []);
});

test("被依据的那一页没有待核实的内容、但用户还没有看过：依据它的条目带 basis_pending，reason 是 unviewed；用户看过之后消掉", () => {
  const ws = build("unviewed", DEFINITION, [
    [page({ 标题: "预约" })], [READY], { view: ["OA-002"] },
    [{ op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["选书"] }, sources: [{ kind: "条目", locator: "OA-001", excerpt: "读者对在架的书办预约。" }] }],
  ]);
  const basisOf = () => (library.taskSnapshot(ws)[1]!.items.find((i) => i.item_id === "UC-001")! as Record<string, any>).basis_pending;
  // OA-001 全部照抄材料，不待核实；用户看过的是另一页（OA-002）。
  assert.deepEqual(basisOf(), { item_id: "OA-001", reason: "unviewed", see: null });
  confirm(ws, "OA-001", 1);
  assert.equal(basisOf(), null);
});
