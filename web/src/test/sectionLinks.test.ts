// 一节末尾三块的算法（model/sectionLinks.ts）：相关角色与对象、对应的需求条目与状态词、追溯行的四段。数据是图书馆借阅的夹具。
import { describe, expect, it } from "vitest";
import type { DiagramRow } from "../api/types";
import { diagramGraph } from "../../../agent/src/lib/diagram_scan.ts";
import { toc } from "../model/chapters";
import { linkedIds, relatedPages, requirementState, requirementStateText, requirementsOf, traceOf } from "../model/sectionLinks";
import { change, itemOf, overallTask } from "./fixtures/overallTask";

const PREFIXES = ["UC", "TBD", "OA"];
const USE_CASES = diagramGraph('flowchart LR\n  r(["OA-007 读者"])\n  l(["OA-009 馆员"])\n  f(["OA-006 续借"])\n  g(["OA-003 预约取书"])\n  r -->|发起| f\n  l --> g\n  r --> g', PREFIXES);
const CLASSES = diagramGraph('classDiagram\n  class Fine["OA-005 逾期与罚款"]\n  class Stock["OA-010 馆藏"]\n  Stock --> Fine', PREFIXES);
const ids = (pages: { item_id: string }[]) => pages.map((page) => page.item_id);

describe("相关角色与对象", () => {
  it("图里与这一页的节点有连线的条目，连线不分方向；图里没有画这一页时一个都没有", () => {
    expect(linkedIds([USE_CASES, CLASSES], "OA-003").sort()).toEqual(["OA-007", "OA-009"]);
    expect(linkedIds([USE_CASES, CLASSES], "OA-007").sort()).toEqual(["OA-003", "OA-006"]);
    expect(linkedIds([USE_CASES, CLASSES], "OA-005")).toEqual(["OA-010"]);
    expect(linkedIds([USE_CASES, CLASSES], "OA-001")).toEqual([]);
  });

  it("三种来历合在一起：这一页提到的、提到这一页的、图里相连的；按章分成角色、业务对象、相关流程，每行照目录的先后", () => {
    const task = overallTask();
    const contents = toc(task);
    // OA-003 被 OA-002 与 OA-006 提到（夹具），图里连着两个角色。
    const related = relatedPages(task, contents, itemOf(task, "OA-003"), [USE_CASES, CLASSES]);
    expect(ids(related.roles)).toEqual(["OA-007", "OA-009"]);
    expect(ids(related.objects)).toEqual([]);
    expect(ids(related.flows)).toEqual(["OA-002", "OA-006"]);
    // OA-002 的文字提到了 OA-003 与 OA-005：反过来在 OA-002 这一页上也看得到它们。
    const back = relatedPages(task, contents, itemOf(task, "OA-002"), []);
    expect(ids(back.flows)).toEqual(["OA-003"]);
    expect(ids(back.objects)).toEqual(["OA-005"]);
    expect(ids(back.roles)).toEqual([]);
  });

  it("自己、已废弃的页、别的章的页与不是业务说明的条目不列", () => {
    const task = overallTask();
    change(task, "OA-006", (page) => { page.fields.状态 = "已废弃"; });
    // OA-004 在第 1 章，OA-008 未归类：都不列。
    change(task, "OA-003", (page) => { page.mentioned_by!.push({ item_id: "OA-004", collection: "总体分析", field: "它是什么", index: null, word: "预约", sentence: "", revision_no: 1 },
      { item_id: "OA-008", collection: "总体分析", field: "它是什么", index: null, word: "预约", sentence: "", revision_no: 1 },
      { item_id: "OA-003", collection: "总体分析", field: "它是什么", index: null, word: "预约", sentence: "", revision_no: 1 }); });
    const related = relatedPages(task, toc(task), itemOf(task, "OA-003"), []);
    expect(ids(related.flows)).toEqual(["OA-002"]);
    expect(ids(related.roles)).toEqual([]);
    expect(ids(related.objects)).toEqual([]);
  });
});

describe("对应的需求条目", () => {
  const failed = { revision_no: 1, verdict: "不合规", findings: [{ rule_id: "R1", level: "必选", message: "缺前置条件" }, { rule_id: "R2", level: "必选", message: "缺异常" }, { rule_id: "R3", level: "可选", message: "可以更短" }] };
  const passed = { revision_no: 1, verdict: "合规", findings: [] };

  it("依据这一页写的条目，按编号；业务说明自己的页不算", () => {
    const task = overallTask();
    expect(requirementsOf(task, itemOf(task, "OA-003")).map((one) => one.item.item_id)).toEqual(["UC-002", "UC-003"]);
    change(task, "OA-003", (page) => { page.depended_by!.push({ element_kind: "条目", id: "OA-006", revision_no: 2 }); });
    expect(requirementsOf(task, itemOf(task, "OA-003")).map((one) => one.item.item_id)).toEqual(["UC-002", "UC-003"]);
    expect(requirementsOf(task, itemOf(task, "OA-011"))).toEqual([]);
  });

  it("状态词：评审不通过、还没有处理的是「评审中 · N 处发现」，只数必选规则的问题", () => {
    const task = overallTask();
    change(task, "UC-002", (item) => { item.reviews = [failed as never]; });
    const state = requirementState(task, itemOf(task, "UC-002"));
    expect(state).toEqual({ kind: "reviewing", findings: 2 });
    expect(requirementStateText(state)).toBe("评审中 · 2 处发现");
  });

  it("状态词：看过、评审通过、依据不待核实才是「已确认」；没看过、等评审、依据待核实的都是「草稿」", () => {
    const task = overallTask();
    // 夹具里三个用例都还没有看过、没有评审，依据的页也待核实。
    expect(requirementStateText(requirementState(task, itemOf(task, "UC-003")))).toBe("草稿");
    // 评审通过了（评的是它现在的修订），还没有看过：草稿。
    change(task, "UC-003", (item) => { item.reviews = [{ ...passed, revision_no: item.revision_no } as never]; });
    expect(requirementState(task, itemOf(task, "UC-003"))).toEqual({ kind: "draft" });
    // 看过了，依据的页还待核实：草稿。
    change(task, "UC-003", (item) => { item.confirmations.push({ revision_no: item.revision_no, accepted: true, basis: "已读" }); });
    expect(requirementState(task, itemOf(task, "UC-003"))).toEqual({ kind: "draft" });
    change(task, "UC-003", (item) => { item.basis_pending = null; });
    expect(requirementState(task, itemOf(task, "UC-003"))).toEqual({ kind: "confirmed" });
    expect(requirementStateText({ kind: "confirmed" })).toBe("已确认");
  });
});

describe("追溯", () => {
  it("四段：引的各份材料（引了几处、第一处）、用户的几句话、画在这一节里的图、依据它写的条目", () => {
    const task = overallTask();
    const contents = toc(task);
    expect(traceOf(task, contents, itemOf(task, "OA-002"))).toEqual({
      materials: [{ name: "借阅规则.md", count: 2, first: { excerpt: "学生一次最多借 5 本，教师一次最多借 10 本，借期都是 30 天。", locator: "inputs/借阅规则.md" } }],
      clarified: 2, figures: 0, items: [],
    });
    const three = traceOf(task, contents, itemOf(task, "OA-003"));
    expect(three.materials.map((one) => `${one.name}:${one.count}`)).toEqual(["借阅规则.md:1"]);
    expect(three.clarified).toBe(2);
    expect(three.items.map((one) => one.item_id)).toEqual(["UC-002", "UC-003"]);
  });

  it("图只数画在这一节里的：流程节的流程图算，章首的用例图不算", () => {
    const row = (id: string, kind: string): DiagramRow => ({ diagram_id: id, name: id, kind, kind_name: kind, revision_no: 1, revision_by: "executor", revision_at: "2026-10-09T10:00:00+08:00", created_at: "", source_count: 1 });
    const task = overallTask({ diagrams: [row("D-001", "flowchart"), row("D-002", "use_case")] });
    change(task, "OA-002", (page) => { page.depended_by = [{ element_kind: "图", id: "D-001", revision_no: 1 }, { element_kind: "图", id: "D-002", revision_no: 1 }]; });
    expect(traceOf(task, toc(task), itemOf(task, "OA-002")).figures).toBe(1);
  });
});
