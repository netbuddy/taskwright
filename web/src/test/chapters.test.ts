// 业务说明的章与节（model/chapters.ts）：页按标签归章、章内的先后与节号、未归类与已废弃的页、目录底部的汇总。
import { describe, expect, it } from "vitest";
import { CHAPTERS, chapterOf, sectionLabel, sectionOf, toc, tocOrder, tocTotals } from "../model/chapters";
import { change, itemOf, overallTask } from "./fixtures/overallTask";

const rows = (task = overallTask()) => toc(task).chapters.map((one) => [one.chapter.no, one.sections.map((s) => `${s.no ?? "-"} ${s.item.item_id}${s.depth ? ` +${s.depth}` : ""}`)]);

describe("页按标签归章", () => {
  it("七章固定，名称与次序不变；第 5、7 章没有自己的页", () => {
    expect(CHAPTERS.map((one) => `${one.no} ${one.name}`)).toEqual(["1 概述与范围", "2 角色", "3 业务流程", "4 业务对象", "5 业务规则", "6 业务目标", "7 决策记录与待澄清事项"]);
    expect(CHAPTERS.filter((one) => one.labels.length === 0).map((one) => one.no)).toEqual([5, 7]);
  });

  it("贴了几个标签的照章的先后取第一个对得上的章；没有标签的不归章", () => {
    const task = overallTask();
    const chapter = (id: string) => chapterOf(itemOf(task, id))?.no ?? null;
    // 概念加流程归业务流程（第 3 章在第 4 章之前）；概念加角色归角色。
    expect([chapter("OA-003"), chapter("OA-007"), chapter("OA-004"), chapter("OA-010"), chapter("OA-008")]).toEqual([3, 2, 1, 4, null]);
    change(task, "OA-010", (page) => { page.fields["标签"] = ["决定", "目标"]; });
    change(task, "OA-009", (page) => { page.fields["标签"] = ["场景"]; });
    expect([chapter("OA-010"), chapter("OA-009")]).toEqual([6, 3]);
  });
});

describe("目录：章内的先后与节号", () => {
  it("章内按上级主题成树（只认本章里的上级），同级按编号，压平之后顺序编号", () => {
    expect(rows()).toEqual([
      // 「闭馆日怎么算」的上级在第 3 章，不在本章：在第 1 章里是顶层。
      [1, ["1.1 OA-004"]],
      [2, ["2.1 OA-007", "2.2 OA-009"]],
      [3, ["3.1 OA-001", "3.2 OA-002 +1", "3.3 OA-003 +1", "3.4 OA-006 +1"]],
      [4, ["4.1 OA-005", "4.2 OA-010"]],
      [5, []],
      [6, []],
      [7, []],
    ]);
    const contents = toc(overallTask());
    expect(contents.unsorted.map((page) => page.item_id)).toEqual(["OA-008", "OA-011"]);
    // 术语表是第 4 章的最后一节，接在对象的节号之后；别的章没有。
    expect(contents.chapters.map((one) => one.glossaryNo)).toEqual([null, null, null, "4.3", null, null, null]);
  });

  it("已废弃的页留在它的章里、不占节号：后面的节号不因为它而变", () => {
    const task = change(overallTask(), "OA-002", (page) => { page.fields["状态"] = "已废弃"; });
    expect(rows(task)[2]).toEqual([3, ["3.1 OA-001", "- OA-002 +1", "3.2 OA-003 +1", "3.3 OA-006 +1"]]);
  });

  it("第 6 章：目标按上级主题成树，决定挂在它上级的目标下；挂不到目标下的决定排在各目标之后", () => {
    const task = overallTask();
    const label = (id: string, labels: string[], parent: string[] = []) => change(task, id, (page) => { page.fields["标签"] = labels; page.fields["上级主题"] = parent; });
    label("OA-011", ["决定"]);                 // 没有上级
    label("OA-010", ["目标"]);
    label("OA-008", ["决定"], ["OA-010"]);     // 挂在目标下
    label("OA-005", ["目标"], ["OA-010"]);     // 下一级目标
    expect(rows(task)[5]).toEqual([6, ["6.1 OA-010", "6.2 OA-005 +1", "6.3 OA-008 +1", "6.4 OA-011"]]);
    // 没有标签含概念的页了：第 4 章没有术语表这一节。
    expect(toc(task).chapters[3].glossaryNo).toBeNull();
  });

  it("上级主题绕成圈的页都当作顶层，一页不丢", () => {
    const task = overallTask();
    change(task, "OA-001", (page) => { page.fields["上级主题"] = ["OA-006"]; });
    expect(rows(task)[2][1]).toHaveLength(4);
    expect(new Set((rows(task)[2][1] as string[]).map((one) => one.split(" ")[1]))).toEqual(new Set(["OA-001", "OA-002", "OA-003", "OA-006"]));
  });
});

describe("目录里找一节、走上一条下一条、底部的汇总", () => {
  it("按页的编号找到它的节与叫法；未归类的页没有节", () => {
    const task = overallTask();
    const contents = toc(task);
    expect([sectionOf(contents, "OA-003")?.no, sectionOf(contents, "OA-003")?.chapter, sectionOf(contents, "OA-008"), sectionOf(contents, "UC-001"), sectionOf(contents, null)])
      .toEqual(["3.3", 3, null, null, null]);
    expect([sectionLabel(contents, itemOf(task, "OA-003")), sectionLabel(contents, itemOf(task, "OA-008"))]).toEqual(["3.3 预约取书", "借书证的有效期"]);
  });

  it("从上到下的次序：各章的节，再是未归类的页", () => {
    expect(tocOrder(toc(overallTask())).map((page) => page.item_id))
      .toEqual(["OA-004", "OA-007", "OA-009", "OA-001", "OA-002", "OA-003", "OA-006", "OA-005", "OA-010", "OA-008", "OA-011"]);
  });

  it("汇总：编了号的节、需求条目（不算总体分析的页与问题条目）、还没有了结的问题", () => {
    const task = overallTask();
    expect(tocTotals(task, toc(task))).toEqual({ sections: 9, items: 3, open: 3 });
  });
});
