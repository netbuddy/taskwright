/**
 * 提交交付物之前要用户在卡片上同意：起真的后端进程与真的 pi，模型换成进程内的假端点。
 * 流程：助手保存一个用例；用户在界面上打开看过、发起评审（假端点替评审者回「没有发现」），完成条件全部满足；
 * 用户打字说「都看过了，完成吧」，助手调用完成任务被拒（打字不算同意），拒绝写明要先发「这个任务是否已经完成」的卡片；
 * 助手发了这张卡片，用户在卡片上点「已完成，提交交付物」（与页面一样经发话接口，origin 为 card_choice），助手再调用，任务变为已完成；
 * 之后改字段与说话都返回 409 task_closed（留存输出的对照里「确认与完成」场景原来核对这两步，现在它走不到已完成，由这里接着核对）。
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { writeAgentDir } from "../fake_model/agent_config.ts";
import { FakeModel } from "../fake_model/server.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
const MAIN = join(ROOT, "backend", "src", "main.mts");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

const NO_PI = spawnSync("pi", ["--version"], { encoding: "utf-8" }).error ? "本机 PATH 上没有 pi" : false;
const DROPPED_ENV = ["TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "TASKWRIGHT_RUNS_DIR", "TASKWRIGHT_TASKS_ROOT",
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "LANGFUSE_TRACING_ENVIRONMENT"];

const MATERIAL = "读者凭借书证在自助机上借书。";
const AGREE = "已完成，提交交付物";
const CARD = { kind: "choose", text: "功能用例一共 1 个条目，已经评审通过，你也看过了，没有未解决的问题。这个任务是否已经完成？提交之后交付物不能再改，仍然可以生成文档。",
  options: [{ key: "complete", text: AGREE }, { key: "continue", text: "还没完成，继续修改" }] };
const reply = (text: string, id: string, act: Dict | null = null) => ({ tool_calls: [{ id, name: "reply", arguments: { informs: [], act, text } }] });
const SCRIPT = {
  rules: [{ when: { any_contains: "你是评审者" }, reply: { text: JSON.stringify({ 发现: [] }) } }],
  sequence: [
    { tool_calls: [{ id: "call-save", name: "save_revision", arguments: { operations: [{ op: "add", collection: "功能用例",
      sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: MATERIAL }],
      fields: { 用例名称: "借书", 用例功能: "读者借书。", 参与者: ["读者"], 基本流程: ["读者在自助机上刷借书证", "系统记下借阅"] } }] } }] },
    reply("整理好了一个用例。", "call-done-1"),
    { tool_calls: [{ id: "call-complete-typed", name: "complete_task", arguments: {} }] },
    reply("完成条件都满足了，请在卡片上选。", "call-card", CARD),
    { tool_calls: [{ id: "call-complete", name: "complete_task", arguments: {} }] },
    reply("任务已经完成。", "call-done-2"),
  ],
};

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise((ok) => probe.close(ok));
  return port;
}

test("打字说完成被拒；助手发了是否已经完成的卡片、用户点「已完成，提交交付物」之后，任务变为已完成", { skip: NO_PI, timeout: 120000 }, async () => {
  const dir = join(tmp, "consent");
  mkdirSync(dir, { recursive: true });
  const fake = await new FakeModel(SCRIPT, join(dir, "fake.jsonl"), { autoIntent: true }).start();
  const env: Dict = { ...process.env, PI_CODING_AGENT_DIR: writeAgentDir(join(dir, "pi-agent"), fake.baseUrl), TASKWRIGHT_LOG_DIR: join(dir, "logs") };
  for (const name of DROPPED_ENV) delete env[name];
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [MAIN, "--tasks", join(dir, "tasks"), "--runs", join(dir, "runs"), "--profile", "fake",
    "--host", "127.0.0.1", "--port", String(port)], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (c) => (out += c));
  child.stderr!.on("data", (c) => (out += c));
  try {
    for (const end = Date.now() + 15000; !/任务服务在 http:\/\/[^:]+:\d+\//.test(out);) {
      if (child.exitCode !== null || Date.now() > end) throw new Error(`后端没有起来：${out}`);
      await sleep(50);
    }
    const call = (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => new Promise((ok, fail) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request({ host: "127.0.0.1", port, path, method, timeout: 60000,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null") }));
      });
      req.on("error", fail);
      req.on("timeout", () => req.destroy(new Error("超时")));
      req.end(data);
    });
    const taskId: string = (await call("POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: "提交交付物" })).body.task_id;
    writeFileSync(join(dir, "tasks", taskId, "inputs", "材料.md"), `${MATERIAL}\n`, "utf-8");
    const session: string = (await call("POST", `/api/v1/tasks/${taskId}/sessions`)).body.session_id;
    // 只读查库；评审正在写库时偶尔读不出（子进程没有输出），按空列表算：轮询接着等，断言处读不出也会因为对不上而失败。
    const db = (sql: string, ...args: string[]) => JSON.parse(spawnSync(process.execPath, ["-e",
      `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});` +
      `console.log(JSON.stringify(db.prepare(process.argv[2]).all(...process.argv.slice(3))))`,
      join(dir, "tasks", taskId, "task.sqlite"), sql, ...args], { encoding: "utf-8" }).stdout || "[]");
    const messages = async () => (await call("GET", `/api/v1/tasks/${taskId}/sessions`)).body.sessions.find((s: Dict) => s.session_id === session)?.message_count ?? 0;
    /** 发一句话（或一次卡片点击），等这一轮做完：这条会话的消息数变多、执行者回到空闲。 */
    const send = async (body: Dict) => {
      const before = await messages();
      assert.equal((await call("POST", `/api/v1/tasks/${taskId}/messages?session=${session}`, body)).status, 200);
      for (const end = Date.now() + 60000; ;) {
        const state = (await call("GET", `/api/v1/tasks/${taskId}/snapshot`)).body.executor.state;
        if ((await messages()) > before && state === "idle") return;
        if (Date.now() > end) throw new Error(`等这一轮做完超时，执行者 ${state}`);
        await sleep(100);
      }
    };
    const action = async (body: Dict) => (await call("POST", `/api/v1/tasks/${taskId}/actions?session=${session}`, { client_id: `a-${body.kind}`, task_id: taskId, ...body })).status;

    await send({ text: "把材料整理成需求规格说明。", client_id: "c-1" });
    assert.equal(await action({ kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] }), 200);
    assert.equal(await action({ kind: "request_review", targets: [] }), 200);
    for (const end = Date.now() + 30000; db("SELECT 1 FROM event WHERE name = 'REVIEW_FINISHED'").length === 0;) {
      if (Date.now() > end) throw new Error("评审没有做完");
      await sleep(100);
    }

    await send({ text: "都看过了，完成吧。", client_id: "c-2" });
    const typed = db("SELECT call_id, fact, guidance FROM tool_rejection WHERE tool_name = 'complete_task'");
    assert.deepEqual(typed.map((r: Dict) => r.call_id), ["call-complete-typed"], "打字说完成不算同意");
    assert.match(typed[0].fact, /用户还没有在问这个任务是否已经完成的卡片上点「已完成，提交交付物」。/);
    assert.match(typed[0].guidance, /\{ key: "complete", text: "已完成，提交交付物" \} 与「还没完成，继续修改」/);
    assert.equal(db("SELECT status FROM task")[0].status, "进行中");

    // 卡片所在的助手消息：会话文件里带「回复」调用 call-card 的那一条。
    const sessionDir = join(dir, "runs", taskId, "pi-sessions", "service");
    const file = join(sessionDir, readdirSync(sessionDir).find((n) => n.endsWith(`_${session}.jsonl`))!);
    const cardEntry = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .find((e) => e.type === "message" && (e.message?.content ?? []).some((p: Dict) => p?.type === "toolCall" && p.id === "call-card")).id;
    await send({ text: `我选：${AGREE}`, client_id: "c-3", origin: "card_choice", card: { reply_message_id: cardEntry, kind: "choose", choice: "complete" } });

    assert.deepEqual(db("SELECT call_id FROM tool_rejection WHERE tool_name = 'complete_task'").map((r: Dict) => r.call_id), ["call-complete-typed"]);
    const task = db("SELECT status, ended_at FROM task")[0];
    assert.equal(task.status, "已完成");
    assert.ok(task.ended_at);
    assert.deepEqual(db("SELECT call_id FROM event WHERE name = 'TASK_COMPLETED'").map((r: Dict) => r.call_id), ["call-complete"]);

    // 提交之后整个任务只读：改字段与说话都返回 409 task_closed。
    const edit = await call("POST", `/api/v1/tasks/${taskId}/actions?session=${session}`, { client_id: "a-edit", task_id: taskId, kind: "edit_fields",
      targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 用例名称: "借阅" }, notify_executor: false });
    assert.deepEqual([edit.status, edit.body.error.code], [409, "task_closed"]);
    const said = await call("POST", `/api/v1/tasks/${taskId}/messages?session=${session}`, { text: "再改改", client_id: "c-4" });
    assert.deepEqual([said.status, said.body.error.code], [409, "task_closed"]);
  } finally {
    if (child.exitCode === null) {
      await new Promise<void>((ok) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
        child.once("exit", () => { clearTimeout(timer); ok(); });
        child.kill("SIGTERM");
      });
    }
    await fake.stop();
  }
});
