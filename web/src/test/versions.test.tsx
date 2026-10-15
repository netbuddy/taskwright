// 发布过的版本在页面上（model/versions.ts）：最近一版、哪些条目与图在它之后改过；条目上的「第 N 版后有改动」、条目区顶部「有 M 处改动在第 N 版之后」
// 与它列出的条目、业务说明目录里节旁的记号；「文档与版本」页签的版本表（下载两种存档，没有存档的灰着说明原因）；页面状态收到发布事件时加一版。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type { DiagramRow, Item, Task, VersionView } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { DocsTab } from "../components/work/DocsTab";
import { initialWorkState, workReducer } from "../state/workState";
import {
  changedAfter, changesAfter, changesLine, diagramChangedAfter, figuresOf, latestVersion, figuresText, missingArchiveText, nextVersionNo, somethingToPublish, versionMeta,
} from "../model/versions";

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const noop = () => {};

const version = (no: number, revision: number, over: Partial<VersionView> = {}): VersionView => ({
  version_no: no, revision_no: revision, published_at: "2026-10-13T09:00:00", actor: "user", note: null, figure_count: null, figure_pictures: null, has_markdown: true, has_docx: true, ...over,
});
function item(id: string, revision: number): Item {
  return {
    item_id: id, collection: "功能用例", title: `${id} 的名字`, revision_no: revision, revision_by: "executor", revision_at: "", revisions: [revision],
    fields: { 用例名称: id }, sources: [], reviews: [], confirmations: [{ revision_no: revision, accepted: true, basis: "viewed" }], confirmation_stale: false,
  } as unknown as Item;
}
const diagram = (id: string, at: string) => ({ diagram_id: id, name: `${id} 图`, kind: "flowchart", kind_name: "流程图", revision_no: 2, revision_by: "executor", revision_at: at }) as unknown as DiagramRow;
function task(over: Partial<Task> = {}): Task {
  return {
    task_id: "TASK-001", task_name: "图书借阅", task_type: "软件需求规格说明编制", domain_tag: null, started_at: "",
    definition: { collections: [{ name: "功能用例", prefix: "UC", needs_review: false, review_rules: null, fields: [{ name: "用例名称", type: "文本", required: true, values: null }] }] },
    completion: null, items: [item("UC-001", 3), item("UC-002", 5), item("UC-003", 6)], latest_revision: 6, versions: [version(1, 3), version(2, 5, { actor: "executor", note: "加了续借" })],
    diagrams: [diagram("D-001", "2026-10-13T08:00:00"), diagram("D-002", "2026-10-13T10:00:00")], ...over,
  } as unknown as Task;
}

describe("版本的读法", () => {
  it("最近一版取版本号最大的；条目比修订号，图比改动的时刻；没有发布过都不算改动", () => {
    const t = task();
    const latest = latestVersion(t)!;
    expect([latest.version_no, nextVersionNo(t), latestVersion(task({ versions: [] })), nextVersionNo(task({ versions: [] }))]).toEqual([2, 3, null, 1]);
    expect(t.items.map((one) => changedAfter(latest, one))).toEqual([false, false, true]);
    expect(t.diagrams!.map((one) => diagramChangedAfter(latest, one))).toEqual([false, true]);
    expect([changedAfter(null, item("UC-009", 9)), diagramChangedAfter(null, diagram("D-9", "2026-10-14T00:00:00"))]).toEqual([false, false]);
    const changes = changesAfter(t);
    expect([changes.items.map((one) => one.item_id), changes.diagrams.map((one) => one.diagram_id)]).toEqual([["UC-003"], ["D-002"]]);
    expect([changesLine(t), changesLine(task({ versions: [] })), changesLine(task({ items: [], diagrams: [] }))]).toEqual(["有 2 处改动在第 2 版之后", null, null]);
  });

  it("有没有东西可以发布：没发布过有；最近一版之后有新的修订或者改过的图有；刚发布完、什么都没改没有", () => {
    expect(somethingToPublish(task({ versions: [] }))).toBe(true);
    expect(somethingToPublish(task())).toBe(true);
    expect(somethingToPublish(task({ latest_revision: 5, diagrams: [] }))).toBe(false);
    expect(somethingToPublish(task({ latest_revision: 5, diagrams: [diagram("D-002", "2026-10-13T10:00:00")] }))).toBe(true);
  });

  it("Word 里的图照实写张数：都是图片、都是 Mermaid 文本、有几张是 Mermaid 文本；没有图、没有 Word 存档时不写", () => {
    expect([
      figuresText(version(1, 3, { figure_count: 3, figure_pictures: 3 })),
      figuresText(version(1, 3, { figure_count: 3, figure_pictures: 0 })),
      figuresText(version(1, 3, { figure_count: 3, figure_pictures: 2 })),
      figuresText(version(1, 3, { figure_count: null, figure_pictures: null })),
      figuresText(version(1, 3, { figure_count: 2, figure_pictures: 2, has_docx: false })),
    ]).toEqual(["Word 里 3 张图都是图片", "Word 里 3 张图是 Mermaid 文本", "Word 里 3 张图有 1 张是 Mermaid 文本", null, null]);
  });

  it("版本一行的小字与没有存档时的说明；文档里的图每张只取一次", () => {
    expect([versionMeta(version(1, 3)), versionMeta(version(2, 5, { actor: "executor", published_at: null }))]).toEqual(["10-13 09:00 · 你发布的", "助手发布的"]);
    expect([missingArchiveText(version(1, 2, { has_markdown: false, has_docx: false })), missingArchiveText(version(1, 2, { has_docx: false }))])
      .toEqual(["这一版是升级之前完成的，当时的文档没有存下来", "这一种没有存下来"]);
    const md = "# 文档\n\n```mermaid D-001\nflowchart TD\n  a --> b\n```\n\n```mermaid D-001\nflowchart TD\n  a --> b\n```\n\n```mermaid\nflowchart TD\n  c --> d\n```\n";
    expect(figuresOf(md)).toEqual([{ diagram_id: "D-001", mermaid: "flowchart TD\n  a --> b" }]);
  });
});

describe("条目区的「第 N 版后有改动」", () => {
  function panel(t: Task) {
    const onSelect = vi.fn();
    render(<Wrap><ItemsPanel task={t} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={null} onSelect={onSelect}
      submit={vi.fn(async () => null)} onGenerateDoc={noop} latestRevision={6} /></Wrap>);
    return onSelect;
  }

  it("最近一版之后改过的条目挂一枚蓝色小标签；顶部一行写几处改动，点「列出来」列出条目与图，点一条打开它", () => {
    const onSelect = panel(task());
    expect(within(screen.getByTestId("item-UC-003")).getByTestId("changed-UC-003")).toHaveTextContent("第 2 版后有改动");
    expect(screen.queryByTestId("changed-UC-001")).toBeNull();
    expect(screen.queryByTestId("changed-UC-002")).toBeNull();
    const bar = screen.getByTestId("changes-bar");
    expect(bar).toHaveTextContent("有 2 处改动在第 2 版之后");
    fireEvent.click(screen.getByTestId("changes-toggle"));
    expect(screen.getByTestId("changes-list").textContent).toBe("UC-003 UC-003 的名字D-002 D-002 图");
    fireEvent.click(within(screen.getByTestId("changes-list")).getByText("UC-003 UC-003 的名字"));
    expect(onSelect).toHaveBeenCalledWith("UC-003");
  });

  it("还没有发布过：没有小标签，也没有那一行", () => {
    panel(task({ versions: [] }));
    expect(screen.queryByTestId("changed-UC-003")).toBeNull();
    expect(screen.queryByTestId("changes-bar")).toBeNull();
  });
});

describe("「文档与版本」页签的版本表", () => {
  function docs(t: Task, fetched: VersionView[] = t.versions ?? []) {
    const list = vi.spyOn(api, "listVersions").mockResolvedValue(fetched);
    const onShowRevision = vi.fn();
    render(<Wrap><div className="app"><DocsTab task={t} readOnly={false} writesOff={false} onGenerate={noop} onShowRevision={onShowRevision} onGo={noop} /></div></Wrap>);
    return { list, onShowRevision };
  }

  it("各版最新的在上：版本号、时刻与谁、修订、发布说明、两种存档；点「修订 N」交给工作视图；存档情况以版本接口为准", async () => {
    const { list, onShowRevision } = docs(task(), [version(1, 3, { has_markdown: false, has_docx: false }), version(2, 5, { actor: "executor", note: "加了续借", figure_count: 3, figure_pictures: 0 })]);
    await waitFor(() => expect(list).toHaveBeenCalledWith("TASK-001"));
    const rows = [...screen.getByTestId("versions").querySelectorAll("tbody tr")].map((one) => one.getAttribute("data-testid"));
    expect(rows).toEqual(["version-2", "version-1"]);
    const second = screen.getByTestId("version-2");
    expect([...second.querySelectorAll("td")].slice(0, 4).map((td) => td.textContent)).toEqual(["第 2 版", "10-13 09:00 · 助手发布的", "修订 5", "加了续借"]);
    expect(screen.getByTestId("version-2-md")).toHaveAttribute("href", "/api/v1/tasks/TASK-001/versions/2/document?format=md");
    expect(screen.getByTestId("version-2-docx")).toHaveAttribute("href", "/api/v1/tasks/TASK-001/versions/2/document?format=docx");
    expect(screen.getByTestId("version-2-figures")).toHaveTextContent("Word 里 3 张图是 Mermaid 文本");
    expect(screen.queryByTestId("version-1-figures")).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("version-1-md")).toBeNull());
    expect(screen.getByTestId("version-1")).toHaveTextContent("这一版是升级之前完成的，当时的文档没有存下来");
    fireEvent.click(within(second).getByText("修订 5"));
    expect(onShowRevision).toHaveBeenCalledWith(5);
    expect(screen.getByTestId("docs-difference")).toHaveTextContent("有 2 处改动在第 2 版之后（1 个条目、1 张图）。");
  });

  it("还没有发布过：写一句怎样发布，不去取版本接口，也没有差异那一句", () => {
    const { list } = docs(task({ versions: [] }));
    expect(screen.getByTestId("versions-empty")).toHaveTextContent("还没有发布过。完成条件都满足之后，可以在上方「发布第 1 版」。");
    expect(screen.queryByTestId("docs-difference")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("页面状态收到发布事件", () => {
  it("version_published：版本列表加一版（同一版不加两次）", () => {
    const state = { ...initialWorkState("S-1"), phase: "ready" as const, seq: 10, task: task({ versions: [version(1, 3)] }) };
    const data = { seq: 11, at: "2026-10-13T11:00:00", version_no: 2, revision_no: 6, actor: "user", note: "第二版" };
    const next = workReducer(state, { type: "sse", event: "version_published", data });
    expect(next.task!.versions!.map((one) => [one.version_no, one.revision_no, one.actor, one.note, one.published_at])).toEqual([
      [1, 3, "user", null, "2026-10-13T09:00:00"], [2, 6, "user", "第二版", "2026-10-13T11:00:00"]]);
    expect(workReducer(next, { type: "sse", event: "version_published", data: { ...data, seq: 12 } }).task!.versions).toHaveLength(2);
  });
});
