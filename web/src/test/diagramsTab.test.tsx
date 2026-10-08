// 图表页签（components/work/DiagramsPane.tsx 与条目区的页签排）：页签与计数、没有图时的引导、列表、详情（文本、图、说明、来源、
// 图里画了谁）、画不出来时的原话、导出、用户改图（预览、保存成修订、校验不过不保存、修订号过时）、只读、图被删了。
// mermaid 包换成假的（jsdom 里画不了图），导出换成假的；取图的详情换成假的接口。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type { DiagramDetail, DiagramRow, Item, Task } from "../api/types";
import { diagramPreview } from "../components/work/DiagramsPane";
import { ItemsPanel } from "../components/work/ItemsPanel";
import * as diagram from "../components/diagram/mermaid";
import { DIAGRAMS_EMPTY_TEXT, DIAGRAM_DELETED_TEXT, EXPORT_NEEDS_SAVE_TEXT, NOTHING_DRAWN_TEXT, PREVIEW_TEXT, revisionLine, revisionText, saveFailedText } from "../model/diagrams";

const fakeRender = vi.fn(async (id: string, text: string) => {
  if (text.includes("写错")) throw new Error("Parse error on line 2:\n...a([\"读者\"]\n----------^\nExpecting 'SQE'");
  return { svg: `<svg id="${id}" viewBox="0 0 300 150" width="100%" style="max-width: 300px;"><text>${text}</text></svg>` };
});
vi.mock("mermaid", () => ({ default: { initialize: () => {}, render: (id: string, text: string) => fakeRender(id, text) } }));
vi.mock("../components/diagram/mermaid", async (original) => ({ ...(await original<typeof diagram>()), exportPng: vi.fn(async () => ({ scale: 2 })) }));
const exportPng = vi.mocked(diagram.exportPng);

Element.prototype.scrollTo ??= function () {};
diagramPreview.delayMs = 10;
afterEach(() => { cleanup(); vi.restoreAllMocks(); fakeRender.mockClear(); exportPng.mockClear(); });

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><div className="app">{children}</div></AntApp></ConfigProvider>
);
const noop = () => {};

const item = (id: string, title: string): Item => ({
  item_id: id, collection: "功能用例", title, revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1],
  fields: { 用例名称: title }, sources: [], reviews: [], waivers: [], confirmations: [], confirmation_stale: false,
} as unknown as Item);
const MERMAID = 'flowchart LR\n  reader(["读者"])\n  a(["UC-001 借出图书"])\n  reader --> a';
const row = (over: Partial<DiagramRow> = {}): DiagramRow => ({
  diagram_id: "D-001", name: "读者用例", kind: "use_case", kind_name: "用例图", revision_no: 2, revision_by: "executor",
  revision_at: "2026-10-08T14:03:00", created_at: "2026-10-08T13:00:00", source_count: 3, ...over,
});
const detail = (over: Partial<DiagramDetail> = {}): DiagramDetail => ({
  ...row(), deleted: false, mermaid: MERMAID, note: "读者能做的事。", revisions: [1, 2],
  sources: [
    { kind: "用户的话", locator: "S1#u2", excerpt: "把这几个用例画成用例图", supports: [] },
    { kind: "条目", locator: "UC-001", excerpt: "", supports: [], depends_revision: 1, current_revision: 2, stale: "changed" },
    { kind: "条目", locator: "UC-003", excerpt: "", supports: [], depends_revision: 1, current_revision: null, stale: "deleted" },
  ],
  depended_by: [],
  drawn: [{ item_id: "UC-001", title: "借出图书", state: "live" }, { item_id: "UC-003", title: "挂失借书证", state: "deleted" }, { item_id: "UC-404", title: null, state: "missing" }],
  ...over,
} as DiagramDetail);
const task = (diagrams: DiagramRow[] | undefined, status = "进行中"): Task => ({
  task_id: "TASK-D", task_name: "图表", task_type: "演示", domain_tag: null, status, started_at: "", ended_at: null,
  definition: { collections: [{ name: "功能用例", prefix: "UC", needs_review: false, review_rules: null, fields: [{ name: "用例名称", type: "文本", required: true, values: null }] }] },
  completion: null, items: [item("UC-001", "借出图书"), item("UC-002", "归还图书")], latest_revision: 2, diagrams,
} as unknown as Task);

type Over = Partial<Parameters<typeof ItemsPanel>[0]>;
const panel = (t: Task, over: Over = {}) => (
  <Wrap><ItemsPanel task={t} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={null} onSelect={noop}
    submit={vi.fn(async () => null)} onGenerateDoc={noop} latestRevision={2} {...over} /></Wrap>
);
const mockDetail = (...answers: DiagramDetail[]) => {
  const spy = vi.spyOn(api, "diagram");
  answers.forEach((one, i) => (i < answers.length - 1 ? spy.mockResolvedValueOnce(one) : spy.mockResolvedValue(one)));
  return spy;
};
const openDiagram = async (t: Task, over: Over = {}) => {
  const view = render(panel(t, { initialDiagram: "D-001", ...over }));
  await screen.findByTestId("diagram-sub");
  return view;
};
const textarea = () => screen.getByTestId("diagram-text") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });

describe("图表页签与列表", () => {
  it("页签排里在各集合之后有「图表」，计数是还在的图的张数；没有图时写一句引导", () => {
    render(panel(task(undefined)));
    const tab = screen.getByTestId("diagrams-tab");
    expect(tab.textContent).toBe("图表0");
    expect([...document.querySelectorAll(".itab")].map((one) => one.textContent)).toEqual(["功能用例2", "图表0"]);
    expect(tab.classList.contains("on")).toBe(false);
    fireEvent.click(tab);
    expect(tab.classList.contains("on")).toBe(true);
    expect(screen.getByTestId("diagrams-empty").textContent).toBe(DIAGRAMS_EMPTY_TEXT);
    expect(DIAGRAMS_EMPTY_TEXT).toBe("在对话里让助手画一张图，例如『把这几个用例画成用例图』");
  });

  it("停在图表页签时筛选项不显示，进度汇总照旧；切回集合页签筛选项回来", () => {
    render(panel(task([row()])));
    expect(document.querySelectorAll(".filt").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("diagrams-tab"));
    expect(document.querySelectorAll(".filt").length).toBe(0);
    expect(screen.getByTestId("progress")).toBeTruthy();
    expect(screen.queryByTestId("item-UC-001")).toBeNull();
    fireEvent.click(screen.getByText("功能用例", { selector: ".itab", exact: false }));
    expect(document.querySelectorAll(".filt").length).toBeGreaterThan(0);
    expect(screen.getByTestId("item-UC-001")).toBeTruthy();
  });

  it("列表每行：编号、图名、种类中文名、最近修订（第几次、谁、何时）；图的清单变了计数与列表跟着变", () => {
    const rows = [row(), row({ diagram_id: "D-002", name: "借书的先后", kind: "sequence", kind_name: "时序图", revision_no: 1, revision_by: "user" })];
    const view = render(panel(task(rows), { initialDiagrams: true }));
    expect(screen.getByTestId("diagrams-tab").textContent).toBe("图表2");
    expect([...screen.getByTestId("diagram-D-001").children].map((one) => one.textContent)).toEqual(["D-001", "读者用例", "用例图", revisionText(rows[0])]);
    expect(screen.getByTestId("diagram-D-002").textContent).toContain("修订 1 · 用户 · ");
    expect(revisionText(rows[0], new Date(2026, 9, 8))).toBe("修订 2 · 助手 · 10-08 14:03");
    expect(revisionText(rows[0], new Date(2027, 0, 1))).toBe("修订 2 · 助手 · 2026-10-08 14:03");
    view.rerender(panel(task([rows[0]]), { initialDiagrams: true }));
    expect(screen.getByTestId("diagrams-tab").textContent).toBe("图表1");
    expect(screen.queryByTestId("diagram-D-002")).toBeNull();
  });
});

describe("图的详情", () => {
  it("点一行打开：顶上编号、图名、种类与修订；左边 Mermaid 文本，右边画出来的图；说明、来源与图里画了谁", async () => {
    const got = mockDetail(detail());
    render(panel(task([row()]), { initialDiagrams: true }));
    fireEvent.click(screen.getByTestId("diagram-D-001"));
    expect(screen.getByTestId("diagram-loading")).toBeTruthy();
    const sub = await screen.findByTestId("diagram-sub");
    expect(got).toHaveBeenCalledWith("TASK-D", "D-001");
    const view = screen.getByTestId("diagram-detail");
    expect(view.querySelector(".dh")!.textContent).toBe("D-001读者用例用例图");
    expect(sub.textContent).toBe(`${revisionLine(row())} · 来源 3 条`);
    expect(revisionLine(row())).toBe("现在是修订 2，由助手改的 · 2026-10-08 14:03");
    expect([revisionLine(row({ revision_no: 1 })), revisionLine(row({ revision_by: "user" }))]).toEqual(["现在是修订 1，由助手画的 · 2026-10-08 14:03", "现在是修订 2，由你改的 · 2026-10-08 14:03"]);
    expect(textarea().value).toBe(MERMAID);
    await waitFor(() => expect(screen.getByTestId("diagram-svg").querySelector("svg")).not.toBeNull());
    expect(screen.getByTestId("diagram-svg").textContent).toBe(MERMAID);
    expect(screen.getByTestId("diagram-note-text").textContent).toBe("读者能做的事。");
    // 来源用条目的来源卡片：依据已变、已经删除的记号相同；图的来源不写「支持哪个字段」。
    expect([...view.querySelectorAll(".srcbox .chip")].map((one) => one.textContent)).toEqual(["用户的话", "条目", "条目"]);
    expect(within(view).getByTestId("basis-stale-UC-001").textContent).toBe("依据已变：UC-001 在这之后改过（引用时是修订 1，现在是修订 2）");
    expect(within(view).getByTestId("basis-deleted-UC-003").textContent).toBe("UC-003 已经删除");
    expect(view.querySelectorAll(".srcbox .fields").length).toBe(0);
    // 依据条目的来源可以没有摘录：没有摘录就不留一对空的引号。
    expect([...view.querySelectorAll(".srcbox .quote")].map((one) => one.textContent)).toEqual(["「把这几个用例画成用例图」"]);
    // 图里画了谁：还在的可点，已经删除的、任务里没有的标灰并说明。
    expect(screen.getByTestId("diagram-drawn").textContent).toBe("UC-001 借出图书、UC-003 挂失借书证（已经删除）、UC-404（任务里没有这个条目）");
    expect(screen.getByTestId("drawn-UC-001").querySelector(".ref")!.getAttribute("role")).toBe("button");
    expect([screen.getByTestId("drawn-UC-003").querySelector(".ref"), screen.getByTestId("drawn-UC-404").querySelector(".ref")]).toEqual([null, null]);
    expect(screen.getByTestId("drawn-UC-404").querySelector(".gone")).not.toBeNull();
    // 回到列表。
    fireEvent.click(screen.getByText("‹ 回到列表"));
    expect(screen.getByTestId("diagram-list")).toBeTruthy();
  });

  it("点图里画的条目或来源里的条目：打开那个条目；文本里没有条目编号、没有说明时各有交代", async () => {
    mockDetail(detail());
    const onSelect = vi.fn();
    const view = await openDiagram(task([row()]), { onSelect });
    fireEvent.click(screen.getByTestId("drawn-UC-001").querySelector(".ref")!);
    fireEvent.click(screen.getByTestId("note-source-UC-001"));
    expect(onSelect.mock.calls.map((call) => call[0])).toEqual(["UC-001", "UC-001"]);
    view.unmount();
    mockDetail(detail({ drawn: [], note: "", sources: [] }));
    await openDiagram(task([row()]));
    expect(screen.getByTestId("diagram-drawn").textContent).toBe(NOTHING_DRAWN_TEXT);
    expect(screen.queryByTestId("diagram-note-text")).toBeNull();
    expect([...screen.getByTestId("diagram-detail").querySelectorAll(".sec-h")].map((one) => one.textContent)).toEqual(["Mermaid 文本", "图", "图里画了谁"]);
  });

  it("画不出来时写 mermaid 的原话，「导出 PNG」不能点；画出来了点导出，文件名是「编号 图名」", async () => {
    mockDetail(detail({ mermaid: 'flowchart LR\n  写错 a(["读者"]' }));
    const view = await openDiagram(task([row()]));
    expect((await screen.findByTestId("diagram-error")).textContent).toContain("这张图画不出来：Parse error on line 2:");
    expect(screen.getByTestId("diagram-export")).toBeDisabled();
    view.unmount();
    mockDetail(detail());
    await openDiagram(task([row()]));
    await waitFor(() => expect(screen.getByTestId("diagram-export")).toBeEnabled());
    fireEvent.click(screen.getByTestId("diagram-export"));
    await waitFor(() => expect(exportPng).toHaveBeenCalledTimes(1));
    expect(exportPng.mock.calls[0][1]).toBe("D-001 读者用例");
    expect(exportPng.mock.calls[0][0]).toContain(MERMAID);
  });

  it("这张图有了新修订、或者条目有了新修订：详情重新取；图被删了写「这张图已经删除。」；读不到时写明", async () => {
    const got = mockDetail(detail(), detail({ revision_no: 3, name: "读者能做的三件事" }), detail({ revision_no: 3, name: "读者能做的三件事", sources: [] }), detail({ deleted: true }));
    const view = await openDiagram(task([row()]));
    view.rerender(panel(task([row({ revision_no: 3 })]), { initialDiagram: "D-001" }));
    await waitFor(() => expect(screen.getByTestId("diagram-detail").querySelector(".title")!.textContent).toBe("读者能做的三件事"));
    view.rerender(panel(task([row({ revision_no: 3 })]), { initialDiagram: "D-001", latestRevision: 3 }));
    await waitFor(() => expect(screen.getByTestId("diagram-sub").textContent).toContain("来源 0 条"));
    view.rerender(panel(task([]), { initialDiagram: "D-001", latestRevision: 3 }));
    expect((await screen.findByTestId("diagram-deleted")).textContent).toBe(DIAGRAM_DELETED_TEXT);
    expect(got).toHaveBeenCalledTimes(4);
    view.unmount();
    vi.spyOn(api, "diagram").mockRejectedValue(new ApiError("not_found", "没有图 D-009。", 404));
    render(panel(task([]), { initialDiagram: "D-009" }));
    expect((await screen.findByTestId("diagram-load-error")).textContent).toBe("读不到这张图：没有图 D-009。");
  });
});

describe("用户改图", () => {
  it("改了文本：右边按改后的文本重画并写「预览：改动还没有保存」，导出灰掉并说明，报告有没保存的改动；放弃改动回到库里的文本", async () => {
    mockDetail(detail());
    const onDiagramDirty = vi.fn();
    await openDiagram(task([row()]), { onDiagramDirty });
    await waitFor(() => expect(screen.getByTestId("diagram-export")).toBeEnabled());
    expect([screen.getByTestId("diagram-save"), screen.getByTestId("diagram-discard")].map((one) => (one as HTMLButtonElement).disabled)).toEqual([true, true]);
    const changed = `${MERMAID}\n  b(["UC-002 归还图书"])`;
    type(changed);
    expect(screen.getByTestId("diagram-preview-note").textContent).toBe(PREVIEW_TEXT);
    await waitFor(() => expect(screen.getByTestId("diagram-svg").textContent).toBe(changed));
    expect(screen.getByTestId("diagram-export")).toBeDisabled();
    expect(screen.getByTestId("diagram-export").getAttribute("title")).toBe(EXPORT_NEEDS_SAVE_TEXT);
    expect(screen.getByTestId("diagram-save")).toBeEnabled();
    expect(onDiagramDirty.mock.calls).toEqual([[true]]);
    fireEvent.click(screen.getByTestId("diagram-discard"));
    expect(textarea().value).toBe(MERMAID);
    expect(screen.queryByTestId("diagram-preview-note")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("diagram-svg").textContent).toBe(MERMAID));
    expect(screen.getByTestId("diagram-export")).toBeEnabled();
    expect(onDiagramDirty.mock.calls).toEqual([[true], [false]]);
    // 改回与库里一样的文本不算有改动。
    type(`${MERMAID} `);
    type(MERMAID);
    expect(screen.getByTestId("diagram-save")).toBeDisabled();
  });

  it("点保存：作为界面操作 edit_diagram 发出，带图的编号、页面看到的修订号与改后的文本；新修订取回来之后收起草稿", async () => {
    const changed = `${MERMAID}\n  b(["UC-002 归还图书"])`;
    mockDetail(detail(), detail({ revision_no: 3, revision_by: "user", mermaid: changed }));
    const submit = vi.fn(async () => null);
    const onDiagramDirty = vi.fn();
    const view = await openDiagram(task([row()]), { submit, onDiagramDirty });
    type(changed);
    fireEvent.click(screen.getByTestId("diagram-save"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]).toEqual([
      { kind: "edit_diagram", targets: [{ diagram_id: "D-001", base_revision: 2 }], fields: { mermaid: changed }, notify_executor: false }, "修改图 D-001"]);
    await waitFor(() => expect(screen.getByTestId("diagram-sub").textContent).toContain("正在保存…"));
    expect(textarea().readOnly).toBe(true);
    // 图的事件到了：清单里这张图成了修订 3，详情重新取。
    view.rerender(panel(task([row({ revision_no: 3, revision_by: "user" })]), { initialDiagram: "D-001", submit, onDiagramDirty }));
    await waitFor(() => expect(screen.getByTestId("diagram-sub").textContent).toMatch(/^现在是修订 3，由你改的/));
    expect(screen.getByTestId("diagram-sub").textContent).not.toContain("正在保存");
    expect(textarea().value).toBe(changed);
    expect(textarea().readOnly).toBe(false);
    expect(screen.queryByTestId("diagram-preview-note")).toBeNull();
    expect(screen.getByTestId("diagram-save")).toBeDisabled();
    expect(onDiagramDirty.mock.calls).toEqual([[true], [false]]);
  });

  it("没有保存成：校验不过写任务服务给的原话，校验没有做成写那一句，修订号过时写明现在是修订几；改动留在文本框里", async () => {
    const syntax = new ApiError("rejected", "这张图没有保存：Mermaid 文本第 2 行附近写得不对，改了再存。解析时的原话：Parse error on line 2", 422, { reason: "syntax", line: 2 });
    const down = new ApiError("rejected", "这一次没有办法校验 Mermaid 文本，图没有保存。这是程序这边的问题，不是文本写错了。", 422, { reason: "unavailable", line: null });
    const stale = new ApiError("stale_revision", "图 D-001 刚被改过。", 409, { diagrams: [{ diagram_id: "D-001", base_revision: 2, current_revision: 4, changed_by: "executor" }] });
    const expected: [ApiError, string][] = [
      [syntax, syntax.message], [down, down.message],
      [stale, "D-001 已经被改到修订 4，你的改动没有保存。点「放弃改动」看现在的内容，再重新改。"],
      [new ApiError("session_busy", "助手正在工作，这一轮做完之后才能发下一句。", 409, { reason: "working" }), "没有保存：助手正在工作，这一轮做完之后才能发下一句。"],
    ];
    for (const [error, text] of expected) expect(saveFailedText("D-001", error)).toBe(text);
    mockDetail(detail());
    const submit = vi.fn<() => Promise<ApiError | null>>(async () => syntax);
    await openDiagram(task([row()]), { submit });
    const wrong = 'flowchart LR\n  reader(["读者"]';
    type(wrong);
    fireEvent.click(screen.getByTestId("diagram-save"));
    expect((await screen.findByTestId("diagram-save-error")).textContent).toBe(syntax.message);
    expect(textarea().value).toBe(wrong);
    expect(textarea().readOnly).toBe(false);
    expect(screen.getByTestId("diagram-sub").textContent).not.toContain("正在保存");
    // 再改一下文本，上一次的原因就收起来。
    type(`${wrong})`);
    expect(screen.queryByTestId("diagram-save-error")).toBeNull();
  });

  it("助手工作中、任务已结束：文本框只读，保存不能点，旁边写明原因", async () => {
    mockDetail(detail());
    const view = await openDiagram(task([row()]), { writesOff: true });
    expect(textarea().readOnly).toBe(true);
    expect(screen.getByTestId("diagram-save")).toBeDisabled();
    expect(screen.getByTestId("diagram-detail").querySelector(".dg-hint")!.textContent).toBe("助手正在工作，结束后你可以继续修改");
    view.unmount();
    await openDiagram(task([row()], "已完成"), { readOnly: true });
    expect(textarea().readOnly).toBe(true);
    expect(screen.getByTestId("diagram-detail").querySelector(".dg-hint")!.textContent).toBe("任务已结束，不能再改。");
  });
});
