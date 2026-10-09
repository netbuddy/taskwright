/**
 * 用户在界面上停止助手这一次运行之后，后端经 /tw-user 发来的 stop_run：只往会话里留一条通知，不写库。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_COMMAND, USER_EDIT_CUSTOM_TYPE, USER_RESULT_KEY, registerUserCommands } from "../src/hooks/user_commands.ts";
import { STOP_RUN_KIND, STOP_RUN_NOTE } from "../src/lib/user_ops.ts";

test("stop_run：往会话里追加一条不可撤销的通知并回报成功；不发话引出新的运行，任务目录里什么都不写", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-stop-run-"));
  const commands = new Map<string, any>();
  const messages: any[] = [];
  const said: string[] = [];
  registerUserCommands({ registerCommand: (name: string, spec: any) => commands.set(name, spec),
    sendMessage: (...args: any[]) => messages.push(args), sendUserMessage: (text: string) => said.push(text) } as any);
  const status: Record<string, string[]> = {};
  const ctx = { mode: "rpc", cwd: dir, sessionManager: { getSessionId: () => "sess-stop" },
    ui: { setStatus: (key: string, value: string) => (status[key] ??= []).push(value), notify() {} } };
  await commands.get(USER_COMMAND).handler(JSON.stringify({ op_id: "ui-op-s1", kind: STOP_RUN_KIND }), ctx);

  assert.equal(STOP_RUN_NOTE, "界面操作（不是用户打的字）：用户在界面上停止了你这一次的工作，停下时正在做的那一步没有做完。");
  // 只传一条消息、不传送法：助手空闲时立即加进会话，不引出模型请求。
  assert.deepEqual(messages, [[{ customType: USER_EDIT_CUSTOM_TYPE, content: STOP_RUN_NOTE, display: true,
    details: { op_id: "ui-op-s1", kind: "stop_run", event_seqs: [], results: [], revision_no: null, undoable: false } }]]);
  assert.deepEqual(said, []);
  assert.deepEqual(status[USER_RESULT_KEY].map((one) => JSON.parse(one)), [{ op_id: "ui-op-s1", ok: true, event_seqs: [], results: [], revision_no: null }]);
  assert.ok(existsSync(dir));
  assert.deepEqual(readdirSync(dir), [], "没有建任务库");
});
