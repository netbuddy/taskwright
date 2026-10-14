/**
 * 发布版本之前要用户在卡片上同意：起真的后端进程与真的 pi，模型换成进程内的假端点。
 * 流程：助手保存一个用例；用户在界面上打开看过、发起评审（假端点替评审者回「没有发现」），完成条件全部满足；
 * 用户打字说「都看过了，发布吧」，助手调用发布版本被拒（打字不算同意），拒绝写明要先发「这个任务是否已经完成」的卡片；
 * 助手发了这张卡片，用户在卡片上点「已完成，发布版本」（与页面一样经发话接口，origin 为 card_choice），助手再调用：
 * 助手一侧请任务服务写好这一版的文档存档（Markdown 与 Word），再记下第 1 版。发布之后任务照常可以修改。
 * 另一条走页面：完成条件满足之后，用户在页面的提示条上发布（POST …/versions，带页面看到的修订号），
 * 修订号不是现在的被拒、存档不留；是现在的，记下第 1 版，发起方是用户，存档在任务目录里，会话里多一句说明，不引出助手的运行。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { captureConsole, tempDir } from "./helpers.ts";
import { type Dict, MATERIAL, NO_PI, reply, sleep, type Stack, withStack } from "./consent_stack.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const AGREE = "已完成，发布版本";
const CARD = { kind: "choose", text: "功能用例一共 1 个条目，已经评审通过，你也看过了，没有未解决的问题。这个任务是否已经完成、可以发布第 1 版？发布之后仍然可以接着修改。",
  options: [{ key: "complete", text: AGREE }, { key: "continue", text: "还没完成，继续修改" }] };
const SCRIPT = {
  rules: [{ when: { any_contains: "你是评审者" }, reply: { text: JSON.stringify({ 发现: [] }) } }],
  sequence: [
    { tool_calls: [{ id: "call-save", name: "save_revision", arguments: { operations: [{ op: "add", collection: "功能用例",
      sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: MATERIAL }],
      fields: { 用例名称: "借书", 用例功能: "读者借书。", 参与者: ["读者"], 基本流程: ["读者在自助机上刷借书证", "系统记下借阅"] } }] } }] },
    reply("整理好了一个用例。", "call-done-1"),
    { tool_calls: [{ id: "call-complete-typed", name: "publish_version", arguments: {} }] },
    reply("完成条件都满足了，请在卡片上选。", "call-card", CARD),
    { tool_calls: [{ id: "call-complete", name: "publish_version", arguments: { note: "首版" } }] },
    reply("第 1 版发布了。", "call-done-2"),
  ],
};

/** 主题页是开会话之前备好的（修订 1）；保存一个用例（修订 2），用户把两个都打开看过，发起评审并等它做完，再把任务移到评审确认：完成条件全部满足。 */
async function ready({ send, action, db }: Stack): Promise<void> {
  await send({ text: "把材料整理成需求规格说明。", client_id: "c-1" });
  assert.equal((await action({ kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 1 }, { item_id: "UC-001", base_revision: 2 }] })).status, 200);
  assert.equal((await action({ kind: "request_review", targets: [] })).status, 200);
  for (const end = Date.now() + 30000; db("SELECT 1 FROM event WHERE name = 'REVIEW_FINISHED'").length === 0;) {
    if (Date.now() > end) throw new Error("评审没有做完");
    await sleep(100);
  }
  // 助手只有在评审确认阶段才能发布版本：用户把任务移过去（任务开会话之前已经备到写条目阶段）。
  assert.equal((await action({ kind: "move_stage", fields: { stage: "评审确认" } })).status, 200);
}

test("打字说发布被拒；助手发了是否已经完成的卡片、用户点「已完成，发布版本」之后，助手发布第 1 版：任务服务写了存档，任务照常可以修改", { skip: NO_PI, timeout: 120000 }, () =>
  withStack(tmp, "consent", SCRIPT, async (stack) => {
    const { call, taskId, session, dir, db, send, entryOfCall } = stack;
    await ready(stack);

    await send({ text: "都看过了，发布吧。", client_id: "c-2" });
    const typed = db("SELECT call_id, fact, guidance FROM tool_rejection WHERE tool_name = 'publish_version'");
    assert.deepEqual(typed.map((r: Dict) => r.call_id), ["call-complete-typed"], "打字说发布不算同意");
    assert.match(typed[0].fact, /用户还没有在问这个任务是否已经完成的卡片上点「已完成，发布版本」。/);
    assert.match(typed[0].guidance, /\{ key: "complete", text: "已完成，发布版本" \} 与「还没完成，继续修改」/);
    assert.equal(db("SELECT COUNT(*) AS n FROM version_record")[0].n, 0);

    const cardEntry = entryOfCall("call-card");
    await send({ text: `我选：${AGREE}`, client_id: "c-3", origin: "card_choice", card: { reply_message_id: cardEntry, kind: "choose", choice: "complete" } });

    assert.deepEqual(db("SELECT call_id FROM tool_rejection WHERE tool_name = 'publish_version'").map((r: Dict) => r.call_id), ["call-complete-typed"]);
    assert.deepEqual(db("SELECT version_no, actor, revision_no, note, markdown_path, docx_path, figure_count, figure_pictures FROM version_record").map((r: Dict) => ({ ...r })), [
      { version_no: 1, actor: "executor", revision_no: 2, note: "首版", markdown_path: "versions/v1/document.md", docx_path: "versions/v1/document.docx", figure_count: null, figure_pictures: null }]);
    assert.deepEqual(db("SELECT call_id FROM event WHERE name = 'VERSION_PUBLISHED'").map((r: Dict) => r.call_id), ["call-complete"]);
    assert.ok(existsSync(join(dir, "tasks", taskId, "versions", "v1", "document.docx")));
    assert.match(readFileSync(join(dir, "tasks", taskId, "versions", "v1", "document.md"), "utf-8"), /借书/);
    assert.equal(db("SELECT status FROM task")[0].status, "进行中");

    // 发布之后照常可以修改：改字段成功。
    const edit = await call("POST", `/api/v1/tasks/${taskId}/actions?session=${session}`, { client_id: "a-edit", task_id: taskId, kind: "edit_fields",
      targets: [{ item_id: "UC-001", base_revision: 2 }], fields: { 用例名称: "借阅" }, notify_executor: false });
    assert.equal(edit.status, 200);
  }));

test("页面发布：看到的修订号不是现在的被拒、不留存档；带着现在的修订号发布，记下第 1 版，发起方是用户，存档在任务目录里，会话里多一句说明，不引出助手的运行", { skip: NO_PI, timeout: 120000 }, () =>
  withStack(tmp, "page", { rules: SCRIPT.rules, sequence: SCRIPT.sequence.slice(0, 2) }, async (stack) => {
    const { call, taskId, session, dir, db } = stack;
    await ready(stack);
    const publish = (body: Dict) => call("POST", `/api/v1/tasks/${taskId}/versions?session=${session}`, body);
    const stale = await publish({ revision_no: 0 });
    assert.deepEqual([stale.body.error.code, stale.body.error.message], ["rejected", "这次没有发布：你看到的是修订 0，交付物现在已经是修订 2。请看过现在的内容再发布。"]);
    assert.equal(db("SELECT COUNT(*) AS n FROM version_record")[0].n, 0);
    assert.equal(existsSync(join(dir, "tasks", taskId, "versions", "v1")), false, "没有记成的存档删掉了");
    // 直接操作的接口不收发布：要先写存档。
    const direct = await call("POST", `/api/v1/tasks/${taskId}/actions?session=${session}`, { kind: "publish_version", targets: [], fields: { revision_no: 2, version_no: 1 } });
    assert.deepEqual([direct.status, direct.body.error.code], [400, "bad_request"]);

    const done = await publish({ revision_no: 2, note: "首版" });
    assert.equal(done.status, 200);
    assert.deepEqual([done.body.version_no, done.body.revision_no, done.body.figure_count, done.body.figure_pictures], [1, 2, null, null]);
    assert.deepEqual(db("SELECT actor, call_id FROM event WHERE name = 'VERSION_PUBLISHED'").map((r: Dict) => [r.actor, r.call_id]), [["user", done.body.op_id]]);
    assert.deepEqual(db("SELECT version_no, note, markdown_path FROM version_record").map((r: Dict) => ({ ...r })), [{ version_no: 1, note: "首版", markdown_path: "versions/v1/document.md" }]);
    assert.ok(existsSync(join(dir, "tasks", taskId, "versions", "v1", "document.md")));
    assert.equal(db("SELECT status FROM task")[0].status, "进行中");
    const sessionDir = join(dir, "runs", taskId, "pi-sessions", "service");
    const file = join(sessionDir, readdirSync(sessionDir).find((n) => n.endsWith(`_${session}.jsonl`))!);
    const entries = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const note = entries.filter((e) => e.type === "custom_message" && e.details?.kind === "publish_version");
    assert.equal(note.length, 1);
    assert.equal(note[0].content, "界面操作（不是用户打的字）：用户在页面上发布了第 1 版（修订 2），发布说明：首版。发布之后任务照常可以修改，以后可以再发布新的一版。");
    assert.equal(note[0].details.version_no, 1);
    assert.equal(entries.at(-1).type, "custom_message", "说明之后没有助手的运行");
  }));
