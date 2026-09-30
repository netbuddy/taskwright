// 任务页与知识库：上传时选择去向（材料、知识库两种各一次；「同时让这个任务选用它」勾上时调改选用；新建库再上传；
// 超过去向各自的上限时不发请求），材料的「删除」先确认再调接口，「选用的知识库」一栏的列出与改选用，没有知识库的旧服务照旧直接上传。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { KnowledgeLibrary, ServiceInfo, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { TaskPage } from "../pages/TaskPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const KINDS = [
  { kind: "standard", name: "规范" }, { kind: "glossary", name: "术语表" }, { kind: "template", name: "模板" },
  { kind: "past_work", name: "以往的成果" }, { kind: "other", name: "其他" },
] as const;
const info: ServiceInfo = {
  ok: true, app: "taskwright", version: "0.4.1", mode: "server", pid: 1, port: 8950,
  capabilities: { exit: false, model: true, knowledge: true },
  upload: { max_bytes: 10, too_large_text: "单个文件不能超过 5 MB。", extensions: [".md", ".txt", ".docx"], types_text: ".md、.txt 与 Word 的 .docx", unsupported_type_text: "只接受 .md、.txt 与 Word 的 .docx 文件。" },
  knowledge_upload: { max_bytes: 40, too_large_text: "单个文件不能超过 20 MB。", extensions: [".md", ".txt", ".docx"], types_text: ".md、.txt 与 Word 的 .docx",
    unsupported_type_text: "只接受 .md、.txt 与 Word 的 .docx 文件。", kinds: [...KINDS] },
};
const lib = (id: string, name: string, used = 0, docs = 0): KnowledgeLibrary =>
  ({ id, name, created_at: "", used_by_tasks: used, documents: Array.from({ length: docs }, (_, i) => ({ name: `d${i}.md`, kind: "other", bytes: 1, uploaded_at: "" })) });
const LIBS = [lib("general", "通用库", 2, 3), lib("lib-hy", "行业规范", 1, 4), lib("lib-cb", "城北区图书馆的资料", 0, 5)];

function detail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task_id: "TASK-K", task_name: "知识库", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [] }, items: [], completion: null, sessions: [],
    materials: [{ path: "inputs/借阅说明.md", bytes: 5, modified_at: "", derived_from: null }], knowledge_libraries: ["general", "lib-cb"], ...over,
  } as unknown as TaskDetail;
}

function page(serviceInfo: ServiceInfo = info, task: TaskDetail = detail()) {
  vi.spyOn(api, "getTask").mockResolvedValue(task);
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "serviceInfo").mockResolvedValue(serviceInfo);
  vi.spyOn(api, "knowledge").mockResolvedValue(LIBS);
  const calls = {
    material: vi.spyOn(api, "uploadMaterial").mockResolvedValue({ path: "inputs/a.md" }),
    document: vi.spyOn(api, "uploadDocument").mockResolvedValue({ name: "a.md", kind: "glossary", bytes: 1, uploaded_at: "" }),
    select: vi.spyOn(api, "setTaskKnowledge").mockImplementation(async (_t, ids) => ids),
    create: vi.spyOn(api, "createLibrary").mockResolvedValue({ id: "lib-new", name: "新库", created_at: "" }),
    remove: vi.spyOn(api, "deleteMaterial").mockResolvedValue({ ok: true, path: "inputs/借阅说明.md" }),
  };
  render(<ConfigProvider><AntApp><ToastProvider><ServiceProvider><TaskPage taskId="TASK-K" /></ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
  return calls;
}

async function choose(bytes = 5, name = "术语.md") {
  await screen.findByTestId("task-knowledge");
  const input = document.querySelector("input[type=file]") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x".repeat(bytes)], name, { type: "text/markdown" })] } });
  return screen.findByText("这份文件用来做什么？");
}

/** 在「放进哪个库」下拉框里选一项。 */
async function pickLibrary(label: string) {
  fireEvent.mouseDown(within(screen.getByTestId("dest-library")).getByRole("combobox"));
  fireEvent.click(await screen.findByText(label, { selector: ".ant-select-item-option-content" }));
}

describe("上传时选择去向", () => {
  it("选「这次要整理的材料」：调材料上传，不碰知识库", async () => {
    const calls = page();
    await choose();
    expect(screen.getByTestId("upload-note").textContent).toBe("上传之后会出现在「材料清单」里。");
    fireEvent.click(screen.getByTestId("upload-confirm"));
    await waitFor(() => expect(calls.material).toHaveBeenCalledTimes(1));
    expect(calls.document).not.toHaveBeenCalled();
    expect(calls.select).not.toHaveBeenCalled();
  });

  it("选「整理时要参考的资料」放进这个任务已经选用的库：调知识库上传并带上种类，提示是灰色，不改选用", async () => {
    const calls = page();
    await choose();
    fireEvent.click(screen.getByTestId("dest-knowledge"));
    await pickLibrary("城北区图书馆的资料（5 份文档）");
    expect(screen.getByTestId("dest-hint").className).not.toContain("amber");
    expect(screen.getByTestId("dest-hint").textContent).toBe("这个任务现在选用了：通用库、城北区图书馆的资料。放进去之后，助手下一次会话开始时就查得到。");
    fireEvent.click(screen.getByText("术语表", { selector: ".updest-seg label" }));
    expect(screen.getByTestId("upload-note").textContent).toBe("上传之后会出现在知识库「城北区图书馆的资料」里，不会出现在「材料清单」里。");
    fireEvent.click(screen.getByTestId("upload-confirm"));
    await waitFor(() => expect(calls.document).toHaveBeenCalledTimes(1));
    expect(calls.document.mock.calls[0][0]).toBe("lib-cb");
    expect(calls.document.mock.calls[0][2]).toBe("glossary");
    expect(calls.material).not.toHaveBeenCalled();
    expect(calls.select).not.toHaveBeenCalled();
  });

  it("放进这个任务还没有选用的库：提示是琥珀色，「同时让这个任务选用它」默认勾上，上传之后调了改选用", async () => {
    const calls = page();
    await choose();
    fireEvent.click(screen.getByTestId("dest-knowledge"));
    await pickLibrary("行业规范（4 份文档）");
    const hint = screen.getByTestId("dest-hint");
    expect(hint.className).toContain("amber");
    expect(hint.textContent).toContain("这个任务还没有选用「行业规范」。放进去之后，要在任务页上选用它，助手才查得到。");
    expect((within(hint).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("upload-confirm"));
    await waitFor(() => expect(calls.select).toHaveBeenCalledWith("TASK-K", ["general", "lib-cb", "lib-hy"]));
    expect(calls.document.mock.calls[0][0]).toBe("lib-hy");
  });

  it("去掉「同时让这个任务选用它」的勾：只上传，不改选用", async () => {
    const calls = page();
    await choose();
    fireEvent.click(screen.getByTestId("dest-knowledge"));
    await pickLibrary("行业规范（4 份文档）");
    fireEvent.click(within(screen.getByTestId("dest-hint")).getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("upload-confirm"));
    await waitFor(() => expect(calls.document).toHaveBeenCalledTimes(1));
    expect(calls.select).not.toHaveBeenCalled();
  });

  it("选「新建一个库…」：先填名字才能上传；先建库，再放进新库，并让这个任务选用它", async () => {
    const calls = page();
    await choose();
    fireEvent.click(screen.getByTestId("dest-knowledge"));
    await pickLibrary("新建一个库…");
    expect((screen.getByTestId("upload-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("dest-new-name"), { target: { value: "新库" } });
    fireEvent.click(screen.getByTestId("upload-confirm"));
    await waitFor(() => expect(calls.select).toHaveBeenCalledWith("TASK-K", ["general", "lib-cb", "lib-new"]));
    expect(calls.create).toHaveBeenCalledWith("新库");
    expect(calls.document.mock.calls[0][0]).toBe("lib-new");
  });

  it("大小按去向各自的上限查：超过材料的上限但没超过知识库的，放进知识库照常发，当材料不发", async () => {
    const calls = page();
    await choose(20);
    fireEvent.click(screen.getByTestId("upload-confirm"));
    expect(await screen.findByText("单个文件不能超过 5 MB。")).toBeInTheDocument();
    expect(calls.material).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("dest-knowledge"));
    fireEvent.click(screen.getByTestId("upload-confirm"));
    await waitFor(() => expect(calls.document).toHaveBeenCalledTimes(1));
  });

  it("上传框说明分别写材料与放进知识库的上限", async () => {
    page({ ...info, upload: { ...info.upload!, max_bytes: 5 * 1024 * 1024 }, knowledge_upload: { ...info.knowledge_upload!, max_bytes: 20 * 1024 * 1024 } });
    await screen.findByTestId("task-knowledge");
    expect(screen.getByTestId("upload-hint").textContent)
      .toBe("把文件拖到这里，或者点这里选择文件（只收 .md、.txt 与 Word 的 .docx，材料单个不超过 5 MB，放进知识库的单个不超过 20 MB）。新传的材料下一次会话开始时助手就能看到。");
  });

  it("没有知识库的旧服务：不弹对话框，照旧直接上传成材料，也没有「选用的知识库」一栏", async () => {
    const old = { ...info, capabilities: { exit: false, model: true }, knowledge_upload: undefined };
    const calls = page(old);
    await screen.findByText(/单个不超过/);
    const input = document.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "a.md", { type: "text/markdown" })] } });
    await waitFor(() => expect(calls.material).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("这份文件用来做什么？")).toBeNull();
    expect(screen.queryByTestId("task-knowledge")).toBeNull();
  });
});

describe("删除材料", () => {
  it("点「删除」先弹确认，写明来源仍然保留；确定之后调删除接口", async () => {
    const calls = page();
    fireEvent.click(await screen.findByTestId("material-delete"));
    expect(await screen.findByText("删除材料《借阅说明.md》？")).toBeInTheDocument();
    expect(screen.getByText("删除之后，已经引用它的条目上的来源仍然保留，出处旁会写明这份材料已经删除。")).toBeInTheDocument();
    expect(calls.remove).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector(".ant-modal .ant-btn-primary")!);
    await waitFor(() => expect(calls.remove).toHaveBeenCalledWith("TASK-K", "inputs/借阅说明.md"));
  });

  it("任务已结束：没有「删除」", async () => {
    page(info, detail({ status: "已完成" }));
    await screen.findByText("借阅说明.md");
    expect(screen.queryByTestId("material-delete")).toBeNull();
  });
});

describe("选用的知识库", () => {
  it("列出选用的库：通用库注明每个任务都会用到、不能去掉；别的库可以不再选用", async () => {
    const calls = page();
    const card = await screen.findByTestId("task-knowledge");
    await within(card).findByTestId("kb-row-general");
    expect(within(card).getByTestId("kb-row-general").textContent).toContain("通用库3 份文档 · 每个任务都会用到不能去掉");
    expect(within(within(card).getByTestId("kb-row-general")).queryByText("不再选用")).toBeNull();
    fireEvent.click(within(within(card).getByTestId("kb-row-lib-cb")).getByText("不再选用"));
    await waitFor(() => expect(calls.select).toHaveBeenCalledWith("TASK-K", ["general"]));
  });

  it("「选用别的库」勾上一个库、确定之后整体改选用；通用库勾着、不能去掉", async () => {
    const calls = page();
    await screen.findByTestId("kb-row-general");
    fireEvent.click(screen.getByTestId("kb-pick"));
    const picker = await screen.findByTestId("kb-picker");
    const boxes = within(picker).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[true, true], [false, false], [true, false]]);
    expect(picker.textContent).toContain("城北区图书馆的资料5 份文档 · 没有任务在用");
    fireEvent.click(boxes[1]);
    fireEvent.click(within(picker).getByTestId("kb-pick-ok"));
    await waitFor(() => expect(calls.select).toHaveBeenCalledWith("TASK-K", ["general", "lib-hy", "lib-cb"]));
  });
});
