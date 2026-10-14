// 任务列表：任务没有状态，按最近活动排，版本一栏写「已发布 N 版 · 最近发布 时刻」或「未发布」；
// 正被别的服务占用的任务照样列出，灰显、打不开，版本一栏写明被哪个端口的服务占用。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { TaskListEntry } from "../api/types";
import { TaskListPage, versionsText } from "../pages/TaskListPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const base = { task_type: "软件需求规格说明编制", domain_tag: null, item_count: null, completion_met: null, completion_total: null,
  completion_unmet: null, version_count: null, latest_published_at: null, last_active_at: null, session_count: null } as unknown as TaskListEntry;

describe("任务列表", () => {
  it("被占用的任务写「正被端口 N 的服务占用」，没有打开按钮；旧格式照旧", async () => {
    vi.spyOn(api, "listTasks").mockResolvedValue([
      { ...base, task_id: "TASK-A", task_name: "被占用的任务", unavailable: "占用中", supported: false, note: "这个任务正被端口 8790 的服务占用，这里不能打开。",
        occupied: { port: 8790, pid: 123, host: "h" } },
      { ...base, task_id: "TASK-OLD", task_name: "TASK-OLD", unavailable: "旧格式", supported: false, note: "旧格式" },
    ]);
    render(<ConfigProvider><AntApp><TaskListPage /></AntApp></ConfigProvider>);
    expect(await screen.findByTestId("task-occupied")).toHaveTextContent("正被端口 8790 的服务占用");
    expect(screen.getByTestId("task-unsupported")).toHaveTextContent("旧格式，不支持");
    expect(screen.getByText(/1 个是旧格式、现在的程序打不开，1 个正被别的服务占用、这里打不开/)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "打开" })).toHaveLength(0);
  });

  it("数据格式与这个程序对不上的任务：版本一栏照后端给的字样写（需要升级、需要处理、需要更新的程序），原因写在完成条件一栏，打不开", async () => {
    const row = (id: string, unavailable: string, note: string) => ({ ...base, task_id: id, task_name: id, unavailable, supported: false, note });
    vi.spyOn(api, "listTasks").mockResolvedValue([
      row("T1", "需要升级", "这个任务是上一版建的，数据还没有升级。重新启动程序后升级。"),
      row("T2", "需要处理", "这个任务的数据升级没有做成：任务库读不出来"),
      row("T3", "需要更新的程序", "这份数据由 0.7.0 写入，请用 0.7.0 或更新的版本打开。"),
      { ...base, task_id: "TASK-OLD", task_name: "TASK-OLD", unavailable: "旧格式", supported: false, note: "旧格式" },
    ]);
    render(<ConfigProvider><AntApp><TaskListPage /></AntApp></ConfigProvider>);
    await screen.findByTestId("task-unsupported");
    expect(screen.getAllByTestId("task-format").map((el) => el.textContent)).toEqual(["需要升级", "需要处理", "需要更新的程序"]);
    expect(screen.getByText("这个任务的数据升级没有做成：任务库读不出来")).toBeTruthy();
    expect(screen.getByText(/一共 4 个任务，1 个是旧格式、现在的程序打不开，3 个的数据要先处理才能打开。/)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "打开" })).toHaveLength(0);
  });

  it("打得开的任务没有状态：一栏写发布过几版；按最近活动排，最近的在前（时刻的写法带不同时区也按时刻比）", async () => {
    const open = (id: string, at: string, count: number, published: string | null) => ({ ...base, task_id: id, task_name: `任务 ${id}`, unavailable: null, supported: true,
      item_count: 3, completion_total: 2, completion_unmet: 0, session_count: 1, last_active_at: at, version_count: count, latest_published_at: published });
    vi.spyOn(api, "listTasks").mockResolvedValue([
      open("T1", "2026-10-14T01:00:00-07:00", 0, null),
      open("T2", "2026-10-14T09:30:00Z", 2, "2026-10-14T01:35:00-07:00"),
      open("T3", "2026-10-13T20:00:00-07:00", 1, "2026-10-13T19:00:00-07:00"),
    ]);
    render(<ConfigProvider><AntApp><TaskListPage /></AntApp></ConfigProvider>);
    await screen.findByTestId("task-versions-T1");
    const rows = screen.getAllByRole("row").slice(1).map((one) => within(one).getByText(/^任务 T/).textContent);
    expect(rows).toEqual(["任务 T2", "任务 T1", "任务 T3"]);
    expect(screen.getByTestId("task-versions-T1")).toHaveTextContent(/^未发布$/);
    expect(screen.getByTestId("task-versions-T2")).toHaveTextContent(/^已发布 2 版 · 最近发布 /);
    expect(screen.getAllByRole("columnheader").map((one) => one.textContent)).not.toContain("状态");
    expect(screen.getByText(/^一共 3 个任务。/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/进行中|已完成/);
    expect([versionsText({ version_count: 0, latest_published_at: null }), versionsText({ version_count: 1, latest_published_at: null })]).toEqual(["未发布", "已发布 1 版"]);
  });
});
