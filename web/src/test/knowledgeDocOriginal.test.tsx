// 知识库里的 PDF 与 Word 文档按原样显示：点来源的出处、在知识库页面点「查看」，都交给材料一侧同一套显示部件（这里换成替身，记下收到的参数），
// 由文档生成的文字版不显示；原件打不开时只写一句「这份文档现在打不开。」。两份缓存按所属从知识库的接口读。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type { EmbeddedLibrary, KnowledgeLibrary, ServiceInfo } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { CANNOT_OPEN, KnowledgeDocModal } from "../components/work/KnowledgeDocModal";
import type { LocateRequest } from "../components/work/MaterialPane";
import { KnowledgePage } from "../pages/KnowledgePage";
import { fileRaw, fileRawUrl, fileText, knowledgeOwner } from "../state/docSource";

type PaperProps = { taskId: string; path: string; locate: LocateRequest | null; onNote?: (text: string | null) => void; onUnavailable?: (off: boolean) => void };
const pdf = vi.fn((_props: PaperProps) => null);
const word = vi.fn((_props: PaperProps) => null);
const stub = (testId: string, record: (props: PaperProps) => void) => (props: PaperProps) => {
  record(props);
  return (
    <div data-testid={testId}>
      <button type="button" onClick={() => props.onUnavailable?.(true)}>显示不出来</button>
      <button type="button" onClick={() => props.onNote?.("这段引用跨越了多个段落，已整段标出。")}>写一句</button>
    </div>
  );
};
vi.mock("../components/work/PdfPaper", () => ({ PdfPaper: (props: PaperProps) => stub("pdf-paper-stub", pdf)(props) }));
vi.mock("../components/work/DocxPaper", () => ({ DocxPaper: (props: PaperProps) => stub("docx-paper-stub", word)(props) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); pdf.mockClear(); word.mockClear(); });

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const doc = (name: string) => ({ name, kind: "standard" as const, bytes: 10, uploaded_at: "" });
const LIBRARIES: KnowledgeLibrary[] = [{ id: "lib-a1", name: "行业规范", created_at: "", used_by_tasks: 1, documents: [doc("安全要求.pdf"), doc("规范.docx")] }];
const open = (locator: string, excerpt: string) =>
  render(<Wrap><KnowledgeDocModal request={{ locator, excerpt }} libraries={LIBRARIES} onClose={() => {}} /></Wrap>);

describe("知识库来源的出处打开原始文档", () => {
  it("PDF 文档交给 PdfPaper：所属是这个知识库，出处带着页与块交过去，按它跳到第 5 页；不读文字版", async () => {
    const documentText = vi.spyOn(api, "documentText");
    open("knowledge/lib-a1/安全要求.pdf#p5-2", "智能体应当记录每一次工具调用。");
    expect(await screen.findByText("行业规范 / 安全要求.pdf")).toBeTruthy();
    expect(screen.getByTestId("pdf-paper-stub")).toBeTruthy();
    const props = pdf.mock.calls.at(-1)![0];
    expect([props.taskId, props.path, props.locate?.locator, props.locate?.excerpt])
      .toEqual(["knowledge/lib-a1", "安全要求.pdf", "knowledge/lib-a1/安全要求.pdf#p5-2", "智能体应当记录每一次工具调用。"]);
    expect(screen.queryByTestId("docx-paper-stub")).toBeNull();
    expect(screen.getByTestId("kb-doc").querySelector(".kbdoc-text")).toBeNull();
    expect(documentText).not.toHaveBeenCalled();
  });

  it("Word 文档交给 DocxPaper 按原版式显示，出处带着段落号交过去，按它滚到第 12 段；定位的提示写在上面", async () => {
    const documentText = vi.spyOn(api, "documentText");
    open("knowledge/lib-a1/规范.docx#p12", "退款在 3 个工作日内到账。");
    expect(await screen.findByTestId("docx-paper-stub")).toBeTruthy();
    const props = word.mock.calls.at(-1)![0];
    expect([props.taskId, props.path, props.locate?.locator, props.locate?.excerpt])
      .toEqual(["knowledge/lib-a1", "规范.docx", "knowledge/lib-a1/规范.docx#p12", "退款在 3 个工作日内到账。"]);
    expect(documentText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("写一句"));
    expect(screen.getByTestId("kb-doc-note").textContent).toBe("这段引用跨越了多个段落，已整段标出。");
  });

  it("原件读不到或画不出来时只写「这份文档现在打不开。」，不退回文字版", async () => {
    const documentText = vi.spyOn(api, "documentText");
    open("knowledge/lib-a1/规范.docx#p12", "退款在 3 个工作日内到账。");
    fireEvent.click(await screen.findByText("显示不出来"));
    expect(screen.getByTestId("kb-doc-error").textContent).toBe(CANNOT_OPEN);
    expect(documentText).not.toHaveBeenCalled();
  });

  it("所属是知识库时两份缓存从知识库的接口读，是任务编号时照旧读材料", async () => {
    const raw = vi.spyOn(api, "documentRaw").mockResolvedValue(new ArrayBuffer(1));
    const text = vi.spyOn(api, "documentText").mockResolvedValue({ name: "x.pdf.locations.json", text: "{}" });
    const material = vi.spyOn(api, "materialRaw").mockResolvedValue(new ArrayBuffer(2));
    await fileRaw(knowledgeOwner("lib-a1"), "安全要求.pdf");
    await fileText(knowledgeOwner("lib-a1"), "安全要求.pdf.locations.json");
    await fileRaw("TASK-1", "inputs/a.pdf");
    expect(raw).toHaveBeenCalledWith("lib-a1", "安全要求.pdf");
    expect(text).toHaveBeenCalledWith("lib-a1", "安全要求.pdf.locations.json");
    expect(material).toHaveBeenCalledWith("TASK-1", "inputs/a.pdf");
    expect(fileRawUrl(knowledgeOwner("lib-a1"), "安全要求.pdf")).toBe("/api/v1/knowledge/libraries/lib-a1/documents/raw?name=%E5%AE%89%E5%85%A8%E8%A6%81%E6%B1%82.pdf");
  });
});

describe("知识库页面的「查看」", () => {
  const info: ServiceInfo = { ok: true, app: "taskwright", version: "0.6.0", mode: "server", pid: 1, port: 8950, capabilities: { exit: false, model: true, knowledge: true } } as ServiceInfo;
  const LIBS: EmbeddedLibrary[] = [{
    id: "lib-a1", name: "行业规范", created_at: "", used_by_tasks: 0, embedding: { done: 0, total: 2 },
    documents: [{ ...doc("安全要求.pdf"), embedding: { status: "none", model: null, error: null, done: null, total: null } },
      { ...doc("规范.docx"), embedding: { status: "none", model: null, error: null, done: null, total: null } }],
  }];

  it("文档表每一行有「查看」：PDF 与 Word 按原样分页显示，从头看，不定位，不读文字版", async () => {
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info);
    vi.spyOn(api, "listTasks").mockResolvedValue([]);
    vi.spyOn(api, "knowledgeOverview").mockResolvedValue({ libraries: LIBS, embedding: { model: null, running: false, ready: false, pending: 2, total: 2, stopped_reason: null } });
    const documentText = vi.spyOn(api, "documentText");
    render(<Wrap><ToastProvider><ServiceProvider><KnowledgePage libraryId="lib-a1" /></ServiceProvider></ToastProvider></Wrap>);
    fireEvent.click(await screen.findByTestId("kb-doc-view-安全要求.pdf"));
    await waitFor(() => expect(screen.getByTestId("pdf-paper-stub")).toBeTruthy());
    expect(pdf.mock.calls.at(-1)![0]).toMatchObject({ taskId: "knowledge/lib-a1", path: "安全要求.pdf", locate: null });
    expect(screen.getByText("行业规范 / 安全要求.pdf")).toBeTruthy();
    fireEvent.click(screen.getByTestId("kb-doc-view-规范.docx"));
    await waitFor(() => expect(screen.getByTestId("docx-paper-stub")).toBeTruthy());
    expect(word.mock.calls.at(-1)![0]).toMatchObject({ taskId: "knowledge/lib-a1", path: "规范.docx", locate: null });
    expect(documentText).not.toHaveBeenCalled();
  });
});
