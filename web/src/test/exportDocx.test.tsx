// 条目区的「导出 Word」：一个都没勾时按钮灰并写明原因；勾了之后按钮带数量，全部页签里勾中的都算；对话框写明导出最新的版本、
// 来自几个集合，「带上来源」缺省勾上；点导出把勾中的编号与带不带来源交给接口，用响应头里的文件名保存；
// 助手工作中、任务结束后也能勾选与导出；没有导出成时原因写在对话框里。另测从响应头取文件名。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type { Item, Task } from "../api/types";
import { EXPORT_DOCX_HINT, ExportDocxModal, exportSummary } from "../components/work/ExportDocxModal";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { ToastProvider } from "../components/Toasts";
import * as download from "../model/download";

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider>{children}</ToastProvider></AntApp></ConfigProvider>
);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const noop = () => {};

function item(id: string, collection: string, fields: Record<string, unknown>): Item {
  return {
    item_id: id, collection, title: String(Object.values(fields)[0]), revision_no: 2, revision_by: "executor", revision_at: "", revisions: [2],
    fields, sources: [], reviews: [], waivers: [], confirmations: [{ revision_no: 2, accepted: true, basis: "viewed" }], confirmation_stale: false,
  } as Item;
}
const TASK: Task = {
  task_id: "TASK-E", task_name: "图书馆借还", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
  definition: { collections: [
    { name: "功能用例", prefix: "UC", needs_review: false, review_rules: null, fields: [{ name: "用例名称", type: "文本", required: true, values: null }] },
    { name: "领域说明", prefix: "DN", needs_review: false, review_rules: null, fields: [{ name: "标题", type: "文本", required: true, values: null }] }] },
  completion: null, latest_revision: 2,
  items: [item("UC-001", "功能用例", { 用例名称: "登录" }), item("UC-002", "功能用例", { 用例名称: "借出图书" }), item("DN-001", "领域说明", { 标题: "口令" })],
} as Task;

function panel(over: Partial<Parameters<typeof ItemsPanel>[0]> = {}) {
  return render(<Wrap><ItemsPanel task={TASK} readOnly={false} recentlyChanged={[]} pendingItems={new Set()} selected={null} onSelect={noop}
    submit={vi.fn(async () => null)} onGenerateDoc={noop} {...over} /></Wrap>);
}
const check = (id: string) => fireEvent.click(within(screen.getByTestId(`item-${id}`)).getByRole("checkbox"));
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name}`) }));
const mockExport = () => vi.spyOn(api, "exportItemsDocx").mockResolvedValue({ blob: new Blob(["docx"]), fileName: "图书馆借还-条目-2026-10-08.docx" });

describe("按钮", () => {
  it("一个都没勾时是灰的，悬停写明先勾选；勾了之后带数量", () => {
    panel();
    const button = screen.getByTestId("export-docx");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/^导出 Word$/);
    expect(button).toHaveAttribute("title", EXPORT_DOCX_HINT);
    check("UC-001");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("导出 Word（1）");
    expect(button).not.toHaveAttribute("title");
    check("UC-001");
    expect(button).toBeDisabled();
  });

  it("全部页签里勾中的都算：在两个页签各勾几个，数量是合起来的", () => {
    panel();
    check("UC-001");
    check("UC-002");
    tab("领域说明");
    check("DN-001");
    expect(screen.getByTestId("export-docx")).toHaveTextContent("导出 Word（3）");
    // 批量条照旧只数当前页签里勾中的。
    expect(screen.getByText(/已勾选 1 个条目/)).toBeInTheDocument();
  });
});

describe("对话框与导出", () => {
  it("写明导出最新的版本、来自几个集合；带上来源缺省勾上；点导出交给接口并用响应头里的文件名保存，然后关掉，勾选留着", async () => {
    const exported = mockExport();
    const saved = vi.spyOn(download, "saveBlob").mockImplementation(noop);
    panel();
    check("UC-002");
    check("UC-001");
    tab("领域说明");
    check("DN-001");
    fireEvent.click(screen.getByTestId("export-docx"));
    expect(await screen.findByTestId("export-docx-summary")).toHaveTextContent("导出选中的 3 个条目（来自 2 个集合）最新的版本。");
    expect(screen.getByTestId("export-docx-sources")).toBeChecked();
    fireEvent.click(screen.getByTestId("export-docx-ok"));
    await waitFor(() => expect(exported).toHaveBeenCalledTimes(1));
    expect(exported).toHaveBeenCalledWith("TASK-E", ["UC-001", "UC-002", "DN-001"], true, "图书馆借还-条目.docx");
    await waitFor(() => expect(saved).toHaveBeenCalledWith(expect.any(Blob), "图书馆借还-条目-2026-10-08.docx"));
    expect(screen.getByTestId("export-docx")).toHaveTextContent("导出 Word（3）");
  });

  it("导出成了就关掉对话框；没有导出成不关", async () => {
    vi.spyOn(download, "saveBlob").mockImplementation(noop);
    const exported = mockExport();
    const onClose = vi.fn();
    render(<Wrap><ExportDocxModal open task={TASK} items={TASK.items} onClose={onClose} /></Wrap>);
    fireEvent.click(await screen.findByTestId("export-docx-ok"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    exported.mockRejectedValueOnce(new ApiError("bad_response", "交付物里没有这些条目：UC-009。", 400));
    fireEvent.click(screen.getByTestId("export-docx-ok"));
    expect(await screen.findByTestId("export-docx-error")).toHaveTextContent("没有导出成：交付物里没有这些条目：UC-009。");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("去掉「带上来源」的勾，交给接口的是不带来源；再打开对话框又是勾上的", async () => {
    const exported = mockExport();
    vi.spyOn(download, "saveBlob").mockImplementation(noop);
    panel();
    check("UC-001");
    fireEvent.click(screen.getByTestId("export-docx"));
    expect(await screen.findByTestId("export-docx-summary")).toHaveTextContent("导出选中的 1 个条目最新的版本。");
    fireEvent.click(screen.getByTestId("export-docx-sources"));
    fireEvent.click(screen.getByTestId("export-docx-ok"));
    await waitFor(() => expect(exported).toHaveBeenCalledWith("TASK-E", ["UC-001"], false, "图书馆借还-条目.docx"));
    fireEvent.click(screen.getByTestId("export-docx"));
    await waitFor(() => expect(screen.getByTestId("export-docx-sources")).toBeChecked());
  });

  it("没有导出成时把原因写在对话框里，对话框留着，不保存文件", async () => {
    vi.spyOn(api, "exportItemsDocx").mockRejectedValue(new ApiError("bad_response", "选中的条目都已经删除，没有可以导出的。", 400));
    const saved = vi.spyOn(download, "saveBlob").mockImplementation(noop);
    panel();
    check("UC-001");
    fireEvent.click(screen.getByTestId("export-docx"));
    fireEvent.click(await screen.findByTestId("export-docx-ok"));
    expect(await screen.findByTestId("export-docx-error")).toHaveTextContent("没有导出成：选中的条目都已经删除，没有可以导出的。");
    expect(screen.getByTestId("export-docx-summary")).toBeInTheDocument();
    expect(saved).not.toHaveBeenCalled();
  });

  it("助手工作中、任务结束后也能勾选与导出；助手工作中「标为已读」照旧不能点", async () => {
    const exported = mockExport();
    vi.spyOn(download, "saveBlob").mockImplementation(noop);
    panel({ writesOff: true });
    check("UC-001");
    expect(screen.getByTestId("export-docx")).toBeEnabled();
    expect(screen.getByTestId("bulk-viewed")).toBeDisabled();
    cleanup();
    panel({ readOnly: true });
    check("UC-002");
    fireEvent.click(screen.getByTestId("export-docx"));
    fireEvent.click(await screen.findByTestId("export-docx-ok"));
    await waitFor(() => expect(exported).toHaveBeenCalledWith("TASK-E", ["UC-002"], true, "图书馆借还-条目.docx"));
  });
});

describe("文字与文件名", () => {
  it("对话框里的那一句：一个集合时不写来自几个集合", () => {
    expect(exportSummary(TASK.items.slice(0, 2))).toBe("导出选中的 2 个条目最新的版本。");
    expect(exportSummary(TASK.items)).toBe("导出选中的 3 个条目（来自 2 个集合）最新的版本。");
  });

  it("从响应头取文件名：先认带中文的 filename*，没有再认 filename，都没有是 null", () => {
    const name = "图书馆借还-条目-2026-10-08.docx";
    expect(download.dispositionFileName(`attachment; filename="TASK-1-items.docx"; filename*=UTF-8''${encodeURIComponent(name)}`)).toBe(name);
    expect(download.dispositionFileName('attachment; filename="TASK-1-items.docx"')).toBe("TASK-1-items.docx");
    expect(download.dispositionFileName("attachment; filename=plain.docx")).toBe("plain.docx");
    expect(download.dispositionFileName("attachment; filename*=UTF-8''%E0%A4%A; filename=\"x.docx\"")).toBe("x.docx");
    expect(download.dispositionFileName("attachment")).toBeNull();
    expect(download.dispositionFileName(null)).toBeNull();
  });
});
