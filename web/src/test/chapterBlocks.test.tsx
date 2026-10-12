// 各章章首页上自己的块（components/work/overall/ChapterBlocks.tsx）：第 1 章的系统边界图与业务目标摘要、各节说明全文；
// 第 2 章的角色与用例对照表、表下的依据与「查看用例图」；第 4 章的对象关系图；第 5 章的规则表与冲突；第 6 章的目标树；
// 第 7 章按时间的表。mermaid 包换成假的；取图的详情换成假的接口。

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
  "D-003": 'classDiagram\n  class Fine["OA-005 逾期与罚款"]\n  class Stock["OA-010 馆藏"]\n  Stock --> Fine',
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

describe("第 4 章 业务对象的章首页", () => {
  it("整张对象关系图画在各节摘要之前；没有对象关系图时没有这一块", async () => {
    const task = overallTask({ diagrams: [row("D-003", "class", "对象关系图", "借阅的对象")] });
    serve(task);
    const view = render(<Panel t={task} />);
    fireEvent.click(screen.getByTestId("toc-chapter-4"));
    expect(await within(screen.getByTestId("chapter-classes")).findByTestId("diagram-svg")).toBeInTheDocument();
    // 章首画的是库里的原文，不标哪一个对象。
    expect(fakeRender.mock.calls.map((call) => call[1])).toEqual([TEXTS["D-003"]]);
    expect([...screen.getByTestId("chapter-head-4").querySelectorAll(".oa-blk > h3")].map((h) => text(h))[0]).toBe("对象关系");
    view.unmount();
    render(<Panel t={overallTask()} />);
    fireEvent.click(screen.getByTestId("toc-chapter-4"));
    expect(screen.queryByTestId("chapter-classes")).toBeNull();
  });
});

describe("第 5 章 业务规则的章首页", () => {
  const rule = (item_id: string, index: number, ruleText: string, conflicts: string[] = [], sources: { kind: string; locator: string; excerpt: string }[] = []) =>
    ({ item_id, title: "", index, text: ruleText, sources, conflicts });
  const rules = (over: Partial<{ conflicts: string[]; unmatched: string[] }> = {}) => ({
    rows: [
      rule("OA-002", 0, "学生一次最多借 5 本。", [], [{ kind: "文档原文", locator: "inputs/借阅规则.md", excerpt: "学生一次最多借 5 本" }, { kind: "用户的话", locator: "s1#u2", excerpt: "五本" }]),
      rule("OA-003", 2, "保留期内这本书不能续借。", ["TBD-001"], [{ kind: "用户的话", locator: "s1#u5", excerpt: "有人预约的书不能续借。" }]),
      rule("OA-006", 0, "每本书可以续借一次。", ["TBD-001"]),
      // OA-003 的第 4 条在夹具里是助手补的、还没有确认；OA-005 的第 1 条确认过之后不再待核实。
      rule("OA-003", 3, "保留期是 3 天。", [], [{ kind: "助手补充", locator: "", excerpt: "按常见做法补的。" }]),
    ],
    conflicts: ["TBD-001"], unmatched: [], ...over,
  });
  const withRules = (table: unknown) => overallTask({ overall_views: { rules: table, goals: { roots: [], loose: [] }, decisions: [] } as never });

  it("规则表：一条一行，写出自哪一节与出处（第一条，另有几条）；点一行打开那一节", () => {
    render(<Panel t={withRules(rules())} />);
    fireEvent.click(screen.getByTestId("toc-chapter-5"));
    expect(screen.getByTestId("chapter-lead")).toHaveTextContent("4 条，自各节「适用规则」汇总");
    const table = screen.getByTestId("rules-table");
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["规则", "出自", "出处"]);
    expect([...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => text(td)).join("|"))).toEqual([
      "学生一次最多借 5 本。|3.2 借书与还书|材料 借阅规则.md「学生一次最多借 5 本」 等 2 条",
      "保留期内这本书不能续借。有冲突，已记为待澄清|3.3 预约取书|你说的「有人预约的书不能续借。」",
      "每本书可以续借一次。有冲突，已记为待澄清|3.4 续借|—",
      // 助手补的、用户还没有确认的规则：出处里不写「你确认过」。
      "保留期是 3 天。|3.3 预约取书|助手补的 · 理由：按常见做法补的。",
    ]);
    fireEvent.click(screen.getByTestId("rule-OA-006-0"));
    expect(text(screen.getByTestId("topic-title"))).toBe("续借");
  });

  it("标了冲突的行有底色，表上面写「N 对相互冲突，已记为待澄清」并列出那几个问题，点一个打开它；对不上规则的另说一句", () => {
    render(<Panel t={withRules(rules({ conflicts: ["TBD-001", "TBD-003"], unmatched: ["TBD-003"] }))} />);
    fireEvent.click(screen.getByTestId("toc-chapter-5"));
    expect(screen.getByTestId("rule-OA-002-0")).not.toHaveClass("conflict");
    expect(screen.getByTestId("rule-OA-003-2")).toHaveClass("conflict");
    expect(text(screen.getByTestId("rules-conflicts"))).toBe("2 对相互冲突，已记为待澄清：保留的 3 天里遇到闭馆日，算不算在内？、逾期从哪一天算起？。其中 1 对在表里对不上是哪两条规则，请打开问题看。");
    fireEvent.click(within(screen.getByTestId("rules-conflicts")).getAllByRole("button")[1]);
    expect(screen.getByTestId("item-detail")).toHaveTextContent("逾期从哪一天算起？");
  });

  it("没有冲突时不写那一句；一条规则都没有时写一句话", () => {
    const view = render(<Panel t={withRules(rules({ conflicts: [] }))} />);
    fireEvent.click(screen.getByTestId("toc-chapter-5"));
    expect(screen.queryByTestId("rules-conflicts")).toBeNull();
    view.unmount();
    render(<Panel t={overallTask()} />);
    fireEvent.click(screen.getByTestId("toc-chapter-5"));
    expect(screen.getByTestId("chapter-rules")).toHaveTextContent("各节还没有写适用规则。");
  });
});

describe("第 6 章 业务目标的章首页", () => {
  it("目标树：目标一层一层往里缩，挂在目标下的决定带着为什么；没有挂到目标下的决定另列；点一个打开那一节", () => {
    const tree = { roots: [{
      item_id: "OA-001", title: "借还更省事", decisions: [{ item_id: "OA-004", title: "闭馆日不计入保留期", why: "读者周末来不了。" }],
      goals: [{ item_id: "OA-002", title: "自助办理", goals: [], decisions: [{ item_id: "OA-006", title: "续借在自助机上办", why: "" }] }],
    }], loose: [{ item_id: "OA-010", title: "馆藏按册登记", why: "一册一个条码。" }] };
    render(<Panel t={overallTask({ overall_views: views(tree) })} />);
    fireEvent.click(screen.getByTestId("toc-chapter-6"));
    const root = screen.getByTestId("goal-OA-001");
    expect(root.firstElementChild).toHaveTextContent("借还更省事");
    expect(within(root).getByTestId("goal-OA-002")).toHaveTextContent("自助办理");
    expect(text(within(root).getByTestId("goal-decision-OA-004"))).toBe("决定闭馆日不计入保留期为什么：读者周末来不了。");
    // 没有写为什么的决定不写「为什么」。
    expect(text(within(screen.getByTestId("goal-OA-002")).getByTestId("goal-decision-OA-006"))).toBe("决定续借在自助机上办");
    expect(text(within(screen.getByTestId("chapter-goals-loose")).getByTestId("goal-decision-OA-010"))).toBe("决定馆藏按册登记为什么：一册一个条码。");
    fireEvent.click(within(screen.getByTestId("goal-decision-OA-004")).getByRole("button"));
    expect(text(screen.getByTestId("topic-title"))).toBe("闭馆日怎么算");
  });

  it("没有目标时写一句话，没有散着的决定时不画那一块", () => {
    render(<Panel t={overallTask()} />);
    fireEvent.click(screen.getByTestId("toc-chapter-6"));
    expect(screen.getByTestId("chapter-goals")).toHaveTextContent("还没有标签含「目标」的节。");
    expect(screen.queryByTestId("chapter-goals-loose")).toBeNull();
  });
});

describe("第 7 章 决策记录与待澄清事项的章首页", () => {
  it("按时间的一张表：时间、类别、事项、说明；点决定打开它那一节，点问题打开它牵涉的那一节", () => {
    const decisions = [
      { entry: "decision", item_id: "OA-004", title: "闭馆日不计入保留期", at: "2026-10-09T10:00:00+08:00", note: "读者周末来不了。", question_kind: null },
      { entry: "question", item_id: "TBD-001", title: "保留的 3 天里遇到闭馆日，算不算在内？", at: "2026-10-09T11:00:00+08:00", note: "", question_kind: "范围外" },
      { entry: "question", item_id: "TBD-003", title: "逾期从哪一天算起？", at: null, note: "从应还日期的第二天算。", question_kind: null },
    ];
    render(<Panel t={overallTask({ overall_views: { rules: { rows: [], conflicts: [], unmatched: [] }, goals: { roots: [], loose: [] }, decisions } as never })} />);
    fireEvent.click(screen.getByTestId("toc-chapter-7"));
    expect(screen.getByTestId("chapter-lead")).toHaveTextContent("3 项，自各节的决定与待澄清事项汇总");
    const table = screen.getByTestId("decisions-table");
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["时间", "类别", "事项", "说明"]);
    const cells = [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].slice(1).map((td) => text(td)).join("|"));
    expect(cells).toEqual([
      "决定|闭馆日不计入保留期|读者周末来不了。",
      "范围外|保留的 3 天里遇到闭馆日，算不算在内？|—",
      "待澄清|逾期从哪一天算起？|从应还日期的第二天算。",
    ]);
    expect(text(screen.getByTestId("decision-TBD-003").querySelector("td"))).toBe("—");
    fireEvent.click(screen.getByTestId("decision-TBD-001"));
    expect(text(screen.getByTestId("topic-title"))).toBe("预约取书");
    fireEvent.click(screen.getByTestId("toc-chapter-7"));
    fireEvent.click(screen.getByTestId("decision-OA-004"));
    expect(text(screen.getByTestId("topic-title"))).toBe("闭馆日怎么算");
  });

  it("一项都没有时写一句话", () => {
    render(<Panel t={overallTask()} />);
    fireEvent.click(screen.getByTestId("toc-chapter-7"));
    expect(screen.getByTestId("chapter-decisions")).toHaveTextContent("还没有决定，也没有待澄清事项。");
  });
});
