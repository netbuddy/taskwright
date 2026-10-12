// 「任务状况」卡：程序据任务记录算出来的定位。各行的写法；两个按钮；三处出现的办法——新建会话的开头（会话里一条消息都没有、
// 任务里已经有主题页）、输入框旁的「任务状况」入口、输入框里打「/状况」。后两种在对话里本地插一行「界面操作：用户调出任务状况」与卡，不发给助手。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { ConversationMessage, StageProposal, Task, TaskStatusView } from "../api/types";
import { Conversation } from "../components/work/Conversation";
import { TaskStatusCard } from "../components/work/TaskStatusCard";
import {
  NEW_SESSION_LINE, STATUS_CALLED_LINE, STATUS_NEXT_TEXT, activityLine, descriptionLine, itemsLine, missingLine, modelsLine, nobodySpoke, shortMoment, statusSubtitle,
  wantsOpeningStatus,
} from "../model/taskStatus";
import { overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
const noop = () => {};
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const PROPOSAL: StageProposal = { stage: "writing", enter: { key: "start_items", text: "开始写条目" }, stay: { key: "continue_consolidate", text: "继续本阶段" },
  text: "这几页整理好了，开始写条目吗？", items: [], session_id: "sess-first", reply_message_id: "reply-far", event_seq: 31, at: "2026-10-10T15:40:00" };
const STATUS: TaskStatusView = {
  generated_at: "2026-10-11T16:20:03",
  activity: { kind: "stage", key: "modeling", name: "整理建模", ordinal: 3, flow: "initial", moved_by: "user", moved_at: "2026-10-10T11:02:00", reason: "用户在卡片上选了「进入整理建模」" },
  description: { sections: 16, chapters: [{ no: 2, name: "角色", sections: 2 }, { no: 3, name: "业务流程", sections: 6 }, { no: 4, name: "业务对象", sections: 6 }, { no: 6, name: "业务目标", sections: 2 }],
    unsorted: 0, open_questions: 1 },
  models: [{ kind: "context", name: "系统边界图", count: 1 }, { kind: "use_case", name: "用例图", count: 1 }, { kind: "flowchart", name: "流程图", count: 6 }],
  items: [{ collection: "功能用例", total: 0, viewed: 0 }, { collection: "约束", total: 0, viewed: 0 }],
  missing: [{ key: "roles_in_context_and_use_cases", summary: "有 1 页标签为「角色」的主题还没有画进用例图：OA-003。" }, { key: "rules_no_conflict", summary: "还有 1 对规则冲突没有了结。" }],
  proposal: PROPOSAL, versions: [],
};
const LAMPS = { reading: [], clarifying: [], modeling: [], writing: [], reviewing: [], document: [] };
const taskWith = (proposal: StageProposal | null = PROPOSAL): Task => ({ ...overallTask(), stage: { current: "modeling", moved_by: "user", moved_at: "2026-10-10T11:02:00", reason: "", lamps: LAMPS, proposal } });
const reply = (id: string, text: string) => ({ type: "assistant_reply", message_id: id, at: "", work_id: null, via_reply_tool: true, informs: [], act: null, text });
const said = (id: string, text: string) => ({ type: "user_message", message_id: id, at: "", text, origin: "typed", annotation: null, queued: false });
function chat(task: Task | null, messages: unknown[] = [], over: Record<string, unknown> = {}) {
  const onMessage = vi.fn(), onSend = vi.fn(), loadStatus = vi.fn().mockResolvedValue(STATUS);
  render(<Wrap><Conversation messages={messages as ConversationMessage[]} currentWork={null} outgoing={[]} task={task}
    disabled={false} disabledReason={null} handlers={{ onAction: noop, onMessage }} onSend={onSend} onUndo={noop} onOpenItem={noop} onAttach={noop}
    hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} loadStatus={loadStatus} {...over} /></Wrap>);
  return { onMessage, onSend, loadStatus };
}

describe("状况卡各行的写法", () => {
  it("阶段、业务说明、模型、需求条目、这一段还差", () => {
    expect(shortMoment("2026-10-11T16:20:03")).toBe("10-11 16:20");
    expect(statusSubtitle(STATUS)).toBe("程序据任务记录生成 · 10-11 16:20");
    expect(activityLine(STATUS.activity)).toBe("整理建模（第 3 阶段）· 10-10 11:02 由你移入");
    expect(activityLine({ ...STATUS.activity, moved_by: "executor" })).toBe("整理建模（第 3 阶段）· 10-10 11:02 由助手移入");
    expect(activityLine({ ...STATUS.activity, key: "reading", name: "核读材料", ordinal: 1, moved_by: null, moved_at: null, reason: null })).toBe("核读材料（第 1 阶段）· 任务从这个阶段开始");
    expect(descriptionLine(STATUS.description)).toEqual({ text: "16 节：角色 2 · 业务流程 6 · 业务对象 6 · 业务目标 2", open: "1 处待澄清" });
    expect(descriptionLine({ sections: 3, chapters: [{ no: 3, name: "业务流程", sections: 2 }], unsorted: 1, open_questions: 0 })).toEqual({ text: "3 节：业务流程 2 · 未归类 1", open: null });
    expect(descriptionLine({ sections: 0, chapters: [], unsorted: 0, open_questions: 0 })).toEqual({ text: "尚未开始", open: null });
    expect(modelsLine(STATUS.models)).toBe("系统边界图 1 · 用例图 1 · 流程图 6");
    expect(modelsLine([])).toBe("尚未开始");
    expect(itemsLine(STATUS.items)).toBe("尚未开始");
    expect(itemsLine([{ collection: "功能用例", total: 12, viewed: 8 }, { collection: "约束", total: 0, viewed: 0 }, { collection: "非功能需求", total: 3, viewed: 3 }]))
      .toBe("功能用例 12 条，已确认 8 条 · 非功能需求 3 条，已确认 3 条");
    // 没有通过的灯各取编号清单前面的半句，用分号接起来。
    expect(missingLine(STATUS.missing)).toBe("有 1 页标签为「角色」的主题还没有画进用例图；还有 1 对规则冲突没有了结");
    expect(missingLine([])).toBe("这一段的几项都齐了");
  });

  it("卡上依次是这几行；有开着的提议时多一行「待决定」与进入按钮；「开展一项活动」的位置留着但不显示", () => {
    const onMessage = vi.fn(), onSend = vi.fn();
    render(<Wrap><TaskStatusCard status={STATUS} liveProposal={PROPOSAL} onMessage={onMessage} onSend={onSend} /></Wrap>);
    const card = screen.getByTestId("task-status");
    expect(card).toHaveAttribute("data-activity", "modeling");
    expect(card.querySelector(".k")).toHaveTextContent("任务状况 程序据任务记录生成 · 10-11 16:20");
    expect([...card.querySelectorAll(".row b")].map((b) => b.textContent)).toEqual(["阶段", "业务说明", "模型", "需求条目", "这一段还差", "待决定"]);
    expect(screen.getByTestId("status-description")).toHaveTextContent("16 节：角色 2 · 业务流程 6 · 业务对象 6 · 业务目标 2；1 处待澄清");
    expect(screen.getByTestId("status-description").querySelector("em")).toHaveTextContent("1 处待澄清");
    expect(screen.getByTestId("status-proposal")).toHaveTextContent("待决定助手已提议进入写条目阶段");
    expect(screen.getByTestId("status-activities")).not.toBeVisible();
    // 进入按钮与输入框上方那一行的按钮是同一个请求；「请助手说明下一步」发那句固定的话。各自点过一次就不能再点。
    fireEvent.click(screen.getByTestId("status-enter"));
    fireEvent.click(screen.getByTestId("status-enter"));
    expect(onMessage.mock.calls).toEqual([["我选：开始写条目", { reply_message_id: "reply-far", kind: "choose", choice: "start_items" }]]);
    fireEvent.click(screen.getByTestId("status-next"));
    fireEvent.click(screen.getByTestId("status-next"));
    expect(onSend.mock.calls).toEqual([["请按任务状况说明下一步该做什么。"]]);
    expect(STATUS_NEXT_TEXT).toBe("请按任务状况说明下一步该做什么。");
  });

  it("没有开着的提议：没有「待决定」一行，只有「请助手说明下一步」；卡上的提议已经结束时进入按钮点不了", () => {
    render(<Wrap><TaskStatusCard status={{ ...STATUS, proposal: null }} liveProposal={null} onMessage={noop} onSend={noop} /></Wrap>);
    expect(screen.queryByTestId("status-proposal")).toBeNull();
    expect(screen.queryByTestId("status-enter")).toBeNull();
    expect(screen.getByTestId("status-next")).toHaveTextContent(/^请助手说明下一步$/);
    cleanup();
    const onMessage = vi.fn();
    render(<Wrap><TaskStatusCard status={STATUS} liveProposal={null} onMessage={onMessage} onSend={noop} /></Wrap>);
    expect(screen.getByTestId("status-enter")).toBeDisabled();
    cleanup();
    // 助手后来发了一条新的提议：卡上那一条也算结束了。
    render(<Wrap><TaskStatusCard status={STATUS} liveProposal={{ ...PROPOSAL, event_seq: 40 }} onMessage={onMessage} onSend={noop} /></Wrap>);
    expect(screen.getByTestId("status-enter")).toBeDisabled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("新建会话的开头", () => {
  it("判法：任务有阶段、在进行中、这条会话里还没有人说过话、任务里已经有在用的主题页", () => {
    const task = taskWith();
    // 会话一开头系统放的任务现状说明、界面操作的通知不算有人说过话。
    expect(nobodySpoke([])).toBe(true);
    expect(nobodySpoke([{ type: "system_note" }, { type: "ui_action_noted" }])).toBe(true);
    expect([nobodySpoke([{ type: "system_note" }, { type: "user_message" }]), nobodySpoke([{ type: "assistant_reply" }])]).toEqual([false, false]);
    expect(wantsOpeningStatus(task, 0, 0, false, false)).toBe(true);
    expect(wantsOpeningStatus(task, 1, 0, false, false)).toBe(false);     // 已经有消息
    expect(wantsOpeningStatus(task, 0, 1, false, false)).toBe(false);     // 有一句正在发送
    expect(wantsOpeningStatus(task, 0, 0, true, false)).toBe(false);      // 更早还有一段
    expect(wantsOpeningStatus(task, 0, 0, false, true)).toBe(false);      // 任务已经结束或者助手不可用
    expect(wantsOpeningStatus({ ...task, stage: null }, 0, 0, false, false)).toBe(false);                                   // 没有阶段的任务
    expect(wantsOpeningStatus({ ...task, items: task.items.filter((i) => i.collection !== "总体分析") }, 0, 0, false, false)).toBe(false);   // 新任务，还没有主题页
    expect(wantsOpeningStatus(null, 0, 0, false, false)).toBe(false);
  });

  it("对话区第一条是一行小字加状况卡，排在会话开头那条任务现状说明之前", async () => {
    const NOTE = { type: "system_note", message_id: "n0", at: "", kind: "task_status", text: "任务现状：总体分析 16 页。", details: null };
    const { loadStatus } = chat(taskWith(), [NOTE]);
    const opening = await screen.findByTestId("status-opening");
    expect(loadStatus).toHaveBeenCalledTimes(1);
    expect(within(opening).getByTestId("new-session-line")).toHaveTextContent(NEW_SESSION_LINE);
    expect(NEW_SESSION_LINE).toBe("新建会话 · 助手从干净的上下文开始，交付物还是这一份");
    expect(within(opening).getByTestId("task-status")).toBeInTheDocument();
    expect(screen.queryByTestId("status-called")).toBeNull();
  });

  it("会话里已经有消息、或者任务还没有主题页：不放，也不去取状况", async () => {
    const { loadStatus } = chat(taskWith(), [said("u1", "接着做"), reply("r1", "好的。")]);
    await Promise.resolve();
    expect(screen.queryByTestId("status-opening")).toBeNull();
    expect(loadStatus).not.toHaveBeenCalled();
    cleanup();
    const fresh = taskWith();
    const second = chat({ ...fresh, items: fresh.items.filter((i) => i.collection !== "总体分析") });
    await Promise.resolve();
    expect(screen.queryByTestId("status-opening")).toBeNull();
    expect(second.loadStatus).not.toHaveBeenCalled();
  });
});

describe("随时调出", () => {
  it("点输入框旁的「任务状况」：在当时最后一条消息后面插一行界面操作与卡，不发给助手；再点一次再插一张", async () => {
    const { onSend, onMessage, loadStatus } = chat(taskWith(), [said("u1", "接着做"), reply("r1", "好的。")]);
    const button = screen.getByTestId("status-button");
    expect(button).toHaveTextContent(/^任务状况$/);
    fireEvent.click(button);
    const called = await screen.findByTestId("status-called");
    expect(within(called).getByTestId("status-called-line")).toHaveTextContent(STATUS_CALLED_LINE);
    expect(STATUS_CALLED_LINE).toBe("界面操作：用户调出任务状况");
    expect(within(called).getByTestId("task-status")).toBeInTheDocument();
    // 排在最后一条回复之后。
    expect(screen.getByTestId("assistant-reply").compareDocumentPosition(called) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    fireEvent.click(button);
    await vi.waitFor(() => expect(screen.getAllByTestId("status-called")).toHaveLength(2));
    expect(loadStatus).toHaveBeenCalledTimes(2);
  });

  it("输入框里打「/状况」再发送：与点入口相同，输入框清空，那一句不发给助手；别的斜杠开头的话照常发", async () => {
    const { onSend } = chat(taskWith(), [reply("r1", "好的。")]);
    const input = screen.getByTestId("chat-input");
    fireEvent.change(input, { target: { value: " /状况 " } });
    fireEvent.click(screen.getByTestId("send"));
    expect(await screen.findByTestId("status-called")).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "/状况 是什么意思" } });
    fireEvent.click(screen.getByTestId("send"));
    expect(onSend.mock.calls).toEqual([["/状况 是什么意思"]]);
  });

  it("没有阶段的任务、没有给取状况的函数：没有入口，「/状况」照普通的话发出去", () => {
    const { onSend } = chat({ ...overallTask(), stage: null });
    expect(screen.queryByTestId("status-button")).toBeNull();
    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "/状况" } });
    fireEvent.click(screen.getByTestId("send"));
    expect(onSend.mock.calls).toEqual([["/状况"]]);
    cleanup();
    chat(taskWith(), [], { loadStatus: undefined });
    expect(screen.queryByTestId("status-button")).toBeNull();
  });

  it("取不到状况：什么都不插", async () => {
    chat(taskWith(), [reply("r1", "好的。")], { loadStatus: vi.fn().mockResolvedValue(null) });
    fireEvent.click(screen.getByTestId("status-button"));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByTestId("status-called")).toBeNull();
  });
});
