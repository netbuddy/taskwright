/**
 * 需求资产六类的现状、前置条件与给页面的活动目录（lib/activity_catalog.ts）：只算不读库，事实是算灯用的那一份。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CATALOG_LATER, type AssetFacts, assetCells, assetFacts, blockedByStage, blockedText, catalog, conditionMet } from "../src/lib/activity_catalog.ts";
import { CONDITIONS } from "../src/lib/activity_def.ts";
import { definitions } from "../src/lib/activity_def_read.ts";
import { IDLE, type LampDiagram, type LampInput, type LampItem, type LampPage, type LampQuestion, STAGES } from "../src/lib/stage.ts";

const page = (id: string, more: Partial<LampPage> = {}): LampPage => ({
  item_id: id, title: id, aliases: [], tags: ["流程"], deprecated: false, parent: null, examples: [], viewed: true, settled: 0, stateful: false, intro: null,
  what: true, pending: false, marked: false, ...more,
});
const item = (id: string, more: Partial<LampItem> = {}): LampItem => ({ item_id: id, collection: "功能用例", cites: [], citesDiagrams: [], pending: false, viewed: true, ...more });
const question = (id: string, open: boolean): LampQuestion => ({ item_id: id, open, related: [], unresolved: open, blocking: false });
const diagram = (id: string, viewed: boolean): LampDiagram => ({ diagram_id: id, kind: "flowchart", sources: [], drawn: [], linked: [], branches: true, viewed });
const input = (more: Partial<LampInput> = {}): LampInput => ({
  pages: [], items: [], questions: [], collections: ["总体分析", "功能用例", "问题"], materials: [], citedDocuments: [], diagrams: [], ruleConflicts: [],
  review: { failing: [], any: false, rounds: 0 }, completion: { satisfied: false, unmet: [] }, ...more,
});
const EMPTY: AssetFacts = {
  materials: 0, materialsUnread: 0, sections: 0, sectionsPending: 0, openQuestions: 0, diagrams: 0, diagramsUnviewed: 0,
  items: 0, itemsUnread: 0, itemsPending: 0, itemsConfirmed: 0, reviewRounds: 0, openFindings: 0, versions: 0,
};
const DEFS = definitions();
const cellsOf = (facts: AssetFacts) => Object.fromEntries(assetCells(facts, DEFS.activities).map((one) => [one.key, [one.text, one.note]]));

test("空任务：六类都是零，材料来自上传所以没有产出它的活动，别的各写由哪些活动产出", () => {
  assert.deepEqual(assetFacts(input()), EMPTY);
  const cells = assetCells(EMPTY, DEFS.activities);
  assert.deepEqual(cells.map((one) => [one.key, one.name, one.count, one.unit, one.text, one.note]), [
    ["materials", "材料与证据", 0, "份", "0 份", ""], ["description", "业务说明", 0, "节", "0 节", ""], ["models", "分析模型", 0, "张", "0 张", ""],
    ["items", "需求条目", 0, "条", "0 条", ""], ["review", "评审与确认", 0, "轮", "未评审", ""], ["versions", "文档与版本", 0, "版", "未发布", ""]]);
  assert.deepEqual(cells.map((one) => one.produced_by), [[], ["核读材料", "澄清", "整理建模", "编写文档"], ["整理建模"], ["写条目", "评审确认"], ["评审确认"], ["编写文档", "发布"]]);
});

test("材料与证据：份数；没有被任何一节或问题引用的算未核读，引用里 # 后面的位置不看", () => {
  const facts = assetFacts(input({ materials: ["inputs/甲.md", "inputs/乙.docx"], citedDocuments: ["inputs/甲.md#p3"] }));
  assert.deepEqual([facts.materials, facts.materialsUnread], [2, 1]);
  assert.deepEqual(cellsOf(facts).materials, ["2 份", "1 份未核读"]);
  assert.deepEqual(cellsOf({ ...facts, materialsUnread: 0 }).materials, ["2 份", "均已核读"]);
});

test("业务说明：节数只数在用的主题页，已废弃的页与章的导语页不数；待澄清数的是没有了结的待澄清问题", () => {
  const facts = assetFacts(input({
    pages: [page("OA-001"), page("OA-002", { tags: [] }), page("OA-003", { deprecated: true }), page("OA-004", { tags: [], intro: "业务流程" }), page("OA-005", { pending: true })],
    questions: [question("Q-001", true), question("Q-002", false)],
  }));
  assert.deepEqual([facts.sections, facts.sectionsPending, facts.openQuestions], [3, 1, 1]);
  assert.deepEqual(cellsOf(facts).description, ["3 节", "1 处待澄清"]);
  assert.deepEqual(cellsOf({ ...facts, openQuestions: 0 }).description, ["3 节", "无待澄清事项"]);
});

test("分析模型：张数与没有看过的张数", () => {
  const facts = assetFacts(input({ diagrams: [diagram("D-001", true), diagram("D-002", false), diagram("D-003", false)] }));
  assert.deepEqual([facts.diagrams, facts.diagramsUnviewed], [3, 2]);
  assert.deepEqual(cellsOf(facts).models, ["3 张", "2 未查看"]);
  assert.deepEqual(cellsOf({ ...facts, diagramsUnviewed: 0 }).models, ["3 张", "均已查看"]);
});

test("需求条目：问题条目不算；没看过的算未读，待核实的另数；看过而且不待核实的才算已确认", () => {
  const facts = assetFacts(input({
    items: [item("UC-001"), item("UC-002", { viewed: false }), item("UC-003", { pending: true }), item("UC-004", { viewed: false, pending: true }), item("Q-001", { collection: "问题", viewed: false })],
    questions: [question("Q-001", true)],
  }));
  assert.deepEqual([facts.items, facts.itemsUnread, facts.itemsPending, facts.itemsConfirmed], [4, 2, 2, 1]);
  assert.deepEqual(cellsOf(facts).items, ["4 条", "2 未读 · 2 待核实"]);
  assert.deepEqual(cellsOf({ ...facts, itemsPending: 0 }).items, ["4 条", "2 未读"]);
  assert.deepEqual(cellsOf({ ...facts, itemsUnread: 0, itemsPending: 0 }).items, ["4 条", "均已确认"]);
});

test("评审与确认、文档与版本：没有评审过写未评审，评审过写轮数与未处理的条数；没有发布过写未发布", () => {
  const facts = assetFacts(input({ review: { failing: ["UC-001", "UC-002"], any: true, rounds: 3 } }));
  assert.deepEqual([facts.reviewRounds, facts.openFindings], [3, 2]);
  assert.deepEqual(cellsOf(facts).review, ["3 轮", "2 未处理"]);
  assert.deepEqual(cellsOf({ ...facts, openFindings: 0 }).review, ["3 轮", "无未处理发现"]);
  // 没有给轮数的调用方：有过评审记录当作一轮。
  assert.equal(assetFacts(input({ review: { failing: [], any: true } })).reviewRounds, 1);
  assert.deepEqual(cellsOf({ ...EMPTY, versions: 2 }).versions, ["第 2 版", ""]);
});

test("前置条件只看数据：每一个各自什么时候满足，缺的时候说缺什么", () => {
  assert.deepEqual(CONDITIONS.filter((one) => conditionMet(one, EMPTY)), ["diagrams_viewed", "confirmations_clear"], "空任务：一张图都没有算都看过，也没有待确认的内容");
  const full: AssetFacts = { ...EMPTY, materials: 1, sections: 2, diagrams: 1, items: 3, itemsConfirmed: 1, reviewRounds: 1, versions: 1 };
  assert.deepEqual(CONDITIONS.filter((one) => !conditionMet(one, full)), []);
  assert.equal(blockedText(["has_pages", "diagrams_viewed"], { ...full, sections: 0, diagramsUnviewed: 2 }), "业务说明还没有内容；有 2 张分析模型还没有查看");
  assert.equal(blockedText(["no_open_findings"], { ...full, reviewRounds: 0 }), "还没有评审过");
  assert.equal(blockedText(["no_open_findings"], { ...full, openFindings: 2 }), "评审还有 2 条未处理");
  assert.equal(blockedText(["confirmations_clear"], { ...full, itemsUnread: 1 }), "还有待确认的内容");
  assert.equal(blockedText([], EMPTY), null);
  assert.deepEqual(STAGES.map((one) => blockedByStage(DEFS.activities, EMPTY)[one]),
    ["还没有项目材料", null, "业务说明还没有内容", "业务说明还没有内容", "还没有需求条目", "还没有已确认的需求条目"]);
  assert.deepEqual(STAGES.map((one) => blockedByStage(DEFS.activities, full)[one]), [null, null, null, null, null, null]);
});

test("活动目录：空任务只有澄清与首次分析能开展；首次分析推荐，从澄清开始；发布与需求变更写缺什么", () => {
  const got = catalog(DEFS, EMPTY, { position: IDLE, inFlow: false, flowNode: null });
  assert.deepEqual(got.activities.map((one) => [one.key, one.enabled, one.state]), [
    ["reading", false, "还没有项目材料"], ["clarifying", true, "可以开展"], ["modeling", false, "业务说明还没有内容"], ["writing", false, "业务说明还没有内容"],
    ["reviewing", false, "还没有需求条目"], ["document", false, "还没有已确认的需求条目"], ["publish", false, "还没有评审过"]]);
  assert.ok(got.activities.every((one) => one.recommended === false));
  const writing = got.activities[3];
  assert.deepEqual([writing.name, writing.mode, writing.mode_name, writing.reads, writing.writes, writing.prerequisite_text], ["写条目", "batch", "批处理",
    [{ key: "description", name: "业务说明" }, { key: "models", name: "分析模型" }], [{ key: "items", name: "需求条目" }], "前置条件：业务说明至少一节，分析模型均已查看。"]);
  assert.deepEqual(got.activities[0].reads, [{ key: "materials", name: "材料与证据" }, { key: "knowledge", name: "知识库" }]);
  assert.deepEqual(got.activities[5].reads, [{ key: "all", name: "全部资产" }]);
  assert.equal(got.activities[1].prerequisite_text, "无前置条件；可从空白开始。");
  assert.deepEqual(got.flows.map((one) => [one.key, one.name, one.enabled, one.state, one.recommended, one.at, one.start]), [
    ["initial", "首次分析", true, "可以开展", true, null, "clarifying"], ["change", "需求变更", false, "还没有已发布的版本", false, null, null]]);
  assert.deepEqual(got.flows[0].nodes.map((one) => one.name), ["核读材料", "澄清", "整理建模", "写条目", "评审确认", "编写文档", "发布"]);
  assert.equal(got.flows[1].prerequisite_text, "前置条件：存在已发布的版本。");
  // 有材料：首次分析从核读材料开始。
  assert.equal(catalog(DEFS, { ...EMPTY, materials: 1 }, { position: IDLE, inFlow: false, flowNode: null }).flows[0].start, "reading");
});

test("活动目录：流程里正在做的那一项不能同时单独开展；单独开展着的那一项写正在进行；流程走过就从走到的那一站接着", () => {
  const facts: AssetFacts = { ...EMPTY, materials: 1, sections: 2, items: 3, itemsConfirmed: 3, reviewRounds: 1 };
  const inFlow = catalog(DEFS, facts, { position: "writing", inFlow: true, flowNode: "writing" });
  assert.deepEqual(inFlow.activities.map((one) => [one.enabled, one.state]), [[true, "可以开展"], [true, "可以开展"], [true, "可以开展"], [false, "正在工作流程中进行"],
    [true, "可以开展"], [true, "可以开展"], [false, CATALOG_LATER]]);
  assert.deepEqual([inFlow.flows[0].enabled, inFlow.flows[0].state, inFlow.flows[0].at, inFlow.flows[0].start], [false, "正在进行", "writing", "writing"]);
  const alone = catalog(DEFS, facts, { position: "clarifying", inFlow: false, flowNode: "writing" });
  assert.deepEqual(alone.activities.filter((one) => !one.enabled).map((one) => [one.key, one.state]), [["clarifying", "正在进行"], ["publish", CATALOG_LATER]]);
  assert.deepEqual([alone.flows[0].enabled, alone.flows[0].state, alone.flows[0].at, alone.flows[0].start], [true, "可以开展", "writing", "writing"]);
  // 发布过版本之后推荐的是需求变更；它现在还不能开展。
  const released = catalog(DEFS, { ...facts, versions: 1 }, { position: IDLE, inFlow: false, flowNode: "document" });
  assert.deepEqual(released.flows.map((one) => [one.recommended, one.enabled, one.state]), [[false, true, "可以开展"], [true, false, CATALOG_LATER]]);
});
