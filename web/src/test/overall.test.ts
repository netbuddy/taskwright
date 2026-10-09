// 总体分析在页面上的派生（model/overall.ts）：提纲成树与每行的计数、状态点的先后、底部总计、术语表、
// 哪几处是助手补的、提到它的地方与依据它的条目、复述要发的话、复述卡片怎样认。数据是图书馆借阅的夹具。
import { describe, expect, it } from "vitest";
import {
  STORY_KEYS, confirmAction, countsText, dependents, exampleParts, firstParagraph, glossary, isStoryOptions, markSupplemented, mentionRows, openQuestions, outline, outlineOrder,
  overallDef, pagesOf, pendingCount, questionReason, retellText, settledCount, sourcesFor, splitByWord, storyPlace, supplemented, topicState, totals, trail, withBelow,
  viewOnOpen, type OutlineNode,
} from "../model/overall";
import { change, itemOf, overallTask } from "./fixtures/overallTask";

const shape = (nodes: OutlineNode[]): unknown[] => nodes.map((n) => (n.children.length ? [n.item.item_id, shape(n.children)] : n.item.item_id));

describe("总体分析：提纲", () => {
  it("任务定义里有名叫总体分析的集合才有；页按编号排", () => {
    const task = overallTask();
    expect(overallDef(task)?.prefix).toBe("OA");
    expect(pagesOf(task).map((p) => p.item_id)).toEqual(["OA-001", "OA-002", "OA-003", "OA-004", "OA-005", "OA-006", "OA-007", "OA-008", "OA-009", "OA-010", "OA-011"]);
    const old = overallTask();
    old.definition.collections = old.definition.collections.filter((c) => c.name !== "总体分析");
    expect(overallDef(old)).toBeNull();
  });

  it("按上级主题成树，同级按编号", () => {
    expect(shape(outline(overallTask()))).toEqual([
      ["OA-001", ["OA-002", ["OA-003", ["OA-004"]], "OA-005", "OA-006"]],
      ["OA-007", ["OA-008"]],
      "OA-009", "OA-010", "OA-011",
    ]);
  });

  it("上级不在总体分析里、指向自己、或者绕成一圈的页，当作顶层的一页；每一页都正好出现一次", () => {
    const task = overallTask();
    change(task, "OA-009", (p) => { p.fields.上级主题 = ["UC-001"]; });
    change(task, "OA-010", (p) => { p.fields.上级主题 = ["OA-010"]; });
    change(task, "OA-001", (p) => { p.fields.上级主题 = ["OA-003"]; }); // OA-003 的上级是 OA-001：两页绕成一圈
    const order = outlineOrder(outline(task)).map((p) => p.item_id);
    expect([...order].sort()).toEqual(pagesOf(task).map((p) => p.item_id));
    const roots = outline(task).map((n) => n.item.item_id);
    expect(roots).toEqual(expect.arrayContaining(["OA-001", "OA-003", "OA-009", "OA-010"]));
    // 绕圈的两页下面原有的页还挂在它们下面。
    expect(outline(task).find((n) => n.item.item_id === "OA-003")!.children.map((n) => n.item.item_id)).toEqual(["OA-004"]);
  });

  it("从上到下的次序先自己再下面的页；面包屑是它上面的各级；它与它下面的页", () => {
    const task = overallTask();
    expect(outlineOrder(outline(task)).map((p) => p.item_id).slice(0, 5)).toEqual(["OA-001", "OA-002", "OA-003", "OA-004", "OA-005"]);
    expect(trail(task, itemOf(task, "OA-004")).map((p) => p.item_id)).toEqual(["OA-001", "OA-003"]);
    expect(trail(task, itemOf(task, "OA-001"))).toEqual([]);
    expect(withBelow(task, "OA-003").map((p) => p.item_id)).toEqual(["OA-003", "OA-004"]);
    expect(withBelow(task, "OA-999")).toEqual([]);
  });

  it("状态点：待核实、有待问、未归类、说清了，同时满足几种时按这个先后；已废弃排最前", () => {
    const task = overallTask();
    const state = (id: string) => topicState(task, itemOf(task, id));
    expect(state("OA-003")).toBe("pending"); // 既待核实又有待问：取待核实
    expect(state("OA-004")).toBe("open");
    expect(state("OA-008")).toBe("unsorted");
    expect(state("OA-002")).toBe("settled");
    change(task, "OA-003", (p) => { p.fields.状态 = "已废弃"; });
    expect(state("OA-003")).toBe("deprecated");
  });

  it("每行的计数：已定几条、待问几条，没有的那一半不写；两样都没有时写待核实或未归类，说清了的不写", () => {
    const task = overallTask();
    const text = (id: string) => countsText(task, itemOf(task, id));
    expect(text("OA-002")).toBe("5 定");
    expect(text("OA-003")).toBe("3 定 · 1 问"); // 四条已定里一条是助手补的，不算
    expect(text("OA-004")).toBe("1 问");
    expect(text("OA-005")).toBe("1 问");
    expect(text("OA-008")).toBe("未归类");
    expect(text("OA-001")).toBe("");
    change(task, "OA-005", (p) => { p.fields.别名 = []; });
    task.items = task.items.filter((i) => i.item_id !== "TBD-003");
    expect(text("OA-005")).toBe("待核实");
  });

  it("底部总计：11 个主题、14 条已定、3 条待问、2 处待核实；已废弃的页不算", () => {
    const task = overallTask();
    expect(totals(task)).toEqual({ pages: 11, settled: 14, open: 3, pending: 2 });
    change(task, "OA-002", (p) => { p.fields.状态 = "已废弃"; });
    expect(totals(task)).toEqual({ pages: 10, settled: 9, open: 3, pending: 2 });
  });
});

describe("总体分析：一页里的内容", () => {
  it("待核实的页：助手补的是哪几处、理由是什么；不待核实的页一处都没有", () => {
    const task = overallTask();
    const page = itemOf(task, "OA-003");
    const got = supplemented(page);
    expect(pendingCount(page)).toBe(1);
    expect([...got.fields]).toEqual(["它是什么"]);
    expect([...got.settled]).toEqual([3]);
    expect(got.reasons).toEqual(["「保留期是 3 天」是按高校图书馆常见做法补的，你只说了「留几天」，没有说几天。"]);
    expect(settledCount(page)).toBe(3);
    // 确认之后（不再待核实）：同样的来源还在，但不再标出，四条都算已定。
    page.pending_verification = false;
    expect(supplemented(page).settled.size).toBe(0);
    expect(pendingCount(page)).toBe(0);
    expect(settledCount(page)).toBe(4);
    // 早先的后端不给这几项：按没有待核实处理。
    delete page.pending_verification;
    delete page.pending_sources;
    expect(pendingCount(page)).toBe(0);
  });

  it("助手补充的来源没有指明哪一处时，整页都要看", () => {
    const task = overallTask();
    const page = change(task, "OA-005", (p) => { p.pending_places = [{ field: null, index: null }]; }) && itemOf(task, "OA-005");
    expect(supplemented(page).whole).toBe(true);
    // 早先的后端不给 pending_places：从助手补充的来源自己看，来源什么都没有指时同样是整页。
    delete page.pending_places;
    page.sources[1].supports = [];
    expect(supplemented(page).whole).toBe(true);
  });

  it("用户亲手改过的那一处不再待核实：以后端给的 pending_places 为准，它可以比助手补充来源支持的地方少", () => {
    const task = overallTask();
    // 助手补的原来有两处（它是什么、已定第 4 条）；用户改写了「它是什么」，只剩已定那一条还待核实。
    const page = change(task, "OA-003", (p) => { p.pending_places = [{ field: "已经定下的", index: 3 }]; }) && itemOf(task, "OA-003");
    const got = supplemented(page);
    expect([...got.fields]).toEqual([]);
    expect([...got.settled]).toEqual([3]);
    // 没有给 pending_places 时退回到看来源：两处都算。
    delete page.pending_places;
    expect([...supplemented(page).fields]).toEqual(["它是什么"]);
  });

  it("「它是什么」里标出理由引到的那几个字；理由没有引原文、或者引的字不在正文里时不标", () => {
    const what = "书放在预留架的这段时间叫保留期，保留期是 3 天，过了没来取，书放回书架。";
    expect(markSupplemented(what, ["「保留期是 3 天」是按常见做法补的，你只说了「留几天」。"])).toEqual([
      { text: "书放在预留架的这段时间叫保留期，", marked: false }, { text: "保留期是 3 天", marked: true }, { text: "，过了没来取，书放回书架。", marked: false },
    ]);
    expect(markSupplemented(what, ["这一句是我补的。"])).toEqual([{ text: what, marked: false }]);
    expect(markSupplemented(what, ["「留一周」是我猜的。"])).toEqual([{ text: what, marked: false }]);
    // 引了两处、其中一处出现两次：都标出来，先后照正文。只引一个字的不算（太容易在别处撞上）。
    expect(markSupplemented("甲乙丙丁，甲乙", ["「甲乙」与「丙丁」"]).filter((p) => p.marked).map((p) => p.text)).toEqual(["甲乙", "丙丁", "甲乙"]);
    expect(markSupplemented("甲乙丙丁", ["「丙」是补的"])).toEqual([{ text: "甲乙丙丁", marked: false }]);
  });

  it("例子里以「反例：」开头的是反例；首段到第一个空行为止", () => {
    expect(exampleParts("反例：小李登记的是排队等书。")).toEqual({ counter: true, text: "小李登记的是排队等书。" });
    expect(exampleParts("小王周二来取。")).toEqual({ counter: false, text: "小王周二来取。" });
    expect(firstParagraph("第一段。\n\n第二段。")).toBe("第一段。");
    expect(firstParagraph("只有一段。")).toBe("只有一段。");
  });

  it("每一处的出处：指到这个字段、这一项的来源", () => {
    const page = itemOf(overallTask(), "OA-003");
    expect(sourcesFor(page, "已经定下的", 1).map((s) => s.kind)).toEqual(["文档原文"]);
    expect(sourcesFor(page, "已经定下的", 3).map((s) => s.kind)).toEqual(["助手补充"]);
    expect(sourcesFor(page, "它是什么").map((s) => s.kind)).toEqual(["用户的话", "助手补充"]);
    expect(sourcesFor(page, "别名")).toEqual([]);
  });

  it("还没定的：问题集合里挂在这一页、还没有了结的条目，带助手为什么问", () => {
    const task = overallTask();
    const open = openQuestions(task, itemOf(task, "OA-003"));
    expect(open.map((q) => q.item_id)).toEqual(["TBD-001"]);
    expect(questionReason(task, open[0])).toBe("小王周六预约、周一到架，如果周日闭馆而且算在 3 天里，他周二来取就只剩一天了。");
    change(task, "TBD-001", (q) => { q.fields.状态 = "用户决定保留"; });
    expect(openQuestions(task, itemOf(task, "OA-003"))).toEqual([]);
    change(task, "TBD-002", (q) => { q.fields.建议的处理 = null; });
    expect(questionReason(task, itemOf(task, "TBD-002"))).toBe("");
  });
});

describe("总体分析：确认待核实", () => {
  // 夹具里总体分析是要求用户看过的集合（没有给完成条件时，不是问题条目一类的集合都算），所以别的页打开就会记已读。
  const needsViewing = () => overallTask();

  it("打开待核实的页不记已读；不待核实、还没有看过的页照旧一打开就记", () => {
    const task = needsViewing();
    expect(viewOnOpen(task, "OA-003")).toBeNull(); // 待核实
    expect(viewOnOpen(task, "OA-008")).toEqual({ item_id: "OA-008", base_revision: 1 }); // 没看过、不待核实
    expect(viewOnOpen(task, "OA-002")).toBeNull(); // 已经看过当前的修订
    expect(viewOnOpen(task, null)).toBeNull();
    expect(viewOnOpen(null, "OA-003")).toBeNull();
  });

  it("确认之后（不再待核实）又被助手改了、当前修订还没有看过的页，打开照旧记", () => {
    const task = change(needsViewing(), "OA-003", (p) => { p.pending_verification = false; });
    expect(viewOnOpen(task, "OA-003")).toEqual({ item_id: "OA-003", base_revision: 12 });
  });

  it("「确认待核实的 N 处」记的是这一页现在所在的修订，不通知助手", () => {
    expect(confirmAction(itemOf(overallTask(), "OA-003"))).toEqual({ kind: "mark_viewed", targets: [{ item_id: "OA-003", base_revision: 12 }], notify_executor: false });
  });
});

describe("总体分析：术语表", () => {
  it("只收标签含概念、在用、不待核实的页；待核实的概念另列出来", () => {
    const task = overallTask();
    const got = glossary(task);
    expect(got.rows.map((r) => r.item.item_id)).toEqual(["OA-007", "OA-010"]);
    expect(got.rows[1]).toMatchObject({ aliases: ["藏书"], first: "图书馆登记在册的每一本实体书，一本一个条码。" });
    expect(got.waiting.map((p) => p.item_id)).toEqual(["OA-003", "OA-005"]);
    change(task, "OA-010", (p) => { p.fields.状态 = "已废弃"; });
    expect(glossary(task).rows.map((r) => r.item.item_id)).toEqual(["OA-007"]);
  });

  it("首段只取第一段", () => {
    const task = change(overallTask(), "OA-003", (p) => { p.pending_verification = false; });
    const row = glossary(task).rows.find((r) => r.item.item_id === "OA-003")!;
    expect(row.first.endsWith("让给下一位。")).toBe(true);
    expect(row.first).not.toContain("排队等书");
    expect(row.aliases).toEqual(["预约"]);
  });
});

describe("总体分析：提到它的地方", () => {
  it("别处提到它的句子在前，依据它写的条目在后；依据在那之后改过的带「依据已变」", () => {
    const task = overallTask();
    const page = itemOf(task, "OA-003");
    expect(dependents(task, page).map((i) => i.item_id)).toEqual(["UC-002", "UC-003"]);
    const rows = mentionRows(task, page);
    expect(rows.map((r) => `${r.kind} ${r.id} ${r.place}${r.stale ? " 已变" : ""}`)).toEqual([
      "mention OA-002 主题 · 它是什么",
      "mention OA-006 主题 · 已经定下的第 2 条",
      "mention UC-002 功能用例 · 约束规则第 1 条",
      "basis UC-002 功能用例 · 依据它",
      "basis UC-003 功能用例 · 依据它 已变",
    ]);
    expect(rows[1]).toMatchObject({ word: "预约", sentence: "有人预约的书不能续借。" });
    expect(rows[4].sentence).toBe("读者对一本在架的书办预约，馆员把这本书从书架取下，放到预留架上等读者来取。");
    expect(rows[0].from?.title).toBe("借书与还书");
  });

  it("起点条目已经不在任务里时，这一行还在，只是没有起点", () => {
    const task = overallTask();
    task.items = task.items.filter((i) => i.item_id !== "OA-006");
    expect(mentionRows(task, itemOf(task, "OA-003")).find((r) => r.id === "OA-006")!.from).toBeNull();
  });

  it("没有被提到、也没有条目依据的页，一行都没有；早先的后端不给 mentioned_by 时也一样", () => {
    const task = overallTask();
    expect(mentionRows(task, itemOf(task, "OA-011"))).toEqual([]);
    const page = itemOf(task, "OA-009");
    delete page.mentioned_by;
    expect(mentionRows(task, page)).toEqual([]);
  });

  it("按命中的词切开原句；词不在句子里时不切", () => {
    expect(splitByWord("有人预约的书不能续借。", "预约")).toEqual([{ text: "有人", hit: false }, { text: "预约", hit: true }, { text: "的书不能续借。", hit: false }]);
    expect(splitByWord("预约取书", "预约取书")).toEqual([{ text: "预约取书", hit: true }]);
    expect(splitByWord("系统为读者预留图书。", "预约")).toEqual([{ text: "系统为读者预留图书。", hit: false }]);
    expect(splitByWord("一句话。", null)).toEqual([{ text: "一句话。", hit: false }]);
  });
});

describe("总体分析：复述", () => {
  it("复述一遍发给助手的话：给了主题讲它与它下面的主题，没有给讲整个总体分析", () => {
    expect(retellText("预约取书")).toBe("请把现在对「预约取书」及其下面主题的理解讲成一段故事");
    expect(retellText(null)).toBe("请把现在对总体分析里各个主题的理解讲成一段故事");
  });

  it("复述卡片：选项里有写死的键就是；没有键的，第一个选项以「这段对」开头也算；别的请选择卡片不算", () => {
    expect(STORY_KEYS).toEqual(["story_ok", "story_fix", "story_again"]);
    expect(isStoryOptions([{ key: "story_ok", text: "这段对，记下" }, { key: "story_fix", text: "有一处不对" }, { key: "story_again", text: "换一个人物再讲" }])).toBe(true);
    expect(isStoryOptions([{ key: "a", text: "这段对，记下" }, { key: "b", text: "有一处不对" }])).toBe(true);
    expect(isStoryOptions([{ key: "a", text: "闭馆日不算，顺延" }, { key: "b", text: "这段对，记下" }])).toBe(false);
    expect(isStoryOptions([{ key: "x", text: "别的话" }, { key: "story_again", text: "再讲一遍" }])).toBe(true);
    expect(isStoryOptions([])).toBe(false);
    expect(isStoryOptions(undefined)).toBe(false);
  });

  it("故事写在哪里：卡片正文与回复正文哪个长哪个是故事；不是请选择、或者选项不是那三个的，不算复述", () => {
    const options = STORY_KEYS.map((key) => ({ key, text: key }));
    const story = "周六上午，小王在家里预约了《算法导论》。周一馆员把书放到预留架。";
    expect(storyPlace({ kind: "choose", text: story, options }, "我把到现在的理解讲成一段：")).toBe("card");
    expect(storyPlace({ kind: "choose", text: "你看这段对不对？", options }, story)).toBe("reply");
    expect(storyPlace({ kind: "choose", text: story, options })).toBe("card"); // 没有回复正文
    expect(storyPlace({ kind: "ask", text: story, options })).toBeNull();
    expect(storyPlace({ kind: "choose", text: story, options: [{ key: "a", text: "按自然日" }, { key: "b", text: "顺延" }] })).toBeNull();
  });
});
