/**
 * 直接操作、卡片点击与让助手停下：用一个假的 pi（记下发给它的命令，按需经状态栏回报扩展命令的结果）驱动执行者看护。
 * 覆盖：十种直接操作的请求体与 Python 版逐字一致；扩展命令的等待与超时；打开详情写已读在工作中的例外；
 * 「先不管这条」之后的固定句；卡片标注的计算与 Python 版逐字一致；停下的三种分支与 stopped_by_user。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { Executor, executorSettings } from "../src/executor.ts";
import { cardAnnotation } from "../src/http.ts";
import { Hub } from "../src/hub.ts";
import { ROOT, makeWorkspace, tempDir } from "./helpers.ts";

type Dict = Record<string, any>;

let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = makeWorkspace(tmp, "ws", true);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 本组测试里十种直接操作的请求体，与 Python 版对同一组请求体比较发给 pi 的文字。 */
const BODIES: Dict[] = [
  { client_id: "a-1", kind: "edit_fields", task_id: "TASK-001", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 用例名称: "改名", 基本流程: ["一", "二"] }, notify_executor: false },
  { client_id: "a-2", kind: "delete_item", targets: [{ item_id: "UC-002", base_revision: 3 }] },
  { client_id: "a-3", kind: "unconfirm", targets: [{ item_id: "UC-001", base_revision: 2 }] },
  { client_id: "a-4", kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 2 }] },
  { client_id: "a-5", kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 2 }, { item_id: "UC-002", base_revision: 1 }], notify_executor: true },
  { client_id: "a-6", kind: "keep_pending", targets: [{ item_id: "TBD-001", base_revision: 1 }, { item_id: "TBD-002", base_revision: 1 }], notify_executor: true },
  { client_id: "a-7", kind: "undo", targets: [{ revision_no: 4 }], extra: "不转交" },
  { client_id: "a-8", kind: "request_review", targets: [{ item_id: "UC-001", revision_no: 2 }], force: true },
  { client_id: "a-9", kind: "waive", targets: [{ item_id: "NFR-001", revision_no: 1 }], fields: { 理由: "另有规定" } },
  { client_id: "a-10", kind: "set_review_rules", fields: { rules: { "UC-R7": false } }, session_id: "S1" },
];
const CARDS: [string, Dict][] = [
  ["我选：先做退货流程", { reply_message_id: "a0000002", option_key: "a", option_text: "先做退货流程" }],
  ["这个不对。", { reply_message_id: "a0000002" }],
];

/** 假的 pi：命令记下来；扩展命令按 answer 给出的结果经状态栏回报（answer 返回 null 时不回报）。 */
function fakePi(executor: Executor, answer: (command: string, body: Dict) => Dict | null = () => ({ ok: true })) {
  const calls: [string, Dict][] = [];
  return {
    calls,
    alive: () => true,
    note() {},
    async request(command: string, fields: Dict = {}) {
      calls.push([command, fields]);
      const message = String(fields.message ?? "");
      if (command === "prompt" && message.startsWith("/tw-")) {
        const [name, json] = [message.slice(0, message.indexOf(" ")), message.slice(message.indexOf(" ") + 1)];
        const body = JSON.parse(json);
        const result = answer(name, body);
        if (result !== null) {
          const key = name === "/tw-user" ? "taskwright-user-result" : "taskwright-ui-result";
          setTimeout(() => void (executor as any).handle(this, { type: "界面请求", method: "setStatus", status_key: key, status_text: JSON.stringify({ op_id: body.op_id, ...result }) }), 5);
        }
      }
      if (command === "clear_queue") return { steering: ["先停一下"], followUp: ["用户说：/再看看"] };
      if (command === "get_state") return { isCompacting: false, sessionName: "有名字" };
      if (command === "get_entries") return { entries: [] };
      return {};
    },
    async getState() {
      return this.request("get_state");
    },
  };
}

function setup(answer?: (command: string, body: Dict) => Dict | null) {
  const hub = new Hub(ws);
  const executor = new Executor("TASK-001", ws, join(tmp, "runs"), {}, hub);
  const pi = fakePi(executor, answer);
  executor.pi = pi as any;
  executor.state = "idle";
  executor.activeSession = "S1";
  const [sub] = hub.subscribe(null, null);
  const drain = async () => {
    const out: [string, Dict][] = [];
    for (let item = await sub.get(10); item; item = await sub.get(10)) out.push([item[0], item[2]]);
    return out;
  };
  return { hub, executor, pi, drain };
}

/** 操作编号按首次出现的先后换成 <操作1>、<操作2>……，两版各自随机生成，只比位置。 */
function normalizeOps(value: unknown): unknown {
  const seen = new Map<string, string>();
  return JSON.parse(JSON.stringify(value).replace(/ui-op-[0-9a-f]{12}/g, (m) => {
    if (!seen.has(m)) seen.set(m, `<操作${seen.size + 1}>`);
    return seen.get(m)!;
  }));
}

/** Python 版对同一组请求体、同一组卡片点击发给 pi 的命令。 */
function pythonCommands(): unknown {
  const script = `
import json, sys
from taskwright_server.service import executor as ex
class Hub:
    def emit(self, *a, **k): pass
    def trigger(self): pass
e = ex.Executor("TASK-001", sys.argv[1], sys.argv[2], {}, Hub())
sent = []
class Pi:
    def alive(self): return True
    def _note(self, *a, **k): pass
    def request(self, command, **fields):
        sent.append([command, fields])
        message = fields.get("message") or ""
        if command == "prompt" and message.startswith("/tw-"):
            name, body = message.split(" ", 1)
            key = "taskwright-user-result" if name == "/tw-user" else "taskwright-ui-result"
            e._handle(self, {"type": "界面请求", "method": "setStatus", "status_key": key, "status_text": json.dumps({"op_id": json.loads(body)["op_id"], "ok": True})})
        return {}
e.pi = Pi(); e.state = "idle"; e.active_session = "S1"
bodies, cards = json.loads(sys.argv[3]), json.loads(sys.argv[4])
for body in bodies:
    e.action("S1", body)
for text, annotation in cards:
    e.card_click("S1", text, "k-1", annotation)
print(json.dumps(sent, ensure_ascii=False))
`;
  const done = spawnSync(process.env.TASKWRIGHT_PYTHON || "python3", ["-c", script, ws, join(tmp, "runs"), JSON.stringify(BODIES), JSON.stringify(CARDS)], {
    encoding: "utf-8", env: { ...process.env, PYTHONPATH: [join(ROOT, "server"), join(ROOT, "observatory")].join(":") },
  });
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout);
}

test("十种直接操作与两种卡片点击发给 pi 的命令与 Python 版逐字一致", async () => {
  const { executor, pi } = setup();
  const ops: string[] = [];
  for (const body of BODIES) ops.push(await executor.action("S1", body));
  for (const [text, annotation] of CARDS) assert.equal(await executor.cardClick("S1", text, "k-1", annotation), false);
  assert.ok(ops.every((op) => /^ui-op-[0-9a-f]{12}$/.test(op)));
  assert.deepEqual(normalizeOps(pi.calls), normalizeOps(pythonCommands()));
  // 抽看两条：请求体只转交六个键，按固定先后，操作编号放最后；「先不管这条」之后跟一句固定句。
  assert.equal(pi.calls[0][1].message, `/tw-user {"kind": "edit_fields", "task_id": "TASK-001", "targets": [{"item_id": "UC-001", "base_revision": 1}], "fields": {"用例名称": "改名", "基本流程": ["一", "二"]}, "notify_executor": false, "op_id": "${ops[0]}"}`);
  assert.deepEqual(pi.calls[6], ["prompt", { message: "我先不管 TBD-001、TBD-002，请接着往下做。" }]);
  assert.equal(pi.calls.at(-1)![1].message.startsWith('/tw-ui {"op_id": "ui-op-'), true);
  assert.equal(pi.calls.at(-1)![1].message.endsWith('"reply_entry": "a0000002", "option_key": null, "option_text": null, "text": "这个不对。"}'), true);
});

test("扩展命令拒绝时按它给的错误码回答；没给错误码时直接操作是 rejected、卡片点击是 bad_request", async () => {
  const { executor } = setup((name, body) => (body.kind === "edit_fields"
    ? { ok: false, error: { code: "stale_revision", message: "这个条目刚被改过。", data: { items: [{ item_id: "UC-001", base_revision: 1, current_revision: 2, changed_by: "user" }] } } }
    : { ok: false }));
  await assert.rejects(executor.action("S1", BODIES[0]), (e: ApiError) => e.status === 409 && e.code === "stale_revision" && e.message === "这个条目刚被改过。"
    && (e.data as Dict).items[0].current_revision === 2);
  await assert.rejects(executor.action("S1", BODIES[1]), (e: ApiError) => e.code === "rejected" && e.message === "这次操作没有通过。");
  await assert.rejects(executor.cardClick("S1", "我选：甲", null, {}), (e: ApiError) => e.code === "bad_request" && e.message === "卡片点击没有转交成功。");
});

test("扩展命令的等待：到时没有结果以 busy_timeout 拒绝并带上操作编号，等的人随后撤掉", async () => {
  const saved = executorSettings.actionTimeout;
  executorSettings.actionTimeout = 100;
  try {
    const { executor } = setup(() => null);
    await assert.rejects(executor.action("S1", BODIES[1]), (e: ApiError) => e.status === 503 && e.code === "busy_timeout"
      && e.message === "这次操作没有在 10 秒内得到结果，请稍后看是否已经生效。" && /^ui-op-/.test(String((e.data as Dict).op_id)));
    assert.equal(executor.waiters.size, 0);
  } finally {
    executorSettings.actionTimeout = saved;
  }
});

test("成功的直接操作让事件分发去查库；pi 不在时直接操作失败", async () => {
  const { executor, hub } = setup();
  let triggered = 0;
  hub.trigger = () => void (triggered += 1);
  await executor.action("S1", BODIES[3]);
  assert.ok(triggered >= 1);
  executor.pi = null;
  await assert.rejects(executor.action("S1", BODIES[3]), (e: ApiError) => e.code === "executor_unavailable" && (e.data as Dict).detail === "pi 没有在跑");
});

test("执行者工作中：打开详情写已读照写；带通知的已读、其余操作、卡片点击都是 session_busy", async () => {
  const { executor, pi } = setup();
  executor.state = "working";
  assert.match(await executor.action("S1", BODIES[3]), /^ui-op-/);
  await assert.rejects(executor.action("S1", BODIES[4]), (e: ApiError) => e.code === "session_busy" && (e.data as Dict).reason === "working"
    && e.message === "助手正在工作，结束后你可以继续修改。");
  await assert.rejects(executor.action("S1", BODIES[6]), (e: ApiError) => e.code === "session_busy" && e.message === "助手正在工作，结束后你可以继续修改。");
  await assert.rejects(executor.cardClick("S1", "我选：甲", "k-1", {}), (e: ApiError) => e.code === "session_busy"
    && e.message === "助手正在工作，这一轮做完之后才能发下一句。你可以先把话打好。");
  assert.equal(pi.calls.filter(([c]) => c === "prompt").length, 1, "只有写已读那一条交给了 pi");
});

test("带通知的操作之后，执行者收到的那句话认作界面发起的话（ui_request）", async () => {
  const { executor, drain } = setup();
  await executor.action("S1", BODIES[5]);
  assert.deepEqual([...executor.pendingOrigin.keys()], ["我已经看过了：", "我先不管 "]);
  await drain();
  await (executor as any).handle(executor.pi, { type: "agent_start" });
  await (executor as any).handle(executor.pi, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "我已经看过了：UC-001 第 2 版。请接着往下做。" }] } });
  const user = (await drain()).find(([name]) => name === "user_message")![1];
  assert.equal(user.origin, "ui_request");
});

test("卡片标注：annotation 原样用；card 写法按回复里的选项查回文字，查不到用 choice 本身；与 Python 版逐字一致", () => {
  const reply = { type: "message", id: "a0000002", message: { role: "assistant", content: [{ type: "text", text: "请选" }, { type: "toolCall", name: "reply", arguments: {
    text: "逾期能续借吗？", act: { kind: "choose", options: [{ key: "allow", text: "允许续借" }, { key: "deny", text: "不允许续借" }, { key: "x" }] } } }] } };
  const entries = [{ type: "message", id: "u0000001", message: { role: "user", content: "问吧" } }, reply];
  const bodies = [
    { annotation: { reply_message_id: "a0000002", option_key: "a", option_text: "甲" } },
    { card: { reply_message_id: "a0000002", kind: "choose", choice: "deny" } },
    { card: { reply_message_id: "a0000002", kind: "confirm", choice: "不对" } },
    { card: { reply_message_id: "a0000002", kind: "choose", choice: "x" } },
    { card: { reply_message_id: "a9999999", kind: "choose", choice: "allow" } },
    { card: { kind: "choose" } },
    { card: "不是对象", annotation: "也不是" },
    {},
  ];
  const ts = bodies.map((b) => cardAnnotation(b, entries));
  assert.deepEqual(ts[1], { reply_message_id: "a0000002", option_key: "deny", option_text: "不允许续借", card_kind: "choose" });
  assert.deepEqual(ts[2].option_text, "不对");
  const script = `
import json, sys
from taskwright_server.service.app import card_annotation
bodies, entries = json.loads(sys.argv[1]), json.loads(sys.argv[2])
print(json.dumps([card_annotation(b, entries) for b in bodies], ensure_ascii=False))
`;
  const done = spawnSync(process.env.TASKWRIGHT_PYTHON || "python3", ["-c", script, JSON.stringify(bodies), JSON.stringify(entries)], {
    encoding: "utf-8", env: { ...process.env, PYTHONPATH: [join(ROOT, "server"), join(ROOT, "observatory")].join(":") },
  });
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(ts, JSON.parse(done.stdout));
});

test("停下：pi 不在时什么都不做；对另一条会话是 session_busy；否则清队列、标记用户让停、中止，work_ended 为 stopped_by_user", async () => {
  const { executor, pi, drain } = setup();
  assert.deepEqual(await executor.stop("S2").catch((e: ApiError) => [e.code, e.message, e.data]),
    ["session_busy", "助手正在另一条会话里工作。", { active_session: "S1" }]);
  await (executor as any).handle(pi, { type: "agent_start" });
  assert.deepEqual(await executor.stop("S1"), ["先停一下", "/再看看"], "清掉的话还给前端，斜杠改写的前缀去掉");
  assert.deepEqual(pi.calls.map(([c]) => c), ["clear_queue", "abort"]);
  assert.equal(executor.work!.stopped, true);
  await drain();
  await (executor as any).handle(pi, { type: "agent_settled" });
  const events = await drain();
  assert.deepEqual(events.filter(([n]) => n === "problem"), [], "用户让停的不发 problem");
  assert.equal(events.find(([n]) => n === "work_ended")![1].outcome, "stopped_by_user");
  executor.pi = null;
  assert.deepEqual(await executor.stop(null), []);
});
