/** /tw-user 被拒时的显示：交互模式下经 notify 给人看完整原因，RPC 模式只经状态栏回传。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { UI_COMMAND, UI_RESULT_KEY, USER_COMMAND, USER_RESULT_KEY, registerUserCommands, rejectionText } from "../src/hooks/user_commands.ts";
import { DEFINITION_PATH, SOURCE, callIn, makeWorkspace } from "./helpers.ts";

function userCommandHandler() {
  const commands = new Map<string, any>();
  registerUserCommands({ registerCommand: (name: string, spec: any) => commands.set(name, spec), sendMessage() {}, sendUserMessage() {} } as any);
  return commands.get(USER_COMMAND).handler as (args: string, ctx: any) => Promise<void>;
}

function fakeCtx(dir: string, mode: string) {
  const status: Record<string, string> = {};
  const notes: Array<{ message: string; type?: string }> = [];
  const ctx = {
    mode,
    cwd: dir,
    sessionManager: { getSessionId: () => "sess-ui" },
    ui: { setStatus: (key: string, value: string) => (status[key] = value), notify: (message: string, type?: string) => notes.push({ message, type }) },
  };
  return { ctx, status, notes };
}

function staleEdit(dir: string) {
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["打开页面"] }, sources: [SOURCE] }] });
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "登录系统" } }] });
  return JSON.stringify({ op_id: "ui-tui-4", kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] });
}

test("交互模式下被拒：状态栏照旧回传 JSON，另经 notify 发出不截短的完整原因", async () => {
  const dir = makeWorkspace();
  const args = staleEdit(dir);
  const { ctx, status, notes } = fakeCtx(dir, "tui");
  await userCommandHandler()(args, ctx);
  const reported = JSON.parse(status[USER_RESULT_KEY]);
  assert.equal(reported.ok, false);
  assert.equal(reported.error.code, "stale_revision");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, "error");
  assert.ok(notes[0].message.startsWith("/tw-user 没有执行（stale_revision）："), notes[0].message);
  assert.ok(notes[0].message.includes(reported.error.message), "notify 里要有状态栏里那段完整的说明");
});

test("RPC 模式下被拒只经状态栏回传，不发 notify；参数不是 JSON 时也一样", async () => {
  const dir = makeWorkspace();
  const args = staleEdit(dir);
  for (const input of [args, "不是 JSON"]) {
    const { ctx, status, notes } = fakeCtx(dir, "rpc");
    await userCommandHandler()(input, ctx);
    assert.equal(JSON.parse(status[USER_RESULT_KEY]).ok, false);
    assert.equal(notes.length, 0);
  }
});

test("rejectionText 把 data.reasons 里说明之外的原因逐条列出", () => {
  const text = rejectionText({ code: "rejected", message: "有 2 个操作不对", data: { reasons: ["有 2 个操作不对", "操作 1：字段为空", "操作 2：版本过期"] } });
  assert.equal(text, "/tw-user 没有执行（rejected）：有 2 个操作不对\n- 操作 1：字段为空\n- 操作 2：版本过期");
});

test("/tw-ui 的 option_key 是 typed：用户在卡片的文本框里打的字，追加的是 taskwright-card-typed 说明，不是界面点击，随后把原话发出去", async () => {
  const dir = makeWorkspace();
  const sent: any[] = [];
  const said: string[] = [];
  const commands = new Map<string, any>();
  registerUserCommands({ registerCommand: (name: string, spec: any) => commands.set(name, spec),
    sendMessage: (message: any, options: any) => sent.push({ message, options }), sendUserMessage: (text: string) => said.push(text) } as any);
  const { ctx, status } = fakeCtx(dir, "rpc");
  Object.assign(ctx, { isIdle: () => true, sessionManager: { getSessionId: () => "sess-ui", getBranch: () => [] } });
  await commands.get(UI_COMMAND).handler(JSON.stringify({ op_id: "ui-op-1", reply_entry: "reply-9", option_key: "typed", option_text: "typed", text: "先说说别的" }), ctx);
  assert.deepEqual(JSON.parse(status[UI_RESULT_KEY]), { op_id: "ui-op-1", ok: true, idle: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, "taskwright-card-typed");
  assert.equal(sent[0].message.content, "卡片里的回复（是用户打的字）：用户在回复 reply-9 的卡片的文本框里写了下面这句话。");
  assert.deepEqual(sent[0].message.details, { op_id: "ui-op-1", reply_entry: "reply-9", text: "先说说别的" });
  assert.deepEqual(sent[0].options, { deliverAs: "followUp" });
  assert.deepEqual(said, ["先说说别的"]);
});
