/**
 * 问题条目的三个新字段与导语页的一条规矩（lib/save_revision.ts）：
 * 不阻断的问题要写何时回看；状态改成已解决时要写落实到；写下之后助手还能改的字段多了落实到、是否阻断下游、何时回看；
 * 任务定义里没有这几个字段的任务不受这几条管；总体分析的一章至多一页在用的导语页。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { ACTOR_USER } from "../src/lib/db.ts";
import { CHAPTERS } from "../src/lib/overall_chapters.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { DEFINITION_PATH, SOURCE, cardClick, makeWorkspace, overallDefinition, problemCard, problemClicksOn, query, userEntry } from "./helpers.ts";

const SESSION = "session-fields";
let serial = 0;
const call = (dir: string, problemClicks: unknown[] = [], actor?: string) =>
  ({ workspaceDir: dir, sessionId: SESSION, callId: `call-f-${++serial}`, problemClicks: problemClicks as never, ...(actor ? { actor } : {}) });

/** 问题集合照需求规格任务的写法，带三个新字段；总体分析带「导语所属章」。withNew 为假时是早先的定义：这四个字段都没有。 */
function workspace(withNew = true): string {
  const definition = overallDefinition() as any;
  const problems = definition.交付物.条目集合.find((one: any) => one.名称 === "问题");
  problems.字段 = [
    { 名: "事项", 类型: "文本", 必填: true },
    ...(withNew ? [{ 名: "是否阻断下游", 类型: "枚举", 必填: true, 取值: ["阻断下游", "不阻断"] }, { 名: "何时回看", 类型: "文本", 必填: false }] : []),
    { 名: "状态", 类型: "枚举", 必填: true, 取值: ["未解决", "已解决", "用户决定保留"] },
    { 名: "处理结果", 类型: "文本", 必填: false },
    ...(withNew ? [{ 名: "落实到", 类型: "文本", 必填: false }] : []),
    { 名: "关联条目", 类型: "条目引用", 必填: false },
  ];
  if (withNew) {
    definition.交付物.条目集合.find((one: any) => one.名称 === "总体分析").字段.push(
      { 名: "导语所属章", 类型: "枚举", 必填: false, 取值: CHAPTERS.map((one) => one.name) });
  }
  const dir = makeWorkspace(definition);
  createTask(call(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
const refused = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail("应当被拒绝");
};
const add = (dir: string, fields: Record<string, unknown>, collection = "问题", actor?: string) =>
  saveRevision(call(dir, [], actor), { operations: [{ op: "add", collection, fields, sources: [SOURCE] }] });
const fieldsOf = (dir: string, item: string) =>
  JSON.parse(query<any>(dir, "SELECT fields FROM item_version WHERE item_id = ? ORDER BY revision_no DESC LIMIT 1", item)[0].fields);
const revisionOf = (dir: string, item: string) =>
  Number(query<any>(dir, "SELECT MAX(revision_no) AS n FROM item_version WHERE item_id = ?", item)[0].n);
const page = (title: string, more: Record<string, unknown> = {}) => ({ 标题: title, 它是什么: `${title}的说明。`, 状态: "在用", ...more });

test("新增问题：不阻断的要写何时回看，没有写就拒绝并指引；写了、或者是阻断下游的，照常保存", () => {
  const dir = workspace();
  const text = refused(() => add(dir, { 事项: "罚款怎样缴纳？", 是否阻断下游: "不阻断", 状态: "未解决" }));
  assert.match(text, /「是否阻断下游」写的是「不阻断」，「何时回看」却没有写。/);
  assert.match(text, /怎么办：不阻断的问题是推后再看的，请在「何时回看」里写什么时候回来看它，例如「评审确认时」/);
  assert.equal(query(dir, "SELECT 1 FROM item").length, 0, "整批没有写入");
  add(dir, { 事项: "罚款怎样缴纳？", 是否阻断下游: "不阻断", 何时回看: "评审确认时", 状态: "未解决" });
  add(dir, { 事项: "借满时怎么办？", 是否阻断下游: "阻断下游", 状态: "未解决" });
  assert.deepEqual([fieldsOf(dir, "TBD-001").何时回看, fieldsOf(dir, "TBD-002").是否阻断下游], ["评审确认时", "阻断下游"]);
  // 是否阻断下游是必填的：不写照必填字段的规矩拒绝。
  assert.match(refused(() => add(dir, { 事项: "别的事", 状态: "未解决" })), /必填字段「是否阻断下游」没有填或者是空的/);
});

test("了结问题：状态改成已解决时要写落实到，没有写就拒绝并指引；写了才保存；改成用户决定保留不要求", () => {
  const dir = workspace();
  add(dir, { 事项: "借满时怎么办？", 是否阻断下游: "阻断下游", 状态: "未解决" });
  add(dir, { 事项: "罚款怎样缴纳？", 是否阻断下游: "不阻断", 何时回看: "评审确认时", 状态: "未解决" });
  const one = [{ item_id: "TBD-001", revision_no: 1 }];
  const yes = problemClicksOn(dir, SESSION, [userEntry("提示先还书"), problemCard("k1", one), ...cardClick("k1", "a", "已解决")]);
  const settle = (fields: Record<string, unknown>) =>
    saveRevision(call(dir, yes), { operations: [{ op: "update", item: "TBD-001", base_revision: revisionOf(dir, "TBD-001"), fields }] });
  const text = refused(() => settle({ 状态: "已解决", 处理结果: "借满时提示先还书。" }));
  assert.match(text, /操作 1（修改，条目 TBD-001）：TBD-001：状态改成了「已解决」，「落实到」却没有写。/);
  assert.match(text, /怎么办：请在「落实到」里写这个问题的答案写进了哪里：页、条目或图的编号加一句话/);
  assert.equal(fieldsOf(dir, "TBD-001").状态, "未解决");
  settle({ 状态: "已解决", 处理结果: "借满时提示先还书。", 落实到: "D-004 的分叉「有没有借满」：借满时提示先还书" });
  assert.deepEqual([fieldsOf(dir, "TBD-001").状态, fieldsOf(dir, "TBD-001").落实到], ["已解决", "D-004 的分叉「有没有借满」：借满时提示先还书"]);
  // 已经了结的问题再改处理结果：状态没有变，不再要求落实到（这里它本来就写着）。
  settle({ 处理结果: "借满时提示先还书，并显示最早的应还日期。" });
  // 先不管：没有落实，不要求写。
  const two = [{ item_id: "TBD-002", revision_no: 2 }];
  const keep = problemClicksOn(dir, SESSION, [userEntry("这个先放着"), problemCard("k2", two), ...cardClick("k2", "c", "先不管，保留")]);
  saveRevision(call(dir, keep), { operations: [{ op: "update", item: "TBD-002", base_revision: 2, fields: { 状态: "用户决定保留", 处理结果: "用户决定先不处理。" } }] });
  assert.equal(fieldsOf(dir, "TBD-002").状态, "用户决定保留");
});

test("写下之后助手还能改是否阻断下游与何时回看；改成不阻断仍要写何时回看；事项这类字段照旧不能改", () => {
  const dir = workspace();
  add(dir, { 事项: "借满时怎么办？", 是否阻断下游: "阻断下游", 状态: "未解决" });
  const update = (fields: Record<string, unknown>) =>
    saveRevision(call(dir), { operations: [{ op: "update", item: "TBD-001", base_revision: revisionOf(dir, "TBD-001"), fields }] });
  assert.match(refused(() => update({ 是否阻断下游: "不阻断" })), /「是否阻断下游」写的是「不阻断」，「何时回看」却没有写/);
  update({ 是否阻断下游: "不阻断", 何时回看: "写条目之前" });
  assert.deepEqual([fieldsOf(dir, "TBD-001").是否阻断下游, fieldsOf(dir, "TBD-001").何时回看], ["不阻断", "写条目之前"]);
  update({ 是否阻断下游: "阻断下游" });
  assert.equal(fieldsOf(dir, "TBD-001").是否阻断下游, "阻断下游");
  assert.match(refused(() => update({ 事项: "借满五本时怎么办？" })),
    /助手想改 TBD-001 的「事项」，但问题条目写下后只能改状态、处理结果、落实到、是否阻断下游与何时回看/);
});

test("用户在页面上的操作不受这两条管：不阻断而没有写何时回看也能存；之后助手改别的字段不被它挡住", () => {
  const dir = workspace();
  add(dir, { 事项: "罚款怎样缴纳？", 是否阻断下游: "不阻断", 状态: "未解决" }, "问题", ACTOR_USER);
  assert.equal(fieldsOf(dir, "TBD-001").何时回看, undefined);
  saveRevision(call(dir), { operations: [{ op: "update", item: "TBD-001", base_revision: 1, fields: { 处理结果: "先记下。" } }] });
  assert.equal(fieldsOf(dir, "TBD-001").处理结果, "先记下。");
});

test("任务定义里没有这几个字段的任务：照旧，不要求何时回看与落实到，可改的字段仍是状态与处理结果", () => {
  const dir = workspace(false);
  add(dir, { 事项: "借满时怎么办？", 状态: "未解决" });
  const one = [{ item_id: "TBD-001", revision_no: 1 }];
  const yes = problemClicksOn(dir, SESSION, [userEntry("提示先还书"), problemCard("k1", one), ...cardClick("k1", "a", "已解决")]);
  saveRevision(call(dir, yes), { operations: [{ op: "update", item: "TBD-001", base_revision: 1, fields: { 状态: "已解决", 处理结果: "提示先还书。" } }] });
  assert.equal(fieldsOf(dir, "TBD-001").状态, "已解决");
  add(dir, { 事项: "罚款怎样缴纳？", 状态: "未解决" });
  assert.match(refused(() => saveRevision(call(dir), { operations: [{ op: "update", item: "TBD-002", base_revision: 3, fields: { 事项: "罚款多少？" } }] })),
    /但问题条目写下后只能改状态与处理结果/);
});

test("导语页：一章至多一页在用的；同一批里立两页、库里已有一页再立，都拒绝并指出是哪一页；废弃了原来的才能另立；别的章不受影响", () => {
  const dir = workspace();
  add(dir, page("业务流程导语", { 导语所属章: "业务流程" }), "总体分析");
  assert.equal(fieldsOf(dir, "OA-001").导语所属章, "业务流程");
  const again = refused(() => add(dir, page("流程一章的导语", { 导语所属章: "业务流程" }), "总体分析"));
  assert.match(again, /「业务流程」这一章已经有一页在用的导语页：OA-001。/);
  assert.match(again, /怎么办：一章只立一页导语页，请改那一页，不要另立/);
  // 同一批里两页写同一章：第二页被拒，整批不写。
  const batch = refused(() => saveRevision(call(dir), { operations: [
    { op: "add", collection: "总体分析", fields: page("角色导语", { 导语所属章: "角色" }), sources: [SOURCE] },
    { op: "add", collection: "总体分析", fields: page("角色导语二", { 导语所属章: "角色" }), sources: [SOURCE] },
  ] }));
  assert.match(batch, /操作 2（新增，集合「总体分析」）：新增到「总体分析」的条目：「角色」这一章已经有一页在用的导语页：OA-002。/);
  assert.equal(query(dir, "SELECT 1 FROM item").length, 1);
  // 别的章照常；把普通的页改成已有导语页的那一章也拒绝；改导语页自己不算撞上自己。
  add(dir, page("角色导语", { 导语所属章: "角色" }), "总体分析");
  add(dir, page("借书", { 标签: ["流程"] }), "总体分析");
  assert.match(refused(() => saveRevision(call(dir), { operations: [{ op: "update", item: "OA-003", base_revision: revisionOf(dir, "OA-003"), fields: { 导语所属章: "业务流程" } }] })),
    /「业务流程」这一章已经有一页在用的导语页：OA-001/);
  saveRevision(call(dir), { operations: [{ op: "update", item: "OA-001", base_revision: 1, fields: { 它是什么: "这一章讲读者怎样借书、预约与续借。" } }] });
  // 原来的导语页废弃之后，这一章可以另立一页。
  saveRevision(call(dir), { operations: [{ op: "update", item: "OA-001", base_revision: revisionOf(dir, "OA-001"), fields: { 状态: "已废弃" } }] });
  add(dir, page("业务流程导语（新）", { 导语所属章: "业务流程" }), "总体分析");
  assert.equal(fieldsOf(dir, "OA-004").导语所属章, "业务流程");
  // 取值只能是七章的章名。
  assert.match(refused(() => add(dir, page("附录导语", { 导语所属章: "附录" }), "总体分析")), /导语所属章/);
});
