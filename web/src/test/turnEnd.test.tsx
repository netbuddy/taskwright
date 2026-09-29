// 一轮被用户停下、或者因为出错停下时，对话区在这一轮的摘要行下面加一行琥珀色的说明；这一轮保存过修订时带「产生了修订 N」小标签。
// 正常做完、做完了但没有回复的一轮不加这一行。结束原因来自摘要（刷新后重算的与实时推送的相同）；实时的时候，
// 后端的摘要到达之前页面按 work_ended 先拼一条，也带上结束原因。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { ConversationMessage, WorkSummary } from "../api/types";
import { Conversation, FAILED_NOTE, stoppedNote } from "../components/work/Conversation";
import { initialWorkState, workReducer } from "../state/workState";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const noop = () => {};

function show(outcome: string, revisions: number[] = [], onRevisionTag = vi.fn()) {
  const summary: WorkSummary = { type: "work_summary", message_id: "summary-u1", work_id: "w-u1", at: "", seconds: 7, step_count: 1,
    stages: [{ text: "写好并保存了修订 2：新增功能用例 1 个（UC-002）" }], outcome } as WorkSummary;
  const messages = [{ type: "user_message", message_id: "u1", at: "", text: "请慢慢做" }, summary] as ConversationMessage[];
  const revisionsOfWork = vi.fn((workId: string) => (workId === "w-u1" ? revisions : []));
  render(<Wrap><Conversation messages={messages} currentWork={null} outgoing={[]} task={null} disabled={false} disabledReason={null}
    handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop} hasEarlier={false}
    onLoadEarlier={noop} revisionOf={() => null} attachments={[]} revisionsOfWork={revisionsOfWork} onRevisionTag={onRevisionTag} /></Wrap>);
  return onRevisionTag;
}

describe("一轮怎样结束：摘要行下面的说明", () => {
  it("被停下而保存过一次修订：写明是你让它停下的、修订 2 保留着；带「产生了修订 2」，点它打开修订页签", () => {
    const onTag = show("stopped_by_user", [2]);
    expect(screen.getByTestId("work-end-note")).toHaveTextContent(/^这一轮是你让助手停下的。已经保存的修订 2 保留着；停下时它正在做的那一步没有做完，没有保存。$/);
    expect(screen.getByTestId("work-end-note")).toHaveClass("stopnote");
    fireEvent.click(screen.getByTestId("work-end-revisions"));
    expect(onTag).toHaveBeenCalledWith([2]);
    expect(screen.getByTestId("work-end-revisions")).toHaveTextContent("产生了修订 2");
  });

  it("被停下而保存过两次修订：修订号都列上", () => {
    show("stopped_by_user", [2, 3]);
    expect(screen.getByTestId("work-end-note")).toHaveTextContent("已经保存的修订 2、3 保留着");
    expect(screen.getByTestId("work-end-revisions")).toHaveTextContent("产生了修订 2、3");
  });

  it("被停下而没有保存修订：中间一句换成「这一轮还没有保存任何修订」，不带小标签", () => {
    show("stopped_by_user", []);
    expect(screen.getByTestId("work-end-note")).toHaveTextContent(/^这一轮是你让助手停下的。这一轮还没有保存任何修订；停下时它正在做的那一步没有做完，没有保存。$/);
    expect(screen.queryByTestId("work-end-revisions")).toBeNull();
  });

  it("出错停下：固定的一句；保存过修订时带小标签", () => {
    show("failed", [4]);
    expect(screen.getByTestId("work-end-note")).toHaveTextContent(/^这一轮因为出错停下了，助手没有做完。已经保存的修订保留着；你可以再说一句，让它接着做。$/);
    expect(screen.getByTestId("work-end-revisions")).toHaveTextContent("产生了修订 4");
    cleanup();
    show("failed", []);
    expect(screen.getByTestId("work-end-note").textContent).toBe(FAILED_NOTE);
    expect(screen.queryByTestId("work-end-revisions")).toBeNull();
  });

  it("正常做完、做完了但没有回复、旧数据没有结束原因：不加这一行", () => {
    for (const outcome of ["replied", "no_reply", undefined]) {
      show(outcome as string, [2]);
      expect(screen.getByTestId("work-summary")).toHaveTextContent("助手做了 1 步");
      expect(screen.queryByTestId("work-end-note")).toBeNull();
      expect(screen.queryByTestId("work-end-revisions")).toBeNull();
      cleanup();
    }
    expect(stoppedNote([])).toBe("这一轮是你让助手停下的。这一轮还没有保存任何修订；停下时它正在做的那一步没有做完，没有保存。");
  });
});

describe("实时：后端的摘要到达之前按 work_ended 先拼的那条也带结束原因", () => {
  it("work_ended 带 stopped_by_user：先拼的摘要记下它；后端的摘要随后到达时换成后端的", () => {
    let state = initialWorkState("S1");
    state = workReducer(state, { type: "sse", event: "work_started", data: { session_id: "S1", work_id: "w-1", at: "", triggered_by: null } });
    state = workReducer(state, { type: "sse", event: "work_ended", data: { session_id: "S1", work_id: "w-1", at: "", seconds: 7, step_count: 1, outcome: "stopped_by_user" } });
    const first = state.messages.find((m) => m.type === "work_summary") as WorkSummary;
    expect(first.outcome).toBe("stopped_by_user");
    state = workReducer(state, { type: "sse", event: "work_summary", data: { session_id: "S1", work_id: "w-1", at: "", seconds: 7.2, step_count: 1, stages: [], outcome: "stopped_by_user" } });
    const summaries = state.messages.filter((m) => m.type === "work_summary") as WorkSummary[];
    expect(summaries.map((s) => [s.outcome, s.seconds])).toEqual([["stopped_by_user", 7.2]]);
  });
});
