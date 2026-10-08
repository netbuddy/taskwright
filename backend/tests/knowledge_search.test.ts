/**
 * 知识库查找接口（src/knowledge_search.ts）：按意思与按字面两路并行；取哪几个（候选与保底）；按意思那一路做不了时退到只按字面
 * （没有选嵌入模型、有的文档没有换算好、换算要找的那句话时出了事、文档读不出来），调用的一方取消时不退化；请求写得不对时拒绝。
 * 嵌入服务是进程内的假服务（embedding_stack.ts）：数字串由文字里有没有「罚款」「预约」「续借」「丢失」四个词决定。
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync, truncateSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { GENERAL } from "../src/knowledge.ts";
import { projectionParagraphs } from "../../agent/src/lib/docx_source.ts";
import { ApiError } from "../src/errors.ts";
import { dispatch } from "../src/http.ts";
import { EMBEDDINGS_SUFFIX, VECTORS_SUFFIX } from "../src/knowledge_embeddings.ts";
import { CANCELLED_TEXT, KEYWORD_KEEP, LIBRARIES_SHAPE_TEXT, LIMIT_RANGE_TEXT, QUERY_REQUIRED_TEXT, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, combine } from "../src/knowledge_search.ts";
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

const KEYS = ["ok", "mode", "reason", "model", "ready", "pending", "libraries", "documents", "chunks", "uncovered_semantic", "uncovered", "hits", "candidates", "timing"];
const titles = (json: Dict) => json.hits.map((h: Dict) => h.title);
const ranks = (json: Dict) => json.hits.map((h: Dict) => [h.title, h.rank_semantic, h.rank_keyword]);

test("两路都做：每个片段带它在两路里各排第几、知识库、文档、标题、位置、文字与出处的写法；要找的那句话按查询的用途换算，前面加查询前缀", async () => {
  const service = fresh();
  await chooseEmbedding(agent, fake.url, "bge-m3", "查询：");
  await upload(service, "借阅规范.md", RULES);
  await idle(service);
  fake.hits = [];
  const got = await search(service, { query: "  逾期怎样罚款  " });
  assert.equal(got.status, 200, JSON.stringify(got.json));
  assert.deepEqual(Object.keys(got.json), KEYS);
  assert.deepEqual([got.json.ok, got.json.mode, got.json.reason, got.json.model, got.json.ready, got.json.pending, got.json.libraries, got.json.documents, got.json.chunks],
    [true, "hybrid", null, MODEL, true, 0, 1, 1, 4]);
  assert.deepEqual([got.json.uncovered_semantic, got.json.uncovered], [[], []]);
  // 只为要找的那句话发了一个请求：首尾的空白去掉，前面直接接上查询前缀。
  assert.deepEqual(fake.hits, [{ model: "bge-m3", input: ["查询：逾期怎样罚款"], truncate: false }]);
  // 不写 limit 是 3 个。按意思：只有「罚款」一个词的片段最相近，又说罚款又说丢失的次之。按字面：「逾期」「罚款」都在的排第 1，只有「罚款」的排第 2。
  assert.equal(SEARCH_DEFAULT_LIMIT, 3);
  assert.deepEqual(got.json.hits.map((h: Dict) => [h.title, h.score, h.rank_semantic, h.rank_keyword]),
    [["借阅规范 / 逾期", 1, 1, 1], ["借阅规范 / 丢失", 0.714, 2, 2], ["借阅规范", 0.1961, 3, null]]);
  assert.deepEqual(got.json.hits[0], {
    score: 1, score_kind: "semantic", rank_semantic: 1, rank_keyword: 1,
    library: GENERAL, library_name: "通用知识库", name: "借阅规范.md", kind: "standard", index: 2, title: "借阅规范 / 逾期", block: 2,
    first_paragraph: null, last_paragraph: null, first_line: 5, last_line: 5, partial: false, text: "逾期每册每天罚款 0.5 元。", locator: "knowledge/general/借阅规范.md",
    body: "逾期每册每天罚款 0.5 元。", paragraphs: null, table: null, header: null, exact: true,
  });
  // 各阶段的耗时都记了，是不小于 0 的数。
  assert.deepEqual(Object.keys(got.json.timing), ["embed_query", "read_derived", "read_source", "chunk_now", "vector_compare", "tokenize", "keyword_score"]);
  assert.ok(Object.values(got.json.timing).every((ms) => typeof ms === "number" && ms >= 0));
  await service.close();
});

/**
 * 六个小节：前四个都说「罚款」（按意思与「罚款」由近到远），后两个是条文。要找的话又说罚款又说第 8 条：
 * 按意思的先后是 一、二、三、四、五、六；按字面是 五（条号与原话都对上）、六（「第」「条」对上）、然后才是说罚款的几个
 * （其中「二」最短，排在「一」前面）。
 */
const SIX = ["# 一\n\n罚款按日计算。", "# 二\n\n罚款与续借。", "# 三\n\n罚款、续借与预约。", "# 四\n\n罚款、续借、预约与丢失。",
  "# 五\n\n第 8 条 寄回期限是七天。", "# 六\n\n第 9 条 验收时限是三天。"].join("\n\n") + "\n";
const ASK = "罚款 第8条 寄回期限";

test("取哪几个：按意思的前 limit 名是候选，按字面的前 2 名替换候选里按意思排名最末的；按意思第 1 名永不被替换，limit 为 1 时不替换；limit 为 1、2、3、5 各一例", async () => {
  const service = fresh();
  await upload(service, "规定.md", SIX);
  await idle(service);
  const at = async (limit: number) => (await search(service, { query: ASK, limit })).json;
  // 两路各自的先后（limit 5 时看得全）。
  const five = await at(5);
  assert.equal(five.mode, "hybrid");
  assert.deepEqual(ranks(five), [["一", 1, 4], ["二", 2, 3], ["三", 3, 5], ["五", 5, 1], ["六", 6, 2]]);
  // limit 1：只有按意思第 1 名，按字面第 1 名不进来。
  const one = await at(1);
  assert.deepEqual(titles(one), ["一"]);
  // 响应另记取结果之前考虑过的片段：按意思的前 limit 名与按字面的前 2 名。「五」进了候选（按字面第 1 名）却没有进结果。
  assert.deepEqual(one.candidates, { semantic: [{ library: GENERAL, name: "规定.md", index: 1 }], keyword: [{ library: GENERAL, name: "规定.md", index: 5 }, { library: GENERAL, name: "规定.md", index: 6 }] });
  assert.deepEqual(five.candidates.semantic.map((c: Dict) => c.index), [1, 2, 3, 4, 5]);
  // limit 2：按字面第 1 名替换按意思第 2 名；按字面第 2 名没有位置可换（剩下的只有按意思第 1 名）。
  assert.deepEqual(titles(await at(2)), ["一", "五"]);
  // limit 3：按字面前 2 名替换按意思的第 3、第 2 名；被替换进来的按字面名次排在最后。
  assert.deepEqual(titles(await at(3)), ["一", "五", "六"]);
  assert.deepEqual(titles(await search(service, { query: ASK }).then((r) => r.json)), ["一", "五", "六"]);
  // limit 5：按字面第 1 名本来就在候选里，第 2 名替换候选里排名最末、又不是按字面保底的那一个（四）。
  assert.deepEqual(titles(five), ["一", "二", "三", "五", "六"]);
  // 被替换进来的片段分数仍是按意思的相近程度。
  assert.ok(five.hits.every((h: Dict) => h.score_kind === "semantic"));
  await service.close();
});

test("取哪几个（只算规则）：候选不满 limit 个时直接补上；按字面没有命中时就是按意思的前 limit 名；按意思没有比过时只按字面", () => {
  assert.equal(KEYWORD_KEEP, 2);
  assert.deepEqual(combine([0, 1, 2, 3], [], 3), [0, 1, 2]);
  assert.deepEqual(combine([], [5, 6, 7, 8], 3), [5, 6, 7]);
  assert.deepEqual(combine([0, 1], [7, 8, 9], 5), [0, 1, 7, 8]);
  assert.deepEqual(combine([0, 1, 2], [0, 1], 3), [0, 1, 2]);
  assert.deepEqual(combine([0, 1, 2], [9, 8, 7], 1), [0]);
  assert.deepEqual(combine([0, 1, 2], [9, 8, 7], 2), [0, 9]);
  assert.deepEqual(combine([0, 1, 2], [9, 8, 7], 3), [0, 9, 8]);
  // 按字面的第 1 名就是按意思的第 2 名：它留在原位，第 2 名替换第 3 名。
  assert.deepEqual(combine([0, 1, 2], [1, 9], 3), [0, 1, 9]);
  // 保底名次可以改（离线比较用）。
  assert.deepEqual(combine([0, 1, 2, 3], [9, 8, 7], 4, 3), [0, 9, 8, 7]);
  assert.deepEqual(combine([0, 1, 2, 3], [9, 8, 7], 4, 1), [0, 1, 2, 9]);
});

test("最多 5 个；Word 文档的片段给的是起止段落号与块的编号，出处不带段落号", async () => {
  const service = fresh();
  await upload(service, "借阅规范.md", RULES);
  await upload(service, "需求.docx", readFileSync(SAMPLE));
  await idle(service);
  const all = (await search(service, { query: "预约的图书", limit: SEARCH_MAX_LIMIT })).json;
  assert.deepEqual([SEARCH_MAX_LIMIT, all.chunks, all.documents, all.hits.length], [5, 15, 2, 5]);
  const word = all.hits.find((h: Dict) => h.name === "需求.docx" && h.title === "3.2 预约");
  assert.deepEqual([word.first_paragraph, word.last_paragraph, word.first_line, word.last_line, word.locator, word.partial], [79, 81, null, null, "knowledge/general/需求.docx", false]);
  assert.ok(Number.isInteger(word.block) && word.block >= 1);
  assert.match(word.text, /预约/);
  await service.close();
});

test("只查给的那几个知识库；清单里没有的编号不算", async () => {
  const service = fresh();
  const extra = service.knowledge!.create("行业规范").id;
  await upload(service, "借阅规范.md", RULES);
  await upload(service, "续借办法.txt", "到期前可以续借一次。", extra);
  await idle(service);
  const mine = (await search(service, { query: "续借", libraries: [GENERAL, "lib-没有这个"] })).json;
  assert.deepEqual([mine.libraries, mine.documents, mine.chunks], [1, 1, 4]);
  assert.ok(mine.hits.every((h: Dict) => h.library === GENERAL));
  const other = (await search(service, { query: "续借", libraries: [extra] })).json;
  assert.deepEqual([other.libraries, other.chunks, other.hits.map((h: Dict) => h.name)], [1, 1, ["续借办法.txt"]]);
  assert.equal((await search(service, { query: "续借" })).json.libraries, 2);
  await service.close();
});

test("没有可比的片段：知识库里没有文档，或者文档都没有文字，回空的结果，不为要找的那句话发请求", async () => {
  const service = fresh();
  const empty = (await search(service, { query: "罚款" })).json;
  assert.deepEqual([empty.mode, empty.reason, empty.ready, empty.documents, empty.chunks, empty.hits], ["hybrid", null, true, 0, 0, []]);
  assert.equal(fake.hits.length, 0);
  await upload(service, "空白.txt", "  \n\n\t\n");
  await idle(service);
  fake.hits = [];
  const got = (await search(service, { query: "罚款" })).json;
  assert.deepEqual([got.mode, got.ready, got.documents, got.chunks, got.hits, got.uncovered_semantic], ["hybrid", true, 1, 0, [], []]);
  await service.close();
});

test("退化一：没有选嵌入模型不再拒绝，只按字面找；不向模型服务发请求", async () => {
  const service = fresh();
  await chooseEmbedding(agent, fake.url, null);
  await upload(service, "规定.md", SIX);
  const got = await search(service, { query: ASK });
  assert.equal(got.status, 200);
  assert.deepEqual([got.json.mode, got.json.reason, got.json.model, got.json.ready, got.json.pending, got.json.documents, got.json.chunks], ["keyword", "not_selected", null, false, 1, 1, 6]);
  // 只按字面的先后；分数是按字面的得分，没有按意思的名次。全部文档都只按字面，所以不另列。
  assert.deepEqual(ranks(got.json), [["五", null, 1], ["六", null, 2], ["二", null, 3]]);
  assert.ok(got.json.hits.every((h: Dict) => h.score_kind === "keyword" && h.score > 0));
  assert.deepEqual([got.json.uncovered_semantic, got.json.uncovered], [[], []]);
  assert.equal(fake.hits.length, 0);
  // 按字面一个词都对不上：没有结果，不出错。
  assert.deepEqual((await search(service, { query: "xyz" })).json.hits, []);
  await service.close();
});

test("退化二：有的文档还没有换算好，对它只按字面找，别的文档两路都做；响应列出这些文档；一份都没有换算好时不为要找的那句话发请求", async () => {
  const service = fresh();
  await upload(service, "借阅规范.md", RULES);
  await idle(service);
  // 这一份没有换算成。
  fake.reply = () => ({ status: 500, body: { error: "boom" } });
  await upload(service, "规定.md", SIX);
  await idle(service);
  fake.reset();
  const got = (await search(service, { query: "第8条 寄回期限" })).json;
  assert.deepEqual([got.mode, got.reason, got.ready, got.pending, got.documents, got.chunks], ["hybrid_partial", null, false, 1, 2, 10]);
  assert.deepEqual(got.uncovered_semantic, [{ library: GENERAL, library_name: "通用知识库", name: "规定.md" }]);
  assert.deepEqual(got.uncovered, []);
  // 没有换算好的那一份里的片段靠按字面进来：没有按意思的名次，分数是按字面的得分。
  const fifth = got.hits.find((h: Dict) => h.title === "五");
  assert.deepEqual([fifth.name, fifth.rank_semantic, fifth.rank_keyword, fifth.score_kind], ["规定.md", null, 1, "keyword"]);
  // 换算好的那一份照常按意思比。
  assert.ok(got.hits.some((h: Dict) => h.name === "借阅规范.md" && h.rank_semantic === 1 && h.score_kind === "semantic"));

  // 文档旁边的数字串文件坏了（长度对不上）：这一份也只按字面。
  const whole = fresh();
  await upload(whole, "借阅规范.md", RULES);
  await upload(whole, "规定.md", SIX);
  await idle(whole);
  truncateSync(join(whole.knowledge!.filesDir(GENERAL), "规定.md") + VECTORS_SUFFIX, 8);
  const broken = (await search(whole, { query: "第8条 寄回期限" })).json;
  assert.deepEqual([broken.mode, broken.uncovered_semantic.map((d: Dict) => d.name), broken.chunks], ["hybrid_partial", ["规定.md"], 10]);
  assert.equal(broken.hits.find((h: Dict) => h.title === "五").rank_keyword, 1);

  // 选了嵌入模型而一份都没有换算好：全部文档只按字面，列出全部，不发请求。
  const none = fresh();
  fake.reply = () => ({ status: 500, body: { error: "boom" } });
  await upload(none, "规定.md", SIX);
  await idle(none);
  fake.reset();
  const all = (await search(none, { query: ASK })).json;
  assert.deepEqual([all.mode, all.reason, all.uncovered_semantic.map((d: Dict) => d.name), titles(all)], ["hybrid_partial", null, ["规定.md"], ["五", "六", "二"]]);
  assert.equal(fake.hits.length, 0);
  await Promise.all([service.close(), whole.close(), none.close()]);
});

test("退化三：换算要找的那句话时模型服务出了事，只按字面找并写明是哪一种；回的数字串长度与存着的不一样时各份文档只按字面", async () => {
  const service = fresh();
  await upload(service, "规定.md", SIX);
  await idle(service);
  const reasonOf = async () => {
    const got = await search(service, { query: ASK });
    assert.equal(got.status, 200);
    assert.deepEqual([got.json.mode, titles(got.json), got.json.uncovered_semantic], ["keyword", ["五", "六", "二"], []]);
    assert.ok(got.json.hits.every((h: Dict) => h.rank_semantic === null && h.score_kind === "keyword"));
    return got.json.reason;
  };
  fake.reply = () => ({ status: 500, body: { error: "model is loading" } });
  assert.equal(await reasonOf(), "service_error");
  fake.reply = () => ({ status: 401, body: { error: "bad key" } });
  assert.equal(await reasonOf(), "key_rejected");
  fake.reply = (body) => ({ body: { embeddings: body.input.map(() => [0, 0, 0, 0, 0]) } });
  assert.equal(await reasonOf(), "bad_answer");
  fake.reply = () => ({ body: { embeddings: [] } });
  assert.equal(await reasonOf(), "bad_answer");
  // 连不上：把选定的模型服务换成一个没有人听的地址。
  await chooseEmbedding(agent, "http://127.0.0.1:9");
  assert.equal(await reasonOf(), "unreachable");
  await chooseEmbedding(agent, fake.url);
  // 回的数字串长度与存着的不一样（模型服务那边换了模型而名字没变）：比不了，这份文档只按字面，不出错。
  fake.reply = (body) => ({ body: { embeddings: body.input.map(() => [1, 2, 3]) } });
  const odd = (await search(service, { query: ASK })).json;
  assert.deepEqual([odd.mode, odd.reason, odd.uncovered_semantic.map((d: Dict) => d.name), titles(odd)], ["hybrid_partial", null, ["规定.md"], ["五", "六", "二"]]);
  await service.close();
});

test("退化四：某份文档的文字读不出来，跳过它并在响应里写明，别的文档照常；不把局部的结果说成全部", async () => {
  const service = fresh();
  await upload(service, "借阅规范.md", RULES);
  await upload(service, "规定.md", SIX);
  await idle(service);
  // 文档本体与它旁边的成品都不在了，清单里还有它。
  const path = join(service.knowledge!.filesDir(GENERAL), "规定.md");
  for (const file of [path, path + EMBEDDINGS_SUFFIX, path + VECTORS_SUFFIX]) unlinkSync(file);
  const got = (await search(service, { query: "逾期怎样罚款" })).json;
  assert.deepEqual(got.uncovered, [{ library: GENERAL, library_name: "通用知识库", name: "规定.md", reason: "source_unreadable" }]);
  assert.deepEqual([got.mode, got.documents, got.chunks, got.uncovered_semantic], ["hybrid", 1, 4, []]);
  assert.deepEqual(got.hits[0].title, "借阅规范 / 逾期");
  await service.close();
});

test("退化五：调用的一方取消时不退化，直接以 cancelled 结束；换算要找的那句话的中途取消也一样", async () => {
  const service = fresh();
  await upload(service, "规定.md", SIX);
  await idle(service);
  const body = Buffer.from(JSON.stringify({ query: ASK }));
  const send = (signal: AbortSignal) => dispatch(service, { method: "POST", path: "/api/v1/knowledge/search", query: {}, headers: {}, body, remote: "127.0.0.1", signal }) as Promise<Dict>;
  // 来的时候已经取消了。
  fake.hits = [];
  const early = await send(AbortSignal.abort());
  assert.deepEqual([early.status, JSON.parse(early.body.toString("utf-8")).error], [499, { code: "cancelled", message: CANCELLED_TEXT, data: {} }]);
  assert.equal(fake.hits.length, 0);
  // 模型服务还在算的时候取消：不拿按字面的结果顶上。
  fake.reply = (b) => ({ delay: 2000, body: { embeddings: b.input.map(() => [1, 0, 0, 0, 0.2]) } });
  const gone = new AbortController();
  const pending = send(gone.signal);
  setTimeout(() => gone.abort(), 100);
  const late = await within("取消之后查找收住", 5000, pending);
  assert.deepEqual([late.status, JSON.parse(late.body.toString("utf-8")).error.code], [499, "cancelled"]);
  assert.equal(new ApiError("cancelled", CANCELLED_TEXT).status, 499);
  await service.close();
});

test("请求写得不对以 bad_request 拒绝：limit 最多是 5", async () => {
  const service = fresh();
  for (const [body, text] of [
    [{}, QUERY_REQUIRED_TEXT], [{ query: "   " }, QUERY_REQUIRED_TEXT], [{ query: 7 }, QUERY_REQUIRED_TEXT],
    [{ query: "罚款", limit: 0 }, LIMIT_RANGE_TEXT], [{ query: "罚款", limit: 6 }, LIMIT_RANGE_TEXT], [{ query: "罚款", limit: 10 }, LIMIT_RANGE_TEXT], [{ query: "罚款", limit: 2.5 }, LIMIT_RANGE_TEXT],
    [{ query: "罚款", limit: "3" }, LIMIT_RANGE_TEXT], [{ query: "罚款", libraries: "general" }, LIBRARIES_SHAPE_TEXT], [{ query: "罚款", libraries: [1] }, LIBRARIES_SHAPE_TEXT],
  ] as const) {
    const got = await search(service, body);
    assert.deepEqual([got.status, got.json.error.code, got.json.error.message], [400, "bad_request", text], JSON.stringify(body));
  }
  assert.equal(LIMIT_RANGE_TEXT, "limit 应当是 1 到 5 的整数。");
  assert.equal((await search(service, { query: "罚款", limit: 5 })).status, 200);
  await service.close();
});

// ───────────── 查到的片段的原文 ─────────────

test("Markdown 与纯文本的原文：与源文字逐字节相同，连段与段之间的空行；片段里存的文字把空行接掉了，原文没有", async () => {
  const service = fresh();
  const source = "# 退款\n\n第 7 条 下列商品不予退货：   \n\n\n第 8 条 退货申请通过后，买家应在 7 天内寄出商品。\r\n\r\n## 别的\n\n无关的一段。\n";
  await upload(service, "退款规范.md", source);
  await upload(service, "说明.txt", "第一段说罚款。\n\n\n\n第二段也说罚款。\n");
  await idle(service);
  const got = (await search(service, { query: "第8条 寄出商品" })).json;
  const hit = got.hits.find((h: Dict) => h.title === "退款");
  // 源文字的行尾已经统一成换行符；第 7 条行尾的三个空格与两条之间的两个空行都原样在。
  assert.equal(hit.body, "第 7 条 下列商品不予退货：   \n\n\n第 8 条 退货申请通过后，买家应在 7 天内寄出商品。");
  assert.equal(hit.text, "第 7 条 下列商品不予退货：\n第 8 条 退货申请通过后，买家应在 7 天内寄出商品。");
  assert.notEqual(hit.body, hit.text);
  assert.deepEqual([hit.paragraphs, hit.table, hit.header, hit.exact, hit.first_line, hit.last_line], [null, null, null, true, 3, 6]);
  const stored = service.knowledge!.text(GENERAL, "退款规范.md");
  assert.ok(stored.includes(hit.body));
  const plain = (await search(service, { query: "罚款", limit: 5 })).json.hits.find((h: Dict) => h.name === "说明.txt");
  assert.equal(plain.body, "第一段说罚款。\n\n\n\n第二段也说罚款。");
  await service.close();
});

test("Word 文档的原文：逐段给并带段落号，文字与核对摘录用的段文字相同；表格的行也逐段给，另给行结构；没有换算好、现切出来的片段也一样", async () => {
  const service = fresh();
  await upload(service, "需求.docx", readFileSync(SAMPLE));
  await idle(service);
  const projection = service.knowledge!.text(GENERAL, "需求.docx");
  const wanted = projectionParagraphs(projection);
  const check = (json: Dict) => {
    const table = json.hits.find((h: Dict) => h.title === "2.3 借阅上限");
    assert.ok(table, JSON.stringify(json.hits.map((h: Dict) => h.title)));
    assert.equal(table.body, null);
    assert.deepEqual([table.first_paragraph, table.last_paragraph], [34, 71]);
    // 每一段的文字就是核对摘录时用的那一段；段落号在片段的范围里，从小到大。
    for (const one of table.paragraphs) assert.equal(one.text, wanted[one.paragraph - 1], `第 ${one.paragraph} 段`);
    const numbers = table.paragraphs.map((one: Dict) => one.paragraph);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
    assert.ok(numbers[0] >= 34 && numbers.at(-1) <= 71);
    // 表格的行结构：每行各格里是哪几段；行里的段都在逐段给的清单里。
    assert.ok(table.table.length >= 3);
    for (const row of table.table) for (const cell of row) if (Array.isArray(cell)) for (const n of cell) assert.ok(numbers.includes(n), `第 ${n} 段`);
    assert.equal(table.header, null);
    // 片段里存的文字是带竖线的改写文字，原文里没有竖线行。
    assert.match(table.text, /^\| /m);
    assert.ok(table.paragraphs.every((one: Dict) => !one.text.startsWith("|")));
  };
  check((await search(service, { query: "各类读者的借阅上限", limit: 5 })).json);
  // 没有选嵌入模型：片段是现切的，原文照样逐段给。
  await chooseEmbedding(agent, fake.url, null);
  const keyword = (await search(service, { query: "各类读者的借阅上限", limit: 5 })).json;
  assert.equal(keyword.mode, "keyword");
  check(keyword);
  await service.close();
});

test("取中的片段读不到源文字（文档本体不在了，旁边的成品还在）：这个片段不给，文档记进没有查到的", async () => {
  const service = fresh();
  await upload(service, "借阅规范.md", RULES);
  await upload(service, "规定.md", SIX);
  await idle(service);
  unlinkSync(join(service.knowledge!.filesDir(GENERAL), "规定.md"));
  const got = (await search(service, { query: ASK, limit: 5 })).json;
  assert.deepEqual(got.uncovered, [{ library: GENERAL, library_name: "通用知识库", name: "规定.md", reason: "source_unreadable" }]);
  assert.ok(got.hits.length >= 1 && got.hits.every((h: Dict) => h.name === "借阅规范.md" && typeof h.body === "string"));
  await service.close();
});
