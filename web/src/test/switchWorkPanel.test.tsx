// 切换工作面板与启动确认框（components/work/SwitchWorkPanel.tsx、model/switchWork.ts）：三组——本会话的工作项、辅助操作、其他活动；
// 自由讨论的会话第一组没有按钮；已有流程工作项时流程项写「已在进行」并给「打开它的会话」；点能启动的一项进确认框，
// 确认框写这样启动之后各处怎样，点主按钮先发启动请求、再替用户发第一句话、然后进新会话。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api, ApiError } from "../api/client";
import type { AssetCell, CatalogActivity, CatalogFlow, StageView, TaskStatusView, WorkItemView } from "../api/types";
import { ANSWER_QUESTIONS_TEXT, SwitchWorkPanel, type SwitchWorkActions } from "../components/work/SwitchWorkPanel";
import { ToastProvider } from "../components/Toasts";
import { confirmEffects, ownItemLine, panelSubtitle } from "../model/switchWork";
import { ACTIVITY_START_TEXTS } from "../../../agent/src/lib/stage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.location.hash = ""; });

const LAMPS = { reading: [], clarifying: [], modeling: [], writing: [], reviewing: [], document: [] };
const FLOW_BRIEF = { record_id: 1, kind: "flow" as const, name: "需求分析", activity: "writing" as const, flow: "analysis", scope: null, started_at: "2026-10-08T09:00:00" };
const flowStage: StageView = { current: "writing", node: "writing", moved_by: "user", moved_at: null, reason: null, lamps: LAMPS, work_item: FLOW_BRIEF };
const aloneStage: StageView = { current: "modeling", node: null, moved_by: "user", moved_at: null, reason: null, lamps: LAMPS,
  work_item: { record_id: 3, kind: "activity", name: "整理建模", activity: "modeling", flow: null, scope: "只重画对象关系图", started_at: "2026-10-13T09:00:00" } };
const freeStage: StageView = { current: "idle", node: null, moved_by: null, moved_at: null, reason: null, lamps: LAMPS, work_item: null };

const cell = (key: string, name: string, count: number, shown: string): AssetCell => ({ key, name, count, unit: "", text: shown, note: "", produced_by: [] });
const kind = (key: string, name: string) => ({ key, name });
const activity = (key: string, name: string, over: Partial<CatalogActivity> = {}): CatalogActivity => ({
  key, name, mode: "batch", mode_name: "批处理", purpose: `${name}的目的。`, reads: [kind("description", "业务说明")], writes: [kind("items", "需求条目")],
  prerequisite_text: "前置条件：业务说明至少一节。", example: "例子。", enabled: true, state: "可以启动", recommended: false, active_count: 0, ...over,
});
const TAKEN = { record_id: 1, name: "需求分析", node: "writing" as const };
const NODES = [kind("reading", "核读材料"), kind("clarifying", "澄清"), kind("modeling", "整理建模"), kind("writing", "写条目"), kind("reviewing", "评审确认"), kind("document", "编写文档"), kind("publish", "发布")];
const flow = (over: Partial<CatalogFlow> = {}): CatalogFlow => ({
  key: "analysis", name: "需求分析", purpose: "从材料出发编制需求规格说明。", applies: "从头编制。", nodes: NODES, inputs: "材料", prerequisite_text: "无前置条件；可从空白开始。",
  example: "经过。", enabled: false, state: "已有流程工作项「需求分析」，位于「写条目」", recommended: true, at: null, start: "reading", active_count: 1, work_item: TAKEN, cases: [], ...over,
});
const item = (recordId: number, over: Partial<WorkItemView> = {}): WorkItemView => ({
  record_id: recordId, kind: "activity", name: "整理建模", activity: "modeling", activity_name: "整理建模", node: null, ordinal: null, flow: null, scope: "只重画对象关系图",
  started_at: "2026-10-13T09:00:00", session_ids: [`S-${recordId}`], session_count: 1, latest_session: { session_id: `S-${recordId}`, name: "整理建模", last_active_at: "2026-10-13T09:02:00" },
  last_active_at: "2026-10-13T09:02:00", session_name: "整理建模", ...over,
});
const FLOW_ITEM = item(1, { kind: "flow", name: "需求分析", activity: "writing", activity_name: "写条目", node: "writing", ordinal: 4, flow: "analysis", scope: null,
  session_ids: ["S-1", "S-2"], session_count: 2, latest_session: { session_id: "S-2", name: "需求分析 · 写条目", last_active_at: "2026-10-13T09:10:00" } });

function status(over: Partial<TaskStatusView> = {}): TaskStatusView {
  return {
    generated_at: "", activity: { kind: "stage", key: "writing", name: "写条目", ordinal: 4, flow: "analysis", moved_by: "user", moved_at: null, reason: null },
    description: { sections: 9, chapters: [], unsorted: 0, open_questions: 2 }, models: [], items: [], missing: [], proposal: null, versions: [], launch: null,
    assets: [cell("materials", "输入资料", 1, "1 份"), cell("description", "业务说明", 9, "9 节"), cell("models", "分析模型", 4, "4 张"),
      cell("items", "需求条目", 6, "6 条"), cell("review", "评审与确认", 0, "未评审"), cell("versions", "文档与版本", 0, "未发布")],
    work_items: [FLOW_ITEM, item(3)],
    catalog: {
      flows: [flow(), flow({ key: "change", name: "需求变更", recommended: false, state: "还没有已发布的版本", prerequisite_text: "前置条件：存在已发布的版本。", start: null, active_count: 0 })],
      activities: [activity("modeling", "整理建模", { writes: [kind("models", "分析模型")], active_count: 1 }), activity("clarifying", "澄清", { mode: "dialogue", mode_name: "逐项对话" }),
        activity("document", "编写文档", { enabled: false, state: "还没有已确认的需求条目", prerequisite_text: "前置条件：存在已确认的需求条目。" })],
    },
    ...over,
  } as TaskStatusView;
}

function actions(): { [K in keyof SwitchWorkActions]: ReturnType<typeof vi.fn> } {
  return { onPrefill: vi.fn(), onRetell: vi.fn(), onReview: vi.fn(), onAttach: vi.fn(), onShowStatus: vi.fn(), onContinue: vi.fn(), onDelete: vi.fn() };
}

function panel(stage: StageView, st: TaskStatusView = status(), off: string | null = null) {
  const calls = {
    status: vi.spyOn(api, "taskStatus").mockResolvedValue({ ok: true, status: st }),
    start: vi.spyOn(api, "startInNewSession").mockResolvedValue({ ok: true, op_id: "ui-op-1", session_id: "S-new", activity_record_id: 9 }),
    send: vi.spyOn(api, "sendMessage").mockResolvedValue({ ok: true, client_id: "c", queued: false } as never),
  };
  const acts = actions();
  const onClose = vi.fn();
  render(<ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider>
    <SwitchWorkPanel open taskId="TASK-P" sessionId="S-2" stage={stage} pendingReview={5} off={off} actions={acts as unknown as SwitchWorkActions} onClose={onClose} />
  </ToastProvider></AntApp></ConfigProvider>);
  return { calls, acts, onClose };
}
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("面板上的几句话", () => {
  it("标题下一句：本会话属于哪个工作项、哪天启动、流程在第几站、本任务实例另有几个；自由讨论的会话写它不绑定活动", () => {
    expect(panelSubtitle(flowStage, status())).toBe("本会话属于工作项「需求分析」（10-08） · 位于第 4 站「写条目」 · 本任务实例另有 1 个工作项");
    expect(panelSubtitle(aloneStage, status())).toBe("本会话属于工作项「整理建模」（10-13） · 本任务实例另有 1 个工作项");
    expect(panelSubtitle(freeStage, status())).toBe("本会话是自由讨论，不绑定活动 · 本任务实例有 2 个工作项");
    expect(panelSubtitle(freeStage, status({ work_items: [] }))).toBe("本会话是自由讨论，不绑定活动 · 本任务实例还没有工作项");
    expect(ownItemLine(flowStage)).toBe("现在在第 4 站「写条目」。完成后助手将提议进入「评审确认」。");
    expect(ownItemLine({ ...flowStage, current: "document", node: "document" })).toBe("现在在第 6 站「编写文档」。这是最后一站，完成后请你过目。");
    expect(ownItemLine(aloneStage)).toBe("单项活动：做够了由助手在回复里汇报做完，不提议下一站；工作项照旧留着，可以接着说。");
    // 需求再工程在逆向解析这一站：第几站与站名、下一站取自活动目录里这条流程的各站，不按六个阶段数。
    const rewriteNodes = [kind("parse_spec", "逆向解析"), ...NODES];
    const catalog = { flows: [flow({ key: "reengineering", name: "需求再工程", nodes: rewriteNodes })], activities: [activity("parse_spec", "逆向解析", { stage: "reading" }), activity("publish", "发布", { mode: "user_only" })] };
    const rewriteStage: StageView = { ...flowStage, current: "reading", activity: "parse_spec", node: "parse_spec", catalog,
      work_item: { ...FLOW_BRIEF, name: "需求再工程", activity: "parse_spec", flow: "reengineering" } };
    expect(panelSubtitle(rewriteStage, status({ work_items: [] }))).toBe("本会话属于工作项「需求再工程」（10-08） · 位于第 1 站「逆向解析」 · 本任务实例没有别的工作项");
    expect(ownItemLine(rewriteStage)).toBe("现在在第 1 站「逆向解析」。完成后助手将提议进入「核读材料」。");
    expect(ownItemLine({ ...rewriteStage, current: "document", activity: "document", node: "document" })).toBe("现在在第 7 站「编写文档」。这是最后一站，完成后请你过目。");
  });
});

describe("切换工作面板", () => {
  it("「其他活动」只列能单独启动的活动：声明为只在工作流里做的逆向解析不列", async () => {
    const st = status();
    panel(flowStage, status({ catalog: { ...st.catalog!, activities: [...st.catalog!.activities, activity("parse_spec", "逆向解析", { alone: false })] } }));
    await screen.findByTestId("switch-others");
    expect(screen.queryByTestId("switch-activity-parse_spec")).toBeNull();
    expect(screen.getByTestId("switch-activity-modeling")).toBeInTheDocument();
  });

  it("流程的工作项的会话：标题与一句、六格；第一组写在第几站、下一站，三个按钮；辅助操作五个；其他活动里流程项写「已在进行」、本会话就是它的会话", async () => {
    const { acts, onClose } = panel(flowStage);
    expect(await screen.findByTestId("switch-title")).toHaveTextContent("切换工作");
    await waitFor(() => expect(screen.getByTestId("switch-subtitle")).toHaveTextContent("本会话属于工作项「需求分析」（10-08） · 位于第 4 站「写条目」 · 本任务实例另有 1 个工作项"));
    expect(screen.getByTestId("asset-cells")).toBeInTheDocument();
    const own = screen.getByTestId("switch-own");
    expect(text(own.querySelector(".gt"))).toBe("本会话的工作项需求分析 · 写条目");
    expect([...own.querySelectorAll("button")].map(text)).toEqual(["继续写条目", "换一条干净的会话接着", "删除这个工作项"]);
    expect(own).toHaveTextContent("完成后助手将提议进入「评审确认」。");
    expect([...screen.getByTestId("switch-basics").querySelectorAll("button")].map(text)).toEqual([
      "回答待澄清问题（2）", "请助手复述当前理解", "对已写的 5 条发起评审", "补充输入资料", "查看工作进展"]);
    const analysis = screen.getByTestId("switch-flow-analysis");
    expect([text(analysis.querySelector(".t")), analysis.textContent?.includes("本会话就是它的会话。"), analysis.querySelector("button")]).toEqual(["需求分析工作流程已在进行", true, null]);
    // 活动卡：已有工作项的标个数（不写「进行中」）；缺前提的变淡、写前置条件。
    expect(text(screen.getByTestId("switch-activity-modeling").querySelector(".t"))).toBe("整理建模批处理1 个工作项");
    expect(screen.getByTestId("switch-activity-document")).toHaveClass("off");
    // 需求变更缺的是它自己的前提：写前置条件，不写别的流程正在进行。
    expect(text(screen.getByTestId("switch-flow-change").querySelector(".tp-need"))).toBe("前置条件：存在已发布的版本。");
    expect(screen.getByTestId("switch-panel").textContent).not.toMatch(/已做完|结束这个工作项|开展/);
    // 「继续写条目」只关面板；删除交给页面去确认（带名字、会话条数、是不是流程）。
    fireEvent.click(within(own).getByTestId("switch-delete"));
    expect(acts.onDelete).toHaveBeenCalledWith(1, "需求分析", 2, true);
    expect(onClose).toHaveBeenCalled();
  });

  it("辅助操作各调页面已有的操作：回答待澄清问题预填输入框，复述、评审、查看工作进展各调一次，然后关面板；不能做事时点不动", async () => {
    const { acts, onClose } = panel(flowStage);
    await waitFor(() => expect(screen.getByTestId("switch-questions")).toBeEnabled());
    fireEvent.click(screen.getByTestId("switch-questions"));
    expect(acts.onPrefill).toHaveBeenCalledWith(ANSWER_QUESTIONS_TEXT);
    fireEvent.click(screen.getByTestId("switch-retell"));
    fireEvent.click(screen.getByTestId("switch-review"));
    fireEvent.click(screen.getByTestId("switch-status"));
    fireEvent.click(screen.getByTestId("switch-fresh"));
    expect([acts.onRetell, acts.onReview, acts.onShowStatus].map((one) => one.mock.calls.length)).toEqual([1, 1, 1]);
    expect(acts.onContinue).toHaveBeenCalledWith(1);
    expect(onClose).toHaveBeenCalledTimes(5);
    cleanup();
    panel(flowStage, status(), "助手正在工作，等它做完这一轮。");
    await screen.findByTestId("switch-panel");
    for (const id of ["switch-questions", "switch-retell", "switch-review", "switch-attach", "switch-fresh", "switch-delete"]) expect(screen.getByTestId(id)).toBeDisabled();
    expect(screen.getByTestId("switch-status")).toBeEnabled();
    expect(screen.getByTestId("switch-activity-clarifying")).toHaveClass("off");
  });

  it("自由讨论的会话：第一组写本会话是自由讨论，没有按钮", async () => {
    panel(freeStage);
    const own = await screen.findByTestId("switch-own");
    expect(text(own.querySelector(".gt"))).toBe("本会话的工作项本会话是自由讨论，不绑定活动");
    expect(own.querySelectorAll("button")).toHaveLength(0);
  });

  it("本会话是单项活动、任务另有流程工作项：流程项写「已在进行，位于第几站」并给「打开它的会话」，点了进那个工作项最近的会话", async () => {
    const { onClose } = panel(aloneStage);
    const analysis = await screen.findByTestId("switch-flow-analysis");
    await waitFor(() => expect(analysis).toHaveTextContent("已在进行，位于第 4 站「写条目」。"));
    fireEvent.click(within(analysis).getByTestId("switch-open-flow"));
    expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-2");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("启动确认框", () => {
  it("点能启动的一项进确认框：标题、目的与方式、这样启动之后的几行（同一项活动已有工作项时写出范围）、范围说明；取消回到面板", async () => {
    panel(flowStage);
    fireEvent.click(await screen.findByTestId("switch-activity-modeling"));
    expect(await screen.findByTestId("switch-title")).toHaveTextContent("启动活动「整理建模」");
    const box = screen.getByTestId("switch-confirm");
    expect(box).toHaveTextContent("整理建模的目的。批处理：助手一次完成后汇报。");
    expect([...screen.getByTestId("switch-effects").querySelectorAll("dt")].map(text)).toEqual(["本会话", "新会话", "受影响的条目", "已有的工作项"]);
    expect(screen.getByTestId("switch-effects")).toHaveTextContent("不受影响：「需求分析」仍在「写条目」；本会话留在会话菜单里，随时回来。");
    expect(screen.getByTestId("switch-effects")).toHaveTextContent("「整理建模」已有 1 个工作项（范围：只重画对象关系图）。要接着做它，请取消并从任务起点页打开它的会话；要另做一次，继续。");
    expect(screen.getByTestId("switch-confirm-start")).toHaveTextContent("启动整理建模（新建会话）");
    fireEvent.click(screen.getByTestId("switch-confirm-back"));
    expect(await screen.findByTestId("switch-panel")).toBeInTheDocument();
    // 没有同一项活动的工作项、也不写分析模型：只有两行。
    expect(confirmEffects({ kind: "activity", activity: activity("clarifying", "澄清") }, freeStage, status()).map((row) => row.label)).toEqual(["本会话", "新会话"]);
    expect(confirmEffects({ kind: "activity", activity: activity("clarifying", "澄清") }, freeStage, status())[0].text).toBe("不受影响：本会话是自由讨论，留在会话菜单里，随时回来。");
  });

  it("点「启动……（新建会话）」：发启动请求（带范围说明），成了替用户在新会话里发第一句话，关面板、进新会话；启动不成留在确认框", async () => {
    const { calls, onClose } = panel(flowStage);
    fireEvent.click(await screen.findByTestId("switch-activity-clarifying"));
    fireEvent.change(await screen.findByTestId("switch-scope"), { target: { value: "  只问续借规则  " } });
    fireEvent.click(screen.getByTestId("switch-confirm-start"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/TASK-P/sessions/S-new"));
    expect(calls.start).toHaveBeenCalledWith("TASK-P", { activity: "clarifying", in_flow: false, scope: "只问续借规则" });
    expect(calls.send.mock.calls[0][1]).toBe("S-new");
    expect(calls.send.mock.calls[0][2]).toMatchObject({ text: ACTIVITY_START_TEXTS.clarifying, attachments: [] });
    expect(onClose).toHaveBeenCalled();
    window.location.hash = "";
    cleanup();
    const again = panel(flowStage);
    again.calls.start.mockRejectedValueOnce(new ApiError("rejected", "现在还不能启动「澄清」：业务说明还没有内容。", 409));
    fireEvent.click(await screen.findByTestId("switch-activity-clarifying"));
    const sent = again.calls.send.mock.calls.length;
    fireEvent.click(await screen.findByTestId("switch-confirm-start"));
    expect(await screen.findByText("现在还不能启动「澄清」：业务说明还没有内容。")).toBeInTheDocument();
    expect(screen.getByTestId("switch-confirm")).toBeInTheDocument();
    expect(again.calls.send.mock.calls.length).toBe(sent);
    expect(window.location.hash).toBe("");
  });

  it("流程项能启动时（任务里还没有流程工作项）：确认框写启动工作流程、从哪一站开始，主按钮照流程名", async () => {
    panel(freeStage, status({ work_items: [], catalog: { flows: [flow({ enabled: true, state: "可以启动", work_item: null, active_count: 0 })], activities: [] } }));
    fireEvent.click(await screen.findByTestId("switch-flow-analysis"));
    expect(await screen.findByTestId("switch-title")).toHaveTextContent("启动工作流程「需求分析」");
    expect(screen.getByTestId("switch-confirm")).toHaveTextContent("从「核读材料」开始，每站完成后助手提议下一站，由你确认。");
    expect(screen.getByTestId("switch-confirm-start")).toHaveTextContent("启动需求分析（新建会话）");
  });
});
