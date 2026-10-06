// 知识库页面：知识库的清单与选中的知识库的文档表格；通用知识库不能改名、不能删除；新建与改名；删除知识库、删除文档先确认；
// 上传时带上先选好的种类；类型不符或超过 20 MB 不发请求；左侧栏在服务有知识库时有「知识库」入口。
// 文档的换算：每份文档的换算状态、这个知识库「已换算几份 / 一共几份」与进度条、「开始换算」与「重试」、停下的原因、
// 没有选嵌入模型时的提示；有文档在等待换算或者换算中时隔一会儿自动再取一次清单。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api, ApiError } from "../api/client";
import type { DocumentEmbedding, EmbeddedLibrary, KnowledgeEmbedding, KnowledgeOverview, ServiceInfo } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { embeddingPolling } from "../model/knowledge";
import { KnowledgePage } from "../pages/KnowledgePage";
import { parseRoute } from "../router";

const POLL_MS = embeddingPolling.intervalMs;
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.location.hash = ""; embeddingPolling.intervalMs = POLL_MS; });

const info: ServiceInfo = {
  ok: true, app: "taskwright", version: "0.4.1", mode: "server", pid: 1, port: 8950, capabilities: { exit: false, model: true, knowledge: true },
  knowledge_upload: { max_bytes: 20 * 1024 * 1024, too_large_text: "单个文件不能超过 20 MB。", extensions: [".md", ".txt", ".docx"], types_text: ".md、.txt 与 Word 的 .docx",
    unsupported_type_text: "只接受 .md、.txt 与 Word 的 .docx 文件。",
    kinds: [{ kind: "standard", name: "规范" }, { kind: "glossary", name: "术语表" }, { kind: "template", name: "模板" }, { kind: "past_work", name: "以往的成果" }, { kind: "other", name: "其他" }] },
};
const MODEL = "taskwright-ollama-embedding/bge-m3";
/** 一份文档的换算状态：只写与「未换算」不同的项。 */
const state = (given: Partial<DocumentEmbedding> = {}): DocumentEmbedding => ({ status: "none", model: null, error: null, done: null, total: null, ...given });
const NONE: KnowledgeEmbedding = { model: null, running: false, ready: false, pending: 1, total: 1, stopped_reason: null };
const LIBS: EmbeddedLibrary[] = [
  { id: "general", name: "通用知识库", created_at: "", used_by_tasks: 3, embedding: { done: 0, total: 1 },
    documents: [{ name: "公司术语表.md", kind: "glossary", bytes: 2048, uploaded_at: "2026-09-29T10:12:00+08:00", embedding: state() }] },
  { id: "lib-hy", name: "行业规范", created_at: "", used_by_tasks: 2, embedding: { done: 0, total: 0 }, documents: [] },
];

/** 通用知识库里放这几份文档的清单；done 是其中换算好了几份。 */
function overviewOf(documents: [string, DocumentEmbedding][], embedding: Partial<KnowledgeEmbedding> = {}): KnowledgeOverview {
  const done = documents.filter(([, e]) => e.status === "done").length;
  return {
    libraries: [{ ...LIBS[0], embedding: { done, total: documents.length },
      documents: documents.map(([name, e]) => ({ name, kind: "standard" as const, bytes: 1024, uploaded_at: "2026-10-05T09:00:00+08:00", embedding: e })) }, LIBS[1]],
    embedding: { model: MODEL, running: false, ready: done === documents.length, pending: documents.length - done, total: documents.length, stopped_reason: null, ...embedding },
  };
}

function page(libraryId: string | null = null, overview: KnowledgeOverview | KnowledgeOverview[] = { libraries: LIBS, embedding: NONE }) {
  vi.spyOn(api, "serviceInfo").mockResolvedValue(info);
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "knowledge").mockResolvedValue(LIBS);
  // 给了几份清单时依次给出，给完之后一直给最后一份。
  const answers = Array.isArray(overview) ? [...overview] : [overview];
  const calls = {
    overview: vi.spyOn(api, "knowledgeOverview").mockImplementation(async () => (answers.length > 1 ? answers.shift()! : answers[0])),
    embed: vi.spyOn(api, "embedKnowledge").mockResolvedValue({ queued: 1, embedding: NONE }),
    create: vi.spyOn(api, "createLibrary").mockResolvedValue({ id: "lib-new", name: "新知识库", created_at: "" }),
    rename: vi.spyOn(api, "renameLibrary").mockResolvedValue({ library: { id: "lib-hy", name: "国家标准" } }),
    removeLib: vi.spyOn(api, "deleteLibrary").mockResolvedValue({ ok: true }),
    upload: vi.spyOn(api, "uploadDocument").mockResolvedValue({ name: "a.md", kind: "template", bytes: 1, uploaded_at: "" }),
    removeDoc: vi.spyOn(api, "deleteDocument").mockResolvedValue({ ok: true }),
  };
  render(<ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider><KnowledgePage libraryId={libraryId} /></ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
  return calls;
}

/** 标题是 title 的那个对话框里的主按钮（关掉的对话框可能还在页面上）。 */
const okButton = (title?: string) => {
  const modals = [...document.querySelectorAll(".ant-modal")].filter((m) => !title || m.textContent?.includes(title));
  return modals[modals.length - 1].querySelector(".ant-btn-primary") as HTMLButtonElement;
};

describe("知识库页面", () => {
  it("地址 #/knowledge 与 #/knowledge/{知识库编号}", () => {
    expect(parseRoute("#/knowledge")).toEqual({ page: "knowledge", libraryId: null });
    expect(parseRoute("#/knowledge/lib-hy")).toEqual({ page: "knowledge", libraryId: "lib-hy" });
  });

  it("左边列出知识库，通用知识库排第一并标「默认选用」；缺省选中通用知识库，表格列出文档名、种类、大小、上传时间；通用知识库没有改名与删除", async () => {
    page();
    const list = await screen.findByTestId("kb-libraries");
    expect(within(list).getByTestId("kb-lib-general").textContent).toBe("通用知识库默认选用1 份文档 · 每个任务都会用到");
    expect(within(list).getByTestId("kb-lib-lib-hy").textContent).toBe("行业规范0 份文档 · 2 个任务在用");
    const pane = screen.getByTestId("kb-pane");
    expect(within(pane).getByText("1 份文档。每个任务都会用到。新建的任务会自动选用它，也不能去掉。")).toBeTruthy();
    const cells = [...within(screen.getByTestId("kb-documents")).getAllByRole("cell")].map((c) => c.textContent);
    expect(cells.slice(0, 3)).toEqual(["公司术语表.md", "术语表", "2.0 KB"]);
    expect(within(pane).queryByText("改名")).toBeNull();
    expect(screen.queryByTestId("kb-delete-library")).toBeNull();
    expect(screen.getByTestId("kb-upload-hint").textContent).toBe("把文件拖到这里，或者点这里选择文件，放进「通用知识库」（只接受 .md、.txt 与 Word 的 .docx，单个文件不超过 20 MB；PDF 暂时不接受，下一版起支持）。");
    expect(screen.getByText(/^文档没有版本：一份文档改了，就当作一份新文件上传。/)).toBeTruthy();
  });

  it("新建一个知识库：填名字之后调新建接口", async () => {
    const calls = page();
    fireEvent.click(await screen.findByTestId("kb-new-library"));
    expect(okButton().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("kb-name-input"), { target: { value: "新知识库" } });
    fireEvent.click(okButton());
    await waitFor(() => expect(calls.create).toHaveBeenCalledWith("新知识库"));
  });

  it("别的知识库：改名、删除这个知识库（确认框写明文档一并删除、选用它的任务自动不再选用）", async () => {
    const calls = page("lib-hy");
    const pane = await screen.findByTestId("kb-pane");
    fireEvent.click(within(pane).getByText("改名"));
    fireEvent.change(screen.getByTestId("kb-name-input"), { target: { value: "国家标准" } });
    fireEvent.click(okButton());
    await waitFor(() => expect(calls.rename).toHaveBeenCalledWith("lib-hy", "国家标准"));
    fireEvent.click(screen.getByTestId("kb-delete-library"));
    expect(await screen.findByText("这个知识库里的 0 份文档会一并删除。选用了这个知识库的任务会自动不再选用它。")).toBeTruthy();
    fireEvent.click(okButton("删除知识库「行业规范」？"));
    await waitFor(() => expect(calls.removeLib).toHaveBeenCalledWith("lib-hy"));
  });

  it("删除文档先确认；确定之后调删除接口", async () => {
    const calls = page();
    fireEvent.click(within(await screen.findByTestId("kb-documents")).getByText("删除"));
    expect(await screen.findByText("删除文档《公司术语表.md》？")).toBeTruthy();
    fireEvent.click(okButton());
    await waitFor(() => expect(calls.removeDoc).toHaveBeenCalledWith("general", "公司术语表.md"));
  });

  it("上传带上先选好的种类；选择框按后端给的类型过滤；超过 20 MB 的不发请求", async () => {
    const calls = page();
    await screen.findByTestId("kb-kind");
    fireEvent.click(screen.getByText("模板", { selector: ".updest-seg label" }));
    const input = document.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "检查单.md", { type: "text/markdown" })] } });
    await waitFor(() => expect(calls.upload).toHaveBeenCalledTimes(1));
    expect(calls.upload.mock.calls[0][0]).toBe("general");
    expect(calls.upload.mock.calls[0][2]).toBe("template");
    expect(input).toHaveAttribute("accept", ".md,.txt,.docx");
    const big = new File([new Uint8Array(21 * 1024 * 1024)], "大.md", { type: "text/markdown" });
    fireEvent.change(document.querySelector("input[type=file]")!, { target: { files: [big] } });
    expect(await screen.findByText("单个文件不能超过 20 MB。")).toBeTruthy();
    expect(calls.upload).toHaveBeenCalledTimes(1);
  });

  it("左侧栏：「任务」下面有「知识库」入口，写着有几个知识库，当前页面是它时高亮", async () => {
    page();
    const entry = await screen.findByTestId("nav-knowledge");
    await waitFor(() => expect(entry.textContent).toBe("知识库2 个知识库"));
    expect(entry.className).toContain("on");
    expect(screen.getByTestId("nav-tasks").className).not.toContain("on");
  });

  it("没有选嵌入模型：表格上面写明这些文档没有换算、只能按字面查找，给去设置的链接；文档都是「未换算」；没有「开始换算」", async () => {
    page();
    const line = await screen.findByTestId("kb-embedding");
    expect(line.textContent).toBe("还没有选嵌入模型，这些文档没有换算，只能按字面查找。去设置里选");
    expect(within(line).getByText("去设置里选").getAttribute("href")).toBe("#/settings/models");
    expect(screen.getByTestId("kb-doc-embedding-公司术语表.md").textContent).toBe("未换算");
    expect(screen.queryByTestId("kb-embed-start")).toBeNull();
    expect([...within(screen.getByTestId("kb-documents")).getAllByRole("columnheader")].map((c) => c.textContent)).toEqual(["文档名", "种类", "大小", "上传时间", "换算", "操作"]);
  });

  it("没有文档的知识库不写换算的那一行", async () => {
    page("lib-hy");
    await screen.findByTestId("kb-pane");
    expect(screen.queryByTestId("kb-embedding")).toBeNull();
  });

  it("选了嵌入模型：写「已换算 N / M」、进度条与嵌入模型的型号；文档各写各的状态，换算失败的带原因；「开始换算」只换算这个知识库，之后重新取清单", async () => {
    const calls = page(null, overviewOf([
      ["规则.md", state({ status: "done", model: MODEL, done: 5, total: 5 })],
      ["长文.txt", state({ status: "failed", model: MODEL, error: "模型服务回答了错误（HTTP 500）：the input length exceeds the context length" })],
      ["说明.txt", state()],
      ["空白.txt", state({ status: "done", model: MODEL, done: 0, total: 0 })],
    ]));
    const line = await screen.findByTestId("kb-embedding");
    expect(screen.getByTestId("kb-embedding-count").textContent).toBe("已换算 2 / 4");
    const bar = within(line).getByRole("progressbar");
    expect([bar.getAttribute("aria-valuenow"), bar.getAttribute("aria-valuemax"), (bar.firstElementChild as HTMLElement).style.width]).toEqual(["2", "4", "50%"]);
    expect(line.textContent).toBe("已换算 2 / 4嵌入模型：bge-m3开始换算");
    expect(screen.getByTestId("kb-doc-embedding-规则.md").textContent).toBe("已换算");
    expect(screen.getByTestId("kb-doc-embedding-长文.txt").textContent).toBe("换算失败重试模型服务回答了错误（HTTP 500）：the input length exceeds the context length");
    expect(screen.getByTestId("kb-doc-embedding-说明.txt").textContent).toBe("未换算");
    expect(screen.getByTestId("kb-doc-embedding-空白.txt").textContent).toBe("没有文字，不用换算");
    expect(screen.queryByTestId("kb-embedding-stopped")).toBeNull();

    fireEvent.click(screen.getByTestId("kb-embed-start"));
    await waitFor(() => expect(calls.embed).toHaveBeenCalledWith({ library: "general" }));
    await waitFor(() => expect(calls.overview).toHaveBeenCalledTimes(2));
  });

  it("换算失败的文档：「重试」只换算这一份", async () => {
    const calls = page(null, overviewOf([["长文.txt", state({ status: "failed", model: MODEL, error: "模型服务回答的数字串全是 0，没法用。" })]]));
    fireEvent.click(within(await screen.findByTestId("kb-doc-embedding-长文.txt")).getByText("重试"));
    await waitFor(() => expect(calls.embed).toHaveBeenCalledWith({ library: "general", name: "长文.txt" }));
  });

  it("换算中：文档写「换算中（算完几个 / 一共几个）」与「等待换算」，没有「开始换算」；隔一会儿自动再取清单，都换算好了就不再取", async () => {
    embeddingPolling.intervalMs = 20;
    const during = overviewOf([["长文.txt", state({ status: "running", model: MODEL, done: 32, total: 40 })], ["规则.md", state({ status: "queued" })]], { running: true });
    const after = overviewOf([["长文.txt", state({ status: "done", model: MODEL, done: 40, total: 40 })], ["规则.md", state({ status: "done", model: MODEL, done: 5, total: 5 })]]);
    const calls = page(null, [during, during, after]);
    expect((await screen.findByTestId("kb-doc-embedding-长文.txt")).textContent).toBe("换算中（32 / 40）");
    expect(screen.getByTestId("kb-doc-embedding-规则.md").textContent).toBe("等待换算");
    expect(screen.getByTestId("kb-embedding-count").textContent).toBe("已换算 0 / 2");
    expect(screen.queryByTestId("kb-embed-start")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("kb-embedding-count").textContent).toBe("已换算 2 / 2"));
    expect(calls.overview).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("kb-embed-start")).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.overview).toHaveBeenCalledTimes(3);
  });

  it("还没有切好片段时只写「换算中」；自动取的那一次没取到时页面照旧，不换成报错", async () => {
    embeddingPolling.intervalMs = 20;
    const during = overviewOf([["长文.txt", state({ status: "running", model: MODEL, done: 0, total: null })]], { running: true });
    const calls = page(null, during);
    expect((await screen.findByTestId("kb-doc-embedding-长文.txt")).textContent).toBe("换算中");
    calls.overview.mockRejectedValue(new Error("网络断了"));
    await waitFor(() => expect(calls.overview.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.getByTestId("kb-doc-embedding-长文.txt").textContent).toBe("换算中");
  });

  it("整个换算停下了：写明停下的原因，「开始换算」还在", async () => {
    page(null, overviewOf([["规则.md", state()]], { stopped_reason: "连不上这个模型服务。请确认它已经启动，地址与端口没有写错。" }));
    expect((await screen.findByTestId("kb-embedding-stopped")).textContent).toBe("换算停下了：连不上这个模型服务。请确认它已经启动，地址与端口没有写错。");
    expect(screen.getByTestId("kb-embed-start")).toBeTruthy();
  });

  it("开始换算没有做成：给出后端的那句话", async () => {
    const calls = page(null, overviewOf([["规则.md", state()]]));
    calls.embed.mockRejectedValue(new ApiError("rejected", "还没有选嵌入模型。", 422));
    fireEvent.click(await screen.findByTestId("kb-embed-start"));
    expect(await screen.findByText("还没有选嵌入模型。")).toBeTruthy();
  });
});
