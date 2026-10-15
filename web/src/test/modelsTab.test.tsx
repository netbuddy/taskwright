// 工作台「分析模型」页签：全部图的索引表——按种类分组、所属节或章首、修订与「刚改」、查看、被哪些条目依据、两个按钮；表上一行计数。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DiagramRow, Task } from "../api/types";
import { MODELS_EMPTY, MODELS_LEAD, ModelsTab } from "../components/work/ModelsTab";
import { toc } from "../model/chapters";
import { basedOnDiagram, homeText, modelCountLine, modelGroups } from "../model/modelIndex";
import { change, overallTask } from "./fixtures/overallTask";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const row = (id: string, kind: string, kindName: string, over: Partial<DiagramRow> = {}): DiagramRow => ({
  diagram_id: id, name: `图 ${id}`, kind, kind_name: kindName, revision_no: 1, revision_by: "executor", revision_at: "2026-10-09T10:00:00+08:00",
  created_at: "2026-10-09T09:00:00+08:00", source_count: 1, viewed: true, ...over,
});
const cite = (task: Task, diagramId: string, ...pages: string[]) => {
  for (const id of pages) change(task, id, (page) => { page.depended_by = [...(page.depended_by ?? []), { element_kind: "图", id: diagramId, revision_no: 1 }]; });
};
/** 一份画了图的任务：D-001 流程图画自 OA-002（3.2 借书与还书），刚改、没看过；D-002 对象关系图在第 4 章章首；D-003 流程图哪一节都不放。UC-001 依据 D-001。 */
function drawn(): Task {
  const task = overallTask({ diagrams: [
    row("D-002", "class", "对象关系图"),
    row("D-001", "flowchart", "流程图", { revision_no: 3, viewed: false }),
    row("D-003", "flowchart", "流程图", { viewed: false }),
  ] });
  cite(task, "D-001", "OA-002");
  cite(task, "D-002", "OA-005");
  change(task, "UC-001", (item) => { item.sources = [...item.sources, { kind: "图", locator: "D-001", excerpt: "借书" }]; });
  return task;
}
const cells = (id: string) => [...screen.getByTestId(`model-${id}`).querySelectorAll("td")].slice(0, 6).map((td) => td.textContent);

describe("「分析模型」页签", () => {
  it("一张表按种类分组（章首的种类在前，同一种只在第一行写种类）：名称、所属、修订、查看、被依据；表上一行计数；刚改的行标出来", () => {
    const task = drawn();
    render(<div className="app"><ModelsTab task={task} contents={toc(task)} onView={vi.fn()} onEdit={vi.fn()} onOpenItem={vi.fn()} /></div>);
    expect(screen.getByTestId("models-tab")).toHaveTextContent(MODELS_LEAD);
    expect([...document.querySelectorAll("[data-testid^=model-D]")].map((tr) => tr.getAttribute("data-testid"))).toEqual(["model-D-002", "model-D-001", "model-D-003"]);
    expect(cells("D-002")).toEqual(["对象关系图", "D-002图 D-002", "第 4 章 业务对象 章首", "1", "已查看", "—"]);
    expect(cells("D-001")).toEqual(["流程图", "D-001图 D-001", homeText(task, toc(task), "D-001"), "3刚改", "未查看", "UC-001"]);
    expect(cells("D-003")).toEqual(["", "D-003图 D-003", "未归入节", "1", "未查看", "—"]);
    expect(homeText(task, toc(task), "D-001")).toMatch(/^3\.\d+ 借书与还书$/);
    expect(screen.getByTestId("model-D-001")).toHaveClass("ap-fresh");
    expect(screen.getByTestId("model-D-003")).not.toHaveClass("ap-fresh");
    expect(screen.getByTestId("models-count")).toHaveTextContent("共 3 张 · 已查看 1 · 刚改 1 · 被条目依据 1");
  });

  it("「在节中查看」「编辑」与被依据的条目各交给条目区；没有图时写一句怎样得到图", () => {
    const task = drawn();
    const [onView, onEdit, onOpenItem] = [vi.fn(), vi.fn(), vi.fn()];
    const view = render(<div className="app"><ModelsTab task={task} contents={toc(task)} onView={onView} onEdit={onEdit} onOpenItem={onOpenItem} /></div>);
    fireEvent.click(screen.getByTestId("model-view-D-002"));
    fireEvent.click(screen.getByTestId("model-edit-D-001"));
    fireEvent.click(screen.getByText("UC-001", { selector: "a" }));
    expect([onView.mock.calls, onEdit.mock.calls, onOpenItem.mock.calls]).toEqual([[["D-002"]], [["D-001"]], [["UC-001"]]]);
    view.unmount();
    const none = overallTask();
    render(<div className="app"><ModelsTab task={none} contents={toc(none)} onView={vi.fn()} onEdit={vi.fn()} onOpenItem={vi.fn()} /></div>);
    expect(screen.getByTestId("models-empty")).toHaveTextContent(MODELS_EMPTY);
    expect(screen.queryByTestId("models-count")).toBeNull();
  });

  it("被依据只算业务说明以外的条目；计数一行照各行算", () => {
    const task = drawn();
    change(task, "OA-003", (page) => { page.sources = [...page.sources, { kind: "图", locator: "D-002", excerpt: "" }]; });
    expect(basedOnDiagram(task, "D-002")).toEqual([]);
    expect(basedOnDiagram(task, "D-001").map((one) => one.item_id)).toEqual(["UC-001"]);
    expect(modelCountLine(modelGroups(task, toc(task)))).toBe("共 3 张 · 已查看 1 · 刚改 1 · 被条目依据 1");
  });
});
