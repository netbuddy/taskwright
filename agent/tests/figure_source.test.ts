/**
 * 条目依据图（来源种类「图」）：出处写图的编号，摘录可以不写、写了要逐字出现在图现在的 Mermaid 文本里；
 * 保存时记下引用这一刻图自己的修订号；图不存在、已经删除、摘录对不上都拒绝；用户撤销时旧来源原样交回。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { type DiagramCheck, type SaveDiagramParams, saveDiagram } from "../src/lib/save_diagram.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { EXECUTOR_SOURCE_KINDS, SOURCE_FIGURE } from "../src/lib/schema.ts";
import { DEFINITION_PATH, SOURCE, callIn, makeWorkspace, query } from "./helpers.ts";

const USER_SAID = "把登录画成一张流程图";
const ok = async (): Promise<DiagramCheck> => ({ ok: true });
const MERMAID = 'flowchart TD\n  a(["UC-001 登录"]) --> b["输入口令"]\n  b --> c{"口令对不对"}\n  c -- 对 --> d["进入首页"]\n  c -- 不对 --> b';
const call = (dir: string) => ({ ...callIn(dir), userMessages: [{ entryId: "u1", text: `${USER_SAID}，谢谢。` }] });
const draw = (dir: string, params: SaveDiagramParams) => saveDiagram(call(dir), params, { validate: ok, priorFailures: 0 });

/** 任务里有 UC-001「登录」（修订 1）与图 D-001「登录流程」（它的修订 1）。 */
async function workspace(): Promise<string> {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [SOURCE] }] });
  await draw(dir, { name: "登录流程", kind: "flowchart", mermaid: MERMAID, sources: [{ kind: "用户的话", excerpt: USER_SAID }, { kind: "条目", locator: "UC-001" }] });
  return dir;
}

const rows = (dir: string, item: string, revisionNo: number) =>
  query<any>(dir, "SELECT element_kind, kind, locator, excerpt, field, field_index, depends_revision FROM item_source WHERE item_id = ? AND revision_no = ? ORDER BY position, support_no", item, revisionNo)
    .map((row) => ({ ...row }));

test("助手可以填的来源种类有五种，最后一种是图", () => {
  assert.deepEqual([...EXECUTOR_SOURCE_KINDS], ["文档原文", "用户的话", "助手补充", "条目", SOURCE_FIGURE]);
});

test("条目依据图：不写摘录、摘录写节点上的文字都可以；记下引用时图的修订号，图改过之后再引用记的是新的修订号", async () => {
  const dir = await workspace();
  // 新增一个条目，整个条目依据这张图，不写摘录。
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "找回口令", 步骤: ["输入口令"] }, sources: [{ kind: "图", locator: "D-001" }] }] });
  assert.deepEqual(rows(dir, "UC-002", 2), [{ element_kind: "条目", kind: "图", locator: "D-001", excerpt: "", field: null, field_index: null, depends_revision: 1 }]);
  // 修改 UC-001：步骤依据图里的两个节点，摘录逐字抄节点上的文字；出处前后带空白也认。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 步骤: ["输入口令", "进入首页"] }, sources: [
    { kind: "图", locator: " D-001 ", excerpt: "输入口令", supports: [{ field: "步骤", index: 0 }] },
    { kind: "图", locator: "D-001", excerpt: "进入首页", supports: [{ field: "步骤", index: 1 }] },
  ] }] });
  assert.deepEqual(rows(dir, "UC-001", 3).filter((row) => row.kind === "图").map((row) => [row.locator, row.excerpt, row.field, row.field_index, row.depends_revision]),
    [["D-001", "输入口令", "步骤", 0, 1], ["D-001", "进入首页", "步骤", 1, 1]]);
  // 图改了一次（它的修订 2）之后再引用，新写的这一条记下的是 2；没有改到的字段上沿用的那一条、早先那两条记的还是 1。
  await draw(dir, { diagram: "D-001", base_revision: 1, note: "加了说明。" });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-002", base_revision: 2, fields: { 名称: "重设口令" }, sources: [{ kind: "图", locator: "D-001", excerpt: "口令对不对" }] }] });
  assert.deepEqual(rows(dir, "UC-002", 4).map((row) => [row.kind, row.locator, row.excerpt, row.depends_revision]), [["图", "D-001", "", 1], ["图", "D-001", "口令对不对", 2]]);
  assert.deepEqual(rows(dir, "UC-001", 3).filter((row) => row.kind === "图").map((row) => row.depends_revision), [1, 1]);
});

test("条目依据图：摘录在图现在的文本里找不到、图已经删除、图不存在、出处不是图的编号，都拒绝并说明", async () => {
  const dir = await workspace();
  const add = (source: Record<string, unknown>) => () =>
    saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "找回口令", 步骤: ["输入口令"] }, sources: [source] }] });
  assert.throws(add({ kind: "图", locator: "D-001", excerpt: "输入验证码" }),
    /第 1 条来源的摘录「输入验证码」在图 D-001 现在的 Mermaid 文本里找不到[\s\S]*摘录逐字抄图里一个节点上的文字[\s\S]*不好抄时可以不写摘录/);
  assert.throws(add({ kind: "图", locator: "D-002" }), /第 1 条来源的种类是「图」，出处 D-002 指向的图在这个任务里不存在[\s\S]*出处写一张还在的图的编号/);
  assert.throws(add({ kind: "图", locator: "UC-001" }), /第 1 条来源的种类是「图」，出处 UC-001 不是图的编号/);
  assert.throws(add({ kind: "图" }), /第 1 条来源缺少 locator（出处）/);
  await draw(dir, { diagram: "D-001", base_revision: 1, delete: true });
  assert.throws(add({ kind: "图", locator: "D-001" }), /第 1 条来源的种类是「图」，出处 D-001 指向的图已在它的修订 2 删除/);
  assert.equal(query(dir, "SELECT 1 FROM item WHERE item_id = 'UC-002'").length, 0, "被拒的条目没有写进去");
});
