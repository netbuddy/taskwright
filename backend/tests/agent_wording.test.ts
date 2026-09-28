/**
 * 执行者状态说明与错误里给人看的几句话不出现「pi」「进程」「命令」：助手运行中退出、没有回应、拒绝操作、找不到程序。
 * 排查要用的原话（哪条命令、系统给的英文原话）不丢：在错误的 technical 里，转成接口错误时放进附带信息 detail，启动失败时写进日志。
 */

import assert from "node:assert/strict";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { Executor } from "../src/executor.ts";
import { Hub } from "../src/hub.ts";
import { loadProfile } from "../src/launch.ts";
import { PiNotFound, PiRefused, PiSession, PiTimeout, technicalOf } from "../src/pi_session.ts";
import { captureConsole, makeWorkspace, tempDir } from "./helpers.ts";

// 本文件在测试进程里运行会写日志的后端代码，日志收进内存，不写标准输出（原因见 helpers.ts 的 captureConsole）。
const logs = captureConsole();

type Dict = Record<string, any>;
let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = makeWorkspace(tmp, "ws", true);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test("没有回应：说明写实际的时限秒数，不提 pi 与命令；原话在 technical 里", () => {
  const e = new PiTimeout("get_state", 60);
  assert.equal(e.message, "助手的程序在 60 秒内没有回应。");
  assert.equal(technicalOf(e), "等 pi 回应命令「get_state」等了 60 秒还没等到。");
  assert.equal(new PiTimeout("prompt", 30).message, "助手的程序在 30 秒内没有回应。");
});

test("拒绝操作：说明写「助手的程序拒绝了这次操作」加原因；原话在 technical 里", () => {
  const e = new PiRefused("switch_session", "文件不是合法的会话");
  assert.equal(e.message, "助手的程序拒绝了这次操作：文件不是合法的会话");
  assert.equal(technicalOf(e), "pi 拒绝了命令「switch_session」：文件不是合法的会话");
});

test("找不到程序：启动时系统报 ENOENT（例如 pi 脚本指定的解释器不存在），说明写「找不到助手的程序（pi），请检查安装。」，系统原话在 technical 里", async () => {
  const script = join(tmp, "pi-without-interpreter");
  writeFileSync(script, "#!/nonexistent/interpreter\n", "utf-8");
  chmodSync(script, 0o755);
  const pi = new PiSession({ ...loadProfile("fake"), executable: script }, ws, join(tmp, "runs-nf"), "service", tmp);
  await assert.rejects(pi.start(), (e: unknown) => e instanceof PiNotFound && (e as Error).message === "找不到助手的程序（pi），请检查安装。"
    && /ENOENT/.test(technicalOf(e)));
});

test("助手运行中退出：执行者状态的附带说明写「助手的程序退出了」", async () => {
  const hub = new Hub(ws);
  const executor = new Executor("TASK-001", ws, join(tmp, "runs"), {}, hub);
  const pi = { alive: () => false, note() {}, async nextEvent() { return { type: "进程已退出" }; }, async request() { return {}; } };
  executor.pi = pi as any;
  const [sub] = hub.subscribe(null, null);
  await (executor as any).pumpLoop(pi);
  const states: Dict[] = [];
  for (let item = await sub.get(10); item; item = await sub.get(10)) if (item[0] === "executor_state") states.push(item[2]);
  hub.close();
  assert.equal(states.at(-1)!.text, "助手已经退出，下一次说话时会重新启动。（助手的程序退出了）");
  assert.doesNotMatch(states.at(-1)!.text, /pi|进程/);
});

test("说话时助手拒绝：接口错误的说明给人看，附带信息 detail 里是排查原话", async () => {
  const hub = new Hub(ws);
  const executor = new Executor("TASK-001", ws, join(tmp, "runs"), {}, hub);
  const pi = { alive: () => true, note() {}, async request() { throw new PiRefused("prompt", "不收"); }, async getState() { return {}; } };
  executor.pi = pi as any;
  executor.activeSession = "S1";
  await assert.rejects(executor.say("S1", "你好", "c-1"), (e: unknown) => e instanceof ApiError && e.code === "executor_unavailable"
    && e.data.detail === "pi 拒绝了命令「prompt」：不收");
  hub.close();
});

test("启动失败：页面顶部显示给人看的那句，日志与附带信息里是排查原话", async () => {
  const script = join(tmp, "pi-missing-interpreter-2");
  writeFileSync(script, "#!/nonexistent/interpreter\n", "utf-8");
  chmodSync(script, 0o755);
  const hub = new Hub(ws);
  const executor = new Executor("TASK-001", ws, join(tmp, "runs-start"), { ...loadProfile("fake"), executable: script }, hub);
  const before = logs.length;
  await assert.rejects(executor.newSession(), (e: unknown) => e instanceof ApiError && /ENOENT/.test(String(e.data.detail)));
  assert.equal(executor.view().state, "failed_to_start");
  assert.equal(executor.detail, "找不到助手的程序（pi），请检查安装。");
  assert.ok(logs.slice(before).some((l) => l.startsWith("任务 TASK-001 的助手没有启动起来：") && /ENOENT/.test(l)));
  hub.close();
});
