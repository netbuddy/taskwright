// 条目区那一排页签：有总体分析集合时它排最前；一打开停在哪一个（选中的条目、地址、记住的、缺省）；
// 用户换了页签就记下来，下次打开这个任务回到那里；早先的任务（集合叫领域说明）次序不变。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import type { Task } from "../api/types";
import { DIAGRAMS_TAB, initialTab, readTab, saveTab, tabOrder } from "../model/itemsTab";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { overallTask } from "./fixtures/overallTask";

afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); });
Element.prototype.scrollTo ??= function () {};

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
function Panel({ t, collection = null, diagrams = false, first = null }: { t: Task; collection?: string | null; diagrams?: boolean; first?: string | null }) {
  const [selected, setSelected] = useState<string | null>(first);
  return (
    <Wrap><div className="app">
      <ItemsPanel task={t} initialCollection={collection} initialDiagrams={diagrams} readOnly={false} recentlyChanged={[]} pendingItems={new Set()}
        selected={selected} onSelect={setSelected} submit={vi.fn(async () => null)} onGenerateDoc={() => {}} />
    </div></Wrap>
  );
}
const tabs = () => [...document.querySelectorAll(".itab")].map((t) => t.textContent!.replace(/\d+$/, ""));
const onTab = () => document.querySelector(".itab.on")!.textContent!.replace(/\d+$/, "");
/** 早先的任务：集合叫领域说明，排在任务定义里原来的位置。 */
function oldTask(): Task {
  const t = overallTask();
  t.definition.collections = t.definition.collections.map((c) => (c.name === "总体分析" ? { ...c, name: "领域说明", prefix: "DN" } : c));
  t.items = t.items.filter((i) => i.collection !== "总体分析");
  return t;
}
/** 只有总体分析里有内容的任务（刚开始、还没有写条目）。 */
function fresh(): Task {
  const t = overallTask();
  t.items = t.items.filter((i) => i.collection === "总体分析");
  return t;
}

describe("页签的次序", () => {
  it("有总体分析集合时它排最前，其余照任务定义的先后，图表在最后", () => {
    expect(tabOrder(overallTask().definition.collections).map((c) => c.name)).toEqual(["总体分析", "功能用例", "问题"]);
    render(<Panel t={overallTask()} />);
    // 总体分析这个集合的页签显示成「业务说明」。
    expect(tabs()).toEqual(["业务说明", "功能用例", "问题", "图表"]);
    expect(screen.getByText("业务说明", { selector: ".itab" }).querySelector(".cnt")!.textContent).toBe("11");
  });

  it("早先的任务次序不变", () => {
    expect(tabOrder(oldTask().definition.collections).map((c) => c.name)).toEqual(["功能用例", "问题", "领域说明"]);
    render(<Panel t={oldTask()} />);
    expect(tabs()).toEqual(["功能用例", "问题", "领域说明", "图表"]);
  });
});

describe("一打开停在哪个页签", () => {
  it("别的集合一条条目都没有时停在总体分析；有了条目、又没有记过时，停在总体分析之外的第一个集合", () => {
    expect(initialTab(fresh(), {})).toEqual({ tab: "总体分析", diagrams: false });
    expect(initialTab(overallTask(), {})).toEqual({ tab: "功能用例", diagrams: false });
    render(<Panel t={fresh()} />);
    expect(onTab()).toBe("业务说明");
  });

  it("选中的条目所在的集合最优先，其次是地址里带的集合或图表页签，再其次是记住的", () => {
    const t = overallTask();
    saveTab(t.task_id, "问题");
    expect(initialTab(t, {})).toEqual({ tab: "问题", diagrams: false });
    expect(initialTab(t, { collection: "总体分析" })).toEqual({ tab: "总体分析", diagrams: false });
    expect(initialTab(t, { diagrams: true })).toEqual({ tab: "功能用例", diagrams: true });
    expect(initialTab(t, { collection: "问题", selected: "OA-003" })).toEqual({ tab: "总体分析", diagrams: false });
  });

  it("记住的是图表页签时回到图表；记住的集合任务里已经没有、或者地址里带的集合任务里没有时，按没有记过处理", () => {
    const t = overallTask();
    saveTab(t.task_id, DIAGRAMS_TAB);
    expect(initialTab(t, {})).toEqual({ tab: "功能用例", diagrams: true });
    saveTab(t.task_id, "非功能需求");
    expect(initialTab(t, {})).toEqual({ tab: "功能用例", diagrams: false });
    expect(initialTab(t, { collection: "没有这个集合" })).toEqual({ tab: "功能用例", diagrams: false });
  });

  it("各个任务各记各的；浏览器不让读写时当作没有记过，不出错", () => {
    saveTab("TASK-A", "问题");
    expect(readTab("TASK-A")).toBe("问题");
    expect(readTab("TASK-B")).toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readTab("TASK-A")).toBeNull();
    expect(() => saveTab("TASK-A", "问题")).not.toThrow();
    expect(initialTab(overallTask(), {})).toEqual({ tab: "功能用例", diagrams: false });
  });

  it("早先的任务：缺省仍是第一个集合，记住的是它自己的集合名", () => {
    const t = oldTask();
    expect(initialTab(t, {})).toEqual({ tab: "功能用例", diagrams: false });
    saveTab(t.task_id, "领域说明");
    expect(initialTab(t, {})).toEqual({ tab: "领域说明", diagrams: false });
  });
});

describe("记住用户上次停的页签", () => {
  it("点别的页签就记下来，下次打开这个任务回到那里", () => {
    const t = overallTask();
    const first = render(<Panel t={t} />);
    expect(onTab()).toBe("功能用例");
    fireEvent.click(screen.getByText("问题", { selector: ".itab" }));
    expect(readTab(t.task_id)).toBe("问题");
    first.unmount();
    render(<Panel t={overallTask()} />);
    expect(onTab()).toBe("问题");
  });

  it("停在图表页签也记；从别处打开一个条目，页签跟着走，也记下来", () => {
    const t = overallTask();
    const first = render(<Panel t={t} />);
    fireEvent.click(screen.getByTestId("diagrams-tab"));
    expect(readTab(t.task_id)).toBe(DIAGRAMS_TAB);
    first.unmount();
    render(<Panel t={overallTask()} first="TBD-001" />);
    expect(onTab()).toBe("问题");
    expect(readTab(t.task_id)).toBe("问题");
  });
});
