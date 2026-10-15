/**
 * 总体分析由事实算出来的几样（src/lib/overall_analysis.ts，都只算、不读库）：待核实、因依据而待核实、词表与提到、最低门要看的事实。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OVERALL_COLLECTION, type PlainItem, basisPending, gateFact, hasOverall, isSupplement, isUsable, mentionedIn, mentionsOf,
  pageFacts, sentencesOf, topicWords, verificationOf, viewedIn,
} from "../src/lib/overall_analysis.ts";

const COLLECTIONS = [
  { name: "功能用例", fields: [{ name: "用例名称", type: "文本" }, { name: "基本流程", type: "文本列表" }, { name: "句式", type: "枚举" }] },
  { name: OVERALL_COLLECTION, fields: [{ name: "标题", type: "文本" }, { name: "别名", type: "文本列表" }, { name: "它是什么", type: "文本" },
    { name: "例子", type: "文本列表" }, { name: "已经定下的", type: "文本列表" }, { name: "标签", type: "文本列表" }, { name: "状态", type: "枚举" }] },
];
const page = (id: string, fields: Record<string, unknown>, revision = 1): PlainItem =>
  ({ item_id: id, collection: OVERALL_COLLECTION, revision_no: revision, fields: { 状态: "在用", ...fields } });
const useCase = (id: string, fields: Record<string, unknown>): PlainItem => ({ item_id: id, collection: "功能用例", revision_no: 1, fields });

test("待核实：当前修订上还在的助手补充都待核实；这一段修订里用户看过一次就是确认整个条目，之后自己再改也不丢", () => {
  assert.deepEqual([isSupplement("助手补充"), isSupplement("执行者补充"), isSupplement("用户的话"), isSupplement(null)], [true, true, false, false]);
  const saved = (viewed = false) => ({ byUser: false, viewed });
  const edited = (viewed = false) => ({ byUser: true, viewed });
  const supplements = [[{ field: "已经定下的", index: 1 }], [{ field: "例子", index: 0 }, { field: "它是什么" }]];
  const pending = { pending_verification: true, pending_sources: 2,
    pending_places: [{ field: "已经定下的", index: 1 }, { field: "例子", index: 0 }, { field: "它是什么", index: null }] };
  const clear = { pending_verification: false, pending_sources: 0, pending_places: [] };
  // 助手补充了两条，用户还没有确认：两条都待核实，各处都列出来。
  assert.deepEqual(verificationOf(supplements, [saved()]), pending);
  // 用户亲手改过（改的是哪里不在这里判：他改写的那几处在保存时已经从来源里去掉，还在的就是他没有改到的）：仍待核实。
  assert.deepEqual(verificationOf(supplements, [saved(), edited(), edited()]), pending);
  // 用户在这一段的某次修订上看过（或点了确认）：整个条目都确认了，之后自己再改也不丢。
  assert.deepEqual(verificationOf(supplements, [saved(true)]), clear);
  assert.deepEqual(verificationOf(supplements, [saved(true), edited()]), clear);
  assert.deepEqual(verificationOf(supplements, [saved(), edited(true), edited()]), clear);
  // 没有助手补充的来源：看没看过都不待核实。
  assert.deepEqual(verificationOf([], [saved()]), clear);
  // 没有写支持哪几处的助手补充指整个条目。
  assert.deepEqual(verificationOf([[]], [saved()]), { pending_verification: true, pending_sources: 1, pending_places: [{ field: null, index: null }] });
  // 两条来源指到同一处：那一处只列一次，来源仍是两条。
  assert.deepEqual(verificationOf([[{ field: "例子", index: 0 }], [{ field: "例子", index: 0 }]], [saved()]),
    { pending_verification: true, pending_sources: 2, pending_places: [{ field: "例子", index: 0 }] });
});

test("因依据而待核实：依据的那一页已废弃、待核实或者用户还没有看过；只看总体分析的页，只看一层，没有的是 null", () => {
  const pages: Record<string, { collection: string; fields: Record<string, unknown>; pending: boolean; viewed: boolean }> = {
    "OA-001": { collection: OVERALL_COLLECTION, fields: { 状态: "在用" }, pending: false, viewed: true },
    "OA-002": { collection: OVERALL_COLLECTION, fields: { 状态: "在用" }, pending: true, viewed: false },
    "OA-003": { collection: OVERALL_COLLECTION, fields: { 状态: "已废弃", 改看: ["OA-001"] }, pending: true, viewed: false },
    "OA-004": { collection: OVERALL_COLLECTION, fields: { 状态: "已废弃" }, pending: false, viewed: true },
    "OA-005": { collection: OVERALL_COLLECTION, fields: { 状态: "在用" }, pending: false, viewed: false },
    "UC-009": { collection: "功能用例", fields: {}, pending: true, viewed: false },
  };
  const at = (id: string) => pages[id] ?? null;
  const cite = (...ids: string[]) => ids.map((locator) => ({ kind: "条目", locator }));
  assert.equal(basisPending(cite("OA-001"), at), null);
  assert.deepEqual(basisPending(cite("OA-001", "OA-002"), at), { item_id: "OA-002", reason: "pending", see: null });
  // 没有待核实的内容（全部照抄材料），但用户还没有看过：也算，原因另写一种。
  assert.deepEqual(basisPending(cite("OA-001", "OA-005"), at), { item_id: "OA-005", reason: "unviewed", see: null });
  // 一页同时待核实又没看过时报待核实；几条来源里按先后报头一处。
  assert.deepEqual(basisPending(cite("OA-005", "OA-002"), at), { item_id: "OA-005", reason: "unviewed", see: null });
  // 已废弃排在待核实前面说：那一页不该再被依据了。
  assert.deepEqual(basisPending(cite("OA-003"), at), { item_id: "OA-003", reason: "deprecated", see: "OA-001" });
  // 依据的图：用户还没有看过它现在的内容时也算，编号是图的编号；看过的、已经不在的（查不到）不算；不给查图的办法时不看图。
  const figures: Record<string, { viewed: boolean }> = { "D-001": { viewed: true }, "D-002": { viewed: false } };
  const figure = (id: string) => figures[id] ?? null;
  const draw = (...ids: string[]) => ids.map((locator) => ({ kind: "图", locator }));
  assert.equal(basisPending(draw("D-001", "D-009"), at, figure), null);
  assert.deepEqual(basisPending(draw("D-001", " D-002 "), at, figure), { item_id: "D-002", reason: "unviewed", see: null });
  assert.equal(basisPending(draw("D-002"), at), null);
  // 页与图混着写时照来源的先后报头一处。
  assert.deepEqual(basisPending([...draw("D-002"), ...cite("OA-002")], at, figure), { item_id: "D-002", reason: "unviewed", see: null });
  assert.deepEqual(basisPending([...cite("OA-002"), ...draw("D-002")], at, figure), { item_id: "OA-002", reason: "pending", see: null });
  assert.deepEqual(basisPending(cite("OA-004"), at), { item_id: "OA-004", reason: "deprecated", see: null });
  // 别的集合的条目待核实不传过来；已经删除或不存在的页不算；别的种类的来源不看。
  assert.equal(basisPending(cite("UC-009", "OA-999"), at), null);
  assert.equal(basisPending([{ kind: "文档原文", locator: "OA-002" }, { kind: "助手补充", locator: "" }], at), null);
});

test("词表：贴了标签、在用的页的标题与别名；没有标签的、已废弃的不进；两页写了同一个词两条都在", () => {
  const items = [
    page("OA-001", { 标题: "预约取书", 别名: ["预约", " 预留 ", ""], 标签: ["概念", "流程"] }),
    page("OA-002", { 标题: "保留期", 标签: ["概念"] }),
    page("OA-003", { 标题: "排队等书" }),                                  // 没有标签：还是草稿
    page("OA-004", { 标题: "旧的说法", 标签: ["概念"], 状态: "已废弃" }),
    page("OA-005", { 标题: "预留", 标签: ["概念"] }),                      // 与 OA-001 的别名相同
    useCase("UC-001", { 用例名称: "预约图书" }),
  ];
  assert.deepEqual(topicWords(items).map((w) => [w.word, w.item_id]),
    [["预约取书", "OA-001"], ["预约", "OA-001"], ["预留", "OA-001"], ["保留期", "OA-002"], ["预留", "OA-005"]]);
  assert.deepEqual([isUsable(items[0].fields), isUsable(items[2].fields), isUsable(items[3].fields)], [true, false, false]);
});

test("按句切开：句号、问号、叹号、分号与换行各算一句的结尾，标点留在句子里", () => {
  assert.deepEqual(sentencesOf("读者预约。馆员取书；放到预留架！\n过了保留期呢？没人取"), ["读者预约。", "馆员取书；", "放到预留架！", "过了保留期呢？", "没人取"]);
  assert.deepEqual(sentencesOf("  \n "), []);
});

test("一句话里的提到：最长的词优先，一句里同一页只记一次，自己不记，英文词要前后不是字母数字", () => {
  const words = [
    { word: "预约取书", item_id: "OA-001" }, { word: "预约", item_id: "OA-002" }, { word: "保留期", item_id: "OA-003" },
    { word: "ID", item_id: "OA-004" }, { word: "预留", item_id: "OA-005" }, { word: "预留", item_id: "OA-006" },
  ];
  // 「预约取书」整个被认走，里面的「预约」不再算给 OA-002。
  assert.deepEqual(mentionedIn("读者办了预约取书，过了保留期没来。", words), [["OA-001", "预约取书"], ["OA-003", "保留期"]]);
  // 单独出现的「预约」算给 OA-002；同一句里出现两次只记一次。
  assert.deepEqual(mentionedIn("先预约，再预约一次，然后预约取书。", words), [["OA-002", "预约"], ["OA-001", "预约取书"]]);
  // 自己的词在自己的文字里不记，但照样占位：OA-001 自己的句子里「预约取书」不会被拆出一个「预约」来。
  assert.deepEqual(mentionedIn("预约取书是读者对在架的书办的预约。", words, "OA-001"), [["OA-002", "预约"]]);
  // 两页写了同一个词：两页都记。
  assert.deepEqual(mentionedIn("书放在预留架上。", words), [["OA-005", "预留"], ["OA-006", "预留"]]);
  // 英文与数字的词：VALID 里的 ID 不算，单独的 ID 算，紧挨着汉字的也算。
  assert.deepEqual(mentionedIn("VALID 标记与 ID2 都不是。", words), []);
  assert.deepEqual(mentionedIn("读者的ID，就是借书证号（ID）。", words), [["OA-004", "ID"]]);
  // 中文没有分词：短的词会在别的词里被认出来，这是认不了的情形。
  assert.deepEqual(mentionedIn("请填写预约单。", words), [["OA-002", "预约"]]);
});

test("整个任务的提到：扫主题页的三块与别的条目的文字字段，按被提到的页归好，带起点、字段、第几项、原句与被提到页现在的修订号", () => {
  const items = [
    page("OA-001", { 标题: "预约取书", 别名: ["预约"], 标签: ["流程"], 它是什么: "读者对在架的书办预约取书。书留在预留架上的这段时间叫保留期。",
      例子: ["小王周六预约了一本书，周二来取。"], 已经定下的: ["保留期内这本书不能借给别人。"] }, 4),
    page("OA-002", { 标题: "保留期", 标签: ["概念"], 它是什么: "预约取书的书在预留架上留着的那几天。", 已经定下的: ["保留期是 3 天。", "闭馆日顺延；预约取书不受影响。"] }, 2),
    page("OA-003", { 标题: "排队等书", 它是什么: "书还在别人手上时登记排队，与预约取书不是一回事。" }),
    useCase("UC-001", { 用例名称: "预约图书", 基本流程: ["读者选一本在架的书", "读者办预约取书；系统记下保留期"], 句式: "保留期" }),
  ];
  const all = mentionsOf(COLLECTIONS, items);
  assert.deepEqual([...all.keys()].sort(), ["OA-001", "OA-002"]);
  assert.deepEqual(all.get("OA-001"), [
    { item_id: "OA-002", collection: OVERALL_COLLECTION, field: "它是什么", index: null, word: "预约取书", sentence: "预约取书的书在预留架上留着的那几天。", revision_no: 4 },
    { item_id: "OA-002", collection: OVERALL_COLLECTION, field: "已经定下的", index: 1, word: "预约取书", sentence: "预约取书不受影响。", revision_no: 4 },
    // 没有贴标签的页自己不进词表，但它的文字照样被扫。
    { item_id: "OA-003", collection: OVERALL_COLLECTION, field: "它是什么", index: null, word: "预约取书", sentence: "书还在别人手上时登记排队，与预约取书不是一回事。", revision_no: 4 },
    { item_id: "UC-001", collection: "功能用例", field: "用例名称", index: null, word: "预约", sentence: "预约图书", revision_no: 4 },
    { item_id: "UC-001", collection: "功能用例", field: "基本流程", index: 1, word: "预约取书", sentence: "读者办预约取书；", revision_no: 4 },
  ]);
  // 标题、别名、标签这些字段不扫；枚举字段不扫；自己提到自己不算。
  assert.deepEqual(all.get("OA-002")!.map((m) => [m.item_id, m.field, m.index, m.sentence, m.revision_no]), [
    ["OA-001", "它是什么", null, "书留在预留架上的这段时间叫保留期。", 2],
    ["OA-001", "已经定下的", 0, "保留期内这本书不能借给别人。", 2],
    ["UC-001", "基本流程", 1, "系统记下保留期", 2],
  ]);
});

test("没有总体分析集合的任务（0.4 建的）没有词表，也没有提到", () => {
  const old = [{ name: "领域说明", fields: [{ name: "标题", type: "文本" }, { name: "内容", type: "文本" }] }, COLLECTIONS[0]];
  assert.equal(hasOverall(old), false);
  const items = [{ item_id: "DN-001", collection: "领域说明", revision_no: 1, fields: { 标题: "预约", 内容: "预约就是预约。" } }, useCase("UC-001", { 用例名称: "预约图书" })];
  assert.deepEqual(topicWords(items), []);
  assert.equal(mentionsOf(old, items).size, 0);
  // 有这个集合而没有一页贴了标签：也没有。
  assert.equal(mentionsOf(COLLECTIONS, [page("OA-001", { 标题: "预约" }), useCase("UC-001", { 用例名称: "预约图书" })]).size, 0);
});

test("最低门要看的事实：至少一页在用的主题贴了标签、有例子、用户看过；过不去时说出差的是什么", () => {
  const facts = (id: string, fields: Record<string, unknown>, viewed: boolean, pending = false) => pageFacts(id, { 状态: "在用", ...fields }, pending, viewed);
  /** 过不去时的事实层；过得去是 null。 */
  const gate = (pages: Parameters<typeof gateFact>[0]) => gateFact(pages)?.fact ?? null;
  assert.equal(gate([]), "还没有用户看过的主题：总体分析里还没有一页主题");
  // 有页，用户看过，没有例子。
  assert.equal(gate([facts("OA-001", { 标签: ["概念"] }, true)]),
    "还没有用户看过的主题：总体分析里还没有一页贴了标签、写了例子、用户又看过的主题（最接近的是 OA-001，它还没有例子）");
  // 有页有例子、全部照抄材料所以不待核实，但用户没有看过：过不去。待不待核实不在这道门里。
  assert.match(gate([facts("OA-001", { 标签: ["概念"], 例子: ["小王周六预约了一本书。"] }, false)])!, /最接近的是 OA-001，它用户还没有看过）$/);
  assert.match(gate([facts("OA-001", { 标签: ["概念"], 例子: ["小王周六预约了一本书。"] }, false, true)])!, /最接近的是 OA-001，它用户还没有看过）$/);
  // 差得最少的那一页被点名；已废弃的页不算。
  assert.match(gate([facts("OA-001", {}, false), facts("OA-002", { 例子: ["一个例子"] }, true), facts("OA-003", { 标签: ["概念"], 例子: ["例"], 状态: "已废弃" }, true)])!,
    /最接近的是 OA-002，它还没有贴标签）$/);
  assert.match(gate([facts("OA-001", {}, false)])!, /最接近的是 OA-001，它还没有贴标签、还没有例子、用户还没有看过）$/);
  assert.equal(gate([facts("OA-009", { 标签: ["概念"], 例子: ["例"], 状态: "已废弃" }, true)]), "还没有用户看过的主题：总体分析里还没有一页主题");
  // 合格。
  assert.equal(gate([facts("OA-001", {}, false), facts("OA-002", { 标签: ["流程"], 例子: ["小王周六预约了一本书。"] }, true)]), null);
  assert.deepEqual([gateFact([])!.code, gateFact([])!.guidance], ["gate.overall_no_viewed_topic", "先在总体分析里立一页主题、写一个例子，请用户打开那一页看一眼（看过就算确认），再写条目"]);
});

test("用户看没看过：看的是从最近一次助手保存的修订到当前修订这一段；看过之后自己再改仍算，助手再保存就要再看", () => {
  const saved = (viewed = false) => ({ byUser: false, viewed });
  const edited = (viewed = false) => ({ byUser: true, viewed });
  assert.equal(viewedIn([]), false);
  assert.equal(viewedIn([saved()]), false);
  assert.equal(viewedIn([saved(true)]), true);
  assert.equal(viewedIn([saved(true), edited()]), true, "看过之后自己改了标签：仍算看过");
  assert.equal(viewedIn([saved(), edited()]), false, "只是亲手改，没有打开看过或点确认：不算");
  assert.equal(viewedIn([saved(), edited(true)]), true);
});
