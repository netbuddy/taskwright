/**
 * 知识库文档的后台换算（src/knowledge_embedder.ts）与它的三个接口：GET /api/v1/knowledge 里的换算状态、POST /api/v1/knowledge/embed、
 * GET /api/v1/tasks/{task}/knowledge 里的 embedding。模型服务是本文件里起的一个假服务（ollama 的接口），每一例自己定它怎样回答；
 * pi 的配置目录与产品设置文件都在临时目录里，不连任何真的模型服务。
 *
 * 各例：上传之后自动换算；没有选嵌入模型时不换算；换了嵌入模型之后全部重新换算；一份文档没算成时整份作废、别的照算、可以重试；
 * 与文档无关的失败让整个换算停下；服务重启之后正在算的回到未换算；删除文档与知识库时放下手上的；同一时间只发一个请求；算到一半换了模型。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { KEY_REJECTED_TEXT, NOT_SELECTED_TEXT, UNREACHABLE_TEXT } from "../src/embedding.ts";
import { dispatch } from "../src/http.ts";
import { GENERAL } from "../src/knowledge.ts";
import { ZERO_VECTOR_TEXT } from "../src/knowledge_embedder.ts";
import { EMBEDDINGS_SUFFIX, readEmbeddings, readHead } from "../src/knowledge_embeddings.ts";
import { type StoredProvider, updatePiDirSettings } from "../src/product_settings.ts";
import { Service } from "../src/service.ts";
import { ROOT, captureConsole, tempDir, within } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
type Reply = { status?: number; body: unknown; delay?: number };

const PROVIDER = "taskwright-ollama";
const MODEL = `${PROVIDER}/bge-m3`;
const OTHER = `${PROVIDER}/另一个模型`;
const SAMPLE = join(ROOT, "examples", "library-lending", "requirements-styled.docx");

/** 每段文字回一条三个数的数字串：第一个数是这段文字的字数，看得出哪一条对着哪一段。 */
const vectorOf = (text: string) => [Array.from(text).length, 1, 2];
const fine = (body: Dict): Reply => ({ body: { model: body.model, embeddings: body.input.map(vectorOf) } });

/**
 * 假的嵌入服务：记下收到的每个请求体，回答由各例设置；peak 是同一时刻最多有几个请求还没有回答。
 * 计数每一例重新开始（reset）：上一例里被取消的请求什么时候算结束，各系统上不一样，不让它串到下一例里去。
 * 所以 peak 只在没有取消过请求的例里看。
 */
class FakeEmbedder {
  reply: (body: Dict) => Reply = fine;
  hits: Dict[] = [];
  active = 0;
  peak = 0;
  server!: Server;
  port = 0;
  private timers = new Set<NodeJS.Timeout>();
  private round = 0;
  async start(): Promise<this> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        this.hits.push(body);
        const round = this.round;
        this.peak = Math.max(this.peak, ++this.active);
        const answer = this.reply(body);
        /** 这个请求结束了（回答了，或者对方先断开了）：只算一次，上一例留下的不算进这一例。 */
        const settle = () => {
          if (!this.timers.delete(timer)) return false;
          clearTimeout(timer);
          if (round === this.round) this.active--;
          return true;
        };
        const timer: NodeJS.Timeout = setTimeout(() => {
          if (!settle()) return;
          res.writeHead(answer.status ?? 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(answer.body));
        }, answer.delay ?? 0);
        this.timers.add(timer);
        res.on("close", settle);
      });
    });
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  reset(): void {
    this.reply = fine;
    this.hits = [];
    this.round++;
    this.active = 0;
    this.peak = 0;
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
let n = 0;

before(async () => {
  tmp = tempDir();
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  agent = join(tmp, "pi-agent");
  mkdirSync(agent);
  writeFileSync(join(agent, "auth.json"), "{}");
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.TASKWRIGHT_SETTINGS_FILE = join(tmp, "settings", "settings.json");
  fake = await new FakeEmbedder().start();
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((ok) => probe.close(() => ok()));
});
beforeEach(async () => {
  fake.reset();
  await chooseEmbedding();
});
after(async () => {
  await fake.stop();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * 本文件造模型设置只在这一个函数里：登记一个 ollama 种类、提供嵌入模型的模型服务（两个模型都勾上），选定其中一个；model 是 null 时不选嵌入模型。
 * base 是模型服务的地址，不给时是假服务。
 */
async function chooseEmbedding(model: string | null = "bge-m3", options: { base?: string; prefix?: string } = {}): Promise<void> {
  const provider: StoredProvider = {
    kind: "ollama", purpose: "embedding", name: "测试用的 ollama", base_url: options.base ?? fake.url, models_fetched_at: null, status: null,
    models: ["bge-m3", "另一个模型"].map((id) => ({ id, enabled: true, context_window: null, context_source: null })),
  };
  await updatePiDirSettings(agent, (dir) => {
    dir.providers = { [PROVIDER]: provider };
    dir.selection.embedding = model === null ? null : { provider: PROVIDER, model, query_prefix: options.prefix ?? "" };
  });
}

function fresh(root = join(tmp, `case-${++n}`)): Service {
  return new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1, knowledgeDir: join(root, "knowledge") });
}

async function call(service: Service, method: string, path: string, body: Dict | Buffer | null = null, headers: Dict = {}) {
  const raw = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const reply = (await dispatch(service, { method, path, query: {}, headers, body: raw, remote: "127.0.0.1" })) as Dict;
  return { status: reply.status as number, json: JSON.parse(reply.body.toString("utf-8")) as Dict };
}

/** 经上传接口放一份文档进知识库（缺省是通用知识库）。 */
async function upload(service: Service, name: string, data: Buffer | string, library = GENERAL) {
  const head = Buffer.from(`--B\r\nContent-Disposition: form-data; name="kind"\r\n\r\nstandard\r\n--B\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const body = Buffer.concat([head, Buffer.isBuffer(data) ? data : Buffer.from(data), Buffer.from("\r\n--B--\r\n")]);
  const done = await call(service, "POST", `/api/v1/knowledge/libraries/${library}/documents`, body, { "content-type": "multipart/form-data; boundary=B" });
  assert.equal(done.status, 200, JSON.stringify(done.json));
}

const overview = async (service: Service) => (await call(service, "GET", "/api/v1/knowledge")).json;
/** 各份文档的状态，写成「文档名: 状态」好比较；library 不给时是通用知识库。 */
async function statuses(service: Service, library = GENERAL): Promise<Dict> {
  const lib = (await overview(service)).libraries.find((l: Dict) => l.id === library);
  return Object.fromEntries(lib.documents.map((d: Dict) => [d.name, d.embedding.status]));
}
const idle = (service: Service) => within("后台换算收住", 20_000, service.embedder!.idle());
async function until(what: string, ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`等${what}超过 10 秒，没有等到。`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const filesOf = (service: Service, library = GENERAL) => readdirSync(service.knowledge!.filesDir(library)).sort();

/** 一份切出来正好 40 个片段的纯文本：40 段，每段 500 个字，两段接起来就超过上限。 */
const LONG = Array.from({ length: 40 }, (_, i) => `第${String(i + 1).padStart(2, "0")}段` + "文".repeat(496)).join("\n\n");
const RULES = `# 退款\n\n七天之内可以退款。\n\n${"读者凭借书证借书。".repeat(200)}\n\n## 时限\n\n收到货之日起算。\n`;

test("上传之后自动换算：文档依次是换算中、等待换算、已换算；片段分批送去，一批不超过 32 段，送去的是标题一行加正文；没有文字的文档不发请求；数字串缩放成长度 1 存到文档旁边", async () => {
  const service = fresh();
  fake.reply = (body) => ({ ...fine(body), delay: 250 });
  await upload(service, "规则.md", RULES);
  await upload(service, "需求.docx", readFileSync(SAMPLE));
  // 第一份已经在算（切好了、还没有拿回来），第二份排着队。
  const during = await overview(service);
  assert.deepEqual(during.libraries[0].documents.map((d: Dict) => d.embedding), [
    { status: "running", model: MODEL, error: null, done: 0, total: 5 },
    { status: "queued", model: null, error: null, done: null, total: null },
  ]);
  assert.deepEqual(during.embedding, { model: MODEL, running: true, ready: false, pending: 2, total: 2, stopped_reason: null });
  assert.deepEqual(during.libraries[0].embedding, { done: 0, total: 2 });
  await upload(service, "空白.txt", "  \n\n\t\n");
  await upload(service, "长文.txt", LONG);
  await idle(service);

  const after = await overview(service);
  assert.deepEqual(after.libraries[0].documents.map((d: Dict) => [d.name, d.embedding]), [
    ["规则.md", { status: "done", model: MODEL, error: null, done: 5, total: 5 }],
    ["需求.docx", { status: "done", model: MODEL, error: null, done: 11, total: 11 }],
    ["空白.txt", { status: "done", model: MODEL, error: null, done: 0, total: 0 }],
    ["长文.txt", { status: "done", model: MODEL, error: null, done: 40, total: 40 }],
  ]);
  assert.deepEqual(after.embedding, { model: MODEL, running: false, ready: true, pending: 0, total: 4, stopped_reason: null });
  assert.deepEqual(after.libraries[0].embedding, { done: 4, total: 4 });
  // 文档清单里别的项照旧。
  assert.deepEqual(Object.keys(after.libraries[0].documents[0]), ["name", "kind", "bytes", "uploaded_at", "embedding"]);

  // 按文档的先后算；空白的那一份不发请求；40 个片段分成 32 加 8 两批；请求体带 truncate: false。
  assert.deepEqual(fake.hits.map((h) => [h.model, h.truncate, h.input.length]), [["bge-m3", false, 5], ["bge-m3", false, 11], ["bge-m3", false, 32], ["bge-m3", false, 8]]);
  assert.equal(fake.peak, 1);
  const sent: string[] = fake.hits[0].input;
  assert.equal(sent[0], "退款\n七天之内可以退款。");
  assert.equal(sent[4], "退款 / 时限\n收到货之日起算。");
  for (const text of sent.slice(1, 4)) {
    assert.ok(text.startsWith("退款\n读者凭借书证借书。"));
    assert.ok(Array.from(text).length <= 800 + 3);
  }
  assert.ok(fake.hits[1].input[1].startsWith("1 概述\n概述\n我们学校图书馆"));

  // 成品在文档旁边：片段与送去的对得上，数字串的长度是 1。
  const path = service.knowledge!.filePath(GENERAL, "规则.md");
  const stored = readEmbeddings(path)!;
  assert.deepEqual([stored.head.model, stored.head.dimensions, stored.chunks.length], [MODEL, 3, 5]);
  assert.deepEqual(stored.chunks.map((c) => [c.heading, c.first_line, c.last_line]), [["退款", 3, 3], ["退款", 5, 5], ["退款", 5, 5], ["退款", 5, 5], ["退款 / 时限", 9, 9]]);
  const first = Array.from(stored.vectors.subarray(0, 3));
  const norm = Math.hypot(12, 1, 2);
  assert.deepEqual(first.map((x) => Math.round(x * 1e5)), [12, 1, 2].map((x) => Math.round((x / norm) * 1e5)));
  assert.equal(readEmbeddings(service.knowledge!.filePath(GENERAL, "需求.docx"))!.chunks[1].first_paragraph, 6);
  assert.deepEqual(filesOf(service).filter((name) => name.includes(".embeddings.")).length, 8);

  // 任务这一侧：按任务选用的知识库算。
  const task = service.task(service.create({ task_type: "srs-authoring", task_name: "任务" }).task_id);
  assert.deepEqual((await call(service, "GET", `/api/v1/tasks/${task.taskId}/knowledge`)).json, { ok: true, libraries: [GENERAL], embedding: { model: MODEL, ready: true, pending: 0 } });
  await service.close();
});

test("没有选嵌入模型：上传的文档是未换算，不发请求；开始换算的接口以 rejected 拒绝；任务这一侧说还没有准备好", async () => {
  await chooseEmbedding(null);
  const service = fresh();
  await upload(service, "规则.md", RULES);
  await idle(service);
  assert.deepEqual(await statuses(service), { "规则.md": "none" });
  assert.deepEqual((await overview(service)).embedding, { model: null, running: false, ready: false, pending: 1, total: 1, stopped_reason: null });
  const refused = await call(service, "POST", "/api/v1/knowledge/embed", {});
  assert.deepEqual([refused.status, refused.json.error.code, refused.json.error.message], [422, "rejected", NOT_SELECTED_TEXT]);
  const task = service.task(service.create({ task_type: "srs-authoring", task_name: "任务" }).task_id);
  assert.deepEqual((await call(service, "GET", `/api/v1/tasks/${task.taskId}/knowledge`)).json.embedding, { model: null, ready: false, pending: 1 });
  assert.equal(fake.hits.length, 0);
  // 选了之后，这份文档经开始换算的接口算出来；范围写错的请求被拒绝。
  await chooseEmbedding();
  assert.deepEqual(await statuses(service), { "规则.md": "none" });
  assert.equal((await call(service, "POST", "/api/v1/knowledge/embed", { name: "规则.md" })).json.error.code, "bad_request");
  assert.equal((await call(service, "POST", "/api/v1/knowledge/embed", { library: 7 })).json.error.code, "bad_request");
  assert.equal((await call(service, "POST", "/api/v1/knowledge/embed", { library: "lib-没有" })).status, 404);
  assert.equal((await call(service, "POST", "/api/v1/knowledge/embed", { library: GENERAL, name: "没有.md" })).status, 404);
  const started = await call(service, "POST", "/api/v1/knowledge/embed");
  assert.deepEqual([started.json.ok, started.json.queued, started.json.embedding.running], [true, 1, true]);
  await idle(service);
  assert.deepEqual(await statuses(service), { "规则.md": "done" });
  await service.close();
});

test("换了嵌入模型：原来换算好的全都回到未换算，开始换算之后用新的模型全部重算，成品换成新的；只改查询前缀不用重算", async () => {
  const service = fresh();
  const extra = service.knowledge!.create("行业规范").id;
  await upload(service, "规则.md", RULES);
  await upload(service, "说明.txt", "退货要保留包装。", extra);
  await idle(service);
  assert.deepEqual([await statuses(service), await statuses(service, extra)], [{ "规则.md": "done" }, { "说明.txt": "done" }]);
  // 只改查询前缀：文档不加前缀，照旧算换算好了。
  await chooseEmbedding("bge-m3", { prefix: "Instruct: 找相关段落\nQuery:" });
  assert.equal((await overview(service)).embedding.ready, true);

  await chooseEmbedding("另一个模型");
  const changed = await overview(service);
  assert.deepEqual(changed.embedding, { model: OTHER, running: false, ready: false, pending: 2, total: 2, stopped_reason: null });
  // 状态是未换算；旁边还留着用原来的模型算的成品，model 写的是它。
  assert.deepEqual(changed.libraries.map((l: Dict) => l.documents[0].embedding), Array(2).fill({ status: "none", model: MODEL, error: null, done: null, total: null }));
  fake.hits = [];
  assert.equal((await call(service, "POST", "/api/v1/knowledge/embed", {})).json.queued, 2);
  await idle(service);
  assert.deepEqual(fake.hits.map((h) => [h.model, h.input.length]), [["另一个模型", 5], ["另一个模型", 1]]);
  assert.deepEqual([await statuses(service), await statuses(service, extra)], [{ "规则.md": "done" }, { "说明.txt": "done" }]);
  assert.equal(readHead(service.knowledge!.filePath(GENERAL, "规则.md"))!.model, OTHER);
  assert.equal((await overview(service)).embedding.ready, true);
  // 都换算好了再点一次：没有要排的，不发请求。
  fake.hits = [];
  assert.equal((await call(service, "POST", "/api/v1/knowledge/embed", {})).json.queued, 0);
  await idle(service);
  assert.equal(fake.hits.length, 0);
  // 只换算一个知识库：别的知识库不动。
  await chooseEmbedding("bge-m3");
  assert.equal((await call(service, "POST", "/api/v1/knowledge/embed", { library: extra })).json.queued, 1);
  await idle(service);
  assert.deepEqual([await statuses(service), await statuses(service, extra)], [{ "规则.md": "none" }, { "说明.txt": "done" }]);
  await service.close();
});

test("一份文档没算成：整份作废，旁边什么都不留下，状态是换算失败带模型服务的原话；别的文档照算；重试之后算成", async () => {
  const service = fresh();
  // 送 8 段去的那一个请求（长文靠后的 8 个片段）回答错误，像文字超过了模型一次能收的长度。
  fake.reply = (body) => (body.input.length === 8 ? { status: 500, body: { error: "the input length exceeds the context length" } } : fine(body));
  await upload(service, "长文.txt", LONG);
  await upload(service, "规则.md", RULES);
  await idle(service);
  const got = await overview(service);
  const reason = "模型服务回答了错误（HTTP 500）：the input length exceeds the context length";
  assert.deepEqual(got.libraries[0].documents.map((d: Dict) => d.embedding), [
    { status: "failed", model: MODEL, error: reason, done: null, total: null },
    { status: "done", model: MODEL, error: null, done: 5, total: 5 },
  ]);
  assert.deepEqual(got.embedding, { model: MODEL, running: false, ready: false, pending: 1, total: 2, stopped_reason: null });
  assert.deepEqual(got.libraries[0].embedding, { done: 1, total: 2 });
  assert.deepEqual(filesOf(service), ["规则.md", "规则.md.embeddings.bin", "规则.md.embeddings.json", "长文.txt"].sort());

  // 重试这一份：这一回模型服务回的数字串全是 0，还是没算成，原因换成新的。
  fake.reply = (body) => ({ body: { embeddings: body.input.map(() => [0, 0, 0]) } });
  assert.equal((await call(service, "POST", "/api/v1/knowledge/embed", { library: GENERAL, name: "长文.txt" })).json.queued, 1);
  await idle(service);
  assert.deepEqual((await overview(service)).libraries[0].documents[0].embedding, { status: "failed", model: MODEL, error: ZERO_VECTOR_TEXT, done: null, total: null });
  assert.equal(existsSync(service.knowledge!.filePath(GENERAL, "长文.txt") + EMBEDDINGS_SUFFIX), false);

  fake.reply = fine;
  assert.equal((await call(service, "POST", "/api/v1/knowledge/embed", { library: GENERAL, name: "长文.txt" })).json.queued, 1);
  await idle(service);
  assert.deepEqual(await statuses(service), { "长文.txt": "done", "规则.md": "done" });
  assert.equal((await overview(service)).embedding.ready, true);
  await service.close();
});

test("与文档无关的失败：连不上或者密钥被拒绝时整个换算停下，原因写在 stopped_reason 里，文档都是未换算而不是换算失败；再开始时原因清掉", async () => {
  const service = fresh();
  await chooseEmbedding("bge-m3", { base: `http://127.0.0.1:${closedPort}` });
  await upload(service, "规则.md", RULES);
  await upload(service, "说明.txt", "退货要保留包装。");
  await idle(service);
  assert.deepEqual(await statuses(service), { "规则.md": "none", "说明.txt": "none" });
  assert.deepEqual((await overview(service)).embedding, { model: MODEL, running: false, ready: false, pending: 2, total: 2, stopped_reason: UNREACHABLE_TEXT });

  // 模型服务连上了，但是拒绝密钥：只试了一次就停下，没有挨个文档去试。
  await chooseEmbedding();
  fake.reply = () => ({ status: 401, body: { error: "unauthorized" } });
  assert.equal((await call(service, "POST", "/api/v1/knowledge/embed", {})).json.embedding.stopped_reason, null);
  await idle(service);
  assert.equal(fake.hits.length, 1);
  assert.deepEqual(await statuses(service), { "规则.md": "none", "说明.txt": "none" });
  assert.equal((await overview(service)).embedding.stopped_reason, KEY_REJECTED_TEXT);

  fake.reply = fine;
  assert.equal((await call(service, "POST", "/api/v1/knowledge/embed", {})).json.queued, 2);
  await idle(service);
  assert.deepEqual((await overview(service)).embedding, { model: MODEL, running: false, ready: true, pending: 0, total: 2, stopped_reason: null });
  await service.close();
});

test("服务重启：停止时手上的请求立刻放下，正在算的与排着队的都回到未换算，旁边不留半成品；再起的服务不自动换算", async () => {
  const root = join(tmp, `case-${++n}`);
  const service = fresh(root);
  fake.reply = (body) => ({ ...fine(body), delay: 5000 });
  await upload(service, "长文.txt", LONG);
  await upload(service, "规则.md", RULES);
  await until("头一个请求发出", () => fake.hits.length === 1);
  assert.deepEqual(await statuses(service), { "长文.txt": "running", "规则.md": "queued" });
  const started = Date.now();
  await service.close();
  assert.ok(Date.now() - started < 2000, "停止服务不应当等模型服务回答");

  const again = fresh(root);
  assert.deepEqual(await statuses(again), { "长文.txt": "none", "规则.md": "none" });
  assert.deepEqual((await overview(again)).embedding, { model: MODEL, running: false, ready: false, pending: 2, total: 2, stopped_reason: null });
  assert.deepEqual(filesOf(again), ["规则.md", "长文.txt"].sort());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fake.hits.length, 1, "停止之后与再起之后都不应当再发请求");
  await again.close();
});

test("删除：正在换算的文档被删除时放下手上的请求、不留下数字串，队里别的照算；删除知识库时它的文档不再算", async () => {
  const service = fresh();
  fake.reply = (body) => ({ ...fine(body), delay: 150 });
  await upload(service, "甲.md", "# 甲\n\n第一份。");
  await upload(service, "乙.md", "# 乙\n\n第二份。");
  await until("第一份的请求发出", () => fake.hits.length === 1);
  assert.deepEqual((await call(service, "POST", `/api/v1/knowledge/libraries/${GENERAL}/documents/delete`, { name: "甲.md" })).json, { ok: true });
  await idle(service);
  assert.deepEqual(await statuses(service), { "乙.md": "done" });
  assert.deepEqual(filesOf(service), ["乙.md", "乙.md.embeddings.bin", "乙.md.embeddings.json"]);
  assert.deepEqual(fake.hits.map((h) => h.input), [["甲\n第一份。"], ["乙\n第二份。"]]);

  const extra = service.knowledge!.create("临时的").id;
  await upload(service, "丙.md", "第三份。", extra);
  await upload(service, "丁.md", "第四份。", extra);
  await until("丙的请求发出", () => fake.hits.length === 3);
  assert.equal((await call(service, "POST", `/api/v1/knowledge/libraries/${extra}/delete`)).status, 200);
  await idle(service);
  assert.equal(existsSync(join(service.knowledge!.root, extra)), false);
  assert.equal(fake.hits.length, 3, "丁不应当再算");
  assert.deepEqual((await overview(service)).embedding, { model: MODEL, running: false, ready: true, pending: 0, total: 1, stopped_reason: null });
  await service.close();
});

test("同一时间只发一个请求：连着点两次开始换算，第二次不重复排；每份文档只算一遍，按知识库、按文档的先后算", async () => {
  await chooseEmbedding(null);
  const service = fresh();
  const extra = service.knowledge!.create("行业规范").id;
  await upload(service, "丙.txt", "第三份。", extra);
  await upload(service, "乙.txt", "第二份。");
  await upload(service, "甲.txt", "第一份。");
  await upload(service, "丁.txt", "第四份。", extra);
  await chooseEmbedding();
  fake.reply = (body) => ({ ...fine(body), delay: 20 });
  const [one, two] = await Promise.all([call(service, "POST", "/api/v1/knowledge/embed", {}), call(service, "POST", "/api/v1/knowledge/embed", {})]);
  assert.deepEqual([one.json.queued, two.json.queued], [4, 0]);
  await until("第二份的请求发出", () => fake.hits.length === 2);
  assert.equal((await call(service, "POST", "/api/v1/knowledge/embed", {})).json.queued, 0);
  await idle(service);
  assert.equal(fake.peak, 1);
  // 通用知识库在前，库里按上传的先后。
  assert.deepEqual(fake.hits.map((h) => h.input), [["第二份。"], ["第一份。"], ["第三份。"], ["第四份。"]]);
  assert.equal((await overview(service)).embedding.ready, true);
  await service.close();
});

test("算到一半换了嵌入模型：这一份作废，按新的模型从头重算，成品是新模型的", async () => {
  const service = fresh();
  fake.reply = (body) => ({ ...fine(body), delay: 120 });
  await upload(service, "长文.txt", LONG);
  await until("头一个请求发出", () => fake.hits.length === 1);
  await chooseEmbedding("另一个模型");
  await idle(service);
  // 头一个请求是旧模型的；后一个请求发出去时已经是新模型，拿回来发现对不上，整份重来：新模型的两个请求。
  assert.deepEqual(fake.hits.map((h) => [h.model, h.input.length]), [["bge-m3", 32], ["另一个模型", 8], ["另一个模型", 32], ["另一个模型", 8]]);
  const head = readHead(service.knowledge!.filePath(GENERAL, "长文.txt"))!;
  assert.deepEqual([head.model, head.chunks], [OTHER, 40]);
  assert.deepEqual(await statuses(service), { "长文.txt": "done" });
  await service.close();
});
