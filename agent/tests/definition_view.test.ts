/**
 * 任务定义按会话给视图（lib/definition_view.ts、lib/definition_view_read.ts、hooks/definition_view.ts）：助手读任务定义文件时，
 * 拿到的是本会话的视图，原文件不改；两个处于不同活动的会话读同一份文件各得所需。
 */

import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { definitionViewFor } from "../src/hooks/definition_view.ts";
import { createTask } from "../src/lib/create_task.ts";
import { PLATFORM_PROBLEM_NAME } from "../src/lib/definition.ts";
import { VIEW_NOTE_KEY, VIEW_WRITABLE_KEY } from "../src/lib/definition_view.ts";
import { OVERALL_COLLECTION, OVERALL_FIELDS } from "../src/lib/overall_analysis.ts";
import { withTaskDatabase } from "../src/lib/schema.ts";
import { launchWorkItem } from "../src/lib/stage_read.ts";
import { DEFINITION_PATH, UI_SESSION, callIn, demoDefinition, enterStage, idleSessions, makeWorkspace, tempDir } from "./helpers.ts";

const SRS_TYPE_DIR = join(import.meta.dirname, "..", "..", "task-types", "requirements-engineering");
const SRS_DEFINITION_PATH = "docs/task-definitions/requirements-engineering.json";
const READ_SESSION = "sess-reading";
const DOC_SESSION = "sess-document";

type View = { [VIEW_NOTE_KEY]: string; 交付物: { 条目集合: Record<string, any>[] }; 完成条件: Record<string, unknown> };

/** 一次 read 的结果事件与上下文；返回扩展换上的视图（解析好的）与 details，不换时返回 undefined。 */
function readAs(dir: string, session: string, input: Record<string, unknown> = { path: SRS_DEFINITION_PATH }, isError = false) {
  const got = definitionViewFor({ toolName: "read", input, isError, details: { truncation: null } }, { cwd: dir, sessionManager: { getSessionId: () => session } });
  return got && { view: JSON.parse(got.content[0].text) as View, details: got.details as Record<string, unknown> };
}

/** 产品的需求工程任务：一条会话在需求分析的核读材料，另一条在单项活动「编写文档」里。 */
function twoSessions(): string {
  const dir = tempDir("tw-definition-view-");
  cpSync(SRS_TYPE_DIR, dir, { recursive: true });
  createTask(callIn(dir), { definition_path: SRS_DEFINITION_PATH });
  enterStage(dir, "reading", [UI_SESSION, READ_SESSION]);
  withTaskDatabase(dir, { createIfMissing: false }, (db) => {
    const task = db.prepare("SELECT task_id FROM task LIMIT 1").get() as { task_id: string };
    // 夹具直接记一个编写文档的单项工作项（产品里要先有确认的条目，这里不测启动的前提）。
    launchWorkItem(db, { taskId: task.task_id, sessionId: DOC_SESSION, runId: null, callId: "ui-op-doc", actor: "user", to: "document", inFlow: false, reason: "" });
  });
  return dir;
}

const names = (view: View) => view.交付物.条目集合.map((one) => one.名称);
const byName = (view: View, name: string) => view.交付物.条目集合.find((one) => one.名称 === name)!;
const fieldNames = (collection: Record<string, any>) => (collection.字段 as { 名: string }[]).map((one) => one.名);

test("两个处于不同活动的会话读同一份任务定义：原文件一个字不变，各得本会话的视图", () => {
  const dir = twoSessions();
  const file = join(dir, SRS_DEFINITION_PATH);
  const before = readFileSync(file, "utf-8");
  const original = JSON.parse(before);

  const reading = readAs(dir, READ_SESSION)!;
  const document = readAs(dir, DOC_SESSION)!;
  assert.equal(readFileSync(file, "utf-8"), before);

  // 核读材料：读材料与知识库，能写页与问题——只列这两个集合，都可写，全部字段照原样，只是没有导语那一栏。
  assert.deepEqual(names(reading.view), [PLATFORM_PROBLEM_NAME, OVERALL_COLLECTION]);
  assert.ok(reading.view.交付物.条目集合.every((one) => one[VIEW_WRITABLE_KEY] === true));
  const page = byName(reading.view, OVERALL_COLLECTION);
  const originalPage = original.交付物.条目集合.find((one: { 名称?: string }) => one.名称 === OVERALL_COLLECTION);
  assert.deepEqual(fieldNames(page), fieldNames(originalPage).filter((one: string) => one !== OVERALL_FIELDS.intro));
  assert.ok(fieldNames(originalPage).includes(OVERALL_FIELDS.intro));
  assert.deepEqual(page.字段.find((one: { 名: string }) => one.名 === "标签").取值, originalPage.字段.find((one: { 名: string }) => one.名 === "标签").取值);
  assert.deepEqual(Object.keys(reading.view.完成条件).sort(), [PLATFORM_PROBLEM_NAME, OVERALL_COLLECTION].sort());
  assert.match(reading.view[VIEW_NOTE_KEY], /核读材料/);
  assert.deepEqual(reading.details, { truncation: null, definition_view: { stage: "reading" } });

  // 编写文档：读全部，能写页、问题、发布——条目集合列出来只供参照（字段只有名字与类型），页与问题可写，导语那一栏在。
  assert.deepEqual(names(document.view), ["功能用例", "非功能需求", "约束", PLATFORM_PROBLEM_NAME, OVERALL_COLLECTION]);
  for (const name of ["功能用例", "非功能需求", "约束"]) {
    const one = byName(document.view, name);
    assert.equal(one[VIEW_WRITABLE_KEY], false);
    assert.deepEqual(Object.keys(one).sort(), ["名称", "编号前缀", VIEW_WRITABLE_KEY, "字段"].sort());
    assert.ok((one.字段 as Record<string, unknown>[]).every((field) => Object.keys(field).join() === "名,类型"));
  }
  assert.ok(fieldNames(byName(document.view, OVERALL_COLLECTION)).includes(OVERALL_FIELDS.intro));
  assert.equal(byName(document.view, OVERALL_COLLECTION)[VIEW_WRITABLE_KEY], true);
  assert.match(document.view[VIEW_NOTE_KEY], /编写文档/);

  // 别的部分照原文件。
  assert.equal((reading.view as unknown as Record<string, unknown>).执行方法, original.执行方法);
  assert.deepEqual((document.view as unknown as Record<string, unknown>).资产显示名, original.资产显示名);
});

test("不管 read 写了从第几行读、读几行，都给整份视图；相对路径、绝对路径都认", () => {
  const dir = twoSessions();
  const whole = readAs(dir, READ_SESSION)!.view;
  assert.deepEqual(readAs(dir, READ_SESSION, { path: SRS_DEFINITION_PATH, offset: 20, limit: 5 })!.view, whole);
  assert.deepEqual(readAs(dir, READ_SESSION, { path: join(dir, SRS_DEFINITION_PATH) })!.view, whole);
});

test("不换的情形：读别的文件、读出错、早先的任务（没有阶段）、定义文件不是合法的 JSON", () => {
  const dir = twoSessions();
  assert.equal(readAs(dir, READ_SESSION, { path: "inputs/材料.md" }), undefined);
  assert.equal(readAs(dir, READ_SESSION, { path: SRS_DEFINITION_PATH }, true), undefined);
  assert.equal(definitionViewFor({ toolName: "grep", input: { path: SRS_DEFINITION_PATH }, isError: false }, { cwd: dir }), undefined);

  const legacy = makeWorkspace(demoDefinition());
  createTask(callIn(legacy), { definition_path: DEFINITION_PATH });
  assert.equal(readAs(legacy, READ_SESSION, { path: DEFINITION_PATH }), undefined);

  writeFileSync(join(dir, SRS_DEFINITION_PATH), "{ 坏了", "utf-8");
  assert.equal(readAs(dir, READ_SESSION), undefined);
});

test("空闲的会话：按读全部办，能写页与问题；导语那一栏不出现", () => {
  const dir = twoSessions();
  idleSessions(dir);
  const idle = readAs(dir, READ_SESSION)!;
  assert.deepEqual(idle.details.definition_view, { stage: "idle" });
  assert.deepEqual(names(idle.view), ["功能用例", "非功能需求", "约束", PLATFORM_PROBLEM_NAME, OVERALL_COLLECTION]);
  assert.deepEqual(idle.view.交付物.条目集合.map((one) => one[VIEW_WRITABLE_KEY]), [false, false, false, true, true]);
  assert.ok(!fieldNames(byName(idle.view, OVERALL_COLLECTION)).includes(OVERALL_FIELDS.intro));
  assert.match(idle.view[VIEW_NOTE_KEY], /空闲/);
});
