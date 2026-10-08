/**
 * 任务现状消息在页面上的写法：用助手一侧实际生成的几种消息（开始会话、续接有变化、续接只有新材料、末尾列出还在等回应的行为）
 * 作输入，页面上的文字里没有「执行者」「扩展」，开头换成页面上的说法；助手看到的原文不动。
 * 替换靠文字匹配，助手一侧改了这几处说法而后端没有跟上时，这里会失败。
 * 这条消息的 details 也给页面（页面拿它写折叠起来的那一行要点）：照原样，只去掉写给助手看的 open_acts，材料清单的每个文件另标
 * 它是由哪个文件生成的；读回的与实时推送的一样，种类都是 task_status。
 * 几种消息由 agent/tests/fixtures/task_status_texts.mts 经子进程写出：后端不导入 agent 的写入函数（见 no_writes.test.ts）。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { TASK_STATUS, baseMessages, taskStatusDisplayDetails, taskStatusDisplayText } from "../src/conversation.ts";
import { Executor } from "../src/executor.ts";
import { Hub } from "../src/hub.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const workspace = () => {
  const dir = tempDir();
  made.push(dir);
  return dir;
};

const SESSION = "session-here";
const INTERNAL = /执行者|扩展/;
const CLOCK = /（\d\d:\d\d:\d\d）/;

/** 助手一侧实际生成的四种消息，一次写出。 */
const TEXTS: { start: string; changed: string; materialsOnly: string; openActs: string } = (() => {
  const done = spawnSync(process.execPath, [join(ROOT, "agent", "tests", "fixtures", "task_status_texts.mts")], { encoding: "utf-8" });
  if (done.status !== 0) throw new Error(`夹具脚本失败：${done.stderr}`);
  return JSON.parse(done.stdout);
})();
const startMessage = () => TEXTS.start;
const changedMessage = () => TEXTS.changed;
const materialsOnlyMessage = () => TEXTS.materialsOnly;
const openActsMessage = () => TEXTS.openActs;

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

// ───────────── details ─────────────

/** 开始会话那一种的 details，照助手一侧写的形状（agent/src/lib/task_status.ts 的 statusNow）。 */
const START_DETAILS = {
  kind: "现状", task_id: "TASK-001", task_name: "登录模块", task_type: "软件需求规格说明编制", status: "进行中", items: { 用例: 1 },
  conditions_total: 3, conditions_met: 1, conditions_unmet: 1, conditions_empty: 1, unresolved: 0,
  materials: {
    dir: "inputs/",
    files: [
      { path: "inputs/办法.pdf", bytes: 5 }, { path: "inputs/办法.pdf.md", bytes: 4 }, { path: "inputs/办法.pdf.segments.json", bytes: 3 },
      { path: "inputs/说明.md", bytes: 2 },
      { path: "inputs/需求.docx", bytes: 9 }, { path: "inputs/需求.docx.md", bytes: 8 }, { path: "inputs/需求.docx.segments.json", bytes: 7 },
      { path: "inputs/旧需求.docx.txt", bytes: 1 }, { path: "inputs/没有本体.pdf.md", bytes: 1 },
    ],
    citations: [],
  },
  knowledge: [{ id: "general", name: "通用知识库", documents: [{ name: "规范.md", kind: "规范", bytes: 10, locator: "knowledge/general/规范.md" }] }],
  open_acts: [{ act_id: "A-1", function: "ask", summary: "要不要拆成两条" }],
};

test("给页面的 details：去掉 open_acts；材料清单里由 Word、PDF 材料生成的文件标出是由哪份生成的，本体不在的不算生成的；别的照原样", () => {
  const shown = taskStatusDisplayDetails(START_DETAILS)!;
  assert.ok(!("open_acts" in shown));
  assert.deepEqual(shown.materials.files.map((f: Dict) => [f.path, f.derived_from]), [
    ["inputs/办法.pdf", null], ["inputs/办法.pdf.md", "inputs/办法.pdf"], ["inputs/办法.pdf.segments.json", "inputs/办法.pdf"],
    ["inputs/说明.md", null],
    ["inputs/需求.docx", null], ["inputs/需求.docx.md", "inputs/需求.docx"], ["inputs/需求.docx.segments.json", "inputs/需求.docx"],
    ["inputs/旧需求.docx.txt", null], ["inputs/没有本体.pdf.md", null],
  ]);
  assert.deepEqual(shown.materials.files[0], { path: "inputs/办法.pdf", bytes: 5, derived_from: null }, "原有的项留着");
  const { open_acts: _a, materials: _m, ...rest } = START_DETAILS;
  const { materials: _n, ...shownRest } = shown;
  assert.deepEqual(shownRest, rest);
  assert.deepEqual([shown.materials.dir, shown.materials.citations], ["inputs/", []]);
  assert.ok("open_acts" in START_DETAILS, "传进去的那份没有被改动");
  assert.ok(!("derived_from" in START_DETAILS.materials.files[0]));
});

test("给页面的 details：不是对象时是 null；没有材料清单的（旧消息、缺项）照原样", () => {
  assert.equal(taskStatusDisplayDetails(null), null);
  assert.equal(taskStatusDisplayDetails("文字"), null);
  assert.deepEqual(taskStatusDisplayDetails({}), {});
  assert.deepEqual(taskStatusDisplayDetails({ kind: "变化", added: ["UC-002"], materials: { dir: "inputs/" } }), { kind: "变化", added: ["UC-002"], materials: { dir: "inputs/" } });
});

test("读回的与实时推送的系统说明都带 kind 为 task_status 与同一份 details", async () => {
  const raw = startMessage();
  const entries = [{ type: "custom_message", id: "n1", parentId: null, timestamp: "2026-09-28T01:00:00.000Z", customType: TASK_STATUS,
    content: raw, display: false, details: START_DETAILS }];
  const read = baseMessages(entries as any, SESSION).find((m) => m.type === "system_note")!;
  assert.equal(read.kind, "task_status");
  assert.deepEqual(read.details, taskStatusDisplayDetails(START_DETAILS));

  const hub = new Hub(workspace());
  const [sub] = hub.subscribe(null, null);
  const executor = new Executor("TASK-001", workspace(), workspace(), {}, hub);
  await (executor as any).handle({ note() {} }, { type: "system_note", custom_type: TASK_STATUS, text: raw, details: START_DETAILS, entry_id: "n1", session_id: SESSION });
  await (executor as any).handle({ note() {} }, { type: "system_note", custom_type: TASK_STATUS, text: raw, entry_id: "n2", session_id: SESSION });
  const pushed: Dict[] = [];
  for (let item = await sub.get(10); item; item = await sub.get(10)) if (item[0] === "system_note") pushed.push(item[2]);
  hub.close();
  assert.deepEqual(pushed.map((p) => [p.message_id, p.kind]), [["n1", "task_status"], ["n2", "task_status"]]);
  assert.deepEqual(pushed[0].details, read.details);
  assert.equal(pushed[1].details, null, "消息没有带 details 时是 null");
});
