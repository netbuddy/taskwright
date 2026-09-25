/**
 * 两个工具在终端里的排版（lib/tool_render.ts）：「回复」与「保存修订」各测合格与被拒两种输入。
 * 合格的输入取自真实的核对函数与核心函数的返回，被拒的输入取自它们真实抛出的拒绝文字。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { checkReply } from "../src/lib/reply.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { replyBodyLines, replyLines, replyRejectedLines, saveRejectedLines, savedLines, titlesForOperations } from "../src/lib/tool_render.ts";
import { DEFINITION_PATH, SOURCE, callIn, makeWorkspace } from "./helpers.ts";

const alone = { toolCallId: "c1", callsThisTurn: [{ id: "c1", name: "reply" }], revisionFact: () => "是当前所在的修订" as const };

test("回复：告知在前、请确认卡片列出条目与修订号、成文的话在最后", () => {
  const reply = checkReply(
    {
      informs: ["我新增了 UC-001。", "来源都取自材料。"],
      act: { kind: "confirm", text: "请确认 UC-001（修订 1）。", items: [{ item_id: "UC-001", revision_no: 1 }] },
      text: "UC-001 已经存好。\n请确认它的内容。",
    },
    alone,
  );
  assert.deepEqual(replyLines(reply), [
    "执行者（经回复工具）：",
    "  告知：",
    "    · 我新增了 UC-001。",
    "    · 来源都取自材料。",
    "  【请确认】请确认 UC-001（修订 1）。",
    "      条目 UC-001（修订 1）",
    "  成文的话：",
    "    UC-001 已经存好。",
    "    请确认它的内容。",
  ]);
});

test("回复：告知点名了条目时在那一行后面写上条目编号；旧写法的纯文字告知照旧", () => {
  const reply = checkReply(
    {
      informs: [{ text: "材料写明预约的书保留 3 天。", items: [{ item_id: "UC-004", revision_no: 2 }, { item_id: "TBD-001", revision_no: 1 }] }, "我没有改动任何条目。"],
      act: null,
      text: "有，材料写明预约的书保留 3 天。",
    },
    alone,
  );
  assert.deepEqual(replyBodyLines(reply).slice(0, 3), ["  告知：", "    · 材料写明预约的书保留 3 天。（UC-004、TBD-001）", "    · 我没有改动任何条目。"]);
  assert.deepEqual(replyBodyLines({ informs: ["旧会话里的一句告知。"], act: null, text: "好。" })[1], "    · 旧会话里的一句告知。");
});

test("回复：给建议值带建议值与依据，请选择列出选项，提议带预览，提问列出关联条目", () => {
  const suggest = checkReply(
    {
      informs: [],
      act: { kind: "suggest", text: "建议加一条时限约束。", scope: "general", value: "48 个工作小时内退款", basis: [{ kind: "文档原文", locator: "inputs/a.md", excerpt: "48个工作小时" }] },
      text: "建议如上。",
    },
    alone,
  );
  assert.deepEqual(replyBodyLines(suggest), [
    "  【给建议值】建议加一条时限约束。",
    "      建议值：48 个工作小时内退款",
    "      依据（文档原文，inputs/a.md）：「48个工作小时」",
    "  成文的话：",
    "    建议如上。",
  ]);
  const choose = checkReply(
    { informs: [], act: { kind: "choose", text: "先整理哪块？", options: [{ key: "a", text: "借书" }, { key: "b", text: "还书" }] }, text: "请选。" },
    alone,
  );
  assert.deepEqual(replyBodyLines(choose).slice(0, 3), ["  【请选择】先整理哪块？", "      a. 借书", "      b. 还书"]);
  const propose = checkReply(
    { informs: [], act: { kind: "propose", text: "把 UC-001 拆成两条。", items: [{ item_id: "UC-001", revision_no: 1 }], preview: [{ effect: "remove", text: "UC-001" }, { effect: "add", text: "两条新用例" }] }, text: "提议如上。" },
    alone,
  );
  assert.deepEqual(replyBodyLines(propose).slice(0, 4), ["  【提议】把 UC-001 拆成两条。", "      条目 UC-001（修订 1）", "      删掉：UC-001", "      新增：两条新用例"]);
  const ask = checkReply({ informs: [], act: { kind: "ask", text: "发票红冲的订单怎么办？", items: [{ item_id: "TBD-001", revision_no: 1 }] }, text: "想问一件事。" }, alone);
  assert.deepEqual(replyBodyLines(ask), ["  【提问】发票红冲的订单怎么办？", "      条目 TBD-001（修订 1）", "  成文的话：", "    想问一件事。"]);
});

test("回复被拒：说明没有送达，拒绝原因逐行照录", () => {
  let reason = "";
  try {
    checkReply({ informs: [], act: { kind: "tell", text: "x" }, text: "y" }, alone);
  } catch (error) {
    reason = (error as Error).message;
  }
  assert.ok(reason.length > 0);
  const lines = replyRejectedLines(reason);
  assert.equal(lines[0], "  回复被拒绝，没有送达。拒绝的原因是：");
  assert.deepEqual(lines.slice(1), reason.split("\n").map((line) => `    ${line}`));
  assert.deepEqual(replyRejectedLines("  "), ["  回复被拒绝，没有送达。拒绝的原因是：", "    （工具没有给出原因）"]);
});

function taskDir() {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}

test("保存修订：新增、修改、删除各一行，带编号、标题与改前改后所在的修订", () => {
  const dir = taskDir();
  const first = saveRevision(callIn(dir), {
    operations: [
      { op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [SOURCE] },
      { op: "add", collection: "用例", fields: { 名称: "注销", 步骤: ["点注销"] }, sources: [SOURCE] },
    ],
  });
  assert.deepEqual(savedLines(first.details, titlesForOperations(dir, (first.details as any).operations)), [
    "  已保存为任务 TASK-001 的修订 1，一共 2 个操作（事件序号 2）：",
    "    新增 UC-001「登录」（集合「用例」）",
    "    新增 UC-002「注销」（集合「用例」）",
  ]);
  const second = saveRevision(callIn(dir), {
    operations: [
      { op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } },
      { op: "delete", item: "UC-002", base_revision: 1 },
    ],
  });
  assert.deepEqual(savedLines(second.details, titlesForOperations(dir, (second.details as any).operations)), [
    "  已保存为任务 TASK-001 的修订 2，一共 2 个操作（事件序号 3）：",
    "    修改 UC-001「用口令登录」，修订 1 → 修订 2",
    "    删除 UC-002「注销」（删除前在修订 1）",
  ]);
  // 取不到标题时只写编号。
  assert.equal(savedLines(second.details)[1], "    修改 UC-001，修订 1 → 修订 2");
});

test("保存修订被拒：说明什么都没有写入，拒绝原因逐行照录", () => {
  const dir = taskDir();
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [SOURCE] }] });
  let reason = "";
  try {
    saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 3, fields: { 名称: "x" } }] });
  } catch (error) {
    reason = (error as Error).message;
  }
  assert.match(reason, /条目 UC-001 现在是修订 1，你写的修订 3 不是它当前所在的修订/);
  const lines = saveRejectedLines(reason);
  assert.equal(lines[0], "  保存修订被拒绝，什么都没有写入。拒绝的原因是：");
  assert.deepEqual(lines.slice(1), reason.split("\n").map((line) => `    ${line}`));
});
