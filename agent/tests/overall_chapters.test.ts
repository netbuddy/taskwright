/**
 * 业务说明的章与节（src/lib/overall_chapters.ts）：页按标签归章，章内的先后与节号，已废弃与未归类的页，术语表的节号。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAPTERS, type ChapterPage, chapterByNo, chapterLayout, chapterOfLabels, chapterPage } from "../src/lib/overall_chapters.ts";

const page = (n: number, labels: string[], parent: number | null = null, deprecated = false): ChapterPage =>
  ({ item_id: `OA-${String(n).padStart(3, "0")}`, labels, parent: parent === null ? null : `OA-${String(parent).padStart(3, "0")}`, deprecated });
const rows = (pages: ChapterPage[]) => chapterLayout(pages).chapters.map((one) => one.sections.map((s) => `${s.no ?? "-"} ${s.item_id}${s.depth ? ` +${s.depth}` : ""}`));

test("七章固定，名称与次序不变；第 5、7 章没有自己的页", () => {
  assert.deepEqual(CHAPTERS.map((one) => `${one.no} ${one.name}`), ["1 概述与范围", "2 角色", "3 业务流程", "4 业务对象", "5 业务规则", "6 业务目标", "7 决策记录与待澄清事项"]);
  assert.deepEqual(CHAPTERS.filter((one) => one.labels.length === 0).map((one) => one.no), [5, 7]);
  assert.equal(chapterByNo(4).name, "业务对象");
});

test("归章：贴了几个标签的照章的先后取第一个对得上的；没有标签、只有不认识的标签的不归章", () => {
  const no = (...labels: string[]) => chapterOfLabels(labels)?.no ?? null;
  assert.deepEqual([no("范围"), no("假设"), no("角色"), no("流程"), no("场景"), no("概念"), no("目标"), no("决定")], [1, 1, 2, 3, 3, 4, 6, 6]);
  // 概念加流程归业务流程（第 3 章在第 4 章之前）；概念加角色归角色；决定加范围归概述与范围。
  assert.deepEqual([no("概念", "流程"), no("概念", "角色"), no("决定", "范围")], [3, 2, 1]);
  assert.deepEqual([no(), no("别的")], [null, null]);
});

test("从字段内容取出算章与节要的几样：上级主题写成列表或一个编号都认", () => {
  assert.deepEqual(chapterPage("OA-002", { 标签: ["流程", ""], 上级主题: ["OA-001"], 状态: "在用" }), { item_id: "OA-002", labels: ["流程"], parent: "OA-001", deprecated: false });
  assert.deepEqual(chapterPage("OA-003", { 上级主题: " OA-001 ", 状态: "已废弃" }), { item_id: "OA-003", labels: [], parent: "OA-001", deprecated: true });
  assert.deepEqual(chapterPage("OA-004", {}), { item_id: "OA-004", labels: [], parent: null, deprecated: false });
});

test("章内按上级主题成树（只认本章里的上级），同级按编号，压平之后顺序编号；没有标签的页另列", () => {
  const pages = [
    page(1, ["流程"]), page(2, ["流程"], 1), page(3, ["概念", "流程"], 1), page(4, ["假设"], 3), page(5, ["概念"], 1), page(6, ["流程"], 1),
    page(7, ["概念", "角色"]), page(8, [], 7), page(9, ["角色"]), page(10, ["概念"]), page(11, []),
  ];
  assert.deepEqual(rows(pages), [
    // 「OA-004」的上级在第 3 章，不在本章：在第 1 章里是顶层。
    ["1.1 OA-004"], ["2.1 OA-007", "2.2 OA-009"], ["3.1 OA-001", "3.2 OA-002 +1", "3.3 OA-003 +1", "3.4 OA-006 +1"], ["4.1 OA-005", "4.2 OA-010"], [], [], [],
  ]);
  const layout = chapterLayout(pages);
  assert.deepEqual(layout.unsorted, [{ item_id: "OA-008", deprecated: false }, { item_id: "OA-011", deprecated: false }]);
  assert.deepEqual(layout.chapters.map((one) => one.glossaryNo), [null, null, null, "4.3", null, null, null]);
  // 给进来的先后不影响结果。
  assert.deepEqual(rows([...pages].reverse()), rows(pages));
  // 编号按数字比：OA-10 在 OA-9 之后。
  assert.deepEqual(rows([{ ...page(9, ["角色"]), item_id: "OA-9" }, { ...page(10, ["角色"]), item_id: "OA-10" }])[1], ["2.1 OA-9", "2.2 OA-10"]);
});

test("每一页恰好落在一处：贴的标签一个都对不上任何一章的页与没有贴标签的页一样在未归类里；未归类里已废弃的带着标记", () => {
  const pages = [page(1, ["流程"]), page(2, ["别的"]), page(3, []), page(4, ["别的", "还有"], null, true), page(5, ["角色"], null, true)];
  const layout = chapterLayout(pages);
  assert.deepEqual(layout.unsorted, [{ item_id: "OA-002", deprecated: false }, { item_id: "OA-003", deprecated: false }, { item_id: "OA-004", deprecated: true }]);
  const placed = [...layout.chapters.flatMap((one) => one.sections.map((s) => s.item_id)), ...layout.unsorted.map((one) => one.item_id)].sort();
  assert.deepEqual(placed, pages.map((one) => one.item_id));
  // 数在用的页：章里数节号不是 null 的，未归类里数没有废弃的。
  assert.deepEqual([layout.chapters.reduce((n, one) => n + one.sections.filter((s) => s.no !== null).length, 0), layout.unsorted.filter((one) => !one.deprecated).length], [1, 2]);
});

test("已废弃的页留在它的章里、不占节号；术语表的节号接在在用的节之后", () => {
  const pages = [page(1, ["流程"]), page(2, ["流程"], 1, true), page(3, ["流程"], 1), page(5, ["概念"]), page(6, ["概念"], null, true)];
  assert.deepEqual(rows(pages)[2], ["3.1 OA-001", "- OA-002 +1", "3.2 OA-003 +1"]);
  assert.deepEqual([rows(pages)[3], chapterLayout(pages).chapters[3].glossaryNo], [["4.1 OA-005", "- OA-006"], "4.2"]);
});

test("术语表：别的章里有标签含概念的在用页时，第 4 章自己没有页也有这一节；一页概念都没有、或者都已废弃时没有", () => {
  assert.equal(chapterLayout([page(1, ["概念", "流程"])]).chapters[3].glossaryNo, "4.1");
  assert.equal(chapterLayout([page(1, ["流程"]), page(2, ["概念"], null, true)]).chapters[3].glossaryNo, null);
  assert.equal(chapterLayout([]).chapters[3].glossaryNo, null);
});

test("第 6 章：目标按上级主题成树，决定挂在它上级的目标下；挂不到目标下的决定排在各目标之后", () => {
  const pages = [page(11, ["决定"]), page(10, ["目标"]), page(8, ["决定"], 10), page(5, ["目标"], 10), page(12, ["决定", "目标"])];
  assert.deepEqual(rows(pages)[5], ["6.1 OA-010", "6.2 OA-005 +1", "6.3 OA-008 +1", "6.4 OA-012", "6.5 OA-011"]);
});

test("上级主题绕成圈的页都当作顶层，一页不丢；自己是自己的上级时当作没有上级", () => {
  const pages = [page(1, ["流程"], 2), page(2, ["流程"], 1), page(3, ["流程"], 3), page(4, ["流程"], 3)];
  assert.deepEqual(rows(pages)[2], ["3.1 OA-001", "3.2 OA-002", "3.3 OA-003", "3.4 OA-004 +1"]);
});
