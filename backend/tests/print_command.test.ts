/**
 * print_command.mts（scripts/tui.sh 用它拿 pi 的命令行）：--shell 的输出交给 bash 执行之后，位置参数与 buildCommand 拼出的逐项相同
 * （系统提示里有换行、引号与反斜杠，检验单引号转义）；另加的环境变量进了 shell；续接、会话文件、任务目录不对时的拒绝。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildCommand, loadProfile } from "../src/launch.ts";
import { ROOT, makeWorkspace, tempDir } from "./helpers.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const SCRIPT = join(ROOT, "backend", "src", "print_command.mts");
const FAKE_PI = join(ROOT, "backend", "tests", "fixtures", "fake_pi.mjs");
const ws = makeWorkspace(tmp, "ws", true);
const env = { ...process.env, TASKWRIGHT_RUNS_DIR: join(tmp, "runs"), TASKWRIGHT_PI_ENTRY: FAKE_PI, TASKWRIGHT_LANGFUSE_ENV_FILE: "" };

function run(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8", env: { ...env, ...extraEnv } });
}

test("--shell 的输出经 bash 执行后，命令行与 buildCommand 逐项相同，任务目录与会话目录也给出", () => {
  const shell = `eval "$(${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} --task ${JSON.stringify(ws)} --profile fake --shell --env-tag "它's \\"标签\\"")"; ` +
    `printf '%s\\0' "$TW_WORKSPACE" "$TW_SESSION_DIR" "$LANGFUSE_TRACING_ENVIRONMENT" "$@"`;
  const done = spawnSync("bash", ["-c", shell], { encoding: "utf-8", env });
  assert.equal(done.status, 0, done.stderr);
  const [workspace, sessionDir, tag, ...argv] = done.stdout.split("\0").slice(0, -1);
  const expected = (() => {
    const saved = process.env.TASKWRIGHT_PI_ENTRY;
    process.env.TASKWRIGHT_PI_ENTRY = FAKE_PI;
    try {
      return buildCommand(loadProfile("fake"), ws, join(tmp, "runs", "pi-sessions", "tui"), null, true);
    } finally {
      if (saved === undefined) delete process.env.TASKWRIGHT_PI_ENTRY;
      else process.env.TASKWRIGHT_PI_ENTRY = saved;
    }
  })();
  assert.deepEqual(argv, [expected.command, ...expected.args]);
  assert.ok(argv.includes("--system-prompt") && argv[argv.indexOf("--system-prompt") + 1].includes("\n"), "系统提示全文原样带过去");
  assert.equal(argv.includes("--mode"), false, "交互模式不写 --mode");
  assert.deepEqual([workspace, sessionDir, tag], [ws, join(tmp, "runs", "pi-sessions", "tui"), `它's "标签"`]);
});

test("不给 --shell 时打印给人看的几行，系统提示全文换成它来自哪个文件", () => {
  const done = run(["--task", ws, "--profile", "fake", "--label", "试一下"]);
  assert.equal(done.status, 0, done.stderr);
  const lines = done.stdout.trimEnd().split("\n");
  assert.match(lines[0], /^任务 TASK-001「.*」，状态是进行中；任务目录 /);
  assert.equal(lines[1], `会话文件放在 ${join(tmp, "runs", "pi-sessions", "试一下")}，这次开一条新会话`);
  assert.match(lines[3], /（系统提示全文，取自 [^）]+executor_system_prompt\.md）/);
});

test("续接：--continue 取最近的会话文件，--session 用给的那一个；没有可续接的、文件不存在、任务目录不对时拒绝", () => {
  const dir = join(tmp, "runs", "pi-sessions", "续接");
  assert.match(run(["--task", ws, "--profile", "fake", "--label", "续接", "--continue"]).stderr, /里还没有会话文件可以续接，去掉 --continue 开一条新会话。/);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.jsonl"), "{}\n");
  assert.match(run(["--task", ws, "--profile", "fake", "--label", "续接", "--continue"]).stdout, /，续接 .*a\.jsonl/);
  assert.match(run(["--task", ws, "--profile", "fake", "--session", join(dir, "没有.jsonl")]).stderr, /^启动不了：会话文件 .*没有\.jsonl 不存在。/);
  const noTask = run(["--task", join(tmp, "空目录"), "--profile", "fake"]);
  assert.deepEqual([noTask.status, /任务目录 .*空目录 不存在。先在网页里/.test(noTask.stderr)], [2, true]);
  mkdirSync(join(tmp, "没有库"), { recursive: true });
  assert.match(run(["--task", join(tmp, "没有库"), "--profile", "fake"]).stderr, /里还没有任务记录/);
  assert.match(run(["--task", ws, "--profile", "fake", "--continue", "--session", "x"]).stderr, /--continue 与 --session 只能给一个。/);
});
