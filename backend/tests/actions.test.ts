/**
 * 直接操作、卡片点击与让助手停下：用一个假的 pi（记下发给它的命令，按需经状态栏回报扩展命令的结果）驱动执行者看护。
 * 覆盖：十种直接操作的请求体与 Python 版留存的输出逐字一致；扩展命令的等待与超时；打开详情写已读在工作中的例外；
 * 「先不管这条」之后的固定句；卡片标注的计算与 Python 版留存的输出逐字一致；停下的三种分支与 stopped_by_user。
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { Executor, executorSettings } from "../src/executor.ts";
import { cardAnnotation } from "../src/http.ts";
import { Hub } from "../src/hub.ts";
import { BODIES, CARDS, CARD_BODIES, CARD_ENTRIES, normalize } from "./fixtures/py/inputs.ts";
import { ROOT, makeWorkspace, tempDir } from "./helpers.ts";

type Dict = Record<string, any>;

let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = makeWorkspace(tmp, "ws", true);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

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

/** Python 版在同一组输入上的输出（fixtures/py/，生成方法见那里的 README.md）。 */
const pyFixture = (name: string) => JSON.parse(readFileSync(join(ROOT, "backend", "tests", "fixtures", "py", name), "utf-8"));

test("十种直接操作与两种卡片点击发给 pi 的命令与 Python 版留存的输出逐字一致", async () => {
  const { executor, pi } = setup();
  const ops: string[] = [];
  for (const body of BODIES) ops.push(await executor.action("S1", body));
  for (const [text, annotation] of CARDS) assert.equal(await executor.cardClick("S1", text, "k-1", annotation), false);
  assert.ok(ops.every((op) => /^ui-op-[0-9a-f]{12}$/.test(op)));
  assert.deepEqual(normalize(pi.calls), pyFixture("actions.json").commands);
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

test("成功的直接操作让事件分发去查库；pi 不在、又没有给会话时直接操作失败", async () => {
  const { executor, hub } = setup();
  let triggered = 0;
  hub.trigger = () => void (triggered += 1);
  await executor.action("S1", BODIES[3]);
  assert.ok(triggered >= 1);
  executor.pi = null;
  // 给了会话时按需启动 pi 并续接那条会话（真进程测试见 session_resume.test.ts）；没有给会话时不为一次操作另开会话，照旧失败。
  await assert.rejects(executor.action(null, BODIES[3]), (e: ApiError) => e.code === "executor_unavailable" && (e.data as Dict).detail === "pi 没有在跑");
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

test("卡片标注：annotation 原样用；card 写法按回复里的选项查回文字，查不到用 choice 本身；与 Python 版留存的输出逐字一致", () => {
  const [bodies, entries] = [CARD_BODIES, CARD_ENTRIES];
  const ts = bodies.map((b) => cardAnnotation(b, entries));
  assert.deepEqual(ts[1], { reply_message_id: "a0000002", option_key: "deny", option_text: "不允许续借", card_kind: "choose" });
  assert.deepEqual(ts[2].option_text, "不对");
  assert.deepEqual(ts, pyFixture("card_annotations.json").annotations);
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
