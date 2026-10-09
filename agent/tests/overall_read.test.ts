/**
 * 从任务库读出总体分析那几样（src/lib/overall_read.ts），经真实的保存修订与用户的界面操作造数据：
 * 待核实的四种情形（助手补充未确认、用户看过之后、助手再改之后、用户亲手改之后），因依据而待核实，提到；
 * 以及助手查看条目、查询任务状态时读到的说法。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { validateDefinition } from "../src/lib/definition.ts";
import { overallState } from "../src/lib/overall_read.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { getItem, getTaskStatus } from "../src/lib/task_query.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, READY_PAGE, SOURCE, callIn, demoDefinition, makeWorkspace, overallDefinition, query } from "./helpers.ts";

const SUPPLEMENT = (supports: unknown[]) => ({ kind: "助手补充", excerpt: "高校图书馆常见的做法，等用户确认。", supports });
const page = (fields: Record<string, unknown>, sources: unknown[] = [SOURCE]) =>
  ({ op: "add", collection: "总体分析", fields: { 标题: "预约取书", 它是什么: "读者对在架的书办预约。", 状态: "在用", ...fields }, sources });

function workspace(definition: Record<string, any> = overallDefinition()): string {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
let op = 0;
const ui = (dir: string, body: Record<string, unknown>) => runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-oa-${++op}`, ...body });
function stateOf(dir: string, definition: Record<string, any> = overallDefinition()) {
  const db = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    return overallState(db, query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id, validateDefinition(definition));
  } finally {
    db.close();
  }
}
const pendingOf = (dir: string, id: string) => {
  const one = stateOf(dir).verification.get(id)!;
  return [one.pending_verification, one.pending_sources];
};

test("待核实：助手补充未确认；用户看过之后；助手再改之后；用户亲手改只确认改到的那几处，只贴标签不算；看过之后再改不丢", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [
    page({ 已经定下的: ["只有在架的书才能预约取书。", "保留期是 3 天。"] },
      [{ ...SOURCE, supports: [{ field: "它是什么" }, { field: "已经定下的", index: 0 }] }, SUPPLEMENT([{ field: "已经定下的", index: 1 }])]),
    page({ 标题: "读者" }),
  ] });
  // 助手补充了一处，用户还没有确认；没有助手补充的那一页不待核实。
  assert.deepEqual([pendingOf(dir, "OA-001"), pendingOf(dir, "OA-002")], [[true, 1], [false, 0]]);
  // 用户打开看过（现有的「已读即确认」）：不再待核实。
  ui(dir, { kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 1 }] });
  assert.deepEqual(pendingOf(dir, "OA-001"), [false, 0]);
  // 助手之后又改：新修订上没有确认，沿用下来的那一处助手补充又待核实。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-001", base_revision: 1, fields: { 例子: ["小王周六预约了《算法导论》，周二来取。"] },
    sources: [{ kind: "助手补充", excerpt: "为了说明流程编的一个例子，等用户确认。", supports: [{ field: "例子", index: 0 }] }] }] });
  assert.deepEqual(pendingOf(dir, "OA-001"), [true, 2]);
  // 用户亲手改了「它是什么」：助手补的两处（已经定下的第 2 条、例子）他没有改到，仍待核实。
  ui(dir, { kind: "edit_fields", targets: [{ item_id: "OA-001", base_revision: 2 }], fields: { 它是什么: "读者对一本在架的书办预约，馆员把书放到预留架。" } });
  assert.deepEqual(pendingOf(dir, "OA-001"), [true, 2]);
  assert.deepEqual(stateOf(dir).verification.get("OA-001")!.pending_places, [{ field: "已经定下的", index: 1 }, { field: "例子", index: 0 }]);
  // 用户只贴了标签：不算确认。
  ui(dir, { kind: "edit_fields", targets: [{ item_id: "OA-001", base_revision: 3 }], fields: { 标签: ["概念"] } });
  assert.deepEqual(pendingOf(dir, "OA-001"), [true, 2]);
  // 用户亲手改了例子：例子那一处确认了，剩下已经定下的第 2 条。
  ui(dir, { kind: "edit_fields", targets: [{ item_id: "OA-001", base_revision: 4 }], fields: { 例子: ["小李周一预约了《算法导论》，周三来取。"] } });
  assert.deepEqual([pendingOf(dir, "OA-001"), stateOf(dir).verification.get("OA-001")!.pending_places], [[true, 1], [{ field: "已经定下的", index: 1 }]]);
  // 用户打开看过现在这一次修订：整页确认。
  ui(dir, { kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 5 }] });
  assert.deepEqual(pendingOf(dir, "OA-001"), [false, 0]);
  // 看过之后用户自己再改别处：确认不丢。
  ui(dir, { kind: "edit_fields", targets: [{ item_id: "OA-001", base_revision: 5 }], fields: { 别名: ["预约"] } });
  assert.deepEqual(pendingOf(dir, "OA-001"), [false, 0]);
});

test("因依据而待核实：条目依据的那一页待核实或已废弃；那一页确认之后就不是了；只看一层", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [
    page({ 标题: "预约取书", 已经定下的: ["保留期是 3 天。"] }, [{ ...SOURCE, supports: [{ field: "它是什么" }] }, SUPPLEMENT([{ field: "已经定下的", index: 0 }])]),
    page({ 标题: "保留期", 它是什么: "保留期是 3 天。" }, [{ kind: "条目", locator: "OA-001", excerpt: "保留期是 3 天。" }]),
  ] });
  // 先有一页合格的主题（OA-003），别的集合才能新增条目。
  saveRevision(callIn(dir), { operations: [READY_PAGE] });
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["选书", "预约，保留期是 3 天。"] }, sources: [{ kind: "条目", locator: "OA-002", excerpt: "保留期是 3 天。" }] },
  ] });
  const basis = (id: string) => stateOf(dir).verification.get(id)!.basis_pending;
  // OA-002 依据 OA-001（待核实）；用例依据 OA-002，OA-002 自己没有助手补充，所以用例不受牵连（只看一层）。
  assert.deepEqual([basis("OA-002"), basis("UC-001"), pendingOf(dir, "OA-002")], [{ item_id: "OA-001", reason: "pending", see: null }, null, [false, 0]]);
  ui(dir, { kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 1 }] });
  assert.equal(basis("OA-002"), null);
  // 被依据的那一页废弃了并写了改看：依据它的条目因此待核实。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-002", base_revision: 1, fields: { 状态: "已废弃", 改看: ["OA-001"] } }] });
  assert.deepEqual(basis("UC-001"), { item_id: "OA-002", reason: "deprecated", see: "OA-001" });
});

test("助手读到的说法：查看条目写待核实与提到它的地方，查询任务状态合计待核实的条目", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [
    page({ 标题: "预约取书", 别名: ["预约"], 标签: ["流程"], 已经定下的: ["保留期是 3 天。"] },
      [{ ...SOURCE, supports: [{ field: "它是什么" }] }, SUPPLEMENT([{ field: "已经定下的", index: 0 }])]),
    page({ 标题: "保留期", 标签: ["概念"], 它是什么: "预约取书的书在预留架上留着的那几天。" }),
  ] });
  saveRevision(callIn(dir), { operations: [READY_PAGE] });
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["读者选一本在架的书", "读者办预约取书"] }, sources: [{ kind: "条目", locator: "OA-001", excerpt: "读者对在架的书办预约。" }] },
  ] });
  const item = getItem(dir, { item_id: "OA-001" });
  assert.match(item.text, /待核实：OA-001 有 1 处是助手补充的，用户还没有确认（「已经定下的」第 1 项）。/);
  assert.match(item.text, /提到它的地方（3 处）：\n  OA-002 的「它是什么」：「预约取书的书在预留架上留着的那几天。」\n  UC-001 的「名称」：「预约图书」\n  UC-001 的「步骤」第 2 项：「读者办预约取书」/);
  assert.deepEqual([(item.details as any).pending_verification, (item.details as any).pending_sources, (item.details as any).pending_places, (item.details as any).mentioned_by.length],
    [true, 1, [{ field: "已经定下的", index: 0 }], 3]);
  const useCase = getItem(dir, { item_id: "UC-001" });
  assert.match(useCase.text, /待核实：它依据的主题 OA-001 还待核实/);
  assert.deepEqual((useCase.details as any).basis_pending, { item_id: "OA-001", reason: "pending", see: null });
  assert.equal("mentioned_by" in (useCase.details as any), false);
  assert.match(getTaskStatus(dir).text, /待核实的条目：有助手补充而用户还没有确认的 1 个：OA-001；依据的主题待核实或已废弃的 1 个：UC-001。/);
  // 用户看过之后这两句都没有了；废弃之后查看依据它的条目时写改看。
  ui(dir, { kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 1 }] });
  assert.doesNotMatch(getItem(dir, { item_id: "OA-001" }).text, /待核实/);
  assert.doesNotMatch(getTaskStatus(dir).text, /待核实的条目/);
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-001", base_revision: 1, fields: { 状态: "已废弃", 改看: ["OA-002"] } }] });
  assert.match(getItem(dir, { item_id: "UC-001" }).text, /待核实：它依据的主题 OA-001 已废弃，改看 OA-002；请改成依据现在在用的主题。/);
});

test("没有总体分析集合的任务（0.4 建的）：待核实照样算，没有提到，查看条目照旧", () => {
  const dir = workspace(demoDefinition() as Record<string, any>);
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面", "输入口令"] },
    sources: [{ ...SOURCE, supports: [{ field: "名称" }] }, SUPPLEMENT([{ field: "步骤" }])] }] });
  const state = stateOf(dir, demoDefinition() as Record<string, any>);
  assert.deepEqual([state.verification.get("UC-001"), state.mentions.size, state.pages], [{ pending_verification: true, pending_sources: 1, pending_places: [{ field: "步骤", index: null }], basis_pending: null }, 0, []]);
  assert.match(getItem(dir, { item_id: "UC-001" }).text, /待核实：UC-001 有 1 处是助手补充的/);
});
