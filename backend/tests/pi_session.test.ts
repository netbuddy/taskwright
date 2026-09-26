/**
 * pi 子进程与 RPC：用测试用的假 pi（tests/fixtures/fake_pi.mjs，经 TASKWRIGHT_PI_ENTRY 注入）测命令的收发与超时、
 * 界面请求的应答、合成的事件、三种归档文件的写法、关闭顺序与进程退出；另测启动配置拼出的 pi 命令行与 Python 版逐字一致、
 * 续接前改写会话文件记的工作目录。对应服务端 Python 测试 test_launch_skills、test_isolation（续接）与集成测试 test_rpc 的收发部分。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildCommand, loadProfile, piLauncher } from "../src/launch.ts";
import { PiExited, PiRefused, PiSession, PiTimeout, rebaseSessionCwd } from "../src/pi_session.ts";
import { ROOT, tempDir } from "./helpers.ts";

const FAKE_PI = join(ROOT, "backend", "tests", "fixtures", "fake_pi.mjs");
const PROFILE = { mode: "rpc", extensions: [], tools: ["read", "reply"], flags: { approve: true }, model: "fake/fake-model" };

let tmp: string;
let workspace: string;
const saved = process.env.TASKWRIGHT_PI_ENTRY;
before(() => {
  tmp = tempDir();
  workspace = join(tmp, "ws");
  cpSync(join(ROOT, "task-types", "srs-authoring"), workspace, { recursive: true });
  process.env.TASKWRIGHT_PI_ENTRY = FAKE_PI;
});
after(() => {
  if (saved === undefined) delete process.env.TASKWRIGHT_PI_ENTRY;
  else process.env.TASKWRIGHT_PI_ENTRY = saved;
  rmSync(tmp, { recursive: true, force: true });
});

const lines = (path: string) => readFileSync(path, "utf-8").split("\n").filter(Boolean);

async function drain(pi: PiSession, until: (e: Record<string, any>) => boolean) {
  const seen: Record<string, any>[] = [];
  for (;;) {
    const e = await pi.nextEvent(5000);
    assert.ok(e, `等事件超时；已收到：${seen.map((x) => x.type).join("、")}`);
    seen.push(e);
    if (until(e)) return seen;
  }
}

test("启动配置拼出的 pi 命令行、启动记录与 Python 版逐字一致", () => {
  const profile = loadProfile("dev");
  profile.extensions = profile.extensions.filter((e: any) => e.source === "repo");
  delete process.env.TASKWRIGHT_PI_ENTRY;
  try {
    const ours = buildCommand(profile, workspace, join(tmp, "sd"), join(tmp, "s.jsonl"));
    const script = "import json, sys\nfrom pathlib import Path\nfrom taskwright_server import launch\n" +
      "p = launch.load_profile('dev'); p['extensions'] = [e for e in p['extensions'] if e['source'] == 'repo']\n" +
      "argv, env = launch.build_command(p, Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))\nprint(json.dumps(argv, ensure_ascii=False))";
    const done = spawnSync(process.env.TASKWRIGHT_PYTHON || "python3", ["-c", script, workspace, join(tmp, "sd"), join(tmp, "s.jsonl")],
      { encoding: "utf-8", env: { ...process.env, PYTHONPATH: join(ROOT, "server") } });
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(ours.argv, JSON.parse(done.stdout));
  } finally {
    process.env.TASKWRIGHT_PI_ENTRY = FAKE_PI;
  }
});

test("注入 pi 的入口脚本时用当前的 Node 运行它；入口不存在时报清楚", () => {
  const launcher = piLauncher(PROFILE);
  assert.deepEqual([launcher.command, launcher.prefix, launcher.shown], [process.execPath, [FAKE_PI], [process.execPath, FAKE_PI]]);
  process.env.TASKWRIGHT_PI_ENTRY = join(tmp, "没有这个文件.js");
  try {
    assert.throws(() => piLauncher(PROFILE), /pi 入口脚本不存在/);
  } finally {
    process.env.TASKWRIGHT_PI_ENTRY = FAKE_PI;
  }
});

test("启动：三种归档文件、后端补记各种记录、收到时刻与原始事件流逐行对齐；界面请求的应答；合成的事件", async () => {
  const pi = new PiSession(PROFILE, workspace, join(tmp, "runs-1"), "service", tmp);
  await pi.start();
  try {
    const events = await drain(pi, (e) => e.type === "界面请求" && e.method === "confirm");
    // 任务现状的状态栏请求先按普通界面请求记一条（不需要应答），再合成一条系统说明。
    assert.deepEqual(events.map((e) => e.type), ["非JSON行", "实际工具清单", "界面请求", "system_note", "界面请求"]);
    assert.equal(events[2].status_key, "taskwright-task-status");
    assert.deepEqual(events[3], { type: "system_note", custom_type: "taskwright-task-status", text: "任务现状", details: { n: 1 }, entry_id: "e0000001", session_id: "S1" });
    assert.equal(events[4].answered, "回了「否」");
    const answer = await drain(pi, (e) => e.type === "debug_ui_answer");
    assert.deepEqual(answer.at(-1)!.answer, { type: "extension_ui_response", id: "u3", confirmed: false });
    assert.deepEqual(pi.badLines, ["这不是 JSON"]);
    assert.equal(pi.systemNotes.length, 1);
  } finally {
    await pi.close();
  }
  const notes = lines(pi.notesPath!).map((l) => JSON.parse(l));
  const kinds = notes.map((n) => n["记录"]);
  for (const kind of ["启动", "知识仓库摘要", "上下文文件", "已加载的 skill", "实际工具清单", "扩展写入的消息", "界面请求应答", "标准错误", "退出"]) {
    assert.ok(kinds.includes(kind), `补记里有「${kind}」`);
  }
  assert.deepEqual(kinds.slice(0, 3), ["启动", "知识仓库摘要", "上下文文件"]);
  assert.match(notes[0]["时刻"], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  const start = notes[0];
  assert.deepEqual([start["命令行"].slice(0, 2), start["任务目录"], start["是不是重启接回"], start["归档文件"]],
    [[process.execPath, FAKE_PI], workspace, false, readdirSync(join(tmp, "runs-1", "pi-events")).find((f) => /^service-\d{8}-\d{6}\.jsonl$/.test(f))]);
  assert.deepEqual(notes.find((n) => n["记录"] === "已加载的 skill").skill, [{ 名字: "taskwright-executor", 描述: "平台", 文件: "/x/SKILL.md" }]);
  assert.deepEqual(notes.find((n) => n["记录"] === "标准错误")["文字"], "假 pi 启动了");
  assert.equal(notes.at(-1)["记录"], "退出");
  assert.equal(notes.at(-1)["退出码"], 0);
  assert.match(readFileSync(pi.notesPath!, "utf-8").split("\n")[0], /^\{"记录": "启动", "时刻": "/, "各项之间「逗号加空格」、键值之间「冒号加空格」，与 Python 版写出的文件逐字相同");
  const raw = lines(pi.archivePath!);
  assert.equal(raw[0], "这不是 JSON", "原始事件流原样照写，不是 JSON 的行也写");
  const times = lines(pi.timesPath!).map((l) => JSON.parse(l));
  assert.deepEqual(times.map((t) => t["行号"]), raw.map((_, i) => i + 1), "收到时刻文件的第 N 行对应原始事件流的第 N 行");
  assert.ok(times.every((t) => typeof t["收到时刻"] === "number"));
});

test("命令：回应、被拒、超时、进程退出", async () => {
  const pi = new PiSession(PROFILE, workspace, join(tmp, "runs-2"), "service", tmp);
  await pi.start();
  try {
    assert.deepEqual(await pi.getState(), { sessionId: "S1", sessionFile: null, isCompacting: false });
    await assert.rejects(pi.request("refuse"), (e: unknown) => e instanceof PiRefused && /pi 拒绝了命令「refuse」：不认这条命令/.test((e as Error).message));
    await assert.rejects(pi.request("slow", {}, 300), (e: unknown) => e instanceof PiTimeout && /等 pi 回应命令「slow」等了 0 秒还没等到/.test((e as Error).message));
    await assert.rejects(pi.request("die"), PiExited);
    assert.equal(pi.alive(), false);
    await drain(pi, (e) => e.type === "进程已退出");
    assert.throws(() => (pi as any).write({ type: "get_state" }), PiExited);
  } finally {
    await pi.close();
  }
  const notes = lines(pi.notesPath!).map((l) => JSON.parse(l));
  assert.deepEqual(notes.filter((n) => n["记录"] === "退出").map((n) => n["退出码"]), [3], "退出只记一次");
});

test("发话：逐条交出一次运行的事件，直到 agent_settled；扩展写入的自定义消息另合成一条系统说明", async () => {
  const pi = new PiSession(PROFILE, workspace, join(tmp, "runs-3"), "service", tmp);
  await pi.start();
  try {
    const seen = [];
    for await (const e of pi.send("你好")) seen.push(e.type);
    assert.deepEqual(seen.filter((t) => !["非JSON行", "实际工具清单", "界面请求", "debug_ui_answer"].includes(t)),
      ["agent_start", "本轮事实", "turn_start", "message_end", "message_end", "system_note", "tool_execution_start", "tool_execution_end", "turn_end", "agent_settled"]);
  } finally {
    await pi.close();
  }
  const notes = lines(pi.notesPath!).map((l) => JSON.parse(l));
  assert.ok(notes.some((n) => n["记录"] === "提示" && n["原文"] === "你好" && /^service-\d+$/.test(n["下一条请求编号"])));
  assert.ok(notes.some((n) => n["记录"] === "本轮事实" && n["内容"].turnIndex === 0));
});

test("续接前改写会话文件记的工作目录，原文件原样备份；已经一致时什么都不做", () => {
  const dir = join(tmp, "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "s.jsonl");
  const original = JSON.stringify({ type: "session", id: "S1", cwd: "/别处/任务" }) + "\n" + JSON.stringify({ type: "message", id: "a" }) + "\n";
  writeFileSync(file, original, "utf-8");
  const [old, backup] = rebaseSessionCwd(file, workspace)!;
  assert.equal(old, "/别处/任务");
  assert.equal(readFileSync(backup, "utf-8"), original);
  assert.match(backup, /s\.jsonl\.cwd-\d{8}-\d{6}\.bak$/);
  const rewritten = readFileSync(file, "utf-8").split("\n");
  assert.deepEqual(JSON.parse(rewritten[0]), { type: "session", id: "S1", cwd: workspace });
  assert.equal(rewritten[1], original.split("\n")[1], "第一行以外一个字不改");
  assert.equal(rebaseSessionCwd(file, workspace), null);
});
