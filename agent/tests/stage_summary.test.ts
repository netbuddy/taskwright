/**
 * 任务现在的阶段与每个阶段的几盏灯，从任务库里读出来算（src/lib/stage_read.ts 的 stageSummary、lampInput）：
 * 助手的查询任务状态与后端的整份数据都经它。这里用真实的保存、界面操作与移动走一小段，看读出来的对不对。
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { databasePath } from "../src/lib/db.ts";
import { validateDefinition } from "../src/lib/definition.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { type StageSummary, sourceMaterials, stageSummary } from "../src/lib/stage_read.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, SOURCE, callIn, demoDefinition, enterStage, makeWorkspace, overallDefinition, query } from "./helpers.ts";

function workspace(definition: Record<string, any> = overallDefinition()): { dir: string; taskId: string; summary: () => StageSummary | null } {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  const taskId = query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id;
  const summary = () => {
    const db = new DatabaseSync(databasePath(dir), { readOnly: true });
    try {
      return stageSummary(db, dir, taskId, validateDefinition(definition));
    } finally {
      db.close();
    }
  };
  return { dir, taskId, summary };
}
const lamp = (summary: StageSummary, key: string) => Object.values(summary.lamps).flat().find((one) => one.key === key)!;
const brief = (summary: StageSummary, key: string) => [lamp(summary, key).ok, lamp(summary, key).items];
let ui = 0;
const userOp = (dir: string, body: Record<string, unknown>) => runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-sum-${++ui}`, ...body });

test("刚建好、有材料的任务：在核读材料，没有人移过；材料还没有被引用，那一盏不通过", () => {
  const { summary } = workspace();
  const now = summary()!;
  assert.deepEqual([now.current, now.moved_by, now.moved_at, now.reason], ["reading", null, null, null]);
  assert.deepEqual(brief(now, "materials_cited"), [false, ["inputs/材料.md"]]);
  assert.deepEqual(Object.keys(now.lamps), ["reading", "clarifying", "modeling", "writing", "reviewing"]);
});

test("走一小段：立页、记问题、移动、用户看过、写用例，各盏灯跟着库里的内容变", () => {
  const { dir, summary } = workspace();
  // 助手立一页流程（照抄材料，没有例外的例子），记一个关联到它的未解决问题。
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "总体分析", fields: { 标题: "登录", 它是什么: "用户可以登录。", 例子: ["登录总要输入口令。"], 标签: ["流程"], 状态: "在用" }, sources: [SOURCE] },
    { op: "add", collection: "问题", fields: { 事项: "口令输错几次要锁定？", 状态: "未解决", 关联条目: ["OA-001"] }, sources: [SOURCE] },
  ] });
  let now = summary()!;
  assert.deepEqual(brief(now, "materials_cited"), [true, []]);
  assert.deepEqual(brief(now, "tagged_pages_no_open_questions"), [false, ["OA-001"]]);
  assert.deepEqual(brief(now, "flows_have_exception"), [false, ["OA-001"]]);
  assert.deepEqual(brief(now, "no_untagged_pages"), [true, []]);
  // 这份演示任务定义里用例的集合叫「用例」，没有「功能用例」：那一盏不适用。
  assert.equal(lamp(now, "flows_backed_by_use_cases").ok, null);
  assert.deepEqual(brief(now, "reviews_no_open_findings"), [false, []]);
  assert.equal(lamp(now, "completion_met").ok, false);

  // 用户把任务移到澄清：记下是谁、为什么。
  userOp(dir, { kind: "move_stage", fields: { stage: "澄清", reason: "材料我读过了。" } });
  now = summary()!;
  assert.deepEqual([now.current, now.moved_by, now.reason], ["clarifying", "user", "材料我读过了。"]);
  assert.match(now.moved_at!, /^\d{4}-\d{2}-\d{2}T/);

  // 助手补一条例外的例子（助手补的，待核实）；用户还没有看过这一页。进入写条目之后助手依据它写一条用例：用例因依据的页而待核实。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-001", base_revision: 1, fields: { 例子: ["登录总要输入口令。", "例外：口令输错时不能登录。"] },
    sources: [{ kind: "助手补充", excerpt: "口令不对自然登录不了，我补了「例外：口令输错时不能登录。」", supports: [{ field: "例子", index: 1 }] }] }] });
  userOp(dir, { kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 2 }] });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-001", base_revision: 2, fields: { 别名: ["登入"] } }] });
  enterStage(dir, "writing");
  // 最低门要一页用户看过的主题：OA-001 被助手又改了一次（修订 3），要再看；这里先不看，另立一页合格的给最低门用。
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "总体分析", fields: { 标题: "退款", 它是什么: "退款须在七天内处理完毕。", 例子: ["退款要在三天内到账"], 标签: ["概念"], 状态: "在用" },
    sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: "退款须在七天内处理完毕。" }] }] });
  userOp(dir, { kind: "mark_viewed", targets: [{ item_id: "OA-002", base_revision: 4 }] });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["输入口令"] }, sources: [{ kind: "条目", locator: "OA-001", excerpt: "用户可以登录。" }] }] });
  now = summary()!;
  assert.equal(now.current, "writing");
  assert.deepEqual(brief(now, "flows_have_exception"), [true, []]);
  assert.deepEqual(brief(now, "basis_pages_viewed"), [false, ["UC-001"]]);
  assert.deepEqual(brief(now, "no_pending_items"), [false, ["UC-001"]]);
  // 用户看过 OA-001 现在的内容：两盏都过。
  userOp(dir, { kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 3 }] });
  now = summary()!;
  assert.deepEqual([brief(now, "basis_pages_viewed"), brief(now, "no_pending_items")], [[true, []], [true, []]]);
});

test("材料清单里由 Word 或 PDF 材料生成的文字版与分段清单不算一份材料；原件不在时照算", () => {
  assert.deepEqual(sourceMaterials(["inputs/需求.md", "inputs/访谈.docx", "inputs/访谈.docx.md", "inputs/访谈.docx.segments.json",
    "inputs/制度.pdf", "inputs/制度.pdf.md", "inputs/制度.pdf.segments.json", "inputs/旧稿.docx.txt", "inputs/孤儿.docx.md"]),
  ["inputs/需求.md", "inputs/访谈.docx", "inputs/制度.pdf", "inputs/旧稿.docx.txt", "inputs/孤儿.docx.md"]);
});

test("早先建的任务没有阶段：读出来是 null", () => {
  const { summary } = workspace(demoDefinition() as Record<string, any>);
  assert.equal(summary(), null);
});
