// 条目区停在「业务说明」页签时：主体是目录加一节两栏；筛选、未读提示不显示，进度汇总照旧；
// 目录按章，章下面一节一行，带状态点，底下是图例与汇总；点章标题打开章首页（第 3 章是收起展开），点一行打开那一节；
// 目录可以收成把手再展开；没有点任何一节时右边是说明与总计；早先的任务（集合叫领域说明）仍是原来的列表。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import type { Task } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { change, overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
Element.prototype.scrollTo ??= function () {};

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
function Panel({ t, first = null, opened }: { t: Task; first?: string | null; opened?: (id: string | null) => void }) {
  const [selected, setSelected] = useState<string | null>(first);
  return (
    <Wrap><div className="app">
      <ItemsPanel task={t} initialCollection="业务说明" readOnly={false} recentlyChanged={[]} pendingItems={new Set()}
        selected={selected} onSelect={(id) => { opened?.(id); setSelected(id); }} submit={vi.fn(async () => null)} onGenerateDoc={() => {}} />
    </div></Wrap>
  );
}
const rows = () => [...screen.getByTestId("toc").querySelectorAll(".oa-row")].map((r) => r.querySelector(".oa-name")!.textContent);
const row = (id: string) => screen.getByTestId(`toc-${id}`);
const chapter = (no: number) => screen.getByTestId(`toc-chapter-${no}`);

describe("条目区的「业务说明」页签", () => {
  it("业务说明这个集合在「业务说明」页签里；主体是目录加一节两栏；筛选与未读提示不显示，进度汇总照旧；切到别的页签又是列表", () => {
    render(<Panel t={overallTask()} />);
    expect(screen.getByTestId("pane-description")).toHaveClass("on");
    expect(screen.getByTestId("pane-description").textContent).toBe("业务说明11");
    expect(screen.getByTestId("overall-pane")).toBeInTheDocument();
    expect(screen.getByTestId("toc")).toBeInTheDocument();
    expect(document.querySelector(".items-body")).toHaveClass("oa-body");
    expect(document.querySelectorAll(".filt").length).toBe(0);
    expect(screen.queryByTestId("unread-bar")).toBeNull();
    expect(screen.getByTestId("progress")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pane-items"));
    expect(screen.queryByTestId("overall-pane")).toBeNull();
    expect(document.querySelector(".items-body")).not.toHaveClass("oa-body");
    expect(document.querySelectorAll(".filt").length).toBeGreaterThan(0);
    expect(screen.getByTestId("item-UC-001")).toBeInTheDocument();
  });

  it("没有点任何一节时，右边是这个集合的一句说明、总计与提示，不替用户打开第一节", () => {
    const opened = vi.fn();
    render(<Panel t={overallTask()} opened={opened} />);
    const intro = screen.getByTestId("overall-intro");
    expect(intro).toHaveTextContent("按章整理的业务说明：每一节写它是什么、适用规则、待澄清事项，图与需求条目都归在它说明的那一节。");
    expect(intro).toHaveTextContent("现在有 11 节，14 条已经定下，3 条还没定，2 处是助手补的、等你核实。");
    expect(intro).toHaveTextContent("在左边的目录里点一节");
    expect(opened).not.toHaveBeenCalled();
    expect(document.querySelector(".oa-row.cur")).toBeNull();
  });

  it("早先的任务（集合叫领域说明）仍是原来的列表，没有目录", () => {
    const t = overallTask();
    t.definition.collections = t.definition.collections.map((c) => (c.name === "业务说明" ? { ...c, name: "领域说明", prefix: "DN" } : c));
    t.items = t.items.map((i) => (i.collection === "业务说明" ? { ...i, collection: "领域说明" } : i));
    render(<Wrap><div className="app"><ItemsPanel task={t} initialCollection="领域说明" readOnly={false} recentlyChanged={[]} pendingItems={new Set()}
      selected={null} onSelect={() => {}} submit={vi.fn(async () => null)} onGenerateDoc={() => {}} /></div></Wrap>);
    expect(screen.queryByTestId("overall-pane")).toBeNull();
    expect(screen.getByTestId("item-OA-003")).toBeInTheDocument();
    expect(document.querySelectorAll(".filt").length).toBeGreaterThan(0);
  });
});

describe("目录", () => {
  it("七章固定，章下面一节一行；章内下级的节往里缩；每行带状态点；没有贴标签的页在最后的「未归类」下面", () => {
    render(<Panel t={overallTask()} />);
    expect([...screen.getByTestId("toc").querySelectorAll(".oa-ch")].map((one) => one.textContent))
      .toEqual(["1概述与范围", "2角色", "3业务流程▾", "4业务对象", "5业务规则", "6业务目标", "7决策记录与待澄清事项", "未归类"]);
    expect(rows()).toEqual(["闭馆日怎么算", "读者", "馆员", "借阅", "借书与还书", "预约取书", "续借", "逾期与罚款", "馆藏", "术语表", "借书证的有效期", "和校园卡打通"]);
    // 「借书与还书」在「借阅」之下：往里缩一层；「借阅」是顶层。
    // 章下面的节由样式统一往里缩 1.3rem；下级的节在这上面再缩 0.9rem，所以写的是两样加起来。
    expect([row("OA-001").style.marginLeft, row("OA-002").style.marginLeft]).toEqual(["", "2.2rem"]);
    const dot = (id: string) => row(id).querySelector(".oa-dot")!.getAttribute("data-state");
    expect([dot("OA-002"), dot("OA-003"), dot("OA-004"), dot("OA-008")]).toEqual(["settled", "pending", "open", "unsorted"]);
    expect(row("OA-003").getAttribute("title")).toBe("3.3 预约取书：有助手补的，待核实");
    expect(within(screen.getByTestId("toc-unsorted")).getAllByRole("button").map((one) => one.textContent)).toEqual(["借书证的有效期", "和校园卡打通"]);
    expect(row("OA-008")).toHaveClass("dim");
    // 还没有内容的章灰着：夹具里没有目标与决定，也没有算出来的表。
    expect([1, 2, 3, 4, 5, 6, 7].filter((no) => chapter(no).classList.contains("dim"))).toEqual([5, 6, 7]);
  });

  it("底下是三种状态点的图例与一行汇总：几节、几条需求条目、几处待澄清", () => {
    render(<Panel t={overallTask()} />);
    expect([...document.querySelectorAll(".oa-legend span")].map((s) => s.textContent)).toEqual(["说清了", "有助手补的，待核实", "还有没定的"]);
    expect(screen.getByTestId("toc-totals").textContent).toBe("说明共 9 节 · 3 条需求条目 · 3 处待澄清");
  });

  it("第 3 章章名右边的小三角收起它的各节、再点展开，不打开章首页；点章名打开章首页，七章都一样", () => {
    const opened = vi.fn();
    render(<Panel t={overallTask()} first="OA-002" opened={opened} />);
    const fold = () => screen.getByTestId("toc-fold-3");
    fireEvent.click(fold());
    expect(screen.queryByTestId("toc-OA-001")).toBeNull();
    expect(fold()).toHaveAttribute("aria-expanded", "false");
    expect(fold()).toHaveAttribute("aria-label", "展开这一章的各节");
    expect(opened).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chapter-head-3")).toBeNull();
    fireEvent.click(fold());
    expect(screen.getByTestId("toc-OA-001")).toBeInTheDocument();
    // 别的章没有小三角。
    expect(screen.queryByTestId("toc-fold-2")).toBeNull();
    // 第 3 章：点章名打开章首页，各节照旧展开着；章首页里每节一段摘要，依据这一节写了用例的在标题后面写几条。
    fireEvent.click(chapter(3));
    const head3 = screen.getByTestId("chapter-head-3");
    expect(chapter(3)).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("toc-OA-001")).toBeInTheDocument();
    expect(within(head3).getByTestId("chapter-title")).toHaveTextContent("业务流程");
    expect(within(head3).getByTestId("chapter-section-OA-001")).toBeInTheDocument();
    const notes = [...head3.querySelectorAll('[data-testid^="chapter-section-note-"]')].map((one) => [one.getAttribute("data-testid")!.replace("chapter-section-note-", ""), one.textContent]);
    expect(notes.length).toBeGreaterThan(0);
    for (const [, words] of notes) expect(words).toMatch(/^\d+ 条用例$/);
    // 第 2 章：打开章首页，不再停在哪一节上；章首页里是这一章各节的摘要，点节的标题打开那一节。
    fireEvent.click(chapter(2));
    expect(opened).toHaveBeenLastCalledWith(null);
    expect(chapter(2)).toHaveClass("cur");
    const head = screen.getByTestId("chapter-head-2");
    expect(within(head).getByTestId("chapter-title")).toHaveTextContent("角色");
    expect(within(head).getByTestId("chapter-lead")).toHaveTextContent("2 节");
    expect([...head.querySelectorAll("h3")].map((one) => one.textContent)).toEqual(["2.1 读者", "2.2 馆员"]);
    fireEvent.click(within(screen.getByTestId("chapter-section-OA-009")).getByRole("button"));
    expect(opened).toHaveBeenLastCalledWith("OA-009");
    expect(screen.queryByTestId("chapter-head-2")).toBeNull();
    expect(chapter(2)).not.toHaveClass("cur");
  });

  it("点一行打开那一节，这一行反色，页签仍停在业务说明", () => {
    const opened = vi.fn();
    render(<Panel t={overallTask()} opened={opened} />);
    fireEvent.click(row("OA-003"));
    expect(opened).toHaveBeenCalledWith("OA-003");
    expect(row("OA-003")).toHaveClass("cur");
    expect(row("OA-002")).not.toHaveClass("cur");
    expect(screen.queryByTestId("overall-intro")).toBeNull();
    expect(screen.getByTestId("toc")).toBeInTheDocument();
    expect(screen.getByTestId("pane-description")).toHaveClass("on");
  });

  it("已废弃的页在目录里划掉，不占节号，不进汇总", () => {
    const t = overallTask();
    t.items.find((i) => i.item_id === "OA-002")!.fields.状态 = "已废弃";
    render(<Panel t={t} />);
    expect(row("OA-002")).toHaveClass("gone");
    expect(row("OA-002").getAttribute("title")).toBe("借书与还书：已废弃");
    expect(row("OA-003").getAttribute("title")).toMatch(/^3\.2 预约取书/);
    expect(screen.getByTestId("toc-totals").textContent).toMatch(/^说明共 8 节/);
  });

  it("一页都没有时写一句话，七章都灰着", () => {
    const t = overallTask();
    t.items = t.items.filter((i) => i.collection !== "业务说明");
    render(<Panel t={t} />);
    expect(within(screen.getByTestId("toc")).getByText(/还没有内容/)).toBeInTheDocument();
    expect([1, 2, 3, 4, 5, 6, 7].every((no) => chapter(no).classList.contains("dim"))).toBe(true);
    expect(screen.queryByTestId("toc-unsorted")).toBeNull();
    expect(screen.getByTestId("toc-totals").textContent).toBe("说明共 0 节 · 3 条需求条目 · 3 处待澄清");
  });
});

describe("目录收成把手", () => {
  it("点「收起」目录收成把手，点把手再展开；点了一节或一章之后，用户点开的目录回到没有动过的样子", () => {
    render(<Panel t={overallTask()} />);
    const pane = screen.getByTestId("overall-pane");
    expect(pane).toHaveClass("auto");
    fireEvent.click(screen.getByTestId("toc-collapse"));
    expect(pane).toHaveClass("closed");
    fireEvent.click(screen.getByTestId("toc-handle"));
    expect(pane).toHaveClass("open");
    fireEvent.click(screen.getByTestId("toc-collapse"));
    expect(pane).toHaveClass("closed");
    fireEvent.click(screen.getByTestId("toc-handle"));
    // 窄的时候展开的目录盖在右边的内容上面（样式里按条目区的宽度定）；点了一节它就该让开，所以回到没有动过的样子。
    fireEvent.click(row("OA-002"));
    expect(pane).toHaveClass("auto");
    fireEvent.click(screen.getByTestId("toc-collapse"));
    fireEvent.click(screen.getByTestId("toc-handle"));
    fireEvent.click(chapter(4));
    expect(pane).toHaveClass("auto");
  });
});

describe("术语表", () => {
  it("是第 4 章的最后一节：右边是两列的表，只收标签含概念、不待核实的页；表下面写明哪几页还待核实", () => {
    render(<Panel t={overallTask()} />);
    const entry = screen.getByTestId("toc-glossary");
    expect(entry.getAttribute("title")).toBe("4.3 术语表");
    // 它排在第 4 章各节之后、下一章之前。
    expect(chapter(4).parentElement!.lastElementChild).toBe(entry);
    fireEvent.click(entry);
    expect(entry).toHaveClass("cur");
    expect(screen.queryByTestId("overall-intro")).toBeNull();
    const table = screen.getByTestId("glossary");
    expect([...table.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["标题与别名", "它是什么"]);
    expect([...table.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("b")!.textContent)).toEqual(["读者", "馆藏"]);
    expect(screen.getByTestId("glossary-OA-010")).toHaveTextContent("馆藏又叫：藏书图书馆登记在册的每一本实体书，一本一个条码。");
    expect(screen.getByTestId("glossary-note").textContent).toBe("待核实的概念确认后才会进文档。现在有 2 页还待核实，没有收进来：预约取书、逾期与罚款。");
    expect(screen.getByTestId("toc")).toBeInTheDocument();
  });

  it("点术语表里的一行、点还待核实的那一页、或者点目录里的一行，都打开那一节", () => {
    const opened = vi.fn();
    render(<Panel t={overallTask()} opened={opened} />);
    fireEvent.click(screen.getByTestId("toc-glossary"));
    fireEvent.click(screen.getByTestId("glossary-OA-007"));
    expect(opened).toHaveBeenLastCalledWith("OA-007");
    expect(screen.queryByTestId("glossary")).toBeNull();
    expect(screen.getByTestId("toc-glossary")).not.toHaveClass("cur");
    fireEvent.click(screen.getByTestId("toc-glossary"));
    fireEvent.click(within(screen.getByTestId("glossary-note")).getByText("逾期与罚款"));
    expect(opened).toHaveBeenLastCalledWith("OA-005");
    fireEvent.click(screen.getByTestId("toc-glossary"));
    fireEvent.click(row("OA-002"));
    expect(screen.queryByTestId("glossary")).toBeNull();
  });

  it("没有标签含概念的页时目录里没有术语表这一节；概念都还待核实时表是空的，写一句话", () => {
    const none = overallTask();
    for (const item of none.items) if (item.collection === "业务说明") item.fields.标签 = [];
    const { unmount } = render(<Panel t={none} />);
    expect(screen.queryByTestId("toc-glossary")).toBeNull();
    unmount();
    const waiting = overallTask();
    for (const item of waiting.items) if (item.collection === "业务说明") item.pending_verification = true;
    render(<Panel t={waiting} />);
    fireEvent.click(screen.getByTestId("toc-glossary"));
    expect(screen.getByTestId("glossary")).toHaveTextContent("还没有可以进术语表的主题");
  });
});

describe("依据的主题待核实或已废弃的条目", () => {
  it("条目行上有一枚琥珀色小标签，悬停说明是哪一页、怎么办；依据没有问题的条目没有", () => {
    const t = overallTask();
    change(t, "UC-003", (i) => { i.basis_pending = { item_id: "OA-003", reason: "deprecated", see: "OA-006" }; });
    change(t, "UC-002", (i) => { i.basis_pending = null; });
    render(<Wrap><div className="app"><ItemsPanel task={t} initialCollection="功能用例" readOnly={false} recentlyChanged={[]} pendingItems={new Set()}
      selected={null} onSelect={() => {}} submit={vi.fn(async () => null)} onGenerateDoc={() => {}} /></div></Wrap>);
    const pending = screen.getByTestId("basis-pending-UC-001");
    expect(pending).toHaveTextContent("依据的主题待核实");
    expect(pending.getAttribute("title")).toBe("它依据的主题 OA-005「逾期与罚款」里有助手补的内容还没有确认；到业务说明里确认那一节，这里就消掉。");
    const gone = screen.getByTestId("basis-pending-UC-003");
    expect(gone).toHaveTextContent("依据的主题已废弃");
    expect(gone.getAttribute("title")).toBe("它依据的主题 OA-003「预约取书」已废弃，改看 OA-006「续借」。把依据改到还在用的主题上。");
    expect(screen.queryByTestId("basis-pending-UC-002")).toBeNull();
  });

  it("依据的图用户还没有看过时，小标签写的是图，悬停说明里写图名", () => {
    const t = overallTask();
    t.diagrams = [{ diagram_id: "D-002", name: "借书的流程", kind: "flowchart", kind_name: "流程图", revision_no: 1, revision_by: "executor", revision_at: "", created_at: "", source_count: 1 }];
    change(t, "UC-002", (i) => { i.basis_pending = { item_id: "D-002", reason: "unviewed", see: null }; });
    render(<Wrap><div className="app"><ItemsPanel task={t} initialCollection="功能用例" readOnly={false} recentlyChanged={[]} pendingItems={new Set()}
      selected={null} onSelect={() => {}} submit={vi.fn(async () => null)} onGenerateDoc={() => {}} /></div></Wrap>);
    const unseen = screen.getByTestId("basis-pending-UC-002");
    expect(unseen).toHaveTextContent("依据的图还没有看过");
    expect(unseen.getAttribute("title")).toBe("它依据的图「借书的流程」现在的内容你还没有看过；到业务说明里把这张图看一遍，这里就消掉。");
  });
});
