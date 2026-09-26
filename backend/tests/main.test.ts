/**
 * 启动层：运行形态对缺省绑定地址与退出接口的影响、服务信息接口的形状、退出接口的来源检查与收尾、端口被占时换端口。
 * 起真的后端进程（node backend/src/main.mts），pi 换成测试用的假 pi 脚本（经 TASKWRIGHT_PI_ENTRY 注入）。
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { type Server, createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { dispatch } from "../src/http.ts";
import { NoFreePort, defaultHost, listenFrom } from "../src/listen.ts";
import { LOCK_NAME } from "../src/occupancy.ts";
import { Service } from "../src/service.ts";
import { ROOT, tempDir } from "./helpers.ts";

type Dict = Record<string, any>;
const MAIN = join(ROOT, "backend", "src", "main.mts");
const FAKE_PI = join(ROOT, "backend", "tests", "fixtures", "fake_pi.mjs");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** 本机一个不是回环的 IPv4 地址；没有就是 null（这时跳过要它的几步）。 */
const lanAddress = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address ?? null;

/** 操作系统挑的一个空闲端口。 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise((ok) => probe.close(ok));
  return port;
}

function call(host: string, port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((ok, fail) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ host, port, path, method, timeout: 5000, headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null") }));
    });
    req.on("error", fail);
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.end(data);
  });
}

/** 起一个后端进程，等它打印出监听地址；返回进程、实际端口与日志。 */
async function startBackend(name: string, args: string[]): Promise<{ child: ChildProcess; port: number; log: () => string }> {
  const dir = join(tmp, name);
  let out = "";
  const child = spawn(process.execPath, [MAIN, "--tasks", join(dir, "tasks"), "--runs", join(dir, "runs"), "--profile", "fake", ...args], {
    cwd: ROOT, env: { ...process.env, TASKWRIGHT_LOG_DIR: join(dir, "logs"), TASKWRIGHT_PI_ENTRY: FAKE_PI }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (c) => (out += c));
  child.stderr!.on("data", (c) => (out += c));
  const end = Date.now() + 15000;
  for (;;) {
    const m = /任务服务在 http:\/\/[^:]+:(\d+)\//.exec(out);
    if (m) return { child, port: Number(m[1]), log: () => out };
    if (child.exitCode !== null || Date.now() > end) throw new Error(`后端没有起来：${out}`);
    await sleep(50);
  }
}

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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("缺省绑定地址：desktop 是 127.0.0.1，server 是 0.0.0.0，给了 --host 以它为准", () => {
  assert.equal(defaultHost("desktop", undefined), "127.0.0.1");
  assert.equal(defaultHost("server", undefined), "0.0.0.0");
  assert.equal(defaultHost("desktop", "0.0.0.0"), "0.0.0.0");
});

test("服务信息的形状；退出接口在 server 形态下与没有这个接口一样，desktop 形态下只收本机回环地址的请求", async () => {
  const go = (service: Service, method: string, path: string, remote: string) => dispatch(service, { method, path, query: {}, headers: {}, body: Buffer.alloc(0), remote }) as Promise<Dict>;
  const server = new Service(join(tmp, "d1"), join(tmp, "d1r"), {}, { port: 8765 });
  const info = JSON.parse((await go(server, "GET", "/api/v1/service", "198.51.100.9")).body.toString());
  assert.deepEqual(Object.keys(info), ["ok", "app", "version", "mode", "pid", "port", "capabilities"]);
  assert.deepEqual({ ...info, version: typeof info.version }, { ok: true, app: "taskwright", version: "string", mode: "server", pid: process.pid, port: 8765, capabilities: { exit: false } });
  assert.equal(info.version, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version);
  const missing = await go(server, "POST", "/api/v1/service/exit", "127.0.0.1");
  assert.deepEqual([missing.status, JSON.parse(missing.body.toString()).error], [404, { code: "not_found", message: "没有这个接口：POST /api/v1/service/exit", data: {} }]);

  const desktop = new Service(join(tmp, "d2"), join(tmp, "d2r"), {}, { port: 8766, mode: "desktop" });
  assert.deepEqual(JSON.parse((await go(desktop, "GET", "/api/v1/service", "::1")).body.toString()).capabilities, { exit: true });
  let exits = 0;
  desktop.exitHandler = () => void (exits += 1);
  for (const remote of ["192.0.2.5", "198.51.100.1", "::ffff:192.0.2.5", ""]) {
    const refused = await go(desktop, "POST", "/api/v1/service/exit", remote);
    assert.deepEqual([refused.status, JSON.parse(refused.body.toString()).error], [403, { code: "forbidden", message: "退出服务只接受从本机发来的请求。", data: {} }], remote);
  }
  for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const accepted = await go(desktop, "POST", "/api/v1/service/exit", remote);
    assert.deepEqual([accepted.status, JSON.parse(accepted.body.toString())], [200, { ok: true }], remote);
    accepted.after();
  }
  assert.equal(exits, 3, "收尾在回答发出之后做，由 after 触发");
  assert.equal((await go(desktop, "GET", "/api/v1/service/exit", "127.0.0.1")).status, 404, "只认 POST");
});

test("换端口：给的端口被占就依次试后面的；都被占时报错；端口被占以外的错误照原样抛出", async () => {
  const start = await freePort();
  const holders: Server[] = [];
  const hold = async (port: number) => {
    const s = createServer();
    await new Promise<void>((ok, fail) => s.once("error", fail).listen(port, "127.0.0.1", () => ok()));
    holders.push(s);
  };
  try {
    await hold(start);
    const server = createHttpServer();
    const port = await listenFrom(server, start, "127.0.0.1");
    assert.ok(port > start && port < start + 10, `落在 ${port}`);
    await new Promise((ok) => server.close(ok));
    const again = createHttpServer();
    await assert.rejects(listenFrom(again, start, "127.0.0.1", 1), (e: Error) => e instanceof NoFreePort && e.message === `端口 ${start} 到 ${start} 都被占用了，服务没有起来。`);
    await assert.rejects(listenFrom(createHttpServer(), start, "203.0.113.1", 3), (e: NodeJS.ErrnoException) => e.code === "EADDRNOTAVAIL");
  } finally {
    for (const s of holders) await new Promise((ok) => s.close(ok));
  }
});

test("真进程：端口被占时落到后面第一个空闲端口，服务信息回出实际端口，日志写明；server 形态绑全部网卡、退出接口 404", async () => {
  const holder = createServer();
  await new Promise<void>((ok) => holder.listen(0, "0.0.0.0", ok));
  const start = (holder.address() as { port: number }).port;
  const { child, port, log } = await startBackend("fallback", ["--port", String(start)]);
  try {
    assert.ok(port > start && port < start + 10, `落在 ${port}（给的是 ${start}；中间的端口可能正被本机别的程序占着）`);
    const info = (await call("127.0.0.1", port, "GET", "/api/v1/service")).body;
    assert.deepEqual([info.port, info.mode, info.pid, info.capabilities], [port, "server", child.pid, { exit: false }]);
    assert.match(log(), new RegExp(`端口 ${start} 被占用，改用端口 ${port}。`));
    assert.match(log(), /任务服务在 http:\/\/0\.0\.0\.0:\d+\/api\/v1\/tasks ，.*运行形态 server/);
    assert.equal((await call("127.0.0.1", port, "POST", "/api/v1/service/exit")).status, 404);
    if (lanAddress) assert.equal((await call(lanAddress, port, "GET", "/api/v1/service")).status, 200, "server 形态从别的网卡也连得上");
  } finally {
    child.kill("SIGTERM");
    await exited(child);
    await new Promise((ok) => holder.close(ok));
  }
});

test("真进程：desktop 形态只绑 127.0.0.1；退出请求先回 ok，再关 pi（开着的事件流收到「已退出」）、删占用标记、释放端口、退出进程", async () => {
  const { child, port, log } = await startBackend("desktop", ["--port", String(await freePort()), "--mode", "desktop"]);
  try {
    assert.match(log(), /任务服务在 http:\/\/127\.0\.0\.1:\d+\/api\/v1\/tasks ，.*运行形态 desktop/);
    if (lanAddress) await assert.rejects(call(lanAddress, port, "GET", "/api/v1/service"), "desktop 形态从别的网卡连不上");
    const created = await call("127.0.0.1", port, "POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: "退出测试" });
    const taskDir = join(tmp, "desktop", "tasks", created.body.task_id);
    const lock = JSON.parse(readFileSync(join(taskDir, LOCK_NAME), "utf-8"));
    assert.deepEqual([lock.port, lock.pid, lock.mode], [port, child.pid, "desktop"], "占用标记写实际端口与运行形态");
    let events = "";
    const stream = request({ host: "127.0.0.1", port, path: `/api/v1/tasks/${created.body.task_id}/events` }, (res) => res.on("data", (c) => (events += c)));
    stream.on("error", () => {});
    stream.end();
    assert.equal((await call("127.0.0.1", port, "POST", `/api/v1/tasks/${created.body.task_id}/sessions`)).status, 200);
    const pis = spawnSync("pgrep", ["-P", String(child.pid)], { encoding: "utf-8" }).stdout.split("\n").filter(Boolean).map(Number);
    assert.equal(pis.length, 1, "打开会话起了一个 pi");
    assert.deepEqual(await call("127.0.0.1", port, "POST", "/api/v1/service/exit"), { status: 200, body: { ok: true } });
    assert.equal(await exited(child), 0);
    assert.equal(existsSync(join(taskDir, LOCK_NAME)), false, "占用标记删掉了");
    assert.equal(alive(pis[0]), false, "pi 已经不在");
    await assert.rejects(call("127.0.0.1", port, "GET", "/api/v1/service"), "端口已经释放");
    assert.match(log(), /收到本机发来的退出请求，服务收尾后退出。/);
    assert.match(events, /event: executor_state\ndata: \{"state": "exited"/, "收尾时先关 pi，开着的事件流收到「已退出」，再断开连接");
    const notes = readdirSync(join(tmp, "desktop", "runs", created.body.task_id, "pi-events")).filter((f) => f.endsWith(".backend.jsonl"));
    assert.match(readFileSync(join(tmp, "desktop", "runs", created.body.task_id, "pi-events", notes[0]), "utf-8"), /"记录": "退出"/, "pi 关完、后端补记写下「退出」之后进程才退出");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited(child);
    }
  }
});

test("真进程：desktop 形态给了 --host 0.0.0.0 时，从别的网卡来的退出请求是 403", { skip: lanAddress === null ? "本机没有回环以外的地址" : false }, async () => {
  const { child, port } = await startBackend("desktop-any", ["--port", String(await freePort()), "--mode", "desktop", "--host", "0.0.0.0"]);
  try {
    const refused = await call(lanAddress!, port, "POST", "/api/v1/service/exit");
    assert.deepEqual([refused.status, refused.body.error.code], [403, "forbidden"]);
    assert.equal((await call("127.0.0.1", port, "GET", "/api/v1/service")).body.capabilities.exit, true);
  } finally {
    child.kill("SIGTERM");
    await exited(child);
  }
});

test("--mode 只收 desktop 与 server", () => {
  const done = spawnSync(process.execPath, [MAIN, "--port", "1", "--mode", "kiosk"], { encoding: "utf-8" });
  assert.deepEqual([done.status, done.stderr], [2, "--mode 只能是 desktop 或 server，现在是「kiosk」。\n"]);
});
