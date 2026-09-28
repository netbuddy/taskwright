// 助手没有在运行时的工作视图：已经退出、正在启动、续接失败之后都不设只读，只在输入框上方给一条蓝色提示；
// 助手启动不起来（failed_to_start）仍然整页只读，并写明原因。页面不显示后端给维护者看的内部说明。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type { ExecutorState, Task } from "../api/types";
import { ToastProvider } from "../components/Toasts";
import { EXITED_HINT, STARTING_AFTER_SEND_HINT, STARTING_HINT, STARTING_SEND_TITLE, executorHint } from "../components/work/executorHint";
import { WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState, type OutgoingMessage } from "../state/workState";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider>{children}</ToastProvider></AntApp></ConfigProvider>
);

const task: Task = {
  task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
  definition: { collections: [{ name: "用例", prefix: "UC", fields: [{ name: "名称", type: "文本", required: true, values: null }] }] },
  completion: null,
  items: [{ item_id: "UC-001", collection: "用例", title: "买家申请退款", revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1],
    fields: { 名称: "买家申请退款" }, sources: [], reviews: [], confirmations: [], confirmation_stale: false }],
} as unknown as Task;

function page(executor: ExecutorState, outgoing: OutgoingMessage[] = []) {
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  (useWorkView as Mock).mockReturnValue({
    state: { ...initialWorkState("S1"), phase: "ready", task, executor, outgoing },
    log: [], dispatch: vi.fn(), stream: "open", loadError: null, reload: vi.fn(),
  });
  render(<Wrap><WorkViewPage taskId="TASK-001" sessionId="S1" /></Wrap>);
}

const INTERNAL = "pi 进程退出了";

describe("助手没有在运行时的工作视图", () => {
  it("已经退出：不设只读，发送可用；输入框上方一条蓝色提示，只写固定的一句，不带后端的内部说明", () => {
    page({ state: "exited", text: `助手已经退出，下一次说话时会重新启动。（${INTERNAL}）`, active_session: "S1" });
    const hint = screen.getByTestId("executor-hint");
    expect(hint.textContent).toBe(EXITED_HINT);
    expect(hint).toHaveClass("info");
    expect(screen.queryByTestId("busy-note")).toBeNull();
    expect(screen.getByTestId("chat-input")).not.toBeDisabled();
    expect(screen.getByTestId("send")).not.toHaveClass("off");
    expect(document.body.textContent).not.toContain(INTERNAL);
    expect(document.body.textContent).not.toContain("助手现在不可用");
  });

  it("用户刚说了一句、助手正在启动：提示说启动好之后会接着处理，发送按钮暂不可用，输入框照常可以打字", () => {
    page({ state: "starting", text: "助手正在启动。", active_session: "S1" }, [{ client_id: "c-1", text: "再整理一条", state: "sending" }]);
    expect(screen.getByTestId("executor-hint").textContent).toBe(STARTING_AFTER_SEND_HINT);
    expect(screen.getByTestId("send")).toHaveClass("off");
    expect(screen.getByTestId("send")).toHaveAttribute("title", STARTING_SEND_TITLE);
    expect(screen.getByTestId("chat-input")).not.toBeDisabled();
  });

  it("续接会话失败之后（not_started）：显示后端的那句说明，不设只读", () => {
    page({ state: "not_started", text: "助手没有接上这条会话，下一次说话时会重新启动。", active_session: null });
    expect(screen.getByTestId("executor-hint").textContent).toBe("助手没有接上这条会话，下一次说话时会重新启动。");
    expect(screen.getByTestId("chat-input")).not.toBeDisabled();
  });

  it("助手启动不起来（failed_to_start）：仍然整页只读，写明原因", () => {
    page({ state: "failed_to_start", text: "助手没有启动起来。（没有配置模型）", active_session: null });
    expect(screen.getByTestId("busy-note")).toHaveTextContent("助手现在不可用：助手没有启动起来。（没有配置模型）");
    expect(screen.queryByTestId("executor-hint")).toBeNull();
    expect(screen.getByTestId("chat-input")).toBeDisabled();
    expect(screen.getByTestId("send")).toHaveClass("off");
  });

  it("提示的取法：空闲与工作中没有提示；正在启动但用户没有刚发的话时是一般的一句", () => {
    expect(executorHint({ state: "idle", text: "", active_session: "S1" }, false)).toBeNull();
    expect(executorHint({ state: "working", text: "", active_session: "S1" }, true)).toBeNull();
    expect(executorHint({ state: "starting", text: "", active_session: "S1" }, false)).toBe(STARTING_HINT);
    expect(executorHint(null, false)).toBeNull();
  });
});
