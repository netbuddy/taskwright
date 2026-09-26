/**
 * 会话场景的双跑对照：两版后端各配一个假模型端点，按同一份脚本、同一串操作各跑一遍，比较事件流、响应、归档与观测台读出的数据。
 *
 * 用法：
 *   node backend/compare/sessions.mts --work <空目录> [--only 场景名,…] [--out 结果.json]
 *        [--ports 8960,8961,8962,8963]（A 后端、B 后端、A 的假端点、B 的假端点）
 *
 * A 是 Python 版（python -m taskwright_server.service），B 是 TypeScript 版（node backend/src/main.mts），都用启动配置 fake，
 * pi 的配置目录由假端点写好、经 PI_CODING_AGENT_DIR 指过去。每个场景重起一套，任务目录与归档目录都在 --work 下、两边互不共享。
 * Python 解释器可用环境变量 TASKWRIGHT_PYTHON 指定（需要能 import taskwright_server 与 taskwright_observatory）。
 *
 * 每个场景记下一串观察：HTTP 响应（状态码与正文）、事件流收到的全部事件、最后的三种归档文件、会话文件、观测台读出的会话列表与会话详情。
 * 归一化之后逐条比较（规则见 Normalizer）。事件流里 executor_state 与其它事件的相对先后不比，两类各自按先后比：
 * Python 版在启动 pi 时先起读事件的线程、再报「空闲」，两个线程之间谁先推事件不固定。
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = process.env.TASKWRIGHT_PYTHON || "python3";
const SEED = join(ROOT, "agent", "tests", "fixtures", "seed_compare_task.mts");
const DROPPED_ENV = ["TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "TASKWRIGHT_RUNS_DIR", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL", "LANGFUSE_TRACING_ENVIRONMENT", "PI_CODING_AGENT_DIR", "TASKWRIGHT_TASKS_ROOT"];
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

type Dict = Record<string, any>;

// ───────────── 假模型脚本 ─────────────

/** 执行者每轮要先写一份理解（agent/prompts/schemas/user_intent.schema.json），这里写在回答的文字里。 */
const INTENT = '```json\n{"acts": [{"function": "request", "confidence": "high", "summary": "照用户说的做"}]}\n```';
const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "买家可以申请退货。" };
const UC = { 用例名称: "提交退货申请", 用例功能: "买家提交退货申请。", 参与者: ["买家"], 基本流程: ["买家打开订单", "系统记下申请"] };
const call = (name: string, args: Dict) => ({ name, arguments: args });
const saveUc = (withIntent = true) => ({ ...(withIntent ? { text: INTENT } : {}), tool_calls: [call("save_revision", { operations: [{ op: "add", collection: "功能用例", fields: UC, sources: [SOURCE] }] })] });
const reply = (text: string, extra: Dict = {}) => ({ ...extra, tool_calls: [call("reply", { informs: [], act: null, text })] });
const replyWithIntent = (text: string) => reply(text, { text: INTENT });

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

/** 一边：一个假端点加一个后端，以及它们用的目录。 */
class Side {
  readonly cfg: SideConfig;
  fake: ChildProcess | null = null;
  backend: ChildProcess | null = null;
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

  async start(script: unknown): Promise<void> {
    rmSync(this.cfg.dir, { recursive: true, force: true });
    mkdirSync(this.tasks, { recursive: true });
    mkdirSync(this.runs, { recursive: true });
    writeFileSync(join(this.cfg.dir, "script.json"), JSON.stringify(script), "utf-8");
    this.fake = spawn(PYTHON, ["-m", "taskwright_server.fake_model", "--script", join(this.cfg.dir, "script.json"), "--log", join(this.cfg.dir, "fake.jsonl"),
      "--port", String(this.cfg.fakePort), "--agent-dir", this.agentDir], { env: this.env(), stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((ok, fail) => {
      let out = "";
      this.fake!.stdout!.on("data", (c) => {
        out += c;
        if (out.includes("pi 配置目录已写好")) ok();
      });
      this.fake!.once("exit", () => fail(new Error(`假端点没有起来：${out}`)));
    });
    await this.startBackend();
  }

  private env(): Dict {
    const env: Dict = { ...process.env, PYTHONPATH: [join(ROOT, "server"), join(ROOT, "observatory")].join(":") };
    for (const name of DROPPED_ENV) delete env[name];
    return env;
  }

  async startBackend(): Promise<void> {
    const env = { ...this.env(), PI_CODING_AGENT_DIR: this.agentDir, TASKWRIGHT_LOG_DIR: join(this.cfg.dir, "logs") };
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

  call(method: string, path: string, body?: unknown, raw?: Buffer, headers: Dict = {}): Promise<{ status: number; type: string; body: any }> {
    return new Promise((ok, fail) => {
      const data = raw ?? (body !== undefined ? Buffer.from(JSON.stringify(body), "utf-8") : undefined);
      const req = request(this.base + path, { method, headers: { ...(data ? { "Content-Length": String(data.length), "Content-Type": "application/json" } : {}), ...headers } }, (res) => {
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

// ───────────── 场景 ─────────────

interface Run {
  side: Side;
  record: (label: string, value: unknown) => void;
  streams: [string, EventStream][];
}

async function newTask(run: Run, material = SOURCE.excerpt): Promise<string> {
  const created = await run.side.call("POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: "测试任务", domain_tag: "售后" });
  run.record("建任务", created);
  const taskId = created.body.task_id;
  run.record("放材料", await run.side.upload(taskId, "材料.md", material));
  return taskId;
}

function openStream(run: Run, label: string, path: string, lastEventId?: number): EventStream {
  const stream = run.side.stream(path, lastEventId);
  run.streams.push([label, stream]);
  return stream;
}

async function say(run: Run, taskId: string, sid: string, text: string, clientId: string, stream: EventStream) {
  const ended = stream.count("work_ended");
  run.record(`说「${text}」`, await run.side.call("POST", `/api/v1/tasks/${taskId}/messages?session=${sid}`, { text, client_id: clientId }));
  await stream.wait((e) => e.event === "work_ended", 60000, 0).then(async () => {
    const end = Date.now() + 60000;
    while (stream.count("work_ended") <= ended && Date.now() < end) await sleep(50);
  });
  await sleep(300);
}

const SCENARIOS: Record<string, { script: unknown; covers: string; run: (r: Run) => Promise<void> }> = {
  open_and_say: {
    covers: "打开会话收到任务现状、斜杠开头的话照原样显示、保存修订与回复、过程摘要与刷新后重算、修订日志（test_service、test_chat_opening、test_rpc）",
    script: [saveUc(), reply("存好了。")],
    run: async (r) => {
      const t = await newTask(r);
      const stream = openStream(r, "任务事件流", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const created = await r.side.call("POST", `/api/v1/tasks/${t}/sessions`);
      r.record("新建会话", created);
      const sid = created.body.session_id;
      await stream.wait((e) => e.event === "system_note");
      r.record("整份数据（说话之前）", await r.side.call("GET", `/api/v1/tasks/${t}/snapshot?session=${sid}`));
      await say(r, t, sid, "/整理一下", "c-1", stream);
      await stream.wait((e) => e.event === "work_summary");
      r.record("整份数据（说话之后）", await r.side.call("GET", `/api/v1/tasks/${t}/snapshot?session=${sid}`));
      r.record("往前读对话", await r.side.call("GET", `/api/v1/tasks/${t}/conversation?session=${sid}&limit=2`));
      r.record("修订日志", await r.side.call("GET", `/api/v1/tasks/${t}/revisions`));
      r.record("会话列表", await r.side.call("GET", `/api/v1/tasks/${t}/sessions`));
      r.record("任务页", await r.side.call("GET", `/api/v1/tasks/${t}`));
      r.record("任务列表", await r.side.call("GET", "/api/v1/tasks"));
      r.record("生成文档", await r.side.call("POST", `/api/v1/tasks/${t}/documents/preview`, {}));
    },
  },
  three_sentences: {
    covers: "三句话：一句保存修订加回复、一句只回复、一句不经回复工具直接输出正文（兜底扩展追加一句、后端兜底转发正文）；再一句什么都没说（problem no_reply）（test_reply）",
    // 脚本用完之后回空文字（不写 default 时假端点回「好的。」），最后一句话才会什么都没说。
    script: { sequence: [saveUc(), reply("存好了。"), replyWithIntent("收到。"), { text: "我直接说了。" }, { text: "还是直接说。" }], default: { text: "" } },
    run: async (r) => {
      const t = await newTask(r);
      const stream = openStream(r, "任务事件流", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const sid = (await r.side.call("POST", `/api/v1/tasks/${t}/sessions`)).body.session_id;
      await stream.wait((e) => e.event === "system_note");
      await say(r, t, sid, "整理一下", "c-1", stream);
      await say(r, t, sid, "好的", "c-2", stream);
      await say(r, t, sid, "你直接说吧", "c-3", stream);
      await say(r, t, sid, "还有吗", "c-4", stream);
      r.record("整份数据", await r.side.call("GET", `/api/v1/tasks/${t}/snapshot?session=${sid}`));
      r.record("修订日志", await r.side.call("GET", `/api/v1/tasks/${t}/revisions`));
    },
  },
  intent: {
    covers: "没写理解就保存被拒、写了理解之后通过、「理解为」一行的推进（test_intent）",
    script: [saveUc(false), saveUc(true), reply("存好了。")],
    run: async (r) => {
      const t = await newTask(r);
      const stream = openStream(r, "任务事件流", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const sid = (await r.side.call("POST", `/api/v1/tasks/${t}/sessions`)).body.session_id;
      await stream.wait((e) => e.event === "system_note");
      await say(r, t, sid, "整理一下", "c-1", stream);
      r.record("整份数据", await r.side.call("GET", `/api/v1/tasks/${t}/snapshot?session=${sid}`));
      r.record("修订日志", await r.side.call("GET", `/api/v1/tasks/${t}/revisions`));
    },
  },
  sessions_and_resume: {
    covers: "新建第二条会话、在两条会话之间切换、后端重启之后打开旧会话续接（test_service、test_rpc 的续接）",
    script: [replyWithIntent("第一条会话里回你。"), replyWithIntent("第二条会话里回你。"), replyWithIntent("续接之后回你。")],
    run: async (r) => {
      const t = await newTask(r);
      let stream = openStream(r, "任务事件流（重启之前）", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const first = (await r.side.call("POST", `/api/v1/tasks/${t}/sessions`)).body.session_id;
      await stream.wait((e) => e.event === "system_note");
      await say(r, t, first, "第一句", "c-1", stream);
      const second = await r.side.call("POST", `/api/v1/tasks/${t}/sessions`);
      r.record("新建第二条会话", second);
      await sleep(500);
      r.record("打开第二条会话", await r.side.call("GET", `/api/v1/tasks/${t}/snapshot?session=${second.body.session_id}`));
      await say(r, t, second.body.session_id, "第二句", "c-2", stream);
      r.record("切回第一条会话", await r.side.call("GET", `/api/v1/tasks/${t}/snapshot?session=${first}`));
      r.record("会话列表", await r.side.call("GET", `/api/v1/tasks/${t}/sessions`));
      stream.close();
      await r.side.stopBackend();
      await r.side.startBackend();
      stream = openStream(r, "任务事件流（重启之后）", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      r.record("重启后打开第一条会话", await r.side.call("GET", `/api/v1/tasks/${t}/snapshot?session=${first}`));
      await say(r, t, first, "续接之后说一句", "c-3", stream);
      r.record("续接之后的整份数据", await r.side.call("GET", `/api/v1/tasks/${t}/snapshot?session=${first}`));
      r.record("会话列表（重启之后）", await r.side.call("GET", `/api/v1/tasks/${t}/sessions`));
    },
  },
  busy: {
    covers: "执行者工作中新建会话、对另一条会话说话、在本会话里再说一句都返回 session_busy；做完之后能说（test_service）",
    script: [saveUc(), reply("慢慢说完。", { delay: 4 }), replyWithIntent("好。")],
    run: async (r) => {
      const t = await newTask(r);
      const stream = openStream(r, "任务事件流", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const sid = (await r.side.call("POST", `/api/v1/tasks/${t}/sessions`)).body.session_id;
      await stream.wait((e) => e.event === "system_note");
      r.record("说一句", await r.side.call("POST", `/api/v1/tasks/${t}/messages?session=${sid}`, { text: "说一句", client_id: "c-1" }));
      await stream.wait((e) => e.event === "deliverable_changed");
      r.record("工作中新建会话", await r.side.call("POST", `/api/v1/tasks/${t}/sessions`));
      r.record("工作中对另一条会话说话", await r.side.call("POST", `/api/v1/tasks/${t}/messages?session=01a0c000-0000-7000-8000-000000000000`, { text: "插一句" }));
      r.record("工作中在本会话再说一句", await r.side.call("POST", `/api/v1/tasks/${t}/messages?session=${sid}`, { text: "再说一句", client_id: "c-2" }));
      await stream.wait((e) => e.event === "work_ended");
      await sleep(300);
      await say(r, t, sid, "再说一句", "c-2", stream);
    },
  },
  replay_and_resync: {
    covers: "断线之后带 Last-Event-ID 重连补发缺的库事件、每条只发一次；差距超过补发窗口发 resync（test_service）",
    script: [saveUc(), reply("存好了。")],
    run: async (r) => {
      const t = await newTask(r);
      const stream = openStream(r, "任务事件流", `/api/v1/tasks/${t}/events`);
      await sleep(300);
      const sid = (await r.side.call("POST", `/api/v1/tasks/${t}/sessions`)).body.session_id;
      await stream.wait((e) => e.event === "system_note");
      await say(r, t, sid, "整理一下", "c-1", stream);
      stream.close();
      const again = openStream(r, "带 Last-Event-ID 1 重连", `/api/v1/tasks/${t}/events`, 1);
      await again.wait((e) => e.event === "deliverable_changed");
      await sleep(500);
      again.close();
      const done = spawnSync(process.execPath, [SEED, "many-events", join(r.side.tasks, t), "UC-001", "1", "510"], { encoding: "utf-8" });
      if (done.status !== 0) throw new Error(`造数失败：${done.stderr}`);
      // pi 还在跑，后端每 2 秒兜底查一次库，会把这几百条转发给在线的订阅者；等它转发完再连，这条连接就只收到 resync。
      await sleep(5000);
      const far = openStream(r, "差距太大", `/api/v1/tasks/${t}/events?last_event_id=1`);
      await far.wait((e) => e.event === "resync");
      await sleep(300);
      far.close();
      r.record("整份数据的序号", (await r.side.call("GET", `/api/v1/tasks/${t}/snapshot`)).body.seq);
    },
  },
};

// ───────────── 归档、会话文件与观测台 ─────────────

function readLines(path: string): unknown[] {
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

/** 归档目录下的三种文件与会话文件：按文件的先后排，文件名里的时刻由归一化处理。 */
function archives(side: Side): Dict {
  const out: Dict = {};
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
  return out;
}

/** 观测台读这一边的归档与任务目录：会话列表与每条会话的详情。 */
function observatory(side: Side): unknown {
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
  const done = spawnSync(PYTHON, ["-c", script, side.runs, side.tasks], {
    encoding: "utf-8", maxBuffer: 512 * 1024 * 1024, env: { ...process.env, PYTHONPATH: [join(ROOT, "server"), join(ROOT, "observatory")].join(":") },
  });
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

/** 事件流：executor_state 与其它事件各自按先后排成两列。 */
function splitStream(events: Dict[]) {
  return { 执行者状态: events.filter((e) => e.event === "executor_state"), 其它事件: events.filter((e) => e.event !== "executor_state") };
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
      await side.start(scenario.script);
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


