// 打开会话时助手正在启动：整份数据还没到、事件流说正在启动时，对话区写「助手正在启动，请稍候。」；
// 读整份数据被拒（正在启动、正在另一条会话里工作）时整页写正在等、会自动重试，不写「读不到这条会话的数据」。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { TaskDetail } from "../api/types";
import { ToastProvider } from "../components/Toasts";
import { WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState } from "../state/workState";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function page(view: { executor?: "starting" | "idle"; loadError?: string; loadErrorCode?: string }) {
  const state = { ...initialWorkState("S-1"), executor: view.executor ? { state: view.executor, text: "", active_session: null } : null };
  (useWorkView as Mock).mockReturnValue({ state, log: [], dispatch: vi.fn(), stream: "open", loadError: view.loadError ?? null, loadErrorCode: view.loadErrorCode ?? null, reload: vi.fn() });
  vi.spyOn(api, "getTask").mockResolvedValue({ task_id: "TASK-001", task_name: "图书馆借还", sessions: [], materials: [] } as unknown as TaskDetail);
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  render(<ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><WorkViewPage taskId="TASK-001" sessionId="S-1" /></ToastProvider></AntApp></ConfigProvider>);
}

describe("打开会话时助手正在启动", () => {
  it("整份数据还没到：事件流说正在启动时写「助手正在启动，请稍候。」，别的时候写「正在读这条会话。」", () => {
    page({ executor: "starting" });
    expect(screen.getByTestId("snapshot-waiting")).toHaveTextContent("助手正在启动，请稍候。");
    cleanup();
    page({ executor: "idle" });
    expect(screen.getByTestId("snapshot-waiting")).toHaveTextContent("正在读这条会话。");
  });

  it("读整份数据被拒、会自动重试：整页写正在等，不写读不到", () => {
    page({ loadError: "助手正在启动，请稍候。", loadErrorCode: "executor_starting" });
    expect(screen.getByTestId("snapshot-load-error")).toHaveTextContent("助手正在启动，几秒后自动重试。");
    expect(screen.queryByText(/读不到这条会话的数据/)).toBeNull();
    cleanup();
    page({ loadError: "助手正在另一条会话里工作，做完才能在这里继续。", loadErrorCode: "session_busy" });
    expect(screen.getByTestId("snapshot-load-error")).toHaveTextContent("助手正在另一条会话里工作，做完之后自动打开这条会话。");
    cleanup();
    page({ loadError: "等了太久没有得到回应。", loadErrorCode: "timeout" });
    expect(screen.getByTestId("snapshot-load-error")).toHaveTextContent("读不到这条会话的数据：等了太久没有得到回应。");
  });
});
