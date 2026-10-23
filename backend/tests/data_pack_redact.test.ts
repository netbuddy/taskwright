/**
 * 脱敏诊断包（data_pack.ts 的 diagnostic.redact，redact.ts）：用材料里独有的几句话造一个任务与它的归档，导出脱敏诊断包，核对：
 * - 整个包（各文件的文字与任务库副本的字节）里找不到这几句话：read 读材料的结果、grep 搜到材料、search_knowledge 的命中、
 *   保存修订参数里的摘录与它流式写出的碎片、任务库副本的来源摘录，都换成了占位；
 * - 占位 JSON 的各项；别的工具（读规矩文件）的结果、与工具无关的行逐字不变；各文件的行数不变；计时文件与后端补记原样；
 * - 原来的任务库与归档逐字节不变；设置摘录的地址换成占位；清单文件的 purpose 是 redacted；说明写明是脱敏诊断包；
 * - 脱敏包不能导入，也不能升级。
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { PackError, README_NAME, REDACTED_IMPORT_TEXT, SETTINGS_EXCERPT_NAME, exportPack, importPack, upgradePack } from "../src/data_pack.ts";
import { maskExcerpt } from "../src/redact.ts";
import { captureConsole, tempDir } from "./helpers.ts";
import { DEFINITION, MATERIAL, READY, build } from "./overall_stack.ts";
import { locations, put, readPack, sha256 } from "./pack_stack.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => join(tmp, `${name}-${++n}`);

/** 材料里的两句（MATERIAL）与知识库命中里独有的一句：脱敏包里一处都不该有。 */
const SECRET_EXCERPT = "读者对在架的书办预约。";
const SECRET_MATERIAL = "只有在架的书才能预约取书。";
const SECRET_KNOWLEDGE = "知识库里独有的一句：借期三十天。";
const RULES = "规矩文件的全文：条目要有来源。";
const KB = "knowledge/lib-0abc/files/借阅规范.md";

const line = (value: unknown) => JSON.stringify(value);
const toolResult = (id: string, name: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 1 });
const toolCall = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const SAVE_ARGS = { operations: [{ op: "add", collection: "业务说明", fields: { 标题: "馆藏范围" }, sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: SECRET_EXCERPT }] }] };

/** 会话文件：读材料、读规矩文件、grep 搜任务目录、查知识库、保存修订，各一次调用与结果。 */
function sessionLines(cwd: string): string[] {
  return [
    line({ type: "session", version: 3, id: "s1", timestamp: "2026-10-22T00:00:00.000Z", cwd }),
    line({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "请开始。" }] } }),
    line({ type: "message", id: "m2", message: { role: "assistant", content: [
      toolCall("c1", "read", { path: "inputs/材料.md", offset: 1, limit: 10 }), toolCall("c2", "read", { path: "docs/rules.md" }),
      toolCall("c3", "grep", { pattern: "在架" }), toolCall("c4", "search_knowledge", { query: "借期多长", libraries: ["lib-0abc"] }),
    ] } }),
    line({ type: "message", id: "m3", message: toolResult("c1", "read", MATERIAL) }),
    line({ type: "message", id: "m4", message: toolResult("c2", "read", RULES) }),
    line({ type: "message", id: "m5", message: toolResult("c3", "grep", `inputs/材料.md:1: ${SECRET_MATERIAL}`) }),
    line({ type: "message", id: "m6", message: { ...toolResult("c4", "search_knowledge", `【第 1 个片段】${KB}\n<<<原文开始\n${SECRET_KNOWLEDGE}\n原文结束>>>`), details: { query: "借期多长", hits: [{ locator: KB }] } } }),
    line({ type: "message", id: "m7", message: { role: "assistant", content: [toolCall("c5", "save_revision", SAVE_ARGS)] } }),
    line({ type: "message", id: "m8", message: toolResult("c5", "save_revision", "已保存为修订 1。") }),
  ];
}

/** 事件流：同样几次调用在各种事件里的样子，另有一行与工具无关的思考片段。 */
function eventLines(): string[] {
  const read = toolResult("c1", "read", MATERIAL);
  return [
    line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "先读材料。" } }),
    line({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "inputs/材料.md", offset: 1, limit: 10 } }),
    line({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: MATERIAL }], structuredContent: MATERIAL }, isError: false }),
    line({ type: "message_start", message: read }),
    line({ type: "message_end", message: read }),
    line({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "docs/rules.md" } }),
    line({ type: "tool_execution_end", toolCallId: "c2", toolName: "read", result: { content: [{ type: "text", text: RULES }], structuredContent: RULES }, isError: false }),
    line({ type: "turn_end", message: { role: "assistant", content: [toolCall("c1", "read", { path: "inputs/材料.md", offset: 1, limit: 10 })] }, toolResults: [read] }),
    line({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "c5", toolName: "save_revision" } }),
    line({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{\"operations\":[{\"sources\":[{\"excerpt\":\"读者对在架" } }),
    line({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "的书办预约。\"}]}]}" } }),
    line({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: toolCall("c5", "save_revision", SAVE_ARGS) } }),
    line({ type: "tool_execution_start", toolCallId: "c5", toolName: "save_revision", args: SAVE_ARGS }),
    line({ type: "agent_end", messages: [{ role: "assistant", content: [toolCall("c5", "save_revision", SAVE_ARGS)] }, read] }),
  ];
}

/** 一个数据目录：一个任务（来源摘录是 SECRET_EXCERPT），它的归档（会话文件、事件流、计时文件、后端补记），一个设置文件。 */
function sample() {
  const ws = build(fresh("ws"), "redact", DEFINITION, [[READY]]);
  const where = locations(fresh("data"));
  mkdirSync(where.tasksDir, { recursive: true });
  const taskDir = join(where.tasksDir, "redact-task");
  cpSync(ws, taskDir, { recursive: true });
  const db = new DatabaseSync(join(taskDir, "task.sqlite"), { readOnly: true });
  const taskId = (db.prepare("SELECT task_id FROM task").get() as { task_id: string }).task_id;
  db.close();
  const runs = join(where.runsDir, taskId);
  // 会话文件里记的工作目录是建它时的那个目录（任务目录后来被挪过）。
  put(join(runs, "pi-sessions", "service", "s1.jsonl"), sessionLines(ws).join("\n") + "\n");
  put(join(runs, "pi-events", "service-1.jsonl"), eventLines().join("\n") + "\n");
  put(join(runs, "pi-events", "service-1.times.jsonl"), line({ 行号: 1, 收到时刻: 1 }) + "\n");
  put(join(runs, "pi-events", "service-1.backend.jsonl"), line({ 记录: "启动", 时刻: "2026-10-22T00:00:00" }) + "\n");
  const settings = { version: 2, selection: { language: null, embedding: null },
    providers: { "taskwright-ollama": { kind: "ollama" as const, purpose: "language" as const, name: "ollama", base_url: "http://models.example.test:11434", models: [] } } };
  return { where, taskId, taskDir, runs, settings };
}

/** 一个目录下全部文件的 SHA-256。 */
function digests(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string) => {
    for (const name of readdirSync(at, { withFileTypes: true })) {
      if (name.isDirectory()) walk(join(at, name.name), `${rel}${name.name}/`);
      else out[`${rel}${name.name}`] = sha256(readFileSync(join(at, name.name)));
    }
  };
  walk(dir, "");
  return out;
}

async function redactedPack() {
  const made = sample();
  const before = { task: digests(made.taskDir), runs: digests(made.runs) };
  const to = join(fresh("out"), "diag-redacted.taskwright.zip");
  mkdirSync(join(to, ".."), { recursive: true });
  const result = await exportPack(made.where, { scope: "task", taskId: made.taskId, to,
    diagnostic: { settings: made.settings, logsDir: join(made.where.dataDir, "logs"), redact: true } });
  return { ...made, before, to, result, pack: readPack(to) };
}

test("整个脱敏包里找不到材料里的句子、知识库命中与来源摘录：会话文件、事件流与任务库副本里都换掉了", async () => {
  const { pack } = await redactedPack();
  for (const name of pack.names) {
    const bytes = pack.content(name);
    for (const secret of [SECRET_EXCERPT, SECRET_MATERIAL, SECRET_KNOWLEDGE, "读者对在架", "的书办预约"]) {
      assert.equal(bytes.includes(Buffer.from(secret, "utf-8")), false, `${name} 里还有「${secret}」`);
    }
  }
});

test("占位 JSON 的各项；读规矩文件的结果、与工具无关的行逐字不变；各文件行数不变；计时文件与后端补记原样", async () => {
  const { pack, taskId } = await redactedPack();
  const text = (name: string) => pack.content(name).toString("utf-8");
  const session = text(`runs/${taskId}/pi-sessions/service/s1.jsonl`).split("\n");
  const events = text(`runs/${taskId}/pi-events/service-1.jsonl`).split("\n");
  assert.equal(session.length, sessionLines("x").length + 1);
  assert.equal(events.length, eventLines().length + 1);
  const resultOf = (raw: string) => JSON.parse(JSON.parse(raw).message.content[0].text);
  assert.deepEqual(resultOf(session[3]), { redacted: true, tool: "read", path: "inputs/材料.md", lines: [1, 10], bytes: Buffer.byteLength(MATERIAL), sha256_16: sha256(MATERIAL).slice(0, 16) });
  assert.equal(JSON.parse(session[4]).message.content[0].text, RULES, "读规矩文件的结果不动");
  assert.deepEqual(resultOf(session[5]).tool, "grep");
  assert.deepEqual([resultOf(session[6]).tool, resultOf(session[6]).path], ["search_knowledge", ["lib-0abc"]]);
  assert.equal(JSON.parse(session[6]).message.details.query, "借期多长", "检索用的话保留");
  assert.equal(JSON.parse(session[7]).message.content[0].arguments.operations[0].sources[0].excerpt, maskExcerpt(SECRET_EXCERPT));
  assert.equal(JSON.parse(session[8]).message.content[0].text, "已保存为修订 1。");
  // 事件流：与工具无关的行逐字不变；read 的结果在 result.content 与 structuredContent 里是同一个占位；碎片置空。
  assert.equal(events[0], eventLines()[0]);
  const end = JSON.parse(events[2]);
  assert.equal(end.result.structuredContent, end.result.content[0].text);
  assert.equal(JSON.parse(end.result.structuredContent).tool, "read");
  assert.equal(JSON.parse(events[6]).result.content[0].text, RULES);
  assert.deepEqual([JSON.parse(events[9]).assistantMessageEvent.delta, JSON.parse(events[10]).assistantMessageEvent.delta], ["", ""]);
  assert.equal(JSON.parse(events[11]).assistantMessageEvent.toolCall.arguments.operations[0].sources[0].excerpt, maskExcerpt(SECRET_EXCERPT));
  assert.equal(text(`runs/${taskId}/pi-events/service-1.times.jsonl`), line({ 行号: 1, 收到时刻: 1 }) + "\n");
  assert.equal(text(`runs/${taskId}/pi-events/service-1.backend.jsonl`), line({ 记录: "启动", 时刻: "2026-10-22T00:00:00" }) + "\n");
});

test("任务库副本的摘录换成摘要值与长度；原库与原归档逐字节不变；设置摘录的地址换成占位；purpose 是 redacted；说明写明是脱敏诊断包", async () => {
  const { pack, taskId, taskDir, runs, before, result } = await redactedPack();
  const copy = join(fresh("db"), "task.sqlite");
  put(copy, pack.content(`tasks/${taskId}/task.sqlite`));
  const db = new DatabaseSync(copy, { readOnly: true });
  const excerpts = (db.prepare("SELECT excerpt FROM item_source").all() as { excerpt: string }[]).map((one) => one.excerpt);
  db.close();
  assert.ok(excerpts.length > 0 && excerpts.every((one) => /^\[已脱敏\] 摘要值 [0-9a-f]{16} 长度 \d+$/.test(one)), excerpts.join(" / "));
  assert.ok(excerpts.includes(maskExcerpt(SECRET_EXCERPT)));
  assert.deepEqual({ task: digests(taskDir), runs: digests(runs) }, before);
  assert.equal(JSON.parse(pack.content(SETTINGS_EXCERPT_NAME).toString("utf-8")).providers["taskwright-ollama"].base_url, "[已脱敏]");
  assert.equal(pack.manifest.diagnostic!.purpose, "redacted");
  assert.deepEqual(result.diagnostic, { logs: 0, redacted: true });
  const readme = pack.content(README_NAME).toString("utf-8");
  assert.ok(readme.startsWith("这是脱敏诊断包，用来排查流程类问题，不用来恢复任务，也不能导入。\n"), readme);
  for (const part of ["已替换", "仍含", "助手的思考与回复里可能引用的原文", "能查什么", "查不了内容类问题"]) assert.ok(readme.includes(part), part);
});

test("脱敏包不能导入，也不能升级", async () => {
  const { to } = await redactedPack();
  // 导入：整个包不导入，原因写在报告里，目标数据目录没有任务。
  const target = locations(fresh("target"));
  const report = await importPack(target, { file: to });
  assert.deepEqual([report.fatal, report.tasks], [REDACTED_IMPORT_TEXT, []]);
  await assert.rejects(upgradePack(to, join(fresh("up"), "x.zip")), (error: unknown) => error instanceof PackError && error.code === "refused" && error.message === REDACTED_IMPORT_TEXT);
});
