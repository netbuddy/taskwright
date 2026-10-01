// 条目详情里的来源：字段下面不再挂来源小标签，来源只在底部「来源」一节列出。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import type { Item, Material, Task } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { MaterialsContext } from "../state/materials";
import { MaterialPane } from "../components/work/MaterialPane";
import { api } from "../api/client";

afterEach(cleanup);
Element.prototype.scrollTo ??= function () {};

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);

const src = (kind: string, locator: string, excerpt: string, field?: string) => ({ kind, locator, excerpt, supports: field ? [{ field, index: null }] : [] });

export function sourcesTask(sources: unknown[]): Task {
  const item = {
    item_id: "UC-001", collection: "功能用例", title: "借阅图书", revision_no: 1, revisions: [1], revision_by: "executor", revision_at: "",
    reviews: [], confirmations: [], confirmation_stale: false, sources, fields: { 用例名称: "借阅图书", 参与者: ["读者"] },
  } as unknown as Item;
  return {
    task_id: "TASK-S", task_name: "来源", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [{ name: "功能用例", prefix: "UC", needs_review: false, fields: [
      { name: "用例名称", type: "文本", required: true, values: null },
      { name: "参与者", type: "文本列表", required: true, values: null }] }] },
    completion: null, items: [item],
  } as unknown as Task;
}

export function OpenItem({ t, wrap = (node) => node }: { t: Task; wrap?: (node: ReactNode) => ReactNode }) {
  const [selected, setSelected] = useState<string | null>("UC-001");
  return (
    <Wrap><div className="app">
      {wrap(<ItemsPanel task={t} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={selected} onSelect={setSelected}
        submit={vi.fn(async () => null)} onGenerateDoc={() => {}} />)}
    </div></Wrap>
  );
}

export const materials = (...paths: string[]): Material[] => paths.map((path) => ({ path, bytes: 1, modified_at: "", derived_from: null }));

describe("条目详情里的来源", () => {
  it("字段下面没有来源标签，底部有「来源」一节，材料原文、用户的话、助手补充都只在那里列出", () => {
    render(<OpenItem t={sourcesTask([
      src("文档原文", "inputs/借阅说明.md", "读者可以借书。", "参与者"),
      src("用户的话", "S#u1", "读者就是持证的人", "参与者"),
      src("执行者补充", "", "补了一个参与者"),
    ])} />);
    const detail = screen.getByTestId("item-detail");
    for (const field of detail.querySelectorAll(".fld")) {
      expect(field.querySelector(".srcs, .srctag")).toBeNull();
      expect(field.textContent).not.toMatch(/借阅说明\.md|用户的话|助手补充/);
    }
    expect(within(detail).getByText("来源", { selector: ".sec-h" })).toBeTruthy();
    expect([...detail.querySelectorAll(".srcbox .chip")].map((c) => c.textContent)).toEqual(["材料原文", "用户的话", "助手补充"]);
    expect(within(detail).getByText("出处：借阅说明.md（点一下看原文）")).toBeTruthy();
  });

  it("底部来源里材料原文的出处点一下，照旧交给材料区定位", () => {
    const onLocate = vi.fn();
    function Panel() {
      const [selected, setSelected] = useState<string | null>("UC-001");
      return (
        <Wrap><div className="app">
          <ItemsPanel task={sourcesTask([src("文档原文", "inputs/借阅说明.md", "读者可以借书。", "参与者")])} readOnly={false} recentlyChanged={[]}
            pendingItems={new Set()} selected={selected} onSelect={setSelected} submit={vi.fn(async () => null)} onGenerateDoc={() => {}} onLocate={onLocate} />
        </div></Wrap>
      );
    }
    render(<Panel />);
    fireEvent.click(screen.getByText("出处：借阅说明.md（点一下看原文）"));
    expect(onLocate).toHaveBeenCalledWith("读者可以借书。", "inputs/借阅说明.md");
  });

  it("出处文件不在材料清单里：出处不可点，旁边灰字写「这份材料已经删除」，摘录照旧；清单里还在的照常可点", () => {
    const onLocate = vi.fn();
    const t = sourcesTask([
      src("文档原文", "inputs/借阅说明.md", "读者可以借书。", "参与者"),
      src("文档原文", "inputs/旧规定.docx#p3", "逾期罚款一角。"),
    ]);
    function Panel() {
      const [selected, setSelected] = useState<string | null>("UC-001");
      return (
        <Wrap><div className="app">
          <MaterialsContext.Provider value={materials("inputs/借阅说明.md")}>
            <ItemsPanel task={t} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={selected} onSelect={setSelected}
              submit={vi.fn(async () => null)} onGenerateDoc={() => {}} onLocate={onLocate} />
          </MaterialsContext.Provider>
        </div></Wrap>
      );
    }
    render(<Panel />);
    const boxes = [...screen.getByTestId("item-detail").querySelectorAll(".srcbox")] as HTMLElement[];
    expect(within(boxes[0]).queryByTestId("material-gone")).toBeNull();
    expect(within(boxes[1]).getByTestId("material-gone").textContent).toBe("这份材料已经删除");
    expect(within(boxes[1]).getByText("出处：旧规定.docx").getAttribute("role")).toBeNull();
    expect(within(boxes[1]).getByText("「逾期罚款一角。」")).toBeTruthy();
    fireEvent.click(within(boxes[1]).getByText("出处：旧规定.docx"));
    expect(onLocate).not.toHaveBeenCalled();
    fireEvent.click(within(boxes[0]).getByText("出处：借阅说明.md（点一下看原文）"));
    expect(onLocate).toHaveBeenCalledTimes(1);
  });

  it("出自知识库文档的来源种类仍是「文档原文」，按出处以 knowledge/ 开头认出，用另一种颜色的标签（样式类 kb）；没有「知识库」这个种类", () => {
    render(<OpenItem t={sourcesTask([src("文档原文", "knowledge/general/公司术语表.md", "读者：持有借书证的人。"), src("知识库", "通用库/公司术语表.md", "读者：持有借书证的人。")])} />);
    const [byLocator, byKind] = screen.getByTestId("item-detail").querySelectorAll(".srcbox .chip");
    expect(byLocator.textContent).toBe("知识库");
    expect(byLocator.className).toBe("chip src kb");
    expect(byKind.className).toBe("chip on");
  });

  it("「材料」页签：正在看的材料被删掉之后改看清单里的第一份，下拉框里不再列它", async () => {
    vi.spyOn(api, "materialContent").mockImplementation(async (_t, path) => ({ path, text: `${path} 的正文` }));
    const { rerender } = render(<MaterialPane taskId="TASK-S" materials={materials("inputs/甲.md", "inputs/乙.md")} focusPath="inputs/乙.md" locate={null} />);
    expect(await screen.findByText("inputs/乙.md 的正文")).toBeTruthy();
    rerender(<MaterialPane taskId="TASK-S" materials={materials("inputs/甲.md")} focusPath="inputs/乙.md" locate={null} />);
    expect(await screen.findByText("inputs/甲.md 的正文")).toBeTruthy();
    expect(screen.queryByText("inputs/乙.md 的正文")).toBeNull();
  });
});
