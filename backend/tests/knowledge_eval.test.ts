/**
 * 知识库查找的评估（agent/eval/knowledge）：从一条会话记录量出助手怎样用知识库、每处期望的规定走到五级里的哪一级；
 * 几种取结果的办法离线比较。都是纯计算，不调模型；语料用评估目录自带的那份图书馆样例。
 */

import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { type CompareEntry, compare, compareTable, methods, reciprocalRankFusion } from "../../agent/eval/knowledge/compare_lib.ts";
import { chunkIndexOf, completeSentence, knowledgeDocuments, measure, sessionEntries, summaryLines, toolCalls, verbatim } from "../../agent/eval/knowledge/eval_lib.ts";
import { ROOT, tempDir } from "./helpers.ts";

const SAMPLE = join(ROOT, "agent", "eval", "knowledge", "sample");
const EXPECT = JSON.parse(readFileSync(join(SAMPLE, "expect.json"), "utf-8")).expectations;
const QUERIES = JSON.parse(readFileSync(join(SAMPLE, "queries.json"), "utf-8")).queries;

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 把样例的知识库拷到临时目录，另加一份超过 4 KB 的大文档。 */
function makeRoot(): string {
  const root = join(tmp, "knowledge");
  cpSync(join(SAMPLE, "knowledge"), root, { recursive: true });
  writeFileSync(join(root, "general", "files", "馆藏管理办法.md"), Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 条 馆藏登记的第 ${i + 1} 项要求。`).join("\n\n") + "\n");
  return root;
}

test("样例：期望里的每一句都在样例语料的某个片段里；样例查询的期望也都找得到", () => {
  const docs = knowledgeDocuments(join(SAMPLE, "knowledge"));
  assert.deepEqual(docs.map((doc) => [doc.library, doc.name, doc.chunks.length]), [["general", "借阅规范.md", 5], ["general", "读者常见问题.txt", 1]]);
  const rules = docs[0];
  // 第 1 个片段是文档的大标题自己；第 6 条在第 3 个（第三章），第 12 条在第 5 个（第五章），预约的保留期在第 4 个（第四章）。
  assert.deepEqual(EXPECT.map((one: { sentence: string }) => chunkIndexOf(rules, one.sentence)), [3, 5, 4]);
  assert.equal(chunkIndexOf(rules, "馆里没有这一条"), null);
  const entries: CompareEntry[] = docs.flatMap((doc) => doc.chunks.map((chunk) => ({ document: doc.name, index: chunk.index, heading: chunk.heading, text: chunk.text, vector: null })));
  assert.deepEqual(compare(entries, QUERIES.map((q: object) => ({ ...q, vector: null })), [3]).missing, []);
});

test("要找的话是不是一句完整的话（粗判）", () => {
  assert.equal(completeSentence("图书超期不还怎样罚款、上限是多少"), true);
  assert.equal(completeSentence("罚款"), false);
  assert.equal(completeSentence("罚款|滞纳金|逾期|超期|晚还"), false);
  assert.equal(completeSentence("罚款 逾期 上限 定价"), false);
});

test("摘录是不是逐字：照保存修订的规则算一次（跨段要连空行原样抄），去掉全部空白再算一次", () => {
  const [rules] = knowledgeDocuments(join(SAMPLE, "knowledge"));
  const at = (excerpt: string) => verbatim(rules, "knowledge/general/借阅规范.md", excerpt);
  assert.deepEqual(at("第 6 条 逾期每册每天罚款 0.5 元，单册罚款累计不超过该书定价。"), { strict: true, loose: true });
  assert.deepEqual(at("第 3 条 读者凭借书证借书，每证最多同时借 5 册。\n\n第 4 条 借期为 30 天，到期前可以续借一次，续借期 15 天。"), { strict: true, loose: true });
  // 把两条之间的空行压掉了：照规则对不上，去掉空白之后对得上。
  assert.deepEqual(at("第 3 条 读者凭借书证借书，每证最多同时借 5 册。\n第 4 条 借期为 30 天，到期前可以续借一次，续借期 15 天。"), { strict: false, loose: true });
  assert.deepEqual(at("第 6 条 逾期每册每天罚款 0.6 元"), { strict: false, loose: false });
});

/** 造一条会话：任务现状消息；整份读大文档；对知识库 grep（返回被截短）；查找两次；保存两次（一次被拒）。 */
function makeSession(root: string): string {
  const ref = (index: number) => ({ library: "general", name: "借阅规范.md", index });
  const assistant = (at: string, calls: object[], usage: object) => ({ type: "message", id: `a-${at}`, timestamp: `2026-10-08T01:00:${at}.000Z`, message: { role: "assistant", content: calls.map((c) => ({ type: "toolCall", ...c })), usage } });
  const result = (at: string, toolCallId: string, text: string, details: object | null = null, isError = false) => ({ type: "message", id: `r-${at}`, timestamp: `2026-10-08T01:00:${at}.500Z`, message: { role: "toolResult", toolCallId, content: [{ type: "text", text }], details, isError } });
  const source = (excerpt: string, field: string) => ({ kind: "文档原文", locator: "knowledge/general/借阅规范.md", excerpt, supports: [{ field }] });
  const entries = [
    { type: "session", id: "S1", timestamp: "2026-10-08T01:00:00.000Z" },
    { type: "custom_message", customType: "taskwright-task-status", timestamp: "2026-10-08T01:00:00.000Z", content: "任务现状：三份文档。" },
    { type: "message", id: "u1", timestamp: "2026-10-08T01:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "整理成条目。" }] } },
    assistant("02", [
      { id: "c-read", name: "read", arguments: { path: join(root, "general", "files", "馆藏管理办法.md") } },
      { id: "c-read-part", name: "read", arguments: { path: join(root, "general", "files", "馆藏管理办法.md"), offset: 10, limit: 20 } },
      { id: "c-read-small", name: "read", arguments: { path: join(root, "general", "files", "借阅规范.md") } },
      { id: "c-grep", name: "grep", arguments: { pattern: "罚款|逾期", path: root } },
      { id: "c-grep-inputs", name: "grep", arguments: { pattern: "罚款", path: "inputs" } },
    ], { input: 1000, cacheRead: 200, output: 50 }),
    result("02", "c-read", "……"), result("02", "c-read-part", "……"), result("02", "c-read-small", "……"),
    result("02", "c-grep", "……", { capped: { shown_lines: 40, total_lines: 100 } }), result("02", "c-grep-inputs", "inputs/材料.md:2: 逾期罚款按馆里的规定执行。"),
    assistant("03", [
      { id: "c-s1", name: "search_knowledge", arguments: { query: "图书超期不还怎样罚款、上限是多少" } },
      { id: "c-s2", name: "search_knowledge", arguments: { query: "丢失", limit: 5 } },
    ], { input: 3000, cacheRead: 1200, output: 80 }),
    // 第一次查找：第 6 条所在的片段（第 3 个）列给了助手；预约那一章（第 4 个）进了候选，被按字面保底的换掉了，没有进结果。
    result("03", "c-s1", "查找……", { mode: "hybrid", shown: 2, hits: [ref(3), ref(2)], candidates: { semantic: [ref(3), ref(4)], keyword: [ref(3), ref(2)] } }),
    // 第二次查找：第 12 条所在的片段（第 5 个）取中了，却因为超过字节上限没有列给助手（只列了前 1 个）。
    result("03", "c-s2", "查找……", { mode: "keyword", shown: 1, hits: [ref(2), ref(5)], candidates: { semantic: [], keyword: [ref(2), ref(5)] } }),
    assistant("04", [{ id: "c-save-bad", name: "save_revision", arguments: { operations: [{ op: "add", collection: "功能用例", sources: [source("第 6 条 逾期每册每天罚款 0.6 元", "基本流程")] }] } }], { input: 4000, cacheRead: 3000, output: 90 }),
    result("04", "c-save-bad", "什么都没有写入……", null, true),
    assistant("05", [{ id: "c-save", name: "save_revision", arguments: { operations: [{ op: "add", collection: "功能用例", sources: [
      { kind: "文档原文", locator: "inputs/材料.md", excerpt: "逾期罚款按馆里的规定执行。" },
      source("第 6 条 逾期每册每天罚款 0.5 元，单册罚款累计不超过该书定价。", "基本流程"),
      source("第 4 条 借期为 30 天，到期前可以续借一次，续借期 15 天。", "约束规则"),
    ] }] } }], { input: 4200, cacheRead: 3500, output: 120 }),
    result("05", "c-save", "已保存为任务 TASK-1 的修订 1……"),
  ];
  const file = join(tmp, "session.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n不是 JSON 的一行\n");
  return file;
}

test("从一条会话量出各项度量与五级指标：没有查到、查到了没有列出、列出了没有用、用了没有引对、保存成功各自分开", () => {
  const root = makeRoot();
  const entries = sessionEntries(readFileSync(makeSession(root), "utf-8"));
  assert.equal(toolCalls(entries).length, 9);
  const m = measure(entries, { knowledgeRoot: root, expectations: EXPECT, cwd: join(tmp, "tasks", "TASK-1") });
  // 整份读大文档：没有写 limit 的那一次算；写了 limit 20 的不算整份；不到 4 KB 的小文档不计。
  assert.deepEqual(m.large_reads, { whole: 1, calls: [
    { path: "general/馆藏管理办法.md", offset: null, limit: null, whole: true },
    { path: "general/馆藏管理办法.md", offset: 10, limit: 20, whole: false },
  ] });
  // 查找两次，一句完整的话一次；各是怎样找的、列了几个。
  assert.deepEqual([m.searches.count, m.searches.complete_sentences], [2, 1]);
  assert.deepEqual(m.searches.calls.map((one) => [one.query, one.limit, one.complete_sentence, one.mode, one.shown]),
    [["图书超期不还怎样罚款、上限是多少", null, true, "hybrid", 2], ["丢失", 5, false, "keyword", 1]]);
  // grep：对知识库目录一次（材料目录的不算），返回被截短一次，一共两次。
  assert.deepEqual(m.grep, { on_knowledge: 1, capped: 1, total: 2 });
  // 知识库来源三条（材料来源不算）：改了数字的那条不逐字、所在的保存被拒；另两条逐字、保存成功；第 4 条不在期望里。
  assert.deepEqual([m.sources.total, m.sources.strict, m.sources.loose, m.sources.saved], [3, 2, 2, 2]);
  assert.deepEqual(m.sources.rows.map((row) => [row.excerpt.slice(0, 5), row.strict, row.saved, row.expected]),
    [["第 6 条", false, false, null], ["第 6 条", true, true, "E1"], ["第 4 条", true, true, null]]);
  // 五级。E1 一路走到保存成功；E2 进了候选、也取中了，却因为字节上限没有列给助手；E3 进了候选，没有进结果。
  assert.deepEqual(m.levels, [
    { id: "E1", title: "逾期罚款的标准与上限", chunk: 3, candidate: true, returned: true, adopted: true, cited_correctly: true, saved: true },
    { id: "E2", title: "丢失图书的赔偿", chunk: 5, candidate: true, returned: false, adopted: false, cited_correctly: false, saved: false },
    { id: "E3", title: "预约图书的保留期", chunk: 4, candidate: true, returned: false, adopted: false, cited_correctly: false, saved: false },
  ]);
  assert.deepEqual(m.level_totals, { expected: 3, candidate: 3, returned: 1, adopted: 1, cited_correctly: 1, saved: 1 });
  // 总量。
  assert.deepEqual(m.totals, { tool_calls: 9, model_requests: 4, max_context: 7700, seconds: 5.5, status_message_bytes: Buffer.byteLength("任务现状：三份文档。", "utf-8") });
  const lines = summaryLines(m);
  assert.equal(lines[0], "期望的规定 3 处：进了候选 3，列给了助手 1，助手采用了 1，引用得对 1，保存成功 1。");
  assert.ok(lines.includes("  E2 丢失图书的赔偿：进了候选，没有列给助手。"));
});

test("五级的另外几种情形：期望的字段没有指对算引用得不对；期望里的那句话在知识库里找不到时五级都是假；没有查找时都没有进候选", () => {
  const root = makeRoot();
  const entries = sessionEntries(readFileSync(makeSession(root), "utf-8"));
  const wrongField = measure(entries, { knowledgeRoot: root, expectations: [{ ...EXPECT[0], field: "约束规则" }] });
  assert.deepEqual([wrongField.levels[0].adopted, wrongField.levels[0].cited_correctly, wrongField.levels[0].saved], [true, false, false]);
  assert.ok(summaryLines(wrongField).includes("  E1 逾期罚款的标准与上限：采用了，引用得不对。"));
  const gone = measure(entries, { knowledgeRoot: root, expectations: [{ id: "X", title: "没有的规定", document: "借阅规范.md", sentence: "馆里没有这一条" }, { id: "Y", title: "没有的文档", document: "不在.md", sentence: "一句" }] });
  assert.deepEqual(gone.levels.map((row) => [row.chunk, row.candidate, row.returned, row.adopted, row.saved]), [[null, false, false, false, false], [null, false, false, false, false]]);
  const quiet = measure([], { knowledgeRoot: root, expectations: EXPECT });
  assert.deepEqual([quiet.level_totals.candidate, quiet.totals.tool_calls, quiet.totals.seconds], [0, 0, null]);
});

test("离线比较：每种办法在各个 limit 下有几处进了结果、几处进了候选；没有数字串时各办法都退到只按字面；保底的名次与倒数排名融合可以调", () => {
  // 四个片段；数字串是二维的，查询与第 1、2 个片段方向相同。
  const v = (x: number, y: number) => Float32Array.from([x, y]);
  const entries: CompareEntry[] = [
    { document: "规范.md", index: 1, heading: null, text: "罚款按日计算。", vector: v(1, 0) },
    { document: "规范.md", index: 2, heading: null, text: "罚款与续借。", vector: v(0.8, 0.6) },
    { document: "规范.md", index: 3, heading: null, text: "第 8 条 寄回期限是七天。", vector: v(0, 1) },
    { document: "规范.md", index: 4, heading: null, text: "第 9 条 验收时限是三天。", vector: v(0, 1) },
  ];
  const queries = [{ query: "罚款 第8条 寄回期限", vector: v(1, 0), expect: [{ document: "规范.md", sentence: "寄回期限是七天" }, { document: "规范.md", sentence: "罚款按日计算" }, { document: "规范.md", sentence: "语料里没有的一句" }] }];
  const got = compare(entries, queries, [1, 2], methods([1, 2], { k: 60, top: 5 }));
  assert.deepEqual(got.missing, [{ query: "罚款 第8条 寄回期限", document: "规范.md", sentence: "语料里没有的一句" }]);
  const cell = (method: string, limit: number) => {
    const row = got.rows.find((one) => one.method === method && one.limit === limit)!;
    return [row.places, row.candidate, row.returned];
  };
  // 只按意思：第 8 条那个片段按意思排最后，进不来。
  assert.deepEqual([cell("只按意思", 1), cell("只按意思", 2)], [[2, 1, 1], [2, 1, 1]]);
  // 只按字面：第 8 条那个片段排第 1。
  assert.deepEqual(cell("只按字面", 1), [2, 1, 1]);
  // 候选与保底：limit 1 时第 8 条进了候选、没有进结果（第 1 名不换）；limit 2 时两处都进了结果。
  assert.deepEqual([cell("候选与保底（按字面前 2 名）", 1), cell("候选与保底（按字面前 2 名）", 2)], [[2, 2, 1], [2, 2, 2]]);
  assert.deepEqual(cell("候选与保底（按字面前 1 名）", 2), [2, 2, 2]);
  assert.deepEqual(got.rows.map((row) => row.method).filter((name, i, all) => all.indexOf(name) === i),
    ["只按意思", "只按字面", "候选与保底（按字面前 1 名）", "候选与保底（按字面前 2 名）", "倒数排名融合（k=60，每路前 5 名）"]);
  // 没有数字串：按意思一路是空的，候选与保底退到只按字面。
  const plain = compare(entries.map((entry) => ({ ...entry, vector: null })), queries.map((q) => ({ ...q, vector: null })), [1], methods([2], null));
  assert.deepEqual(plain.rows.map((row) => [row.method, row.returned]), [["只按意思", 0], ["只按字面", 1], ["候选与保底（按字面前 2 名）", 1]]);
  // 倒数排名融合：两路都排第 1 的在最前。
  assert.deepEqual(reciprocalRankFusion([0, 1, 2], [0, 2, 1], 60, 3), [0, 1, 2]);
  assert.deepEqual(reciprocalRankFusion([0, 1], [2, 1], 60, 2), [1, 0, 2]);
  // 表格：每格是进了结果的处数，括号里是进了候选的处数。
  assert.equal(compareTable(got.rows, [1, 2]).split("\n")[0], "| 办法 | limit 1 | limit 2 |");
  assert.ok(compareTable(got.rows, [1, 2]).includes("| 候选与保底（按字面前 2 名） | 1（2） | 2（2） |"));
});
