// 工作视图顶栏上任务名与会话名后面的那一处，只有两种写法：这条会话在做一个工作项时是「当前活动：某项活动 ▾」，
// 自由讨论的会话是「自由讨论 · 不绑定活动」加一枚「启动工作」（去任务起点页）；前两者点了打开切换工作面板。
// 任务已经结束、任务没有阶段时只是一枚不能点的标签。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { ServiceInfo, SessionListEntry, StageView, Task, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { NO_ACTIVITY_TEXT, START_WORK_TEXT, currentActivityText, topbarActivity } from "../model/stage";
import { WorkViewPage } from "../pages/WorkViewPage";
import { href } from "../router";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState, type WorkState } from "../state/workState";
import { overallTask } from "./fixtures/overallTask";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const info: ServiceInfo = { ok: true, app: "taskwright", version: "0.6.0", mode: "server", pid: 1, port: 8940, capabilities: { exit: false, model: true, model_config: true } };
const stage = (current: StageView["current"], node: StageView["node"] = current === "idle" ? null : current): StageView => ({ current, node, moved_by: null, moved_at: null, reason: null,
  lamps: { reading: [], clarifying: [], modeling: [], writing: [], reviewing: [], document: [] } });

function page(task: Task, sessions: SessionListEntry[] = []) {
  const state: WorkState = { ...initialWorkState("S-1"), phase: "ready", task,
    executor: { state: "idle", text: "", active_session: null, at: "" } as WorkState["executor"] };
  (useWorkView as Mock).mockReturnValue({ state, log: [], dispatch: vi.fn(), stream: "open", loadError: null, loadErrorCode: null, reload: vi.fn() });
  vi.spyOn(api, "getTask").mockResolvedValue({ ...task, sessions: [], materials: [] } as unknown as TaskDetail);
  vi.spyOn(api, "listSessions").mockResolvedValue(sessions);
  vi.spyOn(api, "serviceInfo").mockResolvedValue(info);
  vi.spyOn(api, "taskStatus").mockResolvedValue({ ok: true, status: null });
  render(
    <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>
      <WorkViewPage taskId="TASK-001" sessionId="S-1" />
    </ServiceProvider></ToastProvider></AntApp></ConfigProvider>,
  );
}
const chip = () => screen.getByTestId("current-activity");

describe("顶栏那一处写什么", () => {
  it("有活动在进行写「当前活动：某项活动」，在流程里与单独开展都只写活动的名字", () => {
    expect(topbarActivity({ stage: stage("writing") })).toEqual({ kind: "active", text: "当前活动：写条目" });
    expect(topbarActivity({ stage: stage("modeling", null) })).toEqual({ kind: "active", text: "当前活动：整理建模" });
    expect(currentActivityText("clarifying")).toBe("当前活动：澄清");
  });

  it("自由讨论的会话写「自由讨论 · 不绑定活动」；任务没有阶段写「这个任务没有阶段」；没有「已做完」这种写法", () => {
    expect([NO_ACTIVITY_TEXT, START_WORK_TEXT]).toEqual(["自由讨论 · 不绑定活动", "启动工作"]);
    expect(topbarActivity({ stage: stage("idle") })).toEqual({ kind: "idle", text: NO_ACTIVITY_TEXT });
    expect(topbarActivity({ stage: null })).toEqual({ kind: "plain", text: "这个任务没有阶段" });
    expect(topbarActivity({})).toEqual({ kind: "plain", text: "这个任务没有阶段" });
  });
});

describe("工作视图的顶栏", () => {
  it("会话在做一个工作项：一枚可以点的「当前活动：某项活动 ▾」，点了打开切换工作面板；没有「启动工作」", async () => {
    page(overallTask({ stage: stage("writing") }));
    expect(chip()).toHaveTextContent("当前活动：写条目 ▾");
    expect([chip().tagName, chip().getAttribute("role")]).toEqual(["SPAN", "button"]);
    expect(chip()).toHaveClass("chip", "ai");
    expect(screen.queryByTestId("start-work")).toBeNull();
    expect(document.querySelector(".topbar")).not.toHaveTextContent(/进行中|已完成/);
    fireEvent.click(chip());
    expect(await screen.findByTestId("switch-panel")).toBeInTheDocument();
  });

  it("自由讨论的会话：「自由讨论 · 不绑定活动」点了同样打开面板，旁边一枚深色的「启动工作」去任务起点页", async () => {
    page(overallTask({ stage: stage("idle") }));
    expect(chip()).toHaveTextContent(NO_ACTIVITY_TEXT);
    expect([chip().tagName, chip().getAttribute("role")]).toEqual(["SPAN", "button"]);
    expect(document.querySelector(".topbar")!.textContent).not.toMatch(/已做完|当前无活动|开展/);
    fireEvent.click(chip());
    expect(await screen.findByTestId("switch-panel")).toBeInTheDocument();
    const start = screen.getByTestId("start-work");
    expect(start).toHaveTextContent(START_WORK_TEXT);
    expect(start).toHaveAttribute("href", href.task("TASK-001"));
    expect(start).toHaveClass("chip", "dark");
  });

  it("任务没有阶段：写「这个任务没有阶段」，不能点，没有「启动工作」", () => {
    page(overallTask({ stage: null }));
    expect(chip()).toHaveTextContent("这个任务没有阶段");
    expect(chip().tagName).toBe("SPAN");
    expect(screen.queryByTestId("start-work")).toBeNull();
  });
});

describe("会话开头那一行与工作进展卡取的是本会话", () => {
  const WORK = { record_id: 5, kind: "activity" as const, name: "整理建模", activity: "modeling" as const, flow: null, scope: null, started_at: "2026-10-13T09:02:00" };

  it("属于工作项的会话：对话区最前面写「新会话 · 属于工作项「X」（启动的时刻）」；自由讨论的会话写自由讨论", async () => {
    page({ ...overallTask(), stage: { ...stage("modeling", null), work_item: WORK } });
    expect(await screen.findByTestId("new-session-line")).toHaveTextContent("新会话 · 属于工作项「整理建模」（10-13 09:02）");
    cleanup(); vi.restoreAllMocks();
    page({ ...overallTask(), stage: { ...stage("idle"), work_item: null } });
    expect(await screen.findByTestId("new-session-line")).toHaveTextContent("新会话 · 自由讨论（不绑定活动）");
  });

  it("归档的会话（它的工作项被删除了）开头不写那一行：页面取带归档的会话清单，看本会话是不是归档的", async () => {
    page({ ...overallTask(), stage: { ...stage("idle"), work_item: null } }, [
      { session_id: "S-1", name: "澄清", started_at: "", last_active_at: "", message_count: 2, active: false, archived: true, archived_at: "", archived_record_id: 4 }]);
    await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledWith("TASK-001", true));
    await vi.waitFor(() => expect(screen.queryByTestId("new-session-line")).toBeNull());
  });

  it("点输入框旁的「工作进展」：取的是这条会话的状况（带会话编号）", async () => {
    page({ ...overallTask(), stage: { ...stage("modeling", null), work_item: WORK } });
    fireEvent.click(await screen.findByTestId("status-button"));
    await vi.waitFor(() => expect(api.taskStatus).toHaveBeenCalledWith("TASK-001", "S-1"));
    expect(screen.getByTestId("status-button")).toHaveTextContent(/^工作进展$/);
  });
});
