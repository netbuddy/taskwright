// 知识库页面：知识库的清单与选中的知识库的文档表格；通用知识库不能改名、不能删除；新建与改名；删除知识库、删除文档先确认；
// 上传时带上先选好的种类；类型不符或超过 20 MB 不发请求；左侧栏在服务有知识库时有「知识库」入口。
// 文档的向量化：每份文档的向量化状态、这个知识库「已向量化几份 / 一共几份」与进度条、「开始向量化」与「重试」、停下的原因、
// 没有选嵌入模型时的提示；有文档在等待向量化或者向量化中时隔一会儿自动再取一次清单。
// 试一试按意思查找：只查选中的这一个知识库；文档没有都向量化或者没有选嵌入模型时不能查；查到的片段怎样列。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api, ApiError } from "../api/client";
import type { DocumentEmbedding, EmbeddedLibrary, KnowledgeEmbedding, KnowledgeOverview, KnowledgeSearchHit, KnowledgeSearchResult, ServiceInfo } from "../api/types";
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
/** 一份文档的向量化状态：只写与「未向量化」不同的项。 */
const state = (given: Partial<DocumentEmbedding> = {}): DocumentEmbedding => ({ status: "none", model: null, error: null, done: null, total: null, ...given });
const NONE: KnowledgeEmbedding = { model: null, running: false, ready: false, pending: 1, total: 1, stopped_reason: null };
const LIBS: EmbeddedLibrary[] = [
  { id: "general", name: "通用知识库", created_at: "", used_by_tasks: 3, embedding: { done: 0, total: 1 },
    documents: [{ name: "公司术语表.md", kind: "glossary", bytes: 2048, uploaded_at: "2026-09-29T10:12:00+08:00", embedding: state() }] },
  { id: "lib-hy", name: "行业规范", created_at: "", used_by_tasks: 2, embedding: { done: 0, total: 0 }, documents: [] },
];

/** 通用知识库里放这几份文档的清单；done 是其中向量化完成几份。 */
function overviewOf(documents: [string, DocumentEmbedding][], embedding: Partial<KnowledgeEmbedding> = {}): KnowledgeOverview {
  const done = documents.filter(([, e]) => e.status === "done").length;
  return {
    libraries: [{ ...LIBS[0], embedding: { done, total: documents.length },
      documents: documents.map(([name, e]) => ({ name, kind: "standard" as const, bytes: 1024, uploaded_at: "2026-10-05T09:00:00+08:00", embedding: e })) }, LIBS[1]],
    embedding: { model: MODEL, running: false, ready: done === documents.length, pending: documents.length - done, total: documents.length, stopped_reason: null, ...embedding },
  };
}

const hit = (given: Partial<KnowledgeSearchHit>): KnowledgeSearchHit => ({
  score: 0.5, library: "general", library_name: "通用知识库", name: "借阅规范.md", kind: "standard", title: null,
  first_paragraph: null, last_paragraph: null, first_line: null, last_line: null, text: "", locator: "knowledge/general/借阅规范.md", ...given,
});
/** 查到三个片段：一个 Markdown 的带标题与行号，一个 Word 文档的带段落号，一个没有标题、只占一行。 */
const FOUND: KnowledgeSearchResult = {
  ready: true, model: MODEL, pending: 0, libraries: 1, chunks: 37, hits: [
    hit({ score: 0.7136, title: "借阅规范 / 逾期", first_line: 31, last_line: 35, text: "第 4.2 条　逾期归还的，每册每天收取罚款 0.2 元。\n单册罚款累计不超过该书定价。" }),
    hit({ score: 0.63, name: "需求说明.docx", title: "3.1.1 逾期罚款", first_paragraph: 75, last_paragraph: 78, text: "逾期罚款" }),
    hit({ score: 0.2, name: "术语表.txt", first_line: 7, last_line: 7, text: "逾期：过了应还日期还没有归还。" }),
  ],
};
/** 按一下回车：输入框按下回车后要等抬起才认下一次，所以按下与抬起都发。 */
const pressEnter = (input: HTMLElement) => {
  fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
  fireEvent.keyUp(input, { key: "Enter", code: "Enter", keyCode: 13 });
};
const EMBEDDED = () => overviewOf([["借阅规范.md", state({ status: "done", model: MODEL, done: 12, total: 12 })]]);

function page(libraryId: string | null = null, overview: KnowledgeOverview | KnowledgeOverview[] = { libraries: LIBS, embedding: NONE }) {
  vi.spyOn(api, "serviceInfo").mockResolvedValue(info);
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "knowledge").mockResolvedValue(LIBS);
  // 给了几份清单时依次给出，给完之后一直给最后一份。
  const answers = Array.isArray(overview) ? [...overview] : [overview];
  const calls = {
    overview: vi.spyOn(api, "knowledgeOverview").mockImplementation(async () => (answers.length > 1 ? answers.shift()! : answers[0])),
    embed: vi.spyOn(api, "embedKnowledge").mockResolvedValue({ queued: 1, embedding: NONE }),
    search: vi.spyOn(api, "searchKnowledge").mockResolvedValue(FOUND),
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

  it("左边列出知识库，照后端给的先后，没有「默认选用」；缺省选中第一个，表格列出文档名、种类、大小、上传时间；升级留下的通用知识库与别的库一样可以改名、删除", async () => {
    page();
    const list = await screen.findByTestId("kb-libraries");
    expect(within(list).getByTestId("kb-lib-general").textContent).toBe("通用知识库1 份文档 · 3 个任务实例在用");
    expect(within(list).getByTestId("kb-lib-lib-hy").textContent).toBe("行业规范0 份文档 · 2 个任务实例在用");
    expect(screen.queryByText("默认选用")).toBeNull();
    const pane = screen.getByTestId("kb-pane");
    expect(within(pane).getByText("1 份文档。3 个任务实例在用。")).toBeTruthy();
    const cells = [...within(screen.getByTestId("kb-documents")).getAllByRole("cell")].map((c) => c.textContent);
    expect(cells.slice(0, 3)).toEqual(["公司术语表.md", "术语表", "2.0 KB"]);
    expect(within(pane).getByText("改名")).toBeTruthy();
    expect(screen.getByTestId("kb-delete-library")).toBeTruthy();
    expect(screen.getByTestId("kb-upload-hint").textContent).toBe("把文件拖到这里，或者点这里选择文件，放进「通用知识库」（只接受 .md、.txt 与 Word 的 .docx，单个文件不超过 20 MB）。");
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
    expect(await screen.findByText("这个知识库里的 0 份文档会一并删除。选用了这个知识库的任务实例会自动不再选用它。")).toBeTruthy();
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

  it("左边导航栏：参考一段的「知识库」一行写着几个库几份文档，当前页面是它时高亮；「任务实例列表」不高亮", async () => {
    page();
    const entry = await screen.findByTestId("nav-knowledge");
    await waitFor(() => expect(entry.textContent).toMatch(/^知识库2 库 \d+ 份$/));
    expect(entry.className).toContain("on");
    expect(screen.getByTestId("nav-tasks").className).not.toContain("on");
  });

  it("没有选嵌入模型：表格上面写明这些文档没有向量化、助手查知识库只按字面找，给去设置的链接；文档都是「未向量化」；没有「开始向量化」", async () => {
    page();
    const line = await screen.findByTestId("kb-embedding");
    expect(line.textContent).toBe("还没有选嵌入模型，这些文档没有向量化：助手查知识库只按字面找，用词不同的找不到。去设置里选");
    expect(within(line).getByText("去设置里选").getAttribute("href")).toBe("#/settings/models");
    expect(screen.getByTestId("kb-doc-embedding-公司术语表.md").textContent).toBe("未向量化");
    expect(screen.queryByTestId("kb-embed-start")).toBeNull();
    expect([...within(screen.getByTestId("kb-documents")).getAllByRole("columnheader")].map((c) => c.textContent)).toEqual(["文档名", "种类", "大小", "上传时间", "向量化", "操作"]);
  });

  it("没有文档的知识库不写向量化的那一行", async () => {
    page("lib-hy");
    await screen.findByTestId("kb-pane");
    expect(screen.queryByTestId("kb-embedding")).toBeNull();
  });

  it("选了嵌入模型：写「已向量化 N / M」、进度条与嵌入模型的型号；文档各写各的状态，向量化失败的带原因；「开始向量化」只向量化这个知识库，之后重新取清单", async () => {
    const calls = page(null, overviewOf([
      ["规则.md", state({ status: "done", model: MODEL, done: 5, total: 5 })],
      ["长文.txt", state({ status: "failed", model: MODEL, error: "模型服务回答了错误（HTTP 500）：the input length exceeds the context length" })],
      ["说明.txt", state()],
      ["空白.txt", state({ status: "done", model: MODEL, done: 0, total: 0 })],
    ]));
    const line = await screen.findByTestId("kb-embedding");
    expect(screen.getByTestId("kb-embedding-count").textContent).toBe("已向量化 2 / 4");
    const bar = within(line).getByRole("progressbar");
    expect([bar.getAttribute("aria-valuenow"), bar.getAttribute("aria-valuemax"), (bar.firstElementChild as HTMLElement).style.width]).toEqual(["2", "4", "50%"]);
    expect(line.textContent).toBe("已向量化 2 / 4嵌入模型：bge-m3开始向量化");
    expect(screen.getByTestId("kb-doc-embedding-规则.md").textContent).toBe("已向量化");
    expect(screen.getByTestId("kb-doc-embedding-长文.txt").textContent).toBe("向量化失败重试");
    // 原因写在这份文档下面单独的一行里，横跨整张表的六列。
    const why = screen.getByTestId("kb-doc-embedding-error-长文.txt");
    expect([why.textContent, why.getAttribute("colspan")]).toEqual(["模型服务回答了错误（HTTP 500）：the input length exceeds the context length", "6"]);
    expect(screen.queryByTestId("kb-doc-embedding-error-规则.md")).toBeNull();
    expect(screen.getByTestId("kb-doc-embedding-说明.txt").textContent).toBe("未向量化");
    expect(screen.getByTestId("kb-doc-embedding-空白.txt").textContent).toBe("没有文字，不用向量化");
    expect(screen.queryByTestId("kb-embedding-stopped")).toBeNull();

    fireEvent.click(screen.getByTestId("kb-embed-start"));
    await waitFor(() => expect(calls.embed).toHaveBeenCalledWith({ library: "general" }));
    await waitFor(() => expect(calls.overview).toHaveBeenCalledTimes(2));
  });

  it("向量化失败的文档：「重试」只向量化这一份", async () => {
    const calls = page(null, overviewOf([["长文.txt", state({ status: "failed", model: MODEL, error: "模型服务回答的数字串全是 0，没法用。" })]]));
    fireEvent.click(within(await screen.findByTestId("kb-doc-embedding-长文.txt")).getByText("重试"));
    await waitFor(() => expect(calls.embed).toHaveBeenCalledWith({ library: "general", name: "长文.txt" }));
  });

  it("向量化中：文档写「向量化中（算完几个 / 一共几个）」与「等待向量化」，没有「开始向量化」；隔一会儿自动再取清单，都向量化完成就不再取", async () => {
    embeddingPolling.intervalMs = 20;
    const during = overviewOf([["长文.txt", state({ status: "running", model: MODEL, done: 32, total: 40 })], ["规则.md", state({ status: "queued" })]], { running: true });
    const after = overviewOf([["长文.txt", state({ status: "done", model: MODEL, done: 40, total: 40 })], ["规则.md", state({ status: "done", model: MODEL, done: 5, total: 5 })]]);
    const calls = page(null, [during, during, after]);
    expect((await screen.findByTestId("kb-doc-embedding-长文.txt")).textContent).toBe("向量化中（32 / 40）");
    expect(screen.getByTestId("kb-doc-embedding-规则.md").textContent).toBe("等待向量化");
    expect(screen.getByTestId("kb-embedding-count").textContent).toBe("已向量化 0 / 2");
    expect(screen.queryByTestId("kb-embed-start")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("kb-embedding-count").textContent).toBe("已向量化 2 / 2"));
    expect(screen.queryByTestId("kb-embed-start")).toBeNull();
    // 算完的那次回答到了之后，定时器要等页面渲染完、清理执行了才停，机器忙时这之间可能多响一次，所以不断言「恰好 3 次」：
    // 先等一段时间让清理做完，再确认次数不再增加。
    expect(calls.overview.mock.calls.length).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 100));
    const settled = calls.overview.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.overview).toHaveBeenCalledTimes(settled);
  });

  it("还没有切好片段时只写「向量化中」；自动取的那一次没取到时页面照旧，不换成报错", async () => {
    embeddingPolling.intervalMs = 20;
    const during = overviewOf([["长文.txt", state({ status: "running", model: MODEL, done: 0, total: null })]], { running: true });
    const calls = page(null, during);
    expect((await screen.findByTestId("kb-doc-embedding-长文.txt")).textContent).toBe("向量化中");
    calls.overview.mockRejectedValue(new Error("网络断了"));
    await waitFor(() => expect(calls.overview.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.getByTestId("kb-doc-embedding-长文.txt").textContent).toBe("向量化中");
  });

  it("整个向量化停下了：写明停下的原因，「开始向量化」还在", async () => {
    page(null, overviewOf([["规则.md", state()]], { stopped_reason: "连不上这个模型服务。请确认它已经启动，地址与端口没有写错。" }));
    expect((await screen.findByTestId("kb-embedding-stopped")).textContent).toBe("向量化停下了：连不上这个模型服务。请确认它已经启动，地址与端口没有写错。");
    expect(screen.getByTestId("kb-embed-start")).toBeTruthy();
  });

  it("开始向量化没有做成：给出后端的那句话", async () => {
    const calls = page(null, overviewOf([["规则.md", state()]]));
    calls.embed.mockRejectedValue(new ApiError("rejected", "还没有选嵌入模型。", 422));
    fireEvent.click(await screen.findByTestId("kb-embed-start"));
    expect(await screen.findByText("还没有选嵌入模型。")).toBeTruthy();
  });

  it("试一试按意思查找：这个知识库向量化完成就能查，只查这一个知识库；空着不发请求；查到的片段写相近程度、文档名、标题、位置与正文", async () => {
    const calls = page(null, EMBEDDED());
    const box = await screen.findByTestId("kb-search");
    expect(within(box).getByText("试一试按意思查找")).toBeTruthy();
    expect(screen.getByTestId("kb-search-hint").textContent).toBe("在这个知识库的文档里找意思最相近的几个片段，用词不同也找得到。助手在任务实例里用的是同一种办法，它查的是任务实例选用的全部知识库。");
    const input = screen.getByTestId("kb-search-input") as HTMLInputElement;
    expect([input.disabled, input.placeholder]).toEqual([false, "写一句完整的话，例如：图书超期不还怎样罚款"]);
    expect((screen.getByTestId("kb-search-button") as HTMLButtonElement).disabled).toBe(true);
    pressEnter(input);
    fireEvent.change(input, { target: { value: "   " } });
    pressEnter(input);
    expect(calls.search).not.toHaveBeenCalled();
    expect(screen.queryByTestId("kb-search-result")).toBeNull();

    fireEvent.change(input, { target: { value: " 图书超期不还怎样罚款 " } });
    fireEvent.click(screen.getByTestId("kb-search-button"));
    await waitFor(() => expect(calls.search).toHaveBeenCalledWith("图书超期不还怎样罚款", ["general"]));
    const result = await screen.findByTestId("kb-search-result");
    expect(within(result).getByText("在 37 个片段里，最相近的 3 个。相近程度最大是 1，越大越相近。")).toBeTruthy();
    const hits = within(result).getAllByTestId("kb-search-hit");
    expect(hits.map((h) => h.querySelector(".hh")!.textContent)).toEqual([
      "相近程度 0.71借阅规范.md借阅规范 / 逾期第 31 到 35 行", "相近程度 0.63需求说明.docx3.1.1 逾期罚款第 75 到 78 段", "相近程度 0.20术语表.txt第 7 行"]);
    expect(hits[0].querySelector(".hx")!.textContent).toBe("第 4.2 条　逾期归还的，每册每天收取罚款 0.2 元。\n单册罚款累计不超过该书定价。");
    // 回车也查。
    fireEvent.change(input, { target: { value: "预约" } });
    pressEnter(input);
    await waitFor(() => expect(calls.search).toHaveBeenLastCalledWith("预约", ["general"]));
  });

  it("试一试按意思查找不能用的时候：没有选嵌入模型，或者这个知识库里的文档没有都向量化，输入框是灰的并写明原因；没有文档的知识库没有这一块", async () => {
    page();
    expect(((await screen.findByTestId("kb-search-input")) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("kb-search-hint").textContent).toBe("还没有选嵌入模型，不能按意思查找。");
    cleanup();
    vi.restoreAllMocks();
    page(null, overviewOf([["借阅规范.md", state({ status: "done", model: MODEL, done: 12, total: 12 })], ["说明.txt", state()]]));
    expect(((await screen.findByTestId("kb-search-input")) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("kb-search-hint").textContent).toBe("这个知识库里的文档都向量化之后，才能按意思查找。");
    expect((screen.getByTestId("kb-search-button") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    vi.restoreAllMocks();
    page("lib-hy");
    await screen.findByTestId("kb-pane");
    expect(screen.queryByTestId("kb-search")).toBeNull();
  });

  it("试一试按意思查找没有结果的几种：后端说还有文档没有向量化、文档没有可比较的文字，各写一句；这一次没有查成时给出后端的那句话", async () => {
    const calls = page(null, EMBEDDED());
    const ask = async (text: string) => {
      fireEvent.change(await screen.findByTestId("kb-search-input"), { target: { value: text } });
      fireEvent.click(screen.getByTestId("kb-search-button"));
    };
    calls.search.mockResolvedValue({ ...FOUND, ready: false, pending: 2, chunks: 0, hits: [] });
    await ask("罚款");
    expect((await screen.findByTestId("kb-search-result")).textContent).toBe("这个知识库里还有 2 份文档没有向量化，向量化完成后才能按意思查找。");
    calls.search.mockResolvedValue({ ...FOUND, chunks: 0, hits: [] });
    await ask("预约");
    await waitFor(() => expect(screen.getByTestId("kb-search-result").textContent).toBe("这个知识库里的文档没有可比较的文字。"));
    calls.search.mockRejectedValue(new ApiError("internal", "后端出错了。", 500));
    await ask("续借");
    expect(await screen.findByText("后端出错了。")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("kb-search-result")).toBeNull());
  });
});

describe("补齐缺失的文档", () => {
  const missingOverview = (): KnowledgeOverview => {
    const one = overviewOf([["退款规范.md", state()]]);
    one.libraries[0].documents[0] = { ...one.libraries[0].documents[0], missing: true };
    return one;
  };

  it("清单里有而文件不在的文档：大小一栏写「文件缺失，请补齐」，「查看」灰掉；点「补齐」选文件上传，相同时提示已恢复", async () => {
    const calls = page("general", [missingOverview(), overviewOf([["退款规范.md", state()]])]);
    expect(await screen.findByTestId("kb-doc-missing-退款规范.md")).toHaveTextContent("文件缺失，请补齐");
    expect(screen.getByTestId("kb-doc-view-off-退款规范.md")).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByTestId("kb-doc-view-退款规范.md")).toBeNull();
    const replenish = vi.spyOn(api, "replenishDocument").mockResolvedValue({ ok: true, name: "退款规范.md" });
    fireEvent.click(screen.getByTestId("kb-doc-replenish-退款规范.md"));
    const file = new File(["退款规范全文"], "退款规范.md");
    fireEvent.change(screen.getByTestId("kb-replenish-input"), { target: { files: [file] } });
    await waitFor(() => expect(replenish).toHaveBeenCalledWith("general", "退款规范.md", file));
    expect(await screen.findByText("《退款规范.md》已恢复到导出时的状态。")).toBeInTheDocument();
    await waitFor(() => expect(calls.overview.mock.calls.length).toBeGreaterThan(1));
  });

  it("校验值不同：照后端的原话提示，文档仍标缺失", async () => {
    page("general", missingOverview());
    await screen.findByTestId("kb-doc-missing-退款规范.md");
    vi.spyOn(api, "replenishDocument").mockRejectedValue(new ApiError("rejected", "不是导出时那份文件（校验值与导出时不同）。要换成别的文件，请先删掉这份文档再上传。", 422));
    fireEvent.click(screen.getByTestId("kb-doc-replenish-退款规范.md"));
    fireEvent.change(screen.getByTestId("kb-replenish-input"), { target: { files: [new File(["别的"], "退款规范.md")] } });
    expect(await screen.findByText("不是导出时那份文件（校验值与导出时不同）。要换成别的文件，请先删掉这份文档再上传。")).toBeInTheDocument();
    expect(screen.getByTestId("kb-doc-missing-退款规范.md")).toBeInTheDocument();
  });
});
