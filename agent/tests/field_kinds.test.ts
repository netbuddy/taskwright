/**
 * 字段声明的三样可选项：文本列表的「取值」（每一项只能从里面选，可以选几个）、条目引用的「只许本集合」与「至多一个」。
 * 定义校验认得写对写错；保存修订照着核对；两个键都写了的条目引用字段不许顺着它绕回自己。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { DefinitionError, validateDefinition } from "../src/lib/definition.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { DEFINITION_PATH, SOURCE, callIn, demoDefinition, makeWorkspace, query } from "./helpers.ts";

/** 示例定义加一个「主题」集合：标题、带取值的标签、只许本集合且至多一个的上级、不限集合的参见。 */
function definitionWithTopics(change: (topics: any) => void = () => {}): any {
  const raw = demoDefinition() as any;
  const topics = {
    名称: "主题", 编号前缀: "T",
    字段: [
      { 名: "标题", 类型: "文本", 必填: true },
      { 名: "标签", 类型: "文本列表", 必填: false, 取值: ["概念", "角色", "流程"] },
      { 名: "上级", 类型: "条目引用", 必填: false, 只许本集合: true, 至多一个: true },
      { 名: "参见", 类型: "条目引用", 必填: false },
    ],
  };
  change(topics);
  raw.交付物.条目集合.push(topics);
  return raw;
}

function reasonsOf(raw: unknown): string[] {
  try {
    validateDefinition(raw, "demo.json");
  } catch (error) {
    assert.ok(error instanceof DefinitionError);
    return error.reasons;
  }
  return [];
}

test("定义校验：文本列表可以写取值，条目引用可以写「只许本集合」「至多一个」，都读进字段声明里", () => {
  const definition = validateDefinition(definitionWithTopics(), "demo.json");
  const fields = definition.collections.find((c) => c.name === "主题")!.fields;
  assert.deepEqual(fields.map((f) => [f.name, f.values ?? null, f.sameCollection ?? false, f.single ?? false]), [
    ["标题", null, false, false], ["标签", ["概念", "角色", "流程"], false, false], ["上级", null, true, true], ["参见", null, false, false],
  ]);
  // 写 false 等于没写。
  const off = validateDefinition(definitionWithTopics((t) => Object.assign(t.字段[2], { 只许本集合: false, 至多一个: false })), "demo.json");
  assert.deepEqual([off.collections.at(-1)!.fields[2].sameCollection, off.collections.at(-1)!.fields[2].single], [undefined, undefined]);
});

test("定义校验：取值与两个键写错了地方或者写得不对，逐条说明", () => {
  const cases: [(t: any) => void, RegExp][] = [
    [(t) => (t.字段[1].取值 = []), /字段「标签」的「取值」应当是一个不为空、不重复的文字列表/],
    [(t) => (t.字段[1].取值 = ["概念", "概念"]), /字段「标签」的「取值」应当是一个不为空、不重复的文字列表/],
    [(t) => (t.字段[0].取值 = ["甲"]), /字段「标题」写了「取值」，只有枚举与文本列表类型的字段能写/],
    [(t) => (t.字段[1].只许本集合 = true), /字段「标签」写了「只许本集合」，只有条目引用类型的字段能写/],
    [(t) => (t.字段[0].至多一个 = true), /字段「标题」写了「至多一个」，只有条目引用类型的字段能写/],
    [(t) => (t.字段[2].至多一个 = "是"), /字段「上级」的「至多一个」应当写 true 或 false/],
  ];
  for (const [change, pattern] of cases) assert.ok(reasonsOf(definitionWithTopics(change)).some((r) => pattern.test(r)), String(pattern));
});

test("定义校验：分组字段可以是写了取值的文本列表；没有写取值的文本列表不行", () => {
  assert.deepEqual(reasonsOf(definitionWithTopics((t) => (t.界面 = { 分组字段: "标签" }))), []);
  const noValues = reasonsOf(definitionWithTopics((t) => {
    delete t.字段[1].取值;
    t.界面 = { 分组字段: "标签" };
  }));
  assert.ok(noValues.some((r) => /「分组字段」「标签」应当是文本字段、枚举字段，或者写了「取值」的文本列表字段/.test(r)));
});

/** 一个用带主题集合的定义建好任务的任务目录。 */
function workspace(): string {
  const dir = makeWorkspace(definitionWithTopics());
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
const topic = (fields: Record<string, unknown>) => ({ op: "add", collection: "主题", fields, sources: [SOURCE] });
const fieldsOf = (dir: string, id: string) =>
  JSON.parse(query<{ fields: string }>(dir, "SELECT fields FROM item_version WHERE item_id = ? ORDER BY revision_no DESC LIMIT 1", id)[0].fields);

test("保存修订：带取值的文本列表每一项都要在取值里、不重复；可以选几个，也可以不选", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [topic({ 标题: "预约取书", 标签: ["概念", "流程"] }), topic({ 标题: "读者" })] });
  assert.deepEqual(fieldsOf(dir, "T-001").标签, ["概念", "流程"]);
  assert.equal("标签" in fieldsOf(dir, "T-002"), false);
  assert.throws(() => saveRevision(callIn(dir), { operations: [topic({ 标题: "馆员", 标签: ["角色", "岗位"] })] }),
    /字段「标签」的第 2 项写的是 "岗位"，不在可以选的值里[^]*只能从「概念」、「角色」、「流程」里选，可以选几个/);
  assert.throws(() => saveRevision(callIn(dir), { operations: [topic({ 标题: "馆员", 标签: ["角色", "角色"] })] }), /字段「标签」里「角色」写了两次/);
  assert.throws(() => saveRevision(callIn(dir), { operations: [{ op: "update", item: "T-001", base_revision: 1, fields: { 标签: ["场景"] } }] }), /不在可以选的值里/);
  // 没有写取值的文本列表照旧什么都能写。
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["随便写", "什么都行"] }, sources: [SOURCE] }] });
});

test("保存修订：「至多一个」只许写一个；「只许本集合」只能指向同一个集合里的条目，同一批里排在前面新增的也认", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [
    topic({ 标题: "借阅" }),
    topic({ 标题: "预约取书", 上级: ["T-001"] }),
    { op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["选书", "预约"] }, sources: [SOURCE] },
  ] });
  assert.deepEqual(fieldsOf(dir, "T-002").上级, ["T-001"]);
  assert.throws(() => saveRevision(callIn(dir), { operations: [topic({ 标题: "保留期", 上级: ["T-001", "T-002"] })] }), /字段「上级」最多写一个条目编号，现在写了 2 个/);
  assert.throws(() => saveRevision(callIn(dir), { operations: [topic({ 标题: "保留期", 上级: ["UC-001"] })] }),
    /字段「上级」只能指向「主题」里的条目，UC-001 是「用例」里的/);
  // 同一批里排在前面新增的用例，也认得出不是本集合的。
  assert.throws(() => saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "取书", 步骤: ["到馆", "取书"] }, sources: [SOURCE] }, topic({ 标题: "保留期", 上级: ["UC-002"] }),
  ] }), /UC-002 是「用例」里的/);
  // 没有写这两个键的条目引用字段照旧：可以写几个，可以指向别的集合。
  saveRevision(callIn(dir), { operations: [topic({ 标题: "保留期", 上级: ["T-002"], 参见: ["UC-001", "T-001"] })] });
  assert.deepEqual(fieldsOf(dir, "T-003").参见, ["UC-001", "T-001"]);
  // 不写、写空数组都可以。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "T-003", base_revision: 2, fields: { 上级: [] } }] });
  assert.equal("上级" in fieldsOf(dir, "T-003"), false);
});

test("保存修订：两个键都写了的字段不许指向自己，也不许顺着它绕回自己", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [topic({ 标题: "甲" }), topic({ 标题: "乙", 上级: ["T-001"] }), topic({ 标题: "丙", 上级: ["T-002"] })] });
  assert.throws(() => saveRevision(callIn(dir), { operations: [{ op: "update", item: "T-001", base_revision: 1, fields: { 上级: ["T-001"] } }] }),
    /字段「上级」的第 1 个编号 T-001 指的就是这个条目自己/);
  assert.throws(() => saveRevision(callIn(dir), { operations: [{ op: "update", item: "T-001", base_revision: 1, fields: { 上级: ["T-003"] } }] }),
    /字段「上级」写成 T-003 之后会绕回这个条目自己（T-003 → T-002 → T-001）/);
  // 同一批里前一个操作刚改出来的上级也算在内：先把乙挂到丙下面会绕回（丙的上级是乙），被拒。
  assert.throws(() => saveRevision(callIn(dir), { operations: [{ op: "update", item: "T-002", base_revision: 1, fields: { 上级: ["T-003"] } }] }), /会绕回这个条目自己/);
  // 不成环的改法照常：把丙改挂到甲下面，再把乙挂到丙下面。
  saveRevision(callIn(dir), { operations: [
    { op: "update", item: "T-003", base_revision: 1, fields: { 上级: ["T-001"] } }, { op: "update", item: "T-002", base_revision: 1, fields: { 上级: ["T-003"] } },
  ] });
  assert.deepEqual([fieldsOf(dir, "T-002").上级, fieldsOf(dir, "T-003").上级], [["T-003"], ["T-001"]]);
});
