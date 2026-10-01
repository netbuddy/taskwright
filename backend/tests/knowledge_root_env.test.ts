/**
 * 知识库根目录怎样交给助手：服务有知识库时，启动助手的那一刻环境变量 TASKWRIGHT_KNOWLEDGE_ROOT 是知识库根目录的绝对路径；
 * 服务没有知识库时这个变量不交，后端自己的环境里碰巧有同名变量也不往下传。
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { KNOWLEDGE_ROOT_ENV } from "../../agent/src/lib/knowledge.ts";
import { loadProfile } from "../src/launch.ts";
import { Service } from "../src/service.ts";
import { ROOT, captureConsole, makeWorkspace, sqlGet, tempDir } from "./helpers.ts";

captureConsole();

const FAKE_PI = join(ROOT, "backend", "tests", "fixtures", "fake_pi.mjs");
const ts = "2026-09-27T01:00:00.000Z";
const NOT_SET = "（没有设）";

let tmp: string;
const saved = { entry: process.env.TASKWRIGHT_PI_ENTRY, root: process.env[KNOWLEDGE_ROOT_ENV] };
before(() => {
  tmp = tempDir();
  // 设着 TASKWRIGHT_PI_ENTRY 时启动配置里的可执行文件不起作用，本文件要用自己的脚本记下环境变量
  delete process.env.TASKWRIGHT_PI_ENTRY;
});
after(() => {
  if (saved.entry !== undefined) process.env.TASKWRIGHT_PI_ENTRY = saved.entry;
  if (saved.root === undefined) delete process.env[KNOWLEDGE_ROOT_ENV];
  else process.env[KNOWLEDGE_ROOT_ENV] = saved.root;
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * 一个服务、一个任务、一条会话文件（编号 S1，与假 pi 报的会话编号相同）。助手的可执行文件是一个 shell 脚本：
 * 先把它看到的 TASKWRIGHT_KNOWLEDGE_ROOT 写进 seen-env（没有设时写「（没有设）」），再用当前的 Node 运行假 pi。
 */
function setUp(name: string, knowledgeDir: string | null) {
  const root = join(tmp, name);
  const tasks = join(root, "tasks");
  const ws = makeWorkspace(tasks, "ws", true);
  const taskId = String(sqlGet(ws, "SELECT task_id FROM task")!.task_id);
  const sessions = join(root, "runs", taskId, "pi-sessions", "service");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "s1.jsonl"), JSON.stringify({ type: "session", id: "S1", timestamp: ts, cwd: ws }) + "\n", "utf-8");
  const script = join(root, "pi-script");
  const seen = join(root, "seen-env");
  writeFileSync(script, `#!/bin/sh\nprintf '%s' "\${${KNOWLEDGE_ROOT_ENV}-${NOT_SET}}" > "${seen}"\nexec "${process.execPath}" "${FAKE_PI}" "$@"\n`, "utf-8");
  chmodSync(script, 0o755);
  const service = new Service(tasks, join(root, "runs"), { ...loadProfile("fake"), executable: script }, { port: null, knowledgeDir });
  return { service, t: service.task(taskId), seen };
}

test("服务有知识库：启动助手时环境变量 TASKWRIGHT_KNOWLEDGE_ROOT 是知识库根目录的绝对路径", async () => {
  const knowledge = join(tmp, "with", "..", "with", "knowledge");
  const { service, t, seen } = setUp("with", knowledge);
  try {
    await service.snapshot(t, "S1");
    assert.equal(readFileSync(seen, "utf-8"), resolve(knowledge));
    assert.equal(t.executor.knowledgeRoot, resolve(knowledge));
  } finally {
    await service.close();
  }
});

test("服务没有知识库：不交这个变量，后端自己的环境里碰巧有同名变量也不往下传", async () => {
  process.env[KNOWLEDGE_ROOT_ENV] = join(tmp, "继承来的值");
  const { service, t, seen } = setUp("without", null);
  try {
    await service.snapshot(t, "S1");
    assert.equal(readFileSync(seen, "utf-8"), NOT_SET);
    assert.equal(t.executor.knowledgeRoot, null);
  } finally {
    await service.close();
  }
});
