// 任务没有状态：0.5.0 完成的任务升级后有第 1 版，任务起点页与别的任务一样，有「进入工作台」，没有状态的字样与只读说明。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { TaskPage } from "../pages/TaskPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function taskPage(versions: unknown[]) {
  const detail = {
    task_id: "TASK-C", task_name: "早先完成的任务", task_type: "演示", domain_tag: null, started_at: "",
    definition: { collections: [] }, items: [], completion: null, sessions: [], materials: [], versions,
  } as unknown as TaskDetail;
  vi.spyOn(api, "getTask").mockResolvedValue(detail);
  vi.spyOn(api, "taskStatus").mockResolvedValue({ ok: true, status: null });
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "serviceInfo").mockRejectedValue(new Error("没有这个接口"));
  render(<ConfigProvider><AntApp><ToastProvider><ServiceProvider><TaskPage taskId="TASK-C" /></ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
}

describe("任务起点页的「进入工作台」", () => {
  it.each([["没有发布过", []], ["升级时补了第 1 版", [{ version_no: 1, revision_no: 7, published_at: "2026-10-05T10:00:00", actor: "executor", note: "升级前完成，当时文档未存档",
    figure_count: null, figure_pictures: null, has_markdown: false, has_docx: false }]]])("%s：显示，可以点；没有状态的字样与只读说明", async (_name, versions) => {
    taskPage(versions);
    expect(await screen.findByRole("button", { name: "进入工作台" })).toBeEnabled();
    expect(screen.queryByTestId("task-status")).toBeNull();
    expect(document.body.textContent).not.toMatch(/整页只读|已完成|进行中/);
  });
});
