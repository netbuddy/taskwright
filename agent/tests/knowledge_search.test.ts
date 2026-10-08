/**
 * 「按意思查找知识库」工具的核心逻辑（src/lib/knowledge_search.ts）：怎样找到任务服务、发给它什么、把拿回来的片段排成什么样的文字；
 * 开头一句怎样写明这一次是怎样找的（两路、只按字面与原因、哪些文档只按字面、哪些没有查到）；任务服务联系不上或回答了错误、
 * 没有知识库或没有文档、助手取消时各回哪一句；参数写错时抛异常。
 * 任务服务是本文件里起的一个假服务，回答由各例设置；任务目录与知识库根目录都在临时目录里。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CANCELLED_TEXT, CLOSING_TEXT, LOCK_NAME, NOT_FOUND_TEXT, NO_DOCUMENTS_TEXT, NO_KNOWLEDGE_TEXT, REASON_TEXT, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_PATH,
  BODY_CLOSE, BODY_OPEN, BUDGET_BYTES, UNREACHABLE_TEXT, assemble, backendAddresses, failedText, openingText, searchKnowledge, searchParams, trimmedText, truncatedText,
} from "../src/lib/knowledge_search.ts";

type Dict = Record<string, any>;

let tmp: string;
let server: Server;
let port = 0;
/** 一个已经关掉的端口：连上去会被拒绝。 */
let closedPort = 0;
let reply: (body: Dict) => { status?: number; body: unknown } = () => ({ status: 404, body: {} });
let hits: { method: string; path: string; body: Dict }[] = [];
let n = 0;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "tw-kb-search-"));
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      hits.push({ method: req.method ?? "", path: req.url ?? "", body });
      const answer = reply(body);
      res.writeHead(answer.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as AddressInfo).port;
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((ok) => probe.close(() => ok()));
});
beforeEach(() => {
  hits = [];
  reply = () => ({ status: 404, body: {} });
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((ok) => server.close(() => ok()));
  rmSync(tmp, { recursive: true, force: true });
});

/** 由 Word 文档生成的那份文字：第 75 段在第 4 行，第 78 段在第 8 行。 */
const PROJECTION = ["<!--", "段落总数：80。", "-->", "### 3.1.1 [p75] 逾期罚款", "", "[p76] 逾期每册每天罚款 0.2 元。", "[p77] 单册罚款累计不超过该书定价。", "| [p78] 逾期超过 60 天 | [p79] 按丢失处理 |"].join("\n");

/** 建一个知识库根目录：通用知识库里一份 Markdown 规范，另一个知识库里一份 Word 文档（带由它生成的那份文字）。 */
function makeRoot(): string {
  const root = join(tmp, `root-${++n}`);
  mkdirSync(join(root, "general", "files"), { recursive: true });
  mkdirSync(join(root, "lib-a1", "files"), { recursive: true });
  writeFileSync(join(root, "libraries.json"), JSON.stringify({ version: 1, libraries: [{ id: "general", name: "通用知识库" }, { id: "lib-a1", name: "公司规范" }] }));
  writeFileSync(join(root, "general", "files", "借阅规范.md"), "# 借阅规范\n\n## 逾期\n\n逾期每册每天罚款 0.5 元。\n");
  writeFileSync(join(root, "general", "documents.json"), JSON.stringify({ version: 1, documents: [{ name: "借阅规范.md", kind: "standard", bytes: 64 }] }));
  writeFileSync(join(root, "lib-a1", "files", "需求说明.docx"), "");
  writeFileSync(join(root, "lib-a1", "files", "需求说明.docx.md"), PROJECTION);
  writeFileSync(join(root, "lib-a1", "documents.json"), JSON.stringify({ version: 1, documents: [{ name: "需求说明.docx", kind: "standard", bytes: 2048 }] }));
  return root;
}

/** 建一个任务目录：选用了哪些知识库；lock 是占用标记的内容，不给就不写这份标记。 */
function makeTask(libraries: string[] = ["general", "lib-a1"], lock: Dict | null = { port, pid: 1, host: "某台主机" }): string {
  const dir = join(tmp, `task-${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "knowledge.json"), JSON.stringify({ version: 1, libraries, notes: [] }));
  if (lock) writeFileSync(join(dir, LOCK_NAME), JSON.stringify(lock));
  return dir;
}

/** 一个 Markdown 片段：原文里两条规定之间有一个空行。 */
const MD_HIT = {
  score: 0.7136, score_kind: "semantic", rank_semantic: 1, rank_keyword: 2,
  library: "general", library_name: "通用知识库", name: "借阅规范.md", kind: "standard", title: "借阅规范 / 逾期", block: 2,
  first_paragraph: null, last_paragraph: null, first_line: 5, last_line: 7, partial: false,
  text: "第 6 条 逾期每册每天罚款 0.5 元。\n第 7 条 逾期超过 60 天的，暂停借阅。", locator: "knowledge/general/借阅规范.md",
  body: "第 6 条 逾期每册每天罚款 0.5 元。\n\n第 7 条 逾期超过 60 天的，暂停借阅。", paragraphs: null, table: null, header: null, exact: true,
};
/** 一个 Word 片段：两段正文加表格的两行，从表中间开始，所以带表头。 */
const WORD_HIT = {
  score: 0.63, score_kind: "semantic", rank_semantic: 2, rank_keyword: null,
  library: "lib-a1", library_name: "公司规范", name: "需求说明.docx", kind: "standard", title: "3.1.1 逾期罚款", block: 9,
  first_paragraph: 75, last_paragraph: 81, first_line: null, last_line: null, partial: false,
  text: "| 读者类型 | 罚款 |\n逾期罚款\n逾期每册每天罚款 0.2 元。\n| 学生 | 0.2 元 |\n| （同上） | 上限 |", locator: "knowledge/lib-a1/需求说明.docx",
  body: null,
  paragraphs: [{ paragraph: 75, text: "逾期罚款" }, { paragraph: 76, text: "逾期每册每天罚款 0.2 元。" }, { paragraph: 78, text: "学生" }, { paragraph: 79, text: "0.2 元" }, { paragraph: 81, text: "上限" }],
  table: [[[78], [79]], ["（同上）", [81]]],
  header: { first_paragraph: 70, last_paragraph: 71, cells: [[70], [71]], paragraphs: [{ paragraph: 70, text: "读者类型" }, { paragraph: 71, text: "罚款" }] },
  exact: true,
};
/** 助手收到的这两个片段的样子。 */
const MD_LINES = [
  "【第 1 个片段】知识库「通用知识库」《借阅规范.md》 · 标题：借阅规范 / 逾期 · 按意思排第 1，按字面排第 2",
  "位置：第 5 到 7 行",
  "引用时出处写：knowledge/general/借阅规范.md",
  "正文：",
  "<<<原文开始",
  "第 6 条 逾期每册每天罚款 0.5 元。",
  "",
  "第 7 条 逾期超过 60 天的，暂停借阅。",
  "原文结束>>>",
];
const WORD_LINES = [
  "【第 2 个片段】知识库「公司规范」《需求说明.docx》 · 标题：3.1.1 逾期罚款 · 按意思排第 2，按字面没有命中",
  "位置：第 75 到 81 段",
  "引用时出处写：knowledge/lib-a1/需求说明.docx#p段落号（写摘录所在那一段的段落号）",
  "表格结构（每个分号是表格的一行，竖线隔开各格，格里写的是它的段落号；一条来源只抄一格里的字，不要把一行的几格连起来抄）：p78｜p79；（同上）｜p81",
  "这张表的表头（出自第 70 到 71 段，只帮你看懂各列，不在这个片段的位置范围里；要引用表头里的字，出处写它自己的段落号）：p70｜p71",
  "<<<原文开始",
  "[p70] 读者类型",
  "[p71] 罚款",
  "原文结束>>>",
  "正文（每行是一段，开头方括号里是这一段的段落号，摘录不带它）：",
  "<<<原文开始",
  "[p75] 逾期罚款",
  "[p76] 逾期每册每天罚款 0.2 元。",
  "[p78] 学生",
  "[p79] 0.2 元",
  "[p81] 上限",
  "原文结束>>>",
];
const SECOND = "下面是最相关的 2 个片段。排在前面不等于就是你要找的规定：逐个看正文，对得上的才引用；一个片段里有多条规定时逐条看。";
const found = (list: Dict[], extra: Dict = {}) => ({ body: {
  ok: true, mode: "hybrid", reason: null, model: "svc/bge-m3", ready: true, pending: 0, libraries: 2, documents: 2, chunks: 37, uncovered_semantic: [], uncovered: [], hits: list, ...extra,
} });
const OPENING = "查找「图书超期不还怎样罚款」：在这个任务选用的 2 个知识库、2 份文档、37 个片段里按意思与按字面两路找。";

test("任务服务的地址：先是本机回环地址上占用标记里的端口，再是标记里的主机名；没有标记、标记里没有端口时是空的", () => {
  assert.deepEqual(backendAddresses(makeTask(["general"], { port: 8790, pid: 1, host: "某台主机" })), ["http://127.0.0.1:8790", "http://某台主机:8790"]);
  assert.deepEqual(backendAddresses(makeTask(["general"], { port: 8790, pid: 1 })), ["http://127.0.0.1:8790"]);
  assert.deepEqual(backendAddresses(makeTask(["general"], { port: 8790, host: "localhost" })), ["http://127.0.0.1:8790"]);
  assert.deepEqual(backendAddresses(makeTask(["general"], { port: null, pid: 1, host: "某台主机" })), []);
  assert.deepEqual(backendAddresses(makeTask(["general"], null)), []);
});

test("查到了：把要找的话、任务选用的知识库的编号与要几个发给查找接口；每个片段写在哪份文档、位置、两路里各排第几、出处怎样写与逐字的原文，不给文件的路径", async () => {
  const root = makeRoot();
  reply = () => found([MD_HIT, WORD_HIT]);
  const got = await searchKnowledge(makeTask(), root, { query: "  图书超期不还怎样罚款  " });
  assert.deepEqual(hits, [{ method: "POST", path: SEARCH_PATH, body: { query: "图书超期不还怎样罚款", libraries: ["general", "lib-a1"], limit: 3 } }]);
  assert.equal(got.text, [`${OPENING}${SECOND}`, "", ...MD_LINES, "", ...WORD_LINES, "", CLOSING_TEXT].join("\n"));
  // 原文夹在两行记号之间；Markdown 的原文连空行原样给，Word 的原文每段一行、行首是段落号，表格的改写文字（带竖线的一行）不给。
  assert.deepEqual([BODY_OPEN, BODY_CLOSE], ["<<<原文开始", "原文结束>>>"]);
  assert.ok(got.text.includes(`${BODY_OPEN}\n${MD_HIT.body}\n${BODY_CLOSE}`));
  assert.doesNotMatch(got.text, /^\| /m);
  // 不给知识库文件的路径，也不再请助手去读文件。
  assert.ok(!got.text.includes(root) && !got.text.includes("files/"));
  assert.doesNotMatch(got.text, /读原文|用 read/);
  // 结构化的那一份不带片段的文字与原文；另记这一次列了几个、一共多少字节。
  const brief = ({ text: _t, body: _b, paragraphs: _p, table: _tb, header: _h, ...rest }: Dict) => rest;
  assert.deepEqual(got.details, { ok: true, ready: true, query: "图书超期不还怎样罚款", limit: 3, model: "svc/bge-m3", pending: 0,
    mode: "hybrid", reason: null, uncovered_semantic: [], uncovered: [], hits: [brief(MD_HIT), brief(WORD_HIT)],
    shown: 2, bytes: Buffer.byteLength(got.text, "utf-8"), truncated_chars: null });
});

test("排版的几处细节：没有标题的片段不写标题；只占一行或一段时写「第几行」「第几段」；很长的一段切出来的一截写明不是全文；两路的名次各种情形的写法", async () => {
  const lines = (hit: Dict, keywordOnly = false) => assemble("开头。", [hit as never], keywordOnly).text.split("\n");
  assert.equal(lines({ ...MD_HIT, title: null, first_line: 3, last_line: 3 })[2], "【第 1 个片段】知识库「通用知识库」《借阅规范.md》 · 按意思排第 1，按字面排第 2");
  assert.equal(lines({ ...MD_HIT, first_line: 3, last_line: 3 })[3], "位置：第 3 行");
  assert.equal(lines({ ...MD_HIT, partial: true })[3], "位置：第 5 到 7 行（这一段很长，切成了几个片段，这里是其中的一截，不是全文）");
  assert.equal(lines({ ...WORD_HIT, first_paragraph: 90, last_paragraph: 90, table: null, header: null })[3], "位置：第 90 段");
  // 没有表格、没有表头的 Word 片段：不写表格结构与表头。
  assert.ok(!lines({ ...WORD_HIT, table: null, header: null }).some((line) => line.startsWith("表格结构") || line.startsWith("这张表的表头")));
  // 两路的名次。
  const how = (hit: Dict, keywordOnly = false) => lines(hit, keywordOnly)[2].split(" · ").at(-1);
  assert.equal(how({ ...MD_HIT, rank_semantic: 3, rank_keyword: null }), "按意思排第 3，按字面没有命中");
  assert.equal(how({ ...MD_HIT, rank_semantic: null, rank_keyword: 1, score_kind: "keyword" }), "按字面排第 1，按意思没有比（这份文档还没有换算好）");
  assert.equal(how({ ...MD_HIT, rank_semantic: null, rank_keyword: 2, score_kind: "keyword" }, true), "按字面排第 2");
  // 表头行里没有段落号、表格里有空格。
  const odd = lines({ ...WORD_HIT, table: [["", [78, 79]]], header: { first_paragraph: null, last_paragraph: null, cells: ["（同左）"], paragraphs: [] } });
  assert.ok(odd.includes("表格结构（每个分号是表格的一行，竖线隔开各格，格里写的是它的段落号；一条来源只抄一格里的字，不要把一行的几格连起来抄）：（空）｜p78、p79"));
  assert.ok(odd.some((line) => line.startsWith("这张表的表头（出自位置不详，")));
});

test("预算：全部文字连同说明不超过 8192 字节；超过时从末尾去掉片段并写明还有几条，第 1 个永不去掉；只剩第 1 个仍然超过时截短它的正文并写明", async () => {
  assert.equal(BUDGET_BYTES, 8192);
  const big = (n: number, chars: number) => ({ ...MD_HIT, rank_semantic: n, title: `第 ${n} 节`, body: `${"规".repeat(chars - 1)}。`, text: "" });
  const bytes = (text: string) => Buffer.byteLength(text, "utf-8");
  // 每个片段的正文 700 个字（2100 字节）：五个放不下，三个放得下。
  const five = [1, 2, 3, 4, 5].map((n) => big(n, 700));
  const cut = assemble("开头。", five as never[], false);
  assert.ok(bytes(cut.text) <= BUDGET_BYTES, String(bytes(cut.text)));
  assert.deepEqual([cut.shown, cut.removed, cut.truncated_chars], [3, 2, null]);
  assert.ok(cut.text.includes("【第 3 个片段】") && !cut.text.includes("【第 4 个片段】"));
  // 去掉了几条写在末尾的说明之前；这句说明不超过 200 字节。
  assert.ok(cut.text.endsWith(`\n${trimmedText(2)}\n\n${CLOSING_TEXT}`));
  assert.equal(trimmedText(2), "（这一次的结果超过了 8192 字节的上限：还有 2 条没有列出，缩小问题再查。）");
  assert.ok(bytes(trimmedText(99)) <= 200 && bytes(truncatedText(9999)) <= 200);
  // 放得下时一个不去，也没有那一行。
  const fits = assemble("开头。", five.slice(0, 3) as never[], false);
  assert.deepEqual([fits.shown, fits.removed, fits.text.includes("没有列出")], [3, 0, false]);
  // 第 1 个自己就超过：别的都去掉，它的正文截短到放得下的最多的字数，并写明。
  const huge = assemble("开头。", [big(1, 4000), big(2, 700)] as never[], false);
  assert.deepEqual([huge.shown, huge.removed], [1, 1]);
  assert.ok(huge.truncated_chars !== null && huge.truncated_chars > 2000 && huge.truncated_chars < 4000);
  assert.ok(bytes(huge.text) <= BUDGET_BYTES && bytes(huge.text) > BUDGET_BYTES - 6, String(bytes(huge.text)));
  assert.ok(huge.text.includes(`${"规".repeat(10)}\n${BODY_CLOSE}\n${truncatedText(huge.truncated_chars!)}\n`));
  assert.ok(huge.text.includes(trimmedText(1)));
  assert.equal(truncatedText(140), "（正文只显示了前 140 字；要看后面的内容，把问题缩小再查。）");
  // 预算调小也守得住（Word 片段的正文同样可以截短）。
  const small = assemble("开头。", [{ ...WORD_HIT, rank_semantic: 1 }, MD_HIT] as never[], false, 1500);
  assert.ok(bytes(small.text) <= 1500);
  assert.equal(small.shown, 1);

  // 经工具走一遍：结果里记着列了几个与字节数。
  reply = () => found(five);
  const got = await searchKnowledge(makeTask(), makeRoot(), { query: "罚款", limit: 5 });
  assert.deepEqual([got.details.shown, (got.details.hits as unknown[]).length, got.details.bytes], [3, 5, bytes(got.text)]);
  assert.ok(bytes(got.text) <= BUDGET_BYTES);
});

test("开头的一句写明这一次是怎样找的：两路都做；只按字面与原因；哪些文档只按字面找了；哪些文档没有查到。没有命中时请助手换一种说法", async () => {
  const base = found([]).body;
  const open = (extra: Dict) => openingText("罚款", { ...base, ...extra }, 2);
  assert.equal(open({}), "查找「罚款」：在这个任务选用的 2 个知识库、2 份文档、37 个片段里按意思与按字面两路找。");
  // 只按字面：括号里写原因，每一种原因各有说法。
  assert.equal(open({ mode: "keyword", reason: "not_selected", model: null }), "查找「罚款」：在这个任务选用的 2 个知识库、2 份文档、37 个片段里只按字面找（没有选嵌入模型）。");
  for (const reason of ["provider_gone", "not_offered", "timeout", "unreachable", "key_rejected", "service_error", "bad_answer"]) {
    assert.ok(open({ mode: "keyword", reason }).endsWith(`只按字面找（${REASON_TEXT[reason]}）。`), reason);
    assert.ok(REASON_TEXT[reason].length > 4);
  }
  assert.ok(open({ mode: "keyword", reason: "没见过的原因" }).endsWith("只按字面找（按意思那一路没有做成）。"));
  // 有的文档还没有换算好：写明对它只按字面找了；多于 5 份时只写前 5 份与一共几份。
  const doc = (name: string) => ({ library: "general", library_name: "通用知识库", name });
  assert.ok(open({ mode: "hybrid_partial", uncovered_semantic: [doc("甲.md")] }).endsWith("按意思与按字面两路找。《甲.md》还没有换算好，这一次对它只按字面找了。"));
  assert.ok(open({ mode: "hybrid_partial", uncovered_semantic: ["一", "二", "三", "四", "五", "六", "七"].map((n) => doc(`${n}.md`)) })
    .endsWith("《一.md》《二.md》《三.md》《四.md》《五.md》等 7 份文档还没有换算好，这一次对它们只按字面找了。"));
  // 文档读不出来：写明没有查到它，并且不把局部的结果说成全部。
  assert.ok(open({ uncovered: [{ ...doc("乙.txt"), reason: "source_unreadable" }] }).endsWith("《乙.txt》这一次没有查到，因为它的文件读不出来；没有找到不等于知识库里没有。"));

  // 经工具走一遍：只按字面、没有命中。结果里带查找方式与原因，文字是开头一句加请它换一种说法。
  const root = makeRoot();
  reply = () => found([], { mode: "keyword", reason: "not_selected", model: null, ready: false, pending: 2 });
  const none = await searchKnowledge(makeTask(), root, { query: "罚款" });
  assert.equal(none.text, `查找「罚款」：在这个任务选用的 2 个知识库、2 份文档、37 个片段里只按字面找（没有选嵌入模型）。\n${NOT_FOUND_TEXT}`);
  assert.equal(NOT_FOUND_TEXT, "没有找到相关的片段。换一种说法再查一次；换了说法仍然没有，才算知识库里没有。");
  assert.deepEqual(none.details, { ok: true, ready: false, query: "罚款", limit: 3, model: null, pending: 2, mode: "keyword", reason: "not_selected", uncovered_semantic: [], uncovered: [], hits: [],
    shown: 0, bytes: Buffer.byteLength(none.text, "utf-8"), truncated_chars: null });
  // 文档没有都换算好不再是「不能查」：照样把结果给助手，开头写明哪一份只按字面找了。
  reply = () => found([MD_HIT], { mode: "hybrid_partial", ready: false, pending: 1, uncovered_semantic: [doc("需求说明.docx")] });
  const partial = await searchKnowledge(makeTask(), root, { query: "罚款" });
  assert.ok(partial.text.startsWith("查找「罚款」：在这个任务选用的 2 个知识库、2 份文档、37 个片段里按意思与按字面两路找。《需求说明.docx》还没有换算好，这一次对它只按字面找了。下面是最相关的 1 个片段。"));
  assert.equal((partial.details.hits as unknown[]).length, 1);
});

test("limit 不写是 3，最多 5", () => {
  assert.deepEqual([SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT], [3, 5]);
  assert.deepEqual(searchParams({ query: " 罚款 " }), { query: "罚款", limit: 3 });
  assert.deepEqual(searchParams({ query: "罚款", limit: 5 }), { query: "罚款", limit: 5 });
  for (const limit of [0, 6, 10, 2.5, "3"]) assert.throws(() => searchParams({ query: "罚款", limit }), /limit 要写 1 到 5 的整数，不写是 3。/);
});

test("这一次没有做成：任务服务回答了错误时带上它的那句话；没有占用标记、标记里的端口连不上时说联系不上；都请再查一次、仍然不成就告诉用户并记问题条目，不提 grep", async () => {
  const root = makeRoot();
  reply = () => ({ status: 502, body: { ok: false, error: { code: "embedding_failed", message: "模型服务回答了错误（HTTP 500）：model is loading", data: {} } } });
  const failed = await searchKnowledge(makeTask(), root, { query: "罚款" });
  assert.equal(failed.text, "按意思查找这一次没有做成：模型服务回答了错误（HTTP 500）：model is loading。可以再查一次；仍然不成时把这个原因告诉用户，这一处先保留材料的原话并记一条问题条目。");
  assert.equal(failed.details.reason, "embedding_failed");
  // 回答不是约定的样子（例如端口上是别的程序）：写状态码。
  reply = () => ({ status: 404, body: {} });
  assert.equal((await searchKnowledge(makeTask(), root, { query: "罚款" })).text, failedText("系统回答了错误（HTTP 404）"));

  const before = hits.length;
  const noLock = await searchKnowledge(makeTask(["general"], null), root, { query: "罚款" });
  assert.equal(noLock.text, "按意思查找这一次没有做成：联系不上系统里负责查找的那一部分。可以再查一次；仍然不成时把这个原因告诉用户，这一处先保留材料的原话并记一条问题条目。");
  assert.equal(noLock.text, UNREACHABLE_TEXT);
  const closed = await searchKnowledge(makeTask(["general"], { port: closedPort, pid: 1 }), root, { query: "罚款" });
  assert.deepEqual([closed.text, closed.details.reason], [UNREACHABLE_TEXT, "unreachable"]);
  assert.equal(hits.length, before);
});

test("本机回环地址连不上时按占用标记里的主机名再连一次；已经取消的调用不再试下一个地址，回「查找被取消了」而不说联系不上", async () => {
  const root = makeRoot();
  const tried: string[] = [];
  const viaHost = (async (url: string | URL | Request) => {
    tried.push(String(url));
    if (String(url).startsWith("http://127.0.0.1:")) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(found([MD_HIT]).body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const got = await searchKnowledge(makeTask(["general"], { port: 8790, pid: 1, host: "某台主机" }), root, { query: "罚款" }, { fetch: viaHost });
  assert.deepEqual(tried, [`http://127.0.0.1:8790${SEARCH_PATH}`, `http://某台主机:8790${SEARCH_PATH}`]);
  assert.ok(got.text.startsWith("查找「罚款」："));

  tried.length = 0;
  const stop = new AbortController();
  const cancelled = (async (url: string | URL | Request) => {
    tried.push(String(url));
    stop.abort();
    throw new DOMException("aborted", "AbortError");
  }) as typeof fetch;
  const gone = await searchKnowledge(makeTask(["general"], { port: 8790, pid: 1, host: "某台主机" }), root, { query: "罚款" }, { fetch: cancelled, signal: stop.signal });
  assert.equal(tried.length, 1);
  assert.deepEqual([gone.text, gone.details.reason], [CANCELLED_TEXT, "cancelled"]);
  assert.equal(CANCELLED_TEXT, "查找被取消了。");
});

test("没有可查的：没有知识库、任务选用的知识库里没有文档，各回一句，不联系任务服务；文档里没有文字时照没有命中说", async () => {
  const root = makeRoot();
  assert.equal((await searchKnowledge(makeTask(), null, { query: "罚款" })).text, NO_KNOWLEDGE_TEXT);
  writeFileSync(join(root, "general", "documents.json"), JSON.stringify({ version: 1, documents: [] }));
  const empty = await searchKnowledge(makeTask(["general"]), root, { query: "罚款" });
  assert.deepEqual([empty.text, empty.details.reason], [NO_DOCUMENTS_TEXT, "no_documents"]);
  // 选用的知识库已经不在清单里：同样没有可查的。
  assert.equal((await searchKnowledge(makeTask(["lib-gone"]), root, { query: "罚款" })).text, NO_DOCUMENTS_TEXT);
  assert.equal(hits.length, 0);
  reply = () => found([], { libraries: 1, documents: 1, chunks: 0 });
  const blank = await searchKnowledge(makeTask(["lib-a1"]), root, { query: "罚款" });
  assert.deepEqual([blank.text, blank.details.ok, blank.details.ready],
    [`查找「罚款」：在这个任务选用的 1 个知识库、1 份文档、0 个片段里按意思与按字面两路找。\n${NOT_FOUND_TEXT}`, true, true]);
  assert.deepEqual(hits[0].body.libraries, ["lib-a1"]);
});

test("参数写错时抛异常：要找的话是空的，要几个不是 1 到 5 的整数", async () => {
  for (const params of [{}, { query: "" }, { query: "   " }, { query: 7 }]) {
    await assert.rejects(searchKnowledge(makeTask(), makeRoot(), params), /query 要写要找的内容，用一句完整的话写出来，不能是空的。/);
  }
  for (const limit of [0, 6, 11, 2.5, "3"]) {
    await assert.rejects(searchKnowledge(makeTask(), makeRoot(), { query: "罚款", limit }), /limit 要写 1 到 5 的整数，不写是 3。/);
  }
  assert.equal(hits.length, 0);
});

test("给助手的每一句话都不请它改用 grep 去翻知识库，也不用写给开发者看的词；返回末尾写查到的片段就是逐字的原文", () => {
  const texts = [NO_KNOWLEDGE_TEXT, NO_DOCUMENTS_TEXT, NOT_FOUND_TEXT, CANCELLED_TEXT, UNREACHABLE_TEXT, CLOSING_TEXT, failedText("到时间没有回答"), ...Object.values(REASON_TEXT)];
  for (const text of texts) assert.doesNotMatch(text, /grep|find|检索|向量|进程|项目/, text);
  assert.equal(CLOSING_TEXT, "查到的片段就是逐字的原文：摘录从片段逐字抄，出处照片段给的写法写；不必再读知识库文件核对，保存时系统会逐字核对，对不上会退回并说明原因。");
});

test("工具的说明：什么时候查、一次查一件事、不用写 limit、一个片段里有多条规定时逐条看、查到的就是逐字的原文、不要用 grep 去翻知识库", () => {
  // 工具的登记文件依赖 pi 带来的包，这里不导入它，只读它的文字。
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools", "search_knowledge.ts"), "utf-8");
  const description = [...source.slice(source.indexOf("description:"), source.indexOf("promptSnippet:")).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
  for (const words of [
    "按意思、按字面两路比较",
    "知道条号或原话时把它写进去，按字面那一路会找到。",
    "查知识库用这一个工具：材料把具体规定指给了别的文档（例如「按公司规范执行」「见术语表」），或者不知道规范里这件事叫什么时就查。",
    "一次查一件事，要查几件就分几次查。",
    "不用写 limit；结果说还有几条没有列出时，把问题缩小再查。",
    "一个片段里有多条规定时逐条看，材料的说法与规范的用词常不同。",
    "查到的片段就是逐字的原文，摘录从片段逐字抄，不必再读知识库文件核对。",
    "不要用 grep 去翻知识库，命中太多也拿不全。",
  ]) assert.ok(description.includes(words), words);
  // 不写「最多 5 个」（写了模型就照着写 5），不再提读原文核对、换算好之前不能查、别的工具不能用。
  assert.doesNotMatch(description, /最多|用 read|还不能查|不能用 grep|也不能用 ls|检索|向量/);
  assert.doesNotMatch(source.slice(source.indexOf("limit: Type.Optional")).split("\n")[0], /最多/);
});
