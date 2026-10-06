/**
 * 知识库按意思查找的接口（POST /api/v1/knowledge/search，src/knowledge_search.ts）：按相近程度排、最多给几个、每个片段带哪些项；
 * 只查给的那几个知识库；文档没有都换算好时不查；没有选嵌入模型、请求写得不对、换算要找的那句话时模型服务出事各怎样回答。
 * 模型服务是共用夹具里的假服务（tests/embedding_stack.ts），不连任何真的模型服务。
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { NOT_SELECTED_TEXT } from "../src/embedding.ts";
import { GENERAL } from "../src/knowledge.ts";
import { LIBRARIES_SHAPE_TEXT, LIMIT_RANGE_TEXT, QUERY_REQUIRED_TEXT } from "../src/knowledge_search.ts";
import { Service } from "../src/service.ts";
import { type Dict, FakeEmbedder, MODEL, RULES, call, chooseEmbedding, isolateSettings, upload } from "./embedding_stack.ts";
import { ROOT, captureConsole, tempDir, within } from "./helpers.ts";

captureConsole();

const SAMPLE = join(ROOT, "examples", "library-lending", "requirements-styled.docx");
let tmp: string;
let agent: string;
let restore: () => void;
let fake: FakeEmbedder;
let n = 0;

before(async () => {
  tmp = tempDir();
  ({ agent, restore } = isolateSettings(tmp));
  fake = await new FakeEmbedder().start();
});
beforeEach(async () => {
  fake.reset();
  await chooseEmbedding(agent, fake.url);
});
after(async () => {
  await fake.stop();
  restore();
  rmSync(tmp, { recursive: true, force: true });
});

function fresh(): Service {
  const root = join(tmp, `case-${++n}`);
  return new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1, knowledgeDir: join(root, "knowledge") });
}
const idle = (service: Service) => within("后台换算收住", 20_000, service.embedder!.idle());
const search = (service: Service, body: Dict) => call(service, "POST", "/api/v1/knowledge/search", body);

test("按相近程度从高到低排，每个片段带知识库、文档、标题、位置、正文与出处的写法；要找的那句话按查询的用途换算，前面加查询前缀", async () => {
  const service = fresh();
  await chooseEmbedding(agent, fake.url, "bge-m3", "查询：");
  await upload(service, "借阅规范.md", RULES);
  await idle(service);
  fake.hits = [];
  const got = await search(service, { query: "  逾期怎样罚款  " });
  assert.equal(got.status, 200, JSON.stringify(got.json));
  assert.deepEqual(Object.keys(got.json), ["ok", "model", "pending", "libraries", "ready", "chunks", "hits"]);
  assert.deepEqual([got.json.ok, got.json.ready, got.json.model, got.json.pending, got.json.libraries, got.json.chunks], [true, true, MODEL, 0, 1, 4]);
  // 只为要找的那句话发了一个请求：首尾的空白去掉，前面直接接上查询前缀。
  assert.deepEqual(fake.hits, [{ model: "bge-m3", input: ["查询：逾期怎样罚款"], truncate: false }]);
  // 只有「罚款」一个词的片段与它最相近；又说罚款又说丢失的次之；与它没有共同的词的排在后面。
  assert.deepEqual(got.json.hits.map((h: Dict) => [h.title, h.score]), [["借阅规范 / 逾期", 1], ["借阅规范 / 丢失", 0.714], ["借阅规范", 0.1961], ["借阅规范 / 预约", 0.0385]]);
  assert.deepEqual(got.json.hits[0], {
    score: 1, library: GENERAL, library_name: "通用知识库", name: "借阅规范.md", kind: "standard", title: "借阅规范 / 逾期",
    first_paragraph: null, last_paragraph: null, first_line: 5, last_line: 5, text: "逾期每册每天罚款 0.5 元。", locator: "knowledge/general/借阅规范.md",
  });
  await service.close();
});

test("最多给几个：不写是 5 个，写了照写的给；Word 文档的片段给的是起止段落号，出处不带段落号", async () => {
  const service = fresh();
  await upload(service, "借阅规范.md", RULES);
  await upload(service, "需求.docx", readFileSync(SAMPLE));
  await idle(service);
  const all = (await search(service, { query: "预约的图书" })).json;
  assert.equal(all.chunks, 15);
  assert.equal(all.hits.length, 5);
  assert.deepEqual(all.hits.map((h: Dict) => h.score), [...all.hits.map((h: Dict) => h.score)].sort((a, b) => b - a));
  assert.equal((await search(service, { query: "预约的图书", limit: 2 })).json.hits.length, 2);
  assert.equal((await search(service, { query: "预约的图书", limit: 10 })).json.hits.length, 10);
  const word = (await search(service, { query: "预约的图书", limit: 10 })).json.hits.find((h: Dict) => h.name === "需求.docx" && h.title === "3.2 预约");
  assert.deepEqual([word.first_paragraph, word.last_paragraph, word.first_line, word.last_line, word.locator], [79, 81, null, null, "knowledge/general/需求.docx"]);
  assert.match(word.text, /预约/);
  await service.close();
});

test("只查给的那几个知识库；清单里没有的编号不算；这几个知识库换算好了就能查，别的知识库没换算好不碍事", async () => {
  const service = fresh();
  const extra = service.knowledge!.create("行业规范").id;
  await upload(service, "借阅规范.md", RULES);
  await idle(service);
  // 另一个知识库里的这一份没有换算成。
  fake.reply = () => ({ status: 500, body: { error: "boom" } });
  await upload(service, "续借办法.txt", "到期前可以续借一次。", extra);
  await idle(service);
  fake.reset();

  const whole = (await search(service, { query: "续借" })).json;
  assert.deepEqual([whole.ready, whole.pending, whole.libraries, whole.hits], [false, 1, 2, []]);
  const other = (await search(service, { query: "续借", libraries: [extra] })).json;
  assert.deepEqual([other.ready, other.pending, other.libraries, other.hits], [false, 1, 1, []]);
  // 没换算好时不为要找的那句话发请求。
  const before = fake.hits.length;
  await search(service, { query: "续借", libraries: [extra] });
  assert.equal(fake.hits.length, before);

  fake.reset();
  const mine = (await search(service, { query: "罚款", libraries: [GENERAL, "lib-没有这个"] })).json;
  assert.deepEqual([mine.ready, mine.pending, mine.libraries, mine.chunks, mine.hits.length], [true, 0, 1, 4, 4]);
  assert.ok(mine.hits.every((h: Dict) => h.library === GENERAL));
  await service.close();
});

test("没有可比的片段：知识库里没有文档，或者文档都没有文字，回 ready 为真与空的结果，不为要找的那句话发请求", async () => {
  const service = fresh();
  assert.deepEqual((await search(service, { query: "罚款" })).json, { ok: true, model: MODEL, pending: 0, libraries: 1, ready: true, chunks: 0, hits: [] });
  assert.equal(fake.hits.length, 0);
  await upload(service, "空白.txt", "  \n\n\t\n");
  await idle(service);
  const got = (await search(service, { query: "罚款" })).json;
  assert.deepEqual([got.ready, got.chunks, got.hits], [true, 0, []]);
  await service.close();
});

test("没有选嵌入模型以 rejected 拒绝；请求写得不对以 bad_request 拒绝", async () => {
  const service = fresh();
  for (const [body, text] of [
    [{}, QUERY_REQUIRED_TEXT], [{ query: "   " }, QUERY_REQUIRED_TEXT], [{ query: 7 }, QUERY_REQUIRED_TEXT],
    [{ query: "罚款", limit: 0 }, LIMIT_RANGE_TEXT], [{ query: "罚款", limit: 11 }, LIMIT_RANGE_TEXT], [{ query: "罚款", limit: 2.5 }, LIMIT_RANGE_TEXT],
    [{ query: "罚款", limit: "3" }, LIMIT_RANGE_TEXT], [{ query: "罚款", libraries: "general" }, LIBRARIES_SHAPE_TEXT], [{ query: "罚款", libraries: [1] }, LIBRARIES_SHAPE_TEXT],
  ] as const) {
    const got = await search(service, body);
    assert.deepEqual([got.status, got.json.error.code, got.json.error.message], [400, "bad_request", text], JSON.stringify(body));
  }
  await chooseEmbedding(agent, fake.url, null);
  const refused = await search(service, { query: "罚款" });
  assert.deepEqual([refused.status, refused.json.error.code, refused.json.error.message], [422, "rejected", NOT_SELECTED_TEXT]);
  assert.equal(fake.hits.length, 0);
  await service.close();
});

test("换算要找的那句话时模型服务出了事：以 embedding_failed 报出去，说明是模型服务给的那一句", async () => {
  const service = fresh();
  await upload(service, "借阅规范.md", RULES);
  await idle(service);
  fake.reply = () => ({ status: 500, body: { error: "model is loading" } });
  const failed = await search(service, { query: "罚款" });
  assert.deepEqual([failed.status, failed.json.ok, failed.json.error.code, failed.json.error.message],
    [502, false, "embedding_failed", "模型服务回答了错误（HTTP 500）：model is loading"]);
  fake.reply = (body) => ({ body: { embeddings: body.input.map(() => [0, 0, 0, 0, 0]) } });
  assert.equal((await search(service, { query: "罚款" })).json.error.message, "模型服务回答的数字串全是 0，没法用。");
  // 回的数字串长度与存着的不一样（模型服务那边换了模型而名字没变）：比不了，没有结果，不出错。
  fake.reply = (body) => ({ body: { embeddings: body.input.map(() => [1, 2, 3]) } });
  const odd = (await search(service, { query: "罚款" })).json;
  assert.deepEqual([odd.ready, odd.chunks, odd.hits], [true, 0, []]);
  await service.close();
});
