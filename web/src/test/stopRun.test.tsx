// 从界面停止助手正在进行的这一次工作：助手在这条会话里工作时，输入框右边的发送键换成停止键（一个实心小方块），点它调停止接口，
// 之后是「正在停止」、不能再点，工作结束换回发送键；停下之后会话里留的那条界面操作通知画成「你停止了助手这一次的工作」；
// 之后重新打开这条会话时，任务状况消息折叠成的那一行写「上次被停止」。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { ApiError, api } from "../api/client";
import type { ConversationMessage, CurrentWork, ExecutorState, Task } from "../api/types";
import { ToastProvider } from "../components/Toasts";
import { Conversation, STOP_NOTE_TEXT, STOP_TITLE, STOPPING_TITLE, TURN_TEXT } from "../components/work/Conversation";
import { statusNoteLine } from "../model/statusNote";
import { WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState } from "../state/workState";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider>{children}</ToastProvider></AntApp></ConfigProvider>
);
const noop = () => {};
const WORK: CurrentWork = { work_id: "w-u1", started_at: "", triggered_by: "u1", steps: [{ work_id: "w-u1", step_key: 1, text: "正在保存修订", in_progress: true, failed: false }] } as CurrentWork;

function conversation(props: { working: boolean; onStop?: () => Promise<boolean>; currentWork?: CurrentWork | null; messages?: ConversationMessage[]; hold?: boolean; onSend?: () => void }) {
  return (
    <Wrap><Conversation messages={props.messages ?? []} currentWork={props.currentWork === undefined ? WORK : props.currentWork} outgoing={[]} task={null}
      disabled={false} disabledReason={null} handlers={{ onAction: noop, onMessage: noop }} onSend={props.onSend ?? noop} onUndo={noop} hold={props.hold} onOpenItem={noop} onAttach={noop}
      hasEarlier={false} onLoadEarlier={noop} revisionOf={() => 7} attachments={[]} working={props.working} onStop={props.onStop} /></Wrap>
  );
}

describe("停止键：助手工作时发送键换成它", () => {
  it("只在助手于这条会话里工作时出现，占发送键的位置：没有在工作时是发送键；在另一条会话里工作（页面不给停止的做法）时仍是灰的发送键", () => {
    const onStop = vi.fn(async () => true);
    const view = render(conversation({ working: true, onStop }));
    const key = screen.getByTestId("stop-run");
    expect(key).toHaveClass("send", "stop");
    expect(key).not.toHaveClass("off", "stopping");
    expect(key).toHaveAttribute("title", STOP_TITLE);
    expect(STOP_TITLE).toBe("停止助手这一次的工作");
    expect(screen.queryByTestId("send")).toBeNull();
    view.rerender(conversation({ working: false, onStop, currentWork: null }));
    expect(screen.queryByTestId("stop-run")).toBeNull();
    expect(screen.getByTestId("send")).toHaveTextContent("↑");
    view.rerender(conversation({ working: true }));
    expect(screen.queryByTestId("stop-run")).toBeNull();
    expect(screen.getByTestId("send")).toHaveClass("off");
    expect(screen.getByTestId("send")).toHaveAttribute("title", TURN_TEXT);
  });

  it("进行中那一块旁边没有按钮；助手刚开始工作、第一行过程还没有到时不画那一块，停止键照样在", () => {
    const view = render(conversation({ working: true, onStop: async () => true }));
    expect(screen.getByTestId("work-live").querySelector("button")).toBeNull();
    expect(document.querySelectorAll("[data-testid=stop-run]").length).toBe(1);
    view.rerender(conversation({ working: true, onStop: async () => true, currentWork: null }));
    expect(screen.queryByTestId("work-live")).toBeNull();
    expect(screen.getByTestId("stop-run")).toBeInTheDocument();
  });

  it("点击调一次停止并进入「正在停止」，再点不重复调；工作结束后换回发送键，下一次工作又是可以点的停止键", async () => {
    let done: (ok: boolean) => void = noop;
    const onStop = vi.fn(() => new Promise<boolean>((resolve) => (done = resolve)));
    const view = render(conversation({ working: true, onStop }));
    fireEvent.click(screen.getByTestId("stop-run"));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("stop-run")).toHaveClass("stopping");
    expect(screen.getByTestId("stop-run")).toHaveAttribute("title", STOPPING_TITLE);
    expect(screen.getByTestId("stop-run")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByTestId("stop-run"));
    expect(onStop).toHaveBeenCalledTimes(1);
    await act(async () => done(true));
    expect(screen.getByTestId("stop-run")).toHaveClass("stopping");
    view.rerender(conversation({ working: false, onStop, currentWork: null }));
    expect(screen.queryByTestId("stop-run")).toBeNull();
    expect(screen.getByTestId("send")).not.toHaveClass("off");
    view.rerender(conversation({ working: true, onStop }));
    expect(screen.getByTestId("stop-run")).not.toHaveClass("stopping");
    expect(screen.getByTestId("stop-run")).toHaveAttribute("title", STOP_TITLE);
  });

  it("停止的请求没有做成：恢复成可以点的停止键", async () => {
    const onStop = vi.fn(async () => false);
    render(conversation({ working: true, onStop }));
    await act(async () => { fireEvent.click(screen.getByTestId("stop-run")); });
    expect(screen.getByTestId("stop-run")).not.toHaveClass("stopping");
    await act(async () => { fireEvent.click(screen.getByTestId("stop-run")); });
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("有未保存的条目编辑时停止键照样可以点", () => {
    const onStop = vi.fn(async () => true);
    render(conversation({ working: true, onStop, hold: true }));
    expect(screen.getByTestId("stop-run")).not.toHaveClass("off", "stopping");
    fireEvent.click(screen.getByTestId("stop-run"));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("工作中在输入框里按回车：不停止，也不发送，打的字留着", () => {
    const onStop = vi.fn(async () => true);
    const onSend = vi.fn();
    render(conversation({ working: true, onStop, onSend }));
    const input = screen.getByTestId("chat-input");
    fireEvent.change(input, { target: { value: "先把话打好" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onStop).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("先把话打好");
    expect(screen.getByTestId("stop-run")).not.toHaveClass("stopping");
  });
});

describe("停下之后的界面操作通知与折叠行", () => {
  it("种类是 stop_run 的通知画成「你停止了助手这一次的工作」：不显示写给助手看的原文，没有撤销", () => {
    const raw = "界面操作（不是用户打的字）：用户在界面上停止了你这一次的工作，停下时正在做的那一步没有做完。";
    const messages = [{ type: "ui_action_noted", message_id: "n1", at: "", text: raw, event_seq: null, undoable: false, revision_no: null, kind: "stop_run" }] as ConversationMessage[];
    render(conversation({ working: false, currentWork: null, messages }));
    expect(screen.getByTestId("stop-note").textContent).toBe(STOP_NOTE_TEXT);
    // 停止通知与别的界面操作记号同是居中的一行小字，另带 stop 这个类名，样式里给它琥珀色。
    expect(screen.getByTestId("stop-note")).toHaveClass("selfnote", "stop");
    expect(STOP_NOTE_TEXT).toBe("你停止了助手这一次的工作");
    expect(document.body.textContent).not.toContain("不是用户打的字");
    expect(screen.queryByTestId("undo-link")).toBeNull();
    expect(screen.queryByTestId("ui-action")).toBeNull();
  });

  it("续接的任务状况消息带 last_run_stopped：折叠行的要点最前面写「上次被停止」；不带或为假时不写", () => {
    const note = (details: Record<string, unknown>) => statusNoteLine({ kind: "task_status", text: "接着这条会话继续时（10:00:00），上次之后交付物的变化：", details });
    expect(note({ kind: "变化", last_run_stopped: true, added: [], updated: [], deleted: [] })).toBe("助手续接这条会话时看到的变化：上次被停止");
    expect(note({ kind: "变化", last_run_stopped: true, added: ["UC-2"], updated: [], deleted: [] })).toBe("助手续接这条会话时看到的变化：上次被停止、新增 1 条");
    expect(note({ kind: "变化", last_run_stopped: false, added: ["UC-2"] })).toBe("助手续接这条会话时看到的变化：新增 1 条");
    expect(note({ kind: "变化", added: ["UC-2"] })).toBe("助手续接这条会话时看到的变化：新增 1 条");
  });
});

describe("工作视图里的停止键", () => {
  const task = { task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, started_at: "",
    definition: { collections: [{ name: "用例", prefix: "UC", fields: [{ name: "名称", type: "文本", required: true, values: null }] }] }, completion: null, items: [] } as unknown as Task;
  function page(executor: ExecutorState) {
    vi.spyOn(api, "listSessions").mockResolvedValue([]);
    (useWorkView as Mock).mockReturnValue({
      state: { ...initialWorkState("S1"), phase: "ready", task, executor, currentWork: WORK },
      log: [], dispatch: vi.fn(), stream: "open", loadError: null, reload: vi.fn(),
    });
    render(<Wrap><WorkViewPage taskId="TASK-001" sessionId="S1" /></Wrap>);
  }

  it("助手在这条会话里工作：点停止键对这条会话调停止接口", async () => {
    const control = vi.spyOn(api, "control").mockResolvedValue({ ok: true, cleared: [] });
    page({ state: "working", text: "助手正在工作。", active_session: "S1" });
    await act(async () => { fireEvent.click(screen.getByTestId("stop-run")); });
    expect(control.mock.calls).toEqual([["TASK-001", "S1", "stop"]]);
    expect(screen.getByTestId("stop-run")).toHaveClass("stopping");
  });

  it("停止接口报错：提示「没有停下来」加原因，停止键恢复", async () => {
    vi.spyOn(api, "control").mockRejectedValue(new ApiError("executor_unavailable", "助手现在不可用。"));
    page({ state: "working", text: "助手正在工作。", active_session: "S1" });
    await act(async () => { fireEvent.click(screen.getByTestId("stop-run")); });
    expect(document.body.textContent).toContain("没有停下来：助手现在不可用。");
    expect(screen.getByTestId("stop-run")).not.toHaveClass("stopping");
  });

  it("助手在另一条会话里工作、或者没有在工作：没有停止键", () => {
    page({ state: "working", text: "助手正在工作。", active_session: "S2" });
    expect(screen.queryByTestId("stop-run")).toBeNull();
    cleanup();
    page({ state: "idle", text: "助手空闲，可以开始。", active_session: "S1" });
    expect(screen.queryByTestId("stop-run")).toBeNull();
  });
});
