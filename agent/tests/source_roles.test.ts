/**
 * 按材料角色限定活动能用的材料（活动声明的「sources_from_roles」，lib/source_roles.ts）与「原文未给」配对缺失问题（lib/save_revision.ts）：
 * - 声明的这一栏怎样读；
 * - 保存修订：逆向解析（声明了既有规格说明）引用角色为证据的材料被拒，引用既有规格说明放行；没有声明这一栏的活动不受影响；
 * - 自带工具调用之前（hooks/source_roles.ts）：read 读证据被拦、读既有规格说明放行，grep 搜含证据的目录被拦，ls 不拦，没有声明的活动放行；
 * - 「原文未给」：没有配对的缺失问题被拒，同批记了、或者任务里已经有的放行。
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DefinitionHeadError, parseActivityDef } from "../src/lib/activity_def.ts";
import { createTask } from "../src/lib/create_task.ts";
import { insertMaterial } from "../src/lib/material_db.ts";
import { SaveRejected, saveRevision } from "../src/lib/save_revision.ts";
import { withTaskDatabase } from "../src/lib/schema.ts";
import { materialOfLocator, originalOf } from "../src/lib/source_roles.ts";
import { launchWorkItem } from "../src/lib/stage_read.ts";
import { sourceRoleBlock } from "../src/hooks/source_roles.ts";
import { CALL_SESSION, DEFINITION_PATH, SOURCE, callIn, count, enterStage, makeWorkspace, overallDefinition } from "./helpers.ts";

const PARSE = "sess-parse";
const EVIDENCE = { kind: "文档原文", locator: "inputs/证据.md", excerpt: "证据里的一句。" };
const page = (title: string, sources: unknown[] = [SOURCE]) =>
  ({ op: "add", collection: "业务说明", fields: { 标题: title, 它是什么: `${title}是馆里的一件事。`, 状态: "在用" }, sources });
const useCase = (name: string, steps: string[]) => ({ op: "add", collection: "用例", fields: { 名称: name, 步骤: steps }, sources: [SOURCE] });
const missing = (text: string, related: string) =>
  ({ op: "add", collection: "问题", fields: { 事项: text, 种类: "缺失", 状态: "未解决", 关联条目: [related] }, sources: [SOURCE] });

/** 问题集合照产品的任务类型带「种类」一栏（能记缺失）。 */
function definition(): Record<string, any> {
  const raw = overallDefinition();
  raw.交付物.条目集合[1].字段.splice(1, 0, { 名: "种类", 类型: "枚举", 必填: false, 取值: ["待澄清", "冲突", "缺失", "范围外", "后续迭代"] });
  return raw;
}

/**
 * 一个任务：inputs/材料.md 放在既有规格说明上传位，inputs/证据.md 放在补充证据上传位；会话 sess-parse 在做需求再工程的逆向解析，
 * 测试缺省的那条会话（callIn 的缺省）在做核读。返回任务目录。
 */
function workspace(): string {
  const dir = makeWorkspace(definition(), { material: true });
  writeFileSync(join(dir, "inputs/证据.md"), "证据里的一句。\n", "utf-8");
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  insertMaterial(dir, "inputs/材料.md", { slot: "spec", role: "既有规格说明" });
  insertMaterial(dir, "inputs/证据.md", { slot: "evidence", role: "证据" });
  enterStage(dir, "reading");
  withTaskDatabase(dir, { createIfMissing: false }, (db) => {
    const task = db.prepare("SELECT task_id FROM task LIMIT 1").get() as { task_id: string };
    launchWorkItem(db, { taskId: task.task_id, sessionId: PARSE, runId: null, callId: "ui-op-parse", actor: "user", to: "parse_spec", flow: "rewrite", reason: "" });
  });
  return dir;
}
function refusal(dir: string, session: string, operations: unknown[]): string | null {
  try {
    saveRevision(callIn(dir, session), { operations });
    return null;
  } catch (error) {
    assert.ok(error instanceof SaveRejected, String(error));
    return error.message;
  }
}

const HEAD = ["name: 逆向解析", "mode: batch", "purpose: 照原文解析。", "reads: materials", "writes: description", "writes_allowed: page, problem",
  "requires: has_materials", "example: 一句例子。", "template: parse_spec", "stage: reading"];
const file = (head: readonly string[]) => `---\n${head.join("\n")}\n---\n\n正文。\n`;

test("声明的「sources_from_roles」：逗号隔开的角色名，不写是空的；只能由用户发起的活动不能写", () => {
  assert.deepEqual(parseActivityDef(file([...HEAD, "sources_from_roles: 既有规格说明，旧版说明"]), "parse_spec", "parse_spec.md").sourcesFromRoles, ["既有规格说明", "旧版说明"]);
  assert.deepEqual(parseActivityDef(file(HEAD), "parse_spec", "parse_spec.md").sourcesFromRoles, []);
  const userOnly = ["name: 发布", "mode: user_only", "purpose: 发布。", "reads: all", "writes: document", "writes_allowed:", "requires:", "example: 一句。",
    "template:", "stage:", "sources_from_roles: 证据"];
  assert.throws(() => parseActivityDef(file(userOnly), "publish", "publish.md"), (error: unknown) => error instanceof DefinitionHeadError && /「sources_from_roles」/.test(error.message));
});

test("出处与派生文件：去掉段落号，只写文件名的接在材料目录后面；文字版按原件算", () => {
  assert.equal(materialOfLocator("inputs/需求.docx#12", "inputs/"), "inputs/需求.docx");
  assert.equal(materialOfLocator("需求.md", "inputs/"), "inputs/需求.md");
  assert.equal(originalOf("inputs/需求.docx.md"), "inputs/需求.docx");
  assert.equal(originalOf("inputs/办法.pdf.segments.json"), "inputs/办法.pdf");
  assert.equal(originalOf("inputs/说明.md"), "inputs/说明.md");
});

test("保存修订：逆向解析引用证据被拒并说明角色，引用既有规格说明放行；核读的工作项引用证据照旧放行", () => {
  const dir = workspace();
  const text = refusal(dir, PARSE, [page("借书", [EVIDENCE])])!;
  assert.ok(text.includes("第 1 条来源引用的「inputs/证据.md」是「证据」一类的材料"), text);
  assert.ok(text.includes("这一步只能引用「既有规格说明」一类的材料"), text);
  assert.equal(count(dir, "item"), 0);
  assert.equal(refusal(dir, PARSE, [page("借书")]), null);
  // 核读（没有声明这一栏）：同样的来源不受限。
  assert.equal(refusal(dir, CALL_SESSION, [{ ...page("还书", [EVIDENCE]), fields: { 标题: "还书", 它是什么: "还书是馆里的一件事。", 状态: "在用", 标签: ["流程"], 例子: ["小王周二还书。"] } }]), null);
});

test("「原文未给」：没有配对的缺失问题被拒；同一批记了关联它的缺失问题放行；任务里已经有的也放行", () => {
  const dir = workspace();
  const text = refusal(dir, PARSE, [useCase("借书", ["原文未给"])])!;
  assert.ok(text.includes("UC-001 的「步骤」写了「原文未给」"), text);
  assert.ok(text.includes("要同批记一条种类为缺失、「关联条目」写它的问题条目"), text);
  // 种类不是缺失的问题不算。
  const other = refusal(dir, PARSE, [useCase("借书", ["原文未给"]), { ...missing("借书原文未给步骤", "UC-001"), fields: { 事项: "借书原文未给步骤", 种类: "待澄清", 状态: "未解决", 关联条目: ["UC-001"] } }])!;
  assert.ok(other.includes("UC-001 的「步骤」写了「原文未给」"), other);
  assert.equal(refusal(dir, PARSE, [useCase("借书", ["原文未给"]), missing("UC-001 原文未给步骤", "UC-001")]), null);
  // 任务里已经有关联它的缺失问题：再改这条条目、仍写「原文未给」，放行。
  assert.equal(refusal(dir, PARSE, [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "借阅图书" } }]), null);
});

test("自带工具调用之前：逆向解析的 read 读证据被拦、读既有规格说明放行；grep 搜材料目录或不写 path 被拦，path 写既有规格说明放行；ls 不拦", () => {
  const dir = workspace();
  const ctx = (session: string) => ({ cwd: dir, sessionManager: { getSessionId: () => session } });
  const read = sourceRoleBlock({ toolName: "read", input: { path: "inputs/证据.md" } }, ctx(PARSE))!;
  assert.deepEqual(read, { block: true, reason: "这一步只读「既有规格说明」一类的材料：「inputs/证据.md」是「证据」一类的，这次没有读它。" });
  assert.equal(sourceRoleBlock({ toolName: "read", input: { path: "inputs/材料.md" } }, ctx(PARSE)), undefined);
  assert.equal(sourceRoleBlock({ toolName: "read", input: { path: join(dir, "docs/task-definitions/demo.json") } }, ctx(PARSE)), undefined, "不是材料的文件不管");
  const grep = sourceRoleBlock({ toolName: "grep", input: { pattern: "借书", path: "inputs" } }, ctx(PARSE))!;
  assert.match(grep.reason, /这次要搜的地方有「inputs\/证据\.md」，它是「证据」一类的，这次没有搜。请把 path 写成那份既有规格说明。$/);
  assert.ok(sourceRoleBlock({ toolName: "grep", input: { pattern: "借书" } }, ctx(PARSE)), "不写 path 是任务目录，含证据");
  assert.equal(sourceRoleBlock({ toolName: "grep", input: { pattern: "借书", path: "inputs/材料.md" } }, ctx(PARSE)), undefined);
  assert.equal(sourceRoleBlock({ toolName: "ls", input: { path: "inputs" } }, ctx(PARSE)), undefined);
});

test("自带工具调用之前：没有声明这一栏的活动（核读）与没有工作项的会话都放行", () => {
  const dir = workspace();
  const ctx = (session: string) => ({ cwd: dir, sessionManager: { getSessionId: () => session } });
  assert.equal(sourceRoleBlock({ toolName: "read", input: { path: "inputs/证据.md" } }, ctx(CALL_SESSION)), undefined);
  assert.equal(sourceRoleBlock({ toolName: "grep", input: { pattern: "借书", path: "inputs" } }, ctx(CALL_SESSION)), undefined);
  assert.equal(sourceRoleBlock({ toolName: "read", input: { path: "inputs/证据.md" } }, ctx("sess-nobody")), undefined);
});
