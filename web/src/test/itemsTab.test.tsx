// 条目区的页签：顶上一排六个，需求条目页签里一排集合的子页签；一打开停在哪一个（选中的条目、地址、记住的、缺省）；
// 用户换了页签就记下来，下次打开这个任务回到那里。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import type { Task } from "../api/types";
import { initialTab, readTab, saveTab, tabOrder } from "../model/itemsTab";
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
/** 需求条目页签里一排子页签（集合）的名字。 */
const tabs = () => [...document.querySelectorAll("[data-testid=item-tabs] .itab")].map((t) => t.textContent!.replace(/\d+$/, ""));
/** 停在哪里：停在需求条目页签时是哪个子页签，否则是顶上一排里的哪一个。 */
const onTab = () => (document.querySelector("[data-testid=item-tabs] .itab.on") ?? document.querySelector("[data-testid=asset-tabs] .itab.on"))!.textContent!.replace(/\d+$/, "");
/** 只有总体分析里有内容的任务（刚开始、还没有写条目）。 */
function fresh(): Task {
  const t = overallTask();
  t.items = t.items.filter((i) => i.collection === "总体分析");
  return t;
}

describe("页签的次序", () => {
  it("业务说明那一个集合排最前，其余照任务定义的先后", () => {
    expect(tabOrder(overallTask().definition.collections).map((c) => c.name)).toEqual(["总体分析", "功能用例", "问题"]);
    render(<Panel t={overallTask()} />);
    // 顶上一排是需求资产六类；业务说明那一个集合在「业务说明」页签里，其余集合是「需求条目」页签里的子页签。
    expect([...document.querySelectorAll("[data-testid=asset-tabs] .itab")].map((t) => t.firstChild!.textContent)).toEqual(["材料与证据", "业务说明", "分析模型", "需求条目", "评审与确认", "文档与版本"]);
    expect(tabs()).toEqual(["功能用例", "问题"]);
    expect(screen.getByTestId("pane-description").querySelector(".cnt")!.textContent).toBe("11");
  });
});

describe("一打开停在哪个页签", () => {
  it("别的集合一条条目都没有时停在总体分析；有了条目、又没有记过时，停在总体分析之外的第一个集合", () => {
    expect(initialTab(fresh(), {})).toEqual({ tab: "总体分析" });
    expect(initialTab(overallTask(), {})).toEqual({ tab: "功能用例" });
    render(<Panel t={fresh()} />);
    expect(onTab()).toBe("业务说明");
  });

  it("选中的条目所在的集合最优先，其次是地址里要看的一张图（业务说明）、地址里带的集合，再其次是记住的", () => {
    const t = overallTask();
    saveTab(t.task_id, "问题");
    expect(initialTab(t, {})).toEqual({ tab: "问题" });
    expect(initialTab(t, { collection: "总体分析" })).toEqual({ tab: "总体分析" });
    expect(initialTab(t, { diagram: true, collection: "问题" })).toEqual({ tab: "总体分析" });
    expect(initialTab(t, { collection: "问题", selected: "OA-003" })).toEqual({ tab: "总体分析" });
  });

  it("记住的集合任务里已经没有、或者地址里带的集合任务里没有时，按没有记过处理；记住的是不是集合的页签时，集合也按没有记过处理", () => {
    const t = overallTask();
    saveTab(t.task_id, "非功能需求");
    expect(initialTab(t, {})).toEqual({ tab: "功能用例" });
    expect(initialTab(t, { collection: "没有这个集合" })).toEqual({ tab: "功能用例" });
    saveTab(t.task_id, "@models");
    expect(initialTab(t, {})).toEqual({ tab: "功能用例" });
  });

  it("各个任务各记各的；浏览器不让读写时当作没有记过，不出错", () => {
    saveTab("TASK-A", "问题");
    expect(readTab("TASK-A")).toBe("问题");
    expect(readTab("TASK-B")).toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readTab("TASK-A")).toBeNull();
    expect(() => saveTab("TASK-A", "问题")).not.toThrow();
    expect(initialTab(overallTask(), {})).toEqual({ tab: "功能用例" });
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

  it("停在「分析模型」页签也记；从别处打开一个条目，页签跟着走，也记下来", () => {
    const t = overallTask();
    const first = render(<Panel t={t} />);
    fireEvent.click(screen.getByTestId("pane-models"));
    expect(readTab(t.task_id)).toBe("@models");
    first.unmount();
    render(<Panel t={overallTask()} first="TBD-001" />);
    expect(onTab()).toBe("问题");
    expect(readTab(t.task_id)).toBe("问题");
  });
});
