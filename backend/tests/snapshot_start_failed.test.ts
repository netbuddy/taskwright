/**
 * 助手启动不起来时打开或刷新会话页面：快照照常返回这条会话的对话与条目，执行者状态是 failed_to_start、文字带原因
 * （与实时推送的 executor_state 同一个拼法），页面据此整页只读。每次打开都再试着启动一次：连续三次结果相同，
 * 不留下子进程，也不留下没关的文件；问题修好之后（把可执行文件的权限改回）再打开，助手照常启动。
 * 别的打不开的原因（正在启动、会话不存在）照旧报错。
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { loadProfile } from "../src/launch.ts";
import { Service } from "../src/service.ts";
import { ROOT, captureConsole, makeWorkspace, sqlGet, tempDir } from "./helpers.ts";

// 启动失败时后端写日志，收进内存，不写标准输出（原因见 helpers.ts 的 captureConsole）。
captureConsole();

type Dict = Record<string, any>;
const FAKE_PI = join(ROOT, "backend", "tests", "fixtures", "fake_pi.mjs");
const ts = "2026-09-27T01:00:00.000Z";

let tmp: string;
const savedEntry = process.env.TASKWRIGHT_PI_ENTRY;
before(() => {
  tmp = tempDir();
  // 设着 TASKWRIGHT_PI_ENTRY 时启动配置里的可执行文件不起作用，本文件要用它造出启动失败
  delete process.env.TASKWRIGHT_PI_ENTRY;
});
after(() => {
  if (savedEntry !== undefined) process.env.TASKWRIGHT_PI_ENTRY = savedEntry;
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * 一个服务、一个带条目的任务、一条会话文件（编号 S1，与假 pi 报的会话编号相同）。
 * 助手的可执行文件是一个 shell 脚本，用当前的 Node 运行假 pi；mode 给 0o644 时系统拒绝执行（EACCES）。
 */
function setUp(name: string, executable: (dir: string) => string) {
  const root = join(tmp, name);
  const tasks = join(root, "tasks");
  const ws = makeWorkspace(tasks, "ws", true);
  const taskId = String(sqlGet(ws, "SELECT task_id FROM task")!.task_id);
  const sessions = join(root, "runs", taskId, "pi-sessions", "service");
  mkdirSync(sessions, { recursive: true });
  const lines = [
    { type: "session", id: "S1", timestamp: ts, cwd: ws },
    { type: "message", id: "u1", parentId: null, timestamp: ts, message: { role: "user", content: "请整理材料" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "整理好了。" }] } },
  ];
  writeFileSync(join(sessions, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  const service = new Service(tasks, join(root, "runs"), { ...loadProfile("fake"), executable: executable(root) }, { port: null });
  return { service, t: service.task(taskId), root };
}

function piScript(root: string, mode: number): string {
  const script = join(root, "pi-script");
  writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PI}" "$@"\n`, "utf-8");
  chmodSync(script, mode);
  return script;
}

const openFiles = () => readdirSync("/proc/self/fd").length;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function assertReadable(snap: Dict) {
  assert.deepEqual(snap.conversation.messages.map((m: Dict) => [m.type, m.message_id]), [["user_message", "u1"], ["assistant_reply", "a1"]]);
  assert.ok(snap.task.items.some((i: Dict) => i.item_id === "UC-001"), "条目照常给");
  assert.equal(snap.session.session_id, "S1");
}

test("系统拒绝启动（EACCES）：快照照常给对话与条目，执行者状态带原因；反复打开结果相同，不留子进程与没关的文件；修好之后照常启动", async () => {
  const { service, t, root } = setUp("eacces", (r) => piScript(r, 0o644));
  try {
    // 启动失败的那个子进程的三根管道在 error 事件之后才由 Node 异步关掉，所以先打开一次、稍等，再数文件，之后三次不应再增加。
    assertReadable(await service.snapshot(t, "S1"));
    await sleep(300);
    const fds = openFiles();
    for (let i = 0; i < 3; i++) {
      const snap = await service.snapshot(t, "S1");
      assertReadable(snap);
      assert.deepEqual(snap.executor, { state: "failed_to_start", text: "助手没有启动起来，系统原因：EACCES", active_session: null });
      assert.equal(t.executor.pi, null, "没有留下子进程");
    }
    await sleep(300);
    assert.equal(openFiles(), fds, "没有留下没关的文件");
    // 每次失败的启动都打开一组归档文件（原始事件流、后端补记、收到时刻；文件名精确到秒，同一秒里的几次共用一组），都是空的：
    // spawn 没成功，什么都没写。
    const events = join(root, "runs", t.taskId, "pi-events");
    assert.ok(readdirSync(events).length >= 3);
    assert.ok(readdirSync(events).every((f) => statSync(join(events, f)).size === 0));

    chmodSync(join(root, "pi-script"), 0o755);
    // 助手起来之后对话记录改由它给（假 pi 不带对话），这里只核对它照常启动、接上了这条会话。
    const fixed = await service.snapshot(t, "S1");
    assert.equal(fixed.session.session_id, "S1");
    assert.deepEqual(fixed.executor, { state: "idle", text: "助手空闲，可以开始。", active_session: "S1" });
    assert.ok(t.executor.running());
  } finally {
    await service.close();
  }
});

test("没有安装（PATH 里找不到程序）：快照照常给，执行者状态写「找不到助手的程序（pi），请检查安装。」", async () => {
  const { service, t } = setUp("missing", () => "taskwright-no-such-program");
  try {
    const snap = await service.snapshot(t, "S1");
    assertReadable(snap);
    assert.deepEqual(snap.executor, { state: "failed_to_start", text: "助手没有启动起来，找不到助手的程序（pi），请检查安装。", active_session: null });
  } finally {
    await service.close();
  }
});

test("别的打不开的原因照旧报错：会话不存在时报 not_found，不因为助手启动不起来而改成照常返回", async () => {
  const { service, t } = setUp("other", (r) => piScript(r, 0o644));
  try {
    await service.snapshot(t, "S1");     // 先让执行者处在 failed_to_start
    await assert.rejects(service.snapshot(t, "没有这条会话"), (e: unknown) => e instanceof ApiError && e.code === "not_found");
  } finally {
    await service.close();
  }
});
