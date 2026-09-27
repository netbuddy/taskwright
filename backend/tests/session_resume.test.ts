/**
 * 回到旧会话：--tasks 与 --runs 给相对路径启动时，新建第二条会话之后读第一条会话的快照、后端重启之后读原会话的快照，
 * 执行者都应当接回原来那条会话，而不是另开一条。
 * 起真的后端进程（node backend/src/main.mts，工作目录是临时目录，--tasks tasks --runs runs）与真的 pi，模型换成进程内的假端点。
 *
 * 这两条目前是已知缺陷，标为 todo（失败不算整套测试失败）：后端把相对于自己工作目录的会话文件路径原样交给 pi，
 * pi 的工作目录是任务目录，按它解析找不到文件，于是不报错、悄悄新开一条空会话；之后的话、修订与对话记录都落进那条新会话。
 * 修好之后两条应当通过，届时去掉 todo。给绝对路径启动时不出问题，双跑对照与其余测试都是这样启动的，所以没有发现。
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { writeAgentDir } from "../fake_model/agent_config.ts";
import { FakeModel } from "../fake_model/server.ts";
import { ROOT, tempDir } from "./helpers.ts";

type Dict = Record<string, any>;
const MAIN = join(ROOT, "backend", "src", "main.mts");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

const NO_PI = spawnSync("pi", ["--version"], { encoding: "utf-8" }).error ? "本机 PATH 上没有 pi" : false;
const KNOWN_BUG = "已知缺陷：相对路径启动时回到旧会话会另开一条新会话；修好之后去掉 todo";
const DROPPED_ENV = ["TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "TASKWRIGHT_RUNS_DIR", "TASKWRIGHT_TASKS_ROOT", "PI_CODING_AGENT_DIR",
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "LANGFUSE_TRACING_ENVIRONMENT"];

/** 每句用户的话：先经「回复」工具回一句，工具结果回来后以一段文字结束这一轮。 */
const INTENT = '```json\n{"acts": [{"function": "request", "confidence": "high", "summary": "照用户说的做"}]}\n```';
const SCRIPT = {
  rules: [{ when: { last_role: "tool" }, reply: { text: "好的。" } }],
  default: { text: INTENT, tool_calls: [{ name: "reply", arguments: { informs: [], act: null, text: "我在。" } }] },
};

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise((ok) => probe.close(ok));
  return port;
}

/** 一套验证栈：一个假端点，一个以相对路径启动、工作目录是 dir 的后端；后端可以停下再起。 */
class Stack {
  readonly dir: string;
  fake!: FakeModel;
  child: ChildProcess | null = null;
  port = 0;
  constructor(name: string) {
    this.dir = join(tmp, name);
    mkdirSync(this.dir, { recursive: true });
  }

  async start(): Promise<void> {
    this.fake ??= await new FakeModel(SCRIPT).start();
    const agentDir = writeAgentDir(join(this.dir, "pi-agent"), this.fake.baseUrl);
    const env: Dict = { ...process.env, PI_CODING_AGENT_DIR: agentDir, TASKWRIGHT_LOG_DIR: join(this.dir, "logs") };
    for (const name of DROPPED_ENV) if (name !== "PI_CODING_AGENT_DIR") delete env[name];
    const port = await freePort();
    const child = spawn(process.execPath, [MAIN, "--tasks", "tasks", "--runs", "runs", "--profile", "fake", "--host", "127.0.0.1", "--port", String(port)],
      { cwd: this.dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (c) => (out += c));
    child.stderr!.on("data", (c) => (out += c));
    const end = Date.now() + 15000;
    while (!/任务服务在 http:\/\/[^:]+:\d+\//.test(out)) {
      if (child.exitCode !== null || Date.now() > end) throw new Error(`后端没有起来：${out}`);
      await sleep(50);
    }
    this.child = child;
    this.port = port;
  }

  async stopBackend(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((ok) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
      child.once("exit", () => {
        clearTimeout(timer);
        ok();
      });
      child.kill("SIGTERM");
    });
  }

  async stop(): Promise<void> {
    await this.stopBackend();
    await this.fake?.stop();
  }

  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    return new Promise((ok, fail) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request({ host: "127.0.0.1", port: this.port, path, method, timeout: 60000,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null") }));
      });
      req.on("error", fail);
      req.on("timeout", () => req.destroy(new Error("超时")));
      req.end(data);
    });
  }

  async sessions(taskId: string): Promise<Dict[]> {
    return (await this.call("GET", `/api/v1/tasks/${taskId}/sessions`)).body.sessions;
  }

  /** 建任务、开第一条会话、说一句话并等这一轮做完（会话文件在这一轮里写到磁盘上）。返回任务编号与会话编号。 */
  async taskWithOneTurn(): Promise<[string, string]> {
    const taskId = (await this.call("POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: "回到旧会话" })).body.task_id;
    const first = (await this.call("POST", `/api/v1/tasks/${taskId}/sessions`)).body.session_id;
    assert.equal((await this.call("POST", `/api/v1/tasks/${taskId}/messages?session=${first}`, { text: "你好", client_id: "c-1" })).status, 200);
    const end = Date.now() + 60000;
    for (;;) {
      const row = (await this.sessions(taskId)).find((s) => s.session_id === first);
      const state = (await this.call("GET", `/api/v1/tasks/${taskId}/snapshot`)).body.executor.state;
      if (row && row.message_count >= 2 && state === "idle") break;
      if (Date.now() > end) throw new Error(`等第一轮做完超时：${JSON.stringify(row)}，执行者 ${state}`);
      await sleep(100);
    }
    return [taskId, first];
  }
}

test("新建第二条会话之后读第一条会话的快照：执行者接回第一条会话，会话列表里不多出没有名字的空会话",
  { skip: NO_PI, todo: KNOWN_BUG }, async () => {
    const stack = new Stack("second-session");
    try {
      await stack.start();
      const [taskId, first] = await stack.taskWithOneTurn();
      const second = (await stack.call("POST", `/api/v1/tasks/${taskId}/sessions`)).body.session_id;
      const snapshot = await stack.call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${first}`);
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.body.executor.active_session, first);
      // 第二条会话没说过话，pi 还没写出它的会话文件，切走之后它不在列表里；这里只核对列表里没有这两条以外的会话。
      const listed = (await stack.sessions(taskId)).map((s) => s.session_id);
      assert.ok(listed.includes(first));
      assert.deepEqual(listed.filter((id) => id !== first && id !== second), []);
    } finally {
      await stack.stop();
    }
  });

test("后端重启之后用原会话编号读快照：执行者接回原会话，会话列表里只有这一条",
  { skip: NO_PI, todo: KNOWN_BUG }, async () => {
    const stack = new Stack("restart");
    try {
      await stack.start();
      const [taskId, first] = await stack.taskWithOneTurn();
      await stack.stopBackend();
      await stack.start();
      const snapshot = await stack.call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${first}`);
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.body.executor.active_session, first);
      assert.deepEqual((await stack.sessions(taskId)).map((s) => s.session_id), [first]);
    } finally {
      await stack.stop();
    }
  });
