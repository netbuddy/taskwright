// 修改时原来的来源宁可多留（lib/source_carry.ts 与 lib/save_revision.ts）：按内容认列表项，没改的内容上的来源一律保留，
// 删掉的项上的去掉，改写了的内容上的照旧留着并在结果里提醒；新给的来源接在后面，同一句摘录合成一条。
// 起点：「步骤」三项「甲、乙、丙」；来源一支持「名称」，来源二支持步骤第 1 项「乙」，来源三支持步骤第 2 项「丙」。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { alignList } from "../src/lib/source_carry.ts";
import { DEFINITION_PATH, callIn, makeWorkspace, query } from "./helpers.ts";

const S = (excerpt: string, supports: unknown[]) => ({ kind: "文档原文", locator: "inputs/材料.md", excerpt, supports });
const STEPS = ["甲：打开页面", "乙：输入口令", "丙：点登录"];

function start(): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: STEPS },
    sources: [S("用户可以登录。", [{ field: "名称" }]), S("登录总要输入口令。", [{ field: "步骤", index: 1 }]), S("用口令登录", [{ field: "步骤", index: 2 }])] }] });
  return dir;
}

/** 改一次，返回保存结果的文字与改后每条来源「摘录 → 支持哪几处（列表项写成那一项的文字）」。 */
function change(fields: Record<string, unknown>, sources?: unknown[]) {
  const dir = start();
  const outcome = saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields, ...(sources ? { sources } : {}) }] });
  const now = JSON.parse(query<any>(dir, "SELECT fields FROM item_version WHERE revision_no = 2")[0].fields);
  const rows = query<any>(dir, "SELECT position, excerpt, field, field_index FROM item_source WHERE revision_no = 2 ORDER BY position, support_no");
  const shown = rows.map((r) => `${r.excerpt} → ${r.field === null ? "整个条目" : r.field_index === null ? r.field : `${r.field}「${now[r.field][r.field_index]}」`}`);
  return { text: outcome.text, shown, positions: rows.map((r) => r.position) };
}

const NEW = S("退款须在七天内处理完毕。", [{ field: "名称" }]);

test("改普通字段并给了新来源：原来的来源留着，新的接在后面，结果里提醒改写了的「名称」上还留着旧来源", () => {
  const { text, shown } = change({ 名称: "用口令登录" }, [NEW]);
  assert.deepEqual(shown, ["用户可以登录。 → 名称", "登录总要输入口令。 → 步骤「乙：输入口令」", "用口令登录 → 步骤「丙：点登录」", "退款须在七天内处理完毕。 → 名称"]);
  assert.match(text, /\n提醒：UC-001 这次改写了的内容上还留着原来的来源：「名称」上的「用户可以登录。」（文档原文）。它们如果已经不支持改后的内容，请对 UC-001 做一次只给 sources、不改字段的修改，把要保留的来源全部重新写一遍，没写的就去掉。$/);
});

test("改列表里没有来源的一项并给了新来源：别的项上的来源都留着，不提醒", () => {
  const { text, shown } = change({ 步骤: ["甲2：打开首页", "乙：输入口令", "丙：点登录"] }, [S("退款须在七天内处理完毕。", [{ field: "步骤", index: 0 }])]);
  assert.deepEqual(shown.slice(1, 3), ["登录总要输入口令。 → 步骤「乙：输入口令」", "用口令登录 → 步骤「丙：点登录」"]);
  assert.equal(shown.length, 4);
  assert.doesNotMatch(text, /提醒/);
});

test("列表末尾加一项并给了新来源（试跑里的情形）：原有各项的来源都留着", () => {
  const { shown } = change({ 步骤: [...STEPS, "丁：看到首页"] }, [S("退款须在七天内处理完毕。", [{ field: "步骤", index: 3 }])]);
  assert.deepEqual(shown, ["用户可以登录。 → 名称", "登录总要输入口令。 → 步骤「乙：输入口令」", "用口令登录 → 步骤「丙：点登录」", "退款须在七天内处理完毕。 → 步骤「丁：看到首页」"]);
});

test("删掉第一项、给没给新来源都一样：其余各项的来源跟着那一项挪位置，不再整批被拒", () => {
  for (const sources of [[NEW], undefined]) {
    const { shown } = change({ 步骤: ["乙：输入口令", "丙：点登录"] }, sources);
    assert.deepEqual(shown.slice(1, 3), ["登录总要输入口令。 → 步骤「乙：输入口令」", "用口令登录 → 步骤「丙：点登录」"]);
  }
});

test("调换先后、给没给新来源都一样：来源跟着原来那一项走", () => {
  for (const sources of [[NEW], undefined]) {
    const { text, shown } = change({ 步骤: ["丙：点登录", "乙：输入口令", "甲：打开页面"] }, sources);
    assert.deepEqual(shown.slice(1, 3), ["登录总要输入口令。 → 步骤「乙：输入口令」", "用口令登录 → 步骤「丙：点登录」"]);
    assert.doesNotMatch(text, /提醒/);
  }
});

test("改普通字段不给来源：原来的来源留着，并提醒", () => {
  const { text, shown } = change({ 名称: "扫码登录" });
  assert.equal(shown[0], "用户可以登录。 → 名称");
  assert.match(text, /提醒：UC-001 这次改写了的内容上还留着原来的来源：「名称」上的「用户可以登录。」（文档原文）/);
});

test("列表开头插一项不给来源：来源不再悄悄指到别的项上", () => {
  const { text, shown } = change({ 步骤: ["零：打开应用", ...STEPS] });
  assert.deepEqual(shown, ["用户可以登录。 → 名称", "登录总要输入口令。 → 步骤「乙：输入口令」", "用口令登录 → 步骤「丙：点登录」"]);
  assert.doesNotMatch(text, /提醒/);
});

test("删掉最后一项不给来源：指到它的那条来源去掉，其余照旧，不再整批被拒", () => {
  const { shown } = change({ 步骤: ["甲：打开页面", "乙：输入口令"] });
  assert.deepEqual(shown, ["用户可以登录。 → 名称", "登录总要输入口令。 → 步骤「乙：输入口令」"]);
});

test("原地改写「乙」不给来源：来源指着改写后的那一项，并提醒是第几项", () => {
  const { text, shown } = change({ 步骤: ["甲：打开页面", "乙：扫码", "丙：点登录"] });
  assert.deepEqual(shown.slice(1), ["登录总要输入口令。 → 步骤「乙：扫码」", "用口令登录 → 步骤「丙：点登录」"]);
  assert.match(text, /提醒：UC-001 这次改写了的内容上还留着原来的来源：「步骤」第 2 项上的「登录总要输入口令。」（文档原文）。/);
});

test("原地改写「乙」并把原来那句摘录重新写上：算作表过态，合成一条，不提醒", () => {
  const { text, shown } = change({ 步骤: ["甲：打开页面", "乙：扫码", "丙：点登录"] }, [S("登录总要输入口令。", [{ field: "步骤", index: 1 }])]);
  assert.deepEqual(shown, ["用户可以登录。 → 名称", "登录总要输入口令。 → 步骤「乙：扫码」", "用口令登录 → 步骤「丙：点登录」"]);
  assert.doesNotMatch(text, /提醒/);
});

test("同一句摘录新给的支持别的几处：合成一条，支持的几处取并集", () => {
  const { shown, positions } = change({ 步骤: [...STEPS, "丁：看到首页"] }, [S("用口令登录", [{ field: "步骤", index: 3 }])]);
  assert.deepEqual(shown.slice(2), ["用口令登录 → 步骤「丙：点登录」", "用口令登录 → 步骤「丁：看到首页」"]);
  assert.deepEqual(positions, [1, 2, 3, 3], "还是三条来源，第三条支持两处");
});

test("字段被清空：指到它的来源去掉", () => {
  const dir = start();
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 备注: "临时" }, sources: [S("退款须在七天内处理完毕。", [{ field: "备注" }])] }] });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 2, fields: { 备注: "" } }] });
  assert.deepEqual(query<any>(dir, "SELECT excerpt FROM item_source WHERE revision_no = 3 ORDER BY position").map((r) => r.excerpt),
    ["用户可以登录。", "登录总要输入口令。", "用口令登录"]);
});

test("条目引用字段同样按内容认：前面插一个编号，指到后一个编号的来源跟着它", () => {
  const dir = start();
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "注销", 步骤: ["点注销"] }, sources: [S("用户可以登录。", [])] },
    { op: "add", collection: "问题", fields: { 事项: "口令多长？", 状态: "未解决", 关联条目: ["UC-001"] }, sources: [S("登录总要输入口令。", [{ field: "关联条目", index: 0 }])] },
  ] });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "TBD-001", base_revision: 2, fields: { 关联条目: ["UC-002", "UC-001"] } }] });
  assert.deepEqual(query<any>(dir, "SELECT field, field_index FROM item_source WHERE item_id = 'TBD-001' AND revision_no = 3").map((r) => [r.field, r.field_index]), [["关联条目", 1]]);
});

test("按内容认列表项：相同内容按先后对应；夹在对上的两项之间的算改写；前后颠倒的一段不配对；配不上的算删掉", () => {
  const fates = (a: string[], b: string[]) => alignList(a, b).map((f) => (f.to === null ? "删" : `${f.to}${f.rewritten ? "改" : ""}`)).join(" ");
  assert.equal(fates(["a", "b", "c"], ["a", "b", "c"]), "0 1 2");
  assert.equal(fates(["a", "b", "c"], ["x", "a", "b", "c"]), "1 2 3");
  assert.equal(fates(["a", "b", "c"], ["c", "b", "a"]), "2 1 0");
  assert.equal(fates(["a", "b", "c"], ["a", "c"]), "0 删 1");
  assert.equal(fates(["a", "b", "c"], ["a", "B", "c"]), "0 1改 2");
  assert.equal(fates(["a", "b", "c"], ["x", "a", "B", "c", "d"]), "1 2改 3");
  assert.equal(fates(["a", "a", "b"], ["b", "a", "a"]), "1 2 0");
  assert.equal(fates(["a", "b", "c"], ["a", "B1", "B2", "c"]), "0 1改 3");
  assert.equal(fates(["a", "b", "c", "d"], ["a", "X", "d"]), "0 1改 删 2");
  assert.equal(fates(["a", "b", "c"], ["c", "X", "a"]), "2 删 0", "a 与 c 调换了先后，中间一段不配对");
  assert.equal(fates(["a"], []), "删");
});
