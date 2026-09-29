/**
 * 提交交付物之前要用户在卡片上同意：起真的后端进程与真的 pi，模型换成进程内的假端点。
 * 流程：助手保存一个用例；用户在界面上打开看过、发起评审（假端点替评审者回「没有发现」），完成条件全部满足；
 * 用户打字说「都看过了，完成吧」，助手调用完成任务被拒（打字不算同意），拒绝写明要先发「这个任务是否已经完成」的卡片；
 * 助手发了这张卡片，用户在卡片上点「已完成，提交交付物」（与页面一样经发话接口，origin 为 card_choice），助手再调用，任务变为已完成；
 * 之后改字段与说话都返回 409 task_closed（留存输出的对照里「确认与完成」场景原来核对这两步，现在它走不到已完成，由这里接着核对）。
 * 另一条走页面：完成条件满足之后，用户在页面的提示条上提交交付物（直接操作 submit_deliverable，带页面看到的修订号），
 * 修订号不是现在的被拒；是现在的，任务变为已完成，发起方是用户，会话里多一句说明，不引出助手的运行。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { captureConsole, tempDir } from "./helpers.ts";
import { type Dict, MATERIAL, NO_PI, type Stack, reply, sleep, withStack } from "./consent_stack.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const AGREE = "已完成，提交交付物";
const CARD = { kind: "choose", text: "功能用例一共 1 个条目，已经评审通过，你也看过了，没有未解决的问题。这个任务是否已经完成？提交之后交付物不能再改，仍然可以生成文档。",
  options: [{ key: "complete", text: AGREE }, { key: "continue", text: "还没完成，继续修改" }] };
const SCRIPT = {
  rules: [{ when: { any_contains: "你是评审者" }, reply: { text: JSON.stringify({ 发现: [] }) } }],
  sequence: [
    { tool_calls: [{ id: "call-save", name: "save_revision", arguments: { operations: [{ op: "add", collection: "功能用例",
      sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: MATERIAL }],
      fields: { 用例名称: "借书", 用例功能: "读者借书。", 参与者: ["读者"], 基本流程: ["读者在自助机上刷借书证", "系统记下借阅"] } }] } }] },
    reply("整理好了一个用例。", "call-done-1"),
    { tool_calls: [{ id: "call-complete-typed", name: "complete_task", arguments: {} }] },
    reply("完成条件都满足了，请在卡片上选。", "call-card", CARD),
    { tool_calls: [{ id: "call-complete", name: "complete_task", arguments: {} }] },
    reply("任务已经完成。", "call-done-2"),
  ],
};

/** 保存一个用例、用户打开看过、发起评审并等它做完：完成条件全部满足。 */
async function ready({ send, action, db }: Stack): Promise<void> {
  await send({ text: "把材料整理成需求规格说明。", client_id: "c-1" });
  assert.equal((await action({ kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] })).status, 200);
  assert.equal((await action({ kind: "request_review", targets: [] })).status, 200);
  for (const end = Date.now() + 30000; db("SELECT 1 FROM event WHERE name = 'REVIEW_FINISHED'").length === 0;) {
    if (Date.now() > end) throw new Error("评审没有做完");
    await sleep(100);
  }
}

test("打字说完成被拒；助手发了是否已经完成的卡片、用户点「已完成，提交交付物」之后，任务变为已完成", { skip: NO_PI, timeout: 120000 }, () =>
  withStack(tmp, "consent", SCRIPT, async (stack) => {
    const { call, taskId, session, db, send, entryOfCall } = stack;
    await ready(stack);

    await send({ text: "都看过了，完成吧。", client_id: "c-2" });
    const typed = db("SELECT call_id, fact, guidance FROM tool_rejection WHERE tool_name = 'complete_task'");
    assert.deepEqual(typed.map((r: Dict) => r.call_id), ["call-complete-typed"], "打字说完成不算同意");
    assert.match(typed[0].fact, /用户还没有在问这个任务是否已经完成的卡片上点「已完成，提交交付物」。/);
    assert.match(typed[0].guidance, /\{ key: "complete", text: "已完成，提交交付物" \} 与「还没完成，继续修改」/);
    assert.equal(db("SELECT status FROM task")[0].status, "进行中");

    const cardEntry = entryOfCall("call-card");
    await send({ text: `我选：${AGREE}`, client_id: "c-3", origin: "card_choice", card: { reply_message_id: cardEntry, kind: "choose", choice: "complete" } });

    assert.deepEqual(db("SELECT call_id FROM tool_rejection WHERE tool_name = 'complete_task'").map((r: Dict) => r.call_id), ["call-complete-typed"]);
    const task = db("SELECT status, ended_at FROM task")[0];
    assert.equal(task.status, "已完成");
    assert.ok(task.ended_at);
    assert.deepEqual(db("SELECT call_id FROM event WHERE name = 'TASK_COMPLETED'").map((r: Dict) => r.call_id), ["call-complete"]);

    // 提交之后整个任务只读：改字段与说话都返回 409 task_closed。
    const edit = await call("POST", `/api/v1/tasks/${taskId}/actions?session=${session}`, { client_id: "a-edit", task_id: taskId, kind: "edit_fields",
      targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 用例名称: "借阅" }, notify_executor: false });
    assert.deepEqual([edit.status, edit.body.error.code], [409, "task_closed"]);
    const said = await call("POST", `/api/v1/tasks/${taskId}/messages?session=${session}`, { text: "再改改", client_id: "c-4" });
    assert.deepEqual([said.status, said.body.error.code], [409, "task_closed"]);
  }));

test("页面提交：看到的修订号不是现在的被拒；带着现在的修订号提交，任务变为已完成，发起方是用户，会话里多一句说明，不引出助手的运行", { skip: NO_PI, timeout: 120000 }, () =>
  withStack(tmp, "page", { rules: SCRIPT.rules, sequence: SCRIPT.sequence.slice(0, 2) }, async (stack) => {
    const { taskId, session, dir, db, action } = stack;
    await ready(stack);
    const stale = await action({ kind: "submit_deliverable", targets: [], fields: { revision_no: 0 }, notify_executor: false });
    assert.deepEqual([stale.body.error.code, stale.body.error.message], ["rejected", "这次没有提交：你看到的是修订 0，交付物现在已经是修订 1。请看过现在的内容再提交。"]);
    assert.equal(db("SELECT status FROM task")[0].status, "进行中");

    const done = await action({ kind: "submit_deliverable", targets: [], fields: { revision_no: 1 }, notify_executor: false });
    assert.equal(done.status, 200);
    assert.equal(db("SELECT status FROM task")[0].status, "已完成");
    assert.deepEqual(db("SELECT actor, call_id FROM event WHERE name = 'TASK_COMPLETED'").map((r: Dict) => [r.actor, r.call_id]), [["user", done.body.op_id]]);
    const sessionDir = join(dir, "runs", taskId, "pi-sessions", "service");
    const file = join(sessionDir, readdirSync(sessionDir).find((n) => n.endsWith(`_${session}.jsonl`))!);
    const entries = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const note = entries.filter((e) => e.type === "custom_message" && e.details?.kind === "submit_deliverable");
    assert.equal(note.length, 1);
    assert.match(note[0].content, /^界面操作（不是用户打的字）：用户在页面上确认这个任务已经完成，提交了交付物（修订 1）。/);
    assert.equal(entries.at(-1).type, "custom_message", "说明之后没有助手的运行");
  }));
