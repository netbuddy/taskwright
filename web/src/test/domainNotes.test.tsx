// 领域说明一类的集合（任务定义「界面」一项）：分组与排序、谁引用了它、与条目的联系；不评审的集合不显示评审状态；
// 条目行的分组小标签与来源数；「领域说明」来源标签点一下打开那条说明；详情的「被哪些条目引用」；右侧栏页签；完成条件面板的提示行。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import type { Completion, Item, Task } from "../api/types";
import { citationsOf, groupItems, linkPhrase, unlinkedIds } from "../model/domainNotes";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { ItemStatus } from "../components/work/ItemStatus";
import { SidePanel } from "../components/work/SidePanel";
import { CompletionPanel } from "../components/CompletionPanel";

afterEach(cleanup);
// 条目区打开条目时会把 .app 里的列表滚回顶部；jsdom 的元素没有 scrollTo。
Element.prototype.scrollTo ??= function () {};

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);

const base = { revision_by: "executor", revision_at: "", revisions: [1], sources: [], reviews: [], confirmations: [], confirmation_stale: false };
const src = (kind: string, locator: string, excerpt: string, field?: string, index?: number) =>
  ({ kind, locator, excerpt, supports: field ? [{ field, index: index ?? null }] : [] });

function uc(id: string, title: string, sources: unknown[] = []): Item {
  return { ...base, item_id: id, collection: "功能用例", title, revision_no: 1, sources, fields: { 用例名称: title, 参与者: ["读者"] } } as Item;
}
function dn(id: string, title: string, cat: string, refs: string[] = [], revision = 1): Item {
  return { ...base, item_id: id, collection: "领域说明", title, revision_no: revision, revisions: [revision],
    sources: [src("用户的话", "s#u1", `${title}是这个意思`)], fields: { 标题: title, 内容: `${title}的解释`, 类别: cat, 关联条目: refs } } as Item;
}

const HINT = { kind: "unlinked_domain_notes" as const, collection: "领域说明", items: ["DN-004"], summary: "有 1 条领域说明还没有和任何条目关联：DN-004。" };

function task(over: Partial<Task> = {}): Task {
  return {
    task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [
      { name: "功能用例", prefix: "UC", needs_review: true, fields: [
        { name: "用例名称", type: "文本", required: true, values: null },
        { name: "参与者", type: "文本列表", required: true, values: null }] },
      { name: "领域说明", prefix: "DN", needs_review: false,
        display: { side_tab: true, group_field: "类别", leading_groups: ["术语"], note: "材料里或你说明过的背景、术语、角色，供条目引用。" },
        fields: [
          { name: "标题", type: "文本", required: true, values: null },
          { name: "内容", type: "文本", required: true, values: null },
          { name: "类别", type: "文本", required: true, values: null },
          { name: "关联条目", type: "条目引用", required: false, values: null }] }] },
    completion: { all_met: false, unmet_count: 1, conditions: [
      { collection: "领域说明", name: "每个条目用户确认", met: false, state: "unmet", done: 0, total: 4, missing: ["DN-001"], note: "有 4 个条目用户还没看过。" }],
      hints: [HINT] } as Completion,
    items: [
      uc("UC-001", "借阅图书", [src("领域说明", "DN-002", "借还台管理员的解释", "参与者", 1)]),
      uc("UC-002", "续借图书"),
      dn("DN-001", "纸质登记", "背景", ["UC-002"]),
      dn("DN-002", "借还台管理员", "角色"),
      dn("DN-003", "续借", "术语", [], 5),
      dn("DN-004", "开学第一周", "背景"),
    ],
    ...over,
  } as Task;
}

describe("领域说明的派生", () => {
  it("按分组字段分组：靠前的组在前，其余按每组第一个条目的先后", () => {
    expect(groupItems(task(), "领域说明").map((g) => [g.name, g.items.map((i) => i.item_id)])).toEqual([
      ["术语", ["DN-003"]], ["背景", ["DN-001", "DN-004"]], ["角色", ["DN-002"]],
    ]);
  });

  it("谁引用了它：来源里写了它的（附支持的字段与摘录），关联条目里写了它的；联系的说法；未关联的编号取自完成条件的提示", () => {
    const t = task();
    expect(citationsOf(t, "DN-002").map((c) => [c.item.item_id, c.how, c.where, c.excerpt])).toEqual([["UC-001", "source", "参与者第 2 条", "借还台管理员的解释"]]);
    expect(linkPhrase(t, t.items.find((i) => i.item_id === "DN-002")!)).toEqual({ text: "被 UC-001 的参与者引用", unlinked: false });
    expect(linkPhrase(t, t.items.find((i) => i.item_id === "DN-001")!)).toEqual({ text: "关联了 UC-002", unlinked: false });
    expect(linkPhrase(t, t.items.find((i) => i.item_id === "DN-004")!)).toEqual({ text: "还没有和任何条目关联", unlinked: true });
    expect(unlinkedIds(t, "领域说明")).toEqual(["DN-004"]);
  });
});

describe("不评审的集合不显示评审状态", () => {
  it("领域说明的行：没有「待评审」，有分组小标签、修订与来源数、已读标记；用例照旧有评审状态", () => {
    const t = task();
    render(<Wrap><div className="app"><ItemStatus task={t} item={t.items[4]} row /><ItemStatus task={t} item={t.items[0]} row /></div></Wrap>);
    expect(screen.queryByTestId("review-DN-003")).toBeNull();
    expect(screen.getByTestId("group-DN-003").textContent).toBe("术语");
    expect(screen.getByText("修订 5")).toBeTruthy();
    expect(screen.getByTestId("source-count-DN-003").textContent).toBe("来源 1");
    expect(screen.getByTestId("read-DN-003")).toBeTruthy();
    expect(screen.getByTestId("review-UC-001").textContent).toContain("待评审");
  });
});

function Panel({ t }: { t: Task }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Wrap><div className="app">
      <ItemsPanel task={t} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={selected} onSelect={setSelected}
        submit={vi.fn(async () => null)} onGenerateDoc={() => {}} />
    </div></Wrap>
  );
}

describe("条目区与详情", () => {
  it("领域说明页签下先写一句白话与未关联条数", () => {
    render(<Panel t={task()} />);
    fireEvent.click(screen.getByText("领域说明", { selector: ".itab" }));
    expect(screen.getByTestId("collection-lead").textContent).toBe("领域说明：材料里或你说明过的背景、术语、角色，供条目引用。 有 1 条还没有和任何条目关联（DN-004）。");
  });

  it("「领域说明 DN-002」来源标签点一下打开那条说明；说明的详情列出被哪些条目引用", () => {
    render(<Panel t={task()} />);
    fireEvent.click(screen.getByTestId("item-UC-001"));
    const tag = screen.getByTestId("note-source-DN-002");
    expect(tag.textContent).toBe("领域说明 DN-002");
    fireEvent.click(tag);
    const detail = screen.getByTestId("item-detail");
    expect(within(detail).getByRole("heading").textContent).toBe("借还台管理员");
    expect(within(detail).getByTestId("cited-by-UC-001").textContent).toContain("UC-001 借阅图书 · 参与者第 2 条 · 修订 1把它写成了来源");
    expect(within(detail).queryByTestId("review-one")).toBeNull();
  });

  it("没有别的条目引用它时写一句说明，自己关联了条目的注明不算未关联", () => {
    render(<Panel t={task()} />);
    fireEvent.click(screen.getByText("领域说明", { selector: ".itab" }));
    fireEvent.click(screen.getByTestId("item-DN-001"));
    expect(screen.getByTestId("cited-by-none").textContent).toContain("它自己关联了 UC-002，所以不算「没有和任何条目关联」");
  });
});

describe("右侧栏的领域说明页签", () => {
  it("在材料之后；按类别分组，术语在前；未关联的那条写明；点一条打开它", () => {
    const t = task();
    const open = vi.fn();
    const props = {
      onSide: () => {}, onCollapse: () => {}, onExpand: () => {}, taskId: "TASK-001", materials: [], focusPath: null, items: t.items, locate: null,
      currentItem: null, disabled: false, onOpenItem: open, onSend: () => {}, log: [], messages: [], selectedRevision: null, onSelectRevision: () => {},
      scrollNonce: 0, onDiff: () => {}, onUndo: () => {}, onGenerate: () => {}, writesOff: false, readOnly: false, task: t,
    };
    render(<Wrap><div className="app"><SidePanel side="coll:领域说明" {...props} /></div></Wrap>);
    const tabs = [...document.querySelectorAll(".sw-stab")].map((e) => e.textContent);
    expect(tabs).toEqual(["材料", "领域说明4", "文档", "修订"]);
    const side = screen.getByTestId("side-collection-领域说明");
    expect([...side.querySelectorAll(".grp")].map((e) => e.textContent)).toEqual(["术语", "背景", "角色"]);
    expect(screen.getByTestId("side-entry-DN-004").className).toContain("unl");
    expect(screen.getByTestId("side-entry-DN-004").textContent).toContain("还没有和任何条目关联");
    fireEvent.click(screen.getByTestId("side-entry-DN-002"));
    expect(open).toHaveBeenCalledWith("DN-002");
  });
});

describe("完成条件面板的提示行", () => {
  it("写在所属集合那一组末尾，写明不挡完成任务", () => {
    render(<CompletionPanel completion={task().completion} status="进行中" />);
    expect(screen.getByTestId("cond-hint").textContent).toBe("ⓘ提示：有 1 条领域说明还没有和任何条目关联：DN-004。这一条不挡完成任务，只是告诉你哪些还没用上。");
  });
});
