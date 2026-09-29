/**
 * 启动助手之前准备目录与文件时出错（没有写权限、磁盘满、续接前备份会话文件失败）：页面上是一句带系统代号的中文，
 * 不带 Node 的英文原话与绝对路径；原话在日志与接口错误的附带信息里。打开归档文件打开到一半出错时，已经打开的关掉。
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { Executor } from "../src/executor.ts";
import { Hub } from "../src/hub.ts";
import { loadProfile } from "../src/launch.ts";
import { PiPrepareFailed, PiSession, prepareFailedText, technicalOf } from "../src/pi_session.ts";
import { localStamp } from "../src/py.ts";
import { ROOT, captureConsole, makeWorkspace, tempDir } from "./helpers.ts";

const logs = captureConsole();

type Dict = Record<string, any>;
const FAKE_PI = join(ROOT, "backend", "tests", "fixtures", "fake_pi.mjs");
/** 以 root 身份跑时权限拦不住写入，那两例跳过。 */
const asRoot = process.getuid?.() === 0;

let tmp: string;
let ws: string;
before(() => {
  tmp = tempDir();
  ws = makeWorkspace(tmp, "ws", true);
});
after(() => {
  for (const dir of [join(tmp, "locked"), join(tmp, "locked-sessions")]) if (existsSync(dir)) chmodSync(dir, 0o755);
  rmSync(tmp, { recursive: true, force: true });
});

const openFiles = () => readdirSync("/proc/self/fd").length;

test("措辞：说明写系统代号，页面上接在「助手现在不可用：」后面读成一句；取不到代号时写「未知」", () => {
  assert.equal(`助手现在不可用：${prepareFailedText("EACCES")}`,
    "助手现在不可用：启动助手之前，任务服务没能写入它要用的文件，系统原因：EACCES。请把这个页面的地址告诉管理员。");
  const e = new PiPrepareFailed(Object.assign(new Error("ENOSPC: no space left on device, open '/srv/runs/x.jsonl'"), { code: "ENOSPC" }));
  assert.equal(e.message, prepareFailedText("ENOSPC"));
  assert.equal(technicalOf(e), "ENOSPC: no space left on device, open '/srv/runs/x.jsonl'");
  assert.equal(new PiPrepareFailed(new Error("说不清的错误")).message, prepareFailedText("未知"));
});

test("运行目录没有写权限：页面上是带 EACCES 的一句，不带路径与英文原话；原话在日志与附带信息里", { skip: asRoot }, async () => {
  const locked = join(tmp, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  const hub = new Hub(ws);
  const [sub] = hub.subscribe(null, null);
  const executor = new Executor("TASK-001", ws, join(locked, "runs"), loadProfile("fake"), hub);
  const before = logs.length;
  let apiError: ApiError | null = null;
  try {
    await executor.newSession();
  } catch (error) {
    apiError = error as ApiError;
  }
  const states: Dict[] = [];
  for (let item = await sub.get(10); item; item = await sub.get(10)) if (item[0] === "executor_state") states.push(item[2]);
  hub.close();
  assert.ok(apiError instanceof ApiError && apiError.code === "executor_unavailable");
  const text = states.at(-1)!.text as string;
  assert.equal(text, prepareFailedText("EACCES"));
  assert.equal(executor.view().text, text, "刷新之后看到的相同");
  assert.doesNotMatch(text, /permission|mkdir|\//);
  assert.match(String(apiError.data.detail), /^EACCES: permission denied, mkdir '.*locked/);
  assert.ok(logs.slice(before).some((l) => l.startsWith("任务 TASK-001 的助手没有启动起来：EACCES: permission denied")));
});

test("续接前备份会话文件失败（会话文件所在目录没有写权限）：按准备文件出错报", { skip: asRoot }, async () => {
  const dir = join(tmp, "locked-sessions");
  mkdirSync(dir);
  const file = join(dir, "s1.jsonl");
  // 会话文件记的工作目录与本服务的任务目录不同，续接前要先备份再改写。
  writeFileSync(file, JSON.stringify({ type: "session", id: "S1", timestamp: "2026-09-28T01:00:00.000Z", cwd: "/elsewhere" }) + "\n", "utf-8");
  chmodSync(dir, 0o555);
  const pi = new PiSession(loadProfile("fake"), ws, join(tmp, "runs-rebase"), "service", tmp);
  await assert.rejects(pi.start(file), (e: unknown) => e instanceof PiPrepareFailed && e.reason === "EACCES" && /\.bak/.test(technicalOf(e)));
});

test("打开归档文件打开到一半出错：已经打开的关掉，按准备文件出错报", async () => {
  const runs = join(tmp, "runs-half");
  const events = join(runs, "pi-events");
  mkdirSync(events, { recursive: true });
  // 归档文件名精确到秒：把接下来几秒的「后端补记」文件名先占成目录，原始事件流能打开，打开后端补记时报 EISDIR。
  const now = Date.now();
  for (let s = 0; s < 5; s++) {
    const stamp = localStamp(new Date(now + s * 1000)).replace(/[-:]/g, "").replace("T", "-");
    mkdirSync(join(events, `service-${stamp}.backend.jsonl`));
  }
  const savedEntry = process.env.TASKWRIGHT_PI_ENTRY;
  process.env.TASKWRIGHT_PI_ENTRY = FAKE_PI;
  const fds = openFiles();
  try {
    const pi = new PiSession(loadProfile("fake"), ws, runs, "service", tmp);
    await assert.rejects(pi.start(), (e: unknown) => e instanceof PiPrepareFailed && e.reason === "EISDIR");
    assert.equal(pi.process, null, "没有起子进程");
  } finally {
    if (savedEntry === undefined) delete process.env.TASKWRIGHT_PI_ENTRY;
    else process.env.TASKWRIGHT_PI_ENTRY = savedEntry;
  }
  assert.equal(openFiles(), fds, "没有留下没关的文件");
  // 占位的目录也是这组文件名里原来就有的一份，照「有一份原来就有，三份都保留」的规矩，打开过的原始事件流留着。
  assert.equal(readdirSync(events).filter((n) => !n.endsWith(".backend.jsonl")).length, 1);
});
