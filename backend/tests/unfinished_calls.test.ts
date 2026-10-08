/**
 * 没有结果的工具调用（用户让助手停下时，工具还没开始、或没来得及把结果送回会话）不写成做完了：
 * 过程摘要与实时步骤行用同一个函数、同一种说法；保存修订与完成任务先按调用编号查任务库，写进去了照常写做完，
 * 查过没有写「没有做成」，没法查写「没有做完」；任何说法里都不出现 None。
 * 曾经的缺陷：被停下的保存修订在摘要里写成「写好并保存了修订 None：」。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Executor } from "../src/executor.ts";
import { Hub } from "../src/hub.ts";
import { callFacts } from "../src/library.ts";
import { type CallFacts, UNFINISHED_TEXT, worksFromEntries } from "../src/work_summary.ts";
import { captureConsole, makeWorkspace, tempDir } from "./helpers.ts";

// 本文件在测试进程里运行会写日志的后端代码，日志收进内存，不写标准输出（原因见 helpers.ts 的 captureConsole）。
captureConsole();

type Dict = Record<string, any>;
let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = makeWorkspace(tmp, "ws", true);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const ts = (s: number) => `2026-09-27T01:00:${String(s).padStart(2, "0")}.000Z`;
const userEntry = { type: "message", id: "u1", parentId: null, timestamp: ts(0), message: { role: "user", content: [{ type: "text", text: "请补一条异常流" }] } };
const call = (id: string, name: string, args: Dict = {}) => ({ type: "toolCall", id, name, arguments: args });
/** 一条被停下的助手消息：里面的工具调用都没有结果。 */
const aborted = (...calls: Dict[]) => ({ type: "message", id: "a1", parentId: "u1", timestamp: ts(5), message: { role: "assistant", stopReason: "aborted", content: calls } });
const stagesOf = (entries: Dict[], facts: CallFacts | null) => worksFromEntries(entries, {}, "（兜底）", () => "", facts)[0].stages.map((s: Dict) => s.text);
const nothing: CallFacts = { revision: () => null, completed: () => false };

test("被停下的保存修订：没法查写「没有做完」，查过没有写「没有做成」，查到了照常写保存了修订 N 与碰到的条目", () => {
  const entries = [userEntry, aborted(call("c-save", "save_revision", { operations: [] }))];
  assert.deepEqual(stagesOf(entries, null), [UNFINISHED_TEXT.save_revision_unchecked]);
  assert.deepEqual(stagesOf(entries, nothing), [UNFINISHED_TEXT.save_revision]);
  const found: CallFacts = { revision: (id) => (id === "c-save" ? { revision_no: 8, operations: [{ op: "add", item: "UC-001", collection: "功能用例" }] } : null), completed: () => false };
  assert.deepEqual(stagesOf(entries, found), ["写好并保存了修订 8：新增功能用例 1 个（UC-001）"]);
  assert.deepEqual([UNFINISHED_TEXT.save_revision_unchecked, UNFINISHED_TEXT.save_revision], ["保存修订没有做完", "保存修订没有做成"]);
});

test("没有结果的各种工具都不写成做完了，沿用各自「没有成」的说法；完成任务查到完成事件时照常写已完成；都没有 None", () => {
  const entries = [userEntry, aborted(
    call("c1", "read", { path: "inputs/材料.md" }), call("c2", "ls"), call("c3", "get_item", { item_id: "UC-002" }), call("c4", "get_task_status"),
    call("c5", "request_review"), call("c6", "complete_task"), call("c7", "reply", { text: "好" }), call("c8", "grep"),
    call("c9", "search_knowledge", { query: "罚款" }),
  )];
  const texts = stagesOf(entries, nothing);
  assert.deepEqual(texts, ["读材料《材料.md》没有读成", "看目录没有看成", "查看条目 UC-002 没有成", "查看任务状态没有成", "请评审者评审没有做成",
    "完成任务没有做成", "组织回复没有做成", "调用 grep 没有做成", "查找知识库没有成"]);
  assert.equal(stagesOf([userEntry, aborted(call("c6", "complete_task"))], null)[0], "完成任务没有做完");
  assert.equal(stagesOf([userEntry, aborted(call("c6", "complete_task"))], { ...nothing, completed: (id) => id === "c6" })[0], "把任务标为已完成");
  for (const text of texts) assert.doesNotMatch(text, /None/);
  // 由 Word 材料生成的文件写 Word 文件的本名；被停下的是看分段清单那一步时照「看」的说法。
  assert.deepEqual(stagesOf([userEntry, aborted(call("c1", "read", { path: "inputs/材料.docx.md" }), call("c2", "read", { path: "inputs/材料.docx.segments.json" }))], nothing),
    ["读材料《材料.docx》没有读成", "看材料《材料.docx》的分段清单没有看成"]);
});

test("callFacts 从任务库按调用编号查出修订号与碰到的条目；查不到、库不在时为空", () => {
  const facts = callFacts(ws);
  assert.deepEqual(facts.revision("call-r1"), { revision_no: 1, operations: [
    { op: "add", item: "UC-001", collection: "用例", from_revision: null, to_revision: 1 },
    { op: "add", item: "TBD-001", collection: "待定事项", from_revision: null, to_revision: 1 }] });
  assert.equal(facts.revision("没有这个调用"), null);
  assert.equal(facts.completed("call-r1"), false);
  const empty = join(tmp, "empty");
  mkdirSync(empty, { recursive: true });
  assert.equal(callFacts(empty).revision("call-r1"), null);
});

/** 假的 pi：get_entries 回给定的条目，get_state 回空闲。 */
function fakePi(entries: Dict[]) {
  return {
    alive: () => true,
    note() {},
    async request(command: string) {
      if (command === "get_entries") return { entries };
      if (command === "get_state") return { isCompacting: false, sessionName: "有名字" };
      return {};
    },
    async getState() {
      return this.request("get_state");
    },
  };
}

test("实时步骤行与过程摘要对同一次没有结果的调用说法相同：被停下的消息里的保存修订补成一步；查到修订时两处都写保存了修订", async () => {
  for (const [callId, expected] of [["c-new", "保存修订没有做成"], ["call-r2", null]] as const) {
    const assistant = aborted(call(callId, "save_revision", { operations: [] }));
    const entries = [userEntry, assistant];
    const hub = new Hub(ws);
    const executor = new Executor("TASK-001", ws, join(tmp, "runs"), {}, hub);
    const pi = fakePi(entries);
    executor.pi = pi as any;
    executor.activeSession = "S1";
    const [sub] = hub.subscribe(null, null);
    for (const e of [{ type: "agent_start" }, { type: "turn_start" }, { type: "message_end", message: assistant.message }, { type: "turn_end" }]) {
      await (executor as any).handle(pi, e);
    }
    const steps: Dict[] = [];
    for (let item = await sub.get(10); item; item = await sub.get(10)) if (item[0] === "step") steps.push(item[2]);
    const live = steps.at(-1)!.text;
    const summary = stagesOf(entries, callFacts(ws));
    assert.deepEqual([live], summary);
    if (expected) assert.equal(live, expected);
    else assert.match(live, /^写好并保存了修订 2：/);
    assert.doesNotMatch(live, /None/);
    hub.close();
  }
});
