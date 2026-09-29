/**
 * 示例脚本 examples/library-lending/run.sh 从头到尾跑一遍：起真的后端进程与真的 pi，模型换成进程内的假端点
 * （按 examples/library-lending/fake-model.json 回答，与 scripts/dev.sh --demo 用的是同一份），脚本退出码要是 0，生成的文档开头写明按哪个修订生成、里面有那个用例。
 * 免得接口改了之后示例脚本悄悄失效（曾经读快照里不存在的字段名，第 6 步报错）。
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { writeAgentDir } from "../fake_model/agent_config.ts";
import { FakeModel } from "../fake_model/server.ts";
import { ROOT, spawnBackend, tempDir } from "./helpers.ts";

type Dict = Record<string, any>;
const SCRIPT = join(ROOT, "examples", "library-lending", "run.sh");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const missing = ["pi", "curl", "python3", "bash"].filter((cmd) => spawnSync(cmd, ["--version"], { encoding: "utf-8" }).error);
const SKIP = missing.length ? `本机 PATH 上没有 ${missing.join("、")}` : false;
const DROPPED_ENV = ["TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "TASKWRIGHT_RUNS_DIR", "TASKWRIGHT_TASKS_ROOT",
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "LANGFUSE_TRACING_ENVIRONMENT"];

/** 与 scripts/dev.sh --demo 用同一份假模型脚本：第一句话之后保存几个条目（摘录取自示例材料），再经「回复」工具回一句。 */
const MODEL_SCRIPT = JSON.parse(readFileSync(join(ROOT, "examples", "library-lending", "fake-model.json"), "utf-8"));

function run(cmd: string, args: string[], cwd: string, env: Dict): Promise<{ code: number | null; out: string }> {
  return new Promise((ok) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.once("exit", (code) => ok({ code, out }));
  });
}

test("示例脚本从建任务到生成文档跑通：退出码 0，文档写明按修订 1 生成，里面有保存的用例与问题", { skip: SKIP, timeout: 180_000 }, async () => {
  const fake = await new FakeModel(MODEL_SCRIPT).start();
  const env: Dict = { ...process.env, PI_CODING_AGENT_DIR: writeAgentDir(join(tmp, "pi-agent"), fake.baseUrl), TASKWRIGHT_LOG_DIR: join(tmp, "logs") };
  for (const name of DROPPED_ENV) delete env[name];
  let backend: ChildProcess | null = null;
  try {
    const started = await spawnBackend(["--tasks", join(tmp, "tasks"), "--runs", join(tmp, "runs"), "--profile", "fake", "--host", "127.0.0.1"], { cwd: ROOT, env });
    backend = started.child;
    const port = started.port;
    const work = join(tmp, "work");
    mkdirSync(work);
    const done = await run("bash", [SCRIPT, `http://127.0.0.1:${port}`], work, env);
    assert.equal(done.code, 0, done.out);
    const written = readdirSync(work).filter((n) => /^srs-TASK-.+\.md$/.test(n));
    assert.equal(written.length, 1, done.out);
    const doc = readFileSync(join(work, written[0]), "utf-8");
    assert.match(doc.split("\n").slice(0, 5).join("\n"), /本文档按交付物的修订 1 生成/);
    assert.match(doc, /借书/);
    assert.match(doc, /罚款怎样缴纳/);
  } finally {
    backend?.kill("SIGTERM");
    if (backend && backend.exitCode === null) await new Promise((ok) => backend!.once("exit", ok));
    await fake.stop();
  }
});
