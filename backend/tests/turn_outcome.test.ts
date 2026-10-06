/**
 * 一轮工作怎样结束（结束原因 outcome）：有回复（replied）、没有回复（no_reply）、被用户停下（stopped_by_user）、出错停下（failed）、
 * 助手连续被拒到上限由工具停下（stopped_by_limit）。
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
import { Executor, FAILED_TEXT, LIMIT_STOPPED_TEXT, NO_REPLY_TEXT } from "../src/executor.ts";
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

/** 「先写理解」那道门拒绝时的文字，与连续被拒到上限、由工具停下时那一条结果的文字和 details。 */
const MISSING = "回复没有执行：先按 schema 写下你对用户这句话的理解。这一轮还没有写理解。\n请按平台 skill「先写理解」一节的格式……";
const STOPPED = { stopped: true, rejections: 5, reason_kind: "understanding_missing" };
const refused = (callId: string, details?: Dict) => ({ ...result(callId, details ? `${MISSING}\n这一轮已经连续 5 次没有按规矩回答，这次运行到此停下。` : MISSING, true),
  message: { ...result(callId, MISSING, true).message, toolCallId: callId, ...(details ? { details } : {}) } });
/** 一轮里回复连着被拒 n 次，最后一次是带 stopped 标记的结果；每次助手都只调用回复，不带正文。 */
const refusedTurn = (n: number, tool = "reply") => Array.from({ length: n }, (_, i) => [
  assistant("toolUse", call(`x${i + 1}`, tool, { text: "好的。" })), refused(`x${i + 1}`, i === n - 1 ? STOPPED : undefined)]).flat();

test("连续被拒到上限、由工具停下：结束原因是 stopped_by_limit；被拒的各步按真实原因写，最后一步写已经停下；下一轮正常做完各算各的", () => {
  const stopped = works([user(), ...refusedTurn(5)]);
  assert.equal(stopped.length, 1);
  assert.deepEqual([stopped[0].outcome, stopped[0].step_count], ["stopped_by_limit", 5]);
  const texts = stopped[0].stages.map((s: Dict) => s.text);
  assert.ok(texts.includes("助手还没有写下对这句话的理解，正在补"), JSON.stringify(texts));
  assert.equal(texts.at(-1), "助手这一轮没有按规矩回答，已经停下");
  assert.ok(!texts.includes("回复的形式不对，助手正在改"));
  // 保存修订因为没有合格的理解连着被拒到上限，同样算。
  assert.deepEqual(outcomes([user(), ...refusedTurn(5, "save_revision")]), ["stopped_by_limit"]);
  // 被拒几次之后补上了、回复送达：照常是 replied。
  assert.deepEqual(outcomes([user(), ...refusedTurn(4).slice(0, 6), assistant("toolUse", call("r1", "reply", { text: "好" })), result("r1", "回复已送达"), assistant("stop")]), ["replied"]);
  // 停下之后用户再说一句，那一轮正常做完。
  assert.deepEqual(outcomes([user("第一句"), ...refusedTurn(5), user("第二句"), assistant("toolUse", call("r2", "reply", { text: "好" })), result("r2", "回复已送达"), assistant("stop")]),
    ["stopped_by_limit", "replied"]);
});

test("连续被拒到上限的实时推送：提示是「一直没有按规矩回答，已经停下」，不另发没有回复或出错的提示；这一轮的助手正文不当成回复转发", async () => {
  const given = [user(), ...refusedTurn(5)];
  // 最后一条助手消息带着一段正文（没写合格的那份理解）：停下时不把它当成回复发给用户。
  (given[given.length - 2].message.content as Dict[]).unshift({ type: "text", text: '{"acts": "不合格"}' });
  const entries = given.map((e, i) => ({ ...e, parentId: i ? given[i - 1].id : null }));
  const hub = new Hub(ws);
  const executor = new Executor("TASK-001", ws, join(tmp, "runs-limit"), {}, hub);
  const pi = fakePi(entries);
  executor.pi = pi as any;
  executor.activeSession = "S1";
  const [sub] = hub.subscribe(null, null);
  await (executor as any).handle(pi, { type: "agent_start" });
  Object.assign((executor as any).work, { last_user_id: entries[0].id, replied_since_user: false });
  for (const e of entries.slice(1)) {
    const m = e.message as Dict;
    if (m.role === "assistant") {
      // 一轮的事件照 pi 的先后：这一轮开始、助手消息结束、工具开始、工具结束、这一轮结束。
      await (executor as any).handle(pi, { type: "turn_start" });
      await (executor as any).handle(pi, { type: "message_end", message: m });
      for (const part of m.content) if (part.type === "toolCall") await (executor as any).handle(pi, { type: "tool_execution_start", toolName: part.name, toolCallId: part.id, args: part.arguments });
    } else if (m.role === "toolResult") {
      await (executor as any).handle(pi, { type: "tool_execution_end", toolName: "reply", toolCallId: m.toolCallId, isError: m.isError, result: { content: m.content, details: m.details ?? {} } });
      await (executor as any).handle(pi, { type: "turn_end" });
    }
  }
  await (executor as any).handle(pi, { type: "agent_settled" });
  const events: Dict[] = [];
  for (let item = await sub.get(10); item; item = await sub.get(10)) events.push({ name: item[0], ...item[2] });
  hub.close();
  assert.deepEqual(events.filter((e) => e.name === "problem").map((e) => [e.code, e.text]), [["stopped_by_limit", LIMIT_STOPPED_TEXT]]);
  assert.equal(LIMIT_STOPPED_TEXT, "助手这一轮一直没有按规矩回答，已经停下。你可以再说一句，让它重新来。");
  assert.deepEqual(events.filter((e) => e.name === "assistant_reply"), []);
  assert.equal(events.find((e) => e.name === "work_ended")?.outcome, "stopped_by_limit");
  assert.equal(events.find((e) => e.name === "work_summary")?.outcome, "stopped_by_limit");
  // 实时的每一步：前四次说正在补，最后一次说已经停下。
  const steps = events.filter((e) => e.name === "step" && !e.in_progress).map((e) => e.text);
  assert.deepEqual([...new Set(steps)], ["助手还没有写下对这句话的理解，正在补", "助手这一轮没有按规矩回答，已经停下"]);
  assert.equal(steps.at(-1), "助手这一轮没有按规矩回答，已经停下");
});
