/**
 * 过程摘要的「理解为」一行：从任务库的 USER_INTENT_RECORDED、USER_INTENT_INVALID、USER_INTENT_MISSING 与
 * STRUCTURED_OUTPUT_UNMATCHED 事件拼出来（work_summary.ts 的 understandingLines 与 understandingText）。
 * 几种情形各一例：有理解（摘要按记录顺序用「；」连，把握取最低一档，高时不括注）、还没有理解时的三种说法、界面合成的那句话；
 * 另有刷新后的对话记录与实时推送的步骤行各一例。库是测试自己建的最小库，只有这里读到的两张表。
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { messages } from "../src/conversation.ts";
import { Executor } from "../src/executor.ts";
import { Hub } from "../src/hub.ts";
import { INTENT_SCHEMA_PATH } from "../src/paths.ts";
import { functionNames, understandingLines, understandingText } from "../src/work_summary.ts";
import { captureConsole, tempDir } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
const SESSION = "S";
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let made = 0;

/** 建一个只有事件表与对话行为表的任务库。events 每项是 [事件名, 内容]，acts 每项是 [行为编号, 把握]。 */
function taskDir(events: [string, Dict][], acts: [string, string][] = []): string {
  const dir = join(tmp, `task-${++made}`);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, DB_NAME));
  try {
    db.exec("CREATE TABLE event (seq INTEGER PRIMARY KEY, session_id TEXT, name TEXT, payload TEXT)");
    db.exec("CREATE TABLE dialogue_act (session_id TEXT, act_id TEXT, confidence TEXT)");
    events.forEach(([name, payload], i) => db.prepare("INSERT INTO event VALUES (?, ?, ?, ?)").run(i + 1, SESSION, name, JSON.stringify(payload)));
    for (const [actId, confidence] of acts) db.prepare("INSERT INTO dialogue_act VALUES (?, ?, ?)").run(SESSION, actId, confidence);
  } finally {
    db.close();
  }
  return dir;
}

const recorded = (entry: string, acts: Dict[], origin = "understanding"): [string, Dict] =>
  ["USER_INTENT_RECORDED", { run_id: "r1", user_entry: entry, origin, acts }];
const invalid = (entry: string): [string, Dict] =>
  ["USER_INTENT_INVALID", { run_id: "r1", user_entry: entry, reason: "acts[0].targets 里的 UC-009 在这个任务里没有" }];
const missing = (entry: string): [string, Dict] =>
  ["USER_INTENT_MISSING", { run_id: "r1", user_entry: entry, reason: "这一轮结束时没有合格的理解", nearest: [] }];
const unmatched = (entry: string): [string, Dict] =>
  ["STRUCTURED_OUTPUT_UNMATCHED", { run_id: "r1", user_entry: entry, fragments: [{ nature: "unparseable", text: "{" }] }];

test("有理解：摘要按记录顺序用「；」连，把握取最低一档，高时不括注；事件里没有把握时到对话行为表里按编号查", () => {
  const dir = taskDir([
    recorded("u-1", [
      { act_id: "r1-1", function: "affirm", summary: "UC-001、UC-002 的当前修订", confidence: "high" },
      { act_id: "r1-2", function: "correct", summary: "UC-003 参与者改为借还台管理员", confidence: "high" },
      { act_id: "r1-3", function: "inform", summary: "寒暑假借期先不管", confidence: "medium" },
    ]),
    recorded("u-2", [{ act_id: "r2-1", function: "request", summary: "把材料整理成条目", confidence: "high" }]),
    recorded("u-3", [{ act_id: "r3-1", function: "question", summary: "材料里写了保留几天吗" }]),
  ], [["r3-1", "low"]]);
  const lines = understandingLines(dir, SESSION);
  assert.equal(lines.get("u-1"), "理解为：同意（affirm）UC-001、UC-002 的当前修订；纠正（correct）UC-003 参与者改为借还台管理员；告知（inform）寒暑假借期先不管（把握中）");
  assert.equal(lines.get("u-2"), "理解为：请求（request）把材料整理成条目");
  assert.equal(lines.get("u-3"), "理解为：询问（question）材料里写了保留几天吗（把握低）");
  // 九种功能的中文名取自理解格式的 schema，这里不另写一份
  const schema = JSON.parse(readFileSync(INTENT_SCHEMA_PATH, "utf-8"));
  assert.deepEqual(functionNames(), schema["$defs"]["user_function"]["x-names"]);
  assert.deepEqual(Object.values(functionNames()), ["告知", "请求", "同意", "否定", "纠正", "要求换一个", "无关", "要澄清", "询问"]);
  // 事件内容里没有功能（早先的库）时只写摘要
  assert.equal(understandingText([{ summary: "整理材料", confidence: "high" }]), "理解为：整理材料");
});

test("还没有理解时的三种说法，几种都有时取排在前面的；之后写对了就换成理解，先有理解后面又有没匹配上的片段时仍写理解", () => {
  const other = { act_id: "r2-1", function: "other", summary: "寒暄", confidence: "high" };
  const dir = taskDir([
    invalid("u-1"),
    unmatched("u-2"), recorded("u-2", [other]),
    unmatched("u-3"),
    unmatched("u-4"), invalid("u-4"), missing("u-4"),
    recorded("u-5", [other]), unmatched("u-5"),
    // 几种说法按先后取排在前面的（没有写下 > 对不上 > 正在重写），与记下的先后无关
    missing("u-6"), unmatched("u-6"),
  ]);
  const lines = understandingLines(dir, SESSION);
  assert.equal(lines.get("u-1"), "助手的理解里有对不上的地方，正在重写");
  assert.equal(lines.get("u-2"), "理解为：无关（other）寒暄");
  assert.equal(lines.get("u-3"), "助手的理解正在重写");
  assert.equal(lines.get("u-4"), "助手这一轮没有写下理解");
  assert.equal(lines.get("u-5"), "理解为：无关（other）寒暄");
  assert.equal(lines.get("u-6"), "助手这一轮没有写下理解");
});

test("界面合成的那句话不显示这一行；没有库时什么都没有", () => {
  const dir = taskDir([recorded("u-1", [{ act_id: "r1-1", summary: "在卡片上选了「允许」", confidence: "high" }], "ui")]);
  const lines = understandingLines(dir, SESSION);
  assert.ok(lines.has("u-1"));
  assert.equal(lines.get("u-1"), null);
  assert.equal(understandingLines(join(tmp, "没有这个目录"), SESSION).size, 0);
  assert.equal(understandingLines(null, SESSION).size, 0);
});

test("刷新后的对话记录里过程摘要带理解；理解那一行不算一步；不给任务目录时没有理解", () => {
  const dir = taskDir([recorded("u-1", [{ act_id: "r1-1", function: "request", summary: "把材料整理成条目", confidence: "high" }])]);
  const entries = [
    { type: "message", id: "u-1", parentId: null, timestamp: "2026-09-24T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "整理一下" }] } },
    { type: "message", id: "a-1", parentId: "u-1", timestamp: "2026-09-24T10:00:05.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c-1", name: "reply", arguments: { informs: [], act: null, text: "好的。" } }] } },
    { type: "message", id: "t-1", parentId: "a-1", timestamp: "2026-09-24T10:00:06.000Z",
      message: { role: "toolResult", toolCallId: "c-1", toolName: "reply", content: [], details: {} } },
  ];
  const summary = messages(entries as any, SESSION, {}, dir).find((m) => m.type === "work_summary")!;
  assert.equal(summary.understanding, "理解为：请求（request）把材料整理成条目");
  assert.equal(summary.step_count, 1, "理解那一行不算一步");
  const without = messages(entries as any, SESSION, {}).find((m) => m.type === "work_summary")!;
  assert.equal(without.understanding, null);
});

test("实时推送：助手消息落进会话时推一行理解，排在步骤最前；写对了用同一个键换掉；没有变化时不重复推", async () => {
  const dir = taskDir([invalid("u-1")]);
  const hub = new Hub(dir);
  const [sub] = hub.subscribe(null, null);
  const executor = new Executor("T", dir, dir, {}, hub);
  (executor as any).work = { work_id: "w-u-1", last_user_id: "u-1", triggered_by: "u-1",
    steps: new Map([["w-u-1-0", { step_key: "w-u-1-0", text: "读了材料" }]]) };
  const steps = async () => {
    const out: Dict[] = [];
    for (let item = await sub.get(10); item; item = await sub.get(10)) if (item[0] === "step") out.push(item[2]);
    return out;
  };
  try {
    (executor as any).understandingStep(SESSION);
    const first = (await steps()).at(-1)!;
    assert.deepEqual([first.step_key, first.text, first.in_progress], ["w-u-1-intent", "助手的理解里有对不上的地方，正在重写", true]);
    assert.deepEqual([...(executor as any).work.steps.keys()], ["w-u-1-intent", "w-u-1-0"]);
    const db = new DatabaseSync(join(dir, DB_NAME));
    db.prepare("INSERT INTO event VALUES (2, ?, 'USER_INTENT_RECORDED', ?)").run(SESSION, JSON.stringify({ user_entry: "u-1", origin: "understanding",
      acts: [{ act_id: "r1-1", function: "request", summary: "整理材料", confidence: "high" }] }));
    db.close();
    (executor as any).understandingStep(SESSION);
    (executor as any).understandingStep(SESSION);
    const later = await steps();
    assert.equal(later.length, 1, "写对了推一次，没有变化时不重复推");
    assert.deepEqual([later[0].step_key, later[0].text, later[0].in_progress], ["w-u-1-intent", "理解为：请求（request）整理材料", false]);
  } finally {
    hub.close();
  }
});
