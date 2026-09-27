/**
 * 回到旧会话：--tasks 与 --runs 给相对路径启动时，新建第二条会话之后读第一条会话的快照、后端重启之后读原会话的快照，
 * 执行者都应当接回原来那条会话，而不是另开一条。另有几条核对「接不上时报错、不悄悄换会话」：会话文件被改名互换，
 * pi 续接后报的会话编号与请求的不同时返回 session_resume_failed、用户的话不发出去、停掉 pi；读快照照常返回；
 * pi 拒绝切换同样处理；会话文件被移走时照旧返回 not_found，用户的话同样不发出去。
 * 起真的后端进程（node backend/src/main.mts，工作目录是临时目录，--tasks tasks --runs runs）与真的 pi，模型换成进程内的假端点。
 *
 * 曾经的缺陷：后端把相对于自己工作目录的会话文件路径原样交给 pi，pi 的工作目录是任务目录，按它解析找不到文件，
 * 于是不报错、悄悄新开一条空会话，之后的话、修订与对话记录都落进那条新会话。现在 Service 构造时把两个目录转成绝对路径，
 * 交给 pi 的会话文件路径（switch_session 与 --session）也一律转成绝对路径，两处各自都足以让这两条通过。
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { writeAgentDir } from "../fake_model/agent_config.ts";
import { FakeModel } from "../fake_model/server.ts";
import { RESUME_FAILED_STATE_TEXT, RESUME_FAILED_TEXT } from "../src/executor.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";

// 后端在子进程里运行，它的输出接到管道上；测试进程里另有假模型端点与本文件的代码。以防它们日后写日志，
// console 的输出一律收进内存，不写标准输出（原因见 helpers.ts 的 captureConsole）。
captureConsole();

type Dict = Record<string, any>;
const MAIN = join(ROOT, "backend", "src", "main.mts");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

const NO_PI = spawnSync("pi", ["--version"], { encoding: "utf-8" }).error ? "本机 PATH 上没有 pi" : false;
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
  readonly script: Dict;
  fake!: FakeModel;
  child: ChildProcess | null = null;
  port = 0;
  constructor(name: string, script: Dict = SCRIPT) {
    this.dir = join(tmp, name);
    this.script = script;
    mkdirSync(this.dir, { recursive: true });
  }

  async start(): Promise<void> {
    this.fake ??= await new FakeModel(this.script, join(this.dir, "fake.jsonl")).start();
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

  async newTask(): Promise<string> {
    return (await this.call("POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: "回到旧会话" })).body.task_id;
  }

  async newSession(taskId: string): Promise<string> {
    return (await this.call("POST", `/api/v1/tasks/${taskId}/sessions`)).body.session_id;
  }

  /** 在一条会话里说一句话，等这一轮做完：会话列表里这条会话的消息数变多、执行者回到空闲（会话文件在这一轮里写到磁盘上）。 */
  async sayAndWait(taskId: string, sessionId: string, text: string): Promise<void> {
    const count = async () => (await this.sessions(taskId)).find((s) => s.session_id === sessionId)?.message_count ?? 0;
    const before = await count();
    assert.equal((await this.call("POST", `/api/v1/tasks/${taskId}/messages?session=${sessionId}`, { text, client_id: `c-${text}` })).status, 200);
    const end = Date.now() + 60000;
    for (;;) {
      const state = (await this.call("GET", `/api/v1/tasks/${taskId}/snapshot`)).body.executor.state;
      if ((await count()) > before && state === "idle") return;
      if (Date.now() > end) throw new Error(`等这一轮做完超时，执行者 ${state}`);
      await sleep(100);
    }
  }

  /** 建任务、开第一条会话、说一句话并等这一轮做完。返回任务编号与会话编号。 */
  async taskWithOneTurn(): Promise<[string, string]> {
    const taskId = await this.newTask();
    const first = await this.newSession(taskId);
    await this.sayAndWait(taskId, first, "你好");
    return [taskId, first];
  }

  sessionDir(taskId: string): string {
    return join(this.dir, "runs", taskId, "pi-sessions", "service");
  }

  /** 会话目录里那条会话的文件名（文件名以会话编号结尾）。 */
  sessionFile(taskId: string, sessionId: string): string {
    const name = readdirSync(this.sessionDir(taskId)).find((n) => n.endsWith(`_${sessionId}.jsonl`));
    if (!name) throw new Error(`没有会话 ${sessionId} 的文件`);
    return join(this.sessionDir(taskId), name);
  }

  /** 任务目录与归档目录下全部文件（相对栈目录），以及其中哪些含有给定的文字。 */
  files(text?: string): { all: string[]; containing: string[] } {
    const all: string[] = [];
    const containing: string[] = [];
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else {
          all.push(p.slice(this.dir.length + 1));
          if (text && !p.endsWith(".sqlite") && readFileSync(p, "utf-8").includes(text)) containing.push(p.slice(this.dir.length + 1));
        }
      }
    };
    walk(join(this.dir, "tasks"));
    walk(join(this.dir, "runs"));
    return { all: all.sort(), containing };
  }

  /** 后端进程下还在跑的子进程（pi）的进程号。 */
  children(): string[] {
    const out = spawnSync("pgrep", ["-P", String(this.child!.pid)], { encoding: "utf-8" }).stdout.trim();
    return out ? out.split("\n") : [];
  }

  /** 任务库里某条事件（按 call_id 找，直接操作的 call_id 就是操作编号）记在哪条会话名下；没有这条事件时为空串。 */
  eventSession(taskId: string, callId: string): string {
    const out = spawnSync(process.execPath, ["-e", `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});`
      + `const r=db.prepare("SELECT session_id FROM event WHERE call_id=?").get(process.argv[2]);console.log(r?r.session_id:"")`,
    join(this.dir, "tasks", taskId, "task.sqlite"), callId], { encoding: "utf-8" });
    return out.stdout.trim();
  }

  /** 任务库里某种事件的条数。 */
  eventCount(taskId: string, name: string): number {
    const out = spawnSync(process.execPath, ["-e", `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});`
      + `console.log(db.prepare("SELECT COUNT(*) AS n FROM event WHERE name=?").get(process.argv[2]).n)`, join(this.dir, "tasks", taskId, "task.sqlite"), name], { encoding: "utf-8" });
    return Number(out.stdout.trim());
  }

  /** 只读快照（不带 session，不会启动助手）里的执行者状态。 */
  async executorState(taskId: string): Promise<Dict> {
    return (await this.call("GET", `/api/v1/tasks/${taskId}/snapshot`)).body.executor;
  }

  /** 等执行者到某个状态，最多 30 秒。 */
  async waitState(taskId: string, state: string): Promise<void> {
    const end = Date.now() + 30000;
    while ((await this.executorState(taskId)).state !== state) {
      if (Date.now() > end) throw new Error(`等执行者到 ${state} 超时`);
      await sleep(100);
    }
  }

  /** 一次直接操作：改评审规则（它在任务库里记一条带会话编号与操作编号的事件，不需要先有条目）。 */
  action(taskId: string, sessionId: string, off: string[]): Promise<{ status: number; body: any }> {
    return this.call("POST", `/api/v1/tasks/${taskId}/actions?session=${sessionId}`,
      { client_id: `a-${off.join("-")}`, task_id: taskId, kind: "set_review_rules", targets: [], fields: { collection: "功能用例", off, promote: [] } });
  }

  sessionFiles(taskId: string): string[] {
    return readdirSync(this.sessionDir(taskId)).sort();
  }

  revisions(taskId: string): number {
    const out = spawnSync(process.execPath, ["-e", `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});`
      + `console.log(db.prepare("SELECT COUNT(*) AS n FROM revision").get().n)`, join(this.dir, "tasks", taskId, "task.sqlite")], { encoding: "utf-8" });
    return Number(out.stdout.trim());
  }
}

/**
 * 两条都说过话的会话 A、B，执行者当前接着 B。然后把 A 的会话文件改名移开，把 B 的会话文件改名成 A 原来的文件名：
 * 后端记着的 A 的路径上仍有文件，但里面是 B，pi 续接后报的会话编号就是 B 而不是 A。返回恢复原状的函数。
 */
async function swapped(stack: Stack): Promise<{ taskId: string; a: string; b: string; restore: () => void }> {
  const [taskId, a] = await stack.taskWithOneTurn();
  const b = await stack.newSession(taskId);
  await stack.sayAndWait(taskId, b, "第二条会话");
  const fileA = stack.sessionFile(taskId, a);
  const fileB = stack.sessionFile(taskId, b);
  const aside = join(stack.dir, "A-移开.jsonl");
  renameSync(fileA, aside);
  renameSync(fileB, fileA);
  return { taskId, a, b, restore: () => { renameSync(fileA, fileB); renameSync(aside, fileA); } };
}

test("新建第二条会话之后读第一条会话的快照：执行者接回第一条会话，会话列表里不多出没有名字的空会话",
  { skip: NO_PI }, async () => {
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
  { skip: NO_PI }, async () => {
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

test("续接后 pi 报的会话编号对不上（会话文件被改名互换）：返回 session_resume_failed，用户的话不发出去，不新增修订与会话文件，停掉 pi；恢复之后照常能说话",
  { skip: NO_PI }, async () => {
    const stack = new Stack("resume-mismatch");
    try {
      await stack.start();
      const { taskId, a, restore } = await swapped(stack);
      const requests = stack.fake.requests().length;
      const revisions = stack.revisions(taskId);
      const files = stack.files().all;
      assert.equal(stack.children().length, 1);
      const said = await stack.call("POST", `/api/v1/tasks/${taskId}/messages?session=${a}`, { text: "这句不该发出去", client_id: "c-lost" });
      assert.equal(said.status, 503);
      assert.deepEqual(said.body.error, { code: "session_resume_failed", message: RESUME_FAILED_TEXT, data: { session_id: a } });
      assert.equal(stack.fake.requests().length, requests);
      assert.deepEqual(stack.files("这句不该发出去").containing, []);
      assert.equal(stack.revisions(taskId), revisions);
      assert.deepEqual(stack.files().all, files);
      assert.deepEqual(stack.children(), []);
      assert.deepEqual((await stack.call("GET", `/api/v1/tasks/${taskId}/snapshot`)).body.executor, { state: "not_started", text: RESUME_FAILED_STATE_TEXT, active_session: null });
      restore();
      await stack.sayAndWait(taskId, a, "恢复之后再说");
      assert.equal((await stack.call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${a}`)).body.executor.active_session, a);
    } finally {
      await stack.stop();
    }
  });

test("读快照时续接对不上：快照照常返回对话记录与条目，执行者状态写明助手没有接上", { skip: NO_PI }, async () => {
  const stack = new Stack("resume-mismatch-snapshot");
  try {
    await stack.start();
    const { taskId, a } = await swapped(stack);
    const snapshot = await stack.call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${a}`);
    assert.equal(snapshot.status, 200);
    assert.deepEqual(snapshot.body.executor, { state: "not_started", text: RESUME_FAILED_STATE_TEXT, active_session: null });
    assert.ok(snapshot.body.task);
    assert.ok(snapshot.body.conversation.messages.length > 0);
    assert.deepEqual(stack.children(), []);
  } finally {
    await stack.stop();
  }
});

test("pi 拒绝切换（会话文件不是合法的会话）：同样返回 session_resume_failed，用户的话不发出去，停掉 pi", { skip: NO_PI }, async () => {
  const stack = new Stack("resume-refused");
  try {
    await stack.start();
    const [taskId, a] = await stack.taskWithOneTurn();
    const b = await stack.newSession(taskId);
    await stack.sayAndWait(taskId, b, "第二条会话");
    const fileA = stack.sessionFile(taskId, a);
    renameSync(fileA, join(stack.dir, "A-移开.jsonl"));
    writeFileSync(fileA, "这不是会话文件\n", "utf-8");
    const requests = stack.fake.requests().length;
    const said = await stack.call("POST", `/api/v1/tasks/${taskId}/messages?session=${a}`, { text: "这句不该发出去", client_id: "c-lost" });
    assert.equal(said.status, 503);
    assert.equal(said.body.error.code, "session_resume_failed");
    assert.equal(stack.fake.requests().length, requests);
    assert.deepEqual(stack.files("这句不该发出去").containing, []);
    assert.deepEqual(stack.children(), []);
  } finally {
    await stack.stop();
  }
});

test("会话文件被移走：照旧返回 not_found，用户的话没有进入任何会话", { skip: NO_PI }, async () => {
  const stack = new Stack("session-file-moved");
  try {
    await stack.start();
    const [taskId, a] = await stack.taskWithOneTurn();
    const b = await stack.newSession(taskId);
    await stack.sayAndWait(taskId, b, "第二条会话");
    renameSync(stack.sessionFile(taskId, a), join(stack.dir, "A-移开.jsonl"));
    const requests = stack.fake.requests().length;
    const revisions = stack.revisions(taskId);
    const said = await stack.call("POST", `/api/v1/tasks/${taskId}/messages?session=${a}`, { text: "这句不该发出去", client_id: "c-lost" });
    assert.equal(said.status, 404);
    assert.equal(said.body.error.code, "not_found");
    assert.equal(stack.fake.requests().length, requests);
    assert.deepEqual(stack.files("这句不该发出去").containing, []);
    assert.equal(stack.revisions(taskId), revisions);
  } finally {
    await stack.stop();
  }
});

test("助手已经退出（exited）时做直接操作：按需启动助手、续接页面所在的那条会话，操作记在这条会话名下，会话文件不多出一条", { skip: NO_PI }, async () => {
  const stack = new Stack("action-exited");
  try {
    await stack.start();
    const [taskId, a] = await stack.taskWithOneTurn();
    process.kill(Number(stack.children()[0]));
    await stack.waitState(taskId, "exited");
    const files = stack.sessionFiles(taskId);
    const done = await stack.action(taskId, a, ["UC-R2"]);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(stack.eventSession(taskId, done.body.op_id), a, "操作记在原会话名下");
    assert.equal((await stack.executorState(taskId)).active_session, a, "助手接的是页面所在的那条会话");
    assert.deepEqual(stack.sessionFiles(taskId), files, "会话文件没有多出一条");
    assert.equal(stack.children().length, 1);
  } finally {
    await stack.stop();
  }
});

test("助手还没有启动（not_started，例如后端重启之后）时做直接操作：同样按需启动并续接原会话", { skip: NO_PI }, async () => {
  const stack = new Stack("action-not-started");
  try {
    await stack.start();
    const [taskId, a] = await stack.taskWithOneTurn();
    await stack.stopBackend();
    await stack.start();
    assert.equal((await stack.executorState(taskId)).state, "not_started");
    const files = stack.sessionFiles(taskId);
    const done = await stack.action(taskId, a, ["UC-R2"]);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(stack.eventSession(taskId, done.body.op_id), a);
    assert.equal((await stack.executorState(taskId)).active_session, a);
    assert.deepEqual(stack.sessionFiles(taskId), files);
  } finally {
    await stack.stop();
  }
});

test("按需启动时续接对不上（会话文件被改名互换）：直接操作返回 session_resume_failed，不在接错的会话里执行，停掉助手", { skip: NO_PI }, async () => {
  const stack = new Stack("action-resume-mismatch");
  try {
    await stack.start();
    const { taskId, a } = await swapped(stack);
    process.kill(Number(stack.children()[0]));
    await stack.waitState(taskId, "exited");
    const files = stack.sessionFiles(taskId);
    const done = await stack.action(taskId, a, ["UC-R2"]);
    assert.equal(done.status, 503);
    assert.deepEqual(done.body.error, { code: "session_resume_failed", message: RESUME_FAILED_TEXT, data: { session_id: a } });
    assert.equal(stack.eventCount(taskId, "REVIEW_RULES_CHANGED"), 0, "操作没有执行，任务库里没有改规则的事件");
    assert.deepEqual(stack.sessionFiles(taskId), files, "会话文件没有多出一条");
    assert.deepEqual(stack.children(), []);
    assert.deepEqual(await stack.executorState(taskId), { state: "not_started", text: RESUME_FAILED_STATE_TEXT, active_session: null });
  } finally {
    await stack.stop();
  }
});

test("助手正在另一条会话里工作时做直接操作：照旧返回 session_busy，不打断那条会话", { skip: NO_PI }, async () => {
  const slow = { ...SCRIPT, default: { ...SCRIPT.default, delay: 3 } };
  const stack = new Stack("action-busy", slow);
  try {
    await stack.start();
    const [taskId, a] = await stack.taskWithOneTurn();
    const b = await stack.newSession(taskId);
    assert.equal((await stack.call("POST", `/api/v1/tasks/${taskId}/messages?session=${b}`, { text: "慢慢做", client_id: "c-slow" })).status, 200);
    await stack.waitState(taskId, "working");
    const done = await stack.action(taskId, a, ["UC-R2"]);
    assert.equal(done.status, 409);
    assert.equal(done.body.error.code, "session_busy");
    assert.equal((await stack.executorState(taskId)).active_session, b, "助手仍在另一条会话里");
    await stack.waitState(taskId, "idle");
  } finally {
    await stack.stop();
  }
});
