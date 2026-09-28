// 上传之前按服务信息里的上限拦下过大的文件：超过上限不发请求，直接显示后端给的那句话；不超过照常发；
// 还没取到服务信息（或旧后端没有这一项）时不拦，照常发给后端，由后端拒绝。任务页的上传框与对话区的附件共用同一个判断。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { ServiceInfo, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { tooLargeText } from "../model/upload";
import { TaskPage } from "../pages/TaskPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const TEXT = "单个文件不能超过 5 MB。";
const info: ServiceInfo = {
  ok: true, app: "taskwright", version: "0.3.0", mode: "server", pid: 1, port: 8940,
  capabilities: { exit: false, model: true }, upload: { max_bytes: 10, too_large_text: TEXT },
};
const detail = {
  task_id: "TASK-U", task_name: "上传", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
  definition: { collections: [] }, items: [], completion: null, sessions: [], materials: [],
} as unknown as TaskDetail;

describe("tooLargeText", () => {
  it("超过上限给出后端的那句话；等于上限、不超过、没有服务信息、服务信息里没有 upload 时为 null", () => {
    expect(tooLargeText(info, { size: 11 })).toBe(TEXT);
    expect(tooLargeText(info, { size: 10 })).toBeNull();
    expect(tooLargeText(null, { size: 1e9 })).toBeNull();
    expect(tooLargeText({ ...info, upload: undefined }, { size: 1e9 })).toBeNull();
  });
});

function taskPage(serviceInfo: Promise<ServiceInfo>) {
  vi.spyOn(api, "getTask").mockResolvedValue(detail);
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "serviceInfo").mockReturnValue(serviceInfo);
  const upload = vi.spyOn(api, "uploadMaterial").mockResolvedValue({ path: "inputs/a.md" });
  render(<ConfigProvider><AntApp><ToastProvider><ServiceProvider><TaskPage taskId="TASK-U" /></ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
  return upload;
}

const choose = async (bytes: number) => {
  const input = await waitFor(() => document.querySelector("input[type=file]") as HTMLInputElement);
  fireEvent.change(input, { target: { files: [new File(["x".repeat(bytes)], "a.md", { type: "text/markdown" })] } });
};

describe("任务页的上传框", () => {
  it("文件超过上限：不发请求，红色提示写后端给的那句话", async () => {
    const upload = taskPage(Promise.resolve(info));
    await waitFor(() => expect(api.serviceInfo).toHaveBeenCalled());
    await screen.findByText(/把文件拖到这里/);
    await choose(11);
    expect(await screen.findByText(TEXT)).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });

  it("文件不超过上限：照常发请求", async () => {
    const upload = taskPage(Promise.resolve(info));
    await screen.findByText(/把文件拖到这里/);
    await choose(10);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  });

  it("取不到服务信息时不拦：照常发给后端", async () => {
    const upload = taskPage(Promise.reject(new Error("没有这个接口")));
    await screen.findByText(/把文件拖到这里/);
    await choose(11);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  });
});
