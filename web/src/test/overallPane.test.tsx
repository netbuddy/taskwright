// 条目区停在「总体分析」页签时：主体是提纲加主题页两栏；筛选、未读提示不显示，进度汇总照旧；
// 提纲一页一行，带状态点与计数，底下是图例与总计；点小三角收起或展开下级，点一行打开那一页；
// 提纲可以收成把手再展开；没有点任何主题时右边是说明与总计；早先的任务（集合叫领域说明）仍是原来的列表。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import type { Task } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
Element.prototype.scrollTo ??= function () {};

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
function Panel({ t, first = null, opened }: { t: Task; first?: string | null; opened?: (id: string | null) => void }) {
  const [selected, setSelected] = useState<string | null>(first);
  return (
    <Wrap><div className="app">
      <ItemsPanel task={t} initialCollection="总体分析" readOnly={false} recentlyChanged={[]} pendingItems={new Set()}
        selected={selected} onSelect={(id) => { opened?.(id); setSelected(id); }} submit={vi.fn(async () => null)} onGenerateDoc={() => {}} />
    </div></Wrap>
  );
}
const rows = () => [...screen.getByTestId("outline").querySelectorAll(".oa-row")].map((r) => r.querySelector(".oa-name")!.textContent);
const row = (id: string) => screen.getByTestId(`outline-${id}`);

describe("条目区的「总体分析」页签", () => {
  it("主体是提纲加主题页两栏；筛选与未读提示不显示，进度汇总照旧；切到别的页签又是列表", () => {
    render(<Panel t={overallTask()} />);
    expect(screen.getByTestId("overall-pane")).toBeInTheDocument();
    expect(screen.getByTestId("outline")).toBeInTheDocument();
    expect(document.querySelector(".items-body")).toHaveClass("oa-body");
    expect(document.querySelectorAll(".filt").length).toBe(0);
    expect(screen.queryByTestId("unread-bar")).toBeNull();
    expect(screen.getByTestId("progress")).toBeInTheDocument();
    fireEvent.click(screen.getByText("功能用例", { selector: ".itab" }));
    expect(screen.queryByTestId("overall-pane")).toBeNull();
    expect(document.querySelector(".items-body")).not.toHaveClass("oa-body");
    expect(document.querySelectorAll(".filt").length).toBeGreaterThan(0);
    expect(screen.getByTestId("item-UC-001")).toBeInTheDocument();
  });

  it("没有点任何主题时，右边是这个集合的一句说明、总计与提示，不替用户打开第一页", () => {
    const opened = vi.fn();
    render(<Panel t={overallTask()} opened={opened} />);
    const intro = screen.getByTestId("overall-intro");
    expect(intro).toHaveTextContent("用这件事自己的话写下的主题");
    expect(intro).toHaveTextContent("现在有 11 个主题，14 条已经定下，3 条还没定，2 处是助手补的、等你核实。");
    expect(intro).toHaveTextContent("在左边的提纲里点一个主题");
    expect(opened).not.toHaveBeenCalled();
    expect(document.querySelector(".oa-row.cur")).toBeNull();
  });

  it("早先的任务（集合叫领域说明）仍是原来的列表，没有提纲", () => {
    const t = overallTask();
    t.definition.collections = t.definition.collections.map((c) => (c.name === "总体分析" ? { ...c, name: "领域说明", prefix: "DN" } : c));
    t.items = t.items.map((i) => (i.collection === "总体分析" ? { ...i, collection: "领域说明" } : i));
    render(<Wrap><div className="app"><ItemsPanel task={t} initialCollection="领域说明" readOnly={false} recentlyChanged={[]} pendingItems={new Set()}
      selected={null} onSelect={() => {}} submit={vi.fn(async () => null)} onGenerateDoc={() => {}} /></div></Wrap>);
    expect(screen.queryByTestId("overall-pane")).toBeNull();
    expect(screen.getByTestId("item-OA-003")).toBeInTheDocument();
    expect(document.querySelectorAll(".filt").length).toBeGreaterThan(0);
  });
});

describe("提纲", () => {
  it("一页一行，按上级主题往里缩；每行带状态点与计数", () => {
    render(<Panel t={overallTask()} />);
    expect(rows()).toEqual(["借阅", "借书与还书", "预约取书", "闭馆日怎么算", "逾期与罚款", "续借", "读者", "借书证的有效期", "馆员", "馆藏", "和校园卡打通"]);
    // 「闭馆日怎么算」在「预约取书」下面，「预约取书」在「借阅」下面。
    expect(row("OA-004").closest("ul")!.parentElement).toContainElement(row("OA-003"));
    expect(row("OA-003").closest("ul")!.parentElement).toContainElement(row("OA-001"));
    const dot = (id: string) => row(id).querySelector(".oa-dot")!.getAttribute("data-state");
    expect([dot("OA-002"), dot("OA-003"), dot("OA-004"), dot("OA-008")]).toEqual(["settled", "pending", "open", "unsorted"]);
    expect(screen.getByTestId("outline-count-OA-003")).toHaveTextContent("3 定 · 1 问");
    expect(screen.getByTestId("outline-count-OA-002")).toHaveTextContent("5 定");
    expect(screen.getByTestId("outline-count-OA-008")).toHaveTextContent("未归类");
    expect(screen.queryByTestId("outline-count-OA-001")).toBeNull();
  });

  it("底下是四种状态点的图例与一行总计", () => {
    render(<Panel t={overallTask()} />);
    expect([...document.querySelectorAll(".oa-legend span")].map((s) => s.textContent)).toEqual(["说清了", "有助手补的，待核实", "还有没定的", "记下了，还没归类"]);
    expect(screen.getByTestId("outline-totals").textContent).toBe("11 个主题 · 14 条已定 · 3 条待问 · 2 处待核实");
  });

  it("点小三角收起下级、再点展开；点小三角不算打开那一页", () => {
    const opened = vi.fn();
    render(<Panel t={overallTask()} opened={opened} />);
    fireEvent.click(screen.getByTestId("outline-fold-OA-003"));
    expect(screen.queryByTestId("outline-OA-004")).toBeNull();
    expect(screen.getByTestId("outline-fold-OA-003")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByTestId("outline-fold-OA-003"));
    expect(screen.getByTestId("outline-OA-004")).toBeInTheDocument();
    expect(opened).not.toHaveBeenCalled();
    // 没有下级的行没有小三角。
    expect(screen.queryByTestId("outline-fold-OA-009")).toBeNull();
  });

  it("点一行打开那一页，这一行反色，页签仍停在总体分析", () => {
    const opened = vi.fn();
    render(<Panel t={overallTask()} opened={opened} />);
    fireEvent.click(row("OA-003"));
    expect(opened).toHaveBeenCalledWith("OA-003");
    expect(row("OA-003")).toHaveClass("cur");
    expect(row("OA-002")).not.toHaveClass("cur");
    expect(screen.queryByTestId("overall-intro")).toBeNull();
    expect(screen.getByTestId("outline")).toBeInTheDocument();
    expect(document.querySelector(".itab.on")!.textContent).toBe("总体分析11");
  });

  it("已废弃的页在提纲里划掉，不进总计", () => {
    const t = overallTask();
    t.items.find((i) => i.item_id === "OA-011")!.fields.状态 = "已废弃";
    render(<Panel t={t} />);
    expect(row("OA-011")).toHaveClass("gone");
    expect(screen.getByTestId("outline-totals").textContent).toMatch(/^10 个主题/);
  });

  it("一页主题都没有时写一句话", () => {
    const t = overallTask();
    t.items = t.items.filter((i) => i.collection !== "总体分析");
    render(<Panel t={t} />);
    expect(within(screen.getByTestId("outline")).getByText(/还没有主题/)).toBeInTheDocument();
    expect(screen.getByTestId("outline-totals").textContent).toBe("0 个主题 · 0 条已定 · 0 条待问 · 0 处待核实");
  });
});

describe("提纲收成把手", () => {
  it("点「收起」提纲收成把手，点把手再展开；点了一个主题之后，用户点开的提纲回到没有动过的样子", () => {
    render(<Panel t={overallTask()} />);
    const pane = screen.getByTestId("overall-pane");
    expect(pane).toHaveClass("auto");
    fireEvent.click(screen.getByTestId("outline-collapse"));
    expect(pane).toHaveClass("closed");
    fireEvent.click(screen.getByTestId("outline-handle"));
    expect(pane).toHaveClass("open");
    fireEvent.click(screen.getByTestId("outline-collapse"));
    expect(pane).toHaveClass("closed");
    fireEvent.click(screen.getByTestId("outline-handle"));
    // 窄的时候展开的提纲盖在主题页上面（样式里按条目区的宽度定）；点了一个主题它就该让开，所以回到没有动过的样子。
    fireEvent.click(row("OA-002"));
    expect(pane).toHaveClass("auto");
  });
});
