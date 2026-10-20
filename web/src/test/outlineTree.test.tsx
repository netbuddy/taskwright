// 业务说明按分析提纲画的目录：任务定义带着分析提纲的原文时，目录是提纲的树（维度、提纲条目、挂在下面的页），
// 状态由挂在页上、还没了结的问题条目推出；面包屑写「维度 › 提纲条目」。没有分析提纲时照旧按章画。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { App as AntApp, ConfigProvider } from "antd";
import type { Item, Task } from "../api/types";
import { currentEntryPage, outlinePlace, outlineTree, stateText } from "../model/outlineTree";
import { OutlineContents } from "../components/work/overall/OutlineContents";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
Element.prototype.scrollTo ??= function () {};

const OUTLINE = `---
outline: demo
unsorted: 未归类的发现
ideas: 解决方案创意
judgement: 目前的判断
overview: 总体观察
---

# 演示提纲

## 背景与目标

per_unit: false
examples: optional

- 起因与现状问题 —— 为什么现在要做。 —— 页 —— 方法：五问法
- 目标与衡量 —— 要达到什么。 —— 页

## 价值流与业务流程

per_unit: true
examples: required

- 触发与交付 —— 由什么触发。 —— 页
`;

const base = overallTask();
const pageLike = base.items.find((one) => one.item_id === "OA-001")!;
const issueLike = base.items.find((one) => one.item_id === "TBD-001")!;

function page(id: string, title: string, parent: string | null, what = `${title}的说明（材料 第 1 段）。`): Item {
  const one = structuredClone(pageLike);
  one.item_id = id; one.title = title;
  one.fields = { ...one.fields, 标题: title, 它是什么: what, 上级主题: parent ? [parent] : [] };
  return one;
}
function issue(id: string, kind: string, on: string, status = "未解决"): Item {
  const one = structuredClone(issueLike);
  one.item_id = id; one.title = id;
  one.fields = { ...one.fields, 事项: `${id} 的事`, 种类: kind, 状态: status, 关联条目: [on] };
  return one;
}

/** 只有提纲里的几页与几条问题的任务；outline 为 null 时是没有分析提纲的任务。 */
function task(issues: Item[] = [issue("TBD-001", "待澄清", "OA-002")], outline: string | null = OUTLINE): Task {
  const t = overallTask();
  t.definition = { ...t.definition, outline };
  t.items = [
    page("OA-001", "背景与目标", null), page("OA-002", "起因与现状问题", "OA-001"), page("OA-003", "费用分散", "OA-002"),
    page("OA-004", "目前的判断", null), page("OA-005", "孤零零的一页", null), ...issues,
  ];
  return t;
}

describe("提纲的树与状态", () => {
  it("维度照提纲的先后；提纲条目挂在维度下，条目下挂它下面的页；还没有页的维度与条目是未起；固定页按元数据找；对不上的页进「其他页」", () => {
    const tree = outlineTree(task())!;
    expect(tree.dimensions.map((one) => one.name)).toEqual(["背景与目标", "价值流与业务流程"]);
    const [first, second] = tree.dimensions;
    expect(first.page?.item_id).toBe("OA-001");
    expect(first.entries.map((one) => [one.name, stateText(one.state)])).toEqual([["起因与现状问题", "草稿 · 缺口 1"], ["目标与衡量", "未起"]]);
    expect(first.entries[0].children.map((one) => one.item.item_id)).toEqual(["OA-003"]);
    expect([first.done, first.total, stateText(first.state)]).toEqual([0, 2, "草稿 · 缺口 1"]);
    expect([second.page, stateText(second.state)]).toEqual([null, "未起"]);
    expect(tree.judgement?.page?.item_id).toBe("OA-004");
    expect(tree.ideas).toEqual({ name: "解决方案创意", page: null });
    expect(tree.loose.map((one) => one.item_id)).toEqual(["OA-005"]);
  });

  it("缺口只剩缺失是部分，算已做；缺口了结了是满；正文写明与本系统无关的是确认无关", () => {
    const partial = outlineTree(task([issue("TBD-001", "缺失", "OA-002")]))!.dimensions[0];
    expect([stateText(partial.entries[0].state), partial.done]).toEqual(["部分 · 缺失 1", 1]);
    expect(stateText(outlineTree(task([issue("TBD-001", "待澄清", "OA-002", "已解决")]))!.dimensions[0].entries[0].state)).toBe("满");
    const t = task([]);
    t.items[1].fields.它是什么 = "这一条与本系统无关：一期不涉及（评审会纪要 第 4 条）。";
    expect(stateText(outlineTree(t)!.dimensions[0].entries[0].state)).toBe("确认无关");
  });

  it("现在正在问的是最近记下、还开着的缺口所在的那一页；面包屑的位置是「维度 › 提纲条目」；没有分析提纲时没有树", () => {
    const t = task([issue("TBD-001", "待澄清", "OA-002"), issue("TBD-002", "缺失", "OA-002")]);
    const tree = outlineTree(t)!;
    expect(currentEntryPage(t, tree)).toBe("OA-002");
    expect(outlinePlace(tree, "OA-003")).toEqual({ dimension: "背景与目标", entry: "起因与现状问题" });
    expect(outlinePlace(tree, "OA-001")).toEqual({ dimension: "背景与目标", entry: null });
    expect(outlinePlace(tree, "OA-005")).toBeNull();
    expect(outlineTree(task(undefined, null))).toBeNull();
  });
});

const Wrap = ({ children }: { children: React.ReactNode }) => <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("目录与面包屑", () => {
  it("目录：维度行写已做与状态，没有页的维度与条目灰着点不动；正在问的那一条高亮；点条目打开它的页", () => {
    const t = task();
    const onOpen = vi.fn();
    render(<div className="app"><OutlineContents task={t} tree={outlineTree(t)!} current={null} onOpen={onOpen} /></div>);
    expect(text(screen.getByTestId("outline-dimension-1").firstElementChild)).toBe("1背景与目标已做 0/2草稿 · 缺口 1");
    expect(screen.getByTestId("outline-dimension-2").firstElementChild).toHaveClass("dim");
    expect(screen.getByTestId("outline-entry-起因与现状问题").getAttribute("data-asking")).toBe("true");
    expect(screen.getByTestId("outline-entry-目标与衡量")).toHaveClass("dim");
    fireEvent.click(screen.getByTestId("outline-entry-目标与衡量"));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("outline-entry-起因与现状问题"));
    expect(onOpen).toHaveBeenCalledWith("OA-002");
    expect(screen.getByTestId("outline-judgement")).not.toHaveClass("dim");
    expect(screen.getByTestId("outline-ideas")).toHaveClass("dim");
    expect(screen.getByTestId("outline-loose")).toHaveTextContent("孤零零的一页");
  });

  it("业务说明页签：有分析提纲时目录是提纲的树，面包屑写「维度 › 提纲条目」；没有时照旧按章", () => {
    function Panel({ t }: { t: Task }) {
      const [selected, setSelected] = useState<string | null>("OA-003");
      return <Wrap><div className="app"><ItemsPanel task={t} initialCollection="业务说明" readOnly={false} writesOff={false} recentlyChanged={[]} pendingItems={new Set()}
        selected={selected} onSelect={setSelected} submit={vi.fn(async () => null) as never} onGenerateDoc={() => {}} /></div></Wrap>;
    }
    render(<Panel t={task()} />);
    expect(screen.getByTestId("outline-toc")).toBeInTheDocument();
    expect(text(screen.getByTestId("topic-crumb"))).toContain("背景与目标›起因与现状问题");
    cleanup();
    render(<Panel t={task(undefined, null)} />);
    expect(screen.queryByTestId("outline-toc")).toBeNull();
  });
});
