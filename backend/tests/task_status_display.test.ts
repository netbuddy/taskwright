/**
 * 任务现状消息在页面上的写法：用助手一侧实际生成的几种消息（开始会话、续接有变化、续接只有新材料、末尾列出还在等回应的行为）
 * 作输入，页面上的文字里没有「执行者」「扩展」，开头换成页面上的说法；助手看到的原文不动。
 * 替换靠文字匹配，助手一侧改了这几处说法而后端没有跟上时，这里会失败。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createTask } from "../../agent/src/lib/create_task.ts";
import { ACTOR_USER } from "../../agent/src/lib/db.ts";
import { recordFromAssistantMessage, recordReplyActs } from "../../agent/src/lib/dialogue_acts.ts";
import { REGISTERED_OUTPUTS } from "../../agent/src/lib/registered_outputs.ts";
import { saveRevision } from "../../agent/src/lib/save_revision.ts";
import { taskStatusMessage } from "../../agent/src/lib/task_status.ts";
import { DEFINITION_PATH, SOURCE, callIn, makeWorkspace } from "../../agent/tests/helpers.ts";
import { TASK_STATUS, baseMessages, taskStatusDisplayText } from "../src/conversation.ts";
import { Executor } from "../src/executor.ts";
import { Hub } from "../src/hub.ts";
import { captureConsole } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const workspace = (...args: Parameters<typeof makeWorkspace>) => {
  const dir = makeWorkspace(...args);
  made.push(dir);
  return dir;
};

const SESSION = "session-here";
const addUseCase = (name: string) => ({ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["一步"] }, sources: [SOURCE] });
const FRESH = { hasUserMessage: false, hasStatusMessage: false, lastMessageAt: null };
const INTERNAL = /执行者|扩展/;
const CLOCK = /（\d\d:\d\d:\d\d）/;

/** 开始会话时的现状。 */
function startMessage(): string {
  const dir = workspace();
  createTask(callIn(dir, SESSION), { definition_path: DEFINITION_PATH, task_name: "登录模块" });
  saveRevision(callIn(dir, SESSION), { operations: [addUseCase("登录")] });
  return taskStatusMessage(dir, FRESH, SESSION)!.text;
}

/** 续接时上次之后有变化：用户在界面上改的一次，助手在别的会话里改的一次。 */
function changedMessage(): string {
  const dir = workspace();
  createTask(callIn(dir, SESSION), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir, SESSION), { operations: [addUseCase("登录")] });
  const last = Date.now() + 5;
  while (Date.now() <= last + 2) { /* 等过这条会话最后一刻，让之后的事件时刻一定更晚 */ }
  saveRevision({ ...callIn(dir), callId: "ui-op-2", actor: ACTOR_USER }, { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } }] });
  saveRevision(callIn(dir, "other-session"), { operations: [addUseCase("注销")] });
  return taskStatusMessage(dir, { hasUserMessage: true, hasStatusMessage: true, lastMessageAt: last }, SESSION)!.text;
}

/** 续接时交付物没有变化、只有新放进来的材料。 */
function materialsOnlyMessage(): string {
  const dir = workspace(undefined, { material: false });
  createTask(callIn(dir, SESSION), { definition_path: DEFINITION_PATH });
  mkdirSync(join(dir, "inputs"));
  writeFileSync(join(dir, "inputs/旧材料.md"), "旧", "utf-8");
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, "inputs/旧材料.md"), old, old);
  writeFileSync(join(dir, "inputs/新材料.md"), "新", "utf-8");
  return taskStatusMessage(dir, { hasUserMessage: true, hasStatusMessage: true, lastMessageAt: Date.now() - 1000 }, SESSION)!.text;
}

/** 续接时末尾列出还在等回应的行为：助手回复时请用户确认，用户还没回应。 */
function openActsMessage(): string {
  const dir = workspace();
  createTask(callIn(dir, SESSION), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir, SESSION), { operations: [addUseCase("登录"), addUseCase("注销")] });
  const branch: Dict[] = [{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "把材料整理成用例" }] } }];
  const intent = "```json\n" + JSON.stringify({ acts: [{ function: "request", confidence: "high", summary: "整理材料" }] }) + "\n```";
  recordFromAssistantMessage(dir, SESSION, branch as any, { role: "assistant", stopReason: "toolUse",
    content: [{ type: "text", text: intent }, { type: "toolCall", id: "call-save-0", name: "save_revision", arguments: {} }] }, REGISTERED_OUTPUTS);
  branch.push({ id: "reply-msg-1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "……" }] } });
  recordReplyActs(dir, SESSION, branch as any, {
    informs: ["我新增了 UC-001、UC-002。"],
    act: { kind: "confirm", text: "请确认 UC-001、UC-002", items: [{ item_id: "UC-001" }, { item_id: "UC-002" }] },
  }, "reply-msg-1", "call-reply-1");
  return taskStatusMessage(dir, { hasUserMessage: true, hasStatusMessage: true, lastMessageAt: 0 }, SESSION)!.text;
}

test("开始会话：开头换成「这条会话开始时（时刻）的任务状况：」，正文照旧，没有「执行者」「扩展」", () => {
  const raw = startMessage();
  assert.match(raw, INTERNAL, "助手看到的原文里有这两个词；没有了说明助手一侧改过，替换规则要跟着核对");
  const shown = taskStatusDisplayText(raw);
  assert.match(shown, /^这条会话开始时（\d\d:\d\d:\d\d）的任务状况：任务「登录模块」/);
  assert.doesNotMatch(shown, INTERNAL);
  assert.equal(shown.replace(/^这条会话开始时（[^）]*）的任务状况：/, ""), raw.replace(/^【[^】]*】/, ""), "只换开头");
});

test("续接有变化：开头换成「接着这条会话继续时（时刻），上次之后交付物的变化：」，「执行者在别的会话里做的」换成「助手在别的会话里做的」", () => {
  const raw = changedMessage();
  assert.match(raw, /执行者在别的会话里做的 1 次/);
  const shown = taskStatusDisplayText(raw);
  assert.match(shown, /^接着这条会话继续时（\d\d:\d\d:\d\d），上次之后交付物的变化：/);
  assert.match(shown, /用户在界面上直接做的 1 次，助手在别的会话里做的 1 次/);
  assert.doesNotMatch(shown, INTERNAL);
});

test("续接只有新材料：同一个开头", () => {
  const shown = taskStatusDisplayText(materialsOnlyMessage());
  assert.match(shown, /^接着这条会话继续时（\d\d:\d\d:\d\d），上次之后交付物的变化：交付物没有变化。/);
  assert.doesNotMatch(shown, INTERNAL);
});

test("末尾列出还在等回应的行为：那一行是对助手说的，页面上整行不显示，前面的正文照旧", () => {
  const raw = openActsMessage();
  assert.match(raw, /\n还在等回应的执行者行为 1 条/);
  const shown = taskStatusDisplayText(raw);
  assert.doesNotMatch(shown, /还在等回应|你问过/);
  assert.doesNotMatch(shown, INTERNAL);
  assert.ok(!shown.endsWith("\n"));
  assert.equal(shown, taskStatusDisplayText(raw.slice(0, raw.indexOf("\n还在等回应"))));
});

test("刷新之后从会话记录读回的系统说明，与实时推送的，都是页面上的写法", async () => {
  const raw = changedMessage();
  const entries = [{ type: "custom_message", id: "n1", parentId: null, timestamp: "2026-09-28T01:00:00.000Z", customType: TASK_STATUS,
    content: raw, display: false, details: {} }];
  const read = baseMessages(entries as any, SESSION).find((m) => m.type === "system_note")!;
  assert.equal(read.text, taskStatusDisplayText(raw));

  const hub = new Hub(workspace());
  const [sub] = hub.subscribe(null, null);
  const executor = new Executor("TASK-001", workspace(), workspace(), {}, hub);
  await (executor as any).handle({ note() {} }, { type: "system_note", custom_type: TASK_STATUS, text: raw, entry_id: "n1", session_id: SESSION });
  const pushed: Dict[] = [];
  for (let item = await sub.get(10); item; item = await sub.get(10)) if (item[0] === "system_note") pushed.push(item[2]);
  hub.close();
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].text, read.text);
  assert.doesNotMatch(pushed[0].text, INTERNAL);
  assert.match(pushed[0].text.replace(CLOCK, "（时刻）"), /^接着这条会话继续时（时刻），上次之后交付物的变化：/);
});
