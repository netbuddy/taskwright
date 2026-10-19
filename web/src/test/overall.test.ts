// 业务说明在页面上的派生（model/overall.ts）：每行的计数、状态点的先后、底部总计、术语表、
// 哪几处是助手补的、说明里要标出的原话、节标题下那一行小字、依据它的条目、复述要发的话、复述卡片怎样认。数据是图书馆借阅的夹具。
// 页怎样归章、排先后与编节号在 chapters.test.ts 与助手一侧的测试里核对。
import { describe, expect, it } from "vitest";
import {
  STORY_KEYS, addedQuotes, addedWords, confirmAction, dependents, factsKey, exampleKind, firstParagraph, glossary, isStoryOptions, markPassage, materialQuotes, openQuestions,
  overallDef, pagesOf, pendingCount, questionReason, retellText, sectionLead, settledCount, sourcesFor, storyPlace, supplemented, topicState, totals, viewOnOpen, wholeSources,
} from "../model/overall";
import { change, itemOf, overallTask } from "./fixtures/overallTask";

describe("业务说明：各页与目录每行的计数", () => {
  it("任务定义里有名叫业务说明的集合才有；页按编号排", () => {
    const task = overallTask();
    expect(overallDef(task)?.prefix).toBe("OA");
    expect(pagesOf(task).map((p) => p.item_id)).toEqual(["OA-001", "OA-002", "OA-003", "OA-004", "OA-005", "OA-006", "OA-007", "OA-008", "OA-009", "OA-010", "OA-011"]);
    const old = overallTask();
    old.definition.collections = old.definition.collections.filter((c) => c.name !== "业务说明");
    expect(overallDef(old)).toBeNull();
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

  it("底部总计：11 个主题、14 条已定、3 条待问、2 处待核实；已废弃的页不算", () => {
    const task = overallTask();
    expect(totals(task)).toEqual({ pages: 11, settled: 14, open: 3, pending: 2 });
    change(task, "OA-002", (p) => { p.fields.状态 = "已废弃"; });
    expect(totals(task)).toEqual({ pages: 10, settled: 9, open: 3, pending: 2 });
  });
});

describe("业务说明：一页里的内容", () => {
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

  it("助手补的那几个字：理由里用直角引号引出来的、两个字以上的；没有引的一个都没有", () => {
    expect(addedQuotes(["「保留期是 3 天」是按常见做法补的，你只说了「留几天」。"])).toEqual(["保留期是 3 天", "留几天"]);
    expect(addedQuotes(["这一句是我补的。"])).toEqual([]);
    // 只引一个字的不算（太容易在别处撞上）；两条理由引了同一处只算一次。
    expect(addedQuotes(["「丙」是补的", "「甲乙」", "又是「甲乙」"])).toEqual(["甲乙"]);
  });

  it("助手补进某个字段的字：取指到这个字段的 inserted；来源一处 inserted 都没有（旧数据）时退回理由里的直角引号", () => {
    const item = { item_id: "OA-009", collection: "业务说明", revision_no: 1, fields: {}, sources: [
      { kind: "助手补充", locator: "", excerpt: "材料里只说「预留架」。", supports: [{ field: "它是什么", inserted: ["保留期是 3 天"] }, { field: "例子", index: 0, inserted: ["周二来取"] }] },
      { kind: "助手补充", locator: "", excerpt: "「过期不取」是我补的。", supports: [{ field: "它是什么" }] },
    ] } as unknown as Parameters<typeof addedWords>[0];
    expect(addedWords(item, "它是什么")).toEqual(["保留期是 3 天", "过期不取"]);
    expect(addedWords(item, "例子")).toEqual(["周二来取", "过期不取"]);
  });

  it("在一段文字里标出原话：找得到的切成单独的一截，找不到的不标；出现两次的两处都标，先后照正文", () => {
    const what = "书放在预留架的这段时间叫保留期，保留期是 3 天，过了没来取，书放回书架。";
    expect(markPassage(what, [{ quote: "保留期是 3 天", mark: "added" }, { quote: "留几天", mark: "added" }])).toEqual([
      { text: "书放在预留架的这段时间叫保留期，", mark: null }, { text: "保留期是 3 天", mark: "added" }, { text: "，过了没来取，书放回书架。", mark: null },
    ]);
    expect(markPassage(what, [])).toEqual([{ text: what, mark: null }]);
    expect(markPassage(what, [{ quote: "留一周", mark: "added" }, { quote: "", mark: "added" }])).toEqual([{ text: what, mark: null }]);
    expect(markPassage("甲乙丙丁，甲乙", [{ quote: "甲乙", mark: "added" }, { quote: "丙丁", mark: "added" }]).filter((p) => p.mark).map((p) => p.text)).toEqual(["甲乙", "丙丁", "甲乙"]);
  });

  it("材料原句与助手补的字句一起标：各带各的记号，材料原句带着它的来源；两段从同一处起头时长的占先", () => {
    const source = { kind: "文档原文", locator: "inputs/a.md", excerpt: "借期都是 30 天", supports: [] };
    const parts = markPassage("借期都是 30 天，保留期是 3 天。", [{ quote: "借期都是 30 天", mark: "material", source }, { quote: "保留期是 3 天", mark: "added" }]);
    expect(parts).toEqual([
      { text: "借期都是 30 天", mark: "material", source }, { text: "，", mark: null }, { text: "保留期是 3 天", mark: "added" }, { text: "。", mark: null },
    ]);
    expect(markPassage("借期都是 30 天。", [{ quote: "借期", mark: "added" }, { quote: "借期都是 30 天", mark: "material", source }]).map((p) => p.text)).toEqual(["借期都是 30 天", "。"]);
  });

  it("说明里逐字出自材料的句子：支持「它是什么」或者支持整页的「文档原文」来源的摘录，去掉首尾空白；用户的话与支持别处的不算", () => {
    const task = overallTask();
    expect(materialQuotes(itemOf(task, "OA-002")).map((one) => one.quote)).toEqual(["借书和还书都可以在自助借还机上办理，也可以到服务台办理。"]);
    expect(materialQuotes(itemOf(task, "OA-003"))).toEqual([]);
    const page = change(task, "OA-004", (p) => { p.sources.push({ kind: "文档原文", locator: "inputs/a.md", excerpt: " 每周日闭馆 ", supports: [] }, { kind: "文档原文", locator: "inputs/a.md", excerpt: "  ", supports: [] }); });
    const whole = itemOf(page, "OA-004");
    expect(wholeSources(whole).map((s) => s.excerpt)).toEqual([" 每周日闭馆 ", "  "]);
    expect(materialQuotes(whole)).toEqual([{ quote: "每周日闭馆", mark: "material", source: whole.sources[1] }]);
  });

  it("节标题下那一行小字要的三样：材料几处、澄清几条、这一页现在所在的修订用户看没看过", () => {
    const task = overallTask();
    // OA-002 现在是第 3 次修订，用户看过的就是第 3 次。
    expect(sectionLead(itemOf(task, "OA-002"))).toEqual({ materials: 2, clarified: 2, seen: true });
    // OA-003 现在是第 12 次修订，用户看过的是第 9 次：现在的内容还没有看过。
    expect(sectionLead(itemOf(task, "OA-003"))).toEqual({ materials: 1, clarified: 2, seen: false });
    // 从来没有看过的页。
    expect(sectionLead(itemOf(task, "OA-008"))).toEqual({ materials: 0, clarified: 1, seen: false });
  });

  it("例子分三种：以「例外：」开头的是例外，以「反例：」开头的是反例，别的是平常的例子；首段到第一个空行为止", () => {
    expect(exampleKind("例外：借书证过期了，不能预约。")).toEqual({ kind: "exception", text: "借书证过期了，不能预约。" });
    expect(exampleKind("反例：小李登记的是排队等书。")).toEqual({ kind: "counter", text: "小李登记的是排队等书。" });
    expect(exampleKind("小王周二来取。")).toEqual({ kind: "plain", text: "小王周二来取。" });
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

describe("业务说明：确认待核实", () => {
  // 夹具里业务说明是要求用户看过的集合（没有给完成条件时，不是问题条目一类的集合都算），所以别的页打开就会记已读。
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

describe("业务说明：该不该另取一次待核实与提到", () => {
  it("修订号变了、有条目被确认了、条目多了或少了，记号都变；什么都没有发生时不变", () => {
    const task = overallTask();
    const key = factsKey(task, 12);
    expect(key).not.toBeNull();
    expect(factsKey(task, 12)).toBe(key);
    expect(factsKey(task, 13)).not.toBe(key);
    change(task, "OA-003", (p) => { p.confirmations.push({ revision_no: 12, accepted: true, basis: "viewed" }); });
    expect(factsKey(task, 12)).not.toBe(key);
    // 图多了一张、图有了新修订、图被看过，记号也都变。
    const drawn = overallTask();
    const row = { diagram_id: "D-001", name: "借书的流程", kind: "flowchart", kind_name: "流程图", revision_no: 1, revision_by: "executor", revision_at: "", created_at: "", source_count: 1 };
    const plain = factsKey(drawn, 12);
    drawn.diagrams = [row];
    const one = factsKey(drawn, 12);
    drawn.diagrams = [{ ...row, revision_no: 2 }];
    const two = factsKey(drawn, 12);
    drawn.diagrams = [{ ...row, revision_no: 2, viewed: true }];
    expect(new Set([plain, one, two, factsKey(drawn, 12)]).size).toBe(4);
    const fewer = overallTask();
    fewer.items = fewer.items.slice(1);
    expect(factsKey(fewer, 12)).not.toBe(key);
  });

  it("没有业务说明的早先任务、任务还没有读到时，不用取", () => {
    const old = overallTask();
    old.definition.collections = old.definition.collections.filter((c) => c.name !== "业务说明");
    expect(factsKey(old, 12)).toBeNull();
    expect(factsKey(null, 0)).toBeNull();
  });
});

describe("业务说明：术语表", () => {
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

describe("业务说明：依据它写的条目", () => {
  it("依据这一页写的条目，按编号；没有条目依据的页一条都没有", () => {
    const task = overallTask();
    expect(dependents(task, itemOf(task, "OA-003")).map((i) => i.item_id)).toEqual(["UC-002", "UC-003"]);
    expect(dependents(task, itemOf(task, "OA-011"))).toEqual([]);
  });
});

describe("业务说明：复述", () => {
  it("复述一遍发给助手的话：给了主题讲它与它下面的主题，没有给讲整个业务说明", () => {
    expect(retellText("预约取书")).toBe("请把现在对「预约取书」及其下面主题的理解讲成一段故事");
    expect(retellText(null)).toBe("请把现在对业务说明里各个主题的理解讲成一段故事");
  });

  it("复述卡片：选项里有写死的键就是；没有键的，第一个选项以「这段对」开头也算；别的请选择卡片不算", () => {
    expect(STORY_KEYS).toEqual(["story_ok", "story_fix", "story_again"]);
    expect(isStoryOptions([{ key: "story_ok", text: "采纳为例子" }, { key: "story_fix", text: "有误，需修改" }, { key: "story_again", text: "换一个例子重述" }])).toBe(true);
    // 早先的回复：选项还是原来的文字、没有写死的键，靠第一个选项的文字认。
    expect(isStoryOptions([{ key: "a", text: "这段对，记下" }, { key: "b", text: "有一处不对" }, { key: "c", text: "换一个人物再讲" }])).toBe(true);
    // 现在的文字而没有写死的键：认不出，所以助手的说明要求键照写。
    expect(isStoryOptions([{ key: "a", text: "采纳为例子" }, { key: "b", text: "有误，需修改" }])).toBe(false);
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
