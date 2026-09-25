/**
 * 「领域说明」集合：真实任务类型的定义里有它；来源种类「领域说明」的出处核对（存在、属于这个集合、没有删除）；
 * 完成条件里的「每个条目用户确认」与完成条件之外的提示「还没有和任何条目关联的领域说明」（三种联系都算）。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { loadDefinition } from "../src/lib/definition.ts";
import { checkCompletion, completionHints, unlinkedDomainNotes } from "../src/lib/conditions.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { getTaskStatus } from "../src/lib/task_query.ts";
import { DEFINITION_PATH, SOURCE, callIn, demoDefinition, makeWorkspace, query } from "./helpers.ts";

/** 演示定义加上「领域说明」集合与它的完成条件。 */
function definitionWithNotes(): Record<string, any> {
  const def = demoDefinition() as Record<string, any>;
  def.交付物.条目集合.push({
    名称: "领域说明",
    编号前缀: "DN",
    字段: [
      { 名: "标题", 类型: "文本", 必填: true },
      { 名: "内容", 类型: "文本", 必填: true },
      { 名: "类别", 类型: "文本", 必填: true },
      { 名: "关联条目", 类型: "条目引用", 必填: false },
    ],
  });
  def.完成条件.领域说明 = ["每个条目用户确认"];
  return def;
}

const note = (标题: string, 类别 = "术语", 关联条目?: string[]) => ({
  op: "add", collection: "领域说明",
  fields: { 标题, 内容: `${标题}是登录时输入的一串字符，区分大小写。`, 类别, ...(关联条目 ? { 关联条目 } : {}) },
  sources: [{ kind: "执行者补充", locator: "执行者补充", excerpt: `${标题}是这个意思` }],
});

/** 建任务：UC-001、UC-002（修订 1），DN-001、DN-002（修订 2）。 */
function workspace(def: Record<string, any> = definitionWithNotes()): string {
  const dir = makeWorkspace(def);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [SOURCE] },
    { op: "add", collection: "用例", fields: { 名称: "退出", 步骤: ["点退出"] }, sources: [SOURCE] },
  ] });
  if (def.交付物.条目集合.some((c: any) => c.名称 === "领域说明")) {
    saveRevision(callIn(dir), { operations: [note("口令"), note("管理员", "角色")] });
  }
  return dir;
}

const cite = (locator: string, base = 1, item = "UC-001", excerpt = "登录时输入的一串字符") => ({
  op: "update", item, base_revision: base, fields: { 名称: `登录（${locator}）` },
  sources: [{ kind: "领域说明", locator, excerpt, supports: [{ field: "名称" }] }],
});

test("真实的任务类型：有「领域说明」集合（DN，四个字段，不评审），完成条件是每个条目用户确认", () => {
  const typeDir = resolve(import.meta.dirname, "../../task-types/srs-authoring");
  const { definition } = loadDefinition(typeDir, "docs/task-definitions/srs-authoring.json");
  const notes = definition.collections.find((c) => c.name === "领域说明")!;
  assert.equal(notes.prefix, "DN");
  assert.deepEqual(notes.fields.map((f) => [f.name, f.type, f.required]),
    [["标题", "文本", true], ["内容", "文本", true], ["类别", "文本", true], ["关联条目", "条目引用", false]]);
  assert.equal(notes.reviewRules ?? null, null);
  assert.deepEqual(definition.completion.领域说明, ["每个条目用户确认"]);
});

test("来源种类「领域说明」：出处是还在的领域说明时保存，存进来源表；出处去掉首尾空白", () => {
  const dir = workspace();
  const out = saveRevision(callIn(dir), { operations: [{ ...cite(" DN-001 ") }] });
  const row = query<any>(dir, "SELECT kind, locator, excerpt, field FROM item_source WHERE item_id = 'UC-001' AND revision_no = ?", out.details.revision_no)
    .find((one) => one.kind === "领域说明");
  assert.deepEqual({ ...row }, { kind: "领域说明", locator: "DN-001", excerpt: "登录时输入的一串字符", field: "名称" });
});

test("来源种类「领域说明」：摘录要逐字出现在那条说明当前修订的标题或内容里，标点不同也拒绝", () => {
  const dir = workspace();
  // 标题里的一段也认。
  saveRevision(callIn(dir), { operations: [cite("DN-001", 1, "UC-001", "口令")] });
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("DN-001", 3, "UC-001", "登录时输入的一串字符,区分大小写")] }),
    /这次「保存修订」什么都没有写入[\s\S]*第 1 条来源的摘录「登录时输入的一串字符,区分大小写」在 DN-001 的当前修订里找不到[\s\S]*摘录必须逐字一致，包括标点/);
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("DN-002", 3, "UC-001", "口令是登录时输入的一串字符")] }),
    /在 DN-002 的当前修订里找不到/);
  // 领域说明改了内容之后，按改后的内容核对。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "DN-002", base_revision: 2, fields: { 内容: "坐在服务台办理借还的人" } }] });
  saveRevision(callIn(dir), { operations: [cite("DN-002", 3, "UC-001", "坐在服务台办理借还的人")] });
});

test("来源种类「领域说明」：出处不存在、不是领域说明、已删除、在这次调用里删除时整批拒绝，按现有格式写原因", () => {
  const dir = workspace();
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("DN-009")] }),
    /这次「保存修订」什么都没有写入[\s\S]*第 1 条来源的种类是「领域说明」，出处 DN-009 不是这个任务里「领域说明」集合的条目编号/);
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("UC-002")] }), /出处 UC-002 不是这个任务里「领域说明」集合的条目编号/);
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("DN-002"), { op: "delete", item: "DN-002", base_revision: 2 }] }),
    /出处 DN-002 指向的领域说明在这次调用里被删除/);
  saveRevision(callIn(dir), { operations: [{ op: "delete", item: "DN-002", base_revision: 2 }] });
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("DN-002")] }), /出处 DN-002 指向的领域说明已在修订 3 删除/);
  // 没有写进任何东西。
  assert.equal(query(dir, "SELECT 1 FROM item_source WHERE kind = '领域说明'").length, 0);
});

test("来源种类「领域说明」：任务定义里没有这个集合时拒绝", () => {
  const dir = workspace(demoDefinition() as Record<string, any>);
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("DN-001")] }), /出处 DN-001 这个任务没有「领域说明」集合/);
});

test("提示：还没有和任何条目关联的领域说明——来源引用、别的条目的关联条目、自己的关联条目三种联系都算，删掉的条目不算", () => {
  const dir = workspace();
  // DN-001 被 UC-001 引作来源（a）；DN-002 被问题条目的关联条目写了（b）；
  // DN-003 自己关联了 UC-002（c）；DN-004 什么联系都没有；DN-005 只关联了后来删掉的 UC-002 之外的已删条目。
  saveRevision(callIn(dir), { operations: [cite("DN-001")] });
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "问题", fields: { 事项: "管理员是谁", 状态: "未解决", 关联条目: ["DN-002"] }, sources: [SOURCE] },
    note("借阅", "术语", ["UC-002"]), note("开学", "背景"),
  ] });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "临时", 步骤: ["一步"] }, sources: [SOURCE] }] });
  saveRevision(callIn(dir), { operations: [note("假期", "背景", ["UC-003"])] });
  saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-003", base_revision: 5 }] });
  const db = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    const taskId = (db.prepare("SELECT task_id FROM task").get() as { task_id: string }).task_id;
    assert.deepEqual(unlinkedDomainNotes(db, taskId), ["DN-004", "DN-005"]);
    const completion = { 用例: ["至少一个条目"], 领域说明: ["每个条目用户确认"] };
    assert.deepEqual(completionHints(db, taskId, completion), [{
      kind: "unlinked_domain_notes", collection: "领域说明", items: ["DN-004", "DN-005"],
      summary: "有 2 条领域说明还没有和任何条目关联：DN-004、DN-005。",
    }]);
    // 完成条件里没有领域说明集合时不算提示；领域说明「每个条目用户确认」照常核对（都还没看过）。
    assert.deepEqual(completionHints(db, taskId, { 用例: ["至少一个条目"] }), []);
    const confirm = checkCompletion(db, taskId, completion).find((r) => r.collection === "领域说明")!;
    assert.equal(confirm.state, "unmet");
    assert.equal(confirm.unmet.length, 5);
  } finally {
    db.close();
  }
  // 查询任务状态的文字与结构化内容都带这条提示，写明不挡完成任务。
  const status = getTaskStatus(dir);
  assert.match(status.text, /提示（不挡完成任务）：有 2 条领域说明还没有和任何条目关联：DN-004、DN-005。/);
  assert.deepEqual(status.details.hints.map((h: any) => h.items), [["DN-004", "DN-005"]]);
  // 服务端与观测台经命令行入口取完成条件，输出里也带 hints。
  const cli = resolve(import.meta.dirname, "../src/cli/check_completion.mts");
  const taskId = query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id;
  const out = JSON.parse(execFileSync(process.execPath, [cli, databasePath(dir), taskId, JSON.stringify({ 领域说明: ["每个条目用户确认"] })], { encoding: "utf-8" }));
  assert.deepEqual(out.hints.map((h: any) => h.items), [["DN-004", "DN-005"]]);
});

test("平台 skill 与任务 skill 写了领域说明的做法：记下并说出落点、只收解释性内容、拆两条两边都写、引用的写法", () => {
  const platform = readFileSync(resolve(import.meta.dirname, "../prompts/skills/taskwright-executor/SKILL.md"), "utf-8");
  assert.match(platform, /## 十、领域说明（任务定义里有「领域说明」集合时）/);
  assert.match(platform, /我把「借还台管理员」记到领域说明了（DN-002）/);
  assert.match(platform, /来源种类写「领域说明」，locator 写它的条目编号/);
  const task = readFileSync(resolve(import.meta.dirname, "../../task-types/srs-authoring/.pi/skills/srs-authoring/SKILL.md"), "utf-8");
  assert.match(task, /由五个条目集合组成：功能用例、非功能需求、约束、问题、领域说明/);
  assert.match(task, /材料里的术语定义段落也整理成领域说明，类别写「术语」/);
  assert.match(task, /约束那一条把领域说明写成来源.*领域说明那一条把约束写进「关联条目」，两边都写/);
  assert.match(task, /「一批最多写 4 个条目」同样适用于领域说明/);
  assert.match(task, /例如用户说「我们说的续借是在借期内延长，逾期后办的不叫续借」[\s\S]*分三次保存/);
  assert.match(platform, /excerpt 逐字照抄那条说明的标题或内容里你引用的那一段，包括标点/);
});
