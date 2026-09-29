// 测试夹具：用 agent 里真实的核心函数写出几种任务现状消息（开始会话、续接有变化、续接只有新材料、末尾列出还在等回应的行为），
// 以 JSON 打到标准输出：{start, changed, materialsOnly, openActs}。后端（backend/tests/task_status_display.test.ts）经子进程调用它，
// 用助手一侧实际生成的文字核对页面上的写法；后端自己不导入任何写入函数。建的临时任务目录用完即删。
// 用法：node task_status_texts.mts
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTask } from "../../src/lib/create_task.ts";
import { ACTOR_USER } from "../../src/lib/db.ts";
import { recordFromAssistantMessage, recordReplyActs } from "../../src/lib/dialogue_acts.ts";
import { REGISTERED_OUTPUTS } from "../../src/lib/registered_outputs.ts";
import { saveRevision } from "../../src/lib/save_revision.ts";
import { taskStatusMessage } from "../../src/lib/task_status.ts";
import { DEFINITION_PATH, SOURCE, callIn, makeWorkspace } from "../helpers.ts";

type Dict = Record<string, any>;
const made: string[] = [];
const workspace = (...args: Parameters<typeof makeWorkspace>) => {
  const dir = makeWorkspace(...args);
  made.push(dir);
  return dir;
};

const SESSION = "session-here";
const addUseCase = (name: string) => ({ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["一步"] }, sources: [SOURCE] });
const FRESH = { hasUserMessage: false, hasStatusMessage: false, lastMessageAt: null };

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

try {
  process.stdout.write(JSON.stringify({ start: startMessage(), changed: changedMessage(), materialsOnly: materialsOnlyMessage(), openActs: openActsMessage() }));
} finally {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
}
