/**
 * 观测台对照用的一段对话：起一个后端（Python 版或 TypeScript 版）与 TypeScript 版假模型端点，建任务、放材料、开会话、说一句话，
 * 等这一轮做完停掉后端；再把归档交给观测台（Python 包 taskwright_observatory）读出会话列表与会话详情，归一化之后返回。
 * 测试（observatory_parity.test.ts）用 TypeScript 版跑，与夹具生成脚本（generate.mts）用 Python 版跑出的 observatory_view.json 比较。
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Dict = Record<string, any>;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PYTHON = process.env.TASKWRIGHT_PYTHON || "python3";
const INTENT = '```json\n{"acts": [{"function": "request", "confidence": "high", "summary": "照用户说的做"}]}\n```';
const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "买家可以申请退货。" };
const UC = { 用例名称: "提交退货申请", 用例功能: "买家提交退货申请。", 参与者: ["买家"], 基本流程: ["买家打开订单", "系统记下申请"] };
export const SCRIPT = [
  { text: INTENT, tool_calls: [{ name: "save_revision", arguments: { operations: [{ op: "add", collection: "功能用例", fields: UC, sources: [SOURCE] }] } }] },
  { tool_calls: [{ name: "reply", arguments: { informs: [], act: null, text: "存好了。" } }] },
];
const DROPPED_ENV = ["TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "TASKWRIGHT_RUNS_DIR", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL", "LANGFUSE_TRACING_ENVIRONMENT", "PI_CODING_AGENT_DIR", "TASKWRIGHT_TASKS_ROOT", "TASKWRIGHT_PI_ENTRY"];
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise((ok) => probe.close(ok));
  return port;
}

function call(base: string, method: string, path: string, body?: unknown, raw?: Buffer, headers: Dict = { "Content-Type": "application/json" }): Promise<Dict> {
  return new Promise((ok, fail) => {
    const data = raw ?? (body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined);
    const req = request(base + path, { method, headers: { ...headers, ...(data ? { "Content-Length": data.length } : {}) }, timeout: 60000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}")));
    });
    req.on("error", fail);
    req.end(data);
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((ok) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.once("exit", () => {
      clearTimeout(timer);
      ok();
    });
    child.kill("SIGTERM");
  });
}

/** 起后端与假端点，跑完那一段对话，停掉，返回 [归档目录, 任务目录]。 */
export async function runConversation(kind: "python" | "typescript", root: string): Promise<[string, string]> {
  const tasks = join(root, "tasks");
  const runs = join(root, "runs");
  mkdirSync(tasks, { recursive: true });
  mkdirSync(runs, { recursive: true });
  const env: Dict = { ...process.env };
  for (const name of DROPPED_ENV) delete env[name];
  const scriptFile = join(root, "script.json");
  writeFileSync(scriptFile, JSON.stringify(SCRIPT), "utf-8");
  const fake = spawn(process.execPath, [join(ROOT, "backend", "fake_model", "main.mts"), "--script", scriptFile, "--log", join(root, "fake.jsonl"),
    "--port", "0", "--agent-dir", join(root, "pi-agent")], { env });
  let out = "";
  fake.stdout!.on("data", (c) => (out += c));
  for (let end = Date.now() + 15000; !out.includes("pi 配置目录已写好"); await sleep(30)) {
    if (fake.exitCode !== null || Date.now() > end) throw new Error(`假端点没有起来：${out}`);
  }
  const port = await freePort();
  const args = ["--tasks", tasks, "--runs", runs, "--port", String(port), "--host", "127.0.0.1", "--profile", "fake"];
  const backendEnv = { ...env, PI_CODING_AGENT_DIR: join(root, "pi-agent"), TASKWRIGHT_LOG_DIR: join(root, "logs"),
    PYTHONPATH: [join(ROOT, "server"), join(ROOT, "observatory")].join(":") };
  const backend = kind === "python"
    ? spawn(PYTHON, ["-m", "taskwright_server.service", ...args], { cwd: ROOT, env: backendEnv, stdio: "ignore" })
    : spawn(process.execPath, [join(ROOT, "backend", "src", "main.mts"), ...args], { cwd: ROOT, env: backendEnv, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  let task = "";
  try {
    for (let n = 0; n < 150; n++) {
      try {
        await call(base, "GET", "/api/v1/task-types");
        break;
      } catch {
        await sleep(200);
      }
    }
    task = (await call(base, "POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: "对照任务" })).task_id;
    const material = Buffer.from(`--B\r\nContent-Disposition: form-data; name="file"; filename="材料.md"\r\n\r\n${SOURCE.excerpt}\r\n--B--\r\n`, "utf-8");
    await call(base, "POST", `/api/v1/tasks/${task}/materials`, undefined, material, { "Content-Type": "multipart/form-data; boundary=B" });
    // 用事件流等这一句话做完：不能反复读整份数据来等，那样每读一次都会让后端向 pi 取一次会话条目，归档里多出几行回应。
    const ended = new Promise<void>((ok, fail) => {
      const req = request(`${base}/api/v1/tasks/${task}/events`, (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
          if (text.includes("event: work_ended")) {
            req.destroy();
            ok();
          }
        });
      });
      req.on("error", () => {});
      req.setTimeout(60000, () => fail(new Error("等了 60 秒没等到 work_ended")));
      req.end();
    });
    await sleep(200);
    const session = (await call(base, "POST", `/api/v1/tasks/${task}/sessions`)).session_id;
    await call(base, "POST", `/api/v1/tasks/${task}/messages?session=${session}`, { text: "整理一下", client_id: "c-1" });
    await ended;
    await sleep(500);
  } finally {
    await stop(backend);
    await stop(fake);
  }
  return [join(runs, task), tasks];
}

/**
 * 观测台读出的会话列表与会话详情，按观测台对照一贯的规则归一化（root 下的路径、编号、时刻、耗时、进程号换成占位写法）。
 * 代码仓根目录换成「<仓根>」、pi 的位置换成「<pi>」，绝对写法与观测台把家目录缩成「~」的写法都换：留存输出要进公开仓，
 * 不能带本机的目录布局，换一个检出位置也要比得上。测试与夹具生成脚本都经这一个函数归一化。
 */
export function observatoryView(archive: string, tasks: string, root: string): unknown {
  const script = `
import json, re, shutil, sys
from pathlib import Path
from taskwright_observatory.api import Index
ENTRY_KEYS = {"message_id", "entry_id", "id", "parentId", "会话条目编号", "条目编号", "user_entry"}
class Normalizer:
    def __init__(self, root, repo):
        self.root = str(Path(root).resolve()); self.parent = str(Path(root).resolve().parent); self.maps = {}; self.entries = set()
        home = str(Path.home())
        tilde = lambda p: "~" + p[len(home):] if p.startswith(home + "/") else p
        pi = shutil.which("pi")
        self.machine = ([(pi, "<pi>"), (tilde(pi), "<pi>")] if pi else []) + [(repo, "<仓根>"), (tilde(repo), "<仓根>")]
        self.ancestors = {str(p) for p in Path(root).resolve().parent.parents}
    def label(self, kind, value):
        table = self.maps.setdefault(kind, {}); return table.setdefault(value, f"<{kind}{len(table) + 1}>")
    def collect(self, value, key=""):
        if isinstance(value, str) and key in ENTRY_KEYS and re.fullmatch(r"[0-9a-f]{8}", value): self.entries.add(value)
        elif isinstance(value, list):
            for v in value: self.collect(v, key)
        elif isinstance(value, dict):
            for k, v in value.items(): self.collect(v, k)
    def text(self, value):
        if value in self.ancestors: return "<更上层的目录>"
        out = value.replace(self.root, "<目录>").replace(self.parent, "<上级目录>")
        for path, name in self.machine: out = out.replace(path, name)
        out = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", lambda m: self.label("会话", m.group()), out)
        out = re.sub(r"TASK-\\d{8}-[0-9A-F]{4}", lambda m: self.label("任务", m.group()), out)
        out = re.sub(r"ui-op-[0-9a-f]{12}", lambda m: self.label("操作", m.group()), out)
        out = re.sub(r"(?<![0-9A-Za-z])[0-9a-f]{8}(?![0-9A-Za-z])", lambda m: self.label("条目", m.group()) if m.group() in self.entries else m.group(), out)
        out = re.sub(r"\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z", "<时刻>", out)
        out = re.sub(r"\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})?", "<时刻>", out)
        out = re.sub(r"(?<![0-9])\\d{2}:\\d{2}:\\d{2}(?![0-9])", "<时分秒>", out)
        out = re.sub(r"\\d{8}-\\d{6}", "<时刻>", out)
        out = re.sub(r"(?<![0-9])1\\d{12}(?![0-9])", "<时刻数>", out)
        return out
    def value(self, value, key=""):
        if isinstance(value, str): return self.text(value)
        if isinstance(value, bool) or value is None: return value
        if isinstance(value, (int, float)):
            if "耗时" in key or key.endswith("行号") or key in ("开始时刻", "结束时刻", "启动时刻", "收到时刻", "pid"): return f"<{key}>"
            return "<时刻数>" if 1e9 < value < 3e12 else value
        if isinstance(value, list):
            out = [self.value(v, key) for v in value]
            # 临时目录放在多深，上层目录就有几层；连续的几项合成一项。
            return [v for i, v in enumerate(out) if not (v == "<更上层的目录>" and i and out[i - 1] == v)]
        if isinstance(value, dict): return {self.text(k): self.value(v, k) for k, v in sorted(value.items())}
        return value
archive, tasks, root, repo = sys.argv[1:5]
index = Index(Path(archive), Path(tasks))
view = {"会话列表": index.session_list(), "会话详情": [index.session_detail(s["会话编号"]) for s in index.sessions if s["会话编号"]]}
view = json.loads(json.dumps(view, ensure_ascii=False, default=str))
normalizer = Normalizer(root, repo)
normalizer.collect(view)
print(json.dumps(normalizer.value(view), ensure_ascii=False))
`;
  const done = spawnSync(PYTHON, ["-c", script, archive, tasks, root, ROOT], {
    encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PYTHONPATH: join(ROOT, "observatory") },
  });
  if (done.status !== 0) throw new Error(`观测台读不出来：${done.stderr.slice(-2000)}`);
  return JSON.parse(done.stdout);
}
