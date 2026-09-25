/** 保存修订：新增、修改、删除，一次多个操作只产生一次修订，编号不复用，来源的沿用与替换，各类核对不通过时整体不写入。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { ACTOR_USER } from "../src/lib/db.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, demoDefinition, makeWorkspace, query } from "./helpers.ts";

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

test("新增：生成编号、写条目、条目内容、来源、修订与事件", () => {
  const dir = workspaceWithTask();
  const call = callIn(dir, "session-B");
  const outcome = saveRevision(call, { operations: [addUseCase()] });
  assert.match(outcome.text, /修订 1，/);
  assert.match(outcome.text, /新增了条目 UC-001（集合「用例」），UC-001 现在是修订 1/);
  const [item] = query<any>(dir, "SELECT * FROM item");
  assert.equal(item.item_id, "UC-001");
  assert.equal(item.added_in_revision, 1);
  assert.equal(item.deleted_in_revision, null);
  const [version] = query<any>(dir, "SELECT * FROM item_version");
  assert.deepEqual(JSON.parse(version.fields), { 名称: "登录", 步骤: ["打开页面", "输入口令"] });
  const [source] = query<any>(dir, "SELECT * FROM item_source");
  assert.equal(source.kind, "文档原文");
  assert.equal(source.revision_no, 1);
  const [revision] = query<any>(dir, "SELECT * FROM revision");
  assert.equal(revision.call_id, call.callId);
  assert.equal(revision.session_id, "session-B");
  const event = query<any>(dir, "SELECT * FROM event WHERE seq = ?", revision.event_seq)[0];
  assert.equal(event.call_id, call.callId);
  assert.equal(event.name, "REVISION_SAVED");
  assert.deepEqual(JSON.parse(event.payload), {
    revision_no: 1,
    operations: [{ op: "add", item: "UC-001", collection: "用例", from_revision: null, to_revision: 1 }],
  });
  for (const row of [item, version, source]) assert.equal(row.event_seq, revision.event_seq);
});

test("一次多个操作只产生一次修订，编号按集合各自流水", () => {
  const dir = workspaceWithTask();
  const outcome = saveRevision(callIn(dir), {
    operations: [
      addUseCase("登录"),
      addUseCase("注销"),
      { op: "add", collection: "问题", fields: { 事项: "口令长度？", 状态: "未解决" }, sources: [SOURCE] },
    ],
  });
  assert.equal(count(dir, "revision"), 1);
  assert.equal(count(dir, "event"), 2);
  assert.deepEqual(query<any>(dir, "SELECT item_id FROM item ORDER BY collection, serial").map((r) => r.item_id), ["UC-001", "UC-002", "TBD-001"]);
  assert.equal((outcome.details as any).operations.length, 3);
});

test("修改：只改给出的字段，产生新一版；省略来源就沿用上一版的来源", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase()] });
  const outcome = saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 备注: "补一句" } }] });
  assert.match(outcome.text, /修订 2，/);
  assert.match(outcome.text, /修改了条目 UC-001（改前在修订 1），UC-001 现在是修订 2/);
  const versions = query<any>(dir, "SELECT * FROM item_version ORDER BY revision_no");
  assert.equal(versions.length, 2);
  assert.deepEqual(JSON.parse(versions[1].fields), { 名称: "登录", 步骤: ["打开页面", "输入口令"], 备注: "补一句" });
  assert.equal(versions[1].revision_no, 2);
  const sources = query<any>(dir, "SELECT * FROM item_source WHERE revision_no = 2");
  assert.equal(sources.length, 1);
  assert.equal(sources[0].excerpt, SOURCE.excerpt);
  const event = query<any>(dir, "SELECT payload FROM event WHERE name = 'REVISION_SAVED' ORDER BY seq DESC LIMIT 1")[0];
  assert.deepEqual(JSON.parse(event.payload).operations[0], { op: "update", item: "UC-001", collection: "用例", from_revision: 1, to_revision: 2 });
});

test("修改时给了来源：改到的字段用新来源，支持整个条目的旧来源保留", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase()] });
  saveRevisionWith(dir, {
    operations: [
      {
        op: "update",
        item: "UC-001",
        base_revision: 1,
        fields: { 名称: "用口令登录" },
        sources: [
          { kind: "用户的话", excerpt: "叫用口令登录" },
          { kind: "执行者补充", locator: "执行者补充", excerpt: "按常识补的" },
        ],
      },
    ],
  }, [{ entryId: "e7", text: "这个用例叫用口令登录吧" }]);
  const sources = query<any>(dir, "SELECT kind, locator FROM item_source WHERE revision_no = 2 ORDER BY position");
  assert.deepEqual(sources.map((s) => s.kind), ["文档原文", "用户的话", "执行者补充"]);
  assert.equal(sources[1].locator, "session-test#e7");
  assert.equal(query<any>(dir, "SELECT * FROM item_source WHERE revision_no = 1").length, 1);
});

test("删除：记下在第几次修订删除；删过的编号不复用", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase("甲"), addUseCase("乙")] });
  const outcome = saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-002", base_revision: 1 }] });
  assert.match(outcome.text, /删除了条目 UC-002（删除前在修订 1）/);
  const deleted = query<any>(dir, "SELECT * FROM item WHERE item_id = 'UC-002'")[0];
  assert.equal(deleted.deleted_in_revision, 2);
  saveRevision(callIn(dir), { operations: [addUseCase("丙")] });
  assert.deepEqual(query<any>(dir, "SELECT item_id FROM item ORDER BY serial").map((r) => r.item_id), ["UC-001", "UC-002", "UC-003"]);
  const payload = JSON.parse(query<any>(dir, "SELECT payload FROM event WHERE seq = 3")[0].payload);
  assert.deepEqual(payload.operations[0], { op: "delete", item: "UC-002", collection: "用例", from_revision: 1, to_revision: null });
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
  saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-002", base_revision: 1 }] });
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
        { op: "add", collection: "问题", fields: { 事项: "问", 状态: "搁置", 关联条目: ["UC-002"] }, sources: [SOURCE] },
        { op: "update", item: "UC-099", base_revision: 1, fields: { 名称: "改不存在的" } },
        { op: "update", item: "UC-002", base_revision: 1, fields: { 名称: "改已删除的" } },
        { op: "update", item: "UC-001", base_revision: 1, fields: { 步骤: [] } },
        { op: "delete", item: "UC-099", base_revision: 1 },
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
  assert.match(message, /操作 2（新增，集合「不存在的集合」）：没有名叫「不存在的集合」的集合。\n  怎么办：可用的集合是：「用例」、「问题」/);
  assert.match(message, /操作 3（.*）：新增到「用例」的条目：集合「用例」没有字段「颜色」.*必填字段「步骤」没有填/);
  assert.match(message, /操作 4（.*）：新增到「用例」的条目：字段「步骤」是文本列表类型.*必填字段「名称」没有填或者是空的/);
  assert.match(message, /操作 5（.*）：新增到「用例」的条目：缺少 sources/);
  assert.match(message, /操作 6（.*）：新增到「.*」的条目：第 1 条来源的 kind 写的是 "传闻".*缺少 locator（出处）、excerpt（摘录的原文）/);
  assert.match(message, /操作 7（.*）：新增到「问题」的条目：字段「状态」是枚举类型，写的是 "搁置".*字段「关联条目」是条目引用类型，第 1 个编号 "UC-002" 指向的条目已在修订 2 删除/);
  assert.match(message, /操作 8（修改，条目 UC-099）：这个任务里没有条目 UC-099。\n  怎么办：现有的条目是：UC-001/);
  assert.match(message, /操作 9（修改，条目 UC-002）：助手想修改 UC-002，但它已在修订 2 删除/);
  assert.match(message, /操作 10（修改，条目 UC-001）：UC-001：必填字段「步骤」改完之后是空的/);
  assert.match(message, /操作 11（删除，条目 UC-099）/);
  assert.match(message, /操作 12：操作 12 的种类写成了 "frobnicate"。\n  怎么办：op 只能是/);
});

test("同一次调用里对同一个条目的第二个操作被拒；改完与原来一样的修改被拒", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase()] });
  assert.throws(
    () =>
      saveRevision(callIn(dir), {
        operations: [
          { op: "update", item: "UC-001", base_revision: 1, fields: { 备注: "一" } },
          { op: "delete", item: "UC-001", base_revision: 1 },
        ],
      }),
    /同一次保存里 UC-001 出现了两次（操作 1 已经处理了它）/,
  );
  assert.throws(
    () => saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "登录" } }] }),
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
          { op: "delete", item: "UC-002", base_revision: 1 },
          { op: "add", collection: "问题", fields: { 事项: "问", 状态: "未解决", 关联条目: ["UC-002"] }, sources: [SOURCE] },
        ],
      }),
    /在这次调用里被删除/,
  );
  saveRevision(callIn(dir), {
    operations: [{ op: "add", collection: "问题", fields: { 事项: "问", 状态: "未解决", 关联条目: ["UC-001"] }, sources: [SOURCE] }],
  });
  assert.equal(count(dir, "revision"), 2);
});

test("可选字段写空值等于清空，库里不留空键", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [{ ...addUseCase(), fields: { 名称: "甲", 步骤: ["一"], 备注: "有" } }] });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 备注: "" } }] });
  const latest = query<any>(dir, "SELECT fields FROM item_version WHERE revision_no = 2")[0];
  assert.deepEqual(JSON.parse(latest.fields), { 名称: "甲", 步骤: ["一"] });
});

test("条目引用：值是编号数组，可以有多个，也可以是空数组；写成单个字符串被拒", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase("甲"), addUseCase("乙")] });
  saveRevision(callIn(dir), {
    operations: [
      { op: "add", collection: "问题", fields: { 事项: "多个", 状态: "未解决", 关联条目: ["UC-001", "UC-002"] }, sources: [SOURCE] },
      { op: "add", collection: "问题", fields: { 事项: "空的", 状态: "未解决", 关联条目: [] }, sources: [SOURCE] },
    ],
  });
  const rows = query<any>(dir, "SELECT item_id, fields FROM item_version WHERE item_id LIKE 'TBD-%' ORDER BY item_id");
  assert.deepEqual(JSON.parse(rows[0].fields).关联条目, ["UC-001", "UC-002"]);
  assert.equal("关联条目" in JSON.parse(rows[1].fields), false, "空数组等于不填，库里不留空键");
  assert.throws(
    () =>
      saveRevision(callIn(dir), {
        operations: [{ op: "add", collection: "问题", fields: { 事项: "单个", 状态: "未解决", 关联条目: "UC-001" }, sources: [SOURCE] }],
      }),
    /应当写成条目编号的数组，例如 \["UC-001"\]；现在写的是 "UC-001"，只有一个编号也要放进数组里/,
  );
});

test("条目引用：多个编号里哪几个不对，拒绝文字逐个指出", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase("甲"), addUseCase("乙")] });
  saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-002", base_revision: 1 }] });
  const before = count(dir, "revision");
  let message = "";
  try {
    saveRevision(callIn(dir), {
      operations: [
        { op: "add", collection: "问题", fields: { 事项: "问", 状态: "未解决", 关联条目: ["UC-001", "UC-002", "UC-404", 7] }, sources: [SOURCE] },
      ],
    });
    assert.fail("应当被拒绝");
  } catch (error) {
    message = (error as Error).message;
  }
  assert.equal(count(dir, "revision"), before);
  assert.doesNotMatch(message, /"UC-001"/);
  assert.match(message, /第 2 个编号 "UC-002" 指向的条目已在修订 2 删除/);
  assert.match(message, /第 3 个编号 "UC-404" 指向的条目在这个任务里不存在/);
  assert.match(message, /第 4 个编号 7 应当写一个条目编号/);
});

test("修改时给了来源只替换改到的字段上的来源，没改的字段来源沿用；只给来源不改字段时整体替换", () => {
  const dir = workspaceWithTask();
  // 一条文档原文逐个支持两个字段，与真跑里 UC-002 在修订 1 的样子相同。
  saveRevision(callIn(dir), {
    operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [{ ...SOURCE, supports: [{ field: "名称" }, { field: "步骤" }] }] }],
  });
  saveRevision(callIn(dir), {
    operations: [{
      op: "update", item: "UC-001", base_revision: 1, fields: { 步骤: ["打开页面", "输入口令"] },
      sources: [{ kind: "执行者补充", locator: "执行者补充", excerpt: "登录总要输入口令。", supports: [{ field: "步骤", index: 1 }] }],
    }],
  });
  const v2 = query<any>(dir, "SELECT position, kind, field, field_index FROM item_source WHERE revision_no = 2 ORDER BY position, support_no").map((r) => ({ ...r }));
  assert.deepEqual(v2, [
    { position: 1, kind: "文档原文", field: "名称", field_index: null },
    { position: 2, kind: "执行者补充", field: "步骤", field_index: 1 },
  ]);
  // 只给 sources、不改字段：整体替换，用来重新标注来源。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 2, sources: [SOURCE] }] });
  assert.deepEqual(query<any>(dir, "SELECT kind, field FROM item_source WHERE revision_no = 3").map((r) => [r.kind, r.field]), [["文档原文", null]]);
});

test("文档原文的摘录不用空行隔开就跳句拼接、改了字或出处读不到时整批拒绝，逐条列出；逐字连续的一段（换行写法不同也算）放行", () => {
  const dir = workspaceWithTask();
  const before = snapshot(dir);
  const message = (() => {
    try {
      saveRevision(callIn(dir), {
        operations: [
          { ...addUseCase("甲"), sources: [{ ...SOURCE, excerpt: "用户可以登录。退款须在七天内处理完毕。" }] },
          { ...addUseCase("乙"), sources: [{ ...SOURCE, excerpt: "用户可以登陆。" }] },
          { ...addUseCase("丙"), sources: [{ ...SOURCE, locator: "inputs/没有这份.md" }] },
        ],
      });
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  })();
  assert.match(message, /什么都没有写入，因为有 3 个操作不对/);
  assert.match(message, /第 1 条来源的摘录「用户可以登录。退款须在七天内处理完毕。」在 材料\.md 里找不到。\n  怎么办：摘录必须与材料原文逐字一致，包括标点；不要自行补标点或改写；摘录必须逐字抄自材料里连续的一段，不要跳句拼接或改字；引用不相邻的原文请用空行分开或写成几条来源/);
  assert.match(message, /第 1 条来源的摘录「用户可以登陆。」在 材料\.md 里找不到/);
  assert.match(message, /出处 inputs\/没有这份\.md 不是任务目录里能读到的材料文件/);
  assert.deepEqual(snapshot(dir), before);

  // 连续的两句（跨行也行，材料里的换行是 \n，摘录里写成 \r\n 也认）；只写文件名的出处到材料目录里找。
  const outcome = saveRevision(callIn(dir), {
    operations: [
      { ...addUseCase("丁"), sources: [{ ...SOURCE, excerpt: "登录总要输入口令。用口令登录" }] },
      { ...addUseCase("戊"), sources: [{ ...SOURCE, locator: "材料.md", excerpt: "# 登录与退款\r\n\r\n用户可以登录。" }] },
    ],
  });
  assert.match(outcome.text, /新增了条目 UC-001/);
  assert.match(outcome.text, /新增了条目 UC-002/);
  // 整段原样找得到的（连着的两段，中间隔着空行）照旧存成一条来源，不拆。
  assert.doesNotMatch(outcome.text, /拆成了/);
  assert.deepEqual(query<any>(dir, "SELECT excerpt FROM item_source WHERE item_id = 'UC-002'").map((r) => r.excerpt), ["# 登录与退款\r\n\r\n用户可以登录。"]);
});

test("摘录用空行隔开材料里不相邻的两段：两段都找到就在原位置展开成两条来源，position 连续、后面的来源顺延", () => {
  const dir = workspaceWithTask();
  const supports = [{ field: "名称" }];
  const outcome = saveRevision(callIn(dir), {
    operations: [{ ...addUseCase("甲"), sources: [
      { kind: "执行者补充", locator: "执行者补充", excerpt: "按常识补的步骤" },
      { ...SOURCE, excerpt: "用户可以登录。\n\n  \n退款须在七天内处理完毕。", supports },
      { ...SOURCE, excerpt: "登录总要输入口令。" },
    ] }],
  });
  assert.match(outcome.text, /新增了条目 UC-001（集合「用例」），UC-001 现在是修订 1。第 2 条来源的摘录按空行拆成了 2 条来源。/);
  const rows = query<any>(dir, "SELECT position, kind, locator, excerpt, field FROM item_source WHERE item_id = 'UC-001' ORDER BY position");
  assert.deepEqual(rows.map((r) => [r.position, r.kind, r.excerpt, r.field]), [
    [1, "执行者补充", "按常识补的步骤", null],
    [2, "文档原文", "用户可以登录。", "名称"],
    [3, "文档原文", "退款须在七天内处理完毕。", "名称"],
    [4, "文档原文", "登录总要输入口令。", null],
  ]);
  assert.deepEqual(new Set(rows.slice(1).map((r) => r.locator)), new Set(["inputs/材料.md"]));
});

test("摘录用空行隔开的几段里有一段找不到：整批拒绝，写明是第几段", () => {
  const dir = workspaceWithTask();
  const before = snapshot(dir);
  assert.throws(
    () => saveRevision(callIn(dir), { operations: [{ ...addUseCase(), sources: [{ ...SOURCE, excerpt: "用户可以登录。\n\n退款须在五天内处理完毕。" }] }] }),
    (error: Error) => error.message.includes(
      "第 1 条来源的第 2 段摘录「退款须在五天内处理完毕。」在 材料.md 里找不到。\n  怎么办：摘录必须与材料原文逐字一致，包括标点；不要自行补标点或改写；摘录必须逐字抄自材料里连续的一段，引用不相邻的原文请用空行分开或写成几条来源"),
  );
  assert.deepEqual(snapshot(dir), before);
});

test("只有一段的摘录照旧：存成一条来源，返回里不提拆分", () => {
  const dir = workspaceWithTask();
  const outcome = saveRevision(callIn(dir), { operations: [addUseCase()] });
  assert.doesNotMatch(outcome.text, /拆成了/);
  assert.deepEqual(query<any>(dir, "SELECT position, excerpt FROM item_source WHERE item_id = 'UC-001'").map((r) => [r.position, r.excerpt]), [[1, "用户可以登录。"]]);
});

test("摘录超过 30 个字时，拒绝的文字只引前 30 个字", () => {
  const dir = workspaceWithTask();
  const long = "用户可以登录。".repeat(6) + "（改过）";
  assert.throws(
    () => saveRevision(callIn(dir), { operations: [{ ...addUseCase(), sources: [{ ...SOURCE, excerpt: long }] }] }),
    (error: Error) => error.message.includes(`摘录「${long.slice(0, 30)}…」在 材料.md 里找不到`),
  );
});

/** 问题的状态取值里含「用户决定保留」的定义：这个集合就是问题条目。 */
function workspaceWithProblems(): string {
  const definition = demoDefinition() as any;
  const tbd = definition.交付物.条目集合[1];
  tbd.字段 = [
    { 名: "事项", 类型: "文本", 必填: true },
    { 名: "建议的处理", 类型: "文本", 必填: false },
    { 名: "状态", 类型: "枚举", 必填: true, 取值: ["未解决", "已解决", "用户决定保留"] },
    { 名: "处理结果", 类型: "文本", 必填: false },
    { 名: "关联条目", 类型: "条目引用", 必填: false },
  ];
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [addUseCase()] });
  saveRevision(callIn(dir), {
    operations: [{ op: "add", collection: "问题", fields: { 事项: "口令多长？", 建议的处理: "问用户", 状态: "未解决", 关联条目: ["UC-001"] }, sources: [SOURCE] }],
  });
  return dir;
}

test("问题条目写下后执行者只能改状态与处理结果：改事项、建议的处理被拒，并指向牵涉的条目；原样重写不算改", () => {
  const dir = workspaceWithProblems();
  const before = snapshot(dir);
  assert.throws(
    () => saveRevision(callIn(dir), {
      operations: [{ op: "update", item: "TBD-001", base_revision: 2, fields: { 建议的处理: "口令至少 8 位", 事项: "口令多长？", 状态: "未解决" } }],
    }),
    (error: Error) =>
      error.message.includes("操作 1（修改，条目 TBD-001）：助手想改 TBD-001 的「建议的处理」，但问题条目写下后只能改状态与处理结果。\n" +
        "  怎么办：用户的回答要写进它牵涉的条目（关联条目里列的那些），改完再问用户这个问题是否已解决"),
  );
  assert.throws(
    () => saveRevision(callIn(dir), { operations: [{ op: "update", item: "TBD-001", base_revision: 2, fields: { 关联条目: [] } }] }),
    /助手想改 TBD-001 的「关联条目」/,
  );
  assert.deepEqual(snapshot(dir), before);
});

test("问题条目：改状态与处理结果放行；新增不受限；用户在界面上的修改不受这条限制", () => {
  const dir = workspaceWithProblems();
  const outcome = saveRevision(callIn(dir), {
    operations: [
      { op: "update", item: "TBD-001", base_revision: 2, fields: { 状态: "已解决", 处理结果: "用户采纳：口令至少 8 位" } },
      { op: "add", collection: "问题", fields: { 事项: "要不要短信登录？", 建议的处理: "先不做", 状态: "未解决" }, sources: [SOURCE] },
    ],
  });
  assert.match(outcome.text, /修改了条目 TBD-001/);
  assert.match(outcome.text, /新增了条目 TBD-002/);
  const user = saveRevision({ ...callIn(dir), callId: "ui-op-9", actor: ACTOR_USER }, {
    operations: [{ op: "update", item: "TBD-002", base_revision: 3, fields: { 建议的处理: "下一期再做" } }],
  });
  assert.match(user.text, /修改了条目 TBD-002/);
});
