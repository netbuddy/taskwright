/**
 * 假模型端点自己的测试：不起 pi，直接用 HTTP 请求它，核对脚本的几种用法都按说明工作；
 * 另起一个命令行进程，喂一份脚本、发一串请求，回答、请求记录与写出的 pi 配置目录与期望值逐字比较。
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { writeAgentDir } from "../fake_model/agent_config.ts";
import { FakeModel } from "../fake_model/server.ts";
import { FAKE_MODEL } from "./fixtures/py/inputs.ts";
import { ROOT, tempDir } from "./helpers.ts";

type Dict = Record<string, any>;
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let logNo = 0;
const log = () => join(tmp, `requests-${++logNo}.jsonl`);

function post(baseUrl: string, body: unknown, agent?: Agent): Promise<{ status: number; text: string; headers: Dict }> {
  return new Promise((ok, fail) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request(`${baseUrl}/chat/completions`, { method: "POST", agent, headers: { "Content-Type": "application/json", "Content-Length": data.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf-8"), headers: res.headers }));
    });
    req.on("error", fail);
    req.end(data);
  });
}

const streamChunks = (text: string) => text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
const user = (text: string) => ({ model: "fake-model", messages: [{ role: "user", content: text }] });
const content = (text: string) => JSON.parse(text).choices[0].message.content;

async function withFake<T>(script: unknown, body: (fake: FakeModel) => Promise<T>, logPath: string | null = log()): Promise<T> {
  const fake = await new FakeModel(script, logPath).start();
  try {
    return await body(fake);
  } finally {
    await fake.stop();
  }
}

test("非流式：文字与兜底", () => withFake([{ text: "第一句。" }], async (fake) => {
  const first = await post(fake.baseUrl, user("你好"));
  assert.deepEqual([first.status, content(first.text)], [200, "第一句。"]);
  assert.equal(content((await post(fake.baseUrl, user("还在吗"))).text), "好的。");
}));

test("流式：同一轮两个工具调用", () => withFake([{ tool_calls: [{ name: "read", arguments: { path: "a.md" } }, { name: "ls", arguments: { path: "inputs" }, id: "call-ls" }] }], async (fake) => {
  const got = await post(fake.baseUrl, { ...user("读一下"), stream: true });
  assert.equal(got.status, 200);
  const chunks = streamChunks(got.text);
  const calls = chunks.filter((c) => c.choices.length && "tool_calls" in c.choices[0].delta).map((c) => c.choices[0].delta.tool_calls[0]);
  assert.deepEqual(calls.map((c) => [c.index, c.id, c.function.name]), [[0, "call_fake_1_0", "read"], [1, "call-ls", "ls"]]);
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: "a.md" });
  assert.deepEqual(chunks.filter((c) => c.choices.length && c.choices[0].finish_reason).map((c) => c.choices[0].finish_reason), ["tool_calls"]);
  assert.ok(got.text.trimEnd().endsWith("data: [DONE]"));
}));

test("按条件的规则优先，用完次数就不再用", () => withFake({ rules: [{ when: { last_role: "tool", last_contains: "被拒" }, reply: { text: "我改一下。" }, max_uses: 1 }],
  sequence: [{ text: "按次序的第一条。" }], default: { text: "兜底。" } }, async (fake) => {
  const tool = { model: "fake-model", messages: [{ role: "tool", content: "调用被拒：缺字段" }] };
  const texts = [];
  for (const body of [tool, tool, user("好")]) texts.push(content((await post(fake.baseUrl, body)).text));
  assert.deepEqual(texts, ["我改一下。", "按次序的第一条。", "兜底。"]);
}));

test("第几次请求的条件；按请求现算回答的规则", () => withFake({ rules: [{ when: { request_no: 2 }, reply: { text: "第二次。" } },
  { when: { any_contains: "现算" }, reply_from: (body: Dict) => ({ text: `收到 ${body.messages.length} 条` }) }], default: { text: "别的。" } }, async (fake) => {
  const texts = [];
  for (let i = 0; i < 3; i++) texts.push(content((await post(fake.baseUrl, user("x"))).text));
  assert.deepEqual(texts, ["别的。", "第二次。", "别的。"]);
  assert.equal(content((await post(fake.baseUrl, user("现算一下"))).text), "收到 1 条");
  assert.equal(fake.requests().at(-1)!.按哪一条给的, "rules 第 2 条（按请求现算）");
}));

test("错误状态码", () => withFake([{ status: 503, error_body: "暂时不可用" }, { text: "恢复了。" }], async (fake) => {
  const failed = await post(fake.baseUrl, user("x"));
  assert.deepEqual([failed.status, JSON.parse(failed.text).error], [503, { message: "暂时不可用", type: "fake_error" }]);
  assert.equal((await post(fake.baseUrl, user("x"))).status, 200);
}));

test("错误应答关闭连接：同一条连接上的下一次请求不会卡住", () => withFake([{ status: 500, error_body: "坏了" }, { status: 500, error_body: "又坏了" }], async (fake) => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const first = await post(fake.baseUrl, user("x"), agent);
    assert.deepEqual([first.status, first.headers.connection], [500, "close"]);
    const started = Date.now();
    assert.equal((await post(fake.baseUrl, user("x"), agent)).status, 500);
    assert.ok(Date.now() - started < 1000);
  } finally {
    agent.destroy();
  }
}));

test("故意延迟", () => withFake([{ text: "慢。", delay: 0.6 }], async (fake) => {
  const started = Date.now();
  await post(fake.baseUrl, user("x"));
  assert.ok(Date.now() - started >= 590);
}));

test("请求体原样记下", () => withFake([{ text: "好。" }], async (fake) => {
  const body = { ...user("原样记下这句话"), stream: false, tools: [{ type: "function", function: { name: "ls" } }] };
  await post(fake.baseUrl, body);
  const [entry] = fake.requests();
  assert.deepEqual([entry.序号, entry.请求体, entry.回答, entry.按哪一条给的], [1, body, { text: "好。" }, "sequence 的下一条"]);
}));

test("每个实例各用各的随机端口", () => withFake([{ text: "甲" }], (a) => withFake([{ text: "乙" }], async (b) => {
  assert.notEqual(a.port, b.port);
  assert.equal(content((await post(b.baseUrl, user("x"))).text), "乙");
  assert.equal(content((await post(a.baseUrl, user("x"))).text), "甲");
}, null)));

test("自动补理解：用户说话之后只有工具调用的回答前面补一段理解，别的回答不动", async () => {
  const fake = await new FakeModel([{ tool_calls: [{ name: "ls", arguments: {} }] }, { tool_calls: [{ name: "ls", arguments: {} }] }, { text: "有字", tool_calls: [{ name: "ls" }] }],
    log(), { autoIntent: true }).start();
  try {
    assert.match(content((await post(fake.baseUrl, user("x"))).text), /"summary": "照用户说的做"/);
    assert.equal(content((await post(fake.baseUrl, { messages: [{ role: "tool", content: "结果" }] })).text), null);
    assert.equal(content((await post(fake.baseUrl, user("x"))).text), "有字");
  } finally {
    await fake.stop();
  }
});

test("pi 配置目录只登记假端点", () => {
  const folder = writeAgentDir(join(tmp, "agent"), "http://127.0.0.1:1/v1");
  const models = JSON.parse(readFileSync(join(folder, "models.json"), "utf-8"));
  assert.deepEqual(Object.keys(models.providers), ["fake"]);
  assert.equal(models.providers.fake.baseUrl, "http://127.0.0.1:1/v1");
});

// ───────────── 与期望值逐字对照 ─────────────

/** 起一个命令行假端点，等它打印出地址与 pi 配置目录。 */
async function startCli(dir: string, script: unknown): Promise<{ child: ChildProcess; baseUrl: string }> {
  writeFileSync(join(dir + "-script.json"), JSON.stringify(script), "utf-8");
  const child = spawn(process.execPath, [join(ROOT, "backend", "fake_model", "main.mts"), "--script", dir + "-script.json", "--log", join(dir, "requests.jsonl"),
    "--port", "0", "--agent-dir", join(dir, "pi-agent")]);
  let out = "";
  child.stdout!.on("data", (c) => (out += c));
  child.stderr!.on("data", (c) => (out += c));
  const end = Date.now() + 15000;
  while (!out.includes("pi 配置目录已写好")) {
    if (child.exitCode !== null || Date.now() > end) throw new Error(`假端点没有起来：${out}`);
    await new Promise((ok) => setTimeout(ok, 30));
  }
  return { child, baseUrl: /假端点已启动：(\S+)（只监听本机回环地址）/.exec(out)![1] };
}

test("命令行假端点：一份脚本、一串请求，回答、请求记录与 pi 配置目录与期望值逐字一致", async () => {
  const { script, requests } = FAKE_MODEL;
  const dir = join(tmp, "cli-typescript");
  const { child, baseUrl } = await startCli(dir, script);
  let ours: Dict;
  try {
    const answers = [];
    for (const body of requests) {
      const got = await post(baseUrl, body);
      answers.push([got.status, got.text.replace(/"created": \d+/g, '"created": <秒>')]);
    }
    const lines = readFileSync(join(dir, "requests.jsonl"), "utf-8").replace(/"时刻": [0-9.]+/g, '"时刻": <秒>');
    const agent = ["models.json", "settings.json", "auth.json"].map((f) => readFileSync(join(dir, "pi-agent", f), "utf-8").replace(baseUrl, "<地址>"));
    ours = { answers, lines, agent };
  } finally {
    child.kill("SIGTERM");
    await new Promise((ok) => (child.exitCode !== null ? ok(null) : child.once("exit", ok)));
  }
  // 期望值在 fixtures/py/fake_model_cli.json（说明见那里的 README.md）。
  const expected = JSON.parse(readFileSync(join(ROOT, "backend", "tests", "fixtures", "py", "fake_model_cli.json"), "utf-8"));
  assert.deepEqual(ours.answers, expected.answers);
  assert.equal(ours.lines, expected.lines);
  assert.deepEqual(ours.agent, expected.agent);
  assert.equal(expected.lines.split("\n").filter(Boolean).length, requests.length);
});
