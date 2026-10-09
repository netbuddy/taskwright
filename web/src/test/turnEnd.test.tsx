// 一轮被用户停下、或者因为出错停下时，对话区在这一轮的摘要行下面加一行琥珀色的说明；这一轮保存过修订时带「产生了修订 N」小标签。
// 正常做完、做完了但没有回复的一轮不加这一行。结束原因来自摘要（刷新后重算的与实时推送的相同）；实时的时候，
// 后端的摘要到达之前页面按 work_ended 先拼一条，也带上结束原因。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { ConversationMessage, SavedFacts, WorkSummary } from "../api/types";
import { Conversation, FAILED_NOTE, LIMIT_NOTE, NOTHING_SAVED_NOTE, stoppedNote } from "../components/work/Conversation";
import { initialWorkState, workReducer } from "../state/workState";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const noop = () => {};

function show(outcome: string, revisions: number[] = [], onRevisionTag = vi.fn(), saved?: SavedFacts | null) {
  const summary: WorkSummary = { type: "work_summary", message_id: "summary-u1", work_id: "w-u1", at: "", seconds: 7, step_count: 1,
    stages: [{ text: "写好并保存了修订 2：新增功能用例 1 个（UC-002）" }], outcome, ...(saved !== undefined ? { saved } : {}) } as WorkSummary;
  const messages = [{ type: "user_message", message_id: "u1", at: "", text: "请慢慢做" }, summary] as ConversationMessage[];
  const revisionsOfWork = vi.fn((workId: string) => (workId === "w-u1" ? revisions : []));
  render(<Wrap><Conversation messages={messages} currentWork={null} outgoing={[]} task={null} disabled={false} disabledReason={null}
    handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop} hasEarlier={false}
    onLoadEarlier={noop} revisionOf={() => null} attachments={[]} revisionsOfWork={revisionsOfWork} onRevisionTag={onRevisionTag} /></Wrap>);
  return onRevisionTag;
}

describe("一轮怎样结束：摘要行下面的说明", () => {
  it("被停下而保存过一次修订：按后端算出的事实写修订号与条目个数、怎样撤销；带「产生了修订 2」，点它打开修订页签", () => {
    const onTag = show("stopped_by_user", [2], vi.fn(), { revisions: [2], items: 1, diagrams: 0 });
    expect(screen.getByTestId("work-end-note").textContent).toBe("这一次工作保存了修订 2（1 个条目），保留着；停下时正在做的那一步没有完成。要撤销它，到右侧「修订」页签撤销。");
    expect(screen.getByTestId("work-end-note")).toHaveClass("stopnote");
    fireEvent.click(screen.getByTestId("work-end-revisions"));
    expect(onTag).toHaveBeenCalledWith([2]);
    expect(screen.getByTestId("work-end-revisions")).toHaveTextContent("产生了修订 2");
  });

  it("被停下而保存过几次修订和图：修订写成区间，括号里是条目个数与图的张数，另说图不能撤销", () => {
    show("stopped_by_user", [3, 4, 5], vi.fn(), { revisions: [3, 4, 5], items: 4, diagrams: 1 });
    expect(screen.getByTestId("work-end-note").textContent).toBe(
      "这一次工作保存了修订 3 到 5（4 个条目、1 张图），都保留着；停下时正在做的那一步没有完成。要撤销其中某条，到右侧「修订」页签逐条撤销。图的改动不能撤销，可以让助手改回去。");
    expect(screen.getByTestId("work-end-revisions")).toHaveTextContent("产生了修订 3、4、5");
  });

  it("被停下而什么都没有保存：只有一句「这一次工作没有保存任何东西。」，不带小标签", () => {
    show("stopped_by_user", [], vi.fn(), { revisions: [], items: 0, diagrams: 0 });
    expect(screen.getByTestId("work-end-note").textContent).toBe(NOTHING_SAVED_NOTE);
    expect(NOTHING_SAVED_NOTE).toBe("这一次工作没有保存任何东西。");
    expect(screen.queryByTestId("work-end-revisions")).toBeNull();
  });

  it("停止说明的几种写法：只保存了图；修订不连着时逐个列；摘要没有带保存了什么（旧数据、后端没法查）时按修订日志写、不写个数", () => {
    expect(stoppedNote({ revisions: [], items: 0, diagrams: 2 })).toBe("这一次工作保存了 2 张图，都保留着；停下时正在做的那一步没有完成。图的改动不能撤销，可以让助手改回去。");
    expect(stoppedNote({ revisions: [2, 4], items: 3, diagrams: 0 })).toBe("这一次工作保存了修订 2、4（3 个条目），都保留着；停下时正在做的那一步没有完成。要撤销其中某条，到右侧「修订」页签逐条撤销。");
    expect(stoppedNote(undefined, [2, 3])).toBe("这一次工作保存了修订 2 到 3，都保留着；停下时正在做的那一步没有完成。要撤销其中某条，到右侧「修订」页签逐条撤销。");
    expect(stoppedNote(null, [])).toBe(NOTHING_SAVED_NOTE);
    // 后端算出的与修订日志不一致时以后端算出的为准（修订日志可能还没有读回来）。
    expect(stoppedNote({ revisions: [7], items: 2, diagrams: 0 }, [])).toBe("这一次工作保存了修订 7（2 个条目），保留着；停下时正在做的那一步没有完成。要撤销它，到右侧「修订」页签撤销。");
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

  it("助手连续被拒到上限、由系统停下：固定的一句，不写内部的原因；保存过修订时带小标签", () => {
    show("stopped_by_limit", []);
    expect(screen.getByTestId("work-end-note")).toHaveTextContent(/^这一轮助手一直没有按规矩回答，系统让它停下了。已经保存的修订保留着；你可以再说一句，让它重新来。$/);
    expect(screen.getByTestId("work-end-note").textContent).toBe(LIMIT_NOTE);
    expect(screen.queryByTestId("work-end-revisions")).toBeNull();
    cleanup();
    show("stopped_by_limit", [3]);
    expect(screen.getByTestId("work-end-revisions")).toHaveTextContent("产生了修订 3");
  });

  it("正常做完、做完了但没有回复、旧数据没有结束原因：不加这一行", () => {
    for (const outcome of ["replied", "no_reply", undefined]) {
      show(outcome as string, [2]);
      expect(screen.getByTestId("work-summary")).toHaveTextContent("助手做了 1 步");
      expect(screen.queryByTestId("work-end-note")).toBeNull();
      expect(screen.queryByTestId("work-end-revisions")).toBeNull();
      cleanup();
    }
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
