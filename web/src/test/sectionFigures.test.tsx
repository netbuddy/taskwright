// 业务说明里的图（components/work/overall/Figure.tsx 与它在节里、目录里的接法）：图画在它说明的那一节的哪一块、块的先后、
// 图下面的「画自」与「被依据」、同一块几张图时显示最近修订的一张与「另有 N 张」、「文本与来源」里改图与看来源、
// 看到图就记一次看过、对象节里标出本节的对象、目录末尾「未归入节的图」、地址里与条目依据里的图打开它所在的地方。
// mermaid 包换成假的（jsdom 里画不了图）；取图的详情换成假的接口。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type { DiagramDetail, DiagramRow, Task } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { ToastProvider } from "../components/Toasts";
import { PREVIEW_TEXT, diagramPreview, saveFailedText } from "../model/diagrams";
import { CLASS_MARK_STYLE } from "../model/sectionDiagrams";
import { change, overallTask } from "./fixtures/overallTask";

const fakeRender = vi.fn(async (id: string, text: string) => ({ svg: `<svg id="${id}" viewBox="0 0 300 150" width="100%" style="max-width: 300px;"><text>${text}</text></svg>` }));
vi.mock("mermaid", () => ({ default: { initialize: () => {}, render: (id: string, text: string) => fakeRender(id, text) } }));

Element.prototype.scrollTo ??= function () {};
diagramPreview.delayMs = 10;
afterEach(() => { cleanup(); vi.restoreAllMocks(); fakeRender.mockClear(); vi.unstubAllGlobals(); });

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><div className="app">{children}</div></ToastProvider></AntApp></ConfigProvider>
);
const FLOW = 'flowchart LR\n  a(["读者"])\n  b["OA-002 借书与还书"]\n  a --> b';
const CLASSES = 'classDiagram\n  class Card["OA-005 逾期"]\n  class Hall["OA-010 预留架"]\n  Card --> Hall';
const row = (id: string, kind: string, kindName: string, over: Partial<DiagramRow> = {}): DiagramRow => ({
  diagram_id: id, name: `图 ${id}`, kind, kind_name: kindName, revision_no: 2, revision_by: "executor", revision_at: "2026-10-09T10:00:00+08:00",
  created_at: "2026-10-09T09:00:00+08:00", source_count: 1, ...over,
});
/** 让几页把一张图写成它们的「被谁依据」（也就是这张图的来源页）。 */
function cite(task: Task, diagramId: string, ...pages: string[]): void {
  for (const id of pages) change(task, id, (page) => { page.depended_by = [...(page.depended_by ?? []), { element_kind: "图", id: diagramId, revision_no: 1 }]; });
}
/**
 * 一份画了图的任务：OA-002（3.2 借书与还书）有两张流程图（D-002 更新）与一张时序图；OA-005（第 4 章的对象）有一张状态图，
 * 并与 OA-010 同是对象关系图 D-005 的来源页；D-006 一条页来源都没有。
 */
function drawn(over: Partial<Record<string, Partial<DiagramRow>>> = {}): Task {
  const task = overallTask({ diagrams: [
    row("D-001", "flowchart", "流程图", { revision_at: "2026-10-09T10:00:00+08:00", ...over["D-001"] }),
    row("D-002", "flowchart", "流程图", { revision_at: "2026-10-09T11:00:00+08:00", ...over["D-002"] }),
    row("D-003", "sequence", "时序图", over["D-003"]),
    row("D-004", "state", "状态图", over["D-004"]),
    row("D-005", "class", "对象关系图", over["D-005"]),
    row("D-006", "flowchart", "流程图", over["D-006"]),
  ] });
  cite(task, "D-001", "OA-002");
  cite(task, "D-002", "OA-002", "OA-007");
  cite(task, "D-003", "OA-002");
  cite(task, "D-004", "OA-005");
  cite(task, "D-005", "OA-005", "OA-010");
  return task;
}
const detailOf = (task: Task, id: string, over: Partial<DiagramDetail> = {}): DiagramDetail => {
  const base = task.diagrams!.find((one) => one.diagram_id === id)!;
  const pages = task.items.filter((item) => (item.depended_by ?? []).some((one) => one.element_kind === "图" && one.id === id));
  return {
    ...base, deleted: false, mermaid: base.kind === "class" ? CLASSES : `${FLOW}\n  %% ${id}`, note: "", revisions: [1, 2],
    sources: [
      ...pages.map((page) => ({ kind: "条目", locator: page.item_id, excerpt: "", supports: [], depends_revision: 1, current_revision: page.revision_no, stale: null })),
      { kind: "用户的话", locator: "S1#u2", excerpt: "把借书画成流程图", supports: [] },
    ],
    depended_by: [], drawn: [], ...over,
  } as DiagramDetail;
};
/** 取图的详情换成假的：照任务里的图给；over 里可以按编号改某一张。 */
function serve(task: Task, over: Record<string, Partial<DiagramDetail>> = {}) {
  return vi.spyOn(api, "diagram").mockImplementation(async (_taskId: string, id: string) => detailOf(task, id, over[id]));
}
type Spies = { submit?: ReturnType<typeof vi.fn>; viewed?: ReturnType<typeof vi.fn>; dirty?: ReturnType<typeof vi.fn> };
type From = { diagram?: string | null; diagrams?: boolean; collection?: string };
function Panel({ t, first = "OA-002", readOnly = false, writesOff = false, spies = {}, from = {} }: { t: Task; first?: string | null; readOnly?: boolean; writesOff?: boolean; spies?: Spies; from?: From }) {
  const [selected, setSelected] = useState<string | null>(first);
  return (
    <Wrap>
      <ItemsPanel task={t} initialCollection={from.collection ?? "业务说明"} initialDiagram={from.diagram ?? null} initialDiagrams={from.diagrams ?? false} readOnly={readOnly} writesOff={writesOff} recentlyChanged={[]} pendingItems={new Set()} latestRevision={t.latest_revision}
        selected={selected} onSelect={setSelected} submit={(spies.submit ?? vi.fn(async () => null)) as never} onGenerateDoc={() => {}}
        onDiagramViewed={spies.viewed as never} onDiagramDirty={spies.dirty as never} />
    </Wrap>
  );
}
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const blocks = () => [...screen.getByTestId("topic-page").querySelectorAll(".oa-blk > h3")].map((h) => h.firstChild!.textContent!.trim());
const shown = async (id: string) => within(await screen.findByTestId(`figure-${id}`)).findByTestId("diagram-svg");

describe("图画在节的哪一块", () => {
  it("流程节：流程图在「流程步骤」里，紧跟在说明后面；时序图在末尾的「其他图」里", async () => {
    const task = drawn();
    serve(task);
    render(<Panel t={task} />);
    await shown("D-002");
    expect(blocks()).toEqual(["说明", "流程步骤", "异常分支", "示例", "适用规则", "其他图", "相关角色与对象"]);
    expect(within(screen.getByTestId("topic-fig-steps")).getByTestId("figure-name")).toHaveTextContent("图 D-002");
    expect(within(screen.getByTestId("topic-fig-other")).getByTestId("figure-name")).toHaveTextContent("图 D-003");
  });

  it("对象节：状态图在「状态图」里，对象关系图整张画在「与其他对象的关系」里，本节的对象边框加粗", async () => {
    const task = drawn();
    serve(task);
    render(<Panel t={task} first="OA-005" />);
    await shown("D-004");
    await shown("D-005");
    expect(blocks().slice(0, 3)).toEqual(["说明", "状态图", "与其他对象的关系"]);
    const drawnTexts = fakeRender.mock.calls.map((call) => call[1]);
    expect(drawnTexts).toContain(`${CLASSES}\n  style Card ${CLASS_MARK_STYLE}\n`);
    // 换到同一张图的另一个来源页：标的是另一个类。
    fireEvent.click(screen.getByTestId("toc-OA-010"));
    await shown("D-005");
    await waitFor(() => expect(fakeRender.mock.calls.map((call) => call[1])).toContain(`${CLASSES}\n  style Hall ${CLASS_MARK_STYLE}\n`));
  });

  it("没有图的节没有这几块", () => {
    const task = drawn();
    serve(task);
    render(<Panel t={task} first="OA-003" />);
    for (const slot of ["steps", "state", "relations", "other"]) expect(screen.queryByTestId(`topic-fig-${slot}`)).toBeNull();
  });
});

describe("一张图", () => {
  it("图下面写「画自」哪几节（可点）与别的来源有几条、现在是修订几；被条目依据时写「被依据」", async () => {
    const task = drawn();
    serve(task, { "D-002": { depended_by: [{ element_kind: "条目", id: "UC-002", revision_no: 1 }, { element_kind: "图", id: "D-009", revision_no: 1 }] } });
    render(<Panel t={task} />);
    await shown("D-002");
    const figure = screen.getByTestId("figure-D-002");
    expect(text(within(figure).getByTestId("figure-from"))).toBe("画自：2.1 读者、3.2 借书与还书；另有 1 条别的来源");
    expect(text(within(figure).getByTestId("figure-based"))).toBe(`被依据：${task.items.find((one) => one.item_id === "UC-002")!.title}`);
    expect(within(figure).getByTestId("diagram-sub")).toHaveTextContent("现在是修订 2，由助手改的");
    fireEvent.click(within(within(figure).getByTestId("figure-from")).getByText("2.1 读者"));
    expect(text(screen.getByTestId("topic-title"))).toBe("读者");
  });

  it("同一块有几张图时显示最近修订的那一张，「另有 N 张」展开其余的，点一张换成它", async () => {
    const task = drawn();
    serve(task);
    render(<Panel t={task} />);
    await shown("D-002");
    const steps = screen.getByTestId("topic-fig-steps");
    expect(within(steps).getByTestId("figure-more")).toHaveTextContent("另有 1 张");
    fireEvent.click(within(steps).getByTestId("figure-more"));
    fireEvent.click(within(steps).getByTestId("figure-pick-D-001"));
    await shown("D-001");
    expect(within(steps).getByTestId("figure-name")).toHaveTextContent("图 D-001");
    expect(within(steps).getByTestId("figure-more")).toHaveTextContent("另有 1 张");
    // 只有一张图的块没有「另有」。
    expect(within(screen.getByTestId("topic-fig-other")).queryByTestId("figure-more")).toBeNull();
  });

  it("「文本与来源」展开两个页签：文本可以改，改了图按新文本重画并写明还没有保存；保存成为这张图的一次新修订", async () => {
    const task = drawn();
    serve(task);
    const submit = vi.fn(async () => null);
    const dirty = vi.fn();
    render(<Panel t={task} spies={{ submit, dirty }} />);
    await shown("D-002");
    const figure = screen.getByTestId("figure-D-002");
    expect(within(figure).queryByTestId("diagram-side")).toBeNull();
    fireEvent.click(within(figure).getByTestId("figure-side-toggle"));
    const box = within(figure).getByTestId("diagram-text") as HTMLTextAreaElement;
    expect(box.value).toBe(`${FLOW}\n  %% D-002`);
    expect(within(figure).getByTestId("diagram-save")).toBeDisabled();
    fireEvent.change(box, { target: { value: "flowchart LR\n  a --> c" } });
    expect(within(figure).getByTestId("diagram-preview-note")).toHaveTextContent(PREVIEW_TEXT);
    await waitFor(() => expect(fakeRender.mock.calls.map((call) => call[1])).toContain("flowchart LR\n  a --> c"));
    expect(dirty).toHaveBeenLastCalledWith(true);
    // 放弃改动：回到库里的文本，不再算有没保存的改动。
    fireEvent.click(within(figure).getByTestId("diagram-discard"));
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
    expect(box.value).toBe(`${FLOW}\n  %% D-002`);
    fireEvent.change(box, { target: { value: "flowchart LR\n  a --> c" } });
    fireEvent.click(within(figure).getByTestId("diagram-save"));
    expect(submit).toHaveBeenCalledWith({ kind: "edit_diagram", targets: [{ diagram_id: "D-002", base_revision: 2 }], fields: { mermaid: "flowchart LR\n  a --> c" }, notify_executor: false }, "修改图 D-002");
    // 来源页签：每条来源与图里画了谁。
    fireEvent.click(within(figure).getByTestId("diagram-tab-sources"));
    expect(within(figure).getByTestId("diagram-sources")).toHaveTextContent("把借书画成流程图");
    expect(within(figure).getByTestId("diagram-drawn")).toBeInTheDocument();
  });

  it("没有保存成时把原因写在文本框下面，改的东西还在；助手工作中文本框只读", async () => {
    const task = drawn();
    serve(task);
    const error = new ApiError("stale_revision", "", 409, { diagrams: [{ diagram_id: "D-002", current_revision: 3 }] });
    const submit = vi.fn(async () => error);
    const view = render(<Panel t={task} spies={{ submit }} />);
    await shown("D-002");
    const figure = screen.getByTestId("figure-D-002");
    fireEvent.click(within(figure).getByTestId("figure-side-toggle"));
    fireEvent.change(within(figure).getByTestId("diagram-text"), { target: { value: "flowchart LR\n  a --> c" } });
    fireEvent.click(within(figure).getByTestId("diagram-save"));
    expect(await within(figure).findByTestId("diagram-save-error")).toHaveTextContent(saveFailedText("D-002", error));
    expect((within(figure).getByTestId("diagram-text") as HTMLTextAreaElement).value).toBe("flowchart LR\n  a --> c");
    view.unmount();
    render(<Panel t={task} writesOff />);
    await shown("D-002");
    fireEvent.click(within(screen.getByTestId("figure-D-002")).getByTestId("figure-side-toggle"));
    expect(within(screen.getByTestId("figure-D-002")).getByTestId("diagram-text")).toHaveAttribute("readonly");
  });

  it("读不到与已经删除的图照实说", async () => {
    const task = drawn();
    vi.spyOn(api, "diagram").mockImplementation(async (_taskId: string, id: string) => {
      if (id === "D-003") throw new ApiError("internal", "读库失败", 500);
      return detailOf(task, id, id === "D-002" ? { deleted: true } : {});
    });
    render(<Panel t={task} />);
    expect(await within(await screen.findByTestId("figure-D-002")).findByTestId("diagram-deleted")).toBeInTheDocument();
    expect(await within(screen.getByTestId("figure-D-003")).findByTestId("diagram-load-error")).toHaveTextContent("读不到这张图");
  });
});

describe("看图记录", () => {
  it("图画出来就告诉上面一层一次（这里的浏览器没有 IntersectionObserver，画出来就算看见）；已经看过现在内容的不告诉", async () => {
    const task = drawn({ "D-003": { viewed: true } });
    serve(task);
    const viewed = vi.fn();
    render(<Panel t={task} spies={{ viewed }} />);
    await shown("D-002");
    await shown("D-003");
    await waitFor(() => expect(viewed).toHaveBeenCalledTimes(1));
    expect(viewed.mock.calls[0][0]).toMatchObject({ diagram_id: "D-002", revision_no: 2 });
  });

  it("助手把这张图改出新修订之后再告诉一次；同一次修订不重复", async () => {
    const task = drawn();
    serve(task);
    const viewed = vi.fn();
    const view = render(<Panel t={task} first="OA-005" spies={{ viewed }} />);
    await shown("D-004");
    await waitFor(() => expect(viewed.mock.calls.map((call) => `${call[0].diagram_id}:${call[0].revision_no}`).sort()).toEqual(["D-004:2", "D-005:2"]));
    const next = structuredClone(task);
    next.diagrams!.find((one) => one.diagram_id === "D-004")!.revision_no = 3;
    serve(next);
    view.rerender(<Panel t={next} first="OA-005" spies={{ viewed }} />);
    await waitFor(() => expect(viewed.mock.calls.map((call) => `${call[0].diagram_id}:${call[0].revision_no}`)).toContain("D-004:3"));
    expect(viewed).toHaveBeenCalledTimes(3);
  });

  it("浏览器有 IntersectionObserver 时，滚进看得见的范围才告诉", async () => {
    const watchers: { cb: (entries: { isIntersecting: boolean }[]) => void }[] = [];
    vi.stubGlobal("IntersectionObserver", class { constructor(cb: never) { watchers.push({ cb }); } observe() {} disconnect() {} });
    const task = drawn();
    serve(task);
    const viewed = vi.fn();
    render(<Panel t={task} first="OA-005" spies={{ viewed }} />);
    await shown("D-004");
    await shown("D-005");
    expect(viewed).not.toHaveBeenCalled();
    watchers[0].cb([{ isIntersecting: true }]);
    await waitFor(() => expect(viewed).toHaveBeenCalledTimes(1));
  });
});

describe("图里的连线进「相关角色与对象」，图进追溯行", () => {
  it("对象关系图里与本节的对象相连的对象列在「业务对象」一行；追溯行写本节有几张图", async () => {
    const task = drawn();
    serve(task);
    render(<Panel t={task} first="OA-010" />);
    // OA-010 的文字没有提到别的页，也没有被提到：这一行全靠对象关系图里 Card（OA-005）与 Hall（OA-010）之间的连线。
    expect(text(await screen.findByTestId("related-OA-005"))).toBe("4.1 逾期与罚款");
    expect(text(screen.getByTestId("trace-figures"))).toBe("图 1 张");
  });
});

describe("未归入节的图", () => {
  it("一条页来源都没有的图列在目录末尾的「未归入节的图」里，点它把这几张图画在右边", async () => {
    const task = drawn();
    serve(task);
    render(<Panel t={task} first={null} />);
    expect(text(screen.getByTestId("toc-loose"))).toBe("未归入节的图1");
    fireEvent.click(screen.getByTestId("toc-loose"));
    expect(within(screen.getByTestId("loose-figures")).getByRole("heading", { level: 2 })).toHaveTextContent("未归入节的图");
    await shown("D-006");
    expect(text(within(screen.getByTestId("figure-D-006")).getByTestId("figure-from"))).toBe("画自：另有 1 条别的来源");
  });

  it("每张图都放得进节时目录里没有这一行", () => {
    const task = drawn();
    task.diagrams = task.diagrams!.filter((one) => one.diagram_id !== "D-006");
    serve(task);
    render(<Panel t={task} first={null} />);
    expect(screen.queryByTestId("toc-loose")).toBeNull();
  });
});

describe("地址里的图与条目依据里的图", () => {
  it("地址里带着图的编号：打开那张图所在的节并滚到它；它收在「另有 N 张」里时换成显示它", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const task = drawn();
    serve(task);
    // 从别的页签的地址进来也一样：页签换到业务说明。
    render(<Panel t={task} first={null} from={{ diagram: "D-001", collection: "功能用例" }} />);
    expect(document.querySelector(".itab.on")!.textContent).toContain("业务说明");
    expect(text(await screen.findByTestId("topic-title"))).toBe("借书与还书");
    await shown("D-001");
    expect(within(screen.getByTestId("topic-fig-steps")).getByTestId("figure-name")).toHaveTextContent("图 D-001");
    expect(scrolled).toHaveBeenCalled();
  });

  it("对象关系图打开第 4 章章首；哪一节都放不进的图打开「未归入节的图」；已经不在的图停在业务说明的首页", async () => {
    const task = drawn();
    serve(task);
    const first = render(<Panel t={task} first={null} from={{ diagram: "D-005" }} />);
    expect(await screen.findByTestId("chapter-head-4")).toBeInTheDocument();
    first.unmount();
    const second = render(<Panel t={task} first={null} from={{ diagram: "D-006" }} />);
    expect(await screen.findByTestId("loose-figures")).toBeInTheDocument();
    second.unmount();
    render(<Panel t={task} first={null} from={{ diagram: "D-404" }} />);
    expect(screen.getByTestId("overall-intro")).toBeInTheDocument();
  });

  it("地址里只说看图（tab=diagrams）：停在「分析模型」页签；在那里点「打开所在章节」去那张图所在的节并显示它", async () => {
    const task = drawn();
    serve(task);
    const first = render(<Panel t={task} first={null} from={{ diagrams: true, collection: "功能用例" }} />);
    expect(screen.getByTestId("pane-models")).toHaveClass("on");
    expect(screen.getByTestId("models-tab")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("model-view-D-004"));
    expect(screen.getByTestId("pane-description")).toHaveClass("on");
    await shown("D-004");
    expect(screen.queryByTestId("diagram-side")).toBeNull();
    first.unmount();
  });

  it("条目详情「依据」里的图点了去它所在的节，「依据」里的页点了打开那一节", async () => {
    const task = drawn();
    change(task, "UC-002", (item) => { item.sources = [
      { kind: "图", locator: "D-004", excerpt: "", supports: [], depends_revision: 2, current_revision: 2, stale: null },
      { kind: "条目", locator: "OA-003", excerpt: "", supports: [], depends_revision: 12, current_revision: 12, stale: null },
    ] as never; });
    serve(task);
    render(<Panel t={task} first="UC-002" />);
    const detail = screen.getByTestId("item-detail");
    // 图的编号后面写着图名。
    expect(detail).toHaveTextContent("D-004 图 D-004");
    fireEvent.click(within(detail).getByTestId("note-source-D-004"));
    expect(text(await screen.findByTestId("topic-title"))).toBe("逾期与罚款");
    await shown("D-004");
    cleanup();
    render(<Panel t={task} first="UC-002" />);
    fireEvent.click(within(screen.getByTestId("item-detail")).getByTestId("note-source-OA-003"));
    expect(text(screen.getByTestId("topic-title"))).toBe("预约取书");
  });
});
