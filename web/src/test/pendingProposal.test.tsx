// 输入框上方的「待决定」一行：整份数据的 stage.proposal 不为空时出现，写「待决定 · 助手已提议进入某阶段」加一个按钮；
// 按钮上的字是那张卡片进入项的字，点了与点卡片上的进入项发同一个请求；没有开着的提议、任务不能再发话时不出现或者点不了。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { ConversationMessage, StageProposal, Task } from "../api/types";
import { Conversation } from "../components/work/Conversation";
import { PENDING_LABEL, PendingProposal, enterRequest, pendingParts } from "../components/work/PendingProposal";
import { LIBRARY_EVENTS } from "../api/types";
import { overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
const noop = () => {};
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const PROPOSAL: StageProposal = { stage: "clarifying", enter: { key: "enter_clarify", text: "进入澄清" }, stay: { key: "continue_reading", text: "继续本阶段" },
  text: "材料核读完了，进入澄清吗？", items: [], session_id: "sess-first", reply_message_id: "reply-far", event_seq: 12, at: "2026-01-01T09:00:00" };
const LAMPS = { reading: [], clarifying: [], modeling: [], writing: [], reviewing: [] };
const taskWith = (proposal: StageProposal | null): Task => ({ ...overallTask(), stage: { current: "reading", moved_by: null, moved_at: null, reason: null, lamps: LAMPS, proposal } });
function chat(task: Task | null, over: Record<string, unknown> = {}) {
  const onMessage = vi.fn();
  render(<Wrap><Conversation messages={[] as ConversationMessage[]} currentWork={null} outgoing={[]} task={task}
    disabled={false} disabledReason={null} handlers={{ onAction: noop, onMessage }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop}
    hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} {...over} /></Wrap>);
  return onMessage;
}

describe("「待决定」一行", () => {
  it("四个阶段各自的写法；点按钮发出去的与点卡片上的进入项相同", () => {
    expect(PENDING_LABEL).toBe("待决定");
    expect((["clarifying", "modeling", "writing", "reviewing"] as const).map((stage) => pendingParts({ stage }).join(""))).toEqual(
      ["助手已提议进入澄清阶段", "助手已提议进入整理建模阶段", "助手已提议进入写条目阶段", "助手已提议进入评审确认阶段"]);
    expect(enterRequest(PROPOSAL)).toEqual(["我选：进入澄清", { reply_message_id: "reply-far", kind: "choose", choice: "enter_clarify" }]);
    expect(enterRequest({ ...PROPOSAL, enter: { key: "start_items", text: "开始写条目" }, reply_message_id: null })).toEqual(
      ["我选：开始写条目", { reply_message_id: "", kind: "choose", choice: "start_items" }]);
  });

  it("提议开着：输入框上方多一行，阶段名加重，按钮上是卡片进入项的字；点了发那一句，这一条提议不能再点第二次", () => {
    const onMessage = chat(taskWith(PROPOSAL));
    const row = screen.getByTestId("pending-proposal");
    expect(row).toHaveTextContent("待决定助手已提议进入澄清阶段进入澄清");
    expect(row.querySelector("b")).toHaveTextContent(/^澄清$/);
    expect(row).toHaveAttribute("data-stage", "clarifying");
    // 排在输入框之前。
    expect(row.compareDocumentPosition(screen.getByTestId("chat-input")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const button = screen.getByTestId("pending-enter");
    expect(button).toHaveTextContent(/^进入澄清$/);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onMessage.mock.calls).toEqual([["我选：进入澄清", { reply_message_id: "reply-far", kind: "choose", choice: "enter_clarify" }]]);
    expect(button).toBeDisabled();
  });

  it("没有发出去：按钮放开，可以再点", async () => {
    const onMessage = vi.fn().mockResolvedValue(false);
    render(<Wrap><PendingProposal proposal={PROPOSAL} onMessage={onMessage} /></Wrap>);
    fireEvent.click(screen.getByTestId("pending-enter"));
    await vi.waitFor(() => expect(screen.getByTestId("pending-enter")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("pending-enter"));
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("没有开着的提议、任务没有阶段、任务已经不能发话：不画这一行；助手正在工作时画着但点不了", () => {
    chat(taskWith(null));
    expect(screen.queryByTestId("pending-proposal")).toBeNull();
    cleanup();
    chat({ ...overallTask(), stage: null });
    expect(screen.queryByTestId("pending-proposal")).toBeNull();
    cleanup();
    chat(taskWith(PROPOSAL), { disabled: true, disabledReason: "任务已经完成，对话区只读。" });
    expect(screen.queryByTestId("pending-proposal")).toBeNull();
    cleanup();
    const onMessage = chat(taskWith(PROPOSAL), { working: true });
    expect(screen.getByTestId("pending-enter")).toBeDisabled();
    fireEvent.click(screen.getByTestId("pending-enter"));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("助手发出进入卡片的库事件在页面订阅的事件名里：别的会话里开着的页面据它带的 stage 画出这一行", () => {
    expect(LIBRARY_EVENTS).toContain("stage_proposed");
  });
});
