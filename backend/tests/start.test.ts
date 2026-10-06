/**
 * 启动函数与它带来的三件事：同一进程里起服务并拿到实际端口与停止函数；--web 给了时出网页静态文件（找不到回首页、
 * 跳出目录拒绝、/api 仍归接口）；SIGHUP、SIGTERM、SIGINT 同样收尾，事件流先收到 service_exiting。另测模型探测（只读 pi 配置目录里的两个文件）。
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { probeModel } from "../src/model_probe.ts";
import { LOCK_NAME } from "../src/occupancy.ts";
import { exitSignals, startService } from "../src/start.ts";
import { isWebPath, webFile } from "../src/web.ts";
import { captureConsole, ROOT, spawnBackend, tempDir } from "./helpers.ts";

// 本文件有几例在测试进程里直接起服务，服务的日志收进内存，不写标准输出（原因见 captureConsole 的说明）。
captureConsole();

const FAKE_PI = join(ROOT, "backend", "tests", "fixtures", "fake_pi.mjs");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 发一个 GET，原样取回状态、头与正文（不按 JSON 解析）；路径原样发出，不经 URL 规范化。 */
function get(port: number, path: string): Promise<{ status: number; type: string; cache: string; text: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), cache: String(res.headers["cache-control"] ?? ""), text: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", fail);
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.end();
  });
}

function makeWeb(dir: string): string {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>首页</title>");
  writeFileSync(join(dir, "assets", "app-1a2b.js"), "console.log(1)");
  writeFileSync(join(dir, "..", "secret.txt"), "不该被读到");
  return dir;
}

test("启动函数：同一进程里起服务，回实际端口；--web 出静态文件、找不到回首页、跳出目录拒绝、/api 仍归接口；stop 之后端口释放", async () => {
  const dir = join(tmp, "inproc");
  const web = makeWeb(join(dir, "web"));
  process.env.TASKWRIGHT_LOG_DIR = join(dir, "logs");
  const started = await startService({ port: 0, mode: "desktop", tasks: join(dir, "tasks"), runs: join(dir, "runs"), knowledge: join(dir, "knowledge"), profile: "fake", web, ownProcess: false });
  const port = started.port;
  try {
    assert.ok(port > 0, "给 0 时回的是操作系统挑的端口");
    assert.equal(started.host, "127.0.0.1");
    assert.equal(started.service.port, port);

    const index = await get(port, "/");
    assert.deepEqual([index.status, index.type, index.cache, index.text], [200, "text/html; charset=utf-8", "no-cache", "<!doctype html><title>首页</title>"]);
    const asset = await get(port, "/assets/app-1a2b.js");
    assert.deepEqual([asset.status, asset.type, asset.cache, asset.text], [200, "text/javascript; charset=utf-8", "", "console.log(1)"]);
    const fallback = await get(port, "/tasks/TASK-1/work?session=S1");
    assert.deepEqual([fallback.status, fallback.text], [200, "<!doctype html><title>首页</title>"], "单页应用的路径回首页");
    for (const escape of ["/%2e%2e/secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "/..%2fsecret.txt"]) {
      const refused = await get(port, escape);
      assert.equal(refused.status, 400, escape);
      assert.doesNotMatch(refused.text, /不该被读到/, escape);
    }
    const info = await get(port, "/api/v1/service");
    assert.equal(JSON.parse(info.text).port, port, "/api/v1 仍归接口");
    const missing = await get(port, "/api/v1/nothing");
    assert.deepEqual([missing.status, JSON.parse(missing.text).error.code], [404, "not_found"], "/api 下不存在的接口仍是接口的 404，不回首页");
    assert.equal((await get(port, "/api")).status, 404);
  } finally {
    await started.stop();
    await started.stop();
    delete process.env.TASKWRIGHT_LOG_DIR;
  }
  await assert.rejects(get(port, "/api/v1/service"), "端口已经释放");
});

test("没给 --web 时行为不变：不以 /api/ 开头的路径也是接口的 404", async () => {
  const dir = join(tmp, "noweb");
  process.env.TASKWRIGHT_LOG_DIR = join(dir, "logs");
  const started = await startService({ port: 0, tasks: join(dir, "tasks"), runs: join(dir, "runs"), knowledge: join(dir, "knowledge"), profile: "fake", ownProcess: false });
  try {
    const page = await get(started.port, "/");
    assert.deepEqual([page.status, JSON.parse(page.text).error.code], [404, "not_found"]);
  } finally {
    await started.stop();
    delete process.env.TASKWRIGHT_LOG_DIR;
  }
});

test("启动时给上一版设置文件里没有用途的模型服务定用途，日志里记下；改写不了共用文件时服务照常起来，日志里写明原因", async () => {
  const dir = join(tmp, "purposes");
  const agent = join(dir, "pi-agent");
  mkdirSync(agent, { recursive: true });
  const settings = join(dir, "settings.json");
  const old = JSON.stringify({ version: 1, pi_dirs: { [agent]: { selection: { language: null, embedding: null }, providers: {
    "taskwright-ollama": { kind: "ollama", name: "本机 ollama", base_url: "http://127.0.0.1:11434", models_fetched_at: null, status: null, models: [
      { id: "qwen3:8b", type: "language", enabled: true, context_window: 8192, context_source: "user" },
      { id: "bge-m3", type: "embedding", enabled: true, context_window: null, context_source: null },
    ] },
  } } } });
  const names = ["PI_CODING_AGENT_DIR", "TASKWRIGHT_SETTINGS_FILE", "TASKWRIGHT_LOG_DIR"] as const;
  const saved = names.map((name) => process.env[name]);
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.TASKWRIGHT_SETTINGS_FILE = settings;
  process.env.TASKWRIGHT_LOG_DIR = join(dir, "logs");
  const lines = captureConsole();
  const startAndStop = async (): Promise<string[]> => {
    const from = lines.length;
    const started = await startService({ port: 0, tasks: join(dir, "tasks"), runs: join(dir, "runs"), knowledge: join(dir, "knowledge"), profile: "fake", ownProcess: false });
    await started.stop();
    return lines.slice(from);
  };
  try {
    // 模型登记文件里有注释，改写不了：服务照常起来，设置文件一字不动
    writeFileSync(settings, old);
    writeFileSync(join(agent, "models.json"), '{\n  // 我的注释\n  "providers": {}\n}\n');
    const refused = await startAndStop();
    assert.equal(refused.filter((line) => line.startsWith("没能给设置文件里的模型服务定用途：")).length, 1, refused.join("\n"));
    assert.equal(readFileSync(settings, "utf-8"), old);
    // 改写得了：两类模型都有的那一个拆成两个，日志里记一句
    writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {} }));
    const done = await startAndStop();
    assert.equal(done.filter((line) => line.includes("既有语言模型又有嵌入模型，已经拆成两个")).length, 1, done.join("\n"));
    const now = JSON.parse(readFileSync(settings, "utf-8"));
    assert.equal(now.version, 2);
    assert.deepEqual(Object.entries<any>(now.pi_dirs[agent].providers).map(([id, p]) => [id, p.purpose, p.models.map((m: any) => m.id)]), [
      ["taskwright-ollama", "language", ["qwen3:8b"]], ["taskwright-ollama-embedding", "embedding", ["bge-m3"]],
    ]);
    // 再起一次：没有要迁移的，日志里不再提，文件不再写
    const before = readFileSync(settings, "utf-8");
    const again = await startAndStop();
    assert.equal(again.some((line) => line.includes("用途") || line.includes("拆成两个")), false, again.join("\n"));
    assert.equal(readFileSync(settings, "utf-8"), before);
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
});

test("静态文件的两个小函数：哪些路径归网页；网页目录里没有首页时回 404", () => {
  assert.deepEqual(["/", "/tasks", "/apiary", "/api", "/api/v1/tasks"].map(isWebPath), [true, true, true, false, false]);
  const empty = join(tmp, "empty-web");
  mkdirSync(empty, { recursive: true });
  assert.equal(webFile(empty, "/x").status, 404);
});

test("启动参数不对时，启动函数报出与命令行相同的说明", async () => {
  await assert.rejects(startService({ port: 1, mode: "kiosk" as any, ownProcess: false }), { message: "--mode 只能是 desktop 或 server，现在是「kiosk」。" });
  await assert.rejects(startService({ port: 1.5, ownProcess: false }), { message: "--port 要写一个整数，现在是「1.5」。" });
});

test("要接的退出信号：各平台都有 SIGHUP，Windows 另加 SIGBREAK", () => {
  assert.deepEqual(exitSignals("linux"), ["SIGTERM", "SIGINT", "SIGHUP"]);
  assert.deepEqual(exitSignals("win32"), ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"]);
});

function exited(child: ChildProcess, ms = 20000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((ok) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      ok(null);
    }, ms);
    child.once("exit", (code) => {
      clearTimeout(timer);
      ok(code);
    });
  });
}

function call(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((ok, fail) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ host: "127.0.0.1", port, path, method, timeout: 5000, headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null") }));
    });
    req.on("error", fail);
    req.end(data);
  });
}

for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
  test(`真进程：收到 ${signal} 时收尾：开着的事件流先收到 service_exiting，再关 pi、删占用标记、退出码 0（SIGHUP 是关掉终端或控制台窗口）`,
    { skip: process.platform === "win32" ? "Windows 上不能向别的进程发这些信号" : false }, async () => {
    const dir = join(tmp, `signal-${signal}`);
    const { child, port, output } = await spawnBackend(["--tasks", join(dir, "tasks"), "--runs", join(dir, "runs"), "--profile", "fake", "--mode", "desktop"], {
      cwd: ROOT, env: { ...process.env, TASKWRIGHT_LOG_DIR: join(dir, "logs"), TASKWRIGHT_PI_ENTRY: FAKE_PI },
    });
    let stream: ReturnType<typeof request> | undefined;
    try {
      const created = await call(port, "POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: "关窗测试" });
      const taskDir = join(dir, "tasks", created.body.task_id);
      let events = "";
      stream = request({ host: "127.0.0.1", port, path: `/api/v1/tasks/${created.body.task_id}/events` }, (res) => res.on("data", (c) => (events += c)));
      stream.on("error", () => {});
      stream.end();
      assert.equal((await call(port, "POST", `/api/v1/tasks/${created.body.task_id}/sessions`)).status, 200);
      const pis = spawnSync("pgrep", ["-P", String(child.pid)], { encoding: "utf-8" }).stdout.split("\n").filter(Boolean).map(Number);
      assert.equal(pis.length, 1, "打开会话起了一个 pi");
      assert.ok(existsSync(join(taskDir, LOCK_NAME)));
      child.kill(signal);
      assert.equal(await exited(child), 0);
      assert.equal(existsSync(join(taskDir, LOCK_NAME)), false, "占用标记删掉了");
      assert.throws(() => process.kill(pis[0], 0), "pi 已经不在");
      const notice = events.indexOf("event: service_exiting\ndata: {\"mode\": \"desktop\"");
      assert.ok(notice >= 0, `事件流收到了 service_exiting：${events}`);
      assert.ok(notice < events.indexOf("event: executor_state\ndata: {\"state\": \"exited\""), "先发退出通知，再关 pi");
    } finally {
      stream?.destroy();
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exited(child);
      }
    }
  });
}

test("模型探测：models.json 登记了「服务商/型号」或 auth.json 有这个服务商即为有；都没有时原因句写明两个文件的位置", () => {
  const dir = join(tmp, "agent-dir");
  mkdirSync(dir, { recursive: true });
  const env = { PI_CODING_AGENT_DIR: dir };
  const models = join(dir, "models.json");
  const auth = join(dir, "auth.json");

  const none = probeModel({ model: "local/qwen" }, env);
  assert.deepEqual(none, {
    name: "local/qwen", available: false,
    reason: `在模型登记文件 ${models} 和登录凭据文件 ${auth} 里都没有找到「local/qwen」。如果这个模型服务的密钥只放在环境变量里，这里也会显示没有找到。`,
  });

  writeFileSync(models, JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", models: [{ id: "qwen" }] } } }));
  assert.deepEqual(probeModel({ model: "local/qwen" }, env), { name: "local/qwen", available: true, reason: `在模型登记文件 ${models} 里找到了「local/qwen」。` });
  assert.equal(probeModel({ model: "local/other" }, env).available, false, "服务商登记了但型号没有登记");

  writeFileSync(auth, JSON.stringify({ "some-cloud": { type: "oauth", access: "不读这里" } }));
  const loggedIn = probeModel({ model: "some-cloud/big-model" }, env);
  assert.deepEqual(loggedIn, { name: "some-cloud/big-model", available: true, reason: `模型服务「some-cloud」已经登录，登录凭据文件 ${auth} 里有它。` });
  assert.doesNotMatch(loggedIn.reason, /不读这里/);

  writeFileSync(models, "{ 不是 JSON");
  assert.match(probeModel({ model: "local/qwen" }, env).reason, new RegExp(`其中 ${models.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")} 读不出来`));
  assert.deepEqual(probeModel({}, env), { name: "", available: false, reason: "没有在设置里选定语言模型，启动配置里也没有写模型。" });
  assert.equal(JSON.parse(readFileSync(auth, "utf-8"))["some-cloud"].access, "不读这里", "探测不改文件");
});

test("模型探测的原因句：桌面形态写两个文件的完整路径；服务器形态只写文件名，不带出服务器上的目录", async () => {
  const { Service } = await import("../src/service.ts");
  const { serviceInfo } = await import("../src/http.ts");
  const dir = join(tmp, "probe-agent");
  mkdirSync(dir, { recursive: true });
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const profile = { model: "local/qwen" };
    const desktop = serviceInfo(new Service(join(tmp, "pt1"), join(tmp, "pr1"), profile, { port: 1, mode: "desktop" }));
    assert.equal(desktop.model.reason, `在模型登记文件 ${join(dir, "models.json")} 和登录凭据文件 ${join(dir, "auth.json")} 里都没有找到「local/qwen」。如果这个模型服务的密钥只放在环境变量里，这里也会显示没有找到。`);
    const server = serviceInfo(new Service(join(tmp, "pt2"), join(tmp, "pr2"), profile, { port: 2, mode: "server" }));
    assert.equal(server.model.reason, "在模型登记文件 models.json 和登录凭据文件 auth.json 里都没有找到「local/qwen」。如果这个模型服务的密钥只放在环境变量里，这里也会显示没有找到。");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ local: {} }));
    const found = serviceInfo(new Service(join(tmp, "pt3"), join(tmp, "pr3"), profile, { port: 3, mode: "server" }));
    assert.deepEqual([found.capabilities.model, found.model.reason], [true, "模型服务「local」已经登录，登录凭据文件 auth.json 里有它。"]);
    assert.ok(!found.model.reason.includes(dir));
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});
