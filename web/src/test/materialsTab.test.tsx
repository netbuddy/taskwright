// 工作台中栏按需求资产分的六个页签：顶上一排的名字与数、点了停在哪里并记住；「输入资料」页签的两张表与上面的操作。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { KnowledgeLibrary, Material, Task, TaskDetail } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { MATERIALS_LEAD, MaterialsTab } from "../components/work/MaterialsTab";
import { ENTERED_REPLACE_HINT } from "../components/task/MaterialsCard";
import { citationText, materialCitations, materialKind, paneCount } from "../model/assetTabs";
import { readTab } from "../model/itemsTab";
import { formatTimeShort } from "../model/format";
import { ToastProvider } from "../components/Toasts";
import { overallTask } from "./fixtures/overallTask";

afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); });
Element.prototype.scrollTo ??= function () {};

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider>{children}</ToastProvider></AntApp></ConfigProvider>
);
const RULES = "inputs/借阅规则.md";
const material = (path: string, over: Partial<Material> = {}): Material =>
  ({ path, bytes: 2048, modified_at: "2026-10-12T17:20:00", derived_from: null, deletable: false, ...over });
const MATERIALS = [material(RULES), material("inputs/旧系统说明.docx", { deletable: true, bytes: 30000 }), material("inputs/旧系统说明.docx.md", { derived_from: "inputs/旧系统说明.docx" })];
const lib = (id: string, name: string, docs: number): KnowledgeLibrary =>
  ({ id, name, created_at: "", used_by_tasks: 1, documents: Array.from({ length: docs }, (_, i) => ({ name: `d${i}.md`, kind: "other", bytes: 1, uploaded_at: "" })) });
const LIBS = [lib("general", "通用知识库", 12), lib("lib-hy", "图书馆行业规范", 5), lib("lib-x", "没有选用的库", 1)];

function detailOf(task: Task, knowledge = ["general", "lib-hy"]): TaskDetail {
  return { ...task, materials: MATERIALS, sessions: [], knowledge_libraries: knowledge } as TaskDetail;
}
/** 一个知识库来源：出处写成 knowledge/库编号/文档名。 */
function withKnowledgeSource(task: Task): Task {
  task.items.find((one) => one.item_id === "OA-002")!.sources.push({ kind: "知识库", locator: "knowledge/lib-hy/d0.md", excerpt: "逾期费" });
  return task;
}

function Panel({ t, libraries = LIBS }: { t: Task; libraries?: KnowledgeLibrary[] | null }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Wrap><div className="app">
      <ItemsPanel task={t} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={selected} onSelect={setSelected}
        submit={vi.fn(async () => null)} onGenerateDoc={() => {}} materials={MATERIALS} info={null} libraries={libraries} onViewMaterial={vi.fn()} />
    </div></Wrap>
  );
}

describe("顶上一排页签", () => {
  it("名字照需求资产六类，任务定义有问题集合时需求条目后面多一个问题；数：材料几份（文字版不算）、业务说明几节、分析模型几张、需求条目几条（问题条目不算）、问题几条未解决（已解决的不算）、发布过几版；评审与确认不写数", () => {
    const t = overallTask();
    vi.spyOn(api, "getTask").mockResolvedValue(detailOf(t));
    render(<Panel t={t} />);
    expect([...document.querySelectorAll("[data-testid=asset-tabs] .itab")].map((one) => one.textContent))
      .toEqual(["输入资料2", "业务说明11", "分析模型0", "需求条目3", "问题3", "评审与确认", "文档与版本0"]);
    expect(t.items.filter((one) => one.collection === "问题").length).toBe(4);
    expect(screen.getByTestId("pane-issues").querySelector(".cnt")).toHaveClass("open");
    const published = overallTask({ versions: [{ version_no: 2 }, { version_no: 1 }] as unknown as Task["versions"] });
    expect(paneCount("docs", published, [])).toBe("2");
  });

  it("点「输入资料」：停在那一页，没有集合的子页签与筛选；记下来，下次打开这个任务实例回到那里；回到需求条目页签，子页签一行回来", async () => {
    const t = overallTask();
    vi.spyOn(api, "getTask").mockResolvedValue(detailOf(t));
    const first = render(<Panel t={t} />);
    fireEvent.click(screen.getByTestId("pane-materials"));
    expect(screen.getByTestId("pane-materials")).toHaveClass("on");
    expect(await screen.findByTestId("materials-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("item-tabs")).toBeNull();
    expect(document.querySelectorAll(".filt").length).toBe(0);
    expect(screen.getByTestId("progress")).toBeInTheDocument();
    expect(readTab(t.task_id)).toBe("@materials");
    first.unmount();
    render(<Panel t={overallTask()} />);
    expect(screen.getByTestId("pane-materials")).toHaveClass("on");
    // 回到需求条目页签：集合的子页签一行回来。
    fireEvent.click(screen.getByTestId("pane-items"));
    expect(screen.getByTestId("pane-items")).toHaveClass("on");
    expect(screen.getByTestId("item-tabs")).toBeInTheDocument();
  });
});

describe("「输入资料」页签", () => {
  it("输入资料一张表：名称、类型、大小、上传时刻、被几节几处引用；由别的材料生成的文字版不列；页上一句说明", async () => {
    const t = overallTask();
    vi.spyOn(api, "getTask").mockResolvedValue(detailOf(t));
    render(<Wrap><div className="app"><MaterialsTab task={t} materials={MATERIALS} info={null} libraries={LIBS} readOnly={false} onView={vi.fn()} /></div></Wrap>);
    await waitFor(() => expect(screen.getAllByTestId("materials-row")).toHaveLength(2));
    expect(screen.getByTestId("materials-tab")).toHaveTextContent(MATERIALS_LEAD);
    const rows = screen.getAllByTestId("materials-row").map((row) => [...row.querySelectorAll("td")].slice(0, 5).map((td) => td.textContent));
    const at = formatTimeShort("2026-10-12T17:20:00");
    expect(rows).toEqual([["借阅规则.md", "Markdown", "2.0 KB", at, "5 节 · 6 处"], ["旧系统说明.docx", "Word", "29.3 KB", at, "还没有被引用"]]);
    expect(screen.getByTestId("materials-count")).toHaveTextContent("2 份");
    expect([materialKind("a.pdf"), materialKind("a.txt"), materialKind("a.csv")]).toEqual(["PDF", "纯文本", "CSV"]);
    expect(citationText(materialCitations(t, MATERIALS, "inputs/旧系统说明.docx"))).toBe("还没有被引用");
  });

  it("「查看」交给工作台（在右侧栏原文定位里打开）；没有进入对话的材料能替换、删除，进入了的「替换」是灰的并说明原因", async () => {
    const t = overallTask();
    vi.spyOn(api, "getTask").mockResolvedValue(detailOf(t));
    const onView = vi.fn();
    render(<Wrap><div className="app"><MaterialsTab task={t} materials={MATERIALS} info={null} libraries={LIBS} readOnly={false} onView={onView} /></div></Wrap>);
    await waitFor(() => expect(screen.getAllByTestId("materials-row")).toHaveLength(2));
    const [rules, old] = screen.getAllByTestId("materials-row");
    fireEvent.click(within(rules).getByTestId("materials-view"));
    expect(onView).toHaveBeenCalledWith(RULES);
    expect(within(rules).getByTestId("materials-replace-off")).toHaveAttribute("title", ENTERED_REPLACE_HINT);
    expect(within(rules).queryByTestId("materials-delete")).toBeNull();
    const remove = vi.spyOn(api, "deleteMaterial").mockResolvedValue({ ok: true, path: "inputs/旧系统说明.docx" });
    fireEvent.click(within(old).getByTestId("materials-delete"));
    await screen.findByText("删除输入资料《旧系统说明.docx》？");
    fireEvent.click(within(document.querySelector(".ant-modal") as HTMLElement).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(t.task_id, "inputs/旧系统说明.docx"));
    expect(screen.getByTestId("materials-upload")).toHaveTextContent("上传输入资料");
  });

  it("选用的知识库一张表：文档份数、本项目引用几处、每个都可以「取消选用」；表下「选用别的知识库」；没有知识库这一功能时整块不显示", async () => {
    const t = withKnowledgeSource(overallTask());
    vi.spyOn(api, "getTask").mockResolvedValue(detailOf(t));
    const select = vi.spyOn(api, "setTaskKnowledge").mockImplementation(async (_t, ids) => ids);
    const view = render(<Wrap><div className="app"><MaterialsTab task={t} materials={MATERIALS} info={null} libraries={LIBS} readOnly={false} onView={vi.fn()} /></div></Wrap>);
    await screen.findByTestId("knowledge-row-lib-hy");
    const cells = (id: string) => [...screen.getByTestId(`knowledge-row-${id}`).querySelectorAll("td")].slice(0, 3).map((td) => td.textContent);
    expect(cells("general")).toEqual(["通用知识库", "12 份文档", "还没有被引用"]);
    expect(cells("lib-hy")).toEqual(["图书馆行业规范", "5 份文档", "1 处"]);
    expect(screen.queryByTestId("knowledge-row-lib-x")).toBeNull();
    expect(screen.getByTestId("knowledge-drop-general")).toBeTruthy();
    fireEvent.click(screen.getByTestId("knowledge-drop-lib-hy"));
    await waitFor(() => expect(select).toHaveBeenCalledWith(t.task_id, ["general"]));
    expect(screen.getByTestId("kb-pick")).toHaveClass("btn");
    view.unmount();
    render(<Wrap><div className="app"><MaterialsTab task={t} materials={MATERIALS} info={null} readOnly={false} onView={vi.fn()} /></div></Wrap>);
    await waitFor(() => expect(screen.getAllByTestId("materials-row")).toHaveLength(2));
    expect(screen.queryByTestId("materials-knowledge")).toBeNull();
  });
});
