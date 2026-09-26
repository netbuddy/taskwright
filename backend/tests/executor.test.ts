/**
 * 执行者看护的事件翻译：用一个假的 pi（只回几条命令）把一串 pi 事件喂给看护，看它推出的过程与对话类事件。
 * 覆盖：用户的话（条目编号、client_id、工作编号改用那句话的条目编号、会话自动起名）、步骤行的实时生成与一轮结束时的更正、
 * 「回复」工具的回复、兜底转发正文、什么都没说时的 problem、模型服务不可用、任务现状与兜底句两种系统说明、保存修订被拒的原因、
 * 工作结束时的过程摘要与 work_ended；以及事件分发的会话过滤、补发与 resync、经 HTTP 的事件流写法。
 * 对应服务端 Python 版 executor.py 与 hub.py 的各分支（Python 版这部分由集成测试覆盖，这里拆成单元测试）。
 */

import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Executor } from "../src/executor.ts";
import { makeServer } from "../src/http.ts";
import { Hub, hubSettings } from "../src/hub.ts";
import { Service } from "../src/service.ts";
import { makeWorkspace, tempDir } from "./helpers.ts";

let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = makeWorkspace(tmp, "ws", true);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

type Dict = Record<string, any>;

/** 假的 pi：get_entries 回给定的条目，get_state 回空闲，其余命令记下来。 */
function fakePi(entries: Dict[]) {
  const calls: [string, Dict][] = [];
  return {
    calls,
    entries,
    notes: [] as Dict[],
    alive: () => true,
    note(kind: string, fields: Dict) {
      this.notes.push({ 记录: kind, ...fields });
    },
    async request(command: string, fields: Dict = {}) {
      calls.push([command, fields]);
      if (command === "get_entries") return { entries: fields.since ? entries.slice(entries.findIndex((e) => e.id === fields.since) + 1) : entries };
      if (command === "get_state") return { isCompacting: false, sessionName: null };
      return {};
    },
    async getState() {
      return this.request("get_state");
    },
  };
}

function setup(entries: Dict[]) {
  const hub = new Hub(ws);
  const executor = new Executor("TASK-001", ws, join(tmp, "runs"), {}, hub);
  const pi = fakePi(entries);
  executor.pi = pi as any;
  executor.activeSession = "S1";
  const [sub] = hub.subscribe(null, null);
  const feed = async (...events: Dict[]) => {
    for (const e of events) await (executor as any).handle(pi, e);
  };
  const drain = async () => {
    const out: [string, Dict][] = [];
    for (let item = await sub.get(10); item; item = await sub.get(10)) out.push([item[0], item[2]]);
    return out;
  };
  return { hub, executor, pi, feed, drain };
}

const ts = (s: number) => `2026-09-22T01:00:${String(s).padStart(2, "0")}.000Z`;
const user = (id: string, parentId: string | null, text: string, s = 0) => ({ type: "message", id, parentId, timestamp: ts(s), message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id: string, parentId: string, content: unknown[], s = 1) => ({ type: "message", id, parentId, timestamp: ts(s), message: { role: "assistant", content } });
const result = (id: string, parentId: string, callId: string, isError = false, details: Dict = {}, s = 2) =>
  ({ type: "message", id, parentId, timestamp: ts(s), message: { role: "toolResult", toolCallId: callId, isError, details } });

test("一次说话：用户的话、步骤行、回复、过程摘要与 work_ended", async () => {
  const entries = [
    user("u1", null, "整理一下"),
    assistant("a1", "u1", [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/w/inputs/材料.md" } }]), result("r1", "a1", "c1"),
    assistant("a2", "r1", [{ type: "toolCall", id: "c2", name: "reply", arguments: { text: "好" } }], 3), result("r2", "a2", "c2", false, {}, 4),
  ];
  const { executor, pi, feed, drain } = setup(entries);
  (executor as any).pendingClients.push(["整理一下", "c-1"]);
  await feed({ type: "agent_start" }, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "整理一下" }] } });
  let got = await drain();
  assert.deepEqual(got.map(([n]) => n), ["executor_state", "user_message", "work_started"]);
  assert.equal(got[0][1].state, "working");
  assert.deepEqual([got[1][1].message_id, got[1][1].client_id, got[1][1].origin, got[1][1].text], ["u1", "c-1", "typed", "整理一下"]);
  assert.deepEqual([got[2][1].work_id, got[2][1].triggered_by], ["w-u1", "u1"], "工作编号改用触发它的那句话的条目编号");
  assert.deepEqual(pi.calls.find(([c]) => c === "set_session_name"), ["set_session_name", { name: "整理一下" }], "会话按第一句话起名");

  await feed({ type: "本轮事实", 内容: { turnIndex: 0 } }, { type: "turn_start" },
    { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "/w/inputs/材料.md" } },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false, result: {} }, { type: "turn_end" });
  got = await drain();
  assert.deepEqual(got.map(([, d]) => [d.step_key, d.text, d.in_progress]), [["w-u1-0", "正在读材料《材料.md》", true], ["w-u1-0", "读了材料《材料.md》", false]]);

  await feed({ type: "本轮事实", 内容: { turnIndex: 1 } }, { type: "turn_start" },
    { type: "tool_execution_start", toolCallId: "c2", toolName: "reply", args: {} },
    { type: "tool_execution_end", toolCallId: "c2", toolName: "reply", isError: false, result: { details: { message_id: "a2", reply: { text: "好", informs: ["一"], act: null } } } },
    { type: "turn_end" }, { type: "agent_settled" });
  got = await drain();
  assert.deepEqual(got.map(([n]) => n), ["step", "assistant_reply", "step", "work_summary", "work_ended", "executor_state"]);
  const reply = got[1][1];
  assert.deepEqual([reply.message_id, reply.work_id, reply.via_reply_tool, reply.informs, reply.text, reply.degraded], ["a2", "w-u1", true, [{ text: "一" }], "好", false]);
  const summary = got[3][1];
  assert.deepEqual([summary.work_id, summary.step_count, summary.seconds, summary.stages.map((s: Dict) => s.text)], ["w-u1", 2, 4, ["读了材料《材料.md》", "组织并发出了回复"]]);
  assert.deepEqual([got[4][1].outcome, got[4][1].step_count], ["replied", 2]);
  assert.equal(got[5][1].state, "idle");
  assert.equal(executor.work, null);
});

test("兜底：没有经回复工具说话时转发最后一段正文；正文也没有时发 problem", async () => {
  // 会话条目随运行逐步写进会话：用户的话先在，助手的正文后到。
  const entries: Dict[] = [user("u1", null, "你说")];
  let { feed, drain } = setup(entries);
  await feed({ type: "agent_start" }, { type: "message_end", message: { role: "user", content: "你说" } });
  entries.push(assistant("a1", "u1", [{ type: "text", text: "直接说的话" }]));
  await feed({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: " 直接说的话 " }] } }, { type: "agent_settled" });
  let got = await drain();
  const reply = got.find(([n]) => n === "assistant_reply")![1];
  assert.deepEqual([reply.via_reply_tool, reply.text, reply.message_id, reply.act], [false, "直接说的话", "a1", null]);
  assert.equal(got.find(([n]) => n === "work_ended")![1].outcome, "no_reply");

  ({ feed, drain } = setup([user("u1", null, "你说")]));
  await feed({ type: "agent_start" }, { type: "message_end", message: { role: "user", content: "你说" } }, { type: "agent_settled" });
  got = await drain();
  assert.deepEqual(got.find(([n]) => n === "problem")![1], { session_id: "S1", code: "no_reply", text: "助手这次没有说话就停下了，你可以再问它一句。", retry: null });
});

test("系统说明、模型服务不可用、保存修订被拒的原因、模型出错时 outcome 为 failed", async () => {
  const entries: Dict[] = [user("u1", null, "整理")];
  const { feed, drain } = setup(entries);
  await feed({ type: "system_note", custom_type: "taskwright-task-status", text: "任务现状", entry_id: "e1", session_id: "S1" },
    { type: "system_note", custom_type: "taskwright-user-edit", text: "不算" });
  let got = await drain();
  assert.deepEqual(got.map(([n, d]) => [n, d.message_id, d.text]), [["system_note", "e1", "任务现状"]]);
  await feed({ type: "agent_start" }, { type: "message_end", message: { role: "user", content: "整理" } });
  entries.push(user("f1", "u1", "请用 reply 工具把要对用户说的话发出来"));
  await feed({ type: "message_end", message: { role: "user", content: "请用 reply 工具把要对用户说的话发出来" } },
    { type: "auto_retry_start", attempt: 2, delayMs: 2000 },
    { type: "tool_execution_start", toolCallId: "c1", toolName: "save_revision", args: {} },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "save_revision", isError: true, result: { content: [{ type: "text",
      text: "这次「保存修订」什么都没有写入，因为有 1 个操作不对：\n- 操作 1（新增）：摘录找不到。\n  怎么办：照抄原文\n请把这些地方改正之后再提交。" }] } },
    { type: "turn_end" }, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } }, { type: "agent_settled" });
  got = await drain();
  const fallback = got.find(([n, d]) => n === "system_note" && d.message_id === "f1")!;
  assert.match(fallback[1].text, /系统自动提醒了它一句：「请用 reply 工具把要对用户说的话发出来」。这句不是你说的。/);
  assert.equal(got.filter(([n]) => n === "user_message").length, 1, "兜底句不算用户的话");
  assert.deepEqual(got.find(([n]) => n === "problem")![1], { session_id: "S1", code: "model_unavailable", text: "模型服务暂时不可用，正在第 2 次重试。", retry: { attempt: 2, delay_ms: 2000 } });
  const steps = got.filter(([n]) => n === "step").map(([, d]) => [d.text, d.failed]);
  assert.deepEqual(steps.at(-1), ["保存修订被拒：摘录找不到。", true]);
  assert.equal(got.find(([n]) => n === "work_ended")![1].outcome, "failed");
});

test("事件分发：带会话订阅的只收自己会话的过程事件；Last-Event-ID 补发；差距太大发 resync；不带就不补", () => {
  const hub = new Hub(ws);
  try {
    const [mine] = hub.subscribe("S1", null);
    hub.emit("step", { session_id: "S2", text: "别的会话" });
    hub.emit("step", { session_id: "S1", text: "自己的" });
    hub.emit("material_added", { session_id: null, path: "inputs/a.md" });
    assert.deepEqual((mine as any).items.map((i: any) => i[2].text ?? i[2].path), ["自己的", "inputs/a.md"]);
    const [, replay] = hub.subscribe(null, 2);
    assert.deepEqual(replay.map(([n, seq]) => [n, seq]), [["deliverable_changed", 3], ["deliverable_changed", 4]]);
    const saved = hubSettings.replayWindow;
    hubSettings.replayWindow = 1;
    try {
      assert.deepEqual(hub.subscribe(null, 0)[1], [["resync", null, { reason: "gap_too_large" }]]);
    } finally {
      hubSettings.replayWindow = saved;
    }
    assert.deepEqual(hub.subscribe(null, null)[1], [], "没带 Last-Event-ID 就不补发，前端接着读整份数据");
    assert.equal(hub.forwarded, 4);
  } finally {
    hub.close();
  }
});

test("经 HTTP 的事件流：先发 connected 注释，补发的库事件带 id 行，同一个序号只发一次", async () => {
  const root = join(tmp, "svc");
  mkdirSync(join(root, "tasks"), { recursive: true });
  const dir = makeWorkspace(join(root, "tasks"), "TASK-001", true);
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { claim: () => null, release: () => {} });
  const server = makeServer(service).listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  const port = (server.address() as AddressInfo).port;
  try {
    const text = await new Promise<string>((ok, fail) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/v1/tasks/TASK-001/events", headers: { "Last-Event-ID": "2" } }, (res) => {
        assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
        let body = "";
        res.on("data", (c) => {
          body += c;
          if ((body.match(/\n\n/g) ?? []).length >= 3) {
            req.destroy();
            ok(body);
          }
        });
      });
      req.on("error", (e) => (e.message.includes("aborted") || e.message.includes("socket hang up") ? undefined : fail(e)));
      req.end();
    });
    const blocks = text.split("\n\n").filter(Boolean);
    assert.equal(blocks[0], ": connected");
    assert.match(blocks[1], /^event: deliverable_changed\nid: 3\ndata: \{"seq": 3, /);
    assert.match(blocks[2], /^event: deliverable_changed\nid: 4\ndata: /);
  } finally {
    server.close();
    await service.close();
  }
  void dir;
});
