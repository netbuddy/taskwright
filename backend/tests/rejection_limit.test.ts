/**
 * 一轮里连续被拒的上限，从头到尾走一遍：真的后端进程、真的 pi、假的语言模型（backend/fake_model）。
 * 假语言模型头几次只回一个不带理解的工具调用，工具每次都因为「这一轮还没有写理解」拒绝；到第 5 次产品停下这次运行，
 * 不再请求模型，页面收到「已经停下」的提示，这一轮的结束原因是 stopped_by_limit；用户再说一句，助手照常回复。
 * 「回复」与「保存修订」各走一遍（它们过的是同一道门）。这里验的是工具在 pi 里的接线，计数的细则在 agent 的单元测试里。
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { LIMIT_STOPPED_TEXT } from "../src/executor.ts";
import { ROOT, captureConsole, spawnBackend, tempDir, within } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const INTENT = '```json\n{"acts": [{"function": "request", "confidence": "high", "summary": "照用户说的做"}]}\n```';
const REPLY = { name: "reply", arguments: { informs: [], act: null, text: "好的。" } };
/** 这些环境变量不带给起起来的后端与假语言模型：免得用到测试之外的配置。pi 的配置目录另指到本例的临时目录。 */
const DROPPED_ENV = ["TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "TASKWRIGHT_RUNS_DIR", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL", "LANGFUSE_TRACING_ENVIRONMENT", "PI_CODING_AGENT_DIR", "TASKWRIGHT_TASKS_ROOT", "TASKWRIGHT_PI_ENTRY"];
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function call(base: string, method: string, path: string, body?: unknown): Promise<Dict> {
  return new Promise((ok, fail) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = request(base + path, { method, headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": data.length } : {}) }, timeout: 60000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}")));
    });
    req.on("error", fail);
    req.end(data);
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((ok) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.once("exit", () => {
      clearTimeout(timer);
      ok();
    });
    child.kill("SIGTERM");
  });
}

/** 订阅任务的事件流，把收到的事件攒起来；waitFor 等到攒下的事件里出现第 n 个叫这个名字的。 */
function subscribe(base: string, task: string) {
  const events: Dict[] = [];
  let buffer = "";
  const req = request(`${base}/api/v1/tasks/${task}/events`, (res) => {
    res.on("data", (c) => {
      buffer += c;
      for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const name = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (name && data) events.push({ name, ...JSON.parse(data) });
      }
    });
  });
  req.on("error", () => {});
  req.end();
  const count = (name: string) => events.filter((e) => e.name === name).length;
  return {
    events,
    close: () => req.destroy(),
    async waitFor(name: string, n: number): Promise<void> {
      while (count(name) < n) await sleep(30);
    },
  };
}

/**
 * 起假语言模型与后端，建任务、开会话，交给 body 去说话；最后都停掉。script 是假语言模型的脚本。
 * 返回值里 requests 读出假语言模型到这一刻收到了几个请求。
 */
async function withStack(name: string, script: Dict, body: (stack: { say: (text: string) => Promise<void>; events: Dict[]; requests: () => number; waitFor: (n: string, k: number) => Promise<void> }) => Promise<void>) {
  const root = join(tmp, name);
  const env: Dict = { ...process.env };
  for (const one of DROPPED_ENV) delete env[one];
  const scriptFile = join(tmp, `${name}.json`);
  writeFileSync(scriptFile, JSON.stringify(script), "utf-8");
  const log = join(tmp, `${name}.jsonl`);
  const fake = spawn(process.execPath, [join(ROOT, "backend", "fake_model", "main.mts"), "--script", scriptFile, "--log", log, "--port", "0", "--agent-dir", join(root, "pi-agent")], { env });
  let out = "";
  fake.stdout!.on("data", (c) => (out += c));
  for (let end = Date.now() + 15000; !out.includes("pi 配置目录已写好"); await sleep(30)) {
    if (fake.exitCode !== null || Date.now() > end) throw new Error(`假语言模型没有起来：${out}`);
  }
  const backendEnv = { ...env, PI_CODING_AGENT_DIR: join(root, "pi-agent"), TASKWRIGHT_LOG_DIR: join(root, "logs"), TASKWRIGHT_SETTINGS_FILE: join(root, "settings.json") };
  const { child: backend, port } = await spawnBackend(["--tasks", join(root, "tasks"), "--runs", join(root, "runs"), "--host", "127.0.0.1", "--profile", "fake"], { cwd: ROOT, env: backendEnv }, 30_000);
  const base = `http://127.0.0.1:${port}`;
  let feed: ReturnType<typeof subscribe> | null = null;
  try {
    const task = (await call(base, "POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: "上限" })).task_id;
    feed = subscribe(base, task);
    await sleep(200);
    const session = (await call(base, "POST", `/api/v1/tasks/${task}/sessions`)).session_id;
    let said = 0;
    const requests = () => {
      try {
        return readFileSync(log, "utf-8").split("\n").filter((line) => line.trim()).length;
      } catch {
        return 0;
      }
    };
    await body({
      events: feed.events, requests, waitFor: feed.waitFor,
      say: async (text) => {
        said += 1;
        await call(base, "POST", `/api/v1/tasks/${task}/messages?session=${session}`, { text, client_id: `c-${said}` });
        await within(`第 ${said} 句话的这一轮结束`, 60_000, feed!.waitFor("work_ended", said));
        await sleep(300);
      },
    });
  } finally {
    feed?.close();
    await stop(backend);
    await stop(fake);
  }
}

test("回复连着 5 次没有写理解：第 5 次之后不再请求模型，提示已经停下，结束原因是 stopped_by_limit；再说一句照常回复", async () => {
  // 头 5 个请求只回不带理解的回复；之后每个请求回带理解的回复。
  const script = { rules: [{ when: {}, reply: { tool_calls: [REPLY] }, max_uses: 5 }], default: { text: INTENT, tool_calls: [REPLY] } };
  await withStack("reply", script, async ({ say, events, requests }) => {
    await say("图书可以借阅多少天");
    assert.equal(requests(), 5, "到第 5 次被拒就停下，不再请求模型");
    await sleep(500);
    assert.equal(requests(), 5, "停下之后没有再转");
    assert.deepEqual(events.filter((e) => e.name === "problem").map((e) => [e.code, e.text]), [["stopped_by_limit", LIMIT_STOPPED_TEXT]]);
    assert.deepEqual(events.filter((e) => e.name === "work_ended").map((e) => [e.outcome, e.step_count]), [["stopped_by_limit", 5]]);
    assert.equal(events.filter((e) => e.name === "assistant_reply").length, 0);
    const summary = events.find((e) => e.name === "work_summary")!;
    assert.equal(summary.outcome, "stopped_by_limit");
    const texts: string[] = summary.stages.map((s: Dict) => s.text);
    assert.ok(texts.includes("助手还没有写下对这句话的理解，正在补"), JSON.stringify(texts));
    assert.equal(texts.at(-1), "助手这一轮没有按规矩回答，已经停下");
    // 实时的每一步：前四次说正在补，第五次说已经停下；没有「回复的形式不对」。
    const steps = events.filter((e) => e.name === "step" && !e.in_progress).map((e) => e.text);
    assert.deepEqual(steps, [...Array(4).fill("助手还没有写下对这句话的理解，正在补"), "助手这一轮没有按规矩回答，已经停下"]);

    await say("那再说一遍");
    assert.equal(requests(), 6);
    assert.deepEqual(events.filter((e) => e.name === "work_ended").map((e) => e.outcome), ["stopped_by_limit", "replied"]);
    assert.deepEqual(events.filter((e) => e.name === "assistant_reply").map((e) => [e.via_reply_tool, e.text]), [[true, "好的。"]]);
    assert.equal(events.filter((e) => e.name === "problem").length, 1, "第二句话不再有提示");
  });
});

test("保存修订连着 5 次没有写理解：同样在第 5 次停下；被拒 4 次之后补上理解的那一轮照常做完", async () => {
  const save = { name: "save_revision", arguments: { operations: [] } };
  // 头 5 个请求只调保存修订、不写理解（第一句话）；接着 4 个请求同样（第二句话），之后带着理解回复。
  const script = { rules: [{ when: {}, reply: { tool_calls: [save] }, max_uses: 9 }], default: { text: INTENT, tool_calls: [REPLY] } };
  await withStack("save", script, async ({ say, events, requests }) => {
    await say("把材料整理成条目");
    assert.equal(requests(), 5);
    assert.deepEqual(events.filter((e) => e.name === "problem").map((e) => e.code), ["stopped_by_limit"]);
    assert.deepEqual(events.filter((e) => e.name === "work_ended").map((e) => e.outcome), ["stopped_by_limit"]);
    const summary = events.find((e) => e.name === "work_summary")!;
    assert.equal(summary.stages.at(-1).text, "助手这一轮没有按规矩回答，已经停下");

    // 用户再说一句，计数从头数：被拒 4 次，第 5 个请求补上了理解并回复，这一轮照常做完。
    await say("再试一次");
    assert.equal(requests(), 10);
    assert.deepEqual(events.filter((e) => e.name === "work_ended").map((e) => e.outcome), ["stopped_by_limit", "replied"]);
    assert.equal(events.filter((e) => e.name === "problem").length, 1);
    assert.deepEqual(events.filter((e) => e.name === "assistant_reply").map((e) => e.text), ["好的。"]);
  });
});
