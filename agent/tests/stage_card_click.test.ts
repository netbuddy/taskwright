/**
 * 用户在助手提议进入写条目的那张卡片上点了「开始写条目」：系统替用户记一次移到写条目（lib/stage_read.ts 的 recordStartItemsClick），
 * 在卡片点击的处理函数（hooks/user_commands.ts 的 /tw-ui）里、发那句固定的话之前记。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { UI_COMMAND, UI_RESULT_KEY, registerUserCommands } from "../src/hooks/user_commands.ts";
import { CONTINUE_CLARIFY_KEY, CONTINUE_CLARIFY_TEXT, START_ITEMS_KEY, START_ITEMS_TEXT } from "../src/lib/stage.ts";
import { START_ITEMS_REASON, recordStartItemsClick } from "../src/lib/stage_read.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, callIn, count, demoDefinition, makeWorkspace, overallDefinition, query } from "./helpers.ts";

const SESSION = "sess-ui";
const OPTIONS = [{ key: START_ITEMS_KEY, text: START_ITEMS_TEXT }, { key: CONTINUE_CLARIFY_KEY, text: CONTINUE_CLARIFY_TEXT }];
/** 一条助手消息，里面是「回复」工具发的一张请选择卡片。 */
const card = (id: string, options: unknown[] = OPTIONS) => ({
  id, type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name: "reply", id: `call-${id}`,
    arguments: { informs: [], act: { kind: "choose", text: "主题页你都看过了，现在开始写条目吗？", options }, text: "现在开始写条目吗？" } }] },
});
const said = (id: string, text: string) => ({ id, type: "message", message: { role: "user", content: text } });
const BRANCH = [said("u-1", "读一下材料"), card("a-1"), card("a-2", [{ key: "yes", text: "可以" }, { key: "no", text: "不行" }])] as never;

function workspace(definition: unknown = overallDefinition()): string {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
const records = (dir: string) => query(dir, "SELECT stage, from_stage, actor, reason, run_id, call_id, session_id FROM stage_record ORDER BY event_seq").map((r) => ({ ...r }));

test("点「开始写条目」：记一条用户的移动，理由写明是在卡片上选的；点「继续澄清」什么都不记", () => {
  const dir = workspace();
  assert.equal(recordStartItemsClick(dir, SESSION, BRANCH, { opId: "ui-op-1", replyEntry: "a-1", optionKey: CONTINUE_CLARIFY_KEY }), null);
  assert.equal(count(dir, "stage_record"), 0);
  const moved = recordStartItemsClick(dir, SESSION, BRANCH, { opId: "ui-op-2", replyEntry: "a-1", optionKey: START_ITEMS_KEY })!;
  assert.deepEqual([moved.moved, moved.from, moved.requested], [true, "reading", "writing"]);
  assert.equal(START_ITEMS_REASON, "用户在卡片上选了「开始写条目」");
  assert.deepEqual(records(dir), [{ stage: "writing", from_stage: "reading", actor: "user", reason: START_ITEMS_REASON, run_id: null, call_id: "ui-op-2", session_id: SESSION }]);
  // 已经在写条目了再点一次（例如点了一张更早的卡片）：原地不动，不再记。
  const again = recordStartItemsClick(dir, SESSION, BRANCH, { opId: "ui-op-3", replyEntry: "a-1", optionKey: START_ITEMS_KEY })!;
  assert.deepEqual([again.moved, again.why], [false, "same"]);
  assert.equal(count(dir, "stage_record"), 1);
});

test("认不出那张卡片就不记：回复不在这条分支上、那条回复不是请选择、卡片上没有这个键、点的不是这个键", () => {
  const dir = workspace();
  const tries = [
    { replyEntry: "a-9", optionKey: START_ITEMS_KEY },   // 分支上没有这条回复
    { replyEntry: "u-1", optionKey: START_ITEMS_KEY },   // 是用户的话，不是卡片
    { replyEntry: "a-2", optionKey: START_ITEMS_KEY },   // 卡片上没有这个键（页面不会这样发，防的是乱写的请求）
    { replyEntry: "a-1", optionKey: "yes" },
    { replyEntry: null, optionKey: START_ITEMS_KEY },
  ];
  for (const one of tries) assert.equal(recordStartItemsClick(dir, SESSION, BRANCH, { opId: "ui-op-1", ...one }), null);
  assert.equal(count(dir, "stage_record"), 0);
});

test("早先建的任务没有阶段、已经不在进行中的任务：点了也不记", () => {
  const old = workspace(demoDefinition());
  const none = recordStartItemsClick(old, SESSION, BRANCH, { opId: "ui-op-1", replyEntry: "a-1", optionKey: START_ITEMS_KEY })!;
  assert.deepEqual([none.moved, none.why, none.from], [false, "no_stages", null]);
  assert.equal(count(old, "stage_record"), 0);
  assert.equal(recordStartItemsClick(makeWorkspace(), SESSION, BRANCH, { opId: "ui-op-1", replyEntry: "a-1", optionKey: START_ITEMS_KEY }), null, "还没有库");
});

/** 登记两个扩展命令，取 /tw-ui 的处理函数；sent 按先后记下它往会话里发的东西。 */
function uiHandler() {
  const commands = new Map<string, any>();
  const sent: [string, any][] = [];
  registerUserCommands({
    registerCommand: (name: string, spec: any) => commands.set(name, spec),
    sendMessage: (message: any) => sent.push(["custom", message]),
    sendUserMessage: (text: string) => sent.push(["user", text]),
  } as any);
  return { handler: commands.get(UI_COMMAND).handler as (args: string, ctx: any) => Promise<void>, sent };
}
function fakeCtx(dir: string) {
  const status: Record<string, string> = {};
  return { status, ctx: { mode: "rpc", cwd: dir, isIdle: () => true, sessionManager: { getSessionId: () => SESSION, getBranch: () => BRANCH },
    ui: { setStatus: (key: string, value: string) => (status[key] = value), notify() {} } } };
}

test("卡片点击的处理函数：点「开始写条目」时先记移动、再发标注与那句固定的话，结果里带那条事件的序号", async () => {
  const dir = workspace();
  const { handler, sent } = uiHandler();
  const { ctx, status } = fakeCtx(dir);
  await handler(JSON.stringify({ op_id: "ui-op-41", reply_entry: "a-1", option_key: START_ITEMS_KEY, option_text: START_ITEMS_TEXT, text: "我选：开始写条目" }), ctx);
  const seq = query<{ event_seq: number }>(dir, "SELECT event_seq FROM stage_record")[0].event_seq;
  assert.deepEqual(JSON.parse(status[UI_RESULT_KEY]), { op_id: "ui-op-41", ok: true, idle: true, stage_event_seq: seq });
  assert.deepEqual(sent.map(([kind]) => kind), ["custom", "user"]);
  assert.equal(sent[0][1].details.stage_event_seq, seq);
  assert.equal(sent[1][1], "我选：开始写条目");
  assert.deepEqual(records(dir).map((r) => [r.stage, r.actor, r.call_id]), [["writing", "user", "ui-op-41"]]);

  // 点「继续澄清」：照常发那两条，不记移动，结果里没有事件序号。
  const other = fakeCtx(dir);
  await handler(JSON.stringify({ op_id: "ui-op-42", reply_entry: "a-1", option_key: CONTINUE_CLARIFY_KEY, option_text: CONTINUE_CLARIFY_TEXT, text: "我选：继续澄清" }), other.ctx);
  assert.deepEqual(JSON.parse(other.status[UI_RESULT_KEY]), { op_id: "ui-op-42", ok: true, idle: true });
  assert.equal("stage_event_seq" in sent[2][1].details, false);
  assert.equal(count(dir, "stage_record"), 1);
});

test("用户先在界面上把任务移回澄清，再点卡片上的「开始写条目」：又记一条，最近一条说了算", async () => {
  const dir = workspace();
  const { handler } = uiHandler();
  const click = (opId: string) => handler(JSON.stringify({ op_id: opId, reply_entry: "a-1", option_key: START_ITEMS_KEY, option_text: START_ITEMS_TEXT, text: "我选：开始写条目" }), fakeCtx(dir).ctx);
  await click("ui-op-51");
  runUserOperation({ workspaceDir: dir, sessionId: SESSION }, { op_id: "ui-op-52", kind: "move_stage", fields: { stage: "澄清" } });
  await click("ui-op-53");
  assert.deepEqual(records(dir).map((r) => [r.from_stage, r.stage, r.call_id]), [["reading", "writing", "ui-op-51"], ["writing", "clarifying", "ui-op-52"], ["clarifying", "writing", "ui-op-53"]]);
});
