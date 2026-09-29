/**
 * 执行者状态说明与错误里给人看的几句话不出现「pi」「进程」「命令」「标准错误」：助手运行中退出、没有回应、拒绝操作、找不到程序、
 * 系统拒绝启动（说明只写系统给的英文代号）。只有「找不到助手的程序（pi）」一句写出要装的程序名。
 * 排查要用的原话（哪条命令、系统给的英文原话）不丢：在错误的 technical 里，转成接口错误时放进附带信息 detail，启动失败时写进日志。
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { EXITED_AT_START_TEXT, Executor, START_FAILED_TEXT, startFailure, stateText } from "../src/executor.ts";
import { Hub } from "../src/hub.ts";
import { LaunchError, loadProfile } from "../src/launch.ts";
import { PiExited, PiNotFound, PiRefused, PiSession, PiStartRefused, PiTimeout, startRefusedText, technicalOf } from "../src/pi_session.ts";
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

/** 页面上给人看的话里不许出现的词；「找不到助手的程序（pi）」一句写出要装的程序名，是唯一的例外。 */
const FORBIDDEN = /pi|进程|命令|标准错误/;
const withoutInstallName = (text: string) => text.replace("找不到助手的程序（pi）", "找不到助手的程序");

/**
 * 用给定的启动配置新建会话，让启动失败，返回页面顶部附带说明（执行者状态事件的 text 与 detail）、接口错误的 detail 与这一次的日志。
 * 测试进程里可能设着 TASKWRIGHT_PI_ENTRY（注入假 pi 的入口脚本），设着时启动配置里的可执行文件不起作用，所以这里先拿掉。
 */
async function failStart(profile: Dict, runs: string) {
  const savedEntry = process.env.TASKWRIGHT_PI_ENTRY;
  delete process.env.TASKWRIGHT_PI_ENTRY;
  const hub = new Hub(ws);
  const [sub] = hub.subscribe(null, null);
  const executor = new Executor("TASK-001", ws, join(tmp, runs), profile, hub);
  const before = logs.length;
  let apiError: ApiError | null = null;
  try {
    await executor.newSession();
  } catch (error) {
    apiError = error as ApiError;
  } finally {
    if (savedEntry !== undefined) process.env.TASKWRIGHT_PI_ENTRY = savedEntry;
  }
  const states: Dict[] = [];
  for (let item = await sub.get(10); item; item = await sub.get(10)) if (item[0] === "executor_state") states.push(item[2]);
  hub.close();
  assert.ok(apiError instanceof ApiError && apiError.code === "executor_unavailable", `应当报 executor_unavailable，实际是 ${apiError}`);
  assert.equal(executor.view().state, "failed_to_start");
  return { detail: executor.detail, text: states.at(-1)!.text as string, apiDetail: String(apiError.data.detail), logs: logs.slice(before) };
}

test("没有安装：PATH 里找不到启动配置写的程序时，说明写「找不到助手的程序（pi），请检查安装。」，原话在 technical 里", async () => {
  const got = await failStart({ ...loadProfile("fake"), executable: "taskwright-no-such-program" }, "runs-missing");
  assert.equal(got.detail, "找不到助手的程序（pi），请检查安装。");
  assert.equal(got.text, "助手没有启动起来，找不到助手的程序（pi），请检查安装。");
  assert.equal(got.apiDetail, "在 PATH 里找不到 taskwright-no-such-program 命令，先把 pi 装好再启动。");
  assert.ok(got.logs.some((l) => l === "任务 TASK-001 的助手没有启动起来：在 PATH 里找不到 taskwright-no-such-program 命令，先把 pi 装好再启动。"));
  assert.doesNotMatch(withoutInstallName(got.text), FORBIDDEN);
  // 启动配置写错的那几种不带 technical，说明本身就是给部署人员看的原话
  assert.equal(technicalOf(new LaunchError("启动配置写错了")), "启动配置写错了");
});

test("系统拒绝启动，没有执行权限：说明只写「系统原因：EACCES」，系统原话（带程序路径）在 technical 里", async () => {
  const script = join(tmp, "pi-not-executable");
  writeFileSync(script, "#!/bin/sh\n", "utf-8");
  chmodSync(script, 0o644);
  const got = await failStart({ ...loadProfile("fake"), executable: script }, "runs-eacces");
  assert.equal(got.detail, "系统原因：EACCES");
  assert.equal(got.text, "助手没有启动起来，系统原因：EACCES");
  assert.equal(got.apiDetail, `spawn ${script} EACCES`);
  assert.ok(got.logs.some((l) => l === `任务 TASK-001 的助手没有启动起来：spawn ${script} EACCES`));
  assert.doesNotMatch(got.text, FORBIDDEN);
});

test("系统拒绝启动，命令行太长（系统提示文件超长）：说明只写「系统原因：E2BIG」，系统原话在 technical 里", async () => {
  // 系统提示文件的路径相对代码仓根目录；以 agent/ 开头时按 TASKWRIGHT_AGENT_DIR 找，这样超长的文件可以放在临时目录里。
  // 扩展与平台 skill 也按这个目录找，这里不要它们。
  const agentDir = join(tmp, "agent-e2big");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "huge-prompt.md"), "x".repeat(1_000_000), "utf-8");   // 单个参数超过 Linux 的 128 KB 上限
  const script = join(tmp, "pi-e2big");
  writeFileSync(script, "#!/bin/sh\n", "utf-8");
  chmodSync(script, 0o755);
  const savedAgentDir = process.env.TASKWRIGHT_AGENT_DIR;
  process.env.TASKWRIGHT_AGENT_DIR = agentDir;
  try {
    const profile = { ...loadProfile("fake"), executable: script, extensions: [], platform_skill: undefined, system_prompt_file: "agent/huge-prompt.md" };
    const got = await failStart(profile, "runs-e2big");
    assert.equal(got.detail, "系统原因：E2BIG");
    assert.equal(got.text, "助手没有启动起来，系统原因：E2BIG");
    assert.equal(got.apiDetail, "spawn E2BIG");
    assert.doesNotMatch(got.text, FORBIDDEN);
  } finally {
    if (savedAgentDir === undefined) delete process.env.TASKWRIGHT_AGENT_DIR;
    else process.env.TASKWRIGHT_AGENT_DIR = savedAgentDir;
  }
});

test("系统拒绝启动，资源不足与不是可执行格式：真实触发不了，用错误对象测；没有代号时写错误号，错误号也没有时写「未知」", () => {
  // 资源不足（打开的文件数、内存、进程数到了上限）要在测试进程里耗尽系统资源才能触发。不是可执行格式（ENOEXEC）在 Linux 上
  // 触发不了：系统会退回用 /bin/sh 执行这个文件，启动算成功，随后 sh 报错退出。
  const cases: [string, number][] = [["EMFILE", -24], ["ENFILE", -23], ["ENOMEM", -12], ["EAGAIN", -11], ["ENOEXEC", -8]];
  for (const [code, errno] of cases) {
    const e = new PiStartRefused(Object.assign(new Error(`spawn /opt/pi/bin/pi ${code}`), { code, errno, syscall: "spawn /opt/pi/bin/pi" }));
    assert.equal(e.message, `系统原因：${code}`);
    assert.equal(e.reason, code);
    assert.equal(technicalOf(e), `spawn /opt/pi/bin/pi ${code}`);
  }
  // 旧版 Node 不认得 -8 时，code 是一句英文而不是代号
  const unknown = new PiStartRefused(Object.assign(new Error("spawn /opt/pi/bin/pi Unknown system error -8"), { code: "Unknown system error -8", errno: -8 }));
  assert.equal(unknown.message, "系统原因：错误号 -8");
  assert.equal(technicalOf(unknown), "spawn /opt/pi/bin/pi Unknown system error -8");
  assert.equal(new PiStartRefused(new Error("说不清的错误")).message, "系统原因：未知");
  assert.equal(startRefusedText("EACCES"), "系统原因：EACCES");
});

test("状态文字的拼法：没有启动起来时原因用逗号接在后面，不套括号、不补句号；已经退出时照旧放在括号里；没有附带说明时只有固定的那句", () => {
  assert.equal(stateText("failed_to_start", "系统原因：EACCES"), "助手没有启动起来，系统原因：EACCES");
  assert.equal(stateText("failed_to_start", "配置里写的系统提示文件不存在：prompts/x.md"), "助手没有启动起来，配置里写的系统提示文件不存在：prompts/x.md");
  assert.equal(stateText("failed_to_start", ""), "助手没有启动起来。");
  assert.equal(stateText("exited", "助手的程序退出了"), "助手已经退出，下一次说话时会重新启动。（助手的程序退出了）");
  assert.equal(stateText("idle", ""), "助手空闲，可以开始。");
});

test("启动之后立刻退出：页面上是固定的一句，不带助手的程序写到错误输出里的原文；原文与退出码在日志与附带信息里", async () => {
  const script = join(tmp, "pi-exits-at-once");
  writeFileSync(script, `#!/bin/sh\necho "Error: No API key found for /opt/someone/.pi/agent/models.json" >&2\nexit 3\n`, "utf-8");
  chmodSync(script, 0o755);
  const got = await failStart({ ...loadProfile("fake"), executable: script }, "runs-exits");
  assert.equal(got.text, EXITED_AT_START_TEXT);
  assert.equal(`助手现在不可用：${got.text}`, "助手现在不可用：助手启动之后立刻退出了。请把这个页面的地址告诉管理员。");
  assert.equal(got.detail, "");
  assert.doesNotMatch(got.text, /Error|models\.json|\//);
  assert.match(got.apiDetail, /退出码 3/);
  assert.match(got.apiDetail, /No API key found for \/opt\/someone/);
  assert.ok(got.logs.some((l) => l.startsWith("任务 TASK-001 的助手没有启动起来：") && /No API key found/.test(l)));
});

test("没有预料到的启动错误（助手的程序拒绝了启动时的查询）：页面上是固定的一句，它给的英文原因只在日志与附带信息里", async () => {
  // 一个按行读命令、每条都回「拒绝」的假程序：启动时的查询（get_state）被拒，说明里本来会带上它给的英文原因。
  const script = join(tmp, "pi-refuses-all.mjs");
  writeFileSync(script, `#!${process.execPath}
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, type } = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", id, command: type, success: false, error: "Unknown command: " + type }) + "\\n");
});
`, "utf-8");
  chmodSync(script, 0o755);
  const got = await failStart({ ...loadProfile("fake"), executable: script }, "runs-refused");
  assert.equal(got.text, START_FAILED_TEXT);
  assert.equal(`助手现在不可用：${got.text}`, "助手现在不可用：助手没有启动起来。请把这个页面的地址告诉管理员。");
  assert.doesNotMatch(got.text, /Unknown|get_state/);
  assert.equal(got.apiDetail, "pi 拒绝了命令「get_state」：Unknown command: get_state");
});

test("启动失败时页面文字的来历：四种已经写好说明的接在「助手没有启动起来」后面；启动之后立刻退出与其余错误是固定的一句，都不取错误输出", () => {
  assert.deepEqual(startFailure(new PiStartRefused(Object.assign(new Error("spawn /opt/pi EACCES"), { code: "EACCES" }))),
    { detail: "系统原因：EACCES", text: "助手没有启动起来，系统原因：EACCES" });
  assert.deepEqual(startFailure(new PiTimeout("get_state", 60)), { detail: "助手的程序在 60 秒内没有回应。", text: "助手没有启动起来，助手的程序在 60 秒内没有回应。" });
  assert.deepEqual(startFailure(new LaunchError("配置里写的系统提示文件不存在：prompts/x.md")),
    { detail: "配置里写的系统提示文件不存在：prompts/x.md", text: "助手没有启动起来，配置里写的系统提示文件不存在：prompts/x.md" });
  assert.deepEqual(startFailure(new PiExited(1, "Error: boom at /opt/pi/dist/cli.js\n")), { detail: "", text: EXITED_AT_START_TEXT });
  assert.deepEqual(startFailure(new PiRefused("get_state", "Unknown command")), { detail: "", text: START_FAILED_TEXT });
  assert.deepEqual(startFailure(new Error("something unexpected")), { detail: "", text: START_FAILED_TEXT });
});
