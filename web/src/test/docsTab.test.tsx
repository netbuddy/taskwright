// 工作台「文档与版本」页签：生成文档与发布第 N 版两个按钮（发布不能点时说明为什么）、预览与两种下载、按章覆盖、发布前检查与非阻断提示、追溯一句。
// 版本表另在 versions.test.tsx 里测。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState } from "react";
import { ItemsPanel } from "../components/work/ItemsPanel";
import type { Task } from "../api/types";
import { api } from "../api/client";
import { DOCS_LEAD, DocsTab } from "../components/work/DocsTab";
import * as download from "../model/download";
import { differenceLine, publishOff, traceLine } from "../model/docsPage";
import { checkRows, coverageRows, hints } from "../model/docsCheck";
import { toc } from "../model/chapters";
import { change, overallTask } from "./fixtures/overallTask";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const met = (all: boolean) => ({ all_met: all, unmet_count: all ? 0 : 1, hints: [], conditions: [
  { collection: "功能用例", name: "a", met: true, state: "met", done: 0, total: 0, missing: [], note: "" },
  { collection: "功能用例", name: "b", met: all, state: all ? "met" : "unmet", done: 0, total: 0, missing: [], note: "" }] });
const ready = (over: Partial<Task> = {}) => overallTask({ completion: met(true), ...over } as unknown as Partial<Task>);
function tab(t: Task, props: Partial<Parameters<typeof DocsTab>[0]> = {}) {
  const calls = { generate: vi.fn(), publish: vi.fn(), revision: vi.fn(), go: vi.fn() };
  render(<div className="app"><DocsTab task={t} readOnly={false} writesOff={false} onGenerate={calls.generate} onPublish={calls.publish} onShowRevision={calls.revision} onGo={calls.go} {...props} /></div>);
  return calls;
}

describe("「文档与版本」页签", () => {
  it("页头两个按钮：「生成文档」打开对话框；「发布第 N 版」条件满足时可点，点了打开发布框；页上一句说明", () => {
    const calls = tab(ready());
    expect(screen.getByTestId("docs-tab")).toHaveTextContent(DOCS_LEAD);
    fireEvent.click(screen.getByTestId("docs-generate"));
    expect(screen.getByTestId("docs-publish")).toHaveTextContent("发布第 1 版");
    expect(screen.getByTestId("docs-publish")).toBeEnabled();
    fireEvent.click(screen.getByTestId("docs-publish"));
    expect([calls.generate.mock.calls.length, calls.publish.mock.calls.length]).toEqual([1, 1]);
  });

  it("发布不能点时灰着，悬停说明：完成条件没满足（满足几条）、与最近一版相同、助手在工作、助手不可用；没有发布这一样时不显示按钮", () => {
    expect(publishOff(overallTask({ completion: met(false) } as unknown as Partial<Task>), { readOnly: false, writesOff: false }))
      .toBe("完成条件还没有全部满足（现在满足 1 / 2 条，见本页「发布前检查」）。");
    const same = ready({ versions: [{ version_no: 1, revision_no: 12, published_at: "", actor: "user", note: null, has_markdown: true, has_docx: true }] } as unknown as Partial<Task>);
    expect(publishOff(same, { readOnly: false, writesOff: false })).toBe("当前资产与第 1 版相同，没有可发布的改动。");
    expect(publishOff(ready(), { readOnly: false, writesOff: true })).toBe("助手正在工作，等它做完这一轮再发布。");
    expect(publishOff(ready(), { readOnly: true, writesOff: false })).toBe("助手现在不可用，不能发布。");
    tab(same);
    expect(screen.getByTestId("docs-publish")).toBeDisabled();
    expect(screen.getByTestId("docs-publish")).toHaveAttribute("title", "当前资产与第 1 版相同，没有可发布的改动。");
    expect(differenceLine(same)).toBe("当前资产与第 1 版相同。");
    cleanup();
    tab(ready(), { onPublish: undefined, publishError: "交付物在确认之后又改了。" });
    expect(screen.queryByTestId("docs-publish")).toBeNull();
    expect(screen.getByTestId("docs-publish-error")).toHaveTextContent("交付物在确认之后又改了。");
  });

  it("文档一块：预览在页里展开最新修订的文档，再点收起；下载 Markdown 取最新修订", async () => {
    const t = ready();
    const preview = vi.spyOn(api, "previewDocument").mockResolvedValue({ text: "# 图书馆借阅系统 软件需求规格说明\n\n正文。" });
    const blob = new Blob(["md"]);
    const fetched = vi.spyOn(api, "downloadDocument").mockResolvedValue(blob);
    const saved = vi.spyOn(download, "saveBlob").mockImplementation(() => {});
    tab(t);
    fireEvent.click(screen.getByTestId("docs-preview"));
    expect(await screen.findByTestId("docs-preview-body")).toHaveTextContent("正文。");
    expect(preview).toHaveBeenCalledWith("TASK-001", {});
    expect(screen.getByTestId("docs-preview")).toHaveTextContent("收起预览");
    fireEvent.click(screen.getByTestId("docs-preview"));
    expect(screen.queryByTestId("docs-preview-body")).toBeNull();
    fireEvent.click(screen.getByTestId("docs-download-md"));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(blob, "图书馆借阅系统-修订12.md"));
    expect(fetched).toHaveBeenCalledWith("TASK-001", {});
  });

  it("追溯一句：需求条目（问题条目不算）里几条可追溯到业务说明的节或图，例外点名；依据的节上挂着未解决的待澄清问题的另注一句", () => {
    const t = ready();
    const line = traceLine(t);
    expect(line).toMatch(/^3 条需求条目中 \d 条可追溯到业务说明的节或图/);
    change(t, "UC-001", (item) => { item.sources = []; });
    expect(traceLine(t)).toContain("例外：UC-001");
    tab(t);
    expect(screen.getByTestId("docs-trace")).toHaveTextContent("例外：UC-001");
  });
});

describe("「文档与版本」页签的两张表", () => {
  it("按章覆盖：前七章照页面目录的章名（节数、条目数、图数、有没有导语），业务规则与决策两章写内容从哪里来，其后每个集合一章只数条目；空章标出", () => {
    const t = ready();
    const rows = coverageRows(t, toc(t));
    expect(rows.map((one) => one.name)).toEqual(["1 概述与范围", "2 角色", "3 业务流程", "4 业务对象", "5 业务规则", "6 业务目标", "7 决策记录与待澄清事项", "8 功能用例", "9 问题"]);
    expect(rows[4]).toMatchObject({ sections: null, items: null, note: "由各节「已经定下的」汇成规则表", empty: false });
    expect(rows[7]).toMatchObject({ sections: null, items: 3, diagrams: null, intro: null });
    const sections = toc(t).chapters.map((one) => one.sections.filter((s) => s.no !== null).length);
    expect(rows.slice(0, 4).map((one) => one.sections)).toEqual(sections.slice(0, 4));
    expect(rows.filter((one) => one.empty).every((one) => one.note === "空章")).toBe(true);
    tab(t);
    expect(screen.getByTestId("docs-coverage").querySelectorAll("tbody tr")).toHaveLength(9);
  });

  it("发布前检查：完成条件全部满足时收成一句；没满足时逐条一行，差什么与去补的入口（评审去评审与确认、未读的需求条目筛出未读、业务说明的页打开那一节、未解决的问题去问题）", () => {
    tab(ready());
    expect(screen.getByTestId("check-all-met")).toHaveTextContent("完成条件全部满足");
    expect(screen.queryByTestId("docs-check")).toBeNull();
    cleanup();
    const cond = (collection: string, name: string, missing: string[], state = "unmet") =>
      ({ collection, name, met: state === "met", state, done: 0, total: 0, missing, note: "" });
    const t = overallTask({ completion: { all_met: false, unmet_count: 4, hints: [], conditions: [
      cond("功能用例", "至少一个条目", [], "met"), cond("功能用例", "每个条目评审通过", ["UC-002"]), cond("功能用例", "每个条目用户确认", ["UC-003", "UC-001"]),
      cond("业务说明", "每个条目用户确认", ["OA-004"]), cond("问题", "没有状态为未解决的条目", ["TBD-001"]), cond("非功能需求", "每个条目评审通过", [], "empty")] } } as unknown as Partial<Task>);
    expect(checkRows(t).map((one) => [one.label, one.gap, one.go])).toEqual([
      ["功能用例：至少一个条目", "已满足", null],
      ["功能用例：每个条目评审通过", "UC-002 还没有评审通过", { kind: "review" }],
      ["功能用例：每个条目用户确认", "UC-001、UC-003 你还没有看过", { kind: "items", collection: "功能用例", filter: "unread" }],
      ["业务说明：每个条目用户确认", "OA-004 你还没有看过", { kind: "item", itemId: "OA-004" }],
      ["问题：没有状态为未解决的条目", "TBD-001 还没有解决", { kind: "items", collection: "问题", filter: "all" }],
      ["暂不核对", "非功能需求现在还没有条目，它的完成条件暂时不用核对。", null]]);
    const calls = tab(t);
    fireEvent.click(screen.getByTestId("go-功能用例/每个条目评审通过"));
    expect(calls.go).toHaveBeenCalledWith({ kind: "review" });
  });

  it("非阻断提示：空章、没有依据的需求条目、没看过的图、依据的节上有待澄清问题的条目、判定带出的提示，每条有入口", () => {
    const t = ready({ diagrams: [{ diagram_id: "D-001", name: "借书流程", kind: "flowchart", kind_name: "流程图", revision_no: 1, revision_by: "executor", revision_at: "", created_at: "", source_count: 0, viewed: false }] } as unknown as Partial<Task>);
    change(t, "UC-001", (item) => { item.sources = []; });
    t.completion!.hints = [{ kind: "untagged_overall_pages", collection: "业务说明", items: ["OA-009"], summary: "有 1 页主题还没有贴标签：OA-009。" }];
    const list = hints(t, toc(t));
    expect(list.find((one) => one.key === "basis-UC-001")).toMatchObject({ go: { kind: "item", itemId: "UC-001" } });
    expect(list.find((one) => one.key === "unseen-D-001")).toMatchObject({ text: "D-001「借书流程」现在的内容你还没有看过。", go: { kind: "diagram", diagramId: "D-001" } });
    expect(list.find((one) => one.key === "hint-untagged_overall_pages")).toMatchObject({ text: "有 1 页主题还没有贴标签：OA-009。", go: { kind: "item", itemId: "OA-009" } });
    expect(list.filter((one) => one.key.startsWith("empty-")).every((one) => one.go?.kind === "chapter")).toBe(true);
    const calls = tab(t);
    fireEvent.click(screen.getByTestId("go-unseen-D-001"));
    expect(calls.go).toHaveBeenCalledWith({ kind: "diagram", diagramId: "D-001" });
  });
});

describe("「文档与版本」页签在条目区里", () => {
  function Panel({ t }: { t: Task }) {
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <ConfigProvider><AntApp><div className="app">
        <ItemsPanel task={t} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={selected} onSelect={setSelected}
          submit={vi.fn(async () => null)} onGenerateDoc={() => {}} onPublish={vi.fn(async () => null)} />
      </div></AntApp></ConfigProvider>
    );
  }
  afterEach(() => window.localStorage.clear());

  it("页签上写发布过几版，页头写「已发布第 N 版」；没有发布过写「还没有发布过」", () => {
    const t = ready({ versions: [{ version_no: 1, revision_no: 3, published_at: "", actor: "user", note: null, has_markdown: true, has_docx: true },
      { version_no: 2, revision_no: 9, published_at: "", actor: "user", note: null, has_markdown: true, has_docx: true }] } as unknown as Partial<Task>);
    const view = render(<Panel t={t} />);
    expect(screen.getByTestId("pane-docs").textContent).toBe("文档与版本2");
    fireEvent.click(screen.getByTestId("pane-docs"));
    expect(screen.getByTestId("docs-latest")).toHaveTextContent("已发布第 2 版");
    view.unmount();
    render(<Panel t={ready()} />);
    fireEvent.click(screen.getByTestId("pane-docs"));
    expect(screen.getByTestId("docs-latest")).toHaveTextContent("还没有发布过");
  });

  it("发布前检查里点「去补」：未解决的问题切到问题页签；评审没通过切到评审与确认页签", () => {
    const cond = (collection: string, name: string, missing: string[]) => ({ collection, name, met: false, state: "unmet", done: 0, total: 0, missing, note: "" });
    const t = overallTask({ completion: { all_met: false, unmet_count: 2, hints: [], conditions: [
      cond("功能用例", "每个条目评审通过", ["UC-002"]), cond("问题", "没有状态为未解决的条目", ["TBD-001"])] } } as unknown as Partial<Task>);
    render(<Panel t={t} />);
    fireEvent.click(screen.getByTestId("pane-docs"));
    fireEvent.click(screen.getByTestId("go-问题/没有状态为未解决的条目"));
    expect(screen.getByTestId("pane-issues")).toHaveClass("on");
    expect(screen.getByTestId("item-TBD-001")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pane-docs"));
    fireEvent.click(screen.getByTestId("go-功能用例/每个条目评审通过"));
    expect(screen.getByTestId("pane-review")).toHaveClass("on");
  });
});
