/**
 * 字段级来源一批：改前修订号与发起方、来源记到字段一级、「用户的话」的出处由工具代填、返回值带事件序号。
 * 直接测 lib/ 里的核心函数，不经 pi，也不经模型。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { ACTOR_USER } from "../src/lib/db.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, makeWorkspace, query } from "./helpers.ts";

function workspaceWithTask(): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}

const addUseCase = (name = "登录", sources: unknown[] = [SOURCE]) => ({
  op: "add",
  collection: "用例",
  fields: { 名称: name, 步骤: ["打开页面", "输入口令", "点登录"] },
  sources,
});

function rejection(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail("应当被拒绝");
}

// ---- 2.1 改前修订号与发起方 ----

test("修改与删除缺 base_revision 时整批拒绝，说明缺什么", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase()] });
  const message = rejection(() =>
    saveRevision(callIn(dir), {
      operations: [
        { op: "update", item: "UC-001", fields: { 备注: "一" } },
        { op: "add", collection: "用例", fields: { 名称: "注销", 步骤: ["点注销"] }, sources: [SOURCE] },
      ],
    }),
  );
  assert.match(message, /操作 1（修改，条目 UC-001）：助手修改 UC-001 时没写它看到的是哪次修订。\n  怎么办：修改与删除时要写 base_revision，也就是你所见的这个条目当前所在的修订号/);
  assert.equal(count(dir, "revision"), 1, "整批都不写入");
  const del = rejection(() => saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-001" }] }));
  assert.match(del, /操作 1（删除，条目 UC-001）：助手删除 UC-001 时没写它看到的是哪次修订/);
  const bad = rejection(() => saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-001", base_revision: "1" }] }));
  assert.match(bad, /助手删除 UC-001 时写的修订号 "1" 不对。\n  怎么办：base_revision 应当是一个从 1 起的整数/);
  const onAdd = rejection(() => saveRevision(callIn(dir), { operations: [{ ...addUseCase("甲"), base_revision: 1 }] }));
  assert.match(onAdd, /新增时不要写 base_revision/);
});

test("base_revision 不是条目当前所在的修订时整批拒绝，写明被谁改到哪次修订并附上当前内容", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase()] });
  // 用户在界面上把 UC-001 改到修订 2（扩展命令代用户写入，编号是后端生成的操作编号）。
  saveRevision(
    { workspaceDir: dir, sessionId: "session-test", callId: "ui-op-13", actor: ACTOR_USER },
    { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 备注: "用户在界面上补的" } }] },
  );
  const before = count(dir, "item_version");
  const message = rejection(() =>
    saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "执行者按旧版改" } }] }),
  );
  assert.match(message, /UC-001 已经被用户改到修订 2，助手看到的还是修订 1。\n  怎么办：请先读最新内容再改。/);
  assert.match(message, /它在修订 2 的内容是：\{"名称":"登录",.*"备注":"用户在界面上补的"\}/);
  assert.equal(count(dir, "item_version"), before);
  // 执行者自己改过的，说「被执行者改到」。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 2, fields: { 名称: "看过最新再改" } }] });
  const second = rejection(() => saveRevision(callIn(dir), { operations: [{ op: "delete", item: "UC-001", base_revision: 2 }] }));
  assert.match(second, /UC-001 已经被助手改到修订 3，助手看到的还是修订 2/);
});

test("发起方写进事件表；用户的直接操作的调用编号是操作编号", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase()] });
  saveRevision(
    { workspaceDir: dir, sessionId: "session-test", callId: "ui-op-7", actor: ACTOR_USER },
    { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 备注: "界面上改的" } }] },
  );
  const events = query<any>(dir, "SELECT seq, call_id, actor FROM event ORDER BY seq");
  assert.deepEqual(events.map((e) => e.actor), ["executor", "executor", "user"]);
  assert.equal(events[2].call_id, "ui-op-7");
  const revision = query<any>(dir, "SELECT call_id FROM revision WHERE revision_no = 2")[0];
  assert.equal(revision.call_id, "ui-op-7");
});

// ---- 2.2 来源记到字段一级 ----

test("supports 展开成来源表的多行；不写或写空列表表示支持整个条目", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), {
    operations: [
      addUseCase("登录", [
        { ...SOURCE, supports: [{ field: "名称" }, { field: "步骤", index: 2 }] },
        { kind: "执行者补充", locator: "执行者补充", excerpt: "按常识补的第一步", supports: [{ field: "步骤", index: 0 }] },
        { ...SOURCE, excerpt: "登录总要输入口令。", supports: [] },
      ]),
    ],
  });
  const rows = query<any>(dir, "SELECT position, support_no, kind, field, field_index FROM item_source ORDER BY position, support_no");
  assert.deepEqual(rows.map((r) => [r.position, r.support_no, r.field, r.field_index]), [
    [1, 1, "名称", null],
    [1, 2, "步骤", 2],
    [2, 1, "步骤", 0],
    [3, 1, null, null],
  ]);
});

test("supports 的核对：字段要存在、不能是空的；index 只用于列表型字段且在范围内", () => {
  const dir = workspaceWithTask();
  const message = rejection(() =>
    saveRevision(callIn(dir), {
      operations: [
        addUseCase("甲", [{ ...SOURCE, supports: [{ field: "颜色" }] }]),
        addUseCase("乙", [{ ...SOURCE, supports: [{ field: "名称", index: 0 }] }]),
        addUseCase("丙", [{ ...SOURCE, supports: [{ field: "步骤", index: 3 }] }]),
        addUseCase("丁", [{ ...SOURCE, supports: [{ field: "备注" }] }]),
        addUseCase("戊", [{ ...SOURCE, supports: [{ field: "步骤", index: -1 }] }]),
        addUseCase("己", [{ ...SOURCE, supports: "名称" }]),
      ],
    }),
  );
  assert.match(message, /有 6 个操作不对/);
  assert.match(message, /操作 1.*第 1 条来源说它支持字段「颜色」，集合「用例」没有这个字段/);
  assert.match(message, /操作 2.*给字段「名称」写了 index，这个字段是文本类型，只有列表型的字段才能指到其中一项/);
  assert.match(message, /操作 3.*指到字段「步骤」的第 3 项（从 0 起），这个字段改后只有 3 项，index 最大是 2/);
  assert.match(message, /操作 4.*支持字段「备注」，这个字段在改后的内容里是空的/);
  assert.match(message, /操作 5.*index 应当是从 0 起的整数，现在写的是 -1/);
  assert.match(message, /操作 6.*supports 应当是一个列表/);
  assert.equal(count(dir, "revision"), 0);
});

test("沿用条目当前的来源时，字段改短让它指到不存在的项，要求重新给出来源", () => {
  const dir = workspaceWithTask();
  saveRevision(callIn(dir), { operations: [addUseCase("登录", [{ ...SOURCE, supports: [{ field: "步骤", index: 2 }] }])] });
  const message = rejection(() =>
    saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 步骤: ["一步到位"] } }] }),
  );
  assert.match(message, /沿用下来的第 1 条来源指到字段「步骤」的第 2 项.*请在这个操作里重新给出 sources/);
  // 沿用的来源仍然有效时照常沿用，supports 一起带到新的修订。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } }] });
  const rows = query<any>(dir, "SELECT field, field_index FROM item_source WHERE revision_no = 2");
  assert.deepEqual(rows.map((r) => [r.field, r.field_index]), [["步骤", 2]]);
});

// ---- 2.3 「用户的话」的出处由工具代填 ----

test("用户的话：从最近往前找逐字包含摘录的用户消息，出处填「会话编号#条目编号」；模型写的出处不用", () => {
  const dir = workspaceWithTask();
  const userMessages = [
    { entryId: "a1", text: "退款要在三天内到账" },
    { entryId: "b2", text: "我再说一遍：退款要在三天内到账，节假日也算" },
    { entryId: "c3", text: "好的" },
  ];
  saveRevision(
    { ...callIn(dir, "sess-9"), userMessages },
    { operations: [addUseCase("退款", [{ kind: "用户的话", locator: "我乱写的", excerpt: "退款要在三天内到账" }])] },
  );
  const [row] = query<any>(dir, "SELECT kind, locator, excerpt FROM item_source");
  assert.equal(row.locator, "sess-9#b2", "摘录出现在两条消息里时取最近的一条");
});

test("用户的话：对话里找不到这句话就拒绝；不给会话时当作一条都没有", () => {
  const dir = workspaceWithTask();
  const message = rejection(() =>
    saveRevision(
      { ...callIn(dir), userMessages: [{ entryId: "a1", text: "退款要在三天内到账" }] },
      { operations: [addUseCase("退款", [{ kind: "用户的话", excerpt: "退款要在三天之内到账" }])] },
    ),
  );
  assert.match(message, /第 1 条来源引用的用户的话「退款要在三天之内到账」在对话里没有找到。\n  怎么办：请逐字摘录用户说过的原话/);
  const none = rejection(() =>
    saveRevision(callIn(dir), { operations: [addUseCase("退款", [{ kind: "用户的话", excerpt: "随便" }])] }),
  );
  assert.match(none, /在对话里没有找到/);
  assert.equal(count(dir, "revision"), 0);
});

// ---- 2.4 返回值带事件序号 ----

test("创建任务与保存修订的 details 都带 event_seq，就是这次记下的那条事件", () => {
  const dir = makeWorkspace();
  const created = createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  assert.equal(created.details.event_seq, 1);
  const saved = saveRevision(callIn(dir), { operations: [addUseCase("甲"), addUseCase("乙")] });
  assert.equal(saved.details.event_seq, 2);
  const [event] = query<any>(dir, "SELECT seq, name FROM event WHERE seq = ?", saved.details.event_seq);
  assert.equal(event.name, "REVISION_SAVED");
});
