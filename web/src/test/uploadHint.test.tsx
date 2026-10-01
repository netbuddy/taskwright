// 任务页上传区的说明文字：前一句固定，后面类型与大小两半句取自服务信息（upload.types_text、upload.max_bytes）；大小，写法与后端那句「单个文件不能超过 5 MB。」里的数字一致；
// 还没取到服务信息时两半句都不写，不显示猜的内容。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { ServiceInfo, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { uploadLimitText } from "../model/upload";
import { TaskPage } from "../pages/TaskPage";
import { settled } from "./settled";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const info = (maxBytes: number): ServiceInfo => ({
  ok: true, app: "taskwright", version: "0.3.0", mode: "server", pid: 1, port: 8940,
  capabilities: { exit: false, model: true },
  upload: { max_bytes: maxBytes, too_large_text: `单个文件不能超过 ${maxBytes / 1024 / 1024} MB。`, extensions: [".md", ".txt", ".docx"], types_text: ".md、.txt 与 Word 的 .docx" },
});
const detail = {
  task_id: "TASK-H", task_name: "说明文字", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
  definition: { collections: [] }, items: [], completion: null, sessions: [], materials: [],
} as unknown as TaskDetail;

function taskPage(serviceInfo: Promise<ServiceInfo>) {
  vi.spyOn(api, "getTask").mockResolvedValue(detail);
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "serviceInfo").mockReturnValue(serviceInfo);
  render(<ConfigProvider><AntApp><ToastProvider><ServiceProvider><TaskPage taskId="TASK-H" /></ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
}

describe("uploadLimitText", () => {
  it("按 max_bytes 换算成 MB，数字写法与后端那句话相同；没有服务信息或没有 upload 时为 null", () => {
    expect(uploadLimitText(info(5 * 1024 * 1024))).toBe("单个不超过 5 MB");
    expect(uploadLimitText(info(2.5 * 1024 * 1024))).toBe("单个不超过 2.5 MB");
    expect(uploadLimitText(null)).toBeNull();
    expect(uploadLimitText({ ...info(1), upload: undefined })).toBeNull();
  });
});

describe("任务页上传框的说明文字", () => {
  it("取到服务信息：写后端给的上限", async () => {
    taskPage(Promise.resolve(info(5 * 1024 * 1024)));
    const hint = await screen.findByTestId("upload-hint");
    await waitFor(() => expect(hint.textContent).toBe("把文件拖到这里，或者点这里选择文件。只收 .md、.txt 与 Word 的 .docx，单个不超过 5 MB。"));
  });

  it("后端给的上限变了，说明跟着变", async () => {
    taskPage(Promise.resolve(info(10 * 1024 * 1024)));
    const hint = await screen.findByTestId("upload-hint");
    await waitFor(() => expect(hint).toHaveTextContent("单个不超过 10 MB"));
  });

  it("取不到服务信息：类型与大小两半句都不写", async () => {
    taskPage(Promise.reject(new Error("没有这个接口")));
    const hint = await screen.findByTestId("upload-hint");
    // 取不到时页面上不留痕迹，与还没取到时一样；等这次失败处理完再看说明。
    await settled(vi.mocked(api.serviceInfo));
    expect(hint.textContent).toBe("把文件拖到这里，或者点这里选择文件。");
    expect(hint.textContent).not.toMatch(/MB|只收/);
  });
});
