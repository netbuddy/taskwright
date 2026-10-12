/**
 * 整理建模的五种图从头走一遍（真的后端进程与真的 pi，模型换成进程内的假端点；图的 Mermaid 文本由后端真的校验）：
 * 核读材料时助手立四页主题 → 用户在卡片上点进入澄清、再点进入整理建模 → 助手照说明的次序画系统边界图、用例图、对象关系图、
 * 流程图、状态图各一张，来源都写它画自的页 → 整理建模的七盏灯都算得出、都通过 → 用户看过主题页、点「开始写条目」→
 * 助手写一条功能用例，来源是那张用例图与它自己的流程图 → 用户还没有看过图时「条目依据的图用户都看过」不通过，
 * 看了一张仍不通过，两张都看了通过；助手改了其中一张图之后，那条来源标「依据已变」，这盏灯又不通过。
 * 另核对整份数据里的规则表，与整理建模、写条目两次运行里模型收到的说明。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { captureConsole, tempDir } from "./helpers.ts";
import { type Dict, MATERIAL, NO_PI, reply, withStack } from "./consent_stack.ts";

captureConsole();
process.env.PI_OFFLINE = "1";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const FROM_MATERIAL = { kind: "文档原文", locator: "inputs/材料.md", excerpt: MATERIAL };
const page = (fields: Dict, sources: unknown[] = [FROM_MATERIAL]) => ({ op: "add", collection: "总体分析", fields: { 状态: "在用", ...fields }, sources });
/** 四页主题：一页流程、一页角色、两页概念（借阅记录说到了状态；借书证有一条已经定下的规则）。 */
const PAGES = [
  page({ 标题: "自助借书", 它是什么: MATERIAL, 例子: [MATERIAL], 标签: ["流程"] }),
  page({ 标题: "读者", 它是什么: "办了借书证、来馆里借书的人。", 标签: ["角色"] }),
  page({ 标题: "借阅记录", 它是什么: "读者借一本书留下的记录，有在借与已还两种状态。", 标签: ["概念"] }),
  page({ 标题: "借书证", 它是什么: "读者在馆里的身份凭证。", 标签: ["概念"], 已经定下的: ["一人一证。"] },
    [{ ...FROM_MATERIAL, supports: [{ field: "它是什么" }] }, { kind: "助手补充", excerpt: "图书馆通常这样规定，我补了「一人一证。」", supports: [{ field: "已经定下的", index: 0 }] }]),
];
const from = (...ids: string[]) => ids.map((id) => ({ kind: "条目", locator: id }));
/** 五种图各一张，写法照平台说明第十一节：节点文字最前面写页的编号，来源写它画自的页。 */
const DIAGRAMS = [
  { name: "系统边界", kind: "context", sources: from("OA-002"),
    mermaid: 'flowchart LR\n  reader(["OA-002 读者"])\n  subgraph sys["图书馆系统"]\n    kiosk["自助借书"]\n  end\n  reader -- 借书证 --> kiosk' },
  { name: "读者用例", kind: "use_case", sources: from("OA-002", "OA-001"),
    mermaid: 'flowchart LR\n  reader(["OA-002 读者"])\n  subgraph 图书馆系统\n    borrow(["OA-001 自助借书"])\n  end\n  reader --> borrow' },
  { name: "对象关系", kind: "class", sources: from("OA-003", "OA-004"),
    mermaid: 'classDiagram\n  class Loan["OA-003 借阅记录"]\n  class Card["OA-004 借书证"]\n  Card "1" --> "0..*" Loan : 留下' },
  { name: "自助借书的流程", kind: "flowchart", sources: from("OA-001"),
    mermaid: 'flowchart TD\n  a(["OA-001 自助借书"]) --> b{"借书证有没有过期"}\n  b -- 没有 --> c["记下借阅"]\n  b -- 过期 --> d["拒绝借书"]' },
  { name: "借阅记录的状态", kind: "state", sources: from("OA-003"),
    mermaid: 'stateDiagram-v2\n  state "OA-003 在借" as s1\n  [*] --> s1\n  s1 --> 已还 : 还书' },
];
const draw = (n: number) => ({ tool_calls: [{ id: `call-d${n + 1}`, name: "save_diagram", arguments: DIAGRAMS[n] }] });
const USE_CASE = { op: "add", collection: "功能用例",
  fields: { 用例名称: "自助借书", 用例功能: "读者在自助机上借书。", 参与者: ["读者"], 基本流程: ["读者刷借书证", "记下借阅"], 扩展流程: ["借书证过期时拒绝借书"] },
  sources: [
    { kind: "图", locator: "D-002", excerpt: "OA-001 自助借书", supports: [{ field: "用例名称" }, { field: "用例功能" }, { field: "参与者" }] },
    { kind: "图", locator: "D-004", excerpt: "记下借阅", supports: [{ field: "基本流程" }, { field: "扩展流程" }] },
  ] };
const card = (text: string, enter: [string, string], stay: [string, string]) =>
  ({ kind: "choose", text, items: [{ item_id: "OA-001", revision_no: 1 }], options: [{ key: enter[0], text: enter[1] }, { key: stay[0], text: stay[1] }] });
const SCRIPT = {
  rules: [],
  sequence: [
    // 第一句话（核读材料）：立四页主题，发「进入澄清」的卡片。
    { tool_calls: [{ id: "call-pages", name: "save_revision", arguments: { operations: PAGES } }] },
    reply("材料读完了，我立了四页主题。现在进入澄清吗？", "call-clarify", card("现在进入澄清吗？", ["enter_clarify", "进入澄清"], ["continue_reading", "再核读一遍"])),
    // 用户点了「进入澄清」：发「进入整理建模」的卡片。
    reply("要问的都问到了。现在进入整理建模吗？", "call-model", card("现在进入整理建模吗？", ["enter_consolidate", "进入整理建模"], ["continue_clarify", "继续澄清"])),
    // 用户点了「进入整理建模」：照次序画五种图，汇报，发「开始写条目」的卡片。
    draw(0), draw(1), draw(2), draw(3), draw(4),
    reply("五种图各画了一张：系统边界图、用例图、对象关系图、自助借书的流程图、借阅记录的状态图。角色与概念都进了图，规则没有冲突。请把这几张图看一遍。现在开始写条目吗？",
      "call-start", card("图画好了，现在开始写条目吗？", ["start_items", "开始写条目"], ["continue_consolidate", "再整理一遍"])),
    // 用户点了「开始写条目」：写一条依据两张图的用例。
    { tool_calls: [{ id: "call-uc", name: "save_revision", arguments: { operations: [USE_CASE] } }] },
    reply("写好了一个用例：UC-001 自助借书。", "call-wrote"),
    // 用户说流程图少了一步：助手改图。
    { tool_calls: [{ id: "call-redraw", name: "save_diagram", arguments: { diagram: "D-004", base_revision: 1,
      mermaid: `${DIAGRAMS[3].mermaid}\n  c --> e["打印借书凭条"]` } }] },
    reply("流程图加上了打印凭条这一步。", "call-redrawn"),
  ],
};

/** 一个请求里的系统消息的文字。 */
function systemText(request: Dict): string {
  const system = (request["请求体"].messages as Dict[]).find((m) => m.role === "system" || m.role === "developer");
  if (!system) return "";
  return typeof system.content === "string" ? system.content : (system.content as Dict[]).map((p) => p.text ?? "").join("");
}

test("整理建模画出五种图、七盏灯都通过；写条目依据两张图，「依据的图用户都看过」随用户看图与助手改图而变", { skip: NO_PI, timeout: 180000 }, () =>
  withStack(tmp, "models", SCRIPT, async ({ call, taskId, session, db, send, action, entryOfCall, requests }) => {
    const snapshot = async () => (await call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${session}`)).body.task as Dict;
    const lamps = async (stage: string) => Object.fromEntries(((await snapshot()).stage.lamps[stage] as Dict[]).map((one) => [one.key, one.ok]));
    const click = (callId: string, choice: string, text: string) =>
      send({ text: `我选：${text}`, client_id: `c-${choice}`, origin: "card_choice", card: { reply_message_id: entryOfCall(callId), kind: "choose", choice } });
    let seen = 0;
    /** 上次核对之后模型新收到的请求里的系统提示。 */
    const prompts = () => {
      const fresh = requests().slice(seen).map(systemText);
      seen = requests().length;
      return fresh;
    };

    // 核读材料：立四页主题。整理建模的灯这时还差四项（图一张都没有）。
    await send({ text: "把材料整理成需求规格说明。", client_id: "c-1" });
    assert.deepEqual(db("SELECT item_id FROM item ORDER BY rowid").map((r: Dict) => r.item_id), ["OA-001", "OA-002", "OA-003", "OA-004"]);
    assert.deepEqual(await lamps("modeling"), {
      roles_in_context_and_use_cases: false, concepts_related_in_class: false, flows_have_flowchart_with_branch: false, stateful_concepts_have_state: false,
      no_duplicate_titles: true, no_untagged_pages: true, rules_no_conflict: true,
    });
    await click("call-clarify", "enter_clarify", "进入澄清");
    prompts();

    // 整理建模：助手一口气画五种图。每张图都过了后端真的 Mermaid 校验，来源写的是它画自的页。
    await click("call-model", "enter_consolidate", "进入整理建模");
    const modeling = prompts();
    assert.ok(modeling.length >= 6, `整理建模这次运行至少有 6 个请求，实际 ${modeling.length} 个`);
    for (const text of modeling) {
      assert.ok(text.includes("# 现在这个阶段：整理建模\n") && text.includes("1. **先画系统边界图（context）。**"), "整理建模的那一段是新写的");
      assert.ok(text.includes("这一段你主动画图，不等用户提出，也不用先提议"));
      assert.ok(text.includes("整理建模阶段例外：这一段你主动把五种图画出来"), "共用部分第十一节写了这一段的例外");
    }
    assert.deepEqual(db("SELECT tool_name, fact FROM tool_rejection"), [], "五张图都一次存上，没有被拦");
    const task = await snapshot();
    assert.deepEqual((task.diagrams as Dict[]).map((one) => [one.diagram_id, one.kind, one.kind_name, one.revision_no, one.viewed]), [
      ["D-001", "context", "系统边界图", 1, false], ["D-002", "use_case", "用例图", 1, false], ["D-003", "class", "对象关系图", 1, false],
      ["D-004", "flowchart", "流程图", 1, false], ["D-005", "state", "状态图", 1, false],
    ]);
    assert.deepEqual(db("SELECT item_id, locator FROM item_source WHERE element_kind = '图' ORDER BY item_id, position").map((r: Dict) => `${r.item_id}←${r.locator}`),
      ["D-001←OA-002", "D-002←OA-002", "D-002←OA-001", "D-003←OA-003", "D-003←OA-004", "D-004←OA-001", "D-005←OA-003"]);
    assert.deepEqual(await lamps("modeling"), {
      roles_in_context_and_use_cases: true, concepts_related_in_class: true, flows_have_flowchart_with_branch: true, stateful_concepts_have_state: true,
      no_duplicate_titles: true, no_untagged_pages: true, rules_no_conflict: true,
    });
    // 整份数据里的规则表：借书证那一页的一条规则，出处是助手补的那一条来源，没有冲突。
    assert.deepEqual((task.overall_views.rules.rows as Dict[]).map((row) => [row.item_id, row.title, row.text, row.sources.map((s: Dict) => s.kind), row.conflicts]),
      [["OA-004", "借书证", "一人一证。", ["助手补充"], []]]);
    assert.deepEqual([task.overall_views.goals, task.overall_views.decisions], [{ roots: [], loose: [] }, []]);

    // 用户看过流程那一页，点「开始写条目」：助手写一条依据用例图与流程图的用例。
    assert.equal((await action({ kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 1 }] })).status, 200);
    await click("call-start", "start_items", "开始写条目");
    const writing = prompts();
    for (const text of writing) {
      assert.ok(text.includes("# 现在这个阶段：写条目\n") && text.includes("1. **照图写条目。**") && text.includes("2. **每条功能用例的来源写两张图。**"), "写条目那一次运行带着任务类型的对应");
    }
    assert.deepEqual(db("SELECT tool_name, fact FROM tool_rejection"), []);
    const sourcesOf = async () => ((await snapshot()).items as Dict[]).find((one) => one.item_id === "UC-001")!.sources
      .map((s: Dict) => [s.kind, s.locator, s.excerpt, s.depends_revision, s.current_revision, s.stale]);
    assert.deepEqual(await sourcesOf(), [["图", "D-002", "OA-001 自助借书", 1, 1, null], ["图", "D-004", "记下借阅", 1, 1, null]]);
    // 流程页经图被用例依据；用例没有直接依据主题页；用户还没有看过任何一张图，依据的图那一盏不通过。
    assert.deepEqual(await lamps("writing"), { flows_backed_by_use_cases: true, basis_pages_viewed: null, basis_diagrams_viewed: false, no_pending_items: true });

    // 用户看了用例图：还差流程图；两张都看了：通过。
    assert.equal((await action({ kind: "mark_diagram_viewed", targets: [{ diagram_id: "D-002", base_revision: 1 }] })).status, 200);
    assert.equal((await lamps("writing")).basis_diagrams_viewed, false);
    assert.equal((await action({ kind: "mark_diagram_viewed", targets: [{ diagram_id: "D-004", base_revision: 1 }] })).status, 200);
    assert.equal((await lamps("writing")).basis_diagrams_viewed, true);
    assert.deepEqual(((await snapshot()).diagrams as Dict[]).filter((one) => one.viewed).map((one) => one.diagram_id), ["D-002", "D-004"]);
    assert.deepEqual(db("SELECT actor, payload FROM event WHERE name = 'DIAGRAM_VIEWED' ORDER BY seq").map((r: Dict) => [r.actor, JSON.parse(r.payload).diagrams]),
      [["user", [{ diagram_id: "D-002", revision_no: 1 }]], ["user", [{ diagram_id: "D-004", revision_no: 1 }]]]);

    // 助手改了流程图：用例那条来源标「依据已变」，流程图要再看一次。
    await send({ text: "流程图里少了打印凭条那一步，补上。", client_id: "c-redraw" });
    assert.deepEqual(await sourcesOf(), [["图", "D-002", "OA-001 自助借书", 1, 1, null], ["图", "D-004", "记下借阅", 1, 2, "changed"]]);
    assert.equal((await lamps("writing")).basis_diagrams_viewed, false);
    const detail = (await call("GET", `/api/v1/tasks/${taskId}/diagrams/D-004`)).body.diagram as Dict;
    assert.deepEqual([detail.revision_no, detail.viewed, detail.depended_by], [2, false, [{ element_kind: "条目", id: "UC-001", revision_no: 2 }]]);
  }, { seed: false }));
