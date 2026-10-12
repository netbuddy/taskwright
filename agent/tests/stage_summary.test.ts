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
import { overallState, pendingSummary, verificationLines } from "../src/lib/overall_read.ts";
import { saveDiagram } from "../src/lib/save_diagram.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { type StageSummary, lampDiagrams, sourceMaterials, stageSummary } from "../src/lib/stage_read.ts";
import { DIAGRAM_VIEW_OP_KIND, markDiagramViewed } from "../src/lib/user_diagram.ts";
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
/** 一个条目因依据而待核实的那一项，与给助手看的几行。 */
function verificationOfItem(dir: string, taskId: string, definition: ReturnType<typeof validateDefinition>, itemId: string) {
  const db = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    const state = overallState(db, taskId, definition).verification.get(itemId)!;
    return [state.basis_pending, verificationLines(itemId, state)];
  } finally {
    db.close();
  }
}
/** 任务里待核实的条目合成的那一句。 */
function pendingText(dir: string, taskId: string, definition: ReturnType<typeof validateDefinition>): string | null {
  const db = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    return pendingSummary(overallState(db, taskId, definition));
  } finally {
    db.close();
  }
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
  assert.deepEqual(Object.keys(now.lamps), ["reading", "clarifying", "modeling", "writing", "reviewing", "document"]);
});

test("走一小段：立页、记问题、移动、用户看过、写用例，各盏灯跟着库里的内容变", () => {
  const { dir, summary } = workspace();
  // 助手立一页流程（照抄材料），记一个关联到它的未解决问题。
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "总体分析", fields: { 标题: "登录", 它是什么: "用户可以登录。", 例子: ["登录总要输入口令。"], 标签: ["流程"], 状态: "在用" }, sources: [SOURCE] },
    { op: "add", collection: "问题", fields: { 事项: "口令输错几次要锁定？", 状态: "未解决", 关联条目: ["OA-001"] }, sources: [SOURCE] },
  ] });
  let now = summary()!;
  assert.deepEqual(brief(now, "materials_cited"), [true, []]);
  assert.deepEqual(brief(now, "tagged_pages_no_open_questions"), [false, ["OA-001"]]);
  assert.deepEqual(brief(now, "flows_have_flowchart_with_branch"), [false, ["OA-001"]]);
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
  assert.deepEqual(brief(now, "basis_pages_viewed"), [false, ["UC-001"]]);
  assert.deepEqual(brief(now, "no_pending_items"), [false, ["UC-001"]]);
  // 用户看过 OA-001 现在的内容：两盏都过。
  userOp(dir, { kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 3 }] });
  now = summary()!;
  assert.deepEqual([brief(now, "basis_pages_viewed"), brief(now, "no_pending_items")], [[true, []], [true, []]]);
});

test("与图、规则冲突有关的几盏灯从库里读：角色进两种图、概念有连线、流程图有分叉、状态图、规则冲突、依据的图用户看过", async () => {
  const { dir, taskId, summary } = workspace();
  const definition = validateDefinition(overallDefinition());
  const said = "把这几张图都画出来";
  const draw = (params: Record<string, unknown>) => saveDiagram({ ...callIn(dir), userMessages: [{ entryId: "u1", text: `${said}。` }] },
    { sources: [{ kind: "用户的话", excerpt: said }], ...params } as any, { validate: async () => ({ ok: true }) });
  const cite = (...ids: string[]) => [{ kind: "用户的话", excerpt: said }, ...ids.map((id) => ({ kind: "条目", locator: id }))];
  const pageOf = (fields: Record<string, unknown>) => ({ op: "add", collection: "总体分析", fields: { 它是什么: "用户可以登录。", 状态: "在用", ...fields }, sources: [SOURCE] });
  const rule = (index: number) => ({ ...SOURCE, supports: [{ field: "已经定下的", index }] });
  // OA-001 读者（角色）、OA-002 借阅记录（概念，说到状态）、OA-003 图书（概念）、OA-004 借书（流程）、OA-005 借书证（概念，孤零零的）。
  saveRevision(callIn(dir), { operations: [
    pageOf({ 标题: "读者", 标签: ["角色"] }),
    { ...pageOf({ 标题: "借阅记录", 标签: ["概念"], 已经定下的: ["还书后记录从在借变为已还。", "一次最多借 30 天。"] }), sources: [SOURCE, rule(0), rule(1)].map((one, n) => (n === 0 ? { ...one, supports: [{ field: "它是什么" }] } : one)) },
    pageOf({ 标题: "图书", 标签: ["概念"] }),
    { ...pageOf({ 标题: "借书", 标签: ["流程"], 例子: ["小王周六借了一本书。"], 已经定下的: ["教师一次最多借 60 天。"] }), sources: [{ ...SOURCE, supports: [{ field: "它是什么" }] }, rule(0)] },
    pageOf({ 标题: "借书证", 标签: ["概念"] }),
  ] });
  let now = summary()!;
  assert.deepEqual([brief(now, "roles_in_context_and_use_cases"), brief(now, "concepts_related_in_class"), brief(now, "flows_have_flowchart_with_branch"), brief(now, "stateful_concepts_have_state"),
    brief(now, "rules_no_conflict")], [[false, ["OA-001"]], [false, ["OA-002", "OA-003", "OA-005"]], [false, ["OA-004"]], [false, ["OA-002"]], [true, []]]);

  // 助手到整理建模阶段画五种图。
  enterStage(dir, "modeling");
  await draw({ name: "系统边界", kind: "context", mermaid: 'flowchart LR\n  r(["OA-001 读者"])\n  subgraph 图书馆系统\n    d["办理借还"]\n  end\n  r -- 借书申请 --> d', sources: cite("OA-001") });
  await draw({ name: "读者用例", kind: "use_case", mermaid: 'flowchart LR\n  r(["OA-001 读者"])\n  u(["OA-004 借书"])\n  r --> u', sources: cite("OA-001", "OA-004") });
  await draw({ name: "对象关系", kind: "class", mermaid: 'classDiagram\n  class Loan["OA-002 借阅记录"]\n  class Book["OA-003 图书"]\n  class Card["OA-005 借书证"]\n  Loan --> Book : 借的是', sources: cite("OA-002", "OA-003", "OA-005") });
  await draw({ name: "借书的流程", kind: "flowchart", mermaid: 'flowchart TD\n  a(["OA-004 借书"]) --> b{"证有没有过期"}\n  b -- 没有 --> c["登记借出"]\n  b -- 过期 --> e["拒绝"]', sources: cite("OA-004") });
  await draw({ name: "借阅记录的状态", kind: "state", mermaid: 'stateDiagram-v2\n  state "OA-002 在借" as s1\n  [*] --> s1\n  s1 --> 已还 : 还书', sources: cite("OA-002") });
  const ro = new DatabaseSync(databasePath(dir), { readOnly: true });
  try {
    assert.deepEqual(lampDiagrams(ro, taskId, definition), [
      { diagram_id: "D-001", kind: "context", sources: ["OA-001"], drawn: ["OA-001"], linked: [], branches: false, viewed: false, marked: false },
      { diagram_id: "D-002", kind: "use_case", sources: ["OA-001", "OA-004"], drawn: ["OA-001", "OA-004"], linked: [], branches: false, viewed: false, marked: false },
      { diagram_id: "D-003", kind: "class", sources: ["OA-002", "OA-003", "OA-005"], drawn: ["OA-002", "OA-003", "OA-005"], linked: ["OA-002", "OA-003"], branches: false, viewed: false, marked: false },
      { diagram_id: "D-004", kind: "flowchart", sources: ["OA-004"], drawn: ["OA-004"], linked: [], branches: true, viewed: false, marked: false },
      { diagram_id: "D-005", kind: "state", sources: ["OA-002"], drawn: ["OA-002"], linked: [], branches: false, viewed: false, marked: false },
    ]);
  } finally {
    ro.close();
  }
  now = summary()!;
  assert.deepEqual([brief(now, "roles_in_context_and_use_cases"), brief(now, "concepts_related_in_class"), brief(now, "flows_have_flowchart_with_branch"), brief(now, "stateful_concepts_have_state")],
    [[true, []], [false, ["OA-005"]], [true, []], [true, []]]);
  assert.equal(lamp(now, "concepts_related_in_class").summary, "有 1 页标签为「概念」的主题在对象关系图里还没有连线：OA-005。");

  // 助手记一条规则冲突的问题：来源指到两页的两条规则。问题了结之后灯恢复。
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "问题", fields: { 事项: "规则冲突：一次最多借 30 天还是 60 天", 状态: "未解决", 关联条目: ["OA-002", "OA-004"] },
    sources: [{ kind: "条目", locator: "OA-002", excerpt: "一次最多借 30 天。", supports: [{ field: "事项" }] }, { kind: "条目", locator: "OA-004", excerpt: "教师一次最多借 60 天。", supports: [{ field: "事项" }] }] }] });
  now = summary()!;
  assert.deepEqual(brief(now, "rules_no_conflict"), [false, ["TBD-001"]]);
  userOp(dir, { kind: "edit_fields", targets: [{ item_id: "TBD-001", base_revision: 2 }], fields: { 状态: "已解决" } });
  assert.deepEqual(brief(summary()!, "rules_no_conflict"), [true, []]);

  // 写条目：用例依据用例图与它自己的流程图。流程页经图被用例依据（这份定义里用例的集合不叫「功能用例」，那一盏不适用，这里不看）。
  userOp(dir, { kind: "mark_viewed", targets: [{ item_id: "OA-004", base_revision: 1 }] });
  enterStage(dir, "writing");
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "借书", 步骤: ["登记借出"] }, sources: [
    { kind: "图", locator: "D-002", excerpt: "OA-004 借书", supports: [{ field: "名称" }] }, { kind: "图", locator: "D-004", excerpt: "登记借出", supports: [{ field: "步骤", index: 0 }] }] }] });
  now = summary()!;
  // 用户还没有看过任何一张图：不通过；这个用例也因为依据的图没看过而待核实。
  assert.deepEqual(brief(now, "basis_diagrams_viewed"), [false, ["UC-001"]]);
  // （那条规则冲突的问题依据的两页用户没有看过，它本来就待核实。）
  assert.deepEqual(brief(now, "no_pending_items"), [false, ["TBD-001", "UC-001"]]);
  assert.equal(pendingText(dir, taskId, definition), "待核实的条目：依据的主题待核实、用户还没有看过或已废弃的 1 个：TBD-001；依据的图用户还没有看过的 1 个：UC-001。");
  assert.deepEqual(verificationOfItem(dir, taskId, definition, "UC-001"), [{ item_id: "D-002", reason: "unviewed", see: null },
    ["待核实：它依据的图 D-002 用户还没有看过它现在的内容。请用户把这张图看一遍（看过就算确认）。"]]);
  assert.equal(lamp(now, "basis_diagrams_viewed").summary, "有 1 个条目依据的图用户还没有看过：UC-001（没看过的图是 D-002、D-004）。");
  const view = (id: string) => markDiagramViewed({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-view-${id}`, kind: DIAGRAM_VIEW_OP_KIND, targets: [{ diagram_id: id, base_revision: 1 }] });
  view("D-002");
  assert.deepEqual(brief(summary()!, "basis_diagrams_viewed"), [false, ["UC-001"]]);
  // 看了一张：头一处没看过的换成另一张。两张都看了：不再待核实。
  assert.deepEqual(verificationOfItem(dir, taskId, definition, "UC-001")[0], { item_id: "D-004", reason: "unviewed", see: null });
  view("D-004");
  assert.deepEqual(brief(summary()!, "basis_diagrams_viewed"), [true, []]);
  assert.deepEqual([brief(summary()!, "no_pending_items"), verificationOfItem(dir, taskId, definition, "UC-001")], [[false, ["TBD-001"]], [null, []]]);
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

test("查询任务状态的末尾写现在在哪个阶段、这一段还差什么；早先建的任务不写", async () => {
  const { getTaskStatus } = await import("../src/lib/task_query.ts");
  const { dir } = workspace();
  // 刚建好：核读材料，材料还没有被引用。
  let out = getTaskStatus(dir);
  assert.match(out.text, /\n\n任务现在在核读材料阶段（任务建好之后还没有人移动过）。\n核读材料这一段还差 1 项：\n  - 有 1 份材料还没有被任何一页主题或问题引用：inputs\/材料\.md。$/);
  assert.equal((out.details as any).stage.current, "reading");
  // 立了一页引用材料的主题，用户移到澄清并写了理由：澄清这一段两盏灯都过（或不适用）。
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "总体分析", fields: { 标题: "登录", 它是什么: "用户可以登录。", 标签: ["概念"], 状态: "在用" }, sources: [SOURCE] }] });
  userOp(dir, { kind: "move_stage", fields: { stage: "澄清", reason: "材料我读过了。" } });
  out = getTaskStatus(dir);
  assert.match(out.text, /\n\n任务现在在澄清阶段（用户在 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 移过来的，理由：材料我读过了）。\n澄清这一段的几项都齐了。$/);
  assert.deepEqual([(out.details as any).stage.current, (out.details as any).stage.moved_by], ["clarifying", "user"]);

  const old = workspace(demoDefinition() as Record<string, any>);
  const legacy = getTaskStatus(old.dir);
  assert.doesNotMatch(legacy.text, /阶段/);
  assert.equal("stage" in (legacy.details as any), false);
});
