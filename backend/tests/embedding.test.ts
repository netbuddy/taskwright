/**
 * 调嵌入模型的模块（src/embedding.ts）。模型服务是本文件里起的一个假服务，应答 ollama 自己的接口（/api/embed）与兼容 OpenAI 接口的
 * 那一个（/v1/embeddings）；每一例自己定它怎样回答。pi 的配置目录与产品设置文件都在临时目录里，不连任何真的模型服务。
 * 两种接口各通过一例；查询前缀只加在查询上；没有选模型、模型服务不在了、Codex 订阅、段数超过上限、连不上、超时、密钥被拒绝、
 * 找不到模型、模型服务报错、回答里数字串的个数或内容不对各一例。
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { BATCH_LIMIT, EmbeddingError, embed } from "../src/embedding.ts";
import type { Context } from "../src/model_config.ts";
import { type Kind, type StoredProvider, updatePiDirSettings } from "../src/product_settings.ts";
import { captureConsole, tempDir } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
/** 一个请求怎样回答：状态码与回答的内容；delay 是先等多少毫秒再回答。 */
type Reply = { status?: number; body: unknown; delay?: number };

/** 假的嵌入服务：记下收到的每个请求（路径、Authorization 头、请求体），回答由各例设置。 */
class FakeEmbedder {
  reply: (path: string, body: Dict) => Reply = () => ({ status: 404, body: { error: "not found" } });
  hits: { path: string; auth: string | null; body: Dict }[] = [];
  server!: Server;
  port = 0;
  async start(): Promise<this> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const path = (req.url ?? "/").split("?")[0];
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        this.hits.push({ path, auth: (req.headers.authorization as string) ?? null, body });
        const answer = this.reply(path, body);
        setTimeout(() => {
          res.writeHead(answer.status ?? 200, { "Content-Type": "application/json" });
          res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
        }, answer.delay ?? 0);
      });
    });
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((ok) => this.server.close(() => ok()));
  }
}

let tmp: string;
let agent: string;
let fake: FakeEmbedder;
/** 一个已经关掉的端口：连上去会被拒绝。 */
let closedPort: number;
const saved: Dict = {};
const ENV_NAMES = ["PI_CODING_AGENT_DIR", "TASKWRIGHT_SETTINGS_FILE"];
const ctx = (): Context => ({ env: process.env, profile: {} });

before(async () => {
  tmp = tempDir();
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  agent = join(tmp, "pi-agent");
  mkdirSync(agent);
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.TASKWRIGHT_SETTINGS_FILE = join(tmp, "settings", "settings.json");
  fake = await new FakeEmbedder().start();
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((ok) => probe.close(() => ok()));
});
beforeEach(() => {
  fake.hits.length = 0;
  writeFileSync(join(agent, "auth.json"), "{}");
});
after(async () => {
  await fake.stop();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const provider = (kind: Kind, base: string | null): StoredProvider => ({
  kind, name: `测试用的 ${kind}`, base_url: base, models_fetched_at: null, status: null,
  models: [{ id: "bge-m3", type: "embedding", enabled: true, context_window: null, context_source: null }],
});

/** 产品设置里登记一个这种模型服务并选定它的嵌入模型；key 写进凭据文件。 */
async function choose(kind: Kind, options: { base?: string | null; prefix?: string; key?: string } = {}): Promise<string> {
  const id = `taskwright-${kind}`;
  const base = options.base === undefined ? fake.url : options.base;
  await updatePiDirSettings(agent, (dir) => {
    dir.providers = { [id]: provider(kind, base) };
    dir.selection.embedding = { provider: id, model: "bge-m3", query_prefix: options.prefix ?? "" };
  });
  if (options.key) writeFileSync(join(agent, "auth.json"), JSON.stringify({ [id]: { type: "api_key", key: options.key } }));
  return id;
}

/** 每段文字回一条三个数的数字串：第一个数是这段文字的字数，看得出哪一条对着哪一段。 */
const vectorOf = (text: string) => [Array.from(text).length, 0.5, -0.25];
const ollamaReply = (_: string, body: Dict): Reply => ({ body: { model: body.model, embeddings: body.input.map(vectorOf), total_duration: 1 } });
const openaiReply = (_: string, body: Dict): Reply => ({
  body: { object: "list", model: body.model, data: body.input.map((t: string, index: number) => ({ object: "embedding", index, embedding: vectorOf(t) })) },
});

/** 换算应当没有做成：返回抛出来的那个错误的种类与那句话。 */
async function failure(texts: string[] = ["一句话"], timeoutMs?: number): Promise<[string, string]> {
  try {
    await embed(ctx(), texts, "query", { timeoutMs });
  } catch (error) {
    assert.ok(error instanceof EmbeddingError, `应当抛 EmbeddingError，实际是 ${String(error)}`);
    return [error.kind, error.message];
  }
  assert.fail("应当没有做成");
}

test("ollama：请求发到根地址下的 /api/embed，请求体是模型名与各段文字；每段拿回一条数字串，结果带模型名、送去的文字与数字串的长度", async () => {
  fake.reply = ollamaReply;
  // 用户填的地址末尾带了 /v1 也照根地址算。
  const id = await choose("ollama", { base: `${fake.url}/v1` });
  const r = await embed(ctx(), ["第一段", "第二段长一些"], "document");
  assert.deepEqual(fake.hits, [{ path: "/api/embed", auth: null, body: { model: "bge-m3", input: ["第一段", "第二段长一些"] } }]);
  assert.deepEqual(r, { model: `${id}/bge-m3`, inputs: ["第一段", "第二段长一些"], vectors: [[3, 0.5, -0.25], [6, 0.5, -0.25]], dimensions: 3 });
});

test("兼容 OpenAI 接口的几种：本地的两种在根地址后面补 /v1，别的照用户填的地址，都发到 …/embeddings；有密钥时带上；回答按 index 对上各段", async () => {
  // 回答故意倒着排：靠 index 对回原来的顺序。
  fake.reply = (path, body) => ({ body: { data: (openaiReply(path, body).body as Dict).data.reverse() } });
  for (const kind of ["llamacpp", "vllm"] as const) {
    fake.hits.length = 0;
    await choose(kind);
    const r = await embed(ctx(), ["甲", "乙乙"], "document");
    assert.deepEqual(fake.hits.map((h) => [h.path, h.auth]), [["/v1/embeddings", null]], kind);
    assert.deepEqual(r.vectors, [[1, 0.5, -0.25], [2, 0.5, -0.25]], kind);
  }
  for (const kind of ["deepseek", "aliyun", "openai_compatible"] as const) {
    fake.hits.length = 0;
    await choose(kind, { base: `${fake.url}/compatible/v1`, key: "sk-test-1234" });
    const r = await embed(ctx(), ["甲", "乙乙"], "document");
    assert.deepEqual(fake.hits, [{ path: "/compatible/v1/embeddings", auth: "Bearer sk-test-1234", body: { model: "bge-m3", input: ["甲", "乙乙"] } }], kind);
    assert.deepEqual([r.vectors, r.dimensions], [[[1, 0.5, -0.25], [2, 0.5, -0.25]], 3], kind);
  }
});

test("查询前缀只加在查询上：查询用途时前缀直接接上原文，中间不添任何字符；文档用途时原样送去", async () => {
  fake.reply = ollamaReply;
  await choose("ollama", { prefix: "Instruct: 找相关段落\nQuery:" });
  const query = await embed(ctx(), ["退款要几天", "运费谁出"], "query");
  assert.deepEqual(query.inputs, ["Instruct: 找相关段落\nQuery:退款要几天", "Instruct: 找相关段落\nQuery:运费谁出"]);
  assert.deepEqual(fake.hits[0].body.input, query.inputs);
  const document = await embed(ctx(), ["退款要几天"], "document");
  assert.deepEqual([document.inputs, fake.hits[1].body.input], [["退款要几天"], ["退款要几天"]]);
});

test("没有选嵌入模型、选定的模型所在的模型服务不在了、Codex 订阅：都不发请求，各说明一句", async () => {
  await updatePiDirSettings(agent, (dir) => {
    dir.providers = {};
    dir.selection.embedding = null;
  });
  assert.deepEqual(await failure(), ["not_selected", "还没有选嵌入模型。"]);
  await updatePiDirSettings(agent, (dir) => {
    dir.selection.embedding = { provider: "taskwright-ollama", model: "bge-m3", query_prefix: "" };
  });
  assert.deepEqual(await failure(), ["provider_gone", "选定的嵌入模型「bge-m3」所在的模型服务不在了，请重新选择嵌入模型。"]);
  await choose("codex", { base: null });
  assert.deepEqual(await failure(), ["not_offered", "这个模型服务没有嵌入模型。"]);
  assert.deepEqual(fake.hits, []);
});

test("段数超过这一种模型服务一次能收的上限时不发请求：阿里云百炼是 10 段，别的种类是 32 段；正好到上限可以", async () => {
  fake.reply = openaiReply;
  assert.deepEqual(BATCH_LIMIT, { ollama: 32, llamacpp: 32, vllm: 32, deepseek: 32, aliyun: 10, openai_compatible: 32 });
  const texts = (n: number) => Array.from({ length: n }, (_, i) => `第 ${i} 段`);
  await choose("aliyun", { base: `${fake.url}/v1` });
  assert.deepEqual(await failure(texts(11)), ["too_many", "一次最多换算 10 段文字，这一次送来了 11 段。"]);
  assert.deepEqual(fake.hits, []);
  assert.equal((await embed(ctx(), texts(10), "document")).vectors.length, 10);
  await choose("vllm");
  assert.deepEqual(await failure(texts(33)), ["too_many", "一次最多换算 32 段文字，这一次送来了 33 段。"]);
  assert.equal((await embed(ctx(), texts(32), "document")).vectors.length, 32);
  await assert.rejects(embed(ctx(), [], "document"), TypeError);
});

test("连不上模型服务；到时间没有回答", async () => {
  await choose("ollama", { base: `http://127.0.0.1:${closedPort}` });
  assert.deepEqual(await failure(), ["unreachable", "连不上这个模型服务。请确认它已经启动，地址与端口没有写错。"]);
  fake.reply = (path, body) => ({ ...ollamaReply(path, body), delay: 3_000 });
  await choose("ollama");
  const started = Date.now();
  assert.deepEqual(await failure(["一句话"], 1_000), ["timeout", "1 秒内没有算完。"]);
  assert.ok(Date.now() - started < 2_500, "到时间就应当放弃，不等模型服务回答");
});

test("模型服务拒绝密钥（401、403）；找不到模型或者没有嵌入模型的接口（404）；别的错误带上模型服务给的原文，最多 200 个字", async () => {
  await choose("openai_compatible", { base: `${fake.url}/v1`, key: "sk-wrong" });
  for (const status of [401, 403]) {
    fake.reply = () => ({ status, body: { error: { message: "Incorrect API key provided" } } });
    assert.deepEqual(await failure(), ["key_rejected", "模型服务拒绝了这个密钥。"]);
  }
  fake.reply = () => ({ status: 404, body: { error: { message: "Not Found" } } });
  assert.deepEqual(await failure(), ["service_error", "模型服务里找不到模型「bge-m3」，或者这个模型服务没有嵌入模型的接口。"]);
  fake.reply = () => ({ status: 501, body: { error: { code: 501, message: "This server does not support embeddings." } } });
  assert.deepEqual(await failure(), ["service_error", "模型服务回答了错误（HTTP 501）：This server does not support embeddings."]);
  // ollama 的 error 是一句话，不是对象。
  await choose("ollama");
  fake.reply = () => ({ status: 400, body: { error: "this model does not support embeddings" } });
  assert.deepEqual(await failure(), ["service_error", "模型服务回答了错误（HTTP 400）：this model does not support embeddings"]);
  fake.reply = () => ({ status: 500, body: "x".repeat(300) });
  assert.deepEqual(await failure(), ["service_error", `模型服务回答了错误（HTTP 500）：${"x".repeat(200)}…`]);
  fake.reply = () => ({ status: 503, body: "" });
  assert.deepEqual(await failure(), ["service_error", "模型服务回答了错误（HTTP 503）。"]);
});

test("回答里的数字串不对：没有、个数与送去的段数不符、是空的、有不是数的项、长短不一", async () => {
  await choose("ollama");
  const answers: [unknown, string][] = [
    [{ model: "bge-m3" }, "模型服务的回答里没有数字串。"],
    ["这不是 JSON", "模型服务的回答里没有数字串。"],
    [{ embeddings: [] }, "送去 2 段文字，拿回 0 条数字串。"],
    [{ embeddings: [[1, 2], [3, 4], [5, 6]] }, "送去 2 段文字，拿回 3 条数字串。"],
    [{ embeddings: [[1, 2], []] }, "模型服务回答的数字串不对：是空的，或者里面有不是数的项。"],
    [{ embeddings: [[1, 2], [3, null]] }, "模型服务回答的数字串不对：是空的，或者里面有不是数的项。"],
    [{ embeddings: [[1, 2], [3, "4"]] }, "模型服务回答的数字串不对：是空的，或者里面有不是数的项。"],
    [{ embeddings: [[1, 2], [3, 4, 5]] }, "模型服务回答的各条数字串长短不一。"],
  ];
  for (const [body, message] of answers) {
    fake.reply = () => ({ body });
    assert.deepEqual(await failure(["甲", "乙"]), ["bad_answer", message], JSON.stringify(body));
  }
  await choose("openai_compatible", { base: `${fake.url}/v1` });
  fake.reply = () => ({ body: { object: "list", data: [{ index: 0, embedding: [1, 2] }] } });
  assert.deepEqual(await failure(["甲", "乙"]), ["bad_answer", "送去 2 段文字，拿回 1 条数字串。"]);
  fake.reply = () => ({ body: { object: "list" } });
  assert.deepEqual(await failure(["甲", "乙"]), ["bad_answer", "模型服务的回答里没有数字串。"]);
});
