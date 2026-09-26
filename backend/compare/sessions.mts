/**
 * 会话场景的双跑对照：两版后端各配一个假模型端点，按同一份脚本、同一串操作各跑一遍，比较事件流、响应、归档与观测台读出的数据。
 *
 * 用法：
 *   node backend/compare/sessions.mts --work <空目录> [--only 场景名,…] [--out 结果.json]
 *        [--ports 8960,8961,8962,8963]（A 后端、B 后端、A 的假端点、B 的假端点）
 *
 * A 是 Python 版（python -m taskwright_server.service），B 是 TypeScript 版（node backend/src/main.mts），都用启动配置 fake。
 * 两边的假端点都是 TypeScript 版（node backend/fake_model/main.mts），pi 的配置目录由假端点写好、经 PI_CODING_AGENT_DIR 指过去。
 * 只有 fake_model 这个场景不起后端：A 起 Python 版假端点、B 起 TypeScript 版假端点，对两者发同一串请求。
 * 每个场景重起一套，任务目录与归档目录都在 --work 下、两边互不共享。
 * Python 解释器可用环境变量 TASKWRIGHT_PYTHON 指定（需要能 import taskwright_server 与 taskwright_observatory）。
 *
 * 每个场景记下一串观察：HTTP 响应（状态码与正文）、事件流收到的全部事件、最后的三种归档文件、会话文件、假端点的请求记录、
 * 观测台读出的会话列表与会话详情。归一化之后逐条比较（规则见 Normalizer），另有四条比较规则：
 * 1. 事件流里 executor_state 与其它事件的相对先后不比，两类各自按先后比：Python 版在启动 pi 时先起读事件的线程、再报「空闲」，
 *    两个线程之间谁先推事件不固定。
 * 2. pi 流式输出的中间快照（message_start、message_update）不比 usage 与 responseId（见 stripStreamingSnapshot）。
 * 3. 原始事件流里后端命令的回应与 pi 自己的事件分成两列各自按先后比；记归档行号的字段不比具体行号（见 archives）。
 * 4. 任务目录里的占用标记不比 mode 一项：TypeScript 版按运行形态开关多写这一项，Python 版没有；两版读标记都只看端口、进程号与主机。
 * 5. 事件流里库事件（带序号的那些）的 completion 一项，只比每条事件流里最后一条库事件的。事件分发每次查库把新行拼成一批，
 *    完成条件算一次、附在这一批的最后一条上，其余各条写 null；一批里有哪几条取决于 pi 的提示什么时候到、一次查库花多久
 *    （Python 版算完成条件要起一个 Node 子进程，约零点几秒，这期间新写的行并进下一批），界面评审这种一连写好几行的时候
 *    两版的批次边界不同，中间各条的 completion 就不同。最后一条是写完之后算的，两版相同；整份数据里的完成条件也照比。
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = process.env.TASKWRIGHT_PYTHON || "python3";
const SEED = join(ROOT, "agent", "tests", "fixtures", "seed_compare_task.mts");
const FAKE_MAIN = join(ROOT, "backend", "fake_model", "main.mts");
const DROPPED_ENV = ["TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "TASKWRIGHT_RUNS_DIR", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL", "LANGFUSE_TRACING_ENVIRONMENT", "PI_CODING_AGENT_DIR", "TASKWRIGHT_TASKS_ROOT"];
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

type Dict = Record<string, any>;

// ───────────── 假模型脚本 ─────────────

/** 执行者每轮要先写一份理解（agent/prompts/schemas/user_intent.schema.json），这里写在回答的文字里。 */
const INTENT = '```json\n{"acts": [{"function": "request", "confidence": "high", "summary": "照用户说的做"}]}\n```';
const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "买家可以申请退货。" };
const UC = { 用例名称: "提交退货申请", 用例功能: "买家提交退货申请。", 参与者: ["买家"], 基本流程: ["买家打开订单", "系统记下申请"] };
const UC2 = { 用例名称: "撤回退货申请", 用例功能: "买家撤回退货申请。", 参与者: ["买家"], 基本流程: ["买家打开申请", "系统撤回申请"] };
const call = (name: string, args: Dict, id?: string) => ({ name, arguments: args, ...(id ? { id } : {}) });
const add = (collection: string, fields: Dict) => ({ op: "add", collection, fields, sources: [SOURCE] });
const save = (operations: Dict[], id?: string) => call("save_revision", { operations }, id);
const saveUc = (withIntent = true) => ({ ...(withIntent ? { text: INTENT } : {}), tool_calls: [save([add("功能用例", UC)])] });
const saveTwo = { text: INTENT, tool_calls: [save([add("功能用例", UC), add("功能用例", UC2)], "call-save")] };
const reply = (text: string, extra: Dict = {}, act: Dict | null = null, id?: string) => ({ ...extra, tool_calls: [call("reply", { informs: [], act, text }, id)] });
const replyWithIntent = (text: string, extra: Dict = {}) => reply(text, { text: INTENT, ...extra });
/** 假端点替评审者回答的规则：请求里带评审者的系统提示就回，不占执行者的 sequence。 */
const reviewer = (findings: Dict[], extra: Dict = {}) => ({ when: { any_contains: "你是评审者" }, reply: { text: JSON.stringify({ 发现: findings }), ...extra } });
const UC_R7 = { 规则: "UC-R7", 字段: "基本流程", 序号: 2, 问题: "第 2 步「系统记下申请」没有写明记下什么。", 建议: "写明系统记下的是哪一项退货记录。" };

// ───────────── 进程 ─────────────

function waitPort(port: number, ms = 30000): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((ok, fail) => {
    const attempt = () => {
      const req = request({ host: "127.0.0.1", port, path: "/api/v1/task-types", method: "GET", timeout: 1000 }, (res) => {
        res.resume();
        ok();
      });
      req.on("error", () => (Date.now() > end ? fail(new Error(`端口 ${port} 等了 ${ms / 1000} 秒还没起来`)) : setTimeout(attempt, 200)));
      req.end();
    };
    attempt();
  });
}

function stopProcess(child: ChildProcess | null, ms = 20000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((ok) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      ok();
    }, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      ok();
    });
    child.kill("SIGTERM");
  });
}

interface SideConfig { name: string; kind: "python" | "typescript"; port: number; fakePort: number; dir: string }

function pythonEnv(): Dict {
  const env: Dict = { ...process.env, PYTHONPATH: [join(ROOT, "server"), join(ROOT, "observatory")].join(":") };
  for (const name of DROPPED_ENV) delete env[name];
  return env;
}

/** 一边：一个假端点加一个后端，以及它们用的目录。 */
class Side {
  readonly cfg: SideConfig;
  fake: ChildProcess | null = null;
  backend: ChildProcess | null = null;
  fakeUrl = "";
  constructor(cfg: SideConfig) {
    this.cfg = cfg;
  }
  get base() {
    return `http://127.0.0.1:${this.cfg.port}`;
  }
  get tasks() {
    return join(this.cfg.dir, "tasks");
  }
  get runs() {
    return join(this.cfg.dir, "runs");
  }
  get agentDir() {
    return join(this.cfg.dir, "pi-agent");
  }
  get fakeLog() {
    return join(this.cfg.dir, "fake.jsonl");
  }

  /** 起假端点。fakeKind 缺省是 TypeScript 版；fake_model 场景里 A 起 Python 版。 */
  async startFake(script: unknown, fakeKind: "python" | "typescript" = "typescript"): Promise<void> {
    rmSync(this.cfg.dir, { recursive: true, force: true });
    mkdirSync(this.tasks, { recursive: true });
    mkdirSync(this.runs, { recursive: true });
    writeFileSync(join(this.cfg.dir, "script.json"), JSON.stringify(script), "utf-8");
    const args = ["--script", join(this.cfg.dir, "script.json"), "--log", this.fakeLog, "--port", String(this.cfg.fakePort), "--agent-dir", this.agentDir];
    this.fake = fakeKind === "python"
      ? spawn(PYTHON, ["-m", "taskwright_server.fake_model", ...args], { env: pythonEnv(), stdio: ["ignore", "pipe", "pipe"] })
      : spawn(process.execPath, [FAKE_MAIN, ...args], { env: pythonEnv(), stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((ok, fail) => {
      let out = "";
      this.fake!.stdout!.on("data", (c) => {
        out += c;
        const m = /假端点已启动：(\S+)（/.exec(out);
        if (m) this.fakeUrl = m[1];
        if (out.includes("pi 配置目录已写好")) ok();
      });
      this.fake!.once("exit", () => fail(new Error(`假端点没有起来：${out}`)));
    });
  }

  async start(script: unknown): Promise<void> {
    await this.startFake(script);
    await this.startBackend();
  }

  async startBackend(): Promise<void> {
    const env = { ...pythonEnv(), PI_CODING_AGENT_DIR: this.agentDir, TASKWRIGHT_LOG_DIR: join(this.cfg.dir, "logs") };
    const args = ["--tasks", this.tasks, "--runs", this.runs, "--port", String(this.cfg.port), "--profile", "fake"];
    this.backend = this.cfg.kind === "python"
      ? spawn(PYTHON, ["-m", "taskwright_server.service", ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(process.execPath, [join(ROOT, "backend", "src", "main.mts"), ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const log = join(this.cfg.dir, `backend-${Date.now()}.log`);
    for (const stream of [this.backend.stdout!, this.backend.stderr!]) stream.on("data", (c) => writeFileSync(log, c, { flag: "a" }));
    await waitPort(this.cfg.port);
  }

  async stopBackend(): Promise<void> {
    await stopProcess(this.backend);
    this.backend = null;
  }

  async stop(): Promise<void> {
    await this.stopBackend();
    await stopProcess(this.fake);
    this.fake = null;
  }

  call(method: string, path: string, body?: unknown, raw?: Buffer, headers: Dict = {}, base = this.base): Promise<{ status: number; type: string; body: any }> {
    return new Promise((ok, fail) => {
      const data = raw ?? (body !== undefined ? Buffer.from(JSON.stringify(body), "utf-8") : undefined);
      const req = request(base + path, { method, headers: { ...(data ? { "Content-Length": String(data.length), "Content-Type": "application/json" } : {}), ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let parsed: any = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // 不是 JSON 就按文字留着
          }
          ok({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: parsed });
        });
      });
      req.on("error", fail);
      req.end(data);
    });
  }

  upload(taskId: string, name: string, text: string) {
    const body = Buffer.from(`--B\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n${text}\r\n--B--\r\n`, "utf-8");
    return this.call("POST", `/api/v1/tasks/${taskId}/materials`, undefined, body, { "Content-Type": "multipart/form-data; boundary=B" });
  }

  stream(path: string, lastEventId?: number): EventStream {
    return new EventStream(this.base + path, lastEventId);
  }
}

/** 一条事件流连接：把收到的事件收进列表，每项 {event, id?, data}。 */
class EventStream {
  readonly events: Dict[] = [];
  private req: ReturnType<typeof request>;
  constructor(url: string, lastEventId?: number) {
    this.req = request(url, { headers: lastEventId !== undefined ? { "Last-Event-ID": String(lastEventId) } : {} }, (res) => {
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let at;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event: Dict = {};
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event.event = line.slice(7);
            else if (line.startsWith("id: ")) event.id = Number(line.slice(4));
            else if (line.startsWith("data: ")) event.data = JSON.parse(line.slice(6));
          }
          if (event.event) this.events.push(event);
        }
      });
      res.on("error", () => {});
    });
    this.req.on("error", () => {});
    this.req.end();
  }
  async wait(pred: (e: Dict) => boolean, ms = 60000, after = 0): Promise<Dict> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.events.slice(after).find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    throw new Error(`等了 ${ms / 1000} 秒没等到想要的事件；已收到：${this.events.map((e) => e.event).join("、")}`);
  }
  count(name: string): number {
    return this.events.filter((e) => e.event === name).length;
  }
  close(): void {
    this.req.destroy();
  }
}

// ───────────── 场景用的小工具 ─────────────

interface Run {
  side: Side;
  record: (label: string, value: unknown) => void;
  streams: [string, EventStream][];
}

async function newTask(run: Run, material = SOURCE.excerpt, name = "测试任务"): Promise<string> {
  const created = await run.side.call("POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: name, domain_tag: "售后" });
  run.record(`建任务「${name}」`, created);
  const taskId = created.body.task_id;
  run.record("放材料", await run.side.upload(taskId, "材料.md", material));
  return taskId;
}

function openStream(run: Run, label: string, path: string, lastEventId?: number): EventStream {
  const stream = run.side.stream(path, lastEventId);
  run.streams.push([label, stream]);
  return stream;
}

/** 新建一条会话，等打开会话时的任务现状消息。 */
async function newSession(run: Run, t: string, stream: EventStream, label = "新建会话"): Promise<string> {
  const notes = stream.count("system_note");
  const created = await run.side.call("POST", `/api/v1/tasks/${t}/sessions`);
  run.record(label, created);
  await stream.wait((e) => e.event === "system_note" && stream.count("system_note") > notes);
  return created.body.session_id;
}

/** 等事件流里 name 这种事件的条数超过 before。 */
async function waitCount(stream: EventStream, name: string, before: number, ms = 60000): Promise<void> {
  const end = Date.now() + ms;
  while (stream.count(name) <= before) {
    if (Date.now() > end) throw new Error(`等了 ${ms / 1000} 秒，${name} 还是 ${before} 条；已收到：${stream.events.map((e) => e.event).join("、")}`);
    await sleep(50);
  }
}

/** 说一句话（或点一张卡片）并等这一轮工作结束。 */
async function say(run: Run, taskId: string, sid: string, text: string, clientId: string, stream: EventStream, extra: Dict = {}) {
  const ended = stream.count("work_ended");
  run.record(`说「${text}」`, await run.side.call("POST", `/api/v1/tasks/${taskId}/messages?session=${sid}`, { text, client_id: clientId, ...extra }));
  await waitCount(stream, "work_ended", ended);
  await sleep(300);
}

/**
 * 一次直接操作。until 给了就等事件流里出现那种事件（条数比操作前多），再等一会儿让同一批的其余事件到齐；
 * work 为真时等这次操作引出的一轮工作结束（带通知的操作）。
 */
async function act(run: Run, t: string, sid: string, label: string, body: Dict, stream: EventStream, until: string | null, work = false) {
  const before = until ? stream.count(until) : 0;
  const ended = stream.count("work_ended");
  const got = await run.side.call("POST", `/api/v1/tasks/${t}/actions?session=${sid}`, body);
  run.record(label, got);
  if (got.status === 200 && until) await waitCount(stream, until, before);
  if (got.status === 200 && work) await waitCount(stream, "work_ended", ended);
  await sleep(400);
}

const snapshot = (r: Run, t: string, sid?: string) => r.side.call("GET", `/api/v1/tasks/${t}/snapshot${sid ? `?session=${sid}` : ""}`);

/** 任务目录里的占用标记：两版都写端口、进程号、启动时刻、主机名；TypeScript 版另写 mode，比较时去掉（比较规则第 4 条）。 */
function lockOf(side: Side, t: string): unknown {
  const path = join(side.tasks, t, "service.lock");
  if (!existsSync(path)) return "没有占用标记";
  const lock = JSON.parse(readFileSync(path, "utf-8"));
  delete lock.mode;
  return { ...lock, pid: lock.pid === side.backend?.pid ? "<本边后端的进程号>" : lock.pid === process.pid ? "<对照脚本的进程号>" : "<别的进程号>",
    port: lock.port === side.cfg.port ? "<本边后端的端口>" : lock.port, host: lock.host === hostname() ? "<本机>" : lock.host };
}

// ───────────── 场景 ─────────────

interface Scenario {
  script: unknown;
  covers: string;
  /** 只对照两版假端点，不起后端。 */
  fakeOnly?: boolean;
  run: (r: Run) => Promise<void>;
}

const SCENARIOS: Record<string, Scenario> = {
  chat_opening: {
    covers: "打开会话收到任务现状消息；再开一条会话又收到一条；后端重启后续接旧会话（test_chat_opening，test_rpc 的开场与续接）",
    script: [replyWithIntent("你好，我在。"), replyWithIntent("续接之后也在。")],
    run: async (r) => {
      const t = await newTask(r);
      let stream = openStream(r, "任务事件流（重启之前）", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const first = await newSession(r, t, stream);
      r.record("整份数据（开场）", await snapshot(r, t, first));
      r.record("往前读对话（开场）", await r.side.call("GET", `/api/v1/tasks/${t}/conversation?session=${first}`));
      await say(r, t, first, "你好", "c-1", stream);
      const second = await newSession(r, t, stream, "新建第二条会话");
      r.record("整份数据（第二条会话开场）", await snapshot(r, t, second));
      stream.close();
      await r.side.stopBackend();
      await r.side.startBackend();
      stream = openStream(r, "任务事件流（重启之后）", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      r.record("重启后打开第一条会话", await snapshot(r, t, first));
      await sleep(1000);
      await say(r, t, first, "还在吗", "c-2", stream);
      r.record("往前读对话（续接之后）", await r.side.call("GET", `/api/v1/tasks/${t}/conversation?session=${first}`));
      r.record("会话列表", await r.side.call("GET", `/api/v1/tasks/${t}/sessions`));
    },
  },
  confirm_and_complete: {
    covers: "完成任务在有未读、未评审的条目时被拒；请确认卡片上点「这几条都看过了」（mark_viewed 带 notify_executor）引出一轮工作；" +
      "界面发起评审；之后完成任务；任务完成后直接操作与说话都是 task_closed（test_confirm_and_complete，test_service 的 task_closed）",
    script: { rules: [reviewer([])], sequence: [
      saveTwo,
      { tool_calls: [call("complete_task", {}, "call-complete-early")] },
      reply("整理了两个用例，请确认。", {}, { kind: "confirm", text: "请确认这两个用例。", items: [{ item_id: "UC-001", revision_no: 1 }, { item_id: "UC-002", revision_no: 1 }] }, "call-ask"),
      replyWithIntent("收到，你看过了。"),
      { text: INTENT, tool_calls: [call("complete_task", {}, "call-complete")] },
      reply("任务已经完成。", {}, null, "call-done"),
    ] },
    run: async (r) => {
      const t = await newTask(r);
      const stream = openStream(r, "任务事件流", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const sid = await newSession(r, t, stream);
      await say(r, t, sid, "把材料整理成用例，整理完就结束任务。", "c-1", stream);
      await act(r, t, sid, "卡片上点「这几条都看过了」", { client_id: "a-1", kind: "mark_viewed", notify_executor: true,
        targets: [{ item_id: "UC-001", base_revision: 1 }, { item_id: "UC-002", base_revision: 1 }] }, stream, "item_viewed", true);
      await act(r, t, sid, "界面发起评审", { client_id: "a-2", kind: "request_review", targets: [] }, stream, "review_finished");
      await stream.wait((e) => e.event === "ui_action_noted" && e.data.kind === "request_review");
      await sleep(300);
      await say(r, t, sid, "都看过了，完成吧。", "c-2", stream);
      r.record("整份数据（完成之后）", await snapshot(r, t, sid));
      r.record("完成之后改字段", await r.side.call("POST", `/api/v1/tasks/${t}/actions?session=${sid}`, { client_id: "a-3", kind: "edit_fields",
        targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 用例名称: "晚了" } }));
      r.record("完成之后说话", await r.side.call("POST", `/api/v1/tasks/${t}/messages?session=${sid}`, { text: "再改改", client_id: "c-3" }));
      r.record("任务列表", await r.side.call("GET", "/api/v1/tasks"));
      r.record("修订日志", await r.side.call("GET", `/api/v1/tasks/${t}/revisions`));
      r.record("生成文档", await r.side.call("POST", `/api/v1/tasks/${t}/documents/preview`, {}));
    },
  },
  fake_model: {
    covers: "两版假端点：规则优先与用完次数、第几次请求、序列与兜底、流式与非流式、同一轮两个工具调用、延迟、错误状态码，回答与请求记录（test_fake_model）",
    fakeOnly: true,
    script: {
      rules: [{ when: { last_role: "tool", last_contains: "被拒" }, reply: { text: "我改一下。" }, max_uses: 1 }, { when: { request_no: 6 }, reply: { text: "第六次。" } },
        { when: { any_contains: "你是评审者" }, reply: { text: JSON.stringify({ 发现: [UC_R7] }) } }],
      sequence: [saveTwo, { tool_calls: [call("read", { path: "a.md" }), call("ls", { path: "inputs" }, "call-ls")] }, { text: "慢。", delay: 0.5 },
        { status: 503, error_body: "暂时不可用" }, { status: 500 }],
      default: { text: "兜底。" },
    },
    run: async (r) => {
      const user = (text: string, stream: boolean) => ({ model: "fake-model", stream, messages: [{ role: "user", content: text }] });
      const bodies: [string, Dict][] = [
        ["保存两个用例（流式）", user("整理一下", true)],
        ["同一轮两个工具调用（非流式）", { ...user("读一下", false), tools: [{ type: "function", function: { name: "ls" } }] }],
        ["工具被拒之后的规则（流式）", { model: "fake-model", stream: true, messages: [{ role: "user", content: "x" }, { role: "tool", content: [{ type: "text", text: "调用被拒：缺字段" }] }] }],
        ["规则用完之后回到序列：延迟", user("慢慢说", true)],
        ["评审者的规则", { model: "fake-model", stream: false, messages: [{ role: "system", content: "你是评审者。" }, { role: "user", content: "评一下" }] }],
        ["第六次请求的规则", user("第六次", false)],
        ["错误状态码 503", user("出错", true)],
        ["错误状态码 500，没写错误说明", user("又出错", false)],
        ["序列用完之后的兜底", user("还有吗", true)],
        ["没有的地址", {}],
      ];
      for (const [label, body] of bodies) {
        const path = label === "没有的地址" ? "/v1/embeddings" : "/v1/chat/completions";
        const got = await r.side.call("POST", path, body, undefined, {}, r.side.fakeUrl.replace(/\/v1$/, ""));
        const chunks = typeof got.body === "string" && got.body.startsWith("data: ")
          ? got.body.split("\n").filter((l: string) => l.startsWith("data: ")).map((l: string) => (l === "data: [DONE]" ? "[DONE]" : JSON.parse(l.slice(6)))) : got.body;
        r.record(label, { status: got.status, type: got.type, body: chunks });
      }
      r.record("取模型清单", await r.side.call("GET", "/v1/models", undefined, undefined, {}, r.side.fakeUrl.replace(/\/v1$/, "")));
      r.record("pi 配置目录", Object.fromEntries(["models.json", "settings.json", "auth.json"].map((f) => [f, readFileSync(join(r.side.agentDir, f), "utf-8")])));
    },
  },
  intent: {
    covers: "没写理解就保存被拒、写了理解之后通过、「理解为」一行的推进（test_intent）",
    script: [saveUc(false), saveUc(true), reply("存好了。")],
    run: async (r) => {
      const t = await newTask(r);
      const stream = openStream(r, "任务事件流", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const sid = await newSession(r, t, stream);
      await say(r, t, sid, "整理一下", "c-1", stream);
      r.record("整份数据", await snapshot(r, t, sid));
      r.record("修订日志", await r.side.call("GET", `/api/v1/tasks/${t}/revisions`));
    },
  },
  isolation: {
    covers: "两个任务各有自己的会话、事件流与库，互不干扰；占用标记写的是本服务；别的活着的进程占用的任务列为占用中、打开是 task_occupied，" +
      "退出时只删自己的标记（test_isolation，test_service 的占用）",
    script: [saveUc(), reply("第一个任务存好了。"), saveUc(), reply("第二个任务存好了。")],
    run: async (r) => {
      const t1 = await newTask(r, SOURCE.excerpt, "第一个任务");
      const t2 = await newTask(r, SOURCE.excerpt, "第二个任务");
      const s1 = openStream(r, "第一个任务的事件流", `/api/v1/tasks/${t1}/events`);
      let s2 = openStream(r, "第二个任务的事件流", `/api/v1/tasks/${t2}/events`);
      await sleep(300);
      const sid1 = await newSession(r, t1, s1);
      await say(r, t1, sid1, "整理一下", "c-1", s1);
      const sid2 = await newSession(r, t2, s2);
      await say(r, t2, sid2, "整理一下", "c-2", s2);
      r.record("第一个任务的整份数据", await snapshot(r, t1, sid1));
      r.record("第二个任务的整份数据", await snapshot(r, t2, sid2));
      r.record("第一个任务的占用标记", lockOf(r.side, t1));
      r.record("第二个任务的占用标记", lockOf(r.side, t2));
      r.record("拿第一个任务的会话去第二个任务说话", await r.side.call("POST", `/api/v1/tasks/${t2}/messages?session=${sid1}`, { text: "串门", client_id: "c-3" }));
      s2.close();
      await r.side.stopBackend();
      r.record("停服务之后第一个任务的占用标记", lockOf(r.side, t1));
      // 第二个任务交给「别的活着的服务」（对照脚本自己的进程号）占着，再起服务。
      writeFileSync(join(r.side.tasks, t2, "service.lock"), JSON.stringify({ port: 1, pid: process.pid, started_at: "2026-09-26T08:00:00", host: hostname() }), "utf-8");
      await r.side.startBackend();
      r.record("任务列表（第二个任务被别人占着）", await r.side.call("GET", "/api/v1/tasks"));
      r.record("打开被占着的任务", await r.side.call("GET", `/api/v1/tasks/${t2}`));
      r.record("被占着的任务的整份数据", await snapshot(r, t2));
      r.record("第一个任务照常打开", await r.side.call("GET", `/api/v1/tasks/${t1}`));
      await r.side.stopBackend();
      r.record("再停服务之后第二个任务的占用标记", lockOf(r.side, t2));
    },
  },
  reply: {
    covers: "三句话：一句保存修订加回复、一句只回复、一句不经回复工具直接输出正文（兜底扩展追加一句、后端兜底转发正文）；再一句什么都没说（problem no_reply）（test_reply）",
    // 脚本用完之后回空文字（不写 default 时假端点回「好的。」），最后一句话才会什么都没说。
    script: { sequence: [saveUc(), reply("存好了。"), replyWithIntent("收到。"), { text: "我直接说了。" }, { text: "还是直接说。" }], default: { text: "" } },
    run: async (r) => {
      const t = await newTask(r);
      const stream = openStream(r, "任务事件流", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const sid = await newSession(r, t, stream);
      await say(r, t, sid, "整理一下", "c-1", stream);
      await say(r, t, sid, "好的", "c-2", stream);
      await say(r, t, sid, "你直接说吧", "c-3", stream);
      await say(r, t, sid, "还有吗", "c-4", stream);
      r.record("整份数据", await snapshot(r, t, sid));
      r.record("修订日志", await r.side.call("GET", `/api/v1/tasks/${t}/revisions`));
    },
  },
  review_gate: {
    covers: "执行者调用请求评审（发现带规则编号、必选规则不合规）；界面发起评审：已评过被拒、force 再评、上一批还在评时被拒；" +
      "保留写法与撤销保留；改评审规则之后再评；review_progress 到 review_finished 的库事件（test_review_gate）",
    script: { rules: [reviewer([UC_R7], { delay: 1.5 })], sequence: [
      saveTwo,
      { tool_calls: [call("request_review", { items: [{ item_id: "UC-001", revision_no: 1 }] }, "call-review")] },
      reply("UC-001 评审不通过，有一处问题。", {}, null, "call-done"),
    ] },
    run: async (r) => {
      const t = await newTask(r);
      const stream = openStream(r, "任务事件流", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const sid = await newSession(r, t, stream);
      await say(r, t, sid, "把材料整理成用例，然后评审一下 UC-001。", "c-1", stream);
      await act(r, t, sid, "界面再评 UC-001（已评过）", { client_id: "a-1", kind: "request_review", targets: [{ item_id: "UC-001", base_revision: 1 }] }, stream, null);
      const finished = stream.count("review_finished");
      r.record("界面强制再评 UC-001", await r.side.call("POST", `/api/v1/tasks/${t}/actions?session=${sid}`, { client_id: "a-2", kind: "request_review", force: true,
        targets: [{ item_id: "UC-001", base_revision: 1 }] }));
      r.record("上一批还在评时再评 UC-002", await r.side.call("POST", `/api/v1/tasks/${t}/actions?session=${sid}`, { client_id: "a-3", kind: "request_review",
        targets: [{ item_id: "UC-002", base_revision: 1 }] }));
      await waitCount(stream, "review_finished", finished);
      await sleep(800);
      await act(r, t, sid, "保留 UC-001 的写法", { client_id: "a-4", kind: "waive_review", targets: [{ item_id: "UC-001", base_revision: 1 }],
        fields: { reason: "流程另有规定", source: "panel" } }, stream, "review_waived");
      await act(r, t, sid, "再保留一次（已经保留过）", { client_id: "a-5", kind: "waive_review", targets: [{ item_id: "UC-001", base_revision: 1 }] }, stream, null);
      await act(r, t, sid, "撤销保留", { client_id: "a-6", kind: "unwaive_review", targets: [{ item_id: "UC-001", base_revision: 1 }] }, stream, "review_unwaived");
      await act(r, t, sid, "关掉可选规则 UC-R2", { client_id: "a-7", kind: "set_review_rules", fields: { collection: "功能用例", off: ["UC-R2"], promote: [] } },
        stream, "review_rules_changed");
      await act(r, t, sid, "规则没变再改一次", { client_id: "a-8", kind: "set_review_rules", fields: { collection: "功能用例", off: ["UC-R2"], promote: [] } }, stream, null);
      await act(r, t, sid, "改了规则之后评全部", { client_id: "a-9", kind: "request_review", targets: [] }, stream, "review_finished");
      await stream.wait((e) => e.event === "ui_action_noted" && e.data.kind === "request_review" && stream.events.filter((x) => x.event === "ui_action_noted" && x.data.kind === "request_review").length >= 2);
      await sleep(500);
      r.record("整份数据", await snapshot(r, t, sid));
      r.record("往前读对话", await r.side.call("GET", `/api/v1/tasks/${t}/conversation?session=${sid}`));
    },
  },
  rpc: {
    covers: "新建第二条会话、在两条会话之间切换、闲聊不写库、后端重启（pi 按关闭顺序停下）之后 pi 不在时直接操作是 executor_unavailable、" +
      "打开旧会话续接（续接前改写会话文件记的工作目录）（test_rpc）",
    script: [replyWithIntent("第一条会话里回你。"), replyWithIntent("第二条会话里回你。"), replyWithIntent("随便聊聊。"), replyWithIntent("续接之后回你。")],
    run: async (r) => {
      const t = await newTask(r);
      let stream = openStream(r, "任务事件流（重启之前）", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const first = await newSession(r, t, stream);
      await say(r, t, first, "第一句", "c-1", stream);
      const second = await newSession(r, t, stream, "新建第二条会话");
      r.record("打开第二条会话", await snapshot(r, t, second));
      await say(r, t, second, "第二句", "c-2", stream);
      r.record("切回第一条会话", await snapshot(r, t, first));
      await say(r, t, first, "今天天气不错", "c-3", stream);
      r.record("闲聊之后的整份数据序号", (await snapshot(r, t)).body.seq);
      r.record("会话列表", await r.side.call("GET", `/api/v1/tasks/${t}/sessions`));
      stream.close();
      await r.side.stopBackend();
      await r.side.startBackend();
      stream = openStream(r, "任务事件流（重启之后）", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      r.record("重启之后、打开会话之前直接操作（pi 还没起）", await r.side.call("POST", `/api/v1/tasks/${t}/actions?session=${first}`, { client_id: "a-0", kind: "mark_viewed", targets: [] }));
      r.record("重启后打开第一条会话", await snapshot(r, t, first));
      await sleep(1000);
      await say(r, t, first, "续接之后说一句", "c-4", stream);
      r.record("续接之后的整份数据", await snapshot(r, t, first));
      r.record("会话列表（重启之后）", await r.side.call("GET", `/api/v1/tasks/${t}/sessions`));
    },
  },
  save_replay: {
    covers: "同一调用编号的保存修订连发两次只写一次；断线时用户改字段，带 Last-Event-ID 重连补发缺的库事件、每条只发一次；差距超过补发窗口发 resync" +
      "（test_save_replay，test_service 的补发）",
    script: [{ text: INTENT, tool_calls: [save([add("功能用例", UC)], "call-replayed")] }, { tool_calls: [save([add("功能用例", UC)], "call-replayed")] }, reply("存好了。")],
    run: async (r) => {
      const t = await newTask(r);
      const stream = openStream(r, "任务事件流", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const sid = await newSession(r, t, stream);
      await say(r, t, sid, "整理一下", "c-1", stream);
      stream.close();
      r.record("断线时改字段", await r.side.call("POST", `/api/v1/tasks/${t}/actions?session=${sid}`, { kind: "edit_fields",
        targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 用例名称: "断线时改的" } }));
      await sleep(500);
      const again = openStream(r, "带 Last-Event-ID 1 重连", `/api/v1/tasks/${t}/events`, 1);
      await again.wait((e) => (e.id ?? 0) >= 5);
      await sleep(800);
      again.close();
      const done = spawnSync(process.execPath, [SEED, "many-events", join(r.side.tasks, t), "UC-001", "2", "510"], { encoding: "utf-8" });
      if (done.status !== 0) throw new Error(`造数失败：${done.stderr}`);
      // pi 还在跑，后端每 2 秒兜底查一次库，会把这几百条转发给在线的订阅者；等它转发完再连，这条连接就只收到 resync。
      await sleep(5000);
      const far = openStream(r, "差距太大", `/api/v1/tasks/${t}/events?last_event_id=1`);
      await far.wait((e) => e.event === "resync");
      await sleep(300);
      far.close();
      r.record("整份数据的序号", (await snapshot(r, t)).body.seq);
      r.record("修订日志", await r.side.call("GET", `/api/v1/tasks/${t}/revisions`));
    },
  },
  service: {
    covers: "打开会话、斜杠开头的话照原样显示、附件模板、保存修订与回复、过程摘要与刷新后重算；工作中三种 session_busy（新建会话、对另一条会话说话、" +
      "本会话再说一句）与直接操作被拒、写已读例外；让助手停下（cleared 与 stopped_by_user）；改字段、过期修订号、撤回确认、写已读、" +
      "已退役的 confirm、删除条目、撤销、撤销冲突；修订日志、文档、任务页（test_service）",
    script: [
      saveUc(), reply("存好了。"),
      replyWithIntent("看到了附件。"),
      replyWithIntent("慢慢说完。", { delay: 4 }),
      replyWithIntent("好。"),
      replyWithIntent("这句不会说完。", { delay: 8 }),
      replyWithIntent("接着来。"),
    ],
    run: async (r) => {
      const t = await newTask(r);
      const stream = openStream(r, "任务事件流", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const sid = await newSession(r, t, stream);
      r.record("整份数据（说话之前）", await snapshot(r, t, sid));
      await say(r, t, sid, "/整理一下", "c-1", stream);
      await stream.wait((e) => e.event === "work_summary");
      r.record("整份数据（说话之后）", await snapshot(r, t, sid));
      r.record("往前读对话", await r.side.call("GET", `/api/v1/tasks/${t}/conversation?session=${sid}&limit=2`));
      await say(r, t, sid, "看看这份", "c-2", stream, { attachments: ["inputs/材料.md"] });
      // 执行者工作中（慢回复的 4 秒里）。
      r.record("说一句（慢慢回）", await r.side.call("POST", `/api/v1/tasks/${t}/messages?session=${sid}`, { text: "慢慢来", client_id: "c-3" }));
      await stream.wait((e) => e.event === "work_started" && stream.count("work_started") >= 3);
      await sleep(300);
      r.record("工作中新建会话", await r.side.call("POST", `/api/v1/tasks/${t}/sessions`));
      r.record("工作中对另一条会话说话", await r.side.call("POST", `/api/v1/tasks/${t}/messages?session=01a0c000-0000-7000-8000-000000000000`, { text: "插一句" }));
      r.record("工作中在本会话再说一句", await r.side.call("POST", `/api/v1/tasks/${t}/messages?session=${sid}`, { text: "再说一句", client_id: "c-4" }));
      r.record("工作中撤销", await r.side.call("POST", `/api/v1/tasks/${t}/actions?session=${sid}`, { client_id: "a-busy", kind: "undo", targets: [{ revision_no: 1 }] }));
      r.record("工作中写已读", await r.side.call("POST", `/api/v1/tasks/${t}/actions?session=${sid}`, { client_id: "a-seen", kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] }));
      r.record("工作中点「这几条都看过了」", await r.side.call("POST", `/api/v1/tasks/${t}/actions?session=${sid}`, { client_id: "a-card", kind: "mark_viewed",
        targets: [{ item_id: "UC-001", base_revision: 1 }], notify_executor: true }));
      r.record("工作中点卡片", await r.side.call("POST", `/api/v1/tasks/${t}/messages?session=${sid}`, { text: "我选：甲", client_id: "k-0", origin: "card_choice",
        annotation: { reply_message_id: "00000000", option_key: "a", option_text: "甲" } }));
      await waitCount(stream, "work_ended", 2);
      await sleep(300);
      await say(r, t, sid, "再说一句", "c-4", stream);
      // 让助手停下：慢回复的 8 秒里停。
      const ended = stream.count("work_ended");
      const starts = stream.count("work_started");
      r.record("说一句（会被停下）", await r.side.call("POST", `/api/v1/tasks/${t}/messages?session=${sid}`, { text: "做一件长的事", client_id: "c-5" }));
      await waitCount(stream, "work_started", starts);
      await sleep(500);
      r.record("停另一条会话", await r.side.call("POST", `/api/v1/tasks/${t}/control`, { action: "stop", session_id: "01a0c000-0000-7000-8000-000000000000" }));
      r.record("control 的 action 写错", await r.side.call("POST", `/api/v1/tasks/${t}/control?session=${sid}`, { action: "pause" }));
      r.record("让助手停下", await r.side.call("POST", `/api/v1/tasks/${t}/control?session=${sid}`, { action: "stop" }));
      await waitCount(stream, "work_ended", ended);
      await sleep(9000);
      await say(r, t, sid, "继续", "c-6", stream);
      // 直接操作。
      await act(r, t, sid, "改字段", { client_id: "a-1", kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 用例名称: "买家提交退货申请" } },
        stream, "ui_action_noted");
      await act(r, t, sid, "拿过期的修订号改字段", { client_id: "a-2", kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 用例名称: "晚了" } }, stream, null);
      await act(r, t, sid, "撤回确认", { client_id: "a-3", kind: "unconfirm", targets: [{ item_id: "UC-001", base_revision: 2 }] }, stream, "confirmation_recorded");
      await act(r, t, sid, "写已读", { client_id: "a-4", kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 2 }] }, stream, "item_viewed");
      await act(r, t, sid, "已退役的 confirm", { client_id: "a-5", kind: "confirm", targets: [{ item_id: "UC-001", base_revision: 2 }] }, stream, null);
      await act(r, t, sid, "删除条目", { client_id: "a-6", kind: "delete_item", targets: [{ item_id: "UC-001", base_revision: 2 }] }, stream, "ui_action_noted");
      await act(r, t, sid, "撤销删除", { client_id: "a-7", kind: "undo", targets: [{ revision_no: 3 }] }, stream, "ui_action_noted");
      await act(r, t, sid, "撤销修订 2（之后又改过）", { client_id: "a-8", kind: "undo", targets: [{ revision_no: 2 }] }, stream, null);
      r.record("整份数据（最后）", await snapshot(r, t, sid));
      r.record("UC-001 的修订史", await r.side.call("GET", `/api/v1/tasks/${t}/items/UC-001/revisions`));
      r.record("修订日志", await r.side.call("GET", `/api/v1/tasks/${t}/revisions`));
      r.record("会话列表", await r.side.call("GET", `/api/v1/tasks/${t}/sessions`));
      r.record("任务页", await r.side.call("GET", `/api/v1/tasks/${t}`));
      r.record("任务列表", await r.side.call("GET", "/api/v1/tasks"));
      r.record("按修订 1 生成文档", await r.side.call("POST", `/api/v1/tasks/${t}/documents/preview`, { revision_no: 1 }));
      r.record("按最新修订生成文档", await r.side.call("POST", `/api/v1/tasks/${t}/documents/preview`, {}));
    },
  },
  tool_rejection: {
    covers: "保存修订被拒（没有这个集合）、回复被拒（缺 text）之后改对；请选择卡片，卡片点击两种写法（card 与 annotation）合成 card_choice；" +
      "没写理解被门禁拒绝（test_tool_rejection，test_service 的卡片点击）",
    script: [
      { text: INTENT, tool_calls: [save([add("没有这个集合", UC)], "call-bad")] },
      { tool_calls: [save([add("功能用例", UC)], "call-good")] },
      { tool_calls: [call("reply", { informs: [], act: null }, "call-reply-bad")] },
      reply("逾期的买家能不能退货？", {}, { kind: "choose", text: "逾期的买家能不能退货？", items: [{ item_id: "UC-001", revision_no: 1 }],
        options: [{ key: "allow", text: "允许退货" }, { key: "deny", text: "不允许退货" }] }, "call-reply-good"),
      reply("记下了，不允许退货。"),
      reply("改成允许退货。"),
      { tool_calls: [save([add("功能用例", UC2)], "call-no-intent")] },
      { text: INTENT, tool_calls: [save([add("功能用例", UC2)], "call-with-intent")] },
      reply("第二个也存好了。"),
    ],
    run: async (r) => {
      const t = await newTask(r);
      const stream = openStream(r, "任务事件流", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const sid = await newSession(r, t, stream);
      await say(r, t, sid, "把材料整理成用例。", "c-1", stream);
      const asked = stream.events.filter((e) => e.event === "assistant_reply").at(-1)!.data;
      await say(r, t, sid, "我选：不允许退货", "k-1", stream, { origin: "card_choice", card: { reply_message_id: asked.message_id, kind: "choose", choice: "deny" } });
      await say(r, t, sid, "我选：允许退货", "k-2", stream, { origin: "card_choice",
        annotation: { reply_message_id: asked.message_id, option_key: "allow", option_text: "允许退货" } });
      await say(r, t, sid, "再存一个撤回的用例", "c-2", stream);
      r.record("整份数据", await snapshot(r, t, sid));
      r.record("往前读对话", await r.side.call("GET", `/api/v1/tasks/${t}/conversation?session=${sid}`));
      r.record("修订日志", await r.side.call("GET", `/api/v1/tasks/${t}/revisions`));
    },
  },
};

// ───────────── 归档、会话文件与观测台 ─────────────

function readLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { 不是JSON的行: l };
    }
  });
}

/**
 * pi 流式输出过程中的中间快照（message_start、message_update）里的 usage 与 responseId，取决于模型端点的数据块什么时候到达 pi，
 * 是 pi 内部的时序，与后端无关（后端对原始事件流原样照写）；对照时去掉这两项，其余照比。
 */
function stripStreamingSnapshot(line: unknown): unknown {
  if (!line || typeof line !== "object") return line;
  const type = (line as Dict).type;
  if (type !== "message_update" && type !== "message_start") return line;
  const drop = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(drop);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "usage" && k !== "responseId").map(([k, x]) => [k, drop(x)]));
    return v;
  };
  return drop(line);
}

/** 归档目录下的三种文件与会话文件（按文件的先后排，文件名里的时刻由归一化处理），以及假端点的请求记录。 */
function archives(side: Side): Dict {
  const out: Dict = {};
  if (!existsSync(side.runs)) return out;
  for (const task of readdirSync(side.runs).sort()) {
    const events = join(side.runs, task, "pi-events");
    const sessions = join(side.runs, task, "pi-sessions", "service");
    const files = existsSync(events) ? readdirSync(events).sort() : [];
    const byKind = (suffix: string) => files.filter((f) => f.endsWith(suffix) && (suffix !== ".jsonl" || (!f.endsWith(".backend.jsonl") && !f.endsWith(".times.jsonl"))));
    out[task] = {
      // 后端发的命令（取条目、起会话名之类）的回应与 pi 自己的事件在标准输出里交错，交错的先后取决于时序；两列各自按先后比。
      原始事件流: byKind(".jsonl").map((f) => {
        const lines = readLines(join(events, f)).map(stripStreamingSnapshot) as Dict[];
        const answered = (l: Dict) => l && (l.type === "response" || l.type === "session_info_changed");
        return { 文件: f, 行数: lines.length, 命令的回应: lines.filter(answered), 其余事件: lines.filter((l) => !answered(l)) };
      }),
      后端补记: byKind(".backend.jsonl").map((f) => ({ 文件: f, 行: readLines(join(events, f)) })),
      收到时刻: byKind(".times.jsonl").map((f) => ({ 文件: f, 行数: readLines(join(events, f)).length, 行号: readLines(join(events, f)).map((x: any) => x["行号"]) })),
      会话文件: existsSync(sessions) ? readdirSync(sessions).filter((f) => f.endsWith(".jsonl")).sort().map((f) => ({ 文件: f, 行: readLines(join(sessions, f)) })) : [],
    };
  }
  out.假端点的请求记录 = readLines(side.fakeLog);
  return out;
}

/** 观测台读这一边的归档与任务目录：会话列表与每条会话的详情。 */
function observatory(side: Side): unknown {
  if (!existsSync(side.runs)) return {};
  const script = `
import json, sys
from pathlib import Path
from taskwright_observatory.api import Index
out = {}
runs, tasks = Path(sys.argv[1]), Path(sys.argv[2])
for d in sorted(p for p in runs.iterdir() if p.is_dir()):
    index = Index(d, tasks)
    listing = index.session_list()
    out[d.name] = {"会话列表": listing, "会话详情": [index.session_detail(s["会话编号"]) for s in index.sessions if s["会话编号"]]}
print(json.dumps(out, ensure_ascii=False, default=str))
`;
  const done = spawnSync(PYTHON, ["-c", script, side.runs, side.tasks], { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024, env: pythonEnv() });
  if (done.status !== 0) return { 观测台读不出来: done.stderr.slice(-2000) };
  return JSON.parse(done.stdout);
}

// ───────────── 归一化 ─────────────

const ENTRY_KEYS = new Set(["message_id", "triggered_by", "entry_id", "earliest_id", "reply_message_id", "click_message_id", "id", "parentId", "会话条目编号",
  "user_entry", "reply_entry", "source_entry", "user_message_id", "条目编号", "firstKeptEntryId"]);

/** 把一边的观察里随运行变化的东西换成占位写法：编号按首次出现的先后编号，时刻、耗时、进程号、路径、端口换成固定的字。 */
class Normalizer {
  private maps = new Map<string, Map<string, string>>();
  private entries = new Set<string>();
  private side: Side;
  constructor(side: Side) {
    this.side = side;
  }

  private label(kind: string, value: string): string {
    if (!this.maps.has(kind)) this.maps.set(kind, new Map());
    const map = this.maps.get(kind)!;
    if (!map.has(value)) map.set(value, `<${kind}${map.size + 1}>`);
    return map.get(value)!;
  }

  /** 先把所有像会话条目编号（八位十六进制）的键值收起来，之后在任何文字里出现都按它换。 */
  collect(value: unknown, key = ""): void {
    if (typeof value === "string") {
      if (ENTRY_KEYS.has(key) && /^[0-9a-f]{8}$/.test(value)) this.entries.add(value);
      for (const m of value.matchAll(/(?:^|[^0-9A-Za-z])(?:w-|summary-)([0-9a-f]{8})(?![0-9A-Za-z])/g)) this.entries.add(m[1]);
    } else if (Array.isArray(value)) value.forEach((v) => this.collect(v, key));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) this.collect(v, k);
  }

  text(input: string): string {
    let out = input;
    for (const [path, name] of [[resolve(this.side.cfg.dir), "<工作目录>"]] as const) out = out.split(path).join(name);
    out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => this.label("会话", m));
    out = out.replace(/TASK-\d{8}-[0-9A-F]{4}/g, (m) => this.label("任务", m));
    out = out.replace(/work-[0-9a-f]{12}/g, (m) => this.label("工作", m));
    out = out.replace(/ui-op-[0-9a-f]{12}/g, (m) => this.label("操作", m));
    out = out.replace(/(?<![0-9A-Za-z])[0-9a-f]{8}(?![0-9A-Za-z])/g, (m) => (this.entries.has(m) ? this.label("条目", m) : m));
    out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, "<时刻>");
    out = out.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?/g, "<时刻>");
    out = out.replace(/(?<![0-9])\d{2}:\d{2}:\d{2}(?![0-9])/g, "<时分秒>");
    out = out.replace(/(?<![0-9])1\d{12}(?![0-9])/g, "<时刻数>");
    out = out.replace(/\d{8}-\d{6}/g, "<时刻>");
    out = out.replace(/\b(896[0-9])\b/g, "<端口>");
    out = out.replace(/\/usr\/[^\s"]*\/python3?[0-9.]*|\/[^\s"]*\/(node|python3?)\b/g, "<解释器>");
    return out;
  }

  value(value: unknown, key = ""): unknown {
    if (typeof value === "string") return this.text(value);
    if (typeof value === "number") {
      if (["seconds", "收到时刻", "timestamp", "created", "delay_ms", "duration", "durationMs", "pid", "进程号", "启动时刻", "开始时刻", "结束时刻"].includes(key)
        || key.includes("耗时") || key.endsWith("行号")) return `<${key}>`;
      if (value > 1e9 && value < 3e12) return "<时刻数>";
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => this.value(v, key));
    if (value && typeof value === "object") {
      const out: Dict = {};
      for (const k of Object.keys(value).sort()) out[this.text(k)] = this.value((value as Dict)[k], k);
      return out;
    }
    return value;
  }
}

/** 事件流：executor_state 与其它事件各自按先后排成两列（比较规则第 1 条）；库事件的 completion 只留最后一条的（第 5 条）。 */
function splitStream(events: Dict[]) {
  const library = (e: Dict) => e.id !== undefined && e.data && typeof e.data === "object" && "completion" in e.data;
  const last = events.findLastIndex(library);
  const shown = events.map((e, i) => (library(e) && i !== last ? { ...e, data: { ...e.data, completion: "<批次中间的一条，不比>" } } : e));
  return { 执行者状态: shown.filter((e) => e.event === "executor_state"), 其它事件: shown.filter((e) => e.event !== "executor_state") };
}

function diff(a: unknown, b: unknown, path = "", out: [string, unknown, unknown][] = []): [string, unknown, unknown][] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff((a as Dict)[k], (b as Dict)[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  out.push([path || "（整体）", a, b]);
  return out;
}

// ───────────── 主流程 ─────────────

const { values } = parseArgs({ options: { work: { type: "string" }, only: { type: "string" }, out: { type: "string" }, ports: { type: "string" } }, strict: true });
if (!values.work) {
  process.stderr.write("用法：node backend/compare/sessions.mts --work <空目录> [--only 场景名,…] [--out 结果.json]\n");
  process.exit(2);
}
const [portA, portB, fakeA, fakeB] = (values.ports ?? "8960,8961,8962,8963").split(",").map(Number);
const work = resolve(values.work);
const chosen = values.only ? values.only.split(",") : Object.keys(SCENARIOS);
for (const name of chosen) {
  if (!SCENARIOS[name]) {
    process.stderr.write(`没有场景 ${name}；有这些：${Object.keys(SCENARIOS).join("、")}\n`);
    process.exit(2);
  }
}
const report: Dict[] = [];
let failures = 0;
for (const name of chosen) {
  const scenario = SCENARIOS[name];
  const sides = [
    new Side({ name: "A", kind: "python", port: portA, fakePort: fakeA, dir: join(work, name, "A") }),
    new Side({ name: "B", kind: "typescript", port: portB, fakePort: fakeB, dir: join(work, name, "B") }),
  ];
  const observed: Dict[] = [];
  for (const side of sides) {
    const records: [string, unknown][] = [];
    const run: Run = { side, record: (label, value) => records.push([label, value]), streams: [] };
    try {
      if (scenario.fakeOnly) await side.startFake(scenario.script, side.cfg.kind);
      else await side.start(scenario.script);
      await scenario.run(run);
      await sleep(500);
    } catch (error) {
      records.push(["场景没有跑完", (error as Error).message]);
    } finally {
      for (const [, stream] of run.streams) stream.close();
      await side.stop();
    }
    const whole: Dict = {
      观察: Object.fromEntries(records.map(([label, value], i) => [`${String(i + 1).padStart(2, "0")} ${label}`, value])),
      事件流: Object.fromEntries(run.streams.map(([label, stream]) => [label, splitStream(stream.events)])),
      归档: archives(side),
      观测台: observatory(side),
    };
    const normalizer = new Normalizer(side);
    normalizer.collect(whole);
    observed.push(normalizer.value(whole) as Dict);
  }
  const sections = ["观察", "事件流", "归档", "观测台"];
  const result: Dict = { 场景: name, 覆盖: scenario.covers, 各部分: {} };
  for (const section of sections) {
    const differences = diff(observed[0][section], observed[1][section]);
    result.各部分[section] = { 一致: differences.length === 0, 差异: differences.slice(0, 200) };
    if (differences.length) failures += 1;
    process.stdout.write(`${differences.length ? "差异" : "一致"}  ${name} / ${section}${differences.length ? `（${differences.length} 处）` : ""}\n`);
    for (const [path, x, y] of differences.slice(0, 8)) {
      process.stdout.write(`      ${path}\n        A: ${JSON.stringify(x)?.slice(0, 240)}\n        B: ${JSON.stringify(y)?.slice(0, 240)}\n`);
    }
  }
  result.A = observed[0];
  result.B = observed[1];
  report.push(result);
}
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n", "utf-8");
process.stdout.write(`\n共 ${chosen.length} 个场景、${chosen.length * 4} 部分，有差异的部分 ${failures} 个。\n`);
process.exit(failures ? 1 : 0);
