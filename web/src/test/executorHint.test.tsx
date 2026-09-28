// 助手没有在运行时的工作视图：已经退出、正在启动、续接失败之后都不设只读，只在输入框上方给一条蓝色提示；
// 助手启动不起来（failed_to_start）仍然整页只读，并写明原因。页面不显示后端给维护者看的内部说明。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type { ExecutorState, Snapshot, Task } from "../api/types";
import { ToastProvider } from "../components/Toasts";
import { DISABLED_PLACEHOLDER, INPUT_PLACEHOLDER } from "../components/work/Conversation";
import { EXITED_HINT, STARTING_AFTER_SEND_HINT, STARTING_HINT, STARTING_SEND_TITLE, executorHint } from "../components/work/executorHint";
import { WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState, workReducer, type OutgoingMessage } from "../state/workState";

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

function page(executor: ExecutorState, outgoing: OutgoingMessage[] = [], shown: Task = task) {
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  (useWorkView as Mock).mockReturnValue({
    state: { ...initialWorkState("S1"), phase: "ready", task: shown, executor, outgoing },
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
    page({ state: "failed_to_start", text: "助手没有启动起来，没有配置模型", active_session: null });
    expect(screen.getByTestId("busy-note")).toHaveTextContent("助手现在不可用：助手没有启动起来，没有配置模型");
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

  it("输入框整个停用时，占位文字不再重复提示条里的那句：助手不可用、任务已经结束、助手在另一条会话里工作三种情形相同", () => {
    const cases: [ExecutorState, Task, string][] = [
      [{ state: "failed_to_start", text: "助手没有启动起来，系统原因：EACCES", active_session: null }, task, "助手现在不可用：助手没有启动起来，系统原因：EACCES"],
      [{ state: "idle", text: "", active_session: "S1" }, { ...task, status: "已完成" } as Task, "这个任务已经结束，只能查看。"],
      [{ state: "working", text: "", active_session: "S2" }, task, "助手正在另一条会话里工作，做完才能在这里继续。"],
    ];
    for (const [executor, shown, note] of cases) {
      page(executor, [], shown);
      expect(screen.getByTestId("busy-note").textContent).toBe(note);
      const input = screen.getByTestId("chat-input");
      expect(input).toBeDisabled();
      expect(input).toHaveAttribute("placeholder", DISABLED_PLACEHOLDER);
      expect(input.getAttribute("placeholder")).not.toContain(note);
      cleanup();
    }
  });

  it("输入框可用时占位文字是平常的那句", () => {
    page({ state: "idle", text: "", active_session: "S1" });
    expect(screen.getByTestId("chat-input")).toHaveAttribute("placeholder", INPUT_PLACEHOLDER);
  });

  it("打开或刷新页面时助手启动不起来：快照照常带着对话与条目，页面整页只读、显示原因，对话与条目照常显示", () => {
    // 后端这时照常返回快照，执行者状态是 failed_to_start、文字带原因；这里用页面自己的归约函数把它变成页面状态。
    const snapshot: Snapshot = {
      seq: 4, generated_at: "", session: { session_id: "S1", name: "整理材料", started_at: "", last_active_at: "" } as Snapshot["session"],
      executor: { state: "failed_to_start", text: "助手没有启动起来，系统原因：EACCES", active_session: null },
      task, materials: [], current_work: null,
      conversation: { has_earlier: false, earliest_id: null, messages: [
        { type: "user_message", message_id: "u1", at: "", text: "请整理材料", origin: "typed", annotation: null, queued: false },
        { type: "assistant_reply", message_id: "a1", at: "", work_id: null, via_reply_tool: true, informs: [], act: null, text: "整理好了。" },
      ] as Snapshot["conversation"]["messages"] },
    };
    const state = workReducer(initialWorkState("S1"), { type: "snapshot", snapshot });
    vi.spyOn(api, "listSessions").mockResolvedValue([]);
    (useWorkView as Mock).mockReturnValue({ state, log: [], dispatch: vi.fn(), stream: "open", loadError: null, reload: vi.fn() });
    render(<Wrap><WorkViewPage taskId="TASK-001" sessionId="S1" /></Wrap>);
    expect(screen.getByTestId("busy-note").textContent).toBe("助手现在不可用：助手没有启动起来，系统原因：EACCES");
    expect(screen.getByTestId("chat-input")).toBeDisabled();
    const conversation = screen.getByTestId("conversation");
    expect(conversation).toHaveTextContent("请整理材料");
    expect(conversation).toHaveTextContent("整理好了。");
    expect(document.body.textContent).toContain("买家申请退款");
    expect(document.body.textContent).not.toContain("读不到这条会话的数据");
  });
});
