// 打开一条不存在的会话：整份数据读不到、后端说「没有」，并且任务读得到而会话列表里没有这条会话时，显示两行说明与回到任务页的链接，
// 照常带顶栏，文字里不带会话编号；任务本身读不到或别的读取失败，照旧写「读不到这条会话的数据」。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type { TaskDetail } from "../api/types";
import { ToastProvider } from "../components/Toasts";
import { WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState } from "../state/workState";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider>{children}</ToastProvider></AntApp></ConfigProvider>
);

const detail = (sessions: string[]) => ({
  task_id: "TASK-001", task_name: "图书馆借还", sessions: sessions.map((id) => ({ session_id: id, name: id })), materials: [],
}) as unknown as TaskDetail;

function page(loadError: string, loadErrorCode: string) {
  (useWorkView as Mock).mockReturnValue({
    state: initialWorkState("S-GONE"), log: [], dispatch: vi.fn(), stream: "open", loadError, loadErrorCode, reload: vi.fn(),
  });
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  return render(<Wrap><WorkViewPage taskId="TASK-001" sessionId="S-GONE" /></Wrap>);
}

describe("找不到会话的页面", () => {
  it("任务在、会话列表里没有这条：两行说明、回到任务页的链接、顶栏上的任务名；不带会话编号", async () => {
    vi.spyOn(api, "getTask").mockResolvedValue(detail(["S-1", "S-2"]));
    page("这个任务里没有会话 S-GONE。", "not_found");
    const box = await screen.findByTestId("missing-session");
    expect(box).toHaveTextContent("找不到这条会话。还没有说过话的会话，在你打开别的会话之后不会保留。");
    expect(screen.getByTestId("missing-session-back")).toHaveTextContent("回到任务页");
    expect(screen.getByTestId("missing-session-back")).toHaveAttribute("href", expect.stringContaining("TASK-001"));
    expect(box.querySelector(".topbar")).toHaveTextContent("图书馆借还");
    expect(box).not.toHaveTextContent("S-GONE");
    expect(box).not.toHaveTextContent("读不到这条会话的数据");
  });

  it("任务本身不在（读任务也说没有）：照旧写读不到这条会话的数据", async () => {
    const get = vi.spyOn(api, "getTask").mockRejectedValue(new ApiError("not_found", "没有任务 TASK-001。", 404));
    page("没有任务 TASK-001。", "not_found");
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.getByText("读不到这条会话的数据：没有任务 TASK-001。")).toBeInTheDocument();
    expect(screen.queryByTestId("missing-session")).toBeNull();
  });

  it("会话在列表里（例如别的原因说没有）：不套用这两行", async () => {
    const get = vi.spyOn(api, "getTask").mockResolvedValue(detail(["S-GONE"]));
    page("没有这个接口。", "not_found");
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId("missing-session")).toBeNull();
    expect(screen.getByText("读不到这条会话的数据：没有这个接口。")).toBeInTheDocument();
  });

  it("别的读取失败（连不上服务）：照旧，不去读任务", () => {
    const get = vi.spyOn(api, "getTask");
    page("连不上服务，请检查服务是否在运行。", "network");
    expect(screen.getByText("读不到这条会话的数据：连不上服务，请检查服务是否在运行。")).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});
