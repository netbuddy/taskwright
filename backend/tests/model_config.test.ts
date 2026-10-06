/**
 * 在界面上配置模型服务（docs/api.md §10）：各接口、写共用配置文件的三条规矩（别的内容原样保留、写前备份、照 pi 的办法加锁）、
 * 带注释的文件拒绝改写、只许本机修改、密钥不返回、用户自己登记的服务只读、选定的模型成为起助手用的模型。
 * 一个模型服务只有一种用途（语言模型或者嵌入模型）；上一版设置文件里没有用途的模型服务怎样迁移，在文件末尾。
 * 模型服务是本文件里起的一个假服务（只应答列模型、查模型详情、载入模型几个接口）；pi 的配置目录与产品设置文件都在临时目录里。
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { BACKUP_KEEP, LOCK_WAIT_MS, lockPath, updateJsonFile } from "../src/config_files.ts";
import { dispatch, serviceInfo } from "../src/http.ts";
import { resolveModel } from "../src/launch.ts";
import { embeddingTarget, migrateProviderPurposes } from "../src/model_config.ts";
import { needsPurposeMigration, readPiDirSettings } from "../src/product_settings.ts";
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

async function addOllama(purpose: "language" | "embedding" = "language"): Promise<string> {
  ollamaRoutes();
  const r = await go("POST", "/api/v1/model-config/providers", { purpose, kind: "ollama", name: purpose === "language" ? "本机 ollama" : "本机 ollama 的嵌入模型", base_url: fake.url });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.provider.id;
}

// ───────────── 从哪里来的请求都能改 ─────────────

test("从别的电脑来的请求（来源地址、Origin、X-Forwarded-For 三种写法）也能改，也读得到接口地址与密钥末四位", async () => {
  openaiRoutes("sk-right-key-1234");
  const other = [{ remote: "198.51.100.20" }, { headers: { origin: "http://198.51.100.20:5680" } }, { headers: { "x-forwarded-for": "198.51.100.20" } }];
  for (const from of other) {
    const where = JSON.stringify(from);
    const added = await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "openai_compatible", name: "内网服务", base_url: `${fake.url}/v1`, api_key: "sk-right-key-1234" }, from);
    assert.equal(added.status, 200, `${where} ${JSON.stringify(added.body)}`);
    const id = added.body.provider.id;
    for (const [path, body] of [
      [`/api/v1/model-config/providers/${id}`, { name: "改名" }],
      [`/api/v1/model-config/providers/${id}/check`, {}],
      [`/api/v1/model-config/providers/${id}/fetch-models`, {}],
      [`/api/v1/model-config/providers/${id}/context-window`, { model_id: "qwen3:8b" }],
      ["/api/v1/model-config/selection", { language: null, embedding: null }],
    ] as const) {
      const r = await go("POST", path, body, from);
      assert.equal(r.status, 200, `${path} ${where} ${JSON.stringify(r.body)}`);
    }
    const view = await go("GET", "/api/v1/model-config", undefined, from);
    assert.equal(view.body.editable, true, where);
    assert.equal(view.body.notice, null, where);
    assert.equal(view.body.providers[0].base_url, `${fake.url}/v1`, `${where} 读得到接口地址`);
    assert.deepEqual(view.body.providers[0].key, { set: true, last4: "1234" }, `${where} 读得到密钥末四位`);
    const gone = await go("POST", `/api/v1/model-config/providers/${id}/delete`, {}, from);
    assert.equal(gone.status, 200, `${where} ${JSON.stringify(gone.body)}`);
  }
  assert.equal(serviceInfo(service, "127.0.0.1").capabilities.model_config, true);
  assert.equal(serviceInfo(service, "198.51.100.20").capabilities.model_config, true);
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
  assert.equal(stored.purpose, "language");
  assert.equal(stored.name, "本机 ollama");
  assert.equal(stored.status.ok, true);
  assert.equal(existsSync(authJson()), false, "没有密钥时不碰凭据文件");
  // 第二个 ollama 用下一个名字
  const again = await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "ollama", base_url: fake.url });
  assert.equal(again.body.provider.id, "taskwright-ollama-2");
  assert.equal(again.body.provider.name, "ollama");
  assert.equal(again.body.provider.purpose, "language");
});

test("添加时要说明用途：没有给或者写错了都拒绝；同一个地址的嵌入模型另添加一次，服务名与缺省的名称都带着用途", async () => {
  ollamaRoutes();
  for (const body of [{ kind: "ollama", base_url: fake.url }, { purpose: "speech", kind: "ollama", base_url: fake.url }, { purpose: null, kind: "ollama", base_url: fake.url }]) {
    const r = await go("POST", "/api/v1/model-config/providers", body);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.deepEqual([r.body.error.code, r.body.error.data.field, r.body.error.message], ["rejected", "purpose", "请选择这个模型服务提供哪一类模型。"]);
  }
  const codex = await go("POST", "/api/v1/model-config/providers", { purpose: "embedding", kind: "codex" });
  assert.deepEqual([codex.status, codex.body.error.data.field, codex.body.error.message], [422, "kind", "Codex 订阅没有嵌入模型。"]);
  assert.equal(existsSync(settings), false, "被拒时产品设置不写");
  assert.equal(existsSync(modelsJson()), false, "被拒时模型登记文件不写");
  assert.deepEqual(fake.hits, [], "被拒时不去连模型服务");
  const language = await addOllama();
  const first = await go("POST", "/api/v1/model-config/providers", { purpose: "embedding", kind: "ollama", base_url: fake.url });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.provider.id, first.body.provider.name, first.body.provider.purpose], ["taskwright-ollama-embedding", "ollama（嵌入模型）", "embedding"]);
  const second = await go("POST", "/api/v1/model-config/providers", { purpose: "embedding", kind: "ollama", base_url: fake.url });
  assert.equal(second.body.provider.id, "taskwright-ollama-embedding-2");
  const view = (await go("GET", "/api/v1/model-config")).body;
  assert.deepEqual(view.providers.map((p: Dict) => [p.id, p.purpose]), [[language, "language"], ["taskwright-ollama-embedding", "embedding"], ["taskwright-ollama-embedding-2", "embedding"]]);
  // 嵌入模型的模型服务在模型登记文件里也有一项，模型清单是空的；用途添加之后改不了
  assert.deepEqual(readJson(modelsJson()).providers["taskwright-ollama-embedding"].models, []);
  const changed = await go("POST", "/api/v1/model-config/providers/taskwright-ollama-embedding", { purpose: "language", name: "改个名" });
  assert.deepEqual([changed.body.provider.name, changed.body.provider.purpose], ["改个名", "embedding"]);
});

test("连不上或者密钥被拒时不保存，422 指明是地址还是密钥", async () => {
  const down = await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "vllm", base_url: `http://127.0.0.1:${closedPort}` });
  assert.equal(down.status, 422);
  assert.equal(down.body.error.code, "rejected");
  assert.equal(down.body.error.data.field, "base_url");
  assert.equal(down.body.error.message, "连不上这个地址。请确认模型服务已经启动，地址与端口没有写错。");
  openaiRoutes("sk-right-key-1234");
  const bad = await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "openai_compatible", base_url: `${fake.url}/v1`, api_key: "sk-wrong" });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.data.field, "api_key");
  assert.equal(bad.body.error.message, "模型服务拒绝了这个密钥。");
  const missing = await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "deepseek", base_url: `${fake.url}/v1` });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.data.field, "api_key");
  const noUrl = await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "openai_compatible" });
  assert.equal(noUrl.body.error.data.field, "base_url");
  assert.equal(existsSync(modelsJson()), false, "失败时模型登记文件一字不动");
  assert.equal(existsSync(settings), false, "失败时产品设置也不写");
});

test("密钥写进凭据文件（0600），接口只给「已设置」与末四位；改名、换密钥、删除", async () => {
  openaiRoutes("sk-right-key-1234");
  const r = await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "openai_compatible", name: "内网服务", base_url: `${fake.url}/v1/`, api_key: "sk-right-key-1234" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.provider.id;
  assert.equal(id, "taskwright-openai_compatible");
  assert.deepEqual(r.body.provider.key, { set: true, last4: "1234" });
  assert.deepEqual(readJson(authJson())[id], { type: "api_key", key: "sk-right-key-1234" });
  assert.equal(statSync(authJson()).mode & 0o777, 0o600);
  assert.equal(readJson(modelsJson()).providers[id].baseUrl, `${fake.url}/v1`, "末尾的斜杠去掉");
  assert.equal(JSON.stringify((await go("GET", "/api/v1/model-config")).body).includes("sk-right-key-1234"), false, "读配置不带密钥");
  assert.equal(JSON.stringify((await go("GET", "/api/v1/model-config", undefined, { remote: "203.0.113.9" })).body.providers[0].key), '{"set":true,"last4":"1234"}');
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

test("ollama：获取模型列表只留与用途对得上的模型，上下文长度不填；查上下文长度先载入再读实际值", async () => {
  const id = await addOllama();
  const r = await go("POST", `/api/v1/model-config/providers/${id}/fetch-models`, {});
  assert.equal(r.body.result, "listed");
  assert.deepEqual(r.body.provider.models, [
    { id: "qwen3:8b", enabled: false, context_window: null, context_source: null },
    { id: "qwen3:32b", enabled: false, context_window: null, context_source: null },
  ]);
  assert.ok(r.body.provider.models_fetched_at);
  const embedding = await addOllama("embedding");
  const e = await go("POST", `/api/v1/model-config/providers/${embedding}/fetch-models`, {});
  assert.deepEqual(e.body.provider.models, [{ id: "qwen3-embedding:8b", enabled: false, context_window: null, context_source: null }]);
  fake.hits = [];
  const cw = await go("POST", `/api/v1/model-config/providers/${id}/context-window`, { model_id: "qwen3:8b" });
  assert.deepEqual(cw.body, { ok: true, context_window: 8192, source: "service", message: "" });
  assert.deepEqual(fake.hits.map((h) => `${h.method} ${h.path}`), ["POST /api/generate", "GET /api/ps"]);
  const unknown = await go("POST", `/api/v1/model-config/providers/${id}/context-window`, { model_id: "qwen3:32b" });
  assert.equal(unknown.body.context_window, null);
  assert.match(unknown.body.message, /请手工填写/);
});

test("按用途筛选取回的模型列表：分辨得出类型的种类只留对得上的，分辨不出的全留", async () => {
  const ids = (models: Dict[]) => models.map((m) => m.id);
  // 阿里云按模型名分辨
  openaiRoutes("sk-ali-0001", [{ id: "qwen-max" }, { id: "text-embedding-v4" }]);
  const fetched: Record<string, string[]> = {};
  for (const purpose of ["language", "embedding"]) {
    const added = await go("POST", "/api/v1/model-config/providers", { purpose, kind: "aliyun", base_url: `${fake.url}/v1`, api_key: "sk-ali-0001" });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    fetched[purpose] = ids((await go("POST", `/api/v1/model-config/providers/${added.body.provider.id}/fetch-models`, {})).body.provider.models);
  }
  assert.deepEqual(fetched, { language: ["qwen-max"], embedding: ["text-embedding-v4"] });
  // vLLM 分辨不出，两种用途都把清单全列出来
  openaiRoutes(null, [{ id: "m-a", max_model_len: 32768 }, { id: "bge-m3" }]);
  for (const purpose of ["language", "embedding"]) {
    const added = await go("POST", "/api/v1/model-config/providers", { purpose, kind: "vllm", base_url: fake.url });
    const got = (await go("POST", `/api/v1/model-config/providers/${added.body.provider.id}/fetch-models`, {})).body.provider;
    assert.deepEqual([got.purpose, ids(got.models)], [purpose, ["m-a", "bge-m3"]]);
  }
});

test("兼容 OpenAI 的服务：列表带上下文长度；没有列表时说不提供；出错时说没有成功；再次获取保留勾选与用户填的值", async () => {
  openaiRoutes();
  const id = (await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "vllm", base_url: fake.url })).body.provider.id;
  const r = await go("POST", `/api/v1/model-config/providers/${id}/fetch-models`, {});
  assert.deepEqual(r.body.provider.models, [
    { id: "m-a", enabled: false, context_window: 32768, context_source: "service" },
    { id: "m-b", enabled: false, context_window: null, context_source: null },
  ]);
  await go("POST", `/api/v1/model-config/providers/${id}`, { models: [
    { id: "m-a", enabled: true, context_window: 32768, context_source: "service" },
    { id: "m-b", enabled: true, context_window: 4096 },
  ] });
  openaiRoutes(null, [{ id: "m-a", max_model_len: 65536 }, { id: "m-b", max_model_len: 99999 }, { id: "m-c" }]);
  const again = await go("POST", `/api/v1/model-config/providers/${id}/fetch-models`, {});
  assert.deepEqual(again.body.provider.models, [
    { id: "m-a", enabled: true, context_window: 65536, context_source: "service" },
    { id: "m-b", enabled: true, context_window: 4096, context_source: "user" },
    { id: "m-c", enabled: false, context_window: null, context_source: null },
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

test("勾选的语言模型要有上下文长度，嵌入模型不用；只有语言模型的模型服务把勾选的模型写进模型登记文件", async () => {
  const id = await addOllama();
  await go("POST", `/api/v1/model-config/providers/${id}/fetch-models`, {});
  const missing = await go("POST", `/api/v1/model-config/providers/${id}`, { models: [{ id: "qwen3:8b", enabled: true, context_window: null }] });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.message, "模型「qwen3:8b」还没有填上下文长度，填了才能保存。");
  const ok = await go("POST", `/api/v1/model-config/providers/${id}`, { models: [
    { id: "qwen3:8b", enabled: true, context_window: 8192 },
    { id: "qwen3:32b", enabled: false, context_window: null },
    { id: "手工加的", enabled: true, context_window: 4096 },
  ] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(readJson(modelsJson()).providers[id].models, [{ id: "qwen3:8b", contextWindow: 8192 }, { id: "手工加的", contextWindow: 4096 }]);
  const embedding = await addOllama("embedding");
  // 请求里给模型写的 type 不算数：模型的类型就是模型服务的用途
  const saved = await go("POST", `/api/v1/model-config/providers/${embedding}`, { models: [
    { id: "qwen3-embedding:8b", type: "language", enabled: true, context_window: null },
    { id: "手工加的嵌入模型", enabled: true },
  ] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.provider.models, [
    { id: "qwen3-embedding:8b", enabled: true, context_window: null, context_source: null },
    { id: "手工加的嵌入模型", enabled: true, context_window: null, context_source: null },
  ]);
  assert.deepEqual(readJson(modelsJson()).providers[embedding].models, [], "嵌入模型不写进模型登记文件");
  assert.deepEqual(readJson(modelsJson()).providers[id].models.length, 2, "语言模型那一项不受影响");
});

// ───────────── 选定模型 ─────────────

test("选定语言模型与嵌入模型：各从自己用途的模型服务里选；起助手用选定的模型；停用或删除被选中的要先换；嵌入模型可以不选", async () => {
  const id = await addOllama();
  const eid = await addOllama("embedding");
  await go("POST", `/api/v1/model-config/providers/${id}`, { models: [{ id: "qwen3:8b", enabled: true, context_window: 8192 }, { id: "qwen3:32b", enabled: false, context_window: null }] });
  await go("POST", `/api/v1/model-config/providers/${eid}`, { models: [{ id: "qwen3-embedding:8b", enabled: true, context_window: null }] });
  assert.equal(resolveModel(service.profile).model, "fake/fake-model", "没有选过时照 0.3 的规则");
  const before = (await go("GET", "/api/v1/model-config")).body;
  assert.deepEqual(before.fallback, { model: "fake/fake-model", from: "启动配置" });
  const bad = await go("POST", "/api/v1/model-config/selection", { language: { provider_id: id, model_id: "qwen3:32b" }, embedding: null });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.message, "模型服务「本机 ollama」里没有勾选模型「qwen3:32b」。");
  // 用途对不上的模型服务不能选：语言模型不能从嵌入模型的模型服务里选，反过来也一样
  const wrongLanguage = await go("POST", "/api/v1/model-config/selection", { language: { provider_id: eid, model_id: "qwen3-embedding:8b" }, embedding: null });
  assert.deepEqual([wrongLanguage.status, wrongLanguage.body.error.data.field, wrongLanguage.body.error.message], [422, "language", "模型服务「本机 ollama 的嵌入模型」提供的不是语言模型。"]);
  const wrongEmbedding = await go("POST", "/api/v1/model-config/selection", { language: null, embedding: { provider_id: id, model_id: "qwen3:8b" } });
  assert.deepEqual([wrongEmbedding.status, wrongEmbedding.body.error.data.field, wrongEmbedding.body.error.message], [422, "embedding", "模型服务「本机 ollama」提供的不是嵌入模型。"]);
  const r = await go("POST", "/api/v1/model-config/selection", {
    language: { provider_id: id, model_id: "qwen3:8b" }, embedding: { provider_id: eid, model_id: "qwen3-embedding:8b", query_prefix: "Instruct: 找相关段落\nQuery: " },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.note, "更换之后，下一次打开或者新建会话时生效。正在进行的会话不受影响。");
  assert.deepEqual(r.body.selection, {
    language: { provider_id: id, model_id: "qwen3:8b" }, embedding: { provider_id: eid, model_id: "qwen3-embedding:8b", query_prefix: "Instruct: 找相关段落\nQuery: " },
  });
  const resolved = resolveModel(service.profile);
  assert.equal(resolved.model, `${id}/qwen3:8b`);
  assert.equal(resolved.from, "产品设置");
  const after = (await go("GET", "/api/v1/model-config")).body;
  assert.equal(after.fallback, null);
  assert.deepEqual(after.providers.map((p: Dict) => [p.id, p.in_use]), [[id, ["language"]], [eid, ["embedding"]]]);
  const disable = await go("POST", `/api/v1/model-config/providers/${id}`, { models: [{ id: "qwen3:8b", enabled: false, context_window: 8192 }] });
  assert.equal(disable.status, 409);
  assert.equal(disable.body.error.code, "in_use");
  assert.equal(disable.body.error.message, "模型「qwen3:8b」正被选为助手用的语言模型，先换成别的模型再停用它。");
  const disableEmbedding = await go("POST", `/api/v1/model-config/providers/${eid}`, { models: [{ id: "qwen3-embedding:8b", enabled: false, context_window: null }] });
  assert.equal(disableEmbedding.body.error.code, "in_use");
  assert.equal(disableEmbedding.body.error.message, "模型「qwen3-embedding:8b」正被选为查找用的嵌入模型，先换成别的模型再停用它。");
  const del = await go("POST", `/api/v1/model-config/providers/${id}/delete`, {});
  assert.equal(del.body.error.code, "in_use");
  assert.equal(del.body.error.message, "这个模型服务的模型正被选为助手用的语言模型，先换成别的模型再删除它。");
  const delEmbedding = await go("POST", `/api/v1/model-config/providers/${eid}/delete`, {});
  assert.equal(delEmbedding.body.error.message, "这个模型服务的模型正被选为查找用的嵌入模型，先换成别的模型再删除它。");
  // 嵌入模型连到嵌入模型的那个模型服务
  const target = embeddingTarget({ env: process.env, profile: service.profile })!;
  assert.deepEqual([target.provider_id, target.model, target.url], [eid, "qwen3-embedding:8b", `${fake.url}/api/embed`]);
  const noEmbedding = await go("POST", "/api/v1/model-config/selection", { language: { provider_id: id, model_id: "qwen3:8b" }, embedding: null });
  assert.equal(noEmbedding.body.selection.embedding, null);
  assert.equal((await go("POST", `/api/v1/model-config/providers/${eid}/delete`, {})).status, 200, "不选之后可以删");
  await go("POST", "/api/v1/model-config/selection", { language: null, embedding: null });
  assert.equal(resolveModel(service.profile).model, "fake/fake-model", "不选之后回到 0.3 的规则");
});

test("用户自己在模型登记文件里写的服务：单列只读，语言模型可以选，改不了也删不了", async () => {
  writeFileSync(modelsJson(), JSON.stringify({ providers: { "my-llm": { baseUrl: "http://x/v1", api: "openai-completions", apiKey: "sk-user-secret", name: "我的服务", models: [{ id: "big", contextWindow: 65536 }] } } }));
  const view = (await go("GET", "/api/v1/model-config")).body;
  assert.equal(view.providers.length, 1);
  assert.deepEqual(view.providers[0], {
    id: "my-llm", managed: false, kind: null, purpose: "language", name: "我的服务", base_url: null, key: null, status: null, models_fetched_at: null, in_use: [],
    models: [{ id: "big", enabled: true, context_window: 65536, context_source: null }],
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
  const r = await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "codex" });
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

test("选定 Codex 订阅里的模型：交给助手程序的模型名用助手程序自己的服务商名，不是产品给这个模型服务起的服务名", async () => {
  writeFileSync(authJson(), JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 } }));
  const id = (await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "codex" })).body.provider.id;
  assert.equal(id, "taskwright-codex");
  const saved = await go("POST", `/api/v1/model-config/providers/${id}`, { models: [{ id: "gpt-6-luna", enabled: true, context_window: 272000 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const picked = await go("POST", "/api/v1/model-config/selection", { language: { provider_id: id, model_id: "gpt-6-luna" }, embedding: null });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  // 接口里选定的仍然是产品的服务名；起助手、换模型用的是「openai-codex/模型」
  assert.deepEqual(picked.body.selection.language, { provider_id: id, model_id: "gpt-6-luna" });
  assert.deepEqual([resolveModel(service.profile).model, resolveModel(service.profile).from], ["openai-codex/gpt-6-luna", "产品设置"]);
  // 「有没有可用的模型」按同一个名字查：凭据文件里有这个服务商的登录凭据，所以是有
  const info = serviceInfo(service, "127.0.0.1");
  assert.equal(info.capabilities.model, true, info.model.reason);
  assert.equal(info.model.name, "openai-codex/gpt-6-luna");
});

test("Codex 订阅获取模型列表没有成功：没有登录时让用户先登录；别的原因只说稍后再试；都不建议手工添加", async () => {
  const before = process.env.TASKWRIGHT_PI_ENTRY;
  const fetchWith = async (entry: string) => {
    process.env.TASKWRIGHT_PI_ENTRY = entry;
    const r = await go("POST", "/api/v1/model-config/providers/taskwright-codex/fetch-models", {});
    assert.equal(r.body.result, "failed");
    return r.body.message;
  };
  try {
    // 假的助手程序：列模型时什么都不输出，等于一个服务都没有登录
    const nothing = join(tmp, "list-nothing.mjs");
    writeFileSync(nothing, "");
    process.env.TASKWRIGHT_PI_ENTRY = nothing;
    await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "codex" });
    assert.equal(await fetchWith(nothing), "获取模型列表没有成功：还没有登录 Codex 订阅。请先在命令行里登录，再回到这里点「获取模型列表」。");
    // 假的助手程序：一运行就出错退出
    const broken = join(tmp, "list-broken.mjs");
    writeFileSync(broken, "process.exit(1);\n");
    assert.equal(await fetchWith(broken), "获取模型列表没有成功：没能读出 Codex 订阅的模型目录。可以稍后再试。");
    assert.equal(await fetchWith(join(tmp, "no-such-entry.mjs")), "获取模型列表没有成功：找不到助手的程序。可以稍后再试。");
  } finally {
    if (before === undefined) delete process.env.TASKWRIGHT_PI_ENTRY;
    else process.env.TASKWRIGHT_PI_ENTRY = before;
  }
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
  const id = (await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "openai_compatible", base_url: `${fake.url}/v1`, api_key: "sk-mine-5678" })).body.provider.id;
  // 用户在产品的那一项里另加了一个字段
  const withExtra = readJson(modelsJson());
  withExtra.providers[id].headers = { "x-user": "1" };
  writeFileSync(modelsJson(), JSON.stringify(withExtra));
  await go("POST", `/api/v1/model-config/providers/${id}`, { models: [{ id: "m-a", enabled: true, context_window: 1000 }] });
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
  const id = (await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "openai_compatible", base_url: `${fake.url}/v1`, api_key: "sk-0000" })).body.provider.id;
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
  const r = await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "openai_compatible", base_url: `${fake.url}/v1` });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "config_locked");
  assert.deepEqual(readJson(settings).pi_dirs[agent].providers, {}, "共用文件没写成时产品设置里的这一项撤回");
  rmSync(lockPath(file), { recursive: true });
});

test("模型登记文件里有注释时拒绝改写，说明原因，一个文件都不动", async () => {
  const text = '{\n  // 我的注释\n  "providers": {}\n}\n';
  writeFileSync(modelsJson(), text);
  openaiRoutes(null);
  const r = await go("POST", "/api/v1/model-config/providers", { purpose: "language", kind: "openai_compatible", base_url: `${fake.url}/v1`, api_key: "sk-1111" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "config_unwritable");
  assert.equal(r.body.error.message, "配置文件 models.json 里面有注释，改写时会把注释丢掉，所以没有改动它。请手工检查这个文件。");
  assert.equal(readFileSync(modelsJson(), "utf-8"), text);
  assert.equal(existsSync(authJson()), false);
  assert.equal(existsSync(settings), false);
});

test("设置按 pi 配置目录分开记：换了目录就等于没有配置过", async () => {
  const id = await addOllama();
  await go("POST", `/api/v1/model-config/providers/${id}`, { models: [{ id: "qwen3:8b", enabled: true, context_window: 8192 }] });
  await go("POST", "/api/v1/model-config/selection", { language: { provider_id: id, model_id: "qwen3:8b" }, embedding: null });
  assert.equal(resolveModel(service.profile).from, "产品设置");
  process.env.PI_CODING_AGENT_DIR = join(tmp, "another-agent");
  assert.equal(resolveModel(service.profile).model, "fake/fake-model");
  assert.equal((await go("GET", "/api/v1/model-config")).body.providers.length, 0);
  process.env.PI_CODING_AGENT_DIR = agent;
  assert.equal(Object.keys(readJson(settings).pi_dirs).length, 1);
});

// ───────────── 上一版的设置文件：给没有用途的模型服务定用途 ─────────────

/** 写一份上一版（第 1 版）的设置：模型服务没有用途，每个模型标着类型。 */
function writeOldSettings(providers: Dict, selection: Dict = { language: null, embedding: null }): void {
  mkdirSync(join(settings, ".."), { recursive: true });
  writeFileSync(settings, JSON.stringify({ version: 1, pi_dirs: { [agent]: { selection, providers } } }));
}
const oldModel = (id: string, type: "language" | "embedding", enabled = true) =>
  ({ id, type, enabled, context_window: type === "language" ? 8192 : null, context_source: type === "language" ? "user" : null });
const oldProvider = (name: string, models: Dict[], more: Dict = {}) =>
  ({ kind: "ollama", name, base_url: "http://127.0.0.1:11434", models_fetched_at: "2026-09-30T10:00:00+08:00", status: { checked_at: "2026-09-30T10:00:00+08:00", ok: true, message: "" }, models, ...more });
const ctx = () => ({ env: process.env, profile: service.profile });
const storedDir = () => readJson(settings).pi_dirs[agent];

test("迁移：清单里全是语言模型的模型服务定为语言模型，服务名、名称与清单都不变", async () => {
  writeOldSettings({ "taskwright-ollama": oldProvider("本机 ollama", [oldModel("qwen3:8b", "language"), oldModel("qwen3:32b", "language", false)]) },
    { language: { provider: "taskwright-ollama", model: "qwen3:8b" }, embedding: null });
  assert.equal(needsPurposeMigration(agent), true);
  const notes = await migrateProviderPurposes(ctx());
  assert.deepEqual(notes, ["模型服务「本机 ollama」（taskwright-ollama）的用途定为语言模型。"]);
  assert.equal(readJson(settings).version, 2);
  assert.deepEqual(storedDir().providers, { "taskwright-ollama": {
    kind: "ollama", purpose: "language", name: "本机 ollama", base_url: "http://127.0.0.1:11434", models_fetched_at: "2026-09-30T10:00:00+08:00",
    status: { checked_at: "2026-09-30T10:00:00+08:00", ok: true, message: "" },
    models: [{ id: "qwen3:8b", enabled: true, context_window: 8192, context_source: "user" }, { id: "qwen3:32b", enabled: false, context_window: 8192, context_source: "user" }],
  } });
  assert.deepEqual(storedDir().selection, { language: { provider: "taskwright-ollama", model: "qwen3:8b" }, embedding: null });
  assert.equal(existsSync(modelsJson()), false, "没有拆分时不碰模型登记文件");
  assert.equal(existsSync(authJson()), false, "没有拆分时不碰凭据文件");
  // 迁移过了就不再迁移，也不再写文件
  assert.equal(needsPurposeMigration(agent), false);
  const before = readFileSync(settings, "utf-8");
  assert.deepEqual(await migrateProviderPurposes(ctx()), []);
  assert.equal(readFileSync(settings, "utf-8"), before);
});

test("迁移：清单里全是嵌入模型的模型服务定为嵌入模型，服务名与名称不变，选定的嵌入模型照旧", async () => {
  writeOldSettings({ "taskwright-ollama": oldProvider("嵌入用的 ollama", [oldModel("bge-m3", "embedding"), oldModel("qwen3-embedding:8b", "embedding", false)]) },
    { language: null, embedding: { provider: "taskwright-ollama", model: "bge-m3", query_prefix: "查询：" } });
  assert.deepEqual(await migrateProviderPurposes(ctx()), ["模型服务「嵌入用的 ollama」（taskwright-ollama）的用途定为嵌入模型。"]);
  const p = storedDir().providers["taskwright-ollama"];
  assert.deepEqual([Object.keys(storedDir().providers), p.purpose, p.name], [["taskwright-ollama"], "embedding", "嵌入用的 ollama"]);
  assert.deepEqual(p.models, [{ id: "bge-m3", enabled: true, context_window: null, context_source: null }, { id: "qwen3-embedding:8b", enabled: false, context_window: null, context_source: null }]);
  assert.deepEqual(storedDir().selection.embedding, { provider: "taskwright-ollama", model: "bge-m3", query_prefix: "查询：" });
  assert.equal(embeddingTarget(ctx())!.url, "http://127.0.0.1:11434/api/embed");
});

test("迁移：清单是空的模型服务定为语言模型；Codex 订阅也是语言模型", async () => {
  writeOldSettings({
    "taskwright-vllm": { ...oldProvider("还没取过清单的", []), kind: "vllm" },
    "taskwright-codex": { kind: "codex", name: "Codex 订阅", base_url: null, models_fetched_at: null, status: null, models: [oldModel("gpt-6-luna", "language")] },
  });
  assert.deepEqual(await migrateProviderPurposes(ctx()), [
    "模型服务「还没取过清单的」（taskwright-vllm）的用途定为语言模型。", "模型服务「Codex 订阅」（taskwright-codex）的用途定为语言模型。",
  ]);
  assert.deepEqual(Object.entries<Dict>(storedDir().providers).map(([id, p]) => [id, p.purpose, p.models.length]), [["taskwright-vllm", "language", 0], ["taskwright-codex", "language", 1]]);
});

test("迁移：两类模型都有的模型服务拆成两个，嵌入模型移到新的那一个，选定的嵌入模型跟过去；密钥照抄，模型登记文件里添上新的一项", async () => {
  const models = [oldModel("m-chat", "language"), oldModel("m-embed", "embedding"), oldModel("m-embed-2", "embedding", false), oldModel("m-chat-2", "language", false)];
  writeOldSettings({ "taskwright-openai_compatible": { ...oldProvider("内网服务", models), kind: "openai_compatible", base_url: `${fake.url}/v1` } }, {
    language: { provider: "taskwright-openai_compatible", model: "m-chat" }, embedding: { provider: "taskwright-openai_compatible", model: "m-embed", query_prefix: "Q: " },
  });
  // 模型登记文件里原来的那一项带着用户另加的字段；另有一项用户手写的，恰好占着拆出来的模型服务本来要用的服务名
  const oldEntry = { baseUrl: `${fake.url}/v1`, api: "openai-completions", apiKey: "taskwright-no-key", models: [{ id: "m-chat", contextWindow: 8192 }], headers: { "x-user": "1" } };
  const handWritten = { baseUrl: "http://x/v1", api: "openai-completions", apiKey: "k", models: [{ id: "big", contextWindow: 65536 }] };
  writeFileSync(modelsJson(), JSON.stringify({ providers: { "taskwright-openai_compatible": oldEntry, "taskwright-openai_compatible-embedding": handWritten } }));
  writeFileSync(authJson(), JSON.stringify({ "taskwright-openai_compatible": { type: "api_key", key: "sk-inner-4321" }, anthropic: { type: "api_key", key: "sk-ant" } }), { mode: 0o600 });
  const fresh = "taskwright-openai_compatible-embedding-2";
  assert.deepEqual(await migrateProviderPurposes(ctx()), [
    `模型服务「内网服务」（taskwright-openai_compatible）里既有语言模型又有嵌入模型，已经拆成两个：语言模型留在原处，嵌入模型移到「内网服务（嵌入模型）」（${fresh}）。`,
  ]);
  const dir = storedDir();
  assert.deepEqual(Object.keys(dir.providers), ["taskwright-openai_compatible", fresh]);
  const [kept, moved] = [dir.providers["taskwright-openai_compatible"], dir.providers[fresh]];
  assert.deepEqual([kept.purpose, kept.name, kept.models.map((m: Dict) => m.id)], ["language", "内网服务", ["m-chat", "m-chat-2"]]);
  assert.deepEqual([moved.purpose, moved.name, moved.models.map((m: Dict) => [m.id, m.enabled])], ["embedding", "内网服务（嵌入模型）", [["m-embed", true], ["m-embed-2", false]]]);
  assert.deepEqual([moved.kind, moved.base_url, moved.status, moved.models_fetched_at], [kept.kind, kept.base_url, kept.status, kept.models_fetched_at], "种类、地址、检查结果、获取时间照抄");
  assert.equal([...kept.models, ...moved.models].some((m: Dict) => Object.hasOwn(m, "type")), false, "模型上不再标类型");
  assert.deepEqual(dir.selection, {
    language: { provider: "taskwright-openai_compatible", model: "m-chat" }, embedding: { provider: fresh, model: "m-embed", query_prefix: "Q: " },
  });
  // 两个共用文件：原来的两项原样，新的一项清单是空的；密钥照抄一份，别人的凭据不动
  const now = readJson(modelsJson()).providers;
  assert.deepEqual(now["taskwright-openai_compatible"], oldEntry);
  assert.deepEqual(now["taskwright-openai_compatible-embedding"], handWritten);
  assert.deepEqual(now[fresh], { baseUrl: `${fake.url}/v1`, api: "openai-completions", apiKey: "taskwright-no-key", models: [] });
  assert.deepEqual(readJson(authJson()), {
    "taskwright-openai_compatible": { type: "api_key", key: "sk-inner-4321" }, anthropic: { type: "api_key", key: "sk-ant" }, [fresh]: { type: "api_key", key: "sk-inner-4321" },
  });
  assert.equal(statSync(authJson()).mode & 0o777, 0o600);
  // 迁移之后两种模型照旧用得上
  assert.equal(resolveModel(service.profile).model, "taskwright-openai_compatible/m-chat");
  const target = embeddingTarget(ctx())!;
  assert.deepEqual([target.provider_id, target.model, target.query_prefix, target.url, target.key], [fresh, "m-embed", "Q: ", `${fake.url}/v1/embeddings`, "sk-inner-4321"]);
  const view = (await go("GET", "/api/v1/model-config")).body;
  assert.deepEqual(view.providers.filter((p: Dict) => p.managed).map((p: Dict) => [p.id, p.purpose, p.in_use, p.key.last4]), [
    ["taskwright-openai_compatible", "language", ["language"], "4321"], [fresh, "embedding", ["embedding"], "4321"],
  ]);
});

test("迁移之前只读的时候不拆也不写文件：用途先按清单定，对不上的模型先不列；头一次改配置时补上迁移", async () => {
  writeOldSettings({ "taskwright-ollama": { ...oldProvider("本机 ollama", [oldModel("qwen3:8b", "language"), oldModel("qwen3-embedding:8b", "embedding")]), base_url: fake.url } },
    { language: { provider: "taskwright-ollama", model: "qwen3:8b" }, embedding: { provider: "taskwright-ollama", model: "qwen3-embedding:8b", query_prefix: "" } });
  const before = readFileSync(settings, "utf-8");
  const seen = readPiDirSettings(agent).providers["taskwright-ollama"];
  assert.deepEqual([seen.purpose, seen.models.map((m) => m.id)], ["language", ["qwen3:8b"]]);
  const view = (await go("GET", "/api/v1/model-config")).body;
  assert.deepEqual(view.providers.map((p: Dict) => [p.id, p.purpose, p.models.length]), [["taskwright-ollama", "language", 1]]);
  assert.equal(embeddingTarget(ctx())!.url, null, "还没有迁移时，选定的嵌入模型所在的模型服务提供的不是嵌入模型");
  assert.equal(resolveModel(service.profile).model, "taskwright-ollama/qwen3:8b");
  assert.equal(readFileSync(settings, "utf-8"), before, "只读的时候文件一字不动");
  // 没有经过任务服务启动就来改配置：先迁移，再照常做
  ollamaRoutes();
  const checked = await go("POST", "/api/v1/model-config/providers/taskwright-ollama/check", {});
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.deepEqual(Object.entries<Dict>(storedDir().providers).map(([id, p]) => [id, p.purpose, p.models.map((m: Dict) => m.id)]), [
    ["taskwright-ollama", "language", ["qwen3:8b"]], ["taskwright-ollama-embedding", "embedding", ["qwen3-embedding:8b"]],
  ]);
  assert.equal(embeddingTarget(ctx())!.url, `${fake.url}/api/embed`);
});

test("迁移时共用文件不能改写（有注释）就什么都不改，说明原因；选定的语言模型所在的模型服务提供的不是语言模型时当作没有选", async () => {
  const mixed = { "taskwright-ollama": oldProvider("本机 ollama", [oldModel("qwen3:8b", "language"), oldModel("bge-m3", "embedding")]) };
  writeOldSettings(mixed);
  const text = '{\n  // 我的注释\n  "providers": {}\n}\n';
  writeFileSync(modelsJson(), text);
  const before = readFileSync(settings, "utf-8");
  await assert.rejects(migrateProviderPurposes(ctx()), (error: any) => error.code === "config_unwritable");
  assert.equal(readFileSync(settings, "utf-8"), before);
  assert.equal(readFileSync(modelsJson(), "utf-8"), text);
  // 第 2 版的设置里，选定的语言模型指着一个嵌入模型的模型服务（手工改坏的文件）：起助手时照没有选过办
  writeFileSync(settings, JSON.stringify({ version: 2, pi_dirs: { [agent]: {
    selection: { language: { provider: "taskwright-ollama-embedding", model: "bge-m3" }, embedding: null },
    providers: { "taskwright-ollama-embedding": { ...oldProvider("嵌入", []), purpose: "embedding", models: [{ id: "bge-m3", enabled: true, context_window: null, context_source: null }] } },
  } } }));
  assert.deepEqual([resolveModel(service.profile).model, resolveModel(service.profile).from], ["fake/fake-model", "启动配置"]);
});
