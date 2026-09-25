// 任务列表：正被别的服务占用的任务照样列出，灰显、打不开，状态一栏写明被哪个端口的服务占用。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { TaskListEntry } from "../api/types";
import { TaskListPage } from "../pages/TaskListPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const base = { task_type: "软件需求规格说明编制", domain_tag: null, item_count: null, completion_met: null, completion_total: null,
  completion_unmet: null, last_active_at: null, session_count: null } as unknown as TaskListEntry;

describe("任务列表", () => {
  it("被占用的任务写「正被端口 N 的服务占用」，没有打开按钮；旧格式照旧", async () => {
    vi.spyOn(api, "listTasks").mockResolvedValue([
      { ...base, task_id: "TASK-A", task_name: "被占用的任务", status: "占用中", supported: false, note: "这个任务正被端口 8790 的服务占用，这里不能打开。",
        occupied: { port: 8790, pid: 123, host: "h" } },
      { ...base, task_id: "TASK-OLD", task_name: "TASK-OLD", status: "旧格式", supported: false, note: "旧格式" },
    ]);
    render(<ConfigProvider><AntApp><TaskListPage /></AntApp></ConfigProvider>);
    expect(await screen.findByTestId("task-occupied")).toHaveTextContent("正被端口 8790 的服务占用");
    expect(screen.getByTestId("task-unsupported")).toHaveTextContent("旧格式，不支持");
    expect(screen.getByText(/1 个是旧格式、现在的程序打不开，1 个正被别的服务占用、这里打不开/)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "打开" })).toHaveLength(0);
  });
});
