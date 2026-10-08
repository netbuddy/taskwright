// 条目详情里的来源：字段下面不再挂来源小标签，来源只在底部「来源」一节列出。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import type { Item, Material, Task } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
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
      src("助手补充", "", "补了一个参与者"),
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

  it("助手补充的摘录是理由，前面写「理由：」；依据另一个条目的来源标签写「条目」，编号点一下打开那个条目", () => {
    const t = sourcesTask([src("助手补充", "助手补充", "登录总要输入口令"), { ...src("条目", "UC-002", "读者凭证借书", "参与者"), depends_revision: 3, current_revision: 3, stale: null }]);
    t.items.push({ ...t.items[0], item_id: "UC-002", title: "办理借书证", sources: [], depended_by: [{ element_kind: "条目", id: "UC-001", revision_no: 1 }] } as unknown as Item);
    render(<OpenItem t={t} />);
    const detail = screen.getByTestId("item-detail");
    const boxes = [...detail.querySelectorAll(".srcbox")];
    expect(boxes.map((b) => b.querySelector(".chip")!.textContent)).toEqual(["助手补充", "条目"]);
    expect(boxes[0].querySelector(".quote")!.textContent).toBe("理由：登录总要输入口令");
    expect(boxes[1].querySelector(".quote")!.textContent).toBe("「读者凭证借书」");
    expect(boxes[1].querySelector(".sh")!.textContent).toContain("UC-002 办理借书证");
    expect(detail.querySelector(".basis-stale, .srcbox.stale")).toBeNull();
    // 这个条目没有被别的条目依据：没有「被谁依据」一行。
    expect(within(detail).queryByTestId("depended-by")).toBeNull();
    fireEvent.click(within(detail).getByTestId("note-source-UC-002"));
    // 打开的 UC-002 被 UC-001 依据：有「被谁依据」一行，编号点一下回到 UC-001。
    const other = screen.getByTestId("item-detail");
    expect(within(other).getByTestId("depended-by").textContent).toBe("被谁依据：UC-001 借阅图书");
    fireEvent.click(within(other).getByTestId("depended-by-UC-001"));
    expect(within(screen.getByTestId("item-detail")).getByTestId("note-source-UC-002")).toBeTruthy();
  });

  it("依据已变：被依据的条目在引用之后改过，来源旁写明引用时与现在各是修订几；它已经删除时写「已经删除」，编号不可点", () => {
    const t = sourcesTask([
      { ...src("条目", "UC-002", "读者凭证借书"), depends_revision: 2, current_revision: 5, stale: "changed" },
      { ...src("条目", "UC-009", "早先的一句"), depends_revision: 1, current_revision: null, stale: "deleted" },
    ]);
    t.items.push({ ...t.items[0], item_id: "UC-002", title: "办理借书证", sources: [] } as unknown as Item);
    render(<OpenItem t={t} />);
    const detail = screen.getByTestId("item-detail");
    expect(within(detail).getByTestId("basis-stale-UC-002").textContent).toBe("依据已变：UC-002 在这之后改过（引用时是修订 2，现在是修订 5）");
    expect(within(detail).getByTestId("basis-deleted-UC-009").textContent).toBe("UC-009 已经删除");
    expect(within(detail).queryByTestId("note-source-UC-009")).toBeNull();
    expect(within(detail).queryByTestId("basis-stale-UC-009")).toBeNull();
    expect([...detail.querySelectorAll(".srcbox")].map((b) => b.classList.contains("stale"))).toEqual([true, true]);
  });

  it("被谁依据里的图：写编号、图名与「图」字，点了切到图表页签并打开那张图；条目照旧能点", async () => {
    const t = sourcesTask([src("文档原文", "inputs/借阅说明.md", "读者可以借书。")]);
    (t.items[0] as Item).depended_by = [{ element_kind: "条目", id: "UC-002", revision_no: 1 }, { element_kind: "图", id: "D-001", revision_no: 2 }];
    t.items.push({ ...t.items[0], item_id: "UC-002", title: "办理借书证", sources: [], depended_by: [] } as unknown as Item);
    const row = { diagram_id: "D-001", name: "读者用例", kind: "use_case", kind_name: "用例图", revision_no: 2, revision_by: "executor", revision_at: "", created_at: "", source_count: 2 };
    t.diagrams = [row];
    const got = vi.spyOn(api, "diagram").mockResolvedValue({ ...row, deleted: false, mermaid: "", note: "", revisions: [1, 2], sources: [], depended_by: [], drawn: [] });
    render(<OpenItem t={t} />);
    const detail = screen.getByTestId("item-detail");
    expect(within(detail).getByTestId("depended-by").textContent).toBe("被谁依据：UC-002 办理借书证、D-001 读者用例（图）");
    expect(within(detail).getByTestId("depended-by-UC-002").getAttribute("role")).toBe("button");
    const figure = within(detail).getByTestId("depended-by-D-001");
    expect([figure.getAttribute("role"), figure.classList.contains("ref")]).toEqual(["button", true]);
    fireEvent.click(figure);
    expect(screen.queryByTestId("item-detail")).toBeNull();
    expect(screen.getByTestId("diagrams-tab").classList.contains("on")).toBe(true);
    expect(await screen.findByTestId("diagram-sub")).toBeTruthy();
    expect(got).toHaveBeenCalledWith("TASK-S", "D-001");
    got.mockRestore();
  });

  it("依据图的来源有自己的标签样式", () => {
    render(<OpenItem t={sourcesTask([{ ...src("图", "FIG-001", "借阅流程"), depends_revision: 1, current_revision: null, stale: null }])} />);
    const chip = screen.getByTestId("item-detail").querySelector(".srcbox .chip")!;
    expect([chip.textContent, chip.classList.contains("fig")]).toEqual(["图", true]);
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

  it("出自知识库文档的来源种类仍是「文档原文」，按出处以 knowledge/ 开头认出，用另一种颜色的标签（样式类 kb）；没有「知识库」这个种类", () => {
    render(<OpenItem t={sourcesTask([src("文档原文", "knowledge/general/公司术语表.md", "读者：持有借书证的人。"), src("知识库", "通用知识库/公司术语表.md", "读者：持有借书证的人。")])} />);
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
