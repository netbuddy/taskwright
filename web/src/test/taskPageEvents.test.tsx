// 任务页的会话卡片与「最近一次活动」：任务页开一条不带会话的事件连接，只听执行者状态；助手做完一轮（从工作中变为别的状态）时
// 重读任务。重新连上时重读一次。任务已经结束时不开；离开页面时断开。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { act } from "react";
import { api } from "../api/client";
import { openEventStream, type StreamHandlers } from "../api/events";
import type { TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { TaskPage } from "../pages/TaskPage";

vi.mock("../api/events", async (original) => ({ ...(await original<typeof import("../api/events")>()), openEventStream: vi.fn() }));

let handlers: StreamHandlers | null = null;
const close = vi.fn();
beforeEach(() => {
  handlers = null;
  close.mockReset();
  (openEventStream as Mock).mockImplementation((_url: string, _last: () => number | null, h: StreamHandlers) => { handlers = h; return close; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); (openEventStream as Mock).mockReset(); });

function detail(count: number, at: string, status = "进行中"): TaskDetail {
  return {
    task_id: "TASK-E", task_name: "事件", task_type: "演示", domain_tag: null, status, started_at: "2026-09-28T01:00:00Z", ended_at: null,
    definition: { collections: [] }, completion: null, items: [], latest_revision: 0, materials: [],
    sessions: [{ session_id: "S1", name: "整理材料", started_at: "2026-09-28T01:00:00Z", last_active_at: at, message_count: count, active: true }],
  } as unknown as TaskDetail;
}

function open(first: TaskDetail) {
  const get = vi.spyOn(api, "getTask").mockResolvedValue(first);
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  vi.spyOn(api, "serviceInfo").mockRejectedValue(new Error("没有这个接口"));
  const view = render(<ConfigProvider><AntApp><ToastProvider><ServiceProvider><TaskPage taskId="TASK-E" /></ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
  return { get, view };
}
const executor = (state: string) => act(() => handlers!.onMessage({ event: "executor_state", id: null, data: { state, text: "", active_session: "S1" } }));

describe("任务页随助手做完一轮更新", () => {
  it("连接不带会话；从工作中变为空闲时重读，会话卡片换成新的消息条数", async () => {
    const { get } = open(detail(4, "2026-09-28T01:05:00Z"));
    expect(await screen.findByText(/4 条消息/)).toBeInTheDocument();
    await waitFor(() => expect(handlers).not.toBeNull());
    expect((openEventStream as Mock).mock.calls[0][0]).toBe("/api/v1/tasks/TASK-E/events");
    expect(get).toHaveBeenCalledTimes(1);
    get.mockResolvedValue(detail(10, "2026-09-28T01:15:00Z"));
    executor("working");
    expect(get).toHaveBeenCalledTimes(1);
    executor("idle");
    expect(await screen.findByText(/10 条消息/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("没有从工作中离开（空闲到空闲）时不重读；刚连上时收到的第一条非工作中状态重读一次；别的事件不看", async () => {
    const { get } = open(detail(4, "2026-09-28T01:05:00Z"));
    await waitFor(() => expect(handlers).not.toBeNull());
    act(() => handlers!.onMessage({ event: "deliverable_changed", id: "3", data: { seq: 3 } }));
    expect(get).toHaveBeenCalledTimes(1);
    executor("idle");
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    executor("idle");
    executor("exited");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("重新连上时重读一次，第一次连上不重读", async () => {
    const { get } = open(detail(4, "2026-09-28T01:05:00Z"));
    await waitFor(() => expect(handlers).not.toBeNull());
    act(() => handlers!.onStatus?.("open"));
    expect(get).toHaveBeenCalledTimes(1);
    act(() => { handlers!.onStatus?.("reconnecting"); handlers!.onStatus?.("connecting"); handlers!.onStatus?.("open"); });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("离开页面时断开连接", async () => {
    const { view } = open(detail(4, "2026-09-28T01:05:00Z"));
    await waitFor(() => expect(handlers).not.toBeNull());
    expect(close).not.toHaveBeenCalled();
    view.unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("任务已经结束（已完成、已放弃）时不开这条连接", async () => {
    for (const status of ["已完成", "已放弃"]) {
      open(detail(4, "2026-09-28T01:05:00Z", status));
      expect(await screen.findByText(/4 条消息/)).toBeInTheDocument();
      expect(openEventStream).not.toHaveBeenCalled();
      cleanup(); vi.restoreAllMocks();
    }
  });
});
