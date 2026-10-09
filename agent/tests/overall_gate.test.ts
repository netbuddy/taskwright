/**
 * 保存修订里与总体分析有关的两道门：
 * - 最低门：助手往别的集合里新增条目之前，任务里要已经有一页在用的主题贴了标签、有例子、又不待核实；
 * - 条目的依据不能是已废弃的主题，写了改看的指给助手看。
 * 没有总体分析集合的任务（0.4 建的）不设最低门。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { SaveRejected, saveRevision } from "../src/lib/save_revision.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, demoDefinition, makeWorkspace, overallDefinition } from "./helpers.ts";

const SUPPLEMENT = (supports: unknown[]) => ({ kind: "助手补充", excerpt: "高校图书馆常见的做法，等用户确认。", supports });
const page = (fields: Record<string, unknown>, sources: unknown[] = [SOURCE]) =>
  ({ op: "add", collection: "总体分析", fields: { 标题: "预约取书", 它是什么: "读者对在架的书办预约。", 状态: "在用", ...fields }, sources });
const useCase = (name = "预约图书", sources: unknown[] = [SOURCE]) => ({ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["选书", "预约"] }, sources });
const problem = () => ({ op: "add", collection: "问题", fields: { 事项: "闭馆日算不算在保留期内？", 状态: "未解决" }, sources: [SOURCE] });
const EXAMPLE = "小王周六预约了《算法导论》，周二来取。";

function workspace(definition: unknown = overallDefinition()): string {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
let op = 0;
const view = (dir: string, itemId: string, revision: number) =>
  runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-gate-${++op}`, kind: "mark_viewed", targets: [{ item_id: itemId, base_revision: revision }] });

/** 保存被拒时的全文；没有被拒返回 null。 */
function refusal(dir: string, operations: unknown[]): string | null {
  try {
    saveRevision(callIn(dir), { operations });
    return null;
  } catch (error) {
    assert.ok(error instanceof SaveRejected, String(error));
    return error.message;
  }
}

test("最低门的四种情形：没有页；有页没有例子；有页有例子但待核实；合格", () => {
  const dir = workspace();
  // 一页都没有。
  assert.match(refusal(dir, [useCase()])!, /还没有想清楚的主题：总体分析里还没有一页主题[^]*怎么办：先在总体分析里立一页主题，写一个例子并确认，再写条目/);
  assert.equal(count(dir, "item"), 0, "整批没有写入");
  // 有一页贴了标签，没有例子。
  saveRevision(callIn(dir), { operations: [page({ 标签: ["流程"] })] });
  assert.match(refusal(dir, [useCase()])!, /还没有一页贴了标签、写了例子、又不待核实的主题（最接近的是 OA-001，它还没有例子）/);
  // 加了例子，但例子是助手补的，用户还没有确认：待核实。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-001", base_revision: 1, fields: { 例子: [EXAMPLE] }, sources: [SUPPLEMENT([{ field: "例子", index: 0 }])] }] });
  assert.match(refusal(dir, [useCase()])!, /最接近的是 OA-001，它还待核实）/);
  // 用户看过确认了：合格，条目存得进去。
  view(dir, "OA-001", 2);
  assert.equal(refusal(dir, [useCase()]), null);
  assert.equal(count(dir, "item"), 2);
});

test("最低门只看这次保存之前已有的页：同一批里先立页后写条目仍被拒；只拦新增，不拦修改与删除；不拦总体分析与问题集合", () => {
  const dir = workspace();
  const good = page({ 标签: ["流程"], 例子: [EXAMPLE] });
  // 同一批：页是这一批才新增的，条目被拒，整批都不写入。
  assert.match(refusal(dir, [good, useCase()])!, /操作 2（新增，集合「用例」）[^]*还没有想清楚的主题/);
  assert.equal(count(dir, "item"), 0);
  // 往总体分析与问题集合里新增不受这道门管。
  assert.equal(refusal(dir, [page({ 标题: "读者" }), problem()]), null);
  // 立了一页合格的（全是材料里的话，不待核实），下一次保存条目就过。
  saveRevision(callIn(dir), { operations: [good] });
  assert.equal(refusal(dir, [useCase()]), null);
  // 之后那一页被助手改得又待核实了：新增条目被拒，已有条目的修改与删除照常。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-002", base_revision: 2, fields: { 已经定下的: ["保留期是 3 天。"] }, sources: [SUPPLEMENT([{ field: "已经定下的", index: 0 }])] }] });
  assert.match(refusal(dir, [useCase("取书")])!, /最接近的是 OA-002，它还待核实/);
  assert.equal(refusal(dir, [{ op: "update", item: "UC-001", base_revision: 3, fields: { 步骤: ["选书", "预约", "取书"] } }]), null);
  assert.equal(refusal(dir, [{ op: "delete", item: "UC-001", base_revision: 5 }]), null);
});

test("没有总体分析集合的任务（0.4 建的）不设最低门", () => {
  const dir = workspace(demoDefinition());
  assert.equal(refusal(dir, [useCase()]), null);
});

test("条目的依据不能是已废弃的主题：写了改看的指出改看哪一页；同一批里刚废弃的也算；在用的照常", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [page({ 标题: "预约", 标签: ["概念"], 例子: [EXAMPLE] }), page({ 标题: "预约取书", 标签: ["流程"], 例子: [EXAMPLE] }), page({ 标题: "旧说法" })] });
  const cite = (id: string) => [{ kind: "条目", locator: id, excerpt: "读者对在架的书办预约。" }];
  assert.equal(refusal(dir, [useCase("预约图书", cite("OA-001"))]), null);
  saveRevision(callIn(dir), { operations: [
    { op: "update", item: "OA-001", base_revision: 1, fields: { 状态: "已废弃", 改看: ["OA-002"] } }, { op: "update", item: "OA-003", base_revision: 1, fields: { 状态: "已废弃" } },
  ] });
  assert.match(refusal(dir, [useCase("取书", cite("OA-001"))])!,
    /第 1 条来源的种类是「条目」，出处 OA-001 指向的主题 OA-001 已废弃[^]*怎么办：改看 OA-002：把出处改成 OA-002，摘录照它现在的内容抄/);
  assert.match(refusal(dir, [useCase("取书", cite("OA-003"))])!, /出处 OA-003 指向的主题 OA-003 已废弃[^]*怎么办：请改成依据现在在用的主题/);
  assert.equal(refusal(dir, [useCase("取书", cite("OA-002"))]), null);
  // 同一批里先把一页废弃、再让条目依据它：也被拒。
  assert.match(refusal(dir, [{ op: "update", item: "OA-002", base_revision: 1, fields: { 状态: "已废弃" } }, useCase("还书", cite("OA-002"))])!, /指向的主题 OA-002 已废弃/);
  // 沿用原来的来源（修改时不给新来源）不重新核对：依据已经废弃的那个用例照样改得了字段。
  assert.equal(refusal(dir, [{ op: "update", item: "UC-001", base_revision: 2, fields: { 步骤: ["选书", "预约", "等通知"] } }]), null);
});
