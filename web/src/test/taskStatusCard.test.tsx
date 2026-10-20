// 「工作进展」卡（早先叫任务状况卡）：程序据任务记录算出来的定位。各行的写法；两个按钮；「开展一项活动」一节已经退役；
// 会话开头那一行（「新会话 · 属于工作项「X」（启动的时刻）」或「新会话 · 自由讨论（不绑定活动）」）；三处出现的办法——新建会话的开头
// （会话里一条消息都没有）、输入框旁的「工作进展」入口、输入框里打「/状况」。后两种在对话里本地插一行「界面操作：用户调出工作进展」与卡，不发给助手。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { ConversationMessage, StageProposal, Task, TaskStatusView, WorkItemBrief } from "../api/types";
import { Conversation } from "../components/work/Conversation";
import { TaskStatusCard } from "../components/work/TaskStatusCard";
import {
  FREE_SESSION_LINE, STATUS_CALLED_LINE, STATUS_NEXT_TEXT, activityLine, descriptionLine, itemsLine, missingLine, modelsLine, nobodySpoke, shortMoment, statusTitle,
  assetLine, launchNote, recommendedFlow, versionLine, workItemsLine,
  newSessionLine, wantsOpeningStatus,
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
  activity: { kind: "stage", key: "modeling", name: "整理建模", ordinal: 3, flow: "analysis", moved_by: "user", moved_at: "2026-10-10T11:02:00", reason: "用户在卡片上选了「进入整理建模」" },
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

describe("工作进展卡各行的写法", () => {
  it("本会话、业务说明、模型、需求条目、这一段还差", () => {
    expect(shortMoment("2026-10-11T16:20:03")).toBe("10-11 16:20");
    expect(statusTitle(STATUS)).toBe("工作进展 · 10-11 16:20");
    expect(activityLine(STATUS.activity)).toBe("需求分析 · 第 3 站「整理建模」 · 10-10 11:02 进入");
    // 早先记下的流程键 initial 也读成需求分析。
    expect(activityLine({ ...STATUS.activity, flow: "initial" })).toBe("需求分析 · 第 3 站「整理建模」 · 10-10 11:02 进入");
    expect(activityLine({ ...STATUS.activity, key: "reading", name: "核读材料", ordinal: 1, moved_by: null, moved_at: null, reason: null })).toBe("需求分析 · 第 1 站「核读材料」");
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

  it("卡上依次是这几行；有开着的提议时多一行「待决定」与进入按钮", () => {
    const onMessage = vi.fn(), onSend = vi.fn();
    render(<Wrap><TaskStatusCard status={STATUS} liveProposal={PROPOSAL} onMessage={onMessage} onSend={onSend} /></Wrap>);
    const card = screen.getByTestId("task-status");
    expect(card).toHaveAttribute("data-activity", "modeling");
    expect(card.querySelector(".k")).toHaveTextContent("工作进展 · 10-11 16:20 程序据任务记录生成");
    expect([...card.querySelectorAll(".row b")].map((b) => b.textContent)).toEqual(["本会话", "业务说明", "模型", "需求条目", "这一段还差", "待决定"]);
    expect(screen.getByTestId("status-description")).toHaveTextContent("16 节：角色 2 · 业务流程 6 · 业务对象 6 · 业务目标 2；1 处待澄清");
    expect(screen.getByTestId("status-description").querySelector("em")).toHaveTextContent("1 处待澄清");
    expect(screen.getByTestId("status-proposal")).toHaveTextContent("待决定助手已提议进入写条目这一步");
    expect(screen.queryByTestId("status-activities")).toBeNull();
    // 进入按钮与输入框上方那一行的按钮是同一个请求；「请助手汇报当前状况」发那句固定的话。各自点过一次就不能再点。
    fireEvent.click(screen.getByTestId("status-enter"));
    fireEvent.click(screen.getByTestId("status-enter"));
    expect(onMessage.mock.calls).toEqual([["我选：开始写条目", { reply_message_id: "reply-far", kind: "choose", choice: "start_items" }]]);
    fireEvent.click(screen.getByTestId("status-next"));
    fireEvent.click(screen.getByTestId("status-next"));
    expect(onSend.mock.calls).toEqual([["请按任务状况说明下一步该做什么。"]]);
    expect(STATUS_NEXT_TEXT).toBe("请按任务状况说明下一步该做什么。");
  });

  it("开着的是请过目的提议：写补写了几处，按钮是「看过了，生成文档」，点了不发话，交给页面处理", async () => {
    const review: StageProposal = { ...PROPOSAL, kind: "review", stage: "document", enter: { key: "document_reviewed", text: "看过了，生成文档" },
      stay: { key: "document_revise", text: "需要修改" }, items: [{ item_id: "OA-020", revision_no: 1 }, { item_id: "OA-021", revision_no: 1 }] };
    const onMessage = vi.fn(), onReviewed = vi.fn().mockResolvedValue(true);
    render(<Wrap><TaskStatusCard status={{ ...STATUS, proposal: review }} liveProposal={review} onMessage={onMessage} onSend={noop} onReviewed={onReviewed} /></Wrap>);
    expect(screen.getByTestId("status-proposal")).toHaveTextContent("待决定补写的 2 处待过目");
    expect(screen.getByTestId("status-enter")).toHaveTextContent(/^看过了，生成文档$/);
    fireEvent.click(screen.getByTestId("status-enter"));
    expect(onReviewed.mock.calls).toEqual([["reply-far", review.items]]);
    expect(onMessage).not.toHaveBeenCalled();
    // 退回的提议写「退回」。
    cleanup();
    const back: StageProposal = { ...PROPOSAL, kind: "back", stage: "clarifying", enter: { key: "back_to_clarify", text: "退回澄清" }, stay: { key: "stay_in_stage", text: "留在本段" } };
    render(<Wrap><TaskStatusCard status={{ ...STATUS, proposal: back }} liveProposal={back} onMessage={onMessage} onSend={noop} /></Wrap>);
    expect(screen.getByTestId("status-proposal")).toHaveTextContent("待决定助手已提议退回澄清这一步");
    fireEvent.click(screen.getByTestId("status-enter"));
    expect(onMessage.mock.calls).toEqual([["我选：退回澄清", { reply_message_id: "reply-far", kind: "choose", choice: "back_to_clarify" }]]);
  });

  it("没有开着的提议：没有「待决定」一行，只有「请助手汇报当前状况」；卡上的提议已经结束时进入按钮点不了", () => {
    render(<Wrap><TaskStatusCard status={{ ...STATUS, proposal: null }} liveProposal={null} onMessage={noop} onSend={noop} /></Wrap>);
    expect(screen.queryByTestId("status-proposal")).toBeNull();
    expect(screen.queryByTestId("status-enter")).toBeNull();
    expect(screen.getByTestId("status-next")).toHaveTextContent(/^请助手汇报当前状况$/);
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

const IDLE_STATUS: TaskStatusView = { ...STATUS, activity: { kind: "idle", key: "idle", name: "空闲", ordinal: null, flow: null, moved_by: null, moved_at: null, reason: null },
  missing: [], proposal: null };

describe("「本会话」一行与退役的「开展一项活动」", () => {
  it("三种写法：流程的工作项写流程名、第几站与进入的时刻；单项活动的工作项写活动名与启动的时刻；自由讨论的会话写自由讨论；自由讨论时没有「这一段还差」一行", () => {
    const alone = { kind: "activity" as const, key: "modeling" as const, name: "整理建模", ordinal: null, flow: null, moved_by: "user" as const, moved_at: "2026-10-12T10:05:00", reason: "" };
    expect(activityLine(alone)).toBe("整理建模 · 10-12 10:05 启动");
    expect(activityLine({ ...alone, moved_at: null })).toBe("整理建模");
    expect(activityLine(IDLE_STATUS.activity)).toBe("自由讨论（不绑定活动）");
    render(<Wrap><TaskStatusCard status={IDLE_STATUS} liveProposal={null} onMessage={vi.fn()} onSend={vi.fn()} /></Wrap>);
    expect(screen.getByTestId("task-status")).toHaveAttribute("data-activity", "idle");
    expect(screen.getByTestId("status-activity")).toHaveTextContent("本会话自由讨论（不绑定活动）");
    expect(screen.queryByTestId("status-missing")).toBeNull();
  });

  it("卡上没有「开展一项活动」一节，后端照旧给 launch 也不画；卡上不出现「开展」「任务状况」字样", () => {
    const launch = { current: null, flows: [{ activity: "reading", in_flow: true, label: "启动需求分析", enabled: true, state: "从核读材料开始" }], activities: [], later: [] };
    render(<Wrap><TaskStatusCard status={{ ...IDLE_STATUS, launch } as TaskStatusView} liveProposal={null} onMessage={vi.fn()} onSend={vi.fn()} /></Wrap>);
    expect(screen.queryByTestId("status-activities")).toBeNull();
    expect(screen.queryByTestId("status-activities-earlier")).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["请助手汇报当前状况"]);
    expect(screen.getByTestId("task-status").textContent).not.toMatch(/开展|任务状况/);
  });
});

describe("新建会话的开头", () => {
  it("判法：任务有阶段、在进行中、这条会话里还没有人说过话；新任务还没有主题页也放", () => {
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
    expect(wantsOpeningStatus({ ...task, items: task.items.filter((i) => i.collection !== "业务说明") }, 0, 0, false, false)).toBe(true);    // 新任务，还没有主题页：也放
    expect(wantsOpeningStatus(null, 0, 0, false, false)).toBe(false);
  });

  it("会话开头那一行的写法：属于工作项的会话写工作项的名字与启动的时刻，自由讨论的会话写自由讨论", () => {
    const work: WorkItemBrief = { record_id: 5, kind: "activity", name: "整理建模", activity: "modeling", flow: null, scope: null, started_at: "2026-10-13T09:02:00" };
    expect(newSessionLine(work)).toBe("新会话 · 属于工作项「整理建模」（10-13 09:02）");
    expect(newSessionLine({ ...work, started_at: null })).toBe("新会话 · 属于工作项「整理建模」");
    expect([newSessionLine(null), newSessionLine(undefined), FREE_SESSION_LINE]).toEqual(Array(3).fill("新会话 · 自由讨论（不绑定活动）"));
  });

  it("对话区第一条是会话开头那一行，接着是工作进展卡，都排在会话开头那条任务现状说明之前", async () => {
    const NOTE = { type: "system_note", message_id: "n0", at: "", kind: "task_status", text: "任务现状：业务说明 16 页。", details: null };
    const { loadStatus } = chat(taskWith(), [NOTE], { sessionLine: "新会话 · 属于工作项「需求分析」（10-13 09:02）" });
    const opening = await screen.findByTestId("status-opening");
    expect(loadStatus).toHaveBeenCalledTimes(1);
    const line = screen.getByTestId("new-session-line");
    expect(line).toHaveTextContent("新会话 · 属于工作项「需求分析」（10-13 09:02）");
    expect(line.compareDocumentPosition(opening) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(opening).getByTestId("task-status")).toBeInTheDocument();
    expect(screen.queryByTestId("status-called")).toBeNull();
  });

  it("会话开头那一行不论有没有人说过话都在最前面；更早还有一段没读出来、或者没有给（归档的会话、没有阶段的任务）时不画", () => {
    chat(taskWith(), [said("u1", "请开始整理建模。"), reply("r1", "好的。")], { sessionLine: "新会话 · 属于工作项「整理建模」（10-13 09:02）" });
    const line = screen.getByTestId("new-session-line");
    expect(line.compareDocumentPosition(screen.getByTestId("assistant-reply")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    chat(taskWith(), [reply("r1", "好的。")], { sessionLine: "新会话 · 自由讨论（不绑定活动）", hasEarlier: true });
    expect(screen.queryByTestId("new-session-line")).toBeNull();
    cleanup();
    chat(taskWith(), [reply("r1", "好的。")]);
    expect(screen.queryByTestId("new-session-line")).toBeNull();
  });

  it("会话里已经有消息：不放，也不去取状况；新任务还没有主题页的第一条会话照样放", async () => {
    const { loadStatus } = chat(taskWith(), [said("u1", "接着做"), reply("r1", "好的。")]);
    await Promise.resolve();
    expect(screen.queryByTestId("status-opening")).toBeNull();
    expect(loadStatus).not.toHaveBeenCalled();
    cleanup();
    const fresh = taskWith();
    const second = chat({ ...fresh, items: fresh.items.filter((i) => i.collection !== "业务说明") });
    await screen.findByTestId("status-opening");
    expect(second.loadStatus).toHaveBeenCalledTimes(1);
  });
});

describe("随时调出", () => {
  it("点输入框旁的「工作进展」：在当时最后一条消息后面插一行界面操作与卡，不发给助手；再点一次再插一张", async () => {
    const { onSend, onMessage, loadStatus } = chat(taskWith(), [said("u1", "接着做"), reply("r1", "好的。")]);
    const button = screen.getByTestId("status-button");
    expect(button).toHaveTextContent(/^工作进展$/);
    fireEvent.click(button);
    const called = await screen.findByTestId("status-called");
    expect(within(called).getByTestId("status-called-line")).toHaveTextContent(STATUS_CALLED_LINE);
    expect(STATUS_CALLED_LINE).toBe("界面操作：用户调出工作进展");
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

describe("工作进展卡的版本、工作项与资产三行，启动推荐流程与其他工作", () => {
  const cell = (key: string, count: number, text: string, note = "") => ({ key, name: key, count, unit: "", text, note, produced_by: [] });
  const ASSETS = [cell("materials", 1, "1 份", "均有引用"), cell("description", 9, "9 节", "无待澄清事项"), cell("models", 4, "4 张", "均已查看"),
    cell("items", 23, "23 条", "均已确认"), cell("review", 1, "1 轮", ""), cell("versions", 1, "第 1 版", "")];
  const flow = (key: string, name: string, recommended: boolean, enabled = true) => ({ key, name, recommended, enabled }) as never;
  const WORK = [
    { record_id: 1, kind: "flow", name: "需求分析", activity: "clarifying", activity_name: "澄清", ordinal: 2 },
    { record_id: 5, kind: "activity", name: "整理建模", activity: "modeling", activity_name: "整理建模", ordinal: null },
  ] as unknown as TaskStatusView["work_items"];
  const FULL: TaskStatusView = { ...IDLE_STATUS, assets: ASSETS, work_items: WORK,
    catalog: { flows: [flow("analysis", "需求分析", false, false), flow("change", "需求变更", true)], activities: [] } } as unknown as TaskStatusView;

  it("几行的写法：版本写发布的情形，工作项列出名字（流程另写在第几站），业务说明、模型、需求条目取资产现状那一格；早先的后端没有这几项时不画或照旧写", () => {
    expect([versionLine(ASSETS), versionLine([cell("versions", 0, "未发布")]), versionLine(undefined)]).toEqual(["已发布第 1 版", "未发布", null]);
    expect([workItemsLine(WORK), workItemsLine([]), workItemsLine(undefined)]).toEqual(["2 个工作项：需求分析（第 2 站「澄清」）、整理建模", "没有工作项", null]);
    expect([assetLine(ASSETS, "description"), assetLine(ASSETS, "review"), assetLine(undefined, "models")]).toEqual(["9 节，无待澄清事项", "1 轮", null]);
    render(<Wrap><TaskStatusCard status={FULL} taskId="TASK-001" liveProposal={null} onMessage={vi.fn()} onSend={vi.fn()} onOtherWork={vi.fn()} /></Wrap>);
    const card = screen.getByTestId("task-status");
    expect([...card.querySelectorAll(".row")].map((one) => one.textContent)).toEqual([
      "本会话自由讨论（不绑定活动）", "版本已发布第 1 版", "工作项2 个工作项：需求分析（第 2 站「澄清」）、整理建模",
      "业务说明9 节，无待澄清事项", "模型4 张，均已查看", "需求条目23 条，均已确认"]);
  });

  it("推荐的流程能启动时主按钮「启动需求变更」进它的输入页，下面一句说本会话怎样；「其他工作…」打开切换工作面板；没有能启动的推荐流程时没有主按钮", () => {
    window.location.hash = "";
    const onOtherWork = vi.fn();
    render(<Wrap><TaskStatusCard status={FULL} taskId="TASK-001" liveProposal={null} onMessage={vi.fn()} onSend={vi.fn()} onOtherWork={onOtherWork} /></Wrap>);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["启动需求变更", "请助手汇报当前状况", "其他工作…"]);
    expect(screen.getByTestId("status-launch")).toHaveClass("pri");
    expect(screen.getByTestId("status-launch-note")).toHaveTextContent("「启动需求变更」会新建一条属于它的会话；本会话留作自由讨论。");
    fireEvent.click(screen.getByTestId("status-launch"));
    expect(window.location.hash).toBe("#/tasks/TASK-001/start/change");
    fireEvent.click(screen.getByTestId("status-other"));
    expect(onOtherWork).toHaveBeenCalledTimes(1);
    expect(launchNote(recommendedFlow(FULL.catalog!.flows)!, "整理建模")).toBe("「启动需求变更」会新建一条属于它的会话；本会话照旧属于工作项「整理建模」。");
    cleanup();
    render(<Wrap><TaskStatusCard status={{ ...FULL, catalog: { flows: [flow("analysis", "需求分析", true, false)], activities: [] } } as TaskStatusView} taskId="TASK-001"
      liveProposal={null} onMessage={vi.fn()} onSend={vi.fn()} /></Wrap>);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["请助手汇报当前状况"]);
    expect(screen.queryByTestId("status-launch-note")).toBeNull();
    window.location.hash = "";
  });

  it("任务空着（六类资产都没有）时新建会话的开头不放这张卡", async () => {
    const empty = { ...FULL, assets: ASSETS.map((one) => ({ ...one, count: 0 })) } as TaskStatusView;
    const loadStatus = vi.fn().mockResolvedValue(empty);
    chat(taskWith(), [], { loadStatus });
    await vi.waitFor(() => expect(loadStatus).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(screen.queryByTestId("status-opening")).toBeNull();
  });
});
