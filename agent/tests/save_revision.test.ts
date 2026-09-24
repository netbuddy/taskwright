/** 保存修订：新增、修改、删除，一次多个操作只产生一次修订，编号不复用，来源的沿用与替换，各类核对不通过时整体不写入。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, makeWorkspace, query } from "./helpers.ts";

function workspaceWithTask(): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}

const addUseCase = (name = "登录") => ({
  op: "add",
  collection: "用例",
  fields: { 名称: name, 步骤: ["打开页面", "输入口令"] },
  sources: [SOURCE],
});

/** 带着会话里的用户消息调用「保存修订」，模仿工具登记处从会话读好之后交进来。 */
function saveRevisionWith(dir: string, params: { operations: unknown }, userMessages: { entryId: string; text: string }[]) {
  return saveRevision({ ...callIn(dir), userMessages }, params);
}

function snapshot(dir: string) {
  return ["revision", "item", "item_version", "item_source", "event"].map((t) => count(dir, t));
}

test("新增：生成编号、写条目、条目版本、来源、修订与事件", () => {
  const dir = workspaceWithTask();
  const call = callIn(dir, "session-B");
  const outcome = saveRevision(call, { operations: [addUseCase()] });
  assert.match(outcome.text, /第 1 次修订/);
  assert.match(outcome.text, /新增了条目 UC-001（集合「用例」），这是它的第 1 版/);
  const [item] = query<any>(dir, "SELECT * FROM item");
  assert.equal(item.item_id, "UC-001");
  assert.equal(item.added_in_revision, 1);
  assert.equal(item.deleted_in_revision, null);
  const [version] = query<any>(dir, "SELECT * FROM item_version");
  assert.deepEqual(JSON.parse(version.fields), { 名称: "登录", 步骤: ["打开页面", "输入口令"] });
  const [source] = query<any>(dir, "SELECT * FROM item_source");
  assert.equal(source.kind, "文档原文");
  assert.equal(source.version_no, 1);
  const [revision] = query<any>(dir, "SELECT * FROM revision");
  assert.equal(revision.call_id, call.callId);
  assert.equal(revision.session_id, "session-B");
  const event = query<any>(dir, "SELECT * FROM event WHERE seq = ?", revision.event_seq)[0];
  assert.equal(event.call_id, call.callId);
  assert.equal(event.name, "REVISION_SAVED");
  assert.deepEqual(JSON.parse(event.payload), {
    revision_no: 1,
    operations: [{ op: "add", item: "UC-001", collection: "用例", from_version: null, to_version: 1 }],
  });
  for (const row of [item, version, source]) assert.equal(row.event_seq, revision.event_seq);
});

test("一次多个操作只产生一次修订，编号按集合各自流水", () => {
  const dir = workspaceWithTask();
  const outcome = saveRevision(callIn(dir), {
    operations: [
      addUseCase("登录"),
      addUseCase("注销"),
      { op: "add", collection: "待定事项", fields: { 事项: "口令长度？", 状态: "未解决" }, sources: [SOURCE] },
    ],
  });
  assert.equal(count(dir, "revision"), 1);
  assert.equal(count(dir, "event"), 2);
  assert.deepEqual(query<any>(dir, "SELECT item_id FROM item ORDER BY collection, serial").map((r) => r.item_id), ["TBD-001", "UC-001", "UC-002"]);
  assert.equal((outcome.details as any).operations.length, 3);
});

test("修改：只改给出的字段，产生新一版；省略来源就沿用上一版的来源", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase()] });
  const outcome = saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_version: 1, fields: { 备注: "补一句" } }] });
  assert.match(outcome.text, /第 2 次修订/);
  assert.match(outcome.text, /修改了条目 UC-001，从第 1 版变成第 2 版/);
  const versions = query<any>(dir, "SELECT * FROM item_version ORDER BY version_no");
  assert.equal(versions.length, 2);
  assert.deepEqual(JSON.parse(versions[1].fields), { 名称: "登录", 步骤: ["打开页面", "输入口令"], 备注: "补一句" });
  assert.equal(versions[1].revision_no, 2);
  const sources = query<any>(dir, "SELECT * FROM item_source WHERE version_no = 2");
  assert.equal(sources.length, 1);
  assert.equal(sources[0].excerpt, SOURCE.excerpt);
  const event = query<any>(dir, "SELECT payload FROM event WHERE name = 'REVISION_SAVED' ORDER BY seq DESC LIMIT 1")[0];
  assert.deepEqual(JSON.parse(event.payload).operations[0], { op: "update", item: "UC-001", collection: "用例", from_version: 1, to_version: 2 });
});

test("修改时给了来源：改到的字段用新来源，支持整个条目的旧来源保留", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase()] });
  saveRevisionWith(dir, {
    operations: [
      {
        op: "update",
        item: "UC-001",
        base_version: 1,
        fields: { 名称: "用口令登录" },
        sources: [
          { kind: "用户的话", excerpt: "叫用口令登录" },
          { kind: "执行者补充", locator: "执行者补充", excerpt: "按常识补的" },
        ],
      },
    ],
  }, [{ entryId: "e7", text: "这个用例叫用口令登录吧" }]);
  const sources = query<any>(dir, "SELECT kind, locator FROM item_source WHERE version_no = 2 ORDER BY position");
  assert.deepEqual(sources.map((s) => s.kind), ["文档原文", "用户的话", "执行者补充"]);
  assert.equal(sources[1].locator, "session-test#e7");
  assert.equal(query<any>(dir, "SELECT * FROM item_source WHERE version_no = 1").length, 1);
});

test("删除：记下在第几次修订删除；删过的编号不复用", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase("甲"), addUseCase("乙")] });
  const outcome = saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-002", base_version: 1 }] });
  assert.match(outcome.text, /删除了条目 UC-002（删除前是第 1 版）/);
  const deleted = query<any>(dir, "SELECT * FROM item WHERE item_id = 'UC-002'")[0];
  assert.equal(deleted.deleted_in_revision, 2);
  saveRevision(callIn(dir), { operations: [addUseCase("丙")] });
  assert.deepEqual(query<any>(dir, "SELECT item_id FROM item ORDER BY serial").map((r) => r.item_id), ["UC-001", "UC-002", "UC-003"]);
  const payload = JSON.parse(query<any>(dir, "SELECT payload FROM event WHERE seq = 3")[0].payload);
  assert.deepEqual(payload.operations[0], { op: "delete", item: "UC-002", collection: "用例", from_version: 1, to_version: null });
});

test("没有库时拒绝，并且不留下库文件", () => {
  const dir = makeWorkspace();
  assert.throws(() => saveRevision(callIn(dir), { operations: [addUseCase()] }), /还没有任务记录.*任务由用户在界面上创建/);
});

test("操作列表为空时拒绝", () => {
  const dir = workspaceWithTask();
  assert.throws(() => saveRevision(callIn(dir), { operations: [] }), /不为空的操作列表/);
});

/** 各类核对不通过时：整批不写入，拒绝文字逐条列出每个不对的操作。 */
test("每一类核对不通过时整体不写入，原因逐条列出", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), {
    operations: [addUseCase("甲"), addUseCase("乙")],
  });
  saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-002", base_version: 1 }] });
  const before = snapshot(dir);
  let message = "";
  try {
    saveRevision(callIn(dir), {
      operations: [
        addUseCase("合格的一个"),
        { op: "add", collection: "不存在的集合", fields: {}, sources: [SOURCE] },
        { op: "add", collection: "用例", fields: { 名称: "缺步骤", 颜色: "红" }, sources: [SOURCE] },
        { op: "add", collection: "用例", fields: { 名称: "  ", 步骤: "不是列表" }, sources: [SOURCE] },
        { op: "add", collection: "用例", fields: { 名称: "没来源", 步骤: ["一步"] } },
        { op: "add", collection: "用例", fields: { 名称: "来源不全", 步骤: ["一步"] }, sources: [{ kind: "传闻", locator: "" }] },
        { op: "add", collection: "待定事项", fields: { 事项: "问", 状态: "搁置", 关联条目: ["UC-002"] }, sources: [SOURCE] },
        { op: "update", item: "UC-099", base_version: 1, fields: { 名称: "改不存在的" } },
        { op: "update", item: "UC-002", base_version: 1, fields: { 名称: "改已删除的" } },
        { op: "update", item: "UC-001", base_version: 1, fields: { 步骤: [] } },
        { op: "delete", item: "UC-099", base_version: 1 },
        { op: "frobnicate" },
      ],
    });
    assert.fail("应当被拒绝");
  } catch (error) {
    message = (error as Error).message;
  }
  assert.deepEqual(snapshot(dir), before, "被拒绝的调用不应写入任何一行");
  assert.match(message, /什么都没有写入，因为有 11 个操作不对/);
  assert.doesNotMatch(message, /操作 1（/);
  assert.match(message, /操作 2（新增，集合「不存在的集合」）：没有名叫「不存在的集合」的集合。可用的集合是：「用例」、「待定事项」/);
  assert.match(message, /操作 3（.*）：集合「用例」没有字段「颜色」.*必填字段「步骤」没有填/);
  assert.match(message, /操作 4（.*）：字段「步骤」是文本列表类型.*必填字段「名称」没有填或者是空的/);
  assert.match(message, /操作 5（.*）：缺少 sources/);
  assert.match(message, /操作 6（.*）：第 1 条来源的 kind 写的是 "传闻".*缺少 locator（出处）、excerpt（摘录的原文）/);
  assert.match(message, /操作 7（.*）：字段「状态」是枚举类型，写的是 "搁置".*字段「关联条目」是条目引用类型，第 1 个编号 "UC-002" 指向的条目已在第 2 次修订删除/);
  assert.match(message, /操作 8（修改，条目 UC-099）：这个任务里没有条目 UC-099。现有的条目是：UC-001/);
  assert.match(message, /操作 9（修改，条目 UC-002）：这个条目已在第 2 次修订删除/);
  assert.match(message, /操作 10（修改，条目 UC-001）：必填字段「步骤」改完之后是空的/);
  assert.match(message, /操作 11（删除，条目 UC-099）/);
  assert.match(message, /操作 12：op 写的是 "frobnicate"/);
});

test("同一次调用里对同一个条目的第二个操作被拒；改完与原来一样的修改被拒", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase()] });
  assert.throws(
    () =>
      saveRevision(callIn(dir), {
        operations: [
          { op: "update", item: "UC-001", base_version: 1, fields: { 备注: "一" } },
          { op: "delete", item: "UC-001", base_version: 1 },
        ],
      }),
    /操作 1 已经处理了这个条目/,
  );
  assert.throws(
    () => saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_version: 1, fields: { 名称: "登录" } }] }),
    /没有改动任何东西/,
  );
  assert.equal(count(dir, "revision"), 1);
});

test("条目引用指向在这次调用里被删除的条目时被拒；指向现存条目时通过", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase("甲"), addUseCase("乙")] });
  assert.throws(
    () =>
      saveRevision(callIn(dir), {
        operations: [
          { op: "delete", item: "UC-002", base_version: 1 },
          { op: "add", collection: "待定事项", fields: { 事项: "问", 状态: "未解决", 关联条目: ["UC-002"] }, sources: [SOURCE] },
        ],
      }),
    /在这次调用里被删除/,
  );
  saveRevision(callIn(dir), {
    operations: [{ op: "add", collection: "待定事项", fields: { 事项: "问", 状态: "未解决", 关联条目: ["UC-001"] }, sources: [SOURCE] }],
  });
  assert.equal(count(dir, "revision"), 2);
});

test("可选字段写空值等于清空，库里不留空键", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [{ ...addUseCase(), fields: { 名称: "甲", 步骤: ["一"], 备注: "有" } }] });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_version: 1, fields: { 备注: "" } }] });
  const latest = query<any>(dir, "SELECT fields FROM item_version WHERE version_no = 2")[0];
  assert.deepEqual(JSON.parse(latest.fields), { 名称: "甲", 步骤: ["一"] });
});

test("条目引用：值是编号数组，可以有多个，也可以是空数组；写成单个字符串被拒", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase("甲"), addUseCase("乙")] });
  saveRevision(callIn(dir), {
    operations: [
      { op: "add", collection: "待定事项", fields: { 事项: "多个", 状态: "未解决", 关联条目: ["UC-001", "UC-002"] }, sources: [SOURCE] },
      { op: "add", collection: "待定事项", fields: { 事项: "空的", 状态: "未解决", 关联条目: [] }, sources: [SOURCE] },
    ],
  });
  const rows = query<any>(dir, "SELECT item_id, fields FROM item_version WHERE item_id LIKE 'TBD-%' ORDER BY item_id");
  assert.deepEqual(JSON.parse(rows[0].fields).关联条目, ["UC-001", "UC-002"]);
  assert.equal("关联条目" in JSON.parse(rows[1].fields), false, "空数组等于不填，库里不留空键");
  assert.throws(
    () =>
      saveRevision(callIn(dir), {
        operations: [{ op: "add", collection: "待定事项", fields: { 事项: "单个", 状态: "未解决", 关联条目: "UC-001" }, sources: [SOURCE] }],
      }),
    /应当写成条目编号的数组，例如 \["UC-001"\]；现在写的是 "UC-001"，只有一个编号也要放进数组里/,
  );
});

test("条目引用：多个编号里哪几个不对，拒绝文字逐个指出", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase("甲"), addUseCase("乙")] });
  saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-002", base_version: 1 }] });
  const before = count(dir, "revision");
  let message = "";
  try {
    saveRevision(callIn(dir), {
      operations: [
        { op: "add", collection: "待定事项", fields: { 事项: "问", 状态: "未解决", 关联条目: ["UC-001", "UC-002", "UC-404", 7] }, sources: [SOURCE] },
      ],
    });
    assert.fail("应当被拒绝");
  } catch (error) {
    message = (error as Error).message;
  }
  assert.equal(count(dir, "revision"), before);
  assert.doesNotMatch(message, /"UC-001"/);
  assert.match(message, /第 2 个编号 "UC-002" 指向的条目已在第 2 次修订删除/);
  assert.match(message, /第 3 个编号 "UC-404" 指向的条目在这个任务里不存在/);
  assert.match(message, /第 4 个编号 7 应当写一个条目编号/);
});

test("修改时给了来源只替换改到的字段上的来源，没改的字段来源沿用；只给来源不改字段时整体替换", () => {
  const dir = workspaceWithTask();
  // 一条文档原文逐个支持两个字段，与真跑里 UC-002 第 1 版的样子相同。
  saveRevision(callIn(dir), {
    operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [{ ...SOURCE, supports: [{ field: "名称" }, { field: "步骤" }] }] }],
  });
  saveRevision(callIn(dir), {
    operations: [{
      op: "update", item: "UC-001", base_version: 1, fields: { 步骤: ["打开页面", "输入口令"] },
      sources: [{ kind: "执行者补充", locator: "执行者补充", excerpt: "登录总要输入口令。", supports: [{ field: "步骤", index: 1 }] }],
    }],
  });
  const v2 = query<any>(dir, "SELECT position, kind, field, field_index FROM item_source WHERE version_no = 2 ORDER BY position, support_no").map((r) => ({ ...r }));
  assert.deepEqual(v2, [
    { position: 1, kind: "文档原文", field: "名称", field_index: null },
    { position: 2, kind: "执行者补充", field: "步骤", field_index: 1 },
  ]);
  // 只给 sources、不改字段：整体替换，用来重新标注来源。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_version: 2, sources: [SOURCE] }] });
  assert.deepEqual(query<any>(dir, "SELECT kind, field FROM item_source WHERE version_no = 3").map((r) => [r.kind, r.field]), [["文档原文", null]]);
});
