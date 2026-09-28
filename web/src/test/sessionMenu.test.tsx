// 工作视图的会话菜单：每条会话的「最近活动」与消息条数在助手做完一轮时（执行者状态从工作中变为不在工作）、以及打开菜单时重读，
// 不停在打开页面的那一刻。不用定时轮询。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type { ExecutorState, SessionListEntry, Task } from "../api/types";
import { ToastProvider } from "../components/Toasts";
import { WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState } from "../state/workState";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider>{children}</ToastProvider></AntApp></ConfigProvider>
);

const task = {
  task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
  definition: { collections: [{ name: "用例", prefix: "UC", fields: [{ name: "名称", type: "文本", required: true, values: null }] }] },
  completion: null, items: [],
} as unknown as Task;

const session = (count: number, at: string): SessionListEntry =>
  ({ session_id: "S1", name: "整理材料", started_at: "2026-09-28T01:00:00Z", last_active_at: at, message_count: count, active: true }) as SessionListEntry;

function view(executor: ExecutorState) {
  (useWorkView as Mock).mockReturnValue({
    state: { ...initialWorkState("S1"), phase: "ready", task, executor },
    log: [], dispatch: vi.fn(), stream: "open", loadError: null, reload: vi.fn(),
  });
  return <Wrap><WorkViewPage taskId="TASK-001" sessionId="S1" /></Wrap>;
}
const WORKING: ExecutorState = { state: "working", text: "", active_session: "S1" };
const IDLE: ExecutorState = { state: "idle", text: "", active_session: "S1" };
const menu = () => screen.getByTestId("session-menu");

describe("会话菜单的最近活动与消息条数", () => {
  it("助手做完一轮（工作中变为空闲）时重读会话列表", async () => {
    const list = vi.spyOn(api, "listSessions").mockResolvedValue([session(4, "2026-09-28T01:05:00Z")]);
    const { rerender } = render(view(WORKING));
    await waitFor(() => expect(menu()).toHaveTextContent("4 条消息"));
    list.mockResolvedValue([session(10, "2026-09-28T01:15:00Z")]);
    rerender(view(IDLE));
    await waitFor(() => expect(menu()).toHaveTextContent("10 条消息"));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("打开会话菜单时重读一次；收起时不读", async () => {
    const list = vi.spyOn(api, "listSessions").mockResolvedValue([session(4, "2026-09-28T01:05:00Z")]);
    render(view(IDLE));
    await waitFor(() => expect(menu()).toHaveTextContent("4 条消息"));
    list.mockResolvedValue([session(7, "2026-09-28T01:09:00Z")]);
    fireEvent.click(screen.getByTestId("session-menu-button"));
    await waitFor(() => expect(menu()).toHaveTextContent("7 条消息"));
    expect(list).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId("session-menu-button"));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("状态没有从工作中离开（空闲到空闲、空闲到工作中）时不重读", async () => {
    const list = vi.spyOn(api, "listSessions").mockResolvedValue([session(4, "2026-09-28T01:05:00Z")]);
    const { rerender } = render(view(IDLE));
    await waitFor(() => expect(menu()).toHaveTextContent("4 条消息"));
    rerender(view({ ...IDLE, text: "助手空闲，可以开始。" }));
    rerender(view(WORKING));
    await waitFor(() => expect(screen.getByTestId("session-menu-button")).toBeInTheDocument());
    expect(list).toHaveBeenCalledTimes(1);
  });
});
