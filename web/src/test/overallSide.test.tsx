// 右侧栏的「总体分析」页签：看条目时对照用的窄提纲，只列贴了标签、还在用的主题，按标签分组（照任务定义里取值的先后，
// 「概念」靠前）；一页贴了两个标签就在两组里各列一次；每行写计数与待核实；点一行打开那一页；没有列出的主题有几个写在底下。
// 分组的口径在 model/domainNotes.ts：分组字段是列表时一个条目有几个值就进几个组。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Task } from "../api/types";
import { EMPTY_GROUP, groupItems, groupsOf, displayOf } from "../model/domainNotes";
import { sideLine } from "../model/overall";
import { SidePanel } from "../components/work/SidePanel";
import { change, itemOf, overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
function side(t: Task, open = vi.fn()) {
  const props = {
    onSide: () => {}, onCollapse: () => {}, onExpand: () => {}, taskId: t.task_id, materials: [], focusPath: null, items: t.items, locate: null,
    currentItem: null, disabled: false, onOpenItem: open, onSend: () => {}, log: [], messages: [], selectedRevision: null, onSelectRevision: () => {},
    scrollNonce: 0, onDiff: () => {}, onUndo: () => {}, onGenerate: () => {}, writesOff: false, readOnly: false, task: t,
  };
  render(<Wrap><div className="app"><SidePanel side="coll:总体分析" {...props} /></div></Wrap>);
  return open;
}

describe("分组：分组字段是列表时", () => {
  it("一个条目有几个值就进几个组，空着的归「（未填）」；组的先后是靠前的组、再照字段声明的取值", () => {
    const t = overallTask();
    const display = displayOf(t, "总体分析");
    expect(groupsOf(itemOf(t, "OA-003"), display)).toEqual(["概念", "流程"]);
    expect(groupsOf(itemOf(t, "OA-008"), display)).toEqual([]);
    const groups = groupItems(t, "总体分析");
    expect(groups.map((g) => `${g.name}:${g.items.map((i) => i.item_id.slice(3)).join(",")}`)).toEqual([
      "概念:003,005,007,010", "角色:007,009", "流程:001,002,003,006", "假设:004", `${EMPTY_GROUP}:008,011`,
    ]);
  });

  it("分组字段不是列表的集合照旧：一个条目一个组", () => {
    const t = overallTask();
    t.definition.collections.find((c) => c.name === "问题")!.display = { side_tab: false, group_field: "种类", leading_groups: [] };
    expect(groupItems(t, "问题").map((g) => `${g.name}:${g.items.length}`)).toEqual(["待澄清:4"]);
  });
});

describe("右侧栏的总体分析页签", () => {
  it("只列贴了标签的主题，按标签分组；贴了两个标签的在两组里各列一次；没有列出的写在底下", () => {
    side(overallTask());
    const panel = screen.getByTestId("side-collection-总体分析");
    expect([...panel.querySelectorAll(".grp")].map((e) => e.textContent)).toEqual(["概念", "角色", "流程", "假设"]);
    expect(screen.getByTestId("side-entry-概念-OA-003")).toBeInTheDocument();
    expect(screen.getByTestId("side-entry-流程-OA-003")).toBeInTheDocument();
    expect(panel.querySelector('[data-testid$="-OA-008"]')).toBeNull();
    expect(screen.getByTestId("side-overall-rest")).toHaveTextContent("另有 2 个主题没有贴标签或者已废弃，到条目区的「业务说明」页签看。");
    expect(panel.querySelector(".dn-lead")).toHaveTextContent("这里只列贴了标签的主题，看条目时对照用。");
    // 页签顶上那一句用页面上的叫法起头。
    // 说明那一句自己说了「业务说明」，前面不再重复；早先的任务那一句没有说，前面补上。
    expect(panel.querySelector(".dn-lead b")!.textContent).toBe("按章整理的业务说明：每一节写它是什么、适用规则、待澄清事项，图与需求条目都归在它说明的那一节。");
    cleanup();
    const old = overallTask();
    old.definition.collections.find((c) => c.name === "总体分析")!.display!.note = "用这件事自己的话写下的主题：它是什么、例子、已经定下的。条目依据它写。";
    side(old);
    expect(screen.getByTestId("side-collection-总体分析").querySelector(".dn-lead b")!.textContent).toMatch(/^业务说明：用这件事自己的话写下的主题/);
  });

  it("各章的导语页不列出，也不算进「另有 N 个」：贴没贴标签都一样", () => {
    const task = overallTask();
    const base = task.items.find((one) => one.item_id === "OA-011")!;
    const intro = (id: string, chapter: string, labels: string[] = []) => ({ ...structuredClone(base), item_id: id, title: `${chapter}导语`,
      fields: { 标题: `${chapter}导语`, 它是什么: `${chapter}这一章讲什么。`, 状态: "在用", 导语所属章: chapter, ...(labels.length ? { 标签: labels } : {}) } });
    task.items.push(intro("OA-020", "业务流程") as never, intro("OA-021", "角色", ["角色"]) as never);
    side(task);
    const panel = screen.getByTestId("side-collection-总体分析");
    expect(panel.querySelector('[data-testid$="-OA-020"]')).toBeNull();
    expect(panel.querySelector('[data-testid$="-OA-021"]')).toBeNull();
    expect(screen.getByTestId("side-overall-rest")).toHaveTextContent("另有 2 个主题没有贴标签或者已废弃");
  });

  it("每行是编号与标题、「它是什么」的首段、计数；待核实的写出来并且变色", () => {
    side(overallTask());
    const row = screen.getByTestId("side-entry-概念-OA-003");
    expect(row.querySelector(".t")).toHaveTextContent("OA-003 预约取书");
    expect(row.querySelector(".c")!.textContent!.endsWith("让给下一位。")).toBe(true);
    expect(row.querySelector(".m")).toHaveTextContent("3 定 · 1 问 · 待核实");
    expect(row).toHaveClass("unl");
    expect(screen.getByTestId("side-entry-流程-OA-002").querySelector(".m")).toHaveTextContent("5 定");
    expect(screen.getByTestId("side-entry-流程-OA-002")).not.toHaveClass("unl");
    const t = overallTask();
    expect(sideLine(t, itemOf(t, "OA-001"))).toBe("说清了");
    expect(sideLine(t, change(t, "OA-005", (p) => { p.fields.别名 = []; }) && itemOf(t, "OA-005"))).toBe("1 问 · 待核实");
  });

  it("点一行打开那一页；已废弃的主题不列", () => {
    const t = change(overallTask(), "OA-010", (p) => { p.fields.状态 = "已废弃"; });
    const open = side(t);
    expect(document.querySelector('[data-testid$="-OA-010"]')).toBeNull();
    expect(screen.getByTestId("side-overall-rest")).toHaveTextContent("另有 3 个主题");
    fireEvent.click(screen.getByTestId("side-entry-角色-OA-009"));
    expect(open).toHaveBeenCalledWith("OA-009");
  });

  it("一页贴了标签的主题都没有时写一句话", () => {
    const t = overallTask();
    for (const item of t.items) if (item.collection === "总体分析") item.fields.标签 = [];
    side(t);
    expect(screen.getByTestId("side-collection-总体分析")).toHaveTextContent("还没有贴了标签的主题。");
  });
});
