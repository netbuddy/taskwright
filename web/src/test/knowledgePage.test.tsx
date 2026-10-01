// 知识库页面：知识库的清单与选中的知识库的文档表格；通用知识库不能改名、不能删除；新建与改名；删除知识库、删除文档先确认；
// 上传时带上先选好的种类；类型不符或超过 20 MB 不发请求；左侧栏在服务有知识库时有「知识库」入口。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { KnowledgeLibrary, ServiceInfo } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { KnowledgePage } from "../pages/KnowledgePage";
import { parseRoute } from "../router";

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.location.hash = ""; });

const info: ServiceInfo = {
  ok: true, app: "taskwright", version: "0.4.1", mode: "server", pid: 1, port: 8950, capabilities: { exit: false, model: true, knowledge: true },
  knowledge_upload: { max_bytes: 20 * 1024 * 1024, too_large_text: "单个文件不能超过 20 MB。", extensions: [".md", ".txt", ".docx"], types_text: ".md、.txt 与 Word 的 .docx",
    unsupported_type_text: "只接受 .md、.txt 与 Word 的 .docx 文件。",
    kinds: [{ kind: "standard", name: "规范" }, { kind: "glossary", name: "术语表" }, { kind: "template", name: "模板" }, { kind: "past_work", name: "以往的成果" }, { kind: "other", name: "其他" }] },
};
const LIBS: KnowledgeLibrary[] = [
  { id: "general", name: "通用知识库", created_at: "", used_by_tasks: 3, documents: [{ name: "公司术语表.md", kind: "glossary", bytes: 2048, uploaded_at: "2026-09-29T10:12:00+08:00" }] },
  { id: "lib-hy", name: "行业规范", created_at: "", used_by_tasks: 2, documents: [] },
];

function page(libraryId: string | null = null) {
  vi.spyOn(api, "serviceInfo").mockResolvedValue(info);
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "knowledge").mockResolvedValue(LIBS);
  const calls = {
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
});
