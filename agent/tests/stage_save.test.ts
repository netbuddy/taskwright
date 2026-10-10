/**
 * 保存修订按工作阶段守门（lib/save_revision.ts 调 lib/stage.ts）：助手这一刻能写什么看任务现在所在的阶段。
 * 总体分析的页与问题条目一直可以写（评审确认阶段页只能改状态与改看）；别的集合的条目要到写条目阶段，新增、修改、删除都一样。
 * 被拦的操作逐个报原因，整批一个也不写。用户在界面上的操作不看阶段；早先建的任务没有阶段。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { SaveRejected, saveRevision } from "../src/lib/save_revision.ts";
import { STAGES, STAGE_NAMES, type Stage } from "../src/lib/stage.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, READY_PAGE, SOURCE, callIn, count, demoDefinition, enterStage, makeWorkspace, overallDefinition, query } from "./helpers.ts";

const page = (title: string, fields: Record<string, unknown> = {}) =>
  ({ op: "add", collection: "总体分析", fields: { 标题: title, 它是什么: `${title}是馆里的一件事。`, 状态: "在用", ...fields }, sources: [SOURCE] });
const useCase = (name: string) => ({ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["选书", "办手续"] }, sources: [SOURCE] });
const problem = (text: string) => ({ op: "add", collection: "问题", fields: { 事项: text, 状态: "未解决" }, sources: [SOURCE] });

function workspace(definition: unknown = overallDefinition(), material = true): string {
  const dir = makeWorkspace(definition, { material });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
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
const revisionOf = (dir: string, itemId: string) =>
  query<{ n: number }>(dir, "SELECT MAX(revision_no) AS n FROM item_version WHERE item_id = ?", itemId)[0].n;
let ui = 0;
const userOp = (dir: string, body: Record<string, unknown>) => runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-save-${++ui}`, ...body });

/**
 * 一个已经有两页主题、一条用例、一条问题的任务：在写条目阶段建好（第一页合格，过得了最低门），返回任务目录。
 * OA-001 馆藏范围（合格的一页）、OA-002 预约、UC-001 借书、TBD-001。
 */
function filled(): string {
  const dir = workspace();
  enterStage(dir, "writing");
  saveRevision(callIn(dir), { operations: [READY_PAGE, page("预约")] });
  userOp(dir, { kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 1 }] });
  saveRevision(callIn(dir), { operations: [useCase("借书"), problem("闭馆日算不算在保留期内？")] });
  return dir;
}

test("别的集合的条目：核读材料、澄清、整理建模三个阶段新增、修改、删除都被拦；写条目与评审确认阶段可以", () => {
  const dir = filled();
  for (const stage of ["reading", "clarifying", "modeling"] as const) {
    enterStage(dir, stage);
    const name = STAGE_NAMES[stage];
    const added = refusal(dir, [useCase("还书")])!;
    assert.match(added, /这次「保存修订」什么都没有写入，因为有 1 个操作不对/);
    assert.ok(added.includes(`- 操作 1（新增，集合「用例」）：新增到「用例」的条目：任务现在在${name}阶段，这个阶段不能新增「用例」的条目。`), added);
    assert.ok(added.includes("怎么办：「用例」的条目要到写条目阶段才能写。进入写条目要由用户在卡片上选「开始写条目」"), added);
    const updated = refusal(dir, [{ op: "update", item: "UC-001", base_revision: revisionOf(dir, "UC-001"), fields: { 名称: "借阅图书" } }])!;
    assert.ok(updated.includes(`- 操作 1（修改，条目 UC-001）：UC-001：任务现在在${name}阶段，这个阶段不能修改「用例」的条目。`), updated);
    const deleted = refusal(dir, [{ op: "delete", item: "UC-001", base_revision: revisionOf(dir, "UC-001") }])!;
    assert.ok(deleted.includes(`- 操作 1（删除，条目 UC-001）：任务现在在${name}阶段，这个阶段不能删除「用例」的条目。`), deleted);
  }
  assert.equal(count(dir, "revision"), 2, "三个阶段里一次都没有写进去");
  for (const stage of ["writing", "reviewing"] as const) {
    enterStage(dir, stage);
    assert.equal(refusal(dir, [useCase(`还书（${STAGE_NAMES[stage]}）`)]), null);
    assert.equal(refusal(dir, [{ op: "update", item: "UC-001", base_revision: revisionOf(dir, "UC-001"), fields: { 名称: `借阅图书（${STAGE_NAMES[stage]}）` } }]), null);
  }
  assert.equal(refusal(dir, [{ op: "delete", item: "UC-002", base_revision: revisionOf(dir, "UC-002") }]), null, "评审确认阶段可以删");
});

test("总体分析的页前四个阶段新增、修改、删除都可以；问题条目每个阶段都可以记（它的修改另有自己的规矩，不归阶段管）", () => {
  const dir = workspace();
  let n = 0;
  for (const stage of ["reading", "clarifying", "modeling", "writing"] as const) {
    enterStage(dir, stage);
    n += 1;
    assert.equal(refusal(dir, [page(`主题${n}`), problem(`第 ${n} 个问题？`)]), null, STAGE_NAMES[stage]);
    const id = `OA-00${n}`;
    assert.equal(refusal(dir, [{ op: "update", item: id, base_revision: revisionOf(dir, id), fields: { 它是什么: `改过的第 ${n} 页。` } }]), null);
    assert.equal(refusal(dir, [{ op: "delete", item: id, base_revision: revisionOf(dir, id) }]), null);
  }
});

test("评审确认阶段：页只能改状态与改看，不能新立、不能删、不能改别的字段；问题条目照常可以写", () => {
  const dir = filled();
  enterStage(dir, "reviewing");
  assert.ok(refusal(dir, [page("续借")])!.includes("新增到「总体分析」的条目：任务现在在评审确认阶段，这个阶段不能新立主题页。\n  怎么办：要动主题页的内容，先在回复里把任务移回澄清或整理建模。"));
  const edited = refusal(dir, [{ op: "update", item: "OA-002", base_revision: revisionOf(dir, "OA-002"), fields: { 它是什么: "读者对借出的书办预约。", 状态: "已废弃" } }])!;
  assert.ok(edited.includes("OA-002：任务现在在评审确认阶段，这个阶段主题页只能改「状态」与「改看」，这次还改了「它是什么」。"), edited);
  assert.ok(refusal(dir, [{ op: "delete", item: "OA-002", base_revision: revisionOf(dir, "OA-002") }])!.includes("任务现在在评审确认阶段，这个阶段不能删除主题页。"));
  // 只改状态与改看：可以。
  assert.equal(refusal(dir, [{ op: "update", item: "OA-002", base_revision: revisionOf(dir, "OA-002"), fields: { 状态: "已废弃", 改看: ["OA-001"] } }]), null);
  assert.equal(refusal(dir, [{ op: "update", item: "OA-002", base_revision: revisionOf(dir, "OA-002"), fields: { 状态: "在用", 改看: [] } }]), null);
  // 问题条目照常可以记。
  assert.equal(refusal(dir, [problem("罚款怎样缴纳？")]), null);
});

test("一批里混着页与用例：被拦的那个操作报一条，整批一个也不写；去掉它再保存就过", () => {
  const dir = workspace();
  enterStage(dir, "clarifying");
  const text = refusal(dir, [page("预约"), useCase("预约图书"), problem("保留几天？")])!;
  assert.match(text, /因为有 1 个操作不对/);
  assert.ok(text.includes("- 操作 2（新增，集合「用例」）"), text);
  assert.equal(text.includes("操作 1（"), false);
  assert.equal(count(dir, "item"), 0);
  assert.equal(refusal(dir, [page("预约"), problem("保留几天？")]), null);
  assert.equal(count(dir, "item"), 2);
});

test("阶段与最低门都过不去时两条原因都报；守门按调用那一刻最近的阶段记录判", () => {
  const dir = workspace();
  // 没有任何记录、有材料：在核读材料。总体分析里一页都没有，最低门也过不去。
  const both = refusal(dir, [useCase("借书")])!;
  assert.ok(both.includes("任务现在在核读材料阶段，这个阶段不能新增「用例」的条目；还没有用户看过的主题：总体分析里还没有一页主题"), both);
  assert.ok(both.includes("进入写条目要由用户在卡片上选「开始写条目」"), both);
  // 用户把任务移到写条目：下一次调用就只剩最低门。
  enterStage(dir, "writing");
  const gateOnly = refusal(dir, [useCase("借书")])!;
  assert.equal(gateOnly.includes("这个阶段不能"), false);
  assert.match(gateOnly, /还没有用户看过的主题/);
  // 用户又移回澄清：再下一次调用又被阶段拦。
  enterStage(dir, "clarifying");
  assert.match(refusal(dir, [useCase("借书")])!, /任务现在在澄清阶段/);
});

test("没有材料的新任务缺省在澄清：页可以写，用例被拦", () => {
  const dir = workspace(overallDefinition(), false);
  const said = [{ kind: "助手补充", excerpt: "先立一页占位。" }];
  assert.equal(refusal(dir, [{ ...page("预约"), sources: said }]), null);
  assert.match(refusal(dir, [{ ...useCase("预约图书"), sources: said }])!, /任务现在在澄清阶段，这个阶段不能新增「用例」的条目/);
});

test("用户在界面上的操作不看阶段：澄清阶段照样能改、能删用例", () => {
  const dir = filled();
  enterStage(dir, "clarifying");
  const edited = userOp(dir, { kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: revisionOf(dir, "UC-001") }], fields: { 名称: "借阅图书" } });
  assert.equal(edited.results[0].item_id, "UC-001");
  const removed = userOp(dir, { kind: "delete_item", targets: [{ item_id: "UC-001", base_revision: revisionOf(dir, "UC-001") }] });
  assert.equal(removed.kind, "delete_item");
  // 评审确认阶段用户改主题页的正文也不拦。
  enterStage(dir, "reviewing");
  assert.equal(userOp(dir, { kind: "edit_fields", targets: [{ item_id: "OA-002", base_revision: revisionOf(dir, "OA-002") }], fields: { 它是什么: "读者对借出的书办预约。" } }).kind, "edit_fields");
});

test("早先建的任务没有阶段：有材料也不拦，助手照旧直接写用例", () => {
  const dir = workspace(demoDefinition());
  assert.equal(refusal(dir, [useCase("借书")]), null);
  assert.equal(refusal(dir, [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "借阅图书" } }]), null);
  assert.equal(refusal(dir, [{ op: "delete", item: "UC-001", base_revision: 2 }]), null);
  assert.equal(count(dir, "stage_record"), 0);
  assert.deepEqual([...STAGES].length, 5);
});
