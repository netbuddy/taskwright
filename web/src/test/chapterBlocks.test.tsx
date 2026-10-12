// 各章章首页上自己的块（components/work/overall/ChapterBlocks.tsx）：第 1 章的系统边界图与业务目标摘要、各节说明全文；
// 第 2 章的角色与用例对照表、表下的依据与「查看用例图」。mermaid 包换成假的；取图的详情换成假的接口。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { DiagramDetail, DiagramRow, Task } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { ToastProvider } from "../components/Toasts";
import { revisionText } from "../model/diagrams";
import { change, overallTask } from "./fixtures/overallTask";

const fakeRender = vi.fn(async (id: string, text: string) => ({ svg: `<svg id="${id}" viewBox="0 0 300 150" width="100%" style="max-width: 300px;"><text>${text}</text></svg>` }));
vi.mock("mermaid", () => ({ default: { initialize: () => {}, render: (id: string, text: string) => fakeRender(id, text) } }));

Element.prototype.scrollTo ??= function () {};
afterEach(() => { cleanup(); vi.restoreAllMocks(); fakeRender.mockClear(); });

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><div className="app">{children}</div></ToastProvider></AntApp></ConfigProvider>
);
const row = (id: string, kind: string, kindName: string, name: string): DiagramRow => ({
  diagram_id: id, name, kind, kind_name: kindName, revision_no: 2, revision_by: "executor", revision_at: "2026-10-09T10:00:00+08:00", created_at: "2026-10-09T09:00:00+08:00", source_count: 1,
});
const TEXTS: Record<string, string> = {
  "D-001": 'flowchart LR\n  s["借阅系统"]\n  r(["OA-007 读者"])\n  r --> s',
  "D-009": "flowchart LR\n  a --> b",
  "D-002": 'flowchart LR\n  r(["OA-007 读者"])\n  l(["OA-009 馆员"])\n  a(["OA-006 续借"])\n  b(["UC-003 预约图书"])\n  c(["缴纳罚款"])\n  r -->|发起| a\n  r --> b\n  l -->|上架| b\n  r --> c',
};
function serve(task: Task) {
  return vi.spyOn(api, "diagram").mockImplementation(async (_taskId: string, id: string) => ({
    ...task.diagrams!.find((one) => one.diagram_id === id)!, deleted: false, mermaid: TEXTS[id], note: "", revisions: [1, 2], sources: [], depended_by: [], drawn: [],
  } as DiagramDetail));
}
function Panel({ t }: { t: Task }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Wrap>
      <ItemsPanel task={t} initialCollection="总体分析" readOnly={false} writesOff={false} recentlyChanged={[]} pendingItems={new Set()} latestRevision={t.latest_revision}
        selected={selected} onSelect={setSelected} submit={vi.fn(async () => null) as never} onGenerateDoc={() => {}} />
    </Wrap>
  );
}
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const GOALS = { roots: [
  { item_id: "OA-001", title: "借还更省事", goals: [{ item_id: "OA-002", title: "自助办理", goals: [{ item_id: "OA-003", title: "第三层", goals: [], decisions: [] }], decisions: [] }], decisions: [] },
], loose: [] };
const views = (goals: unknown = GOALS) => ({ rules: { rows: [], conflicts: [], unmatched: [] }, goals, decisions: [] }) as never;

describe("第 1 章 概述与范围的章首页", () => {
  it("系统边界图画在最前；业务目标摘要只有目标树的前两层，点一个目标打开那一节，「看全部」去第 6 章", async () => {
    const task = overallTask({ diagrams: [row("D-001", "context", "系统边界图", "借阅系统的边界")], overall_views: views() });
    serve(task);
    render(<Panel t={task} />);
    fireEvent.click(screen.getByTestId("toc-chapter-1"));
    const head = screen.getByTestId("chapter-head-1");
    expect([...head.querySelectorAll(".oa-blk > h3")].map((h) => h.firstChild!.textContent!.trim()).slice(0, 2)).toEqual(["系统边界", "业务目标"]);
    expect(await within(screen.getByTestId("chapter-context")).findByTestId("diagram-svg")).toBeInTheDocument();
    expect(within(screen.getByTestId("chapter-context")).getByTestId("figure-name")).toHaveTextContent("借阅系统的边界");
    const goals = screen.getByTestId("chapter-goals-summary");
    expect([...goals.querySelectorAll("li")].map((li) => li.firstElementChild!.textContent)).toEqual(["借还更省事", "自助办理"]);
    expect(goals).not.toHaveTextContent("第三层");
    fireEvent.click(screen.getByTestId("goals-all"));
    expect(screen.getByTestId("chapter-head-6")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("toc-chapter-1"));
    fireEvent.click(within(screen.getByTestId("chapter-goals-summary")).getByText("自助办理"));
    expect(text(screen.getByTestId("topic-title"))).toBe("借书与还书");
  });

  it("各节的说明在章首页上显示全文（各段都在）；没有系统边界图、没有目标时这两块不画", () => {
    const task = change(overallTask(), "OA-004", (page) => { page.fields["它是什么"] = "第一段。\n\n第二段。"; });
    render(<Panel t={task} />);
    fireEvent.click(screen.getByTestId("toc-chapter-1"));
    expect([...screen.getByTestId("chapter-section-OA-004").querySelectorAll(".oa-prose p")].map((p) => p.textContent)).toEqual(["第一段。", "第二段。"]);
    expect(screen.queryByTestId("chapter-context")).toBeNull();
    expect(screen.queryByTestId("chapter-goals-summary")).toBeNull();
    // 别的章只显示第一段。
    change(task, "OA-007", (page) => { page.fields["它是什么"] = "头一段。\n\n后一段。"; });
    fireEvent.click(screen.getByTestId("toc-chapter-2"));
    expect([...screen.getByTestId("chapter-section-OA-007").querySelectorAll(".oa-prose p")].map((p) => p.textContent)).toEqual(["头一段。"]);
  });
});

describe("第 2 章 角色的章首页", () => {
  it("角色与用例对照表：列是角色，行是用例，格子是线上写的字，末列是所属流程；表下写依据的用例图", async () => {
    const task = overallTask({ diagrams: [row("D-002", "use_case", "用例图", "读者与馆员的用例")] });
    change(task, "UC-003", (item) => { item.sources = [{ kind: "条目", locator: "OA-003", excerpt: "", supports: [] }]; });
    serve(task);
    render(<Panel t={task} />);
    fireEvent.click(screen.getByTestId("toc-chapter-2"));
    expect(screen.getByTestId("usecases-empty")).toHaveTextContent("正在读用例图。");
    const table = await screen.findByTestId("usecases-table");
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["用例", "读者", "馆员", "所属流程"]);
    expect([...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => text(td)).join("|"))).toEqual([
      "续借|发起|—|3.4 续借",
      "预约图书|参与|上架|3.3 预约取书",
      "缴纳罚款|参与|—|—",
    ]);
    expect(text(screen.getByTestId("usecases-basis"))).toBe(`依据：用例图「读者与馆员的用例」（${revisionText(task.diagrams![0])}）查看用例图`);
  });

  it("「查看用例图」展开那张图，再点收起；点表里的流程打开那一节，点依据流程写的条目打开那个条目", async () => {
    const task = overallTask({ diagrams: [row("D-002", "use_case", "用例图", "读者与馆员的用例")] });
    serve(task);
    render(<Panel t={task} />);
    fireEvent.click(screen.getByTestId("toc-chapter-2"));
    await screen.findByTestId("usecases-table");
    expect(screen.queryByTestId("figure-D-002")).toBeNull();
    fireEvent.click(screen.getByTestId("usecases-figure-toggle"));
    expect(await within(screen.getByTestId("figure-D-002")).findByTestId("diagram-svg")).toBeInTheDocument();
    expect(screen.getByTestId("usecases-figure-toggle")).toHaveTextContent("收起用例图");
    fireEvent.click(within(screen.getByTestId("usecase-row-1")).getByText("预约图书"));
    expect(screen.getByTestId("item-detail")).toHaveTextContent("预约图书");
  });

  it("没有用例图时没有这一块；用例图里没有画出角色与用例的连线时写一句话", async () => {
    const none = overallTask();
    const view = render(<Panel t={none} />);
    fireEvent.click(screen.getByTestId("toc-chapter-2"));
    expect(screen.queryByTestId("chapter-usecases")).toBeNull();
    view.unmount();
    const task = overallTask({ diagrams: [row("D-009", "use_case", "用例图", "还没有画角色的用例图")] });
    serve(task);
    render(<Panel t={task} />);
    fireEvent.click(screen.getByTestId("toc-chapter-2"));
    expect(await screen.findByText("用例图里还没有画出角色与用例之间的连线。")).toBeInTheDocument();
  });
});
