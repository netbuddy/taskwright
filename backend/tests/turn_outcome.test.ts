/**
 * 一轮工作怎样结束（结束原因 outcome）：有回复（replied）、没有回复（no_reply）、被用户停下（stopped_by_user）、出错停下（failed）。
 * 从会话记录重算的过程摘要与实时推送的摘要用同一个函数（worksFromEntries）算出结束原因，刷新前后说法一致；
 * 按这一轮最后一条助手消息的结束方式判断：pi 把被停下的消息记为 aborted、出错的记为 error，自动重试成功时出错的那条仍留在会话里，不算出错。
 * 出错或被停下的一轮即使没有调用工具、也没有回复，也保留在摘要里（曾经的缺陷：出错的一轮刷新之后整轮消失）。
 * 出错停下时右上角的提示与「没有回复」分开；被停下时不提示。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { withWorkSummaries } from "../src/conversation.ts";
import { Executor, FAILED_TEXT, NO_REPLY_TEXT } from "../src/executor.ts";
import { Hub } from "../src/hub.ts";
import { callFacts } from "../src/library.ts";
import { worksFromEntries } from "../src/work_summary.ts";
import { captureConsole, makeWorkspace, tempDir } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = makeWorkspace(tmp, "ws", true);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const ts = (s: number) => `2026-09-28T01:00:${String(s).padStart(2, "0")}.000Z`;
let n = 0;
const id = () => `e${++n}`;
const user = (text = "请整理材料") => ({ type: "message", id: id(), timestamp: ts(0), message: { role: "user", content: [{ type: "text", text }] } });
const call = (callId: string, name: string, args: Dict = {}) => ({ type: "toolCall", id: callId, name, arguments: args });
const assistant = (stopReason: string, ...calls: Dict[]) =>
  ({ type: "message", id: id(), timestamp: ts(5), message: { role: "assistant", stopReason, content: calls, ...(stopReason === "error" ? { errorMessage: "400 bad request" } : {}) } });
const result = (callId: string, text = "已保存", isError = false) =>
  ({ type: "message", id: id(), timestamp: ts(6), message: { role: "toolResult", toolCallId: callId, content: [{ type: "text", text }], isError } });
const works = (entries: Dict[]) => worksFromEntries(entries, {}, "（兜底）", () => "", null);
const outcomes = (entries: Dict[]) => works(entries).map((w) => w.outcome);

test("被停下：保存过一次、两次修订，或者一次也没保存；没有调用工具也保留这一轮", () => {
  assert.deepEqual(outcomes([user(), assistant("toolUse", call("s1", "save_revision")), result("s1"), assistant("aborted")]), ["stopped_by_user"]);
  assert.deepEqual(outcomes([user(), assistant("toolUse", call("s1", "save_revision")), result("s1"),
    assistant("toolUse", call("s2", "save_revision")), result("s2"), assistant("aborted")]), ["stopped_by_user"]);
  const nothing = works([user(), assistant("aborted")]);
  assert.equal(nothing.length, 1);
  assert.deepEqual([nothing[0].outcome, nothing[0].step_count], ["stopped_by_user", 0]);
  // 工具执行中被停下：pi 给工具回「Operation aborted」，接着的那次模型调用也记为 aborted
  assert.deepEqual(outcomes([user(), assistant("toolUse", call("s1", "save_revision")), result("s1", "Operation aborted", true), assistant("aborted")]), ["stopped_by_user"]);
});

test("出错停下：没有调用工具、没有回复也保留这一轮；保存过修订之后出错也算出错", () => {
  const bare = works([user(), assistant("error")]);
  assert.equal(bare.length, 1);
  assert.deepEqual([bare[0].outcome, bare[0].step_count], ["failed", 0]);
  assert.deepEqual(outcomes([user(), assistant("toolUse", call("s1", "save_revision")), result("s1"), assistant("error")]), ["failed"]);
});

test("正常做完是 replied，没有回复是 no_reply；中途出错、自动重试成功的一轮不算出错", () => {
  assert.deepEqual(outcomes([user(), assistant("toolUse", call("r1", "reply", { text: "好" })), result("r1", "回复已送达"), assistant("stop")]), ["replied"]);
  assert.deepEqual(outcomes([user(), assistant("toolUse", call("s1", "save_revision")), result("s1"), assistant("stop")]), ["no_reply"]);
  assert.deepEqual(outcomes([user(), assistant("error"), assistant("toolUse", call("r1", "reply", { text: "好" })), result("r1", "回复已送达"), assistant("stop")]), ["replied"]);
  // 什么也没做、也没有出错或被停下的一段照旧不算一次工作
  assert.deepEqual(outcomes([user(), assistant("stop")]), []);
});

test("几轮各算各的：前一轮被停下，后一轮正常做完", () => {
  assert.deepEqual(outcomes([user("第一句"), assistant("toolUse", call("s1", "save_revision")), result("s1"), assistant("aborted"),
    user("第二句"), assistant("toolUse", call("r1", "reply", { text: "好" })), result("r1", "回复已送达"), assistant("stop")]), ["stopped_by_user", "replied"]);
});

test("刷新后的对话记录：摘要带结束原因；出错的那一轮刷新后仍有摘要，放在下一句用户的话之前", () => {
  const u1 = user("第一句");
  const u2 = user("第二句");
  const path = [u1, assistant("error"), u2, assistant("aborted")];
  const out: Dict[] = [{ type: "user_message", message_id: u1.id }, { type: "user_message", message_id: u2.id }];
  const msgs = withWorkSummaries(out, path as any, "S1", {});
  assert.deepEqual(msgs.map((m) => [m.type, m.outcome ?? null]),
    [["user_message", null], ["work_summary", "failed"], ["user_message", null], ["work_summary", "stopped_by_user"]]);
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

/** 让执行者走完一轮：开始、每条助手消息结束、安定；收集推给页面的事件。stop 为真时照「用户让停」标记这一轮。 */
async function runTurn(given: Dict[], stop = false): Promise<Dict[]> {
  // 会话条目按 parentId 连成一条分支（conversation.branch 顺着它找当前分支）
  const entries = given.map((e, i) => ({ ...e, parentId: i ? given[i - 1].id : null }));
  const hub = new Hub(ws);
  const executor = new Executor("TASK-001", ws, join(tmp, "runs"), {}, hub);
  const pi = fakePi(entries);
  executor.pi = pi as any;
  executor.activeSession = "S1";
  const [sub] = hub.subscribe(null, null);
  await (executor as any).handle(pi, { type: "agent_start" });
  Object.assign((executor as any).work, { last_user_id: entries[0].id, replied_since_user: false });
  if (stop) (executor as any).work.stopped = true;
  for (const e of entries.slice(1)) {
    if (e.message.role === "assistant") await (executor as any).handle(pi, { type: "message_end", message: e.message });
    // 回复工具送达：实际由 tool_execution_end 记下，这里只记下它留给本轮的两件事实
    if (e.message.role === "toolResult" && e.message.content[0].text === "回复已送达") Object.assign((executor as any).work, { replied: true, replied_since_user: true });
  }
  await (executor as any).handle(pi, { type: "agent_settled" });
  const events: Dict[] = [];
  for (let item = await sub.get(10); item; item = await sub.get(10)) events.push({ name: item[0], ...item[2] });
  hub.close();
  return events;
}

test("实时推送：摘要与工作结束事件的结束原因和刷新后重算的相同；出错与没有回复的提示分开，被停下时不提示", async () => {
  const cases: [Dict[], boolean, string, string | null][] = [
    [[user(), assistant("toolUse", call("s1", "save_revision")), result("s1"), assistant("aborted")], true, "stopped_by_user", null],
    [[user(), assistant("aborted")], true, "stopped_by_user", null],
    [[user(), assistant("error")], false, "failed", FAILED_TEXT],
    [[user(), assistant("toolUse", call("s1", "save_revision")), result("s1"), assistant("error")], false, "failed", FAILED_TEXT],
    [[user(), assistant("error"), assistant("toolUse", call("r1", "reply", { text: "好" })), result("r1", "回复已送达"), assistant("stop")], false, "replied", null],
    [[user(), assistant("toolUse", call("s1", "save_revision")), result("s1"), assistant("stop")], false, "no_reply", NO_REPLY_TEXT],
  ];
  for (const [entries, stop, expected, problem] of cases) {
    const events = await runTurn(entries, stop);
    const summary = events.find((e) => e.name === "work_summary");
    const ended = events.find((e) => e.name === "work_ended");
    const recomputed = worksFromEntries(entries, {}, "（兜底）", () => "", callFacts(ws))[0];
    assert.equal(recomputed.outcome, expected);
    assert.equal(summary?.outcome, expected, `实时摘要：${expected}`);
    assert.equal(ended?.outcome, expected, `工作结束事件：${expected}`);
    assert.deepEqual(events.filter((e) => e.name === "problem").map((e) => e.text), problem ? [problem] : []);
  }
  assert.equal(FAILED_TEXT, "助手这一轮因为出错停下了，你可以再说一句，让它接着做。");
  assert.equal(NO_REPLY_TEXT, "助手这次没有说话就停下了，你可以再问它一句。");
});

test("被停下时结束消息的步数与摘要相同：一条消息里几个调用执行到一半被停下，没有开始的调用也算步数，没有执行的保存修订写「没有做成」", async () => {
  // 第一个调用做完了，停在第二个上（pi 给它回「Operation aborted」），第三个没有开始、会话记录里没有结果
  const entries = [user(), assistant("toolUse", call("m1", "save_revision"), call("m2", "save_revision"), call("m3", "save_revision")),
    result("m1"), result("m2", "Operation aborted", true), assistant("aborted")];
  const events = await runTurn(entries, true);
  const summary = events.find((e) => e.name === "work_summary")!;
  const ended = events.find((e) => e.name === "work_ended")!;
  assert.equal(summary.step_count, 3);
  assert.equal(ended.step_count, summary.step_count);
  assert.match(summary.stages.map((s: Dict) => s.text ?? JSON.stringify(s)).join("；"), /保存修订没有做成/);
});
