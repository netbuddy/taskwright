// 任务列表：任务没有状态，按最近活动排，「进展」一栏写流程到了哪一站、几个工作项、几条阻断；
// 正被别的服务占用的任务照样列出，灰显、打不开，进展一栏写明被哪个端口的服务占用。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api, ApiError } from "../api/client";
import type { TaskDetail, TaskListEntry } from "../api/types";
import { TaskListPage } from "../pages/TaskListPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const base = { task_type: "需求工程", domain_tag: null, item_count: null, completion_met: null, completion_total: null,
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

  it("数据格式与这个程序对不上的任务：进展一栏照后端给的字样写（需要升级、需要处理、需要更新的程序），原因写在完成条件一栏，打不开", async () => {
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

  it("打得开的任务没有状态：「进展」一栏写流程到了哪一站、几个工作项、几条阻断（有才写），没有流程写「未启动流程」；不写版本；按最近活动排，最近的在前（时刻的写法带不同时区也按时刻比）", async () => {
    const open = (id: string, at: string, flow: TaskListEntry["flow"], items: number, blocking: number) => ({ ...base, task_id: id, task_name: `任务 ${id}`, unavailable: null,
      supported: true, item_count: 3, completion_total: 2, completion_unmet: 0, session_count: 1, last_active_at: at, flow, work_item_count: items, blocking_count: blocking,
      version_count: 2, latest_published_at: "2026-10-14T01:35:00-07:00" });
    vi.spyOn(api, "listTasks").mockResolvedValue([
      open("T1", "2026-10-14T01:00:00-07:00", null, 0, 0),
      open("T2", "2026-10-14T09:30:00Z", { name: "需求分析", node: "writing", node_name: "写条目", ordinal: 4 }, 2, 2),
      open("T3", "2026-10-13T20:00:00-07:00", null, 1, 0),
    ]);
    render(<ConfigProvider><AntApp><TaskListPage /></AntApp></ConfigProvider>);
    await screen.findByTestId("task-progress-T1");
    const rows = screen.getAllByRole("row").slice(1).map((one) => within(one).getByText(/^任务 T/).textContent);
    expect(rows).toEqual(["任务 T2", "任务 T1", "任务 T3"]);
    expect(screen.getByTestId("task-progress-T2")).toHaveTextContent(/^需求分析 · 第 4 站写条目 · 2 个工作项 · 2 条阻断$/);
    expect(screen.getByTestId("task-progress-T1")).toHaveTextContent(/^未启动流程 · 0 个工作项$/);
    expect(screen.getByTestId("task-progress-T3")).toHaveTextContent(/^未启动流程 · 1 个工作项$/);
    const headers = screen.getAllByRole("columnheader").map((one) => one.textContent);
    expect(headers).toContain("进展");
    expect(headers.filter((one) => one === "状态" || one === "版本")).toEqual([]);
    expect(document.body.textContent).not.toMatch(/已发布|未发布|进行中|已完成/);
    expect(screen.getByText(/^一共 3 个任务。/)).toBeTruthy();
  });
});

describe("删除任务", () => {
  const row = { ...base, task_id: "T1", task_name: "一次性的任务", unavailable: null, supported: true, item_count: 2, completion_total: 1, completion_unmet: 0,
    session_count: 1, last_active_at: "2026-10-14T01:00:00-07:00", version_count: 1, latest_published_at: "2026-10-14T00:30:00-07:00" } as TaskListEntry;
  const detail = { task_id: "T1", task_name: "一次性的任务", items: [{ item_id: "UC-001" }, { item_id: "OA-001" }], versions: [{ version_no: 1 }],
    materials: [{ path: "inputs/a.docx", derived_from: null }, { path: "inputs/a.docx.md", derived_from: "inputs/a.docx" }, { path: "inputs/b.md", derived_from: null }] } as unknown as TaskDetail;

  async function openDialog() {
    vi.spyOn(api, "listTasks").mockResolvedValue([row]);
    const get = vi.spyOn(api, "getTask").mockResolvedValue(detail);
    render(<ConfigProvider><AntApp><TaskListPage /></AntApp></ConfigProvider>);
    fireEvent.click(await screen.findByTestId("task-menu-T1"));
    fireEvent.click(await screen.findByText("删除任务"));
    expect(await screen.findByTestId("delete-task-text")).toHaveTextContent("这个任务有 2 份材料、2 个条目、1 版发布，删除后不能恢复。");
    return get;
  }

  it("菜单里点「删除任务」：确认框写明材料（不算生成的文件）、条目、发布各几，「先导出存档」是这个任务的数据包下载，点「取消」什么都不删", async () => {
    const get = await openDialog();
    expect(get).toHaveBeenCalledWith("T1");
    expect(screen.getByText("删除任务「一次性的任务」？")).toBeInTheDocument();
    expect(screen.getByTestId("delete-task-export")).toHaveAttribute("href", "/api/v1/tasks/T1/export");
    expect(screen.getByTestId("delete-task-export-note")).toHaveTextContent("先导出存档：导出这个任务的需求资产与对话记录，不含材料与知识库的原件，也不含运行日志；含摘录、转述与对话全文。以后可以再导入，导入后重新上传材料即可补齐。不导出也可以直接删除。");
    const remove = vi.spyOn(api, "deleteTask");
    fireEvent.click(screen.getByRole("button", { name: /^取\s?消$/ }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByTestId("task-progress-T1")).toBeInTheDocument();
  });

  it("点「删除」：请任务服务删除，这一行从列表里去掉；不要求先导出", async () => {
    await openDialog();
    const remove = vi.spyOn(api, "deleteTask").mockResolvedValue({ ok: true, task_id: "T1" });
    fireEvent.click(screen.getByTestId("delete-task-confirm"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("T1"));
    await waitFor(() => expect(screen.queryByTestId("task-progress-T1")).toBeNull());
  });

  it("被拒（助手正在工作）：照任务服务的原话写在确认框里，这一行留着", async () => {
    await openDialog();
    vi.spyOn(api, "deleteTask").mockRejectedValue(new ApiError("session_busy", "助手正在工作，请先停止助手，再删除这个任务。", 409));
    fireEvent.click(screen.getByTestId("delete-task-confirm"));
    expect(await screen.findByTestId("delete-task-error")).toHaveTextContent("助手正在工作，请先停止助手，再删除这个任务。");
    expect(screen.getByTestId("task-progress-T1")).toBeInTheDocument();
  });
});
