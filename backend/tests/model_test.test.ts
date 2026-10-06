/**
 * 测试语言模型的接口（docs/api.md §10）：POST /api/v1/model-config/test。在本进程里直接调接口，起真的 pi，模型换成进程内的假端点。
 * 通过、没有调用工具、回答里没有箱数、模型服务报错、超时、同时来第二个请求、助手起不来、模型登记里找不到、没有密钥、没有模型可测、type 写错各一例；
 * 每一例之后核对助手已经停了（起助手用的收发数据层都报程序不在跑了）、临时目录已经删了（系统临时目录指到本文件自己的空目录，例后仍是空的）。
 * pi 的配置目录与产品设置文件都在本文件的临时目录里。
 *
 * 同一个接口也测试嵌入模型（type 是 embedding）：不起助手，嵌入模型的服务是本文件里起的一个假服务。通过、没有通过、没有选嵌入模型、
 * 到时间没有回答各一例；两种测试共用「同一时间只跑一个」，两个方向各一例。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { writeAgentDir } from "../fake_model/agent_config.ts";
import { FakeModel } from "../fake_model/server.ts";
import { dispatch } from "../src/http.ts";
import { loadProfile } from "../src/launch.ts";
import { testEmbeddingModel, testLanguageModel } from "../src/model_test.ts";
import { updatePiDirSettings } from "../src/product_settings.ts";
import { Service } from "../src/service.ts";
import { RpcTransport } from "../src/transport_rpc.ts";
import { captureConsole, tempDir } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
const NO_PI = spawnSync("pi", ["--version"], { encoding: "utf-8" }).error ? "本机 PATH 上没有 pi" : false;
const CASE = { skip: NO_PI };
const ENV_NAMES = ["PI_CODING_AGENT_DIR", "TASKWRIGHT_SETTINGS_FILE", "PI_OFFLINE", "TMPDIR"];

let tmp: string;
/** 系统临时目录指到这里：接口建的临时目录都在它下面，例后应当只剩 pi 自己的编译缓存目录。 */
let osTmp: string;
/** pi 启动时在系统临时目录下建的 Node 编译缓存目录：不是接口建的，测完还在。 */
const PI_COMPILE_CACHE = "node-compile-cache";
/** 系统临时目录下除 pi 的编译缓存目录以外的东西。 */
const leftInOsTmp = (): string[] => readdirSync(osTmp).filter((name) => name !== PI_COMPILE_CACHE);
let fake: FakeModel;
let service: Service;
const saved: Dict = {};
/** 这一例里起助手用过的收发数据层，按先后排。 */
const transports: RpcTransport[] = [];
const tracked = () => {
  const transport = new RpcTransport();
  transports.push(transport);
  return transport;
};
/** 直接调接口背后的函数，起助手用记得住的收发数据层。 */
const run = (profile: Dict = service.profile, timeoutMs?: number) => testLanguageModel({ env: process.env, profile }, { makeTransport: tracked, timeoutMs });

/** 假的嵌入服务（ollama 的接口）：embedReply 定它怎样回答，embedHits 记下收到的每个请求体。 */
let embedder: Server;
let embedUrl: string;
let embedReply: (body: Dict) => { body: unknown; delay?: number };
const embedHits: Dict[] = [];
/** 每段文字回一条 1024 个数的数字串。 */
const embedded = (body: Dict) => ({ body: { model: body.model, embeddings: body.input.map(() => Array.from({ length: 1024 }, (_, i) => i / 1024)) } });

before(async () => {
  tmp = tempDir();
  embedder = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      embedHits.push(body);
      const answer = embedReply(body);
      setTimeout(() => {
        res.writeHead(req.url === "/api/embed" ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer.body));
      }, answer.delay ?? 0);
    });
  });
  await new Promise<void>((ok) => embedder.listen(0, "127.0.0.1", ok));
  embedUrl = `http://127.0.0.1:${(embedder.address() as AddressInfo).port}`;
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  fake = await new FakeModel([], join(tmp, "fake.jsonl")).start();
  osTmp = join(tmp, "os");
  mkdirSync(osTmp);
  process.env.PI_CODING_AGENT_DIR = writeAgentDir(join(tmp, "pi-agent"), fake.baseUrl);
  process.env.TASKWRIGHT_SETTINGS_FILE = join(tmp, "settings", "settings.json");
  process.env.PI_OFFLINE = "1";
  service = new Service(join(tmp, "tasks"), join(tmp, "runs"), loadProfile("fake"));
});
beforeEach(() => {
  process.env.TMPDIR = osTmp;
  transports.length = 0;
  embedHits.length = 0;
  embedReply = embedded;
});
afterEach(() => {
  process.env.TMPDIR = saved.TMPDIR ?? "";
  if (saved.TMPDIR === undefined) delete process.env.TMPDIR;
});
after(async () => {
  await service.close();
  await fake.stop();
  embedder.closeAllConnections();
  await new Promise<void>((ok) => embedder.close(() => ok()));
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const text = (content: unknown): string => (typeof content === "string" ? content : ((content as Dict[]) || []).map((p) => p.text ?? "").join(""));
const QUESTION = "请读当前目录下的文件 inventory.txt，然后用一句话回答：这批货一共有多少箱？";
/** 工具结果回到模型时，最后一条消息里就是文件的内容；从里面取出箱数。 */
const countIn = (body: Dict): string => /这批货一共有 ([0-9]+) 箱。/.exec(text(body.messages.at(-1).content))?.[1] ?? "";
const READ = { tool_calls: [{ name: "read", arguments: { path: "inventory.txt" } }] };
const answer = (body: Dict) => ({ text: `这批货一共有 ${countIn(body)} 箱。` });
const ANSWERED = /^这批货一共有 [1-9][0-9] 箱。$/;
/** 照要求做的模型：先读文件，拿到工具结果后用一句话答出箱数。 */
const obedient = (first: Dict = READ) => ({ rules: [{ when: { last_role: "tool" }, reply_from: answer }], default: first });

async function go(body: unknown, target: Service = service) {
  const reply = (await dispatch(target, {
    method: "POST", path: "/api/v1/model-config/test", query: {}, headers: {}, body: Buffer.from(JSON.stringify(body)), remote: "127.0.0.1",
  })) as { status: number; body: Buffer };
  return { status: reply.status, body: JSON.parse(reply.body.toString("utf-8")) };
}

/** 助手已经停了、临时目录已经删了。started 是这一例里应当起过几次助手。 */
function assertCleanedUp(started: number): void {
  assert.equal(transports.length, started, "起助手的次数");
  assert.deepEqual(transports.map((t) => t.running()), transports.map(() => false), "助手的程序不应当还在跑");
  assert.deepEqual(leftInOsTmp(), [], "接口建的临时目录应当已经删掉，系统临时目录下除 pi 的编译缓存目录以外不应当有别的东西");
}

test("通过：模型读了文件并答出了箱数；结果带模型名、用时、工具调用次数、问模型的话与回答；测试当中助手在跑、临时目录在，结束后都没有了", CASE, async () => {
  let duringTest: { running: boolean[]; dirs: string[] } | null = null;
  fake.setScript({
    rules: [{ when: { last_role: "tool" }, reply_from: (body: Dict) => {
      duringTest = { running: transports.map((t) => t.running()), dirs: leftInOsTmp() };
      return answer(body);
    } }],
    default: READ,
  });
  const before = fake.requestCount;
  const r = await run();
  assert.deepEqual(Object.keys(r), ["ok", "result", "model", "seconds", "tool_calls", "question", "reply", "reason"]);
  assert.deepEqual({ ...r, seconds: typeof r.seconds, reply: ANSWERED.test(r.reply) },
    { ok: true, result: "passed", model: "fake/fake-model", seconds: "number", tool_calls: 1, question: QUESTION, reply: true, reason: null });
  assert.ok(r.seconds > 0);
  assert.deepEqual([duringTest!.running, duringTest!.dirs.length, duringTest!.dirs[0].startsWith("taskwright-model-test-")], [[true], 1, true]);
  assertCleanedUp(1);
  // 走的是任务用的那份启动配置里的模型；给模型的工具只有读文件的那一个，没有产品自己的工具；系统提示不是任务的那一份。
  const first = fake.requests()[before]["请求体"];
  assert.equal(first.model, "fake-model");
  assert.deepEqual(first.tools.map((t: Dict) => t.function.name), ["read"]);
  assert.equal(first.messages.some((m: Dict) => text(m.content).includes("save_revision")), false);
  assert.equal(text(first.messages.at(-1).content), QUESTION);
});

test("工具调用了两次不算没有通过，次数记在结果里", CASE, async () => {
  let reads = 0;
  fake.setScript({ rules: [{ when: { last_role: "tool" }, reply_from: (body: Dict) => (++reads < 2 ? READ : answer(body)) }], default: READ });
  const r = await run();
  assert.deepEqual([r.result, r.tool_calls, r.reason], ["passed", 2, null]);
  assertCleanedUp(1);
});

test("没有通过：模型没有调用工具", CASE, async () => {
  fake.setScript({ default: { text: "这批货一共有 50 箱。" } });
  const r = await run();
  assert.deepEqual([r.result, r.tool_calls, r.reply, r.reason], ["failed", 0, "这批货一共有 50 箱。", "模型没有调用读文件的工具。"]);
  assertCleanedUp(1);
});

test("没有通过：模型读了文件，回答里却没有文件里写的箱数；只认阿拉伯数字，箱数前后紧挨着别的数字不算；回复超过 200 个字时截短", CASE, async () => {
  fake.setScript({ rules: [{ when: { last_role: "tool" }, reply: { text: "读".repeat(300) } }], default: READ });
  const r = await run();
  assert.deepEqual([r.result, r.tool_calls, r.reason], ["failed", 1, "模型的回答里没有文件里写的箱数。"]);
  assert.equal(r.reply, "读".repeat(200) + "…");
  assertCleanedUp(1);
  // 文件里写 42 时，「420 箱」「142 箱」与「四十二箱」都不算答对。
  for (const wrong of [(n: string) => `一共有 ${n}0 箱。`, (n: string) => `一共有 1${n} 箱。`, () => "一共有四十二箱。"]) {
    fake.setScript({ rules: [{ when: { last_role: "tool" }, reply_from: (body: Dict) => ({ text: wrong(countIn(body)) }) }], default: READ });
    assert.equal((await run()).reason, "模型的回答里没有文件里写的箱数。");
  }
  // 箱数夹在别的字中间、后面跟着标点，都算答对。
  fake.setScript({ rules: [{ when: { last_role: "tool" }, reply_from: (body: Dict) => ({ text: `我读了文件，答案是${countIn(body)}，没有别的了。` }) }], default: READ });
  assert.equal((await run()).result, "passed");
  assertCleanedUp(5);
});

test("没有通过：模型服务报错，原因里带上它给的原文", CASE, async () => {
  fake.setScript({ default: { status: 400, error_body: "这个型号不存在" } });
  const r = await run();
  assert.equal(r.result, "failed");
  assert.match(r.reason ?? "", /^模型服务报错：.*这个型号不存在/);
  assertCleanedUp(1);
});

test("没有通过：到时间还没有做完；助手照样停掉、临时目录照样删掉", CASE, async () => {
  // 假端点等 6 秒才回第二句（这个等待在例后还会让本文件的进程多留几秒），接口只等 2 秒。
  fake.setScript({ rules: [{ when: { last_role: "tool" }, reply: { text: "来不及了", delay: 6 } }], default: READ });
  const r = await run(service.profile, 2000);
  assert.deepEqual([r.result, r.tool_calls, r.reason], ["failed", 1, "2 秒内没有做完。"]);
  assert.ok(r.seconds >= 2 && r.seconds < 6, `用时 ${r.seconds} 秒`);
  assertCleanedUp(1);
});

test("经接口测试：结果的形状；同一时间只跑一个测试，第二个请求报 busy，第一个不受影响，做完之后可以再测", CASE, async () => {
  fake.setScript(obedient({ ...READ, delay: 1.5 }));
  const first = go({ type: "language" });
  const second = await go({ type: "language" });
  assert.deepEqual([second.status, second.body.error], [409, { code: "busy", message: "正在测试，请等它结束。", data: {} }]);
  const done = await first;
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual({ ...done.body, seconds: typeof done.body.seconds, reply: ANSWERED.test(done.body.reply) },
    { ok: true, result: "passed", model: "fake/fake-model", seconds: "number", tool_calls: 1, question: QUESTION, reply: true, reason: null });
  fake.setScript(obedient());
  assert.equal((await go({ type: "language" })).body.result, "passed");
  assert.deepEqual(leftInOsTmp(), []);
});

test("没有通过：助手起不来，原因是任务里助手起不来时的那一句；起不来之后还能再测", CASE, async () => {
  const r = await run({ ...loadProfile("fake"), executable: "taskwright-no-such-program" });
  assert.deepEqual([r.result, r.tool_calls, r.reply, r.reason], ["failed", 0, "", "助手没有启动起来，找不到助手的程序（pi），请检查安装。"]);
  assertCleanedUp(0);
  fake.setScript(obedient());
  assert.equal((await run()).result, "passed");
  assertCleanedUp(1);
});

test("没有通过：模型登记里找不到要测的模型；它的模型服务没有密钥。两种都写成给人看的一句，不带助手程序的英文原话", CASE, async () => {
  fake.setScript(obedient());
  const missing = await run({ ...loadProfile("fake"), model: "no-such-service/some-model" });
  assert.deepEqual([missing.result, missing.model, missing.reason], ["failed", "no-such-service/some-model", "模型登记里找不到「no-such-service/some-model」。请检查它的模型服务还在不在。"]);
  assertCleanedUp(1);
  // 另一个配置目录：登记了假端点，却没有给它密钥。
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  const noKey = join(tmp, "pi-agent-no-key");
  mkdirSync(noKey);
  writeFileSync(join(noKey, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: fake.baseUrl, api: "openai-completions", models: [{ id: "fake-model", contextWindow: 32768, maxTokens: 8192 }] } } }));
  process.env.PI_CODING_AGENT_DIR = noKey;
  try {
    const before = fake.requestCount;
    const r = await run();
    assert.deepEqual([r.result, r.tool_calls, r.reason], ["failed", 0, "「fake/fake-model」的模型服务还没有设置密钥，或者还没有登录。"]);
    assert.equal(fake.requestCount, before, "没有密钥时不应当发出模型请求");
  } finally {
    process.env.PI_CODING_AGENT_DIR = agentDir;
  }
  assertCleanedUp(2);
});

test("没有模型可测时不起助手，直接说明；type 不是 language 也不是 embedding 时拒绝", async () => {
  const empty = new Service(join(tmp, "tasks-3"), join(tmp, "runs-3"), {});
  try {
    const before = fake.requestCount;
    const r = await go({ type: "language" }, empty);
    assert.deepEqual(r.body, { ok: true, result: "failed", model: "", seconds: 0, tool_calls: 0, question: QUESTION, reply: "", reason: "还没有选定语言模型，启动配置里也没有写模型。" });
    assert.equal(fake.requestCount, before);
  } finally {
    await empty.close();
  }
  for (const body of [{ type: "image" }, {}]) {
    const bad = await go(body);
    const message = "type 应当是 language 或 embedding。";
    assert.deepEqual([bad.status, bad.body.error], [422, { code: "rejected", message, data: { field: "type", reasons: [message] } }]);
  }
  assert.deepEqual(leftInOsTmp(), []);
});

// ───────────── 测试嵌入模型 ─────────────

const SENTENCE = /^这批货一共有 [1-9][0-9] 箱。$/;
const EMBEDDING_KEYS = ["ok", "result", "model", "seconds", "question", "dimensions", "reason"];

/** 产品设置里登记假的嵌入服务并选定它的嵌入模型；chosen 为假时只登记不选。 */
async function chooseEmbedding(prefix = "", chosen = true): Promise<void> {
  await updatePiDirSettings(process.env.PI_CODING_AGENT_DIR!, (dir) => {
    dir.providers["taskwright-ollama"] = {
      kind: "ollama", purpose: "embedding", name: "本机的 ollama", base_url: embedUrl, models_fetched_at: null, status: null,
      models: [{ id: "bge-m3", enabled: true, context_window: null, context_source: null }],
    };
    dir.selection.embedding = chosen ? { provider: "taskwright-ollama", model: "bge-m3", query_prefix: prefix } : null;
  });
}

test("嵌入模型通过：把一句话按查询的用途送去换算，拿回一条数字串；结果带模型名、用时、送去的那句话（含查询前缀）与数字串的长度，不带工具调用次数与回答", async () => {
  await chooseEmbedding("Instruct: 找相关段落\nQuery:");
  const r = await go({ type: "embedding" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body), EMBEDDING_KEYS);
  const sentence = r.body.question.slice("Instruct: 找相关段落\nQuery:".length);
  assert.match(sentence, SENTENCE);
  assert.deepEqual({ ...r.body, seconds: typeof r.body.seconds },
    { ok: true, result: "passed", model: "taskwright-ollama/bge-m3", seconds: "number", question: `Instruct: 找相关段落\nQuery:${sentence}`, dimensions: 1024, reason: null });
  // 只发了一次请求，送去的正是结果里写的那句话。
  assert.deepEqual(embedHits, [{ model: "bge-m3", input: [r.body.question], truncate: false }]);
  // 没有查询前缀时送去的就是那句话本身。
  await chooseEmbedding();
  const plain = await go({ type: "embedding" });
  assert.match(plain.body.question, SENTENCE);
  assert.deepEqual(embedHits[1].input, [plain.body.question]);
  assert.deepEqual(leftInOsTmp(), []);
});

test("嵌入模型没有通过：模型服务没有给数字串、到时间没有回答、没有选嵌入模型，都照样回答 200，原因写在 reason 里，数字串的长度是 null", async () => {
  await chooseEmbedding();
  embedReply = (body) => ({ body: { model: body.model, embeddings: [] } });
  const empty = await go({ type: "embedding" });
  assert.equal(empty.status, 200);
  assert.deepEqual(Object.keys(empty.body), EMBEDDING_KEYS);
  assert.match(empty.body.question, SENTENCE);
  assert.deepEqual({ ...empty.body, seconds: typeof empty.body.seconds, question: "" },
    { ok: true, result: "failed", model: "taskwright-ollama/bge-m3", seconds: "number", question: "", dimensions: null, reason: "送去 1 段文字，拿回 0 条数字串。" });
  embedReply = (body) => ({ ...embedded(body), delay: 2_000 });
  const late = await testEmbeddingModel({ env: process.env, profile: service.profile }, { timeoutMs: 1_000 });
  assert.deepEqual([late.result, late.dimensions, late.reason], ["failed", null, "1 秒内没有算完。"]);
  await chooseEmbedding("", false);
  const before = embedHits.length;
  const none = await go({ type: "embedding" });
  assert.equal(none.status, 200);
  assert.match(none.body.question, SENTENCE);
  assert.deepEqual([none.body.result, none.body.model, none.body.dimensions, none.body.reason], ["failed", "", null, "还没有选嵌入模型。"]);
  assert.equal(embedHits.length, before, "没有选嵌入模型时不应当发请求");
  // 没有通过之后还能再测。
  await chooseEmbedding();
  embedReply = embedded;
  assert.equal((await go({ type: "embedding" })).body.result, "passed");
});

test("嵌入模型的测试在跑时，再来的测试请求（哪一种都一样）报 busy；它做完之后可以再测", async () => {
  await chooseEmbedding();
  embedReply = (body) => ({ ...embedded(body), delay: 800 });
  const first = go({ type: "embedding" });
  for (const type of ["embedding", "language"]) {
    const second = await go({ type });
    assert.deepEqual([second.status, second.body.error], [409, { code: "busy", message: "正在测试，请等它结束。", data: {} }], type);
  }
  assert.equal((await first).body.result, "passed");
  assert.equal(embedHits.length, 1);
  embedReply = embedded;
  assert.equal((await go({ type: "embedding" })).body.result, "passed");
  assertCleanedUp(0);
});

test("语言模型的测试在跑时，嵌入模型的测试请求报 busy，不发换算的请求；语言模型的测试不受影响", CASE, async () => {
  await chooseEmbedding();
  fake.setScript(obedient({ ...READ, delay: 1.5 }));
  const first = go({ type: "language" });
  const second = await go({ type: "embedding" });
  assert.deepEqual([second.status, second.body.error], [409, { code: "busy", message: "正在测试，请等它结束。", data: {} }]);
  assert.equal(embedHits.length, 0);
  assert.equal((await first).body.result, "passed");
  assert.equal((await go({ type: "embedding" })).body.result, "passed");
  assert.deepEqual(leftInOsTmp(), []);
});
