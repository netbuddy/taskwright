/**
 * 每个阶段「这一段还差什么」的十二盏灯（src/lib/stage.ts 的 stageLamps，只算不读库）：每盏各有通过、不通过、不适用三种情形。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LAMP_KEYS, type Lamp, type LampInput, type LampItem, type LampPage, STAGES, lampLines, lampPage, lampQuestion, stageLamps,
} from "../src/lib/stage.ts";

const page = (id: string, over: Partial<LampPage> = {}): LampPage =>
  ({ item_id: id, title: `主题${id}`, aliases: [], tags: [], deprecated: false, parent: null, examples: [], viewed: false, ...over });
const item = (id: string, over: Partial<LampItem> = {}): LampItem => ({ item_id: id, collection: "功能用例", cites: [], pending: false, ...over });
const input = (over: Partial<LampInput> = {}): LampInput => ({
  pages: [], items: [], questions: [], collections: ["功能用例", "非功能需求", "约束", "问题", "总体分析"], materials: [], citedDocuments: [],
  mentions: new Map(), review: { failing: [], any: false }, completion: { satisfied: false, unmet: ["「功能用例」至少一个条目：还没有条目。"] }, ...over,
});
/** 按键取一盏灯。 */
function lampOf(key: string, given: Partial<LampInput>): Lamp {
  const found = Object.values(stageLamps(input(given))).flat().find((one) => one.key === key);
  assert.ok(found, key);
  return found;
}
const brief = (one: Lamp) => [one.ok, one.items];

test("十二盏灯按阶段分组，键与次序固定；什么都没有的任务里「每个某某页都……」的灯是不适用", () => {
  const lamps = stageLamps(input());
  assert.deepEqual(Object.keys(lamps), [...STAGES]);
  assert.deepEqual(Object.values(lamps).flat().map((one) => one.key), [...LAMP_KEYS]);
  assert.deepEqual(Object.fromEntries(Object.entries(lamps).map(([stage, list]) => [stage, list.map((one) => one.key)])), {
    reading: ["materials_cited"],
    clarifying: ["tagged_pages_no_open_questions", "decisions_have_goal"],
    modeling: ["flows_have_exception", "roles_mentioned_by_flows", "no_duplicate_titles", "no_untagged_pages"],
    writing: ["flows_backed_by_use_cases", "basis_pages_viewed", "no_pending_items"],
    reviewing: ["reviews_no_open_findings", "completion_met"],
  });
  // 空任务：前十盏都不适用；评审与完成条件两盏不通过。
  assert.deepEqual(Object.values(lamps).flat().map((one) => one.ok), [null, null, null, null, null, null, null, null, null, null, false, false]);
  for (const one of Object.values(lamps).flat()) assert.match(one.summary, /。$/, `${one.key} 的说明是一句完整的话`);
});

test("materials_cited：每份材料都被至少一页主题或一条问题引用；出处带位置的去掉位置再比", () => {
  const materials = ["inputs/需求.md", "inputs/访谈.docx", "inputs/制度.pdf"];
  assert.deepEqual(brief(lampOf("materials_cited", { materials, citedDocuments: ["inputs/需求.md", "inputs/访谈.docx#p12", "inputs/制度.pdf#p3-2", "kb:general/术语表.md"] })), [true, []]);
  const missing = lampOf("materials_cited", { materials, citedDocuments: ["inputs/需求.md"] });
  assert.deepEqual(brief(missing), [false, ["inputs/访谈.docx", "inputs/制度.pdf"]]);
  assert.equal(missing.summary, "有 2 份材料还没有被任何一页主题或问题引用：inputs/访谈.docx、inputs/制度.pdf。");
  assert.deepEqual([lampOf("materials_cited", {}).ok, lampOf("materials_cited", {}).summary], [null, "任务里没有材料。"]);
});

test("tagged_pages_no_open_questions：贴了标签的页没有挂着未解决的待澄清问题", () => {
  const pages = [page("OA-001", { tags: ["流程"] }), page("OA-002", { tags: ["概念"] }), page("OA-003"), page("OA-004", { tags: ["概念"], deprecated: true })];
  const q = (id: string, open: boolean, related: string[]) => ({ item_id: id, open, related });
  // 挂在没贴标签的页、已废弃的页上的，与已经解决的，都不算。
  assert.deepEqual(brief(lampOf("tagged_pages_no_open_questions", { pages, questions: [q("TBD-001", true, ["OA-003"]), q("TBD-002", false, ["OA-001"]), q("TBD-003", true, ["OA-004"])] })), [true, []]);
  const asked = lampOf("tagged_pages_no_open_questions", { pages, questions: [q("TBD-001", true, ["OA-001"]), q("TBD-002", true, ["OA-001", "OA-002"])] });
  assert.deepEqual(brief(asked), [false, ["OA-001", "OA-002"]]);
  assert.equal(asked.summary, "有 2 页贴了标签的主题还挂着未解决的待澄清问题：OA-001（TBD-001、TBD-002）、OA-002（TBD-002）。");
  assert.equal(lampOf("tagged_pages_no_open_questions", { pages: [page("OA-001")] }).ok, null);
});

test("decisions_have_goal：每个决定页的上级主题是一页目标页", () => {
  const goal = page("OA-001", { tags: ["目标"] });
  const ok = [goal, page("OA-002", { tags: ["决定"], parent: "OA-001" })];
  assert.deepEqual(brief(lampOf("decisions_have_goal", { pages: ok })), [true, []]);
  // 没有上级、上级不是目标页、上级不存在：都不算。
  const bad = [goal, page("OA-002", { tags: ["决定"] }), page("OA-003", { tags: ["决定"], parent: "OA-002" }), page("OA-004", { tags: ["决定"], parent: "OA-099" }),
    page("OA-005", { tags: ["决定"], parent: "OA-001" })];
  const out = lampOf("decisions_have_goal", { pages: bad });
  assert.deepEqual(brief(out), [false, ["OA-002", "OA-003", "OA-004"]]);
  assert.match(out.summary, /^有 3 页标签为「决定」的主题没有标签为「目标」的上级主题：OA-002、OA-003、OA-004。在「它是什么」里写了为什么的也算说清了，这一点程序认不出，要自己看。$/);
  assert.equal(lampOf("decisions_have_goal", { pages: [goal] }).ok, null);
});

test("flows_have_exception：每个流程页至少有一条以「例外：」开头的例子；反例不算", () => {
  const withException = page("OA-001", { tags: ["流程"], examples: ["小王周六借了一本书。", "例外：借书证过期的读者不能借。"] });
  assert.deepEqual(brief(lampOf("flows_have_exception", { pages: [withException, page("OA-002", { tags: ["概念"] })] })), [true, []]);
  const smooth = lampOf("flows_have_exception", { pages: [withException, page("OA-002", { tags: ["流程"], examples: ["反例：这种不算。", "说到例外：也不算。"] }), page("OA-003", { tags: ["流程", "概念"] })] });
  assert.deepEqual(brief(smooth), [false, ["OA-002", "OA-003"]]);
  assert.equal(smooth.summary, "有 2 页标签为「流程」的主题还没有以「例外：」开头的例子：OA-002、OA-003。");
  assert.equal(lampOf("flows_have_exception", { pages: [page("OA-001", { tags: ["概念"] })] }).ok, null);
});

test("roles_mentioned_by_flows：每个角色页被至少一个流程页或场景页提到；别的页与条目提到不算", () => {
  const pages = [page("OA-001", { tags: ["角色"] }), page("OA-002", { tags: ["角色"] }), page("OA-003", { tags: ["流程"] }), page("OA-004", { tags: ["场景"] }), page("OA-005", { tags: ["概念"] })];
  const mention = (...ids: string[]) => ids.map((item_id) => ({ item_id }));
  assert.deepEqual(brief(lampOf("roles_mentioned_by_flows", { pages, mentions: new Map([["OA-001", mention("OA-003")], ["OA-002", mention("UC-001", "OA-004")]]) })), [true, []]);
  const idle = lampOf("roles_mentioned_by_flows", { pages, mentions: new Map([["OA-001", mention("OA-005", "UC-001")]]) });
  assert.deepEqual(brief(idle), [false, ["OA-001", "OA-002"]]);
  assert.equal(idle.summary, "有 2 页标签为「角色」的主题没有被任何标签为「流程」或「场景」的主题提到：OA-001、OA-002。");
  assert.equal(lampOf("roles_mentioned_by_flows", { pages: [pages[2]] }).ok, null);
});

test("no_duplicate_titles 与 no_untagged_pages：在用的页之间比标题与别名、看有没有贴标签；已废弃的页不算", () => {
  const clean = [page("OA-001", { title: "预约", aliases: ["预留"], tags: ["概念"] }), page("OA-002", { title: "读者", tags: ["角色"] }),
    page("OA-003", { title: "预约", deprecated: true })];
  assert.deepEqual([brief(lampOf("no_duplicate_titles", { pages: clean })), brief(lampOf("no_untagged_pages", { pages: clean }))], [[true, []], [true, []]]);
  const messy = [page("OA-001", { title: "预约", aliases: ["预留"], tags: ["概念"] }), page("OA-002", { title: "预留" }), page("OA-003", { title: "预约取书", aliases: ["预约"] })];
  const clash = lampOf("no_duplicate_titles", { pages: messy });
  assert.deepEqual(brief(clash), [false, ["OA-001", "OA-003", "OA-002"]]);
  assert.equal(clash.summary, "有 2 个标题或别名被两页以上的主题用了：「预约」（OA-001、OA-003）、「预留」（OA-001、OA-002）。");
  const loose = lampOf("no_untagged_pages", { pages: messy });
  assert.deepEqual(brief(loose), [false, ["OA-002", "OA-003"]]);
  assert.equal(loose.summary, "有 2 页主题还没有贴标签：OA-002、OA-003。");
  assert.deepEqual([lampOf("no_duplicate_titles", {}).ok, lampOf("no_untagged_pages", {}).ok], [null, null]);
});

test("flows_backed_by_use_cases：每个流程页与场景页被至少一条用例依据；别的集合的条目依据不算；没有功能用例集合时不适用", () => {
  const pages = [page("OA-001", { tags: ["流程"] }), page("OA-002", { tags: ["场景"] }), page("OA-003", { tags: ["概念"] })];
  assert.deepEqual(brief(lampOf("flows_backed_by_use_cases", { pages, items: [item("UC-001", { cites: ["OA-001"] }), item("UC-002", { cites: ["OA-002", "OA-003"] })] })), [true, []]);
  const unbacked = lampOf("flows_backed_by_use_cases", { pages, items: [item("UC-001", { cites: ["OA-001"] }), item("NFR-001", { collection: "非功能需求", cites: ["OA-002"] })] });
  assert.deepEqual(brief(unbacked), [false, ["OA-002"]]);
  assert.equal(unbacked.summary, "有 1 页标签为「流程」或「场景」的主题还没有用例依据它：OA-002。");
  assert.equal(lampOf("flows_backed_by_use_cases", { pages: [pages[2]] }).ok, null);
  const other = lampOf("flows_backed_by_use_cases", { pages, collections: ["用例", "问题", "总体分析"] });
  assert.deepEqual([other.ok, other.summary], [null, "这个任务没有「功能用例」这个集合。"]);
});

test("basis_pages_viewed 与 no_pending_items：条目依据的页用户都看过；没有待核实的条目", () => {
  const pages = [page("OA-001", { viewed: true }), page("OA-002"), page("OA-003")];
  const good = [item("UC-001", { cites: ["OA-001"] }), item("NFR-001", { collection: "非功能需求", cites: ["UC-001"] }), item("TBD-001", { collection: "问题" })];
  assert.deepEqual([brief(lampOf("basis_pages_viewed", { pages, items: good })), brief(lampOf("no_pending_items", { pages, items: good }))], [[true, []], [true, []]]);
  const bad = [item("UC-001", { cites: ["OA-001", "OA-002"], pending: true }), item("UC-002", { cites: ["OA-003", "OA-002"] }), item("CON-001", { collection: "约束", pending: true })];
  const blind = lampOf("basis_pages_viewed", { pages, items: bad });
  assert.deepEqual(brief(blind), [false, ["UC-001", "UC-002"]]);
  assert.equal(blind.summary, "有 2 个条目依据的主题用户还没有看过：UC-001、UC-002（没看过的主题是 OA-002、OA-003）。");
  const pending = lampOf("no_pending_items", { pages, items: bad });
  assert.deepEqual(brief(pending), [false, ["UC-001", "CON-001"]]);
  assert.equal(pending.summary, "有 2 个条目待核实：UC-001、CON-001。");
  // 没有条目依据主题页、总体分析以外没有条目：不适用。
  assert.deepEqual([lampOf("basis_pages_viewed", { pages, items: [item("UC-001")] }).ok, lampOf("no_pending_items", { pages }).ok], [null, null]);
});

test("reviews_no_open_findings 与 completion_met：评审没有未处理的发现；完成条件全部满足", () => {
  assert.deepEqual([lampOf("reviews_no_open_findings", {}).ok, lampOf("reviews_no_open_findings", {}).summary], [false, "还没有评审过。"]);
  assert.deepEqual(brief(lampOf("reviews_no_open_findings", { review: { failing: [], any: true } })), [true, []]);
  const failing = lampOf("reviews_no_open_findings", { review: { failing: ["UC-002", "NFR-001"], any: true } });
  assert.deepEqual(brief(failing), [false, ["UC-002", "NFR-001"]]);
  assert.equal(failing.summary, "有 2 个条目评审不合规、还没有处理：UC-002、NFR-001。");
  assert.deepEqual(brief(lampOf("completion_met", { completion: { satisfied: true, unmet: [] } })), [true, []]);
  const unmet = lampOf("completion_met", { completion: { satisfied: false, unmet: ["「功能用例」每个条目评审通过：还差 UC-002。", "「问题」没有状态为未解决的条目：还差 TBD-001。"] } });
  assert.equal(unmet.summary, "还有 2 条完成条件没有满足：「功能用例」每个条目评审通过：还差 UC-002。；「问题」没有状态为未解决的条目：还差 TBD-001。");
});

test("从字段内容取算灯要的几样：一页主题、一条问题", () => {
  assert.deepEqual(lampPage("OA-002", { 标题: " 预约取书 ", 别名: ["预约 ", ""], 标签: ["流程", "概念"], 上级主题: ["OA-001"], 例子: ["例外：书丢了。"], 状态: "已废弃" }, true),
    { item_id: "OA-002", title: "预约取书", aliases: ["预约"], tags: ["流程", "概念"], deprecated: true, parent: "OA-001", examples: ["例外：书丢了。"], viewed: true });
  assert.deepEqual(lampPage("OA-003", { 标题: "读者", 状态: "在用" }, false),
    { item_id: "OA-003", title: "读者", aliases: [], tags: [], deprecated: false, parent: null, examples: [], viewed: false });
  const q = (fields: Record<string, unknown>) => lampQuestion("TBD-001", fields, "状态");
  assert.deepEqual(q({ 种类: "待澄清", 状态: "未解决", 关联条目: ["OA-001", "UC-002"] }), { item_id: "TBD-001", open: true, related: ["OA-001", "UC-002"] });
  assert.deepEqual([q({ 种类: "范围外", 状态: "未解决" }).open, q({ 种类: "待澄清", 状态: "已解决" }).open, q({ 种类: "待澄清", 状态: "用户决定保留" }).open], [false, false, false]);
  // 集合没有「种类」这个字段时只看状态。
  assert.deepEqual(q({ 状态: "未解决" }), { item_id: "TBD-001", open: true, related: [] });
});

test("「这一段还差什么」的几行：不通过的灯各一句；都通过或不适用时写一句都齐了", () => {
  const lamps = stageLamps(input({ pages: [page("OA-001", { tags: ["流程"] }), page("OA-002")] }));
  assert.deepEqual(lampLines("modeling", lamps.modeling), [
    "整理建模这一段还差 2 项：",
    "  - 有 1 页标签为「流程」的主题还没有以「例外：」开头的例子：OA-001。",
    "  - 有 1 页主题还没有贴标签：OA-002。",
  ]);
  assert.deepEqual(lampLines("reading", lamps.reading), ["核读材料这一段的几项都齐了。"]);
});
