/**
 * 「领域说明」集合：真实任务类型的定义里有它；来源种类「条目」（早期版本只能引用领域说明，种类名叫「领域说明」）的核对：
 * 被引用的条目存在、没有删除、不是自己，摘录逐字出自它的当前内容，记下引用时它的修订号；
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
import { loadDefinition, validateDefinition } from "../src/lib/definition.ts";
import { CHAPTERS } from "../src/lib/overall_chapters.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { getTaskStatus } from "../src/lib/task_query.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
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
  sources: [{ kind: "助手补充", locator: "助手补充", excerpt: `${标题}是这个意思`, supports: [{ field: "内容", inserted: ["区分大小写"] }] }],
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

const cite = (locator: string, base = 1, item = "UC-001", excerpt = "登录时输入的一串字符", kind = "条目") => ({
  op: "update", item, base_revision: base, fields: { 名称: `登录（${locator}）` },
  sources: [{ kind, locator, excerpt, supports: [{ field: "名称" }] }],
});

/** 某个条目在某次修订下种类为「条目」的来源行。 */
const itemRows = (dir: string, item: string, revisionNo: number) =>
  query<any>(dir, "SELECT element_kind, kind, locator, excerpt, field, depends_revision FROM item_source WHERE item_id = ? AND revision_no = ? AND kind = '条目' ORDER BY position", item, revisionNo)
    .map((row) => ({ ...row }));

test("真实的任务类型：这个位置上现在是「业务说明」集合（OA，十个字段，不评审），完成条件是每个条目用户确认；没有「领域说明」集合了", () => {
  const typeDir = resolve(import.meta.dirname, "../../task-types/requirements-engineering");
  const { definition } = loadDefinition(typeDir, "docs/task-definitions/requirements-engineering.json");
  assert.equal(definition.collections.some((c) => c.name === "领域说明"), false);
  const pages = definition.collections.find((c) => c.name === "业务说明")!;
  assert.equal(pages.prefix, "OA");
  assert.deepEqual(pages.fields.map((f) => [f.name, f.type, f.required]), [
    ["标题", "文本", true], ["别名", "文本列表", false], ["它是什么", "文本", true], ["例子", "文本列表", false], ["已经定下的", "文本列表", false],
    ["标签", "文本列表", false], ["上级主题", "条目引用", false], ["状态", "枚举", true], ["改看", "条目引用", false],
    ["导语所属章", "枚举", false],
  ]);
  // 导语所属章的取值就是业务说明七章的章名（lib/overall_chapters.ts）。
  assert.deepEqual(pages.fields.find((f) => f.name === "导语所属章")!.values, CHAPTERS.map((one) => one.name));
  // 问题集合：是否阻断下游必填，何时回看与落实到可以不填。
  const problems = definition.collections.find((c) => c.name === "问题")!;
  assert.deepEqual(problems.fields.map((f) => [f.name, f.type, f.required]), [
    ["事项", "文本", true], ["种类", "枚举", true], ["是否阻断下游", "枚举", true], ["何时回看", "文本", false], ["建议的处理", "文本", false],
    ["状态", "枚举", true], ["处理结果", "文本", false], ["落实到", "文本", false], ["关联条目", "条目引用", false],
  ]);
  assert.deepEqual(problems.fields.find((f) => f.name === "是否阻断下游")!.values, ["阻断下游", "不阻断"]);
  assert.deepEqual(pages.fields.find((f) => f.name === "标签")!.values, ["概念", "角色", "流程", "场景", "目标", "范围", "假设", "决定"]);
  assert.deepEqual(pages.fields.filter((f) => f.sameCollection && f.single).map((f) => f.name), ["上级主题", "改看"]);
  assert.equal(pages.reviewRules ?? null, null);
  assert.deepEqual(definition.completion.业务说明, ["每个条目用户确认"]);
  assert.equal(JSON.parse(readFileSync(resolve(typeDir, "docs/task-definitions/requirements-engineering.json"), "utf-8")).版本, 6);
});

test("来源种类「条目」：出处是还在的条目时保存，记下引用时它的修订号；出处去掉首尾空白；产出方记作条目", () => {
  const dir = workspace();
  const out = saveRevision(callIn(dir), { operations: [{ ...cite(" DN-001 ") }] });
  // DN-001 是修订 2 新增的，之后没有改过。
  assert.deepEqual(itemRows(dir, "UC-001", out.details.revision_no),
    [{ element_kind: "条目", kind: "条目", locator: "DN-001", excerpt: "登录时输入的一串字符", field: "名称", depends_revision: 2 }]);
  // 别的种类不记修订号。
  assert.deepEqual(query<any>(dir, "SELECT DISTINCT depends_revision FROM item_source WHERE kind <> '条目'").map((row) => row.depends_revision), [null]);
});

test("来源种类「条目」：哪个集合的条目都可以引用，任务没有「领域说明」集合时也一样", () => {
  const dir = workspace(demoDefinition() as Record<string, any>);
  const out = saveRevision(callIn(dir), { operations: [cite("UC-002", 1, "UC-001", "点退出")] });
  assert.deepEqual(itemRows(dir, "UC-001", out.details.revision_no).map((row) => [row.locator, row.excerpt, row.depends_revision]), [["UC-002", "点退出", 1]]);
});

test("来源种类「条目」：摘录要逐字出现在那个条目当前修订的某段文字里，标点不同也拒绝", () => {
  const dir = workspace();
  // 标题里的一段也认。
  saveRevision(callIn(dir), { operations: [cite("DN-001", 1, "UC-001", "口令")] });
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("DN-001", 3, "UC-001", "登录时输入的一串字符,区分大小写")] }),
    /这次「保存修订」什么都没有写入[\s\S]*第 1 条来源的摘录「登录时输入的一串字符,区分大小写」在 DN-001 的当前修订里找不到[\s\S]*摘录必须逐字一致，包括标点/);
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("DN-002", 3, "UC-001", "口令是登录时输入的一串字符")] }),
    /在 DN-002 的当前修订里找不到/);
  // 被引用的条目改了内容之后，按改后的内容核对，记下的是改后的修订号。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "DN-002", base_revision: 2, fields: { 内容: "坐在服务台办理借还的人" } }] });
  const out = saveRevision(callIn(dir), { operations: [cite("DN-002", 3, "UC-001", "坐在服务台办理借还的人")] });
  // 修订 3 写下的那条引用 DN-001 的来源沿用下来，记的仍是当时的修订号。
  assert.deepEqual(itemRows(dir, "UC-001", out.details.revision_no).map((row) => [row.locator, row.depends_revision]), [["DN-001", 2], ["DN-002", 4]]);
});

test("来源种类「条目」：出处不存在、已删除、在这次调用里删除、指的是自己时整批拒绝，按现有格式写原因", () => {
  const dir = workspace();
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("DN-009")] }),
    /这次「保存修订」什么都没有写入[\s\S]*第 1 条来源的种类是「条目」，出处 DN-009 指向的条目在这个任务里不存在[\s\S]*出处写一个还在的条目的编号/);
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("UC-001", 1, "UC-001", "登录")] }),
    /出处 UC-001 指的就是这个条目自己，一个条目不能把自己当作依据/);
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("DN-002"), { op: "delete", item: "DN-002", base_revision: 2 }] }),
    /出处 DN-002 指向的条目在这次调用里被删除/);
  saveRevision(callIn(dir), { operations: [{ op: "delete", item: "DN-002", base_revision: 2 }] });
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("DN-002")] }), /出处 DN-002 指向的条目已在修订 3 删除/);
  // 没有写进任何东西。
  assert.equal(query(dir, "SELECT 1 FROM item_source WHERE kind = '条目'").length, 0);
});

test("来源种类「条目」：同一批里排在前面新增或修改的条目可以引用，修订号就是这一次；排在后面才新增的、新增操作引用自己的拒绝", () => {
  const dir = workspace();
  // DN-003 要到这一批第 2 个操作才新增；第 1 个操作的来源指向它。
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("DN-003", 1, "UC-001", "借阅"), note("借阅")] }),
    /出处 DN-003 指向的条目在这一批里排在第 2 个操作才新增，在这个操作之后；请把新增它的操作排到前面/);
  assert.throws(() => saveRevision(callIn(dir), { operations: [{ ...note("借阅"), sources: [{ kind: "条目", locator: "DN-003", excerpt: "借阅" }] }] }),
    /出处 DN-003 指的就是这个操作自己要新增的条目，一个条目不能把自己当作依据/);
  // 排在前面新增的 DN-003 可以引用，摘录对着它将要保存的内容核对；这一批是修订 3。
  assert.throws(() => saveRevision(callIn(dir), { operations: [note("借阅"), cite("DN-003", 1, "UC-001", "这句话不在里面")] }), /在 DN-003 的当前修订里找不到/);
  const out = saveRevision(callIn(dir), { operations: [
    note("借阅"),
    { op: "update", item: "DN-001", base_revision: 2, fields: { 内容: "口令是进门时说的一句话。" } },
    { op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "登录（引两条）" }, sources: [
      { kind: "条目", locator: "DN-003", excerpt: "借阅是登录时输入的一串字符", supports: [{ field: "名称" }] },
      { kind: "条目", locator: "DN-001", excerpt: "进门时说的一句话", supports: [{ field: "名称" }] },
    ] },
  ] });
  assert.equal(out.details.revision_no, 3);
  assert.deepEqual(itemRows(dir, "UC-001", 3).map((row) => [row.locator, row.depends_revision]), [["DN-003", 3], ["DN-001", 3]]);
  // 同一批里的条目引用字段照样可以指向排在前面新增的条目。
  saveRevision(callIn(dir), { operations: [note("续借"),
    { op: "add", collection: "问题", fields: { 事项: "借阅期限", 状态: "未解决", 关联条目: ["DN-004"] }, sources: [SOURCE] }] });
});

test("来源种类「条目」：这个条目后来被修改而这条来源原样沿用时，记下的修订号不变；助手重新写上同一条来源才换成最新的", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [cite("DN-001")] }); // 修订 3，引用时 DN-001 是修订 2
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "DN-001", base_revision: 2, fields: { 内容: "口令是登录时输入的一串字符，区分大小写，至少八位。" } }] }); // 修订 4
  // 只改 UC-001 的别的字段，来源沿用。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 3, fields: { 步骤: ["打开页面", "输入口令"] } }] }); // 修订 5
  assert.deepEqual(itemRows(dir, "UC-001", 5).map((row) => [row.locator, row.depends_revision]), [["DN-001", 2]]);
  // 重新写上同一条来源：与原来的合成一条，修订号换成 DN-001 现在的。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 5, fields: { 步骤: ["打开页面", "输入口令", "点登录"] },
    sources: [{ kind: "条目", locator: "DN-001", excerpt: "登录时输入的一串字符", supports: [{ field: "名称" }] }] }] }); // 修订 6
  assert.deepEqual(itemRows(dir, "UC-001", 6).map((row) => [row.locator, row.depends_revision]), [["DN-001", 4]]);
});

test("来源种类「条目」：用户在界面上改字段、撤销，都不算重新引用，沿用下来的来源记的修订号不变", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1,
    sources: [SOURCE, { kind: "条目", locator: "DN-001", excerpt: "登录时输入的一串字符", supports: [{ field: "步骤" }] }] }] }); // 修订 3
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "DN-001", base_revision: 2, fields: { 内容: "口令是登录时输入的一串字符，区分大小写，至少八位。" } }] }); // 修订 4
  let n = 0;
  const ui = (body: Record<string, unknown>) => runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-dn-${++n}`, ...body });
  // 用户改「名称」：指到「步骤」的那条来源沿用。
  const edit = ui({ kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 3 }], fields: { 名称: "用口令登录" } });
  assert.equal(edit.results[0].revision_no, 5);
  assert.deepEqual(itemRows(dir, "UC-001", 5).map((row) => [row.locator, row.field, row.depends_revision]), [["DN-001", "步骤", 2]]);
  // 撤销这次修改：来源照修订 3 的原样交回，修订号还是当时的。
  ui({ kind: "undo", targets: [{ revision_no: 5 }] });
  assert.deepEqual(itemRows(dir, "UC-001", 6).map((row) => [row.locator, row.field, row.depends_revision]), [["DN-001", "步骤", 2]]);
});

test("来源种类「图」：出处不是图的编号、任务里没有这张图，都拒绝并说明出处该怎样写", () => {
  const dir = workspace();
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("FIG-001", 1, "UC-001", "登录", "图")] }),
    /第 1 条来源的种类是「图」，出处 FIG-001 不是图的编号[\s\S]*出处写一张还在的图的编号，例如 D-001/);
  assert.throws(() => saveRevision(callIn(dir), { operations: [cite("D-001", 1, "UC-001", "登录", "图")] }),
    /第 1 条来源的种类是「图」，出处 D-001 指向的图在这个任务里不存在/);
});

test("任务 skill 写了业务说明的做法，不出现平台的内部用词", () => {
  // 任务 skill 里不出现这几个词。
  // 任务 skill 的文字分三份：每个阶段都要用的在 SKILL.md，核读材料与写条目各有一段在旁边 activities/ 的那两项活动里（原写 stages/ 目录里。
  const taskDir = resolve(import.meta.dirname, "../../task-types/requirements-engineering/.pi/skills/requirements-engineering");
  const task = ["SKILL.md", "activities/reading.md", "activities/writing.md"].map((name) => readFileSync(resolve(taskDir, name), "utf-8")).join("\n");
  for (const word of ["节点", "联系", "要素", "依据门", "派生", "投影", "schema"]) {
    assert.ok(!task.includes(word), `任务 skill 里有「${word}」`);
  }
  assert.match(task, /由五个条目集合组成：功能用例、非功能需求、约束、问题、业务说明/);
  assert.doesNotMatch(task, /领域说明/);
  assert.match(task, /各立成业务说明的一页主题（每一块怎样填见上文第 6 条）；材料里的术语定义段落也立成主题，标签贴「概念」/);
  assert.match(task, /4\. \*\*业务说明的每一页怎样填。\*\*/);
  for (const piece of ["一页一个主题", "「标题」写短", "「它是什么」用这件事自己的话写一两段", "有名字的人、具体的东西、具体的日子", "这种不算的例子以「反例：」开头",
    "「已经定下的」一句一条", "「标签」从概念、角色、流程、场景、目标、范围、假设、决定里选", "「上级主题」写它在哪一页之下讨论", "一次保存最多写 4 页主题"]) {
    assert.ok(task.includes(piece), piece);
  }
  assert.match(task, /例如用户说「我们说的预约保留期[\s\S]*「它是什么」只写到「书到馆后替预约的读者留着的那几天」为止[\s\S]*在「约束规则」里加上「过了保留期还没来取，预约自动取消」/);
});

test("任务定义的「界面」一项：真实任务类型的业务说明写了分组字段、靠前的组与说明；写错时逐条报出，「右侧栏页签」已经去掉，写了算多出来的一项", () => {
  const typeDir = resolve(import.meta.dirname, "../../task-types/requirements-engineering");
  const { definition } = loadDefinition(typeDir, "docs/task-definitions/requirements-engineering.json");
  assert.deepEqual(definition.collections.find((c) => c.name === "业务说明")!.display,
    { note: "按章整理的业务说明：每一节写它是什么、适用规则、待澄清事项，图与需求条目都归在它说明的那一节。", groupField: "标签", leadingGroups: ["概念"] });
  assert.equal(definition.collections.find((c) => c.name === "功能用例")!.display, null);
  const withDisplay = (display: unknown) => {
    const def = definitionWithNotes();
    def.交付物.条目集合.at(-1).界面 = display;
    return def;
  };
  assert.deepEqual(validateDefinition(withDisplay({ 分组字段: "类别" })).collections.at(-1)!.display,
    { note: null, groupField: "类别", leadingGroups: [] });
  assert.throws(() => validateDefinition(withDisplay({ 分组字段: "没有这个", 右侧栏页签: "是", 靠前的组: "术语", 颜色: "红", 说明: "" })), (error: Error) => {
    for (const piece of ["「分组字段」是「没有这个」，这个集合没有这个字段", "多了「右侧栏页签」这一项", "「靠前的组」应当是文字的列表",
      "多了「颜色」这一项", "「说明」应当是一段不为空的文字"]) assert.match(error.message, new RegExp(piece));
    return true;
  });
  assert.throws(() => validateDefinition(withDisplay({ 分组字段: "关联条目" })), /「分组字段」「关联条目」应当是文本字段、枚举字段，或者写了「取值」的文本列表字段/);
});
