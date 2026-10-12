// 图放在业务说明的哪里（model/sectionDiagrams.ts）：按种类与来源页归到章首或节里的某一块。
import { describe, expect, it } from "vitest";
import type { DiagramRow, Task } from "../api/types";
import { toc } from "../model/chapters";
import {
  CLASS_MARK_STYLE, classNamesOf, diagramViewTarget, diagramsOfKind, diagramsOfPage, figureHome, firstFigureHome, looseDiagrams, markClasses, sectionFigures, sourcePages,
} from "../model/sectionDiagrams";
import { change, itemOf, overallTask } from "./fixtures/overallTask";

const row = (id: string, kind: string, at = "2026-10-09T10:00:00+08:00"): DiagramRow =>
  ({ diagram_id: id, name: `图 ${id}`, kind, kind_name: kind, revision_no: 1, revision_by: "executor", revision_at: at, created_at: at, source_count: 1 });
/** 让几页把一张图写成它们的「被谁依据」（也就是这张图的来源页）。 */
function cite(task: Task, diagramId: string, ...pages: string[]): void {
  for (const id of pages) change(task, id, (page) => { page.depended_by = [...(page.depended_by ?? []), { element_kind: "图", id: diagramId, revision_no: 1 }]; });
}
// 夹具里：OA-001、OA-002、OA-003、OA-006 在第 3 章；OA-005、OA-010 在第 4 章；OA-007、OA-009 在第 2 章；OA-004 在第 1 章；OA-008、OA-011 未归类。
function drawn(): Task {
  const task = overallTask({ diagrams: [
    row("D-001", "context"), row("D-002", "use_case"), row("D-003", "class"),
    row("D-004", "flowchart", "2026-10-09T10:00:00+08:00"), row("D-005", "flowchart", "2026-10-09T11:00:00+08:00"),
    row("D-006", "state"), row("D-007", "sequence"), row("D-008", "flowchart"), row("D-009", "state"), row("D-010", "sequence"), row("D-011", "mindmap"),
  ] });
  cite(task, "D-001", "OA-007", "OA-009");
  cite(task, "D-002", "OA-007", "OA-002");
  cite(task, "D-003", "OA-005", "OA-010", "OA-003");
  cite(task, "D-004", "OA-002");            // 借书与还书的流程图（早一点的一张）
  cite(task, "D-005", "OA-002", "OA-007");  // 同一页的另一张流程图，来源里还有一页角色
  cite(task, "D-006", "OA-005");            // 对象的状态图
  cite(task, "D-007", "OA-006", "OA-002");  // 时序图：两个来源页
  cite(task, "D-008", "OA-009");            // 流程图的来源只有一页角色
  cite(task, "D-009", "OA-001");            // 状态图的来源是一页流程
  cite(task, "D-011", "OA-008");            // 认不出种类的图，来源是一页未归类的页
  return task;                               // D-010 一条页来源都没有
}
const ids = (rows: DiagramRow[]) => rows.map((one) => one.diagram_id);
const slots = (task: Task, id: string) => Object.fromEntries(Object.entries(sectionFigures(task, toc(task), itemOf(task, id))).map(([slot, rows]) => [slot, ids(rows)]));

describe("一页的图与一张图的来源页", () => {
  it("一页的图取自它的「被谁依据」里的图，只认还在的；一张图的来源页照目录的先后", () => {
    const task = drawn();
    change(task, "OA-002", (page) => { page.depended_by!.push({ element_kind: "图", id: "D-404", revision_no: 1 }, { element_kind: "条目", id: "UC-001", revision_no: 3 }); });
    expect(ids(diagramsOfPage(task, itemOf(task, "OA-002")))).toEqual(["D-005", "D-007", "D-004", "D-002"]);
    const contents = toc(task);
    // D-007：OA-002 是 3.2，OA-006 是 3.4；D-003：OA-003（3.3）在两页对象之前。
    expect(sourcePages(task, contents, "D-007").map((page) => page.item_id)).toEqual(["OA-002", "OA-006"]);
    expect(sourcePages(task, contents, "D-003").map((page) => page.item_id)).toEqual(["OA-003", "OA-005", "OA-010"]);
    expect(sourcePages(task, contents, "D-010")).toEqual([]);
  });
});

describe("一节里各块放哪几张图", () => {
  it("流程图放进流程节的「流程步骤」，最近修订的在前；时序图放进它第一个来源页的「其他图」", () => {
    const task = drawn();
    expect(slots(task, "OA-002")).toEqual({ steps: ["D-005", "D-004"], state: [], relations: [], other: ["D-007"] });
    // D-007 的另一个来源页不重复放。
    expect(slots(task, "OA-006")).toEqual({ steps: [], state: [], relations: [], other: [] });
  });

  it("状态图放进对象节的「状态图」，对象关系图放进把它写成来源的对象节的「与其他对象的关系」；流程节里不放对象关系图", () => {
    const task = drawn();
    expect(slots(task, "OA-005")).toEqual({ steps: [], state: ["D-006"], relations: ["D-003"], other: [] });
    expect(slots(task, "OA-010")).toEqual({ steps: [], state: [], relations: ["D-003"], other: [] });
    expect(slots(task, "OA-003")).toEqual({ steps: [], state: [], relations: [], other: [] });
  });

  it("流程图的来源里没有流程节、状态图的来源里没有对象节：放进第一个来源页的「其他图」；角色节不放别人的流程图与章首的图", () => {
    const task = drawn();
    expect(slots(task, "OA-009")).toEqual({ steps: [], state: [], relations: [], other: ["D-008"] });
    expect(slots(task, "OA-001")).toEqual({ steps: [], state: [], relations: [], other: ["D-009"] });
    // OA-007 是 D-001、D-002、D-005 的来源页：前两张在章首，D-005 有流程节可放，都不进这一节。
    expect(slots(task, "OA-007")).toEqual({ steps: [], state: [], relations: [], other: [] });
    // 未归类的页也可以是图的家。
    expect(slots(task, "OA-008")).toEqual({ steps: [], state: [], relations: [], other: ["D-011"] });
  });
});

describe("一张图放在哪里", () => {
  it("章首的三种按种类；别的按来源页；一条页来源都没有的另列；任务里没有的是 null", () => {
    const task = drawn();
    const contents = toc(task);
    const home = (id: string) => figureHome(task, contents, id);
    expect([home("D-001"), home("D-002"), home("D-003")]).toEqual([{ where: "chapter", chapter: 1 }, { where: "chapter", chapter: 2 }, { where: "chapter", chapter: 4 }]);
    expect(home("D-005")).toEqual({ where: "section", itemId: "OA-002", slot: "steps" });
    expect(home("D-006")).toEqual({ where: "section", itemId: "OA-005", slot: "state" });
    expect(home("D-007")).toEqual({ where: "section", itemId: "OA-002", slot: "other" });
    expect(home("D-008")).toEqual({ where: "section", itemId: "OA-009", slot: "other" });
    expect([home("D-010"), home("D-404")]).toEqual([{ where: "loose" }, null]);
    expect(ids(looseDiagrams(task, contents))).toEqual(["D-010"]);
    expect(ids(diagramsOfKind(task, "flowchart"))).toEqual(["D-005", "D-008", "D-004"]);
  });

  it("第一处有图的地方：有系统边界图是第 1 章章首；没有就照目录从上到下找；一张图都没有是 null", () => {
    const task = drawn();
    expect(firstFigureHome(task, toc(task))).toEqual({ where: "chapter", chapter: 1 });
    const flows = overallTask({ diagrams: [row("D-001", "flowchart"), row("D-002", "class")] });
    cite(flows, "D-001", "OA-006");
    cite(flows, "D-002", "OA-005");
    expect(firstFigureHome(flows, toc(flows))).toEqual({ where: "section", itemId: "OA-006", slot: "steps" });
    const objects = overallTask({ diagrams: [row("D-002", "class")] });
    cite(objects, "D-002", "OA-005");
    expect(firstFigureHome(objects, toc(objects))).toEqual({ where: "chapter", chapter: 4 });
    const only = overallTask({ diagrams: [row("D-001", "sequence")] });
    expect(firstFigureHome(only, toc(only))).toEqual({ where: "loose" });
    expect(firstFigureHome(overallTask(), toc(overallTask()))).toBeNull();
  });
});

describe("标出本节的对象与看图记录", () => {
  const CLASSES = 'classDiagram\n  class Card["OA-005 借书证"]\n  class Fine["OA-010 逾期"]\n  class Reader["读者"]\n  Card --> Fine : 产生\n';

  it("对象关系图里代表这一页的类：节点文字里写着这一页编号的那几个；图里没有画这一页时一个都没有", () => {
    const task = overallTask();
    expect(classNamesOf(CLASSES, task, "OA-005")).toEqual(["Card"]);
    expect(classNamesOf(CLASSES, task, "OA-010")).toEqual(["Fine"]);
    expect(classNamesOf(CLASSES, task, "OA-003")).toEqual([]);
  });

  it("标出这几个类：在文本后面各添一行 style 语句；一个类都没有、或者不是类图写法时原样返回", () => {
    expect(markClasses(CLASSES, ["Card", "Fine"])).toBe(`${CLASSES.trimEnd()}\n  style Card ${CLASS_MARK_STYLE}\n  style Fine ${CLASS_MARK_STYLE}\n`);
    expect(markClasses(CLASSES, [])).toBe(CLASSES);
    const flow = "flowchart LR\n  a --> b\n";
    expect(markClasses(flow, ["a"])).toBe(flow);
  });

  it("看到一张图要不要记：任务进行中、它现在的内容还没有看过才记，记在它现在的修订上", () => {
    const task = overallTask();
    const seen = { ...row("D-001", "flowchart"), revision_no: 4 };
    expect(diagramViewTarget(task, seen)).toEqual({ diagram_id: "D-001", base_revision: 4 });
    expect(diagramViewTarget(task, { ...seen, viewed: false })).toEqual({ diagram_id: "D-001", base_revision: 4 });
    expect(diagramViewTarget(task, { ...seen, viewed: true })).toBeNull();
    expect(diagramViewTarget(overallTask({ status: "已完成" }), seen)).toBeNull();
    expect(diagramViewTarget(null, seen)).toBeNull();
  });
});
