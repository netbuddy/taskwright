/**
 * 总体分析的一页经保存修订保存时另外核对的两条（改看只在已废弃时写；已经定下的每一条都要有出处），
 * 以及完成条件之外「还没有贴标签」的提示。集合的字段照产品的任务类型（tests/helpers.ts 的 overallDefinition）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { completionHints, untaggedPages } from "../src/lib/conditions.ts";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { validateDefinition } from "../src/lib/definition.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { DEFINITION_PATH, READY_PAGE, SOURCE, callIn, demoDefinition, makeWorkspace, overallDefinition, query } from "./helpers.ts";

function workspace(definition: unknown = overallDefinition()): string {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}

/** 新增一页主题：没写的必填项给缺省值，没写来源就是一条文档原文（整页都出自它）。 */
const page = (fields: Record<string, unknown>, sources: unknown[] = [SOURCE]) =>
  ({ op: "add", collection: "总体分析", fields: { 标题: "预约取书", 它是什么: "读者对在架的书办预约。", 状态: "在用", ...fields }, sources });
const SUPPLEMENT = (supports: unknown[]) => ({ kind: "助手补充", excerpt: "高校图书馆常见的做法，等用户确认。", supports });
const fieldsOf = (dir: string, id: string) =>
  JSON.parse(query<{ fields: string }>(dir, "SELECT fields FROM item_version WHERE item_id = ? ORDER BY revision_no DESC LIMIT 1", id)[0].fields);
const taskId = (dir: string) => query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id;

test("这个集合的声明通过定义校验：标签是带取值的文本列表，上级主题与改看只许本集合、至多一个，分组字段是标签", () => {
  const definition = validateDefinition(overallDefinition());
  const collection = definition.collections.find((c) => c.name === "总体分析")!;
  assert.deepEqual([collection.prefix, collection.fields[0].name, collection.display?.groupField], ["OA", "标题", "标签"]);
  assert.deepEqual(collection.fields.filter((f) => f.single && f.sameCollection).map((f) => f.name), ["上级主题", "改看"]);
  assert.equal(collection.fields.find((f) => f.name === "标签")!.values!.length, 8);
});

test("一页主题照常保存：标签可以不贴，上级主题指向同一个集合里的一页", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [
    page({ 标题: "借阅" }),
    page({ 标题: "预约取书", 别名: ["预约"], 例子: ["小王周六预约了《算法导论》，周二来取。", "反例：小李想借的书还在别人手上，他登记的是排队，不是预约取书。"],
      标签: ["概念", "流程"], 上级主题: ["OA-001"] }),
  ] });
  assert.deepEqual([fieldsOf(dir, "OA-002").标签, fieldsOf(dir, "OA-002").上级主题, "标签" in fieldsOf(dir, "OA-001")], [["概念", "流程"], ["OA-001"], false]);
});

test("改看只在这一页已废弃时写；它只能指向一页主题", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [page({ 标题: "预约" }), page({ 标题: "预约取书" })] });
  assert.throws(() => saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-001", base_revision: 1, fields: { 改看: ["OA-002"] } }] }),
    /「改看」写了 OA-002，但这一页的状态不是已废弃[^]*怎么办：「改看」只在这一页不再用、由另一页取代时写：把状态改成已废弃，或者去掉「改看」/);
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-001", base_revision: 1, fields: { 状态: "已废弃", 改看: ["OA-002"] } }] });
  assert.deepEqual([fieldsOf(dir, "OA-001").状态, fieldsOf(dir, "OA-001").改看], ["已废弃", ["OA-002"]]);
  // 再改回在用而不去掉改看：拒绝；一起去掉就可以。
  assert.throws(() => saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-001", base_revision: 2, fields: { 状态: "在用" } }] }), /状态不是已废弃/);
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-001", base_revision: 2, fields: { 状态: "在用", 改看: [] } }] });
  // 新增时就写了改看而状态是在用：同样拒绝。
  assert.throws(() => saveRevision(callIn(dir), { operations: [page({ 标题: "预留", 改看: ["OA-002"] })] }), /状态不是已废弃/);
});

test("已经定下的每一条都要有出处：来源指到那一条、指到整个字段、或者整页都出自一条来源，都算；没有的拒绝并说出是第几条", () => {
  const dir = workspace();
  const settled = ["只有在架的书才能预约取书。", "保留期是 3 天。"];
  // 整页只有一条来源、没有写 supports：整页都出自它，两条已定都有出处。
  saveRevision(callIn(dir), { operations: [page({ 已经定下的: settled })] });
  // 两条来源各标到一条。
  saveRevision(callIn(dir), { operations: [page({ 标题: "保留期", 已经定下的: settled }, [
    { ...SOURCE, supports: [{ field: "它是什么" }, { field: "已经定下的", index: 0 }] }, SUPPLEMENT([{ field: "已经定下的", index: 1 }]),
  ])] });
  // 一条来源指到整个字段。
  saveRevision(callIn(dir), { operations: [page({ 标题: "预留架", 已经定下的: settled }, [
    { ...SOURCE, supports: [{ field: "它是什么" }] }, SUPPLEMENT([{ field: "已经定下的" }]),
  ])] });
  // 第二条没有来源指到。
  assert.throws(() => saveRevision(callIn(dir), { operations: [page({ 标题: "续借", 已经定下的: settled }, [
    { ...SOURCE, supports: [{ field: "它是什么" }, { field: "已经定下的", index: 0 }] }, SUPPLEMENT([{ field: "标题" }]),
  ])] }), /「已经定下的」的第 2 条「保留期是 3 天。」没有出处[^]*怎么办：每一条已经定下的都要有出处：在它出自的那条来源的 supports 里写 \{"field": "已经定下的", "index": 1\}/);
  // 修改时加了一条已定而没有给它出处：沿用下来的来源各有所指，新的一条没有，拒绝；给了就过。
  const more = [...settled, "保留期内这本书不能借给别人。"];
  assert.throws(() => saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-002", base_revision: 2, fields: { 已经定下的: more } }] }),
    /「已经定下的」的第 3 条「保留期内这本书不能借给别人。」没有出处/);
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-002", base_revision: 2, fields: { 已经定下的: more },
    sources: [{ kind: "助手补充", excerpt: "由「保留」的意思推出来的，等用户确认。", supports: [{ field: "已经定下的", index: 2 }] }] }] });
  assert.equal(fieldsOf(dir, "OA-002").已经定下的.length, 3);
  // 别的集合的列表字段没有这条要求（先有一页合格的主题，别的集合才能新增条目）。
  saveRevision(callIn(dir), { operations: [READY_PAGE] });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["选书", "预约"] },
    sources: [{ ...SOURCE, supports: [{ field: "名称" }] }, SUPPLEMENT([{ field: "步骤", index: 0 }])] }] });
});

test("完成条件之外的提示：总体分析里在用而还没有贴标签的主题；贴了标签、已废弃的不算；没有这个集合的任务没有这一种提示", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [page({ 标题: "借阅" }), page({ 标题: "预约取书", 标签: ["流程"] }), page({ 标题: "预留" }), page({ 标题: "旧说法", 状态: "已废弃" })] });
  const db = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    const completion = validateDefinition(overallDefinition()).completion;
    assert.deepEqual(untaggedPages(db, taskId(dir)), ["OA-001", "OA-003"]);
    assert.deepEqual(completionHints(db, taskId(dir), completion), [{
      kind: "untagged_overall_pages", collection: "总体分析", items: ["OA-001", "OA-003"],
      summary: "有 2 页主题还没有贴标签：OA-001、OA-003。贴了标签的主题才会进文档，评审也只认贴了标签的主题。",
    }]);
  } finally {
    db.close();
  }
  const old = workspace(demoDefinition());
  const oldDb = new DatabaseSync(databasePath(old), { readOnly: true });
  try {
    assert.deepEqual(completionHints(oldDb, taskId(old), validateDefinition(demoDefinition()).completion), []);
  } finally {
    oldDb.close();
  }
});
