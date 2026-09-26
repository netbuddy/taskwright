/**
 * 启动函数与它带来的三件事：同一进程里起服务并拿到实际端口与停止函数；--web 给了时出网页静态文件（找不到回首页、
 * 跳出目录拒绝、/api 仍归接口）；SIGHUP 与 SIGTERM 同样收尾。另测模型探测（只读 pi 配置目录里的两个文件）。
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { probeModel } from "../src/model_probe.ts";
import { LOCK_NAME } from "../src/occupancy.ts";
import { exitSignals, startService } from "../src/start.ts";
import { isWebPath, webFile } from "../src/web.ts";
import { ROOT, tempDir } from "./helpers.ts";

const MAIN = join(ROOT, "backend", "src", "main.mts");
const FAKE_PI = join(ROOT, "backend", "tests", "fixtures", "fake_pi.mjs");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise((ok) => probe.close(ok));
  return port;
}

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
  const port = await freePort();
  const started = await startService({ port, mode: "desktop", tasks: join(dir, "tasks"), runs: join(dir, "runs"), profile: "fake", web, ownProcess: false });
  try {
    assert.equal(started.port, port);
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
  const started = await startService({ port: await freePort(), tasks: join(dir, "tasks"), runs: join(dir, "runs"), profile: "fake", ownProcess: false });
  try {
    const page = await get(started.port, "/");
    assert.deepEqual([page.status, JSON.parse(page.text).error.code], [404, "not_found"]);
  } finally {
    await started.stop();
    delete process.env.TASKWRIGHT_LOG_DIR;
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

test("真进程：收到 SIGHUP（关掉终端或控制台窗口）与 SIGTERM 一样收尾：关 pi、删占用标记、退出码 0", { skip: process.platform === "win32" ? "Windows 上不能向别的进程发 SIGHUP" : false }, async () => {
  const dir = join(tmp, "hup");
  let out = "";
  const child = spawn(process.execPath, [MAIN, "--tasks", join(dir, "tasks"), "--runs", join(dir, "runs"), "--profile", "fake", "--mode", "desktop", "--port", String(await freePort())], {
    cwd: ROOT, env: { ...process.env, TASKWRIGHT_LOG_DIR: join(dir, "logs"), TASKWRIGHT_PI_ENTRY: FAKE_PI }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (c) => (out += c));
  child.stderr!.on("data", (c) => (out += c));
  try {
    let port = 0;
    for (const end = Date.now() + 15000; !port; await sleep(50)) {
      const m = /任务服务在 http:\/\/[^:]+:(\d+)\//.exec(out);
      if (m) port = Number(m[1]);
      else if (child.exitCode !== null || Date.now() > end) throw new Error(`后端没有起来：${out}`);
    }
    const created = await call(port, "POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: "关窗测试" });
    const taskDir = join(dir, "tasks", created.body.task_id);
    assert.equal((await call(port, "POST", `/api/v1/tasks/${created.body.task_id}/sessions`)).status, 200);
    const pis = spawnSync("pgrep", ["-P", String(child.pid)], { encoding: "utf-8" }).stdout.split("\n").filter(Boolean).map(Number);
    assert.equal(pis.length, 1, "打开会话起了一个 pi");
    assert.ok(existsSync(join(taskDir, LOCK_NAME)));
    child.kill("SIGHUP");
    assert.equal(await exited(child), 0);
    assert.equal(existsSync(join(taskDir, LOCK_NAME)), false, "占用标记删掉了");
    assert.throws(() => process.kill(pis[0], 0), "pi 已经不在");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited(child);
    }
  }
});

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
  assert.deepEqual(probeModel({}, env), { name: "", available: false, reason: "启动配置里没有写模型。" });
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
