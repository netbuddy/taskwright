/**
 * 在界面上配置模型服务（docs/api.md §10）：各接口、写共用配置文件的三条规矩（别的内容原样保留、写前备份、照 pi 的办法加锁）、
 * 带注释的文件拒绝改写、只许本机修改、密钥不返回、用户自己登记的服务只读、选定的模型成为起助手用的模型。
 * 模型服务是本文件里起的一个假服务（只应答列模型、查模型详情、载入模型几个接口）；pi 的配置目录与产品设置文件都在临时目录里。
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { BACKUP_KEEP, LOCK_WAIT_MS, lockPath, updateJsonFile } from "../src/config_files.ts";
import { dispatch, isLocalRequest, serviceInfo } from "../src/http.ts";
import { resolveModel } from "../src/launch.ts";
import { Service } from "../src/service.ts";
import { captureConsole, tempDir } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
type Route = (body: Dict | null) => [number, unknown];

/** 假的模型服务：路由表由各例设置，记下收到的每个请求（方法、路径、Authorization 头）。 */
class FakeService {
  routes: Record<string, Route> = {};
  hits: { method: string; path: string; auth: string | null }[] = [];
  server!: Server;
  port = 0;
  async start(): Promise<this> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const path = (req.url ?? "/").split("?")[0];
        this.hits.push({ method: req.method ?? "GET", path, auth: (req.headers.authorization as string) ?? null });
        const route = this.routes[`${req.method} ${path}`];
        let body: Dict | null = null;
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : null;
        } catch {
          body = null;
        }
        const [status, answer] = route ? route(body) : [404, { error: "not found" }];
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer));
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
    return new Promise((ok) => this.server.close(() => ok()));
  }
}

let tmp: string;
let agent: string;
let settings: string;
let service: Service;
let fake: FakeService;
/** 一个已经关掉的端口：连上去会被拒绝。 */
let closedPort: number;
const saved: Dict = {};

before(async () => {
  tmp = tempDir();
  for (const name of ["PI_CODING_AGENT_DIR", "TASKWRIGHT_SETTINGS_FILE"]) saved[name] = process.env[name];
  service = new Service(join(tmp, "tasks"), join(tmp, "runs"), { model: "fake/fake-model" });
  fake = await new FakeService().start();
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((ok) => probe.close(() => ok()));
});
after(async () => {
  await service.close();
  await fake.stop();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

let round = 0;
beforeEach(() => {
  round += 1;
  agent = join(tmp, `agent-${round}`);
  settings = join(tmp, `settings-${round}`, "settings.json");
  mkdirSync(agent, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.TASKWRIGHT_SETTINGS_FILE = settings;
  fake.routes = {};
  fake.hits = [];
});
afterEach(() => {
  fake.routes = {};
});

const LOCAL = "127.0.0.1";
async function go(method: string, path: string, body?: unknown, options: { remote?: string; headers?: Dict } = {}) {
  const reply = (await dispatch(service, {
    method, path, query: {}, headers: options.headers ?? {}, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)), remote: options.remote ?? LOCAL,
  })) as { status: number; body: Buffer };
  return { status: reply.status, body: JSON.parse(reply.body.toString("utf-8")) };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8"));
const modelsJson = () => join(agent, "models.json");
const authJson = () => join(agent, "auth.json");
const backups = (file: string) => readdirSync(agent).filter((n) => n.startsWith(`${file}.taskwright-backup-`)).sort();

/** 假服务按 ollama 的样子应答：两个语言模型、一个嵌入模型；载入之后 /api/ps 报 8192。 */
function ollamaRoutes(): void {
  fake.routes["GET /api/tags"] = () => [200, { models: [{ name: "qwen3:8b" }, { name: "qwen3:32b" }, { name: "qwen3-embedding:8b" }] }];
  fake.routes["POST /api/show"] = (b) => [200, { capabilities: b?.model === "qwen3-embedding:8b" ? ["embedding"] : ["completion", "tools"], model_info: { "qwen3.context_length": 40960 } }];
  fake.routes["POST /api/generate"] = (b) => [200, { model: b?.model, done: true }];
  fake.routes["GET /api/ps"] = () => [200, { models: [{ name: "qwen3:8b", context_length: 8192 }] }];
}

/** 假服务按兼容 OpenAI 接口的样子应答模型清单；key 给了就要求带这个密钥。 */
function openaiRoutes(key: string | null = null, entries: Dict[] = [{ id: "m-a", max_model_len: 32768 }, { id: "m-b" }]): void {
  fake.routes["GET /v1/models"] = () => {
    const auth = fake.hits[fake.hits.length - 1].auth;
    if (key !== null && auth !== `Bearer ${key}`) return [401, { error: "bad key" }];
    return [200, { object: "list", data: entries }];
  };
}

async function addOllama(): Promise<string> {
  ollamaRoutes();
  const r = await go("POST", "/api/v1/model-config/providers", { kind: "ollama", name: "本机 ollama", base_url: fake.url });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.provider.id;
}

// ───────────── 只许本机 ─────────────

test("只许本机：套接字来源、转发头与 Origin 三条都满足才算本机", () => {
  assert.equal(isLocalRequest("127.0.0.1", {}), true);
  assert.equal(isLocalRequest("::1", {}), true);
  assert.equal(isLocalRequest("::ffff:127.0.0.1", {}), true);
  assert.equal(isLocalRequest("198.51.100.20", {}), false);
  assert.equal(isLocalRequest(null, {}), false);
  assert.equal(isLocalRequest("127.0.0.1", { "x-forwarded-for": "198.51.100.20" }), false);
  assert.equal(isLocalRequest("127.0.0.1", { "x-forwarded-for": "127.0.0.1, ::1" }), true);
  assert.equal(isLocalRequest("127.0.0.1", { "x-real-ip": "203.0.113.3" }), false);
  assert.equal(isLocalRequest("127.0.0.1", { forwarded: 'for="[2001:db8::1]:4711";proto=http' }), false);
  assert.equal(isLocalRequest("127.0.0.1", { forwarded: "for=127.0.0.1;proto=http" }), true);
  assert.equal(isLocalRequest("127.0.0.1", { origin: "http://198.51.100.20:5680" }), false);
  assert.equal(isLocalRequest("127.0.0.1", { origin: "https://evil.example" }), false);
  assert.equal(isLocalRequest("127.0.0.1", { origin: "null" }), false);
  assert.equal(isLocalRequest("127.0.0.1", { origin: "http://localhost:5680" }), true);
  assert.equal(isLocalRequest("127.0.0.1", { origin: "http://[::1]:8940" }), true);
});

test("从别的电脑来的修改一律 403，读照常但不给可改、不给密钥末四位", async () => {
  const id = await addOllama();
  fake.routes["GET /v1/models"] = () => [200, { data: [] }];
  const other = [{ remote: "198.51.100.20" }, { headers: { origin: "http://198.51.100.20:5680" } }, { headers: { "x-forwarded-for": "198.51.100.20" } }];
  for (const from of other) {
    for (const [path, body] of [
      ["/api/v1/model-config/providers", { kind: "ollama", base_url: fake.url }],
      [`/api/v1/model-config/providers/${id}`, { name: "改名" }],
      [`/api/v1/model-config/providers/${id}/delete`, {}],
      [`/api/v1/model-config/providers/${id}/check`, {}],
      [`/api/v1/model-config/providers/${id}/fetch-models`, {}],
      [`/api/v1/model-config/providers/${id}/context-window`, { model_id: "qwen3:8b" }],
      ["/api/v1/model-config/selection", { language: null, embedding: null }],
    ] as const) {
      const r = await go("POST", path, body, from);
      assert.equal(r.status, 403, `${path} ${JSON.stringify(from)}`);
      assert.equal(r.body.error.code, "forbidden");
      assert.equal(r.body.error.message, "模型的配置只能在运行任务服务的这台电脑上修改。");
    }
  }
  const view = await go("GET", "/api/v1/model-config", undefined, { remote: "198.51.100.20" });
  assert.equal(view.status, 200);
  assert.equal(view.body.editable, false);
  assert.equal(view.body.notice, "模型的配置只能在运行任务服务的这台电脑上修改。");
  assert.equal(view.body.providers[0].name, "本机 ollama");
  const local = await go("GET", "/api/v1/model-config");
  assert.equal(local.body.editable, true);
  assert.equal(local.body.notice, null);
  assert.equal(serviceInfo(service, "127.0.0.1", {}).capabilities.model_config, true);
  assert.equal(serviceInfo(service, "127.0.0.1", { origin: "http://198.51.100.20:5680" }).capabilities.model_config, false);
  assert.equal(serviceInfo(service, "198.51.100.20", {}).capabilities.model_config, false);
});

// ───────────── 新增、修改、删除 ─────────────

test("新增 ollama：先检查连得上，登记进模型登记文件（根地址加 /v1、占位密钥、兼容项），名单记在产品设置里", async () => {
  const id = await addOllama();
  assert.equal(id, "taskwright-ollama");
  assert.deepEqual(fake.hits.map((h) => `${h.method} ${h.path}`), ["GET /api/tags"]);
  const entry = readJson(modelsJson()).providers[id];
  assert.equal(entry.baseUrl, `${fake.url}/v1`);
  assert.equal(entry.api, "openai-completions");
  assert.equal(entry.apiKey, "taskwright-no-key");
  assert.deepEqual(entry.compat, { supportsDeveloperRole: false, supportsReasoningEffort: false });
  assert.deepEqual(entry.models, []);
  const stored = readJson(settings).pi_dirs[agent].providers[id];
  assert.equal(stored.kind, "ollama");
  assert.equal(stored.name, "本机 ollama");
  assert.equal(stored.status.ok, true);
  assert.equal(existsSync(authJson()), false, "没有密钥时不碰凭据文件");
  // 第二个 ollama 用下一个名字
  const again = await go("POST", "/api/v1/model-config/providers", { kind: "ollama", base_url: fake.url });
  assert.equal(again.body.provider.id, "taskwright-ollama-2");
  assert.equal(again.body.provider.name, "ollama");
});

test("连不上或者密钥被拒时不保存，422 指明是地址还是密钥", async () => {
  const down = await go("POST", "/api/v1/model-config/providers", { kind: "vllm", base_url: `http://127.0.0.1:${closedPort}` });
  assert.equal(down.status, 422);
  assert.equal(down.body.error.code, "rejected");
  assert.equal(down.body.error.data.field, "base_url");
  assert.equal(down.body.error.message, "连不上这个地址。请确认模型服务已经启动，地址与端口没有写错。");
  openaiRoutes("sk-right-key-1234");
  const bad = await go("POST", "/api/v1/model-config/providers", { kind: "openai_compatible", base_url: `${fake.url}/v1`, api_key: "sk-wrong" });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.data.field, "api_key");
  assert.equal(bad.body.error.message, "模型服务拒绝了这个密钥。");
  const missing = await go("POST", "/api/v1/model-config/providers", { kind: "deepseek", base_url: `${fake.url}/v1` });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.data.field, "api_key");
  const noUrl = await go("POST", "/api/v1/model-config/providers", { kind: "openai_compatible" });
  assert.equal(noUrl.body.error.data.field, "base_url");
  assert.equal(existsSync(modelsJson()), false, "失败时模型登记文件一字不动");
  assert.equal(existsSync(settings), false, "失败时产品设置也不写");
});

test("密钥写进凭据文件（0600），接口只给「已设置」与末四位；改名、换密钥、删除", async () => {
  openaiRoutes("sk-right-key-1234");
  const r = await go("POST", "/api/v1/model-config/providers", { kind: "openai_compatible", name: "内网服务", base_url: `${fake.url}/v1/`, api_key: "sk-right-key-1234" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.provider.id;
  assert.equal(id, "taskwright-openai_compatible");
  assert.deepEqual(r.body.provider.key, { set: true, last4: "1234" });
  assert.deepEqual(readJson(authJson())[id], { type: "api_key", key: "sk-right-key-1234" });
  assert.equal(statSync(authJson()).mode & 0o777, 0o600);
  assert.equal(readJson(modelsJson()).providers[id].baseUrl, `${fake.url}/v1`, "末尾的斜杠去掉");
  assert.equal(JSON.stringify((await go("GET", "/api/v1/model-config")).body).includes("sk-right-key-1234"), false, "读配置不带密钥");
  assert.equal(JSON.stringify((await go("GET", "/api/v1/model-config", undefined, { remote: "203.0.113.9" })).body.providers[0].key), '{"set":true,"last4":null}');
  openaiRoutes("sk-new-key-9999");
  const changed = await go("POST", `/api/v1/model-config/providers/${id}`, { name: "改过名的服务", api_key: "sk-new-key-9999" });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.provider.name, "改过名的服务");
  assert.equal(changed.body.provider.key.last4, "9999");
  const refused = await go("POST", `/api/v1/model-config/providers/${id}`, { api_key: "sk-wrong" });
  assert.equal(refused.body.error.data.field, "api_key");
  assert.equal(readJson(authJson())[id].key, "sk-new-key-9999", "被拒的密钥不保存");
  const gone = await go("POST", `/api/v1/model-config/providers/${id}/delete`, {});
  assert.equal(gone.status, 200);
  assert.equal(Object.hasOwn(readJson(modelsJson()).providers, id), false);
  assert.equal(Object.hasOwn(readJson(authJson()), id), false);
  assert.equal((await go("GET", "/api/v1/model-config")).body.providers.length, 0);
  assert.equal((await go("POST", `/api/v1/model-config/providers/${id}/delete`, {})).status, 404);
});

// ───────────── 模型列表、上下文长度 ─────────────

test("ollama：获取模型列表分出嵌入模型，上下文长度不填；查上下文长度先载入再读实际值", async () => {
  const id = await addOllama();
  const r = await go("POST", `/api/v1/model-config/providers/${id}/fetch-models`, {});
  assert.equal(r.body.result, "listed");
  assert.deepEqual(r.body.provider.models, [
    { id: "qwen3:8b", type: "language", enabled: false, context_window: null, context_source: null },
    { id: "qwen3:32b", type: "language", enabled: false, context_window: null, context_source: null },
    { id: "qwen3-embedding:8b", type: "embedding", enabled: false, context_window: null, context_source: null },
  ]);
  assert.ok(r.body.provider.models_fetched_at);
  fake.hits = [];
  const cw = await go("POST", `/api/v1/model-config/providers/${id}/context-window`, { model_id: "qwen3:8b" });
  assert.deepEqual(cw.body, { ok: true, context_window: 8192, source: "service", message: "" });
  assert.deepEqual(fake.hits.map((h) => `${h.method} ${h.path}`), ["POST /api/generate", "GET /api/ps"]);
  const unknown = await go("POST", `/api/v1/model-config/providers/${id}/context-window`, { model_id: "qwen3:32b" });
  assert.equal(unknown.body.context_window, null);
  assert.match(unknown.body.message, /请手工填写/);
});

test("兼容 OpenAI 的服务：列表带上下文长度；没有列表时说不提供；出错时说没有成功；再次获取保留勾选与用户填的值", async () => {
  openaiRoutes();
  const id = (await go("POST", "/api/v1/model-config/providers", { kind: "vllm", base_url: fake.url })).body.provider.id;
  const r = await go("POST", `/api/v1/model-config/providers/${id}/fetch-models`, {});
  assert.deepEqual(r.body.provider.models, [
    { id: "m-a", type: "language", enabled: false, context_window: 32768, context_source: "service" },
    { id: "m-b", type: "language", enabled: false, context_window: null, context_source: null },
  ]);
  await go("POST", `/api/v1/model-config/providers/${id}`, { models: [
    { id: "m-a", type: "language", enabled: true, context_window: 32768, context_source: "service" },
    { id: "m-b", type: "language", enabled: true, context_window: 4096 },
  ] });
  openaiRoutes(null, [{ id: "m-a", max_model_len: 65536 }, { id: "m-b", max_model_len: 99999 }, { id: "m-c" }]);
  const again = await go("POST", `/api/v1/model-config/providers/${id}/fetch-models`, {});
  assert.deepEqual(again.body.provider.models, [
    { id: "m-a", type: "language", enabled: true, context_window: 65536, context_source: "service" },
    { id: "m-b", type: "language", enabled: true, context_window: 4096, context_source: "user" },
    { id: "m-c", type: "language", enabled: false, context_window: null, context_source: null },
  ]);
  fake.routes["GET /v1/models"] = () => [404, {}];
  const none = await go("POST", `/api/v1/model-config/providers/${id}/fetch-models`, {});
  assert.equal(none.body.result, "not_offered");
  assert.equal(none.body.message, "这个模型服务没有提供模型的清单，请手工添加。");
  fake.routes["GET /v1/models"] = () => [500, {}];
  const broken = await go("POST", `/api/v1/model-config/providers/${id}/fetch-models`, {});
  assert.equal(broken.body.result, "failed");
  assert.equal(broken.body.message, "获取模型列表没有成功：模型服务回答了错误（HTTP 500）。可以稍后再试，或者手工添加。");
  assert.equal(broken.body.provider.models.length, 3, "失败时已有的清单不变");
});

test("勾选的语言模型要有上下文长度；只有勾选的语言模型写进模型登记文件，嵌入模型不写", async () => {
  const id = await addOllama();
  await go("POST", `/api/v1/model-config/providers/${id}/fetch-models`, {});
  const missing = await go("POST", `/api/v1/model-config/providers/${id}`, { models: [{ id: "qwen3:8b", type: "language", enabled: true, context_window: null }] });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.message, "模型「qwen3:8b」还没有填上下文长度，填了才能保存。");
  const ok = await go("POST", `/api/v1/model-config/providers/${id}`, { models: [
    { id: "qwen3:8b", type: "language", enabled: true, context_window: 8192 },
    { id: "qwen3:32b", type: "language", enabled: false, context_window: null },
    { id: "qwen3-embedding:8b", type: "embedding", enabled: true, context_window: null },
    { id: "手工加的", type: "language", enabled: true, context_window: 4096 },
  ] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(readJson(modelsJson()).providers[id].models, [{ id: "qwen3:8b", contextWindow: 8192 }, { id: "手工加的", contextWindow: 4096 }]);
});

// ───────────── 选定模型 ─────────────

test("选定语言模型与嵌入模型：起助手用选定的模型；停用或删除被选中的要先换；嵌入模型可以不选", async () => {
  const id = await addOllama();
  await go("POST", `/api/v1/model-config/providers/${id}/fetch-models`, {});
  await go("POST", `/api/v1/model-config/providers/${id}`, { models: [
    { id: "qwen3:8b", type: "language", enabled: true, context_window: 8192 },
    { id: "qwen3-embedding:8b", type: "embedding", enabled: true, context_window: null },
  ] });
  assert.equal(resolveModel(service.profile).model, "fake/fake-model", "没有选过时照 0.3 的规则");
  const before = (await go("GET", "/api/v1/model-config")).body;
  assert.deepEqual(before.fallback, { model: "fake/fake-model", from: "启动配置" });
  const bad = await go("POST", "/api/v1/model-config/selection", { language: { provider_id: id, model_id: "qwen3:32b" }, embedding: null });
  assert.equal(bad.status, 422);
  const wrongType = await go("POST", "/api/v1/model-config/selection", { language: { provider_id: id, model_id: "qwen3-embedding:8b" }, embedding: null });
  assert.equal(wrongType.body.error.message, "模型「qwen3-embedding:8b」不是语言模型。");
  const r = await go("POST", "/api/v1/model-config/selection", {
    language: { provider_id: id, model_id: "qwen3:8b" }, embedding: { provider_id: id, model_id: "qwen3-embedding:8b", query_prefix: "Instruct: 找相关段落\nQuery: " },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.note, "更换之后，下一次打开或者新建会话时生效。正在进行的会话不受影响。");
  assert.deepEqual(r.body.selection, {
    language: { provider_id: id, model_id: "qwen3:8b" }, embedding: { provider_id: id, model_id: "qwen3-embedding:8b", query_prefix: "Instruct: 找相关段落\nQuery: " },
  });
  const resolved = resolveModel(service.profile);
  assert.equal(resolved.model, `${id}/qwen3:8b`);
  assert.equal(resolved.from, "产品设置");
  assert.equal((await go("GET", "/api/v1/model-config")).body.fallback, null);
  assert.deepEqual((await go("GET", "/api/v1/model-config")).body.providers[0].in_use, ["language", "embedding"]);
  const disable = await go("POST", `/api/v1/model-config/providers/${id}`, { models: [{ id: "qwen3:8b", type: "language", enabled: false, context_window: 8192 }] });
  assert.equal(disable.status, 409);
  assert.equal(disable.body.error.code, "in_use");
  const del = await go("POST", `/api/v1/model-config/providers/${id}/delete`, {});
  assert.equal(del.body.error.code, "in_use");
  const noEmbedding = await go("POST", "/api/v1/model-config/selection", { language: { provider_id: id, model_id: "qwen3:8b" }, embedding: null });
  assert.equal(noEmbedding.body.selection.embedding, null);
  await go("POST", "/api/v1/model-config/selection", { language: null, embedding: null });
  assert.equal(resolveModel(service.profile).model, "fake/fake-model", "不选之后回到 0.3 的规则");
});

test("用户自己在模型登记文件里写的服务：单列只读，语言模型可以选，改不了也删不了", async () => {
  writeFileSync(modelsJson(), JSON.stringify({ providers: { "my-llm": { baseUrl: "http://x/v1", api: "openai-completions", apiKey: "sk-user-secret", name: "我的服务", models: [{ id: "big", contextWindow: 65536 }] } } }));
  const view = (await go("GET", "/api/v1/model-config")).body;
  assert.equal(view.providers.length, 1);
  assert.deepEqual(view.providers[0], {
    id: "my-llm", managed: false, kind: null, name: "我的服务", base_url: null, key: null, status: null, models_fetched_at: null, in_use: [],
    models: [{ id: "big", type: "language", enabled: true, context_window: 65536, context_source: null }],
  });
  assert.equal(JSON.stringify(view).includes("sk-user-secret"), false);
  assert.equal((await go("POST", "/api/v1/model-config/providers/my-llm", { name: "改" })).status, 404);
  assert.equal((await go("POST", "/api/v1/model-config/providers/my-llm/delete", {})).status, 404);
  const pick = await go("POST", "/api/v1/model-config/selection", { language: { provider_id: "my-llm", model_id: "big" }, embedding: null });
  assert.equal(pick.status, 200, JSON.stringify(pick.body));
  assert.equal(resolveModel(service.profile).model, "my-llm/big");
  const embedding = await go("POST", "/api/v1/model-config/selection", { language: null, embedding: { provider_id: "my-llm", model_id: "big" } });
  assert.equal(embedding.status, 422, "用户自己的服务里的模型不能选作嵌入模型");
});

test("Codex 订阅：不写两个共用文件，只看凭据文件里有没有登录", async () => {
  const r = await go("POST", "/api/v1/model-config/providers", { kind: "codex" });
  assert.equal(r.status, 200);
  assert.equal(r.body.provider.id, "taskwright-codex");
  assert.equal(r.body.provider.key, null);
  assert.equal(r.body.provider.status.logged_in, false);
  assert.equal(existsSync(modelsJson()), false);
  assert.equal(existsSync(authJson()), false);
  writeFileSync(authJson(), JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 } }));
  const again = await go("POST", "/api/v1/model-config/providers/taskwright-codex/check", {});
  assert.equal(again.body.provider.status.logged_in, true);
  assert.equal(again.body.provider.status.ok, true);
});

// ───────────── 写文件的三条规矩 ─────────────

test("别的内容原样保留：用户的服务、不认识的字段、产品那一项里用户另加的字段、凭据文件里别人的凭据", async () => {
  const userModels = {
    providers: { "my-llm": { baseUrl: "http://x/v1", api: "openai-completions", apiKey: "k", models: [{ id: "big", contextWindow: 65536, cost: { input: 1 } }], weird: [1, 2] } },
    somethingElse: { keep: true },
  };
  const userAuth = { anthropic: { type: "api_key", key: "sk-ant" }, "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 } };
  writeFileSync(modelsJson(), JSON.stringify(userModels));
  writeFileSync(authJson(), JSON.stringify(userAuth), { mode: 0o600 });
  openaiRoutes("sk-mine-5678");
  const id = (await go("POST", "/api/v1/model-config/providers", { kind: "openai_compatible", base_url: `${fake.url}/v1`, api_key: "sk-mine-5678" })).body.provider.id;
  // 用户在产品的那一项里另加了一个字段
  const withExtra = readJson(modelsJson());
  withExtra.providers[id].headers = { "x-user": "1" };
  writeFileSync(modelsJson(), JSON.stringify(withExtra));
  await go("POST", `/api/v1/model-config/providers/${id}`, { models: [{ id: "m-a", type: "language", enabled: true, context_window: 1000 }] });
  const now = readJson(modelsJson());
  assert.deepEqual(now.providers["my-llm"], userModels.providers["my-llm"]);
  assert.deepEqual(now.somethingElse, userModels.somethingElse);
  assert.deepEqual(now.providers[id].headers, { "x-user": "1" }, "产品那一项里用户另加的字段保留");
  await go("POST", `/api/v1/model-config/providers/${id}/delete`, {});
  assert.deepEqual(readJson(modelsJson()), userModels);
  assert.deepEqual(readJson(authJson()), userAuth);
});

test("写之前备份：每个文件留最近 5 份，凭据文件的备份也是 0600", async () => {
  openaiRoutes(null);
  writeFileSync(modelsJson(), JSON.stringify({ providers: {} }));
  const id = (await go("POST", "/api/v1/model-config/providers", { kind: "openai_compatible", base_url: `${fake.url}/v1`, api_key: "sk-0000" })).body.provider.id;
  assert.equal(backups("models.json").length, 1);
  assert.deepEqual(readJson(join(agent, backups("models.json")[0])), { providers: {} }, "备份是写之前的内容");
  for (let n = 1; n <= 7; n++) {
    await go("POST", `/api/v1/model-config/providers/${id}`, { api_key: `sk-000${n}` });
  }
  assert.equal(backups("models.json").length, BACKUP_KEEP);
  assert.equal(backups("auth.json").length, BACKUP_KEEP);
  for (const name of backups("auth.json")) assert.equal(statSync(join(agent, name)).mode & 0o777, 0o600, name);
  const newest = backups("auth.json").at(-1)!;
  assert.equal(readJson(join(agent, newest))[id].key, "sk-0006", "最新的备份是最后一次改之前的内容");
});

test("加锁：写的时候锁目录在；别人拿着锁时等不到就报 config_locked，文件不动；失效的锁清掉接着写", async () => {
  const file = join(agent, "models.json");
  writeFileSync(file, JSON.stringify({ providers: {} }));
  let sawLock = false;
  await updateJsonFile(file, (value) => {
    sawLock = existsSync(lockPath(file));
    value.touched = true;
    return true;
  });
  assert.equal(sawLock, true, "改写时锁目录在");
  assert.equal(existsSync(lockPath(file)), false, "写完锁目录删掉");
  mkdirSync(lockPath(file));
  const started = Date.now();
  await assert.rejects(updateJsonFile(file, (value) => {
    value.second = true;
    return true;
  }), (error: any) => error.code === "config_locked");
  assert.ok(Date.now() - started >= LOCK_WAIT_MS - 50, "等够了才放弃");
  assert.equal(readJson(file).second, undefined, "等不到锁时不写");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath(file), old, old);
  await updateJsonFile(file, (value) => {
    value.third = true;
    return true;
  });
  assert.equal(readJson(file).third, true, "失效的锁清掉之后照常写");
  assert.equal(existsSync(lockPath(file)), false);
  // 经接口时是 409 之外的 503 config_locked
  mkdirSync(lockPath(file));
  openaiRoutes(null);
  const r = await go("POST", "/api/v1/model-config/providers", { kind: "openai_compatible", base_url: `${fake.url}/v1` });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "config_locked");
  assert.deepEqual(readJson(settings).pi_dirs[agent].providers, {}, "共用文件没写成时产品设置里的这一项撤回");
  rmSync(lockPath(file), { recursive: true });
});

test("模型登记文件里有注释时拒绝改写，说明原因，一个文件都不动", async () => {
  const text = '{\n  // 我的注释\n  "providers": {}\n}\n';
  writeFileSync(modelsJson(), text);
  openaiRoutes(null);
  const r = await go("POST", "/api/v1/model-config/providers", { kind: "openai_compatible", base_url: `${fake.url}/v1`, api_key: "sk-1111" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "config_unwritable");
  assert.equal(r.body.error.message, "配置文件 models.json 里面有注释，改写时会把注释丢掉，所以没有改动它。请手工检查这个文件。");
  assert.equal(readFileSync(modelsJson(), "utf-8"), text);
  assert.equal(existsSync(authJson()), false);
  assert.equal(existsSync(settings), false);
});

test("设置按 pi 配置目录分开记：换了目录就等于没有配置过", async () => {
  const id = await addOllama();
  await go("POST", `/api/v1/model-config/providers/${id}`, { models: [{ id: "qwen3:8b", type: "language", enabled: true, context_window: 8192 }] });
  await go("POST", "/api/v1/model-config/selection", { language: { provider_id: id, model_id: "qwen3:8b" }, embedding: null });
  assert.equal(resolveModel(service.profile).from, "产品设置");
  process.env.PI_CODING_AGENT_DIR = join(tmp, "another-agent");
  assert.equal(resolveModel(service.profile).model, "fake/fake-model");
  assert.equal((await go("GET", "/api/v1/model-config")).body.providers.length, 0);
  process.env.PI_CODING_AGENT_DIR = agent;
  assert.equal(Object.keys(readJson(settings).pi_dirs).length, 1);
});
