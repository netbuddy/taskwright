/**
 * 每个阶段「这一段还差什么」的二十一盏灯（src/lib/stage.ts 的 stageLamps，只算不读库）：每盏各有通过、不通过、不适用三种情形。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LAMP_KEYS, type Lamp, type LampDiagram, type LampInput, type LampItem, type LampPage, type LampQuestion, REPORT_ONLY_LAMPS, STAGES, hasPendingMark, lampLines, lampPage, lampQuestion, stageLamps,
} from "../src/lib/stage.ts";

const page = (id: string, over: Partial<LampPage> = {}): LampPage =>
  ({ item_id: id, title: `主题${id}`, aliases: [], tags: [], deprecated: false, parent: null, examples: [], viewed: false, settled: 0, stateful: false,
    intro: null, what: true, pending: false, marked: false, ...over });
const item = (id: string, over: Partial<LampItem> = {}): LampItem => ({ item_id: id, collection: "功能用例", cites: [], citesDiagrams: [], pending: false, ...over });
const diagram = (id: string, kind: string, over: Partial<LampDiagram> = {}): LampDiagram =>
  ({ diagram_id: id, kind, sources: [], drawn: [], linked: [], branches: false, viewed: false, ...over });
const input = (over: Partial<LampInput> = {}): LampInput => ({
  pages: [], items: [], questions: [], collections: ["功能用例", "非功能需求", "约束", "问题", "业务说明"], materials: [], citedDocuments: [],
  diagrams: [], ruleConflicts: [], review: { failing: [], any: false }, completion: { satisfied: false, unmet: ["「功能用例」至少一个条目：还没有条目。"] }, ...over,
});
/** 按键取一盏灯。 */
function lampOf(key: string, given: Partial<LampInput>): Lamp {
  const found = Object.values(stageLamps(input(given))).flat().find((one) => one.key === key);
  assert.ok(found, key);
  return found;
}
const brief = (one: Lamp) => [one.ok, one.items];

test("二十一盏灯按阶段分组，键与次序固定；什么都没有的任务里「每个某某页都……」的灯是不适用", () => {
  const lamps = stageLamps(input());
  assert.deepEqual(Object.keys(lamps), [...STAGES]);
  assert.deepEqual(Object.values(lamps).flat().map((one) => one.key), [...LAMP_KEYS]);
  assert.deepEqual(Object.fromEntries(Object.entries(lamps).map(([stage, list]) => [stage, list.map((one) => one.key)])), {
    reading: ["materials_cited"],
    clarifying: ["tagged_pages_no_open_questions", "decisions_have_goal"],
    modeling: ["roles_in_context_and_use_cases", "concepts_related_in_class", "flows_have_flowchart_with_branch", "stateful_concepts_have_state",
      "no_duplicate_titles", "no_untagged_pages", "rules_no_conflict"],
    writing: ["flows_backed_by_use_cases", "basis_pages_viewed", "basis_diagrams_viewed", "no_pending_items", "no_blocking_questions", "no_pending_marks"],
    reviewing: ["reviews_no_open_findings", "completion_met"],
    document: ["chapters_have_intro", "glossary_complete", "document_no_blocking_questions"],
  });
  // 空任务：评审与完成条件两盏不通过，别的十九盏都不适用。
  assert.equal(LAMP_KEYS.length, 21);
  assert.deepEqual(Object.values(lamps).flat().map((one) => one.ok), [...Array(16).fill(null), false, false, null, null, null]);
  for (const one of Object.values(lamps).flat()) assert.match(one.summary, /。$/, `${one.key} 的说明是一句完整的话`);
});

test("materials_cited：只报数、不判（恒为 null）——各份材料的块数与有引用的块数，页按标签分，例子总数，问题条目按种类分", () => {
  assert.ok(REPORT_ONLY_LAMPS.has("materials_cited"));
  const materials = ["inputs/需求.md", "inputs/访谈.docx", "inputs/制度.pdf"];
  const coverage = [
    { path: "inputs/需求.md", blocks: null, cited_blocks: null, citations: 3 },
    { path: "inputs/访谈.docx", blocks: 12, cited_blocks: 9, citations: 0 },
  ];
  const pages = [page("OA-001", { tags: ["流程"], examples: ["甲", "例外：乙"] }), page("OA-002", { tags: ["角色", "流程"], examples: ["丙"] }), page("OA-003"),
    page("OA-004", { tags: ["概念"], examples: ["丁"], deprecated: true })];
  const questions = [question("TBD-001", { kind: "待澄清" }), question("TBD-002", { kind: "冲突" }), question("TBD-003", { kind: "待澄清" }), question("TBD-004")];
  const all = lampOf("materials_cited", { materials, coverage, citedDocuments: ["inputs/需求.md", "inputs/访谈.docx#p12"], pages, questions });
  assert.deepEqual(brief(all), [null, []]);
  assert.equal(all.summary, "只报数、不判：材料 3 份：inputs/需求.md 被引用 3 处；inputs/访谈.docx 共 12 块，9 块有引用、3 块没有；inputs/制度.pdf 没有引用。"
    + "页 3 页（按标签：流程 2、角色 1；没贴标签的 1 页），例子共 3 项。问题条目 4 条（待澄清 2、冲突 1、没写种类 1）。");
  // 没有材料、没有页、没有问题：照样只报数。
  assert.deepEqual(brief(lampOf("materials_cited", {})), [null, []]);
  assert.equal(lampOf("materials_cited", {}).summary, "只报数、不判：任务里没有材料。页 0 页，例子共 0 项。问题条目 0 条。");
  // 没有给块数时按出处说有没有引用（出处带位置的去掉位置再比）。
  assert.match(lampOf("materials_cited", { materials, citedDocuments: ["inputs/制度.pdf#p3-2"] }).summary, /inputs\/需求\.md 没有引用；inputs\/访谈\.docx 没有引用；inputs\/制度\.pdf 有引用。/);
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

test("roles_in_context_and_use_cases：每个角色页的编号都写在系统边界图与用例图里；说明里逐页写缺的是哪一种图", () => {
  const pages = [page("OA-001", { tags: ["角色"] }), page("OA-002", { tags: ["角色"] }), page("OA-003", { tags: ["角色"] }), page("OA-004", { tags: ["角色"] }),
    page("OA-005", { tags: ["概念"] }), page("OA-006", { tags: ["角色"], deprecated: true })];
  const all = ["OA-001", "OA-002", "OA-003", "OA-004"];
  assert.deepEqual(brief(lampOf("roles_in_context_and_use_cases", { pages, diagrams: [diagram("D-001", "context", { drawn: all }), diagram("D-002", "use_case", { drawn: [...all, "OA-005"] })] })), [true, []]);
  // 两张用例图合起来画全了也算；别的种类的图里写了不算。
  assert.deepEqual(brief(lampOf("roles_in_context_and_use_cases", { pages, diagrams: [diagram("D-001", "context", { drawn: all }),
    diagram("D-002", "use_case", { drawn: ["OA-001", "OA-002"] }), diagram("D-003", "use_case", { drawn: ["OA-003", "OA-004"] })] })), [true, []]);
  const partly = lampOf("roles_in_context_and_use_cases", { pages, diagrams: [diagram("D-001", "context", { drawn: ["OA-001", "OA-002"] }),
    diagram("D-002", "use_case", { drawn: ["OA-001", "OA-003"] }), diagram("D-003", "flowchart", { drawn: all })] });
  assert.deepEqual(brief(partly), [false, ["OA-002", "OA-003", "OA-004"]]);
  assert.equal(partly.summary, "有 3 页标签为「角色」的主题还没有同时画进系统边界图与用例图：OA-002（用例图里没有）、OA-003（系统边界图里没有）、OA-004（两种图里都没有）。");
  assert.deepEqual(brief(lampOf("roles_in_context_and_use_cases", { pages: [pages[0]] })), [false, ["OA-001"]]);
  assert.deepEqual([lampOf("roles_in_context_and_use_cases", { pages: [pages[4], pages[5]] }).ok, lampOf("roles_in_context_and_use_cases", { pages: [pages[4]] }).summary], [null, "还没有标签为「角色」的主题。"]);
});

test("concepts_related_in_class：每个概念页在对象关系图里至少有一条连线；只画了没有连线不算；一张对象关系图都没有时说明里先说这一句", () => {
  const pages = [page("OA-001", { tags: ["概念"] }), page("OA-002", { tags: ["概念", "流程"] }), page("OA-003", { tags: ["角色"] })];
  assert.deepEqual(brief(lampOf("concepts_related_in_class", { pages, diagrams: [diagram("D-001", "class", { drawn: ["OA-001", "OA-002"], linked: ["OA-001", "OA-002"] })] })), [true, []]);
  const alone = lampOf("concepts_related_in_class", { pages, diagrams: [diagram("D-001", "class", { drawn: ["OA-001", "OA-002"], linked: ["OA-001"] }), diagram("D-002", "flowchart", { linked: ["OA-002"] })] });
  assert.deepEqual(brief(alone), [false, ["OA-002"]]);
  assert.equal(alone.summary, "有 1 页标签为「概念」的主题在对象关系图里还没有连线：OA-002。");
  assert.equal(lampOf("concepts_related_in_class", { pages }).summary, "还没有画对象关系图。有 2 页标签为「概念」的主题在对象关系图里还没有连线：OA-001、OA-002。");
  assert.equal(lampOf("concepts_related_in_class", { pages: [pages[2]] }).ok, null);
});

test("flows_have_flowchart_with_branch：每个流程页有一张以它为来源、带判断分叉的流程图；没有图与有图没分叉分开说", () => {
  const pages = [page("OA-001", { tags: ["流程"] }), page("OA-002", { tags: ["流程"] }), page("OA-003", { tags: ["流程"] }), page("OA-004", { tags: ["场景"] })];
  const charts = [diagram("D-001", "flowchart", { sources: ["OA-001", "OA-009"], branches: true }), diagram("D-002", "flowchart", { sources: ["OA-002"] }),
    // 状态图以它为来源、流程图只是在文本里写到它而来源里没有它，都不算。
    diagram("D-003", "state", { sources: ["OA-003"], branches: true }), diagram("D-004", "flowchart", { drawn: ["OA-003"], branches: true })];
  const out = lampOf("flows_have_flowchart_with_branch", { pages, diagrams: charts });
  assert.deepEqual(brief(out), [false, ["OA-002", "OA-003"]]);
  assert.equal(out.summary, "有 2 页标签为「流程」的主题还没有带判断分叉的流程图：OA-002（流程图里没有判断分叉）、OA-003（还没有以它为来源的流程图）。");
  // 一页有两张流程图，其中一张有分叉就算。
  assert.deepEqual(brief(lampOf("flows_have_flowchart_with_branch", { pages: [pages[1]], diagrams: [charts[1], diagram("D-005", "flowchart", { sources: ["OA-002"], branches: true })] })), [true, []]);
  assert.equal(lampOf("flows_have_flowchart_with_branch", { pages: [pages[3]] }).ok, null);
});

test("stateful_concepts_have_state：文字说到状态而没有状态图的概念页是差的；已经画了状态图的概念页算有图，不管文字里说没说到状态；两样都没有才不适用", () => {
  const pages = [page("OA-001", { tags: ["概念"], stateful: true }), page("OA-002", { tags: ["概念"], stateful: true }), page("OA-003", { tags: ["概念"] }),
    page("OA-004", { tags: ["流程"], stateful: true })];
  assert.deepEqual(brief(lampOf("stateful_concepts_have_state", { pages, diagrams: [diagram("D-001", "state", { sources: ["OA-001"] }), diagram("D-002", "state", { sources: ["OA-002"] })] })), [true, []]);
  const missing = lampOf("stateful_concepts_have_state", { pages, diagrams: [diagram("D-001", "state", { sources: ["OA-001"] }), diagram("D-002", "flowchart", { sources: ["OA-002"] })] });
  assert.deepEqual(brief(missing), [false, ["OA-002"]]);
  assert.equal(missing.summary, "有 1 页说到状态的「概念」主题还没有以它为来源的状态图：OA-002。说没说到状态是按字面认的（文字里有「状态」「变成」或者「从……变为……」），认错了的不用画，向用户说明即可。");
  const none = "还没有画了状态图的「概念」主题，也没有哪一页「概念」主题的文字说到状态。";
  assert.deepEqual([lampOf("stateful_concepts_have_state", { pages: [pages[2], pages[3]] }).ok, lampOf("stateful_concepts_have_state", { pages: [pages[2]] }).summary], [null, none]);
  // 文字里没有说到状态的概念页画了状态图：这盏灯通过，不再是不适用。流程页的状态图不算。
  const drawn = lampOf("stateful_concepts_have_state", { pages: [pages[2], pages[3]], diagrams: [diagram("D-001", "state", { sources: ["OA-003"] })] });
  assert.deepEqual([brief(drawn), drawn.summary], [[true, []], "有 1 页「概念」主题画了状态图；文字说到状态的「概念」主题都有状态图。"]);
  assert.equal(lampOf("stateful_concepts_have_state", { pages: [pages[2], pages[3]], diagrams: [diagram("D-001", "state", { sources: ["OA-004"] })] }).ok, null);
  // 一页画了、另一页说到状态而没有画：不通过，差的只列没有画的那一页。
  assert.deepEqual(brief(lampOf("stateful_concepts_have_state", { pages, diagrams: [diagram("D-001", "state", { sources: ["OA-003"] }), diagram("D-002", "state", { sources: ["OA-001"] })] })), [false, ["OA-002"]]);
});

test("rules_no_conflict：规则表里没有还没了结的规则冲突；各页一条「已经定下的」都没有时不适用", () => {
  const pages = [page("OA-001", { settled: 2 }), page("OA-002"), page("OA-003", { settled: 5, deprecated: true })];
  assert.deepEqual(brief(lampOf("rules_no_conflict", { pages })), [true, []]);
  const clash = lampOf("rules_no_conflict", { pages, ruleConflicts: ["TBD-002", "TBD-005"] });
  assert.deepEqual(brief(clash), [false, ["TBD-002", "TBD-005"]]);
  assert.equal(clash.summary, "有 2 处规则冲突还没有了结：TBD-002、TBD-005。");
  // 只有已废弃的页写了「已经定下的」：不适用。
  assert.deepEqual([lampOf("rules_no_conflict", { pages: [pages[1], pages[2]] }).ok, lampOf("rules_no_conflict", {}).summary], [null, "各页主题还没有写「已经定下的」。"]);
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
  // 用例依据一张图、而那张图以这一页为来源，也算；别的集合的条目经图依据不算，图不存在不算。
  const charts = [diagram("D-001", "flowchart", { sources: ["OA-001"] }), diagram("D-002", "use_case", { sources: ["OA-002", "OA-003"] })];
  assert.deepEqual(brief(lampOf("flows_backed_by_use_cases", { pages, diagrams: charts, items: [item("UC-001", { citesDiagrams: ["D-001", "D-002"] })] })), [true, []]);
  assert.deepEqual(brief(lampOf("flows_backed_by_use_cases", { pages, diagrams: charts, items: [item("UC-001", { citesDiagrams: ["D-001", "D-009"] }), item("CON-001", { collection: "约束", citesDiagrams: ["D-002"] })] })),
    [false, ["OA-002"]]);
  assert.equal(lampOf("flows_backed_by_use_cases", { pages: [pages[2]] }).ok, null);
  const other = lampOf("flows_backed_by_use_cases", { pages, collections: ["用例", "问题", "业务说明"] });
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
  // 问题条目即使有助手补写的来源也不算待核实；只有问题条目时不适用。
  const questions = [{ item_id: "TBD-001", open: true, related: [], unresolved: true, blocking: false }];
  const asked = lampOf("no_pending_items", { pages, items: [item("UC-001"), item("TBD-001", { collection: "问题", pending: true })], questions });
  assert.deepEqual(brief(asked), [true, []]);
  const onlyQuestions = lampOf("no_pending_items", { pages, items: [item("TBD-001", { collection: "问题", pending: true })], questions });
  assert.deepEqual([onlyQuestions.ok, onlyQuestions.summary], [null, "还没有需求条目。"]);
  // 没有条目依据主题页、业务说明以外没有条目：不适用。
  assert.deepEqual([lampOf("basis_pages_viewed", { pages, items: [item("UC-001")] }).ok, lampOf("no_pending_items", { pages }).ok], [null, null]);
});

test("basis_diagrams_viewed：条目依据的图用户都看过；没有条目依据图时不适用；用户一张图都没有看过时如实是不通过", () => {
  const charts = [diagram("D-001", "use_case", { viewed: true }), diagram("D-002", "flowchart"), diagram("D-003", "flowchart")];
  const good = [item("UC-001", { citesDiagrams: ["D-001"] }), item("NFR-001", { collection: "非功能需求" })];
  assert.deepEqual(brief(lampOf("basis_diagrams_viewed", { diagrams: charts, items: good })), [true, []]);
  const bad = [item("UC-001", { citesDiagrams: ["D-001", "D-002"] }), item("UC-002", { citesDiagrams: ["D-003", "D-002"] }), item("UC-003", { citesDiagrams: ["D-001"] })];
  const blind = lampOf("basis_diagrams_viewed", { diagrams: charts, items: bad });
  assert.deepEqual(brief(blind), [false, ["UC-001", "UC-002"]]);
  assert.equal(blind.summary, "有 2 个条目依据的图用户还没有看过：UC-001、UC-002（没看过的图是 D-002、D-003）。");
  // 用户一张图都没有看过：不通过，点名每一个依据了图的条目。
  const none = lampOf("basis_diagrams_viewed", { diagrams: charts.map((one) => ({ ...one, viewed: false })), items: bad });
  assert.deepEqual([none.ok, none.items], [false, ["UC-001", "UC-002", "UC-003"]]);
  // 没有条目依据图；依据的图已经不在。
  assert.deepEqual([lampOf("basis_diagrams_viewed", { diagrams: charts, items: [item("UC-001")] }).ok,
    lampOf("basis_diagrams_viewed", { diagrams: charts, items: [item("UC-001", { citesDiagrams: ["D-009"] })] }).summary], [null, "还没有依据图写的条目。"]);
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
    { item_id: "OA-002", title: "预约取书", aliases: ["预约"], tags: ["流程", "概念"], deprecated: true, parent: "OA-001", examples: ["例外：书丢了。"], viewed: true,
      settled: 0, stateful: false, intro: null, what: false, pending: false, marked: false });
  assert.deepEqual(lampPage("OA-003", { 标题: "读者", 状态: "在用", 已经定下的: ["一人一证。", "", "证不外借。"] }, false),
    { item_id: "OA-003", title: "读者", aliases: [], tags: [], deprecated: false, parent: null, examples: [], viewed: false, settled: 2, stateful: false,
      intro: null, what: false, pending: false, marked: false });
  // 导语页、写没写「它是什么」、待核实由调用方给、文字里有没有「待定」标记。
  const intro = lampPage("OA-020", { 标题: "业务流程导语", 它是什么: "这一章讲借书与预约。", 导语所属章: " 业务流程 ", 已经定下的: ["待定：保留期遇闭馆日怎样算"] }, true, true);
  assert.deepEqual([intro.intro, intro.what, intro.pending, intro.marked], ["业务流程", true, true, true]);
  assert.deepEqual([hasPendingMark("待定"), hasPendingMark(" 待定 "), hasPendingMark("待定：借满怎么办"), hasPendingMark(["读者刷证", "待定:超时"]), hasPendingMark({ 扩展流程: ["待定"] }),
    hasPendingMark("这件事有待定夺"), hasPendingMark("期待定下来"), hasPendingMark(null), hasPendingMark('b{"待定：有没有借满"}')], [true, true, true, true, true, false, false, false, true]);
  // 说没说到状态：按字面认「状态」「变成」「从……变为……」，看「它是什么」与「已经定下的」；例子与标题里的不看，「变为」前面没有「从」不认。
  const stateful = (fields: Record<string, unknown>) => lampPage("OA-009", fields, false).stateful;
  assert.deepEqual([
    stateful({ 它是什么: "一条借阅记录有在借、已还、逾期三种状态。" }), stateful({ 已经定下的: ["到期没还的，记录变成逾期。"] }),
    stateful({ 已经定下的: ["还书后记录从在借变为已还。"] }), stateful({ 它是什么: "读者办的一张证。", 例子: ["证的状态是挂失。"], 标题: "状态" }),
    stateful({ 它是什么: "从三月起执行。押金另算，不变为积分。" }),
  ], [true, true, true, false, false]);
  const q = (fields: Record<string, unknown>) => lampQuestion("TBD-001", fields, "状态");
  assert.deepEqual(q({ 种类: "待澄清", 状态: "未解决", 关联条目: ["OA-001", "UC-002"] }), { item_id: "TBD-001", open: true, related: ["OA-001", "UC-002"], unresolved: true, blocking: false, kind: "待澄清" });
  // 未解决不分种类；是否阻断下游只认「阻断下游」这个取值。
  assert.deepEqual([q({ 种类: "范围外", 状态: "未解决", 是否阻断下游: "阻断下游" }).unresolved, q({ 种类: "范围外", 状态: "未解决", 是否阻断下游: "阻断下游" }).blocking,
    q({ 状态: "已解决", 是否阻断下游: "阻断下游" }).unresolved, q({ 状态: "未解决", 是否阻断下游: "不阻断" }).blocking], [true, true, false, false]);
  assert.deepEqual([q({ 种类: "范围外", 状态: "未解决" }).open, q({ 种类: "待澄清", 状态: "已解决" }).open, q({ 种类: "待澄清", 状态: "用户决定保留" }).open], [false, false, false]);
  // 集合没有「种类」这个字段时只看状态。
  assert.deepEqual(q({ 状态: "未解决" }), { item_id: "TBD-001", open: true, related: [], unresolved: true, blocking: false, kind: null });
});

test("「这一段还差什么」的几行：不通过的灯各一句；都通过或不适用时写一句都齐了", () => {
  const lamps = stageLamps(input({ pages: [page("OA-001", { tags: ["流程"] }), page("OA-002")] }));
  assert.deepEqual(lampLines("modeling", lamps.modeling), [
    "整理建模这一段还差 2 项：",
    "  - 有 1 页标签为「流程」的主题还没有带判断分叉的流程图：OA-001（还没有以它为来源的流程图）。",
    "  - 有 1 页主题还没有贴标签：OA-002。",
  ]);
  // 核读材料只有一盏只报数的灯：不说「都齐了」，写它报的数。
  assert.deepEqual(lampLines("reading", lamps.reading), ["核读材料这一段只报数、不判是否做够：", `  - ${lamps.reading[0].summary}`]);
});

// ───────────── 写条目与编写文档新加的五盏 ─────────────

const question = (id: string, over: Partial<LampQuestion> = {}): LampQuestion => ({ item_id: id, open: true, related: [], unresolved: true, blocking: false, ...over });
const DECLARED = { declared: { intro: true, blocking: true } };

test("no_blocking_questions：未了结的阻断下游的问题列出来；不阻断的、已经了结的不算；写条目与编写文档各一盏，判法相同", () => {
  const questions = [question("TBD-001", { blocking: true }), question("TBD-002"), question("TBD-003", { blocking: true, unresolved: false, open: false })];
  for (const key of ["no_blocking_questions", "document_no_blocking_questions"]) {
    assert.deepEqual(brief(lampOf(key, { ...DECLARED, questions })), [false, ["TBD-001"]]);
    assert.equal(lampOf(key, { ...DECLARED, questions }).summary, "有 1 个阻断下游的问题还没有了结：TBD-001。");
    assert.deepEqual(brief(lampOf(key, { ...DECLARED, questions: questions.slice(1) })), [true, []]);
    // 一个问题条目都没有、任务定义里没有这个字段：不适用。
    assert.equal(lampOf(key, { ...DECLARED }).ok, null);
    assert.equal(lampOf(key, { questions }).ok, null);
    assert.equal(lampOf(key, { questions }).summary, "任务定义的问题集合里没有「是否阻断下游」这个字段。");
  }
});

test("no_pending_marks：在用的页、图、条目里标着待定的都列出来；已废弃的页不算；什么都没有时不适用", () => {
  const given = {
    pages: [page("OA-001", { marked: true }), page("OA-002"), page("OA-003", { marked: true, deprecated: true })],
    diagrams: [diagram("D-001", "flowchart", { marked: true }), diagram("D-002", "state")],
    items: [item("UC-001", { marked: true }), item("UC-002")],
  };
  assert.deepEqual(brief(lampOf("no_pending_marks", given)), [false, ["OA-001", "D-001", "UC-001"]]);
  assert.equal(lampOf("no_pending_marks", given).summary, "有 3 处还标着待定：OA-001、D-001、UC-001。");
  assert.deepEqual(brief(lampOf("no_pending_marks", { pages: [page("OA-002")], diagrams: [diagram("D-002", "state")], items: [item("UC-002")] })), [true, []]);
  assert.equal(lampOf("no_pending_marks", {}).ok, null);
});

test("chapters_have_intro：有内容的章都要有一页在用、写了说明的导语页；第 5、7 章看有没有规则、决定与没了结的问题；没有内容的章不要求", () => {
  const pages = [
    page("OA-001", { tags: ["流程"], settled: 2 }), page("OA-002", { tags: ["角色"] }), page("OA-003", { tags: ["决定"] }),
    page("OA-010", { intro: "业务流程" }), page("OA-011", { intro: "角色", what: false }), page("OA-012", { intro: "业务规则", deprecated: true }),
  ];
  const lit = lampOf("chapters_have_intro", { ...DECLARED, pages });
  // 有内容的章：角色、业务流程、业务规则（有已经定下的）、业务目标（决定页归这一章）、决策记录（有决定）。
  // 业务流程有导语；角色的导语没有写说明、业务规则的导语已废弃，都不算。
  assert.deepEqual([lit.ok, lit.summary], [false, "有 4 章还没有导语：「角色」、「业务规则」、「业务目标」、「决策记录与待澄清事项」。"]);
  const all = [...pages, page("OA-013", { intro: "角色" }), page("OA-014", { intro: "业务规则" }), page("OA-015", { intro: "业务目标" }), page("OA-016", { intro: "决策记录与待澄清事项" })];
  assert.equal(lampOf("chapters_have_intro", { ...DECLARED, pages: all }).ok, true);
  // 没有决定、只有一条没了结的问题时，第 7 章也算有内容。
  const seven = lampOf("chapters_have_intro", { ...DECLARED, pages: [page("OA-020", { intro: "角色" }), page("OA-002", { tags: ["角色"] })], questions: [question("TBD-001")] });
  assert.deepEqual([seven.ok, seven.summary], [false, "有 1 章还没有导语：「决策记录与待澄清事项」。"]);
  // 各章都没有内容、任务定义里没有这个字段：不适用。导语页自己不算内容。
  assert.equal(lampOf("chapters_have_intro", { ...DECLARED, pages: [page("OA-010", { intro: "业务流程" })] }).ok, null);
  assert.equal(lampOf("chapters_have_intro", { pages }).summary, "任务定义的业务说明里没有「导语所属章」这个字段。");
});

test("glossary_complete：标签含概念的在用页都写了说明而且不待核实；没有概念页时不适用", () => {
  const pages = [page("OA-001", { tags: ["概念"] }), page("OA-002", { tags: ["概念", "角色"], pending: true }), page("OA-003", { tags: ["概念"], what: false }),
    page("OA-004", { tags: ["概念"], what: false, deprecated: true }), page("OA-005", { tags: ["流程"], pending: true })];
  assert.deepEqual(brief(lampOf("glossary_complete", { pages })), [false, ["OA-002", "OA-003"]]);
  assert.deepEqual(brief(lampOf("glossary_complete", { pages: [pages[0], pages[4]] })), [true, []]);
  assert.equal(lampOf("glossary_complete", { pages: [pages[4]] }).ok, null);
});

test("导语页不贴标签，不算没归类的页", () => {
  assert.deepEqual(brief(lampOf("no_untagged_pages", { pages: [page("OA-001", { tags: ["流程"] }), page("OA-010", { intro: "业务流程" }), page("OA-002")] })), [false, ["OA-002"]]);
  assert.deepEqual(brief(lampOf("no_untagged_pages", { pages: [page("OA-001", { tags: ["流程"] }), page("OA-010", { intro: "业务流程" })] })), [true, []]);
});
