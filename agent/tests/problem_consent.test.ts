// 问题条目了结之前的同意（lib/problem_consent.ts 与 lib/save_revision.ts）：助手把问题条目改为「已解决」或「用户决定保留」，
// 要用户在「这个问题是否已解决」的卡片上点过对应的那一项；以最近一次点击为准；点了之后问题条目或它牵涉的条目又改过就要重新问；
// 新增问题条目时状态不能直接写成这两种；用户在界面上的操作不受限。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { ACTOR_USER } from "../src/lib/db.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, SOURCE, cardClick, count, demoDefinition, makeWorkspace, problemCard, problemClicksOn, query, userEntry } from "./helpers.ts";

const SESSION = "session-problem";
let serial = 0;
const call = (dir: string, problemClicks: unknown[] = []) =>
  ({ workspaceDir: dir, sessionId: SESSION, callId: `call-p-${++serial}`, problemClicks: problemClicks as never });

/** 问题集合带「用户决定保留」与「关联条目」。建好之后：UC-001 在修订 1，TBD-001（关联 UC-001）在修订 2，TBD-002（关联 UC-001）在修订 3。 */
function workspace(): string {
  const definition = demoDefinition() as any;
  definition.交付物.条目集合[1].字段 = [
    { 名: "事项", 类型: "文本", 必填: true },
    { 名: "状态", 类型: "枚举", 必填: true, 取值: ["未解决", "已解决", "用户决定保留"] },
    { 名: "处理结果", 类型: "文本", 必填: false },
    { 名: "关联条目", 类型: "条目引用", 必填: false },
  ];
  const dir = makeWorkspace(definition);
  createTask(call(dir), { definition_path: DEFINITION_PATH });
  saveRevision(call(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["输入口令"] }, sources: [SOURCE] }] });
  saveRevision(call(dir), { operations: [{ op: "add", collection: "问题", fields: { 事项: "口令多长？", 状态: "未解决", 关联条目: ["UC-001"] }, sources: [SOURCE] }] });
  saveRevision(call(dir), { operations: [{ op: "add", collection: "问题", fields: { 事项: "要不要短信登录？", 状态: "未解决", 关联条目: ["UC-001"] }, sources: [SOURCE] }] });
  return dir;
}

const settle = (dir: string, status: string, clicks: unknown[], item = "TBD-001", base?: number) =>
  saveRevision(call(dir, clicks), { operations: [{ op: "update", item, base_revision: base ?? (item === "TBD-001" ? 2 : 3), fields: { 状态: status, 处理结果: "按用户的答复" } }] });
const refused = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail("应当被拒绝");
};
const statusOf = (dir: string, item: string) =>
  JSON.parse(query<any>(dir, "SELECT fields FROM item_version WHERE item_id = ? ORDER BY revision_no DESC LIMIT 1", item)[0].fields).状态;
const TBD1 = [{ item_id: "TBD-001", revision_no: 2 }];

test("没有问就改为已解决：整批拒绝，写明用户还没点，指引发卡片、打字不算；什么都没写入", () => {
  const dir = workspace();
  const before = count(dir, "revision");
  const text = refused(() => settle(dir, "已解决", []));
  assert.match(text, /操作 1（修改，条目 TBD-001）：助手想把 TBD-001 的状态改为「已解决」，但用户还没有在问 TBD-001 是否已解决的卡片上点「已解决」。/);
  assert.match(text, /怎么办：请用回复的请选择（choose）问用户这个问题是否已解决：在 items 里点名 TBD-001，三个选项是「已解决」「还没解决，继续改」「先不管，保留」；用户点了「已解决」之后再把状态改为「已解决」。用户在对话里打字说已经解决不算，照样先发卡片/);
  assert.ok(!/执行者/.test(text), "说明里不出现内部用词");
  assert.equal(count(dir, "revision"), before);
  assert.equal(statusOf(dir, "TBD-001"), "未解决");
});

test("发了卡片、用户点「已解决」：放行；点「还没解决，继续改」：拒绝，写明选的是哪一项", () => {
  const dir = workspace();
  const no = problemClicksOn(dir, SESSION, [userEntry("按 8 位改"), problemCard("k1", TBD1), ...cardClick("k1", "b", "还没解决，继续改")]);
  assert.match(refused(() => settle(dir, "已解决", no)), /用户在最近一张问 TBD-001 是否已解决的卡片上选的是「还没解决，继续改」/);
  const yes = problemClicksOn(dir, SESSION, [userEntry("按 8 位改"), problemCard("k2", TBD1), ...cardClick("k2", "a", "已解决")]);
  assert.match(settle(dir, "已解决", yes).text, /修改了条目 TBD-001/);
  assert.equal(statusOf(dir, "TBD-001"), "已解决");
});

test("用户决定保留对应「先不管，保留」；点的是「已解决」不能改成用户决定保留", () => {
  const dir = workspace();
  const resolved = problemClicksOn(dir, SESSION, [userEntry("好"), problemCard("k1", TBD1), ...cardClick("k1", "a", "已解决")]);
  assert.match(refused(() => settle(dir, "用户决定保留", resolved)), /助手想把 TBD-001 的状态改为「用户决定保留」，但用户在最近一张问 TBD-001 是否已解决的卡片上选的是「已解决」/);
  const kept = problemClicksOn(dir, SESSION, [userEntry("好"), problemCard("k2", TBD1), ...cardClick("k2", "c", "先不管，保留")]);
  assert.match(settle(dir, "用户决定保留", kept).text, /修改了条目 TBD-001/);
  assert.equal(statusOf(dir, "TBD-001"), "用户决定保留");
});

test("选项文字带标点或空白也认得；键随便写", () => {
  const dir = workspace();
  const options = [{ key: "x", text: "已解决。" }, { key: "y", text: "还没解决,继续改" }, { key: "z", text: "先不管, 保留" }];
  const clicks = problemClicksOn(dir, SESSION, [userEntry("好"), problemCard("k1", TBD1, options), ...cardClick("k1", "x", "已解决。")]);
  assert.match(settle(dir, "已解决", clicks).text, /修改了条目 TBD-001/);
});

test("用户照着卡片的话打字不算点击；卡片没点名问题条目也不算问过", () => {
  const dir = workspace();
  const typed = problemClicksOn(dir, SESSION, [userEntry("好"), problemCard("k1", TBD1), userEntry("我选：已解决")]);
  assert.match(refused(() => settle(dir, "已解决", typed)), /用户还没有在问 TBD-001 是否已解决的卡片上点「已解决」/);
  const unnamed = problemClicksOn(dir, SESSION, [userEntry("好"), problemCard("k2", []), ...cardClick("k2", "a", "已解决")]);
  assert.match(refused(() => settle(dir, "已解决", unnamed)), /用户还没有在问 TBD-001 是否已解决的卡片上点「已解决」/);
});

test("点击没有记进对话行为表时不算（无从知道点在什么时候）", () => {
  const dir = workspace();
  const branch = [userEntry("好"), problemCard("k1", TBD1), ...cardClick("k1", "a", "已解决")];
  const clicks = problemClicksOn(dir, "another-session", branch);
  assert.match(refused(() => settle(dir, "已解决", clicks)), /用户还没有在问 TBD-001 是否已解决的卡片上点「已解决」/);
});

test("以最近一次点击为准：先点「已解决」，后来在新卡片上点「还没解决，继续改」，拒绝；别的问题的卡片不影响", () => {
  const dir = workspace();
  const clicks = problemClicksOn(dir, SESSION, [
    userEntry("好"), problemCard("k1", TBD1), ...cardClick("k1", "a", "已解决"),
    problemCard("k2", TBD1), ...cardClick("k2", "b", "还没解决，继续改"),
    problemCard("k3", [{ item_id: "TBD-002", revision_no: 3 }]), ...cardClick("k3", "a", "已解决"),
  ]);
  assert.match(refused(() => settle(dir, "已解决", clicks)), /选的是「还没解决，继续改」/);
  assert.match(settle(dir, "已解决", clicks, "TBD-002").text, /修改了条目 TBD-002/);
});

test("问别的事的请选择（选项不是这三个）点名了问题条目，不顶替先前的点击", () => {
  const dir = workspace();
  const other = [{ key: "a", text: "允许" }, { key: "b", text: "不允许" }];
  const clicks = problemClicksOn(dir, SESSION, [
    userEntry("好"), problemCard("k1", TBD1), ...cardClick("k1", "a", "已解决"),
    problemCard("k2", TBD1, other), ...cardClick("k2", "b", "不允许"),
  ]);
  assert.match(settle(dir, "已解决", clicks).text, /修改了条目 TBD-001/);
});

test("一张卡片问两个问题：一次点击对两条都算", () => {
  const dir = workspace();
  const clicks = problemClicksOn(dir, SESSION, [userEntry("好"), problemCard("k1", [...TBD1, { item_id: "TBD-002", revision_no: 3 }]), ...cardClick("k1", "a", "已解决")]);
  const outcome = saveRevision(call(dir, clicks), { operations: [
    { op: "update", item: "TBD-001", base_revision: 2, fields: { 状态: "已解决" } },
    { op: "update", item: "TBD-002", base_revision: 3, fields: { 状态: "已解决" } },
  ] });
  assert.match(outcome.text, /一共 2 个操作/);
  assert.equal(statusOf(dir, "TBD-002"), "已解决");
});

test("点了之后问题条目本身又改过：要重新问", () => {
  const dir = workspace();
  const clicks = problemClicksOn(dir, SESSION, [userEntry("好"), problemCard("k1", TBD1), ...cardClick("k1", "a", "已解决")]);
  saveRevision(call(dir, clicks), { operations: [{ op: "update", item: "TBD-001", base_revision: 2, fields: { 处理结果: "先写结果" } }] });
  assert.match(refused(() => settle(dir, "已解决", clicks, "TBD-001", 4)), /用户点「已解决」之后，TBD-001 又改到了修订 4，要重新问/);
});

test("点了之后用户在页面上改了牵涉的条目：要重新问（不论是谁改的）", () => {
  const dir = workspace();
  const clicks = problemClicksOn(dir, SESSION, [userEntry("好"), problemCard("k1", TBD1), ...cardClick("k1", "a", "已解决")]);
  runUserOperation({ workspaceDir: dir, sessionId: SESSION }, { op_id: "ui-op-edit", kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 名称: "用口令登录" } });
  assert.match(refused(() => settle(dir, "已解决", clicks)), /用户点「已解决」之后，UC-001 又改到了修订 4，要重新问/);
});

test("点了之后牵涉的条目被删除：要重新问", () => {
  const dir = workspace();
  const clicks = problemClicksOn(dir, SESSION, [userEntry("好"), problemCard("k1", TBD1), ...cardClick("k1", "a", "已解决")]);
  saveRevision(call(dir), { operations: [{ op: "delete", item: "UC-001", base_revision: 1 }] });
  assert.match(refused(() => settle(dir, "已解决", clicks)), /用户点「已解决」之后，UC-001 又在修订 4 删除了，要重新问/);
});

test("同一批里又改了牵涉的条目：拒绝，指引先单独保存那处修改再问", () => {
  const dir = workspace();
  const clicks = problemClicksOn(dir, SESSION, [userEntry("好"), problemCard("k1", TBD1), ...cardClick("k1", "a", "已解决")]);
  const text = refused(() => saveRevision(call(dir, clicks), { operations: [
    { op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } },
    { op: "update", item: "TBD-001", base_revision: 2, fields: { 状态: "已解决" } },
  ] }));
  assert.match(text, /操作 2（修改，条目 TBD-001）：助手想把 TBD-001 的状态改为「已解决」，但这一批操作里还改了它牵涉的 UC-001，用户点「已解决」时还没有这些改动，要重新问。\n  怎么办：先单独保存对 UC-001 的修改；请用回复的请选择/);
});

test("点击之前改过的不算：先改牵涉的条目，再问，用户点了之后放行", () => {
  const dir = workspace();
  saveRevision(call(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } }] });
  const clicks = problemClicksOn(dir, SESSION, [userEntry("好"), problemCard("k1", TBD1), ...cardClick("k1", "a", "已解决")]);
  assert.match(settle(dir, "已解决", clicks).text, /修改了条目 TBD-001/);
});

test("状态没有变、改回未解决、只改处理结果：不核对", () => {
  const dir = workspace();
  const clicks = problemClicksOn(dir, SESSION, [userEntry("好"), problemCard("k1", TBD1), ...cardClick("k1", "a", "已解决")]);
  settle(dir, "已解决", clicks);
  assert.match(saveRevision(call(dir), { operations: [{ op: "update", item: "TBD-001", base_revision: 4, fields: { 状态: "已解决", 处理结果: "补一句" } }] }).text, /修改了条目/);
  assert.match(saveRevision(call(dir), { operations: [{ op: "update", item: "TBD-001", base_revision: 5, fields: { 状态: "未解决" } }] }).text, /修改了条目/);
});

test("新增问题条目时状态直接写成已解决或用户决定保留：拒绝；写未解决照旧", () => {
  const dir = workspace();
  const add = (status: string) => saveRevision(call(dir), { operations: [{ op: "add", collection: "问题", fields: { 事项: "要不要记住我？", 状态: status }, sources: [SOURCE] }] });
  assert.match(refused(() => add("已解决")), /新增的问题条目状态不能直接写成「已解决」。\n  怎么办：先按「未解决」记下，用问这个问题是否已解决的卡片问过用户、用户点了「已解决」之后再改状态/);
  assert.match(refused(() => add("用户决定保留")), /不能直接写成「用户决定保留」[\s\S]*用户点了「先不管，保留」之后再改状态/);
  assert.match(add("未解决").text, /新增了条目 TBD-003/);
});

test("用户在页面上的操作不受限：直接把问题改为已解决、标为先不管，都照旧", () => {
  const dir = workspace();
  const edit = saveRevision({ workspaceDir: dir, sessionId: SESSION, callId: "ui-op-1", actor: ACTOR_USER }, {
    operations: [{ op: "update", item: "TBD-001", base_revision: 2, fields: { 状态: "已解决" } }],
  });
  assert.match(edit.text, /修改了条目 TBD-001/);
  const keep = runUserOperation({ workspaceDir: dir, sessionId: SESSION }, { op_id: "ui-op-keep", kind: "keep_pending", targets: [{ item_id: "TBD-002", base_revision: 3 }] });
  assert.match(keep.note, /TBD-002 标为先不管/);
  assert.equal(statusOf(dir, "TBD-002"), "用户决定保留");
});

test("问题集合没有「用户决定保留」时不算问题条目，不核对（与现有字段限制同一个判据）", () => {
  const dir = makeWorkspace();
  createTask(call(dir), { definition_path: DEFINITION_PATH });
  saveRevision(call(dir), { operations: [{ op: "add", collection: "问题", fields: { 事项: "口令多长？", 状态: "已解决" }, sources: [SOURCE] }] });
  assert.match(saveRevision(call(dir), { operations: [{ op: "update", item: "TBD-001", base_revision: 1, fields: { 状态: "未解决" } }] }).text, /修改了条目/);
});
