// 工作视图顶栏上任务名与会话名后面的那一处：有活动在进行时是可以点的「当前活动：某项活动 ▾」，任务空闲时是「当前无活动」
// 加一枚「开展工作」，两处都去任务起点页；任务已经结束、任务没有阶段时只是一枚不能点的标签。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { ServiceInfo, StageView, Task, TaskDetail } from "../api/types";
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

function page(task: Task) {
  const state: WorkState = { ...initialWorkState("S-1"), phase: "ready", task,
    executor: { state: "idle", text: "", active_session: null, at: "" } as WorkState["executor"] };
  (useWorkView as Mock).mockReturnValue({ state, log: [], dispatch: vi.fn(), stream: "open", loadError: null, loadErrorCode: null, reload: vi.fn() });
  vi.spyOn(api, "getTask").mockResolvedValue({ ...task, sessions: [], materials: [] } as unknown as TaskDetail);
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  vi.spyOn(api, "serviceInfo").mockResolvedValue(info);
  render(
    <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>
      <WorkViewPage taskId="TASK-001" sessionId="S-1" />
    </ServiceProvider></ToastProvider></AntApp></ConfigProvider>,
  );
}
const chip = () => screen.getByTestId("current-activity");

describe("顶栏那一处写什么", () => {
  it("有活动在进行写「当前活动：某项活动」，在流程里与单独开展都只写活动的名字", () => {
    expect(topbarActivity({ status: "进行中", stage: stage("writing") })).toEqual({ kind: "active", text: "当前活动：写条目" });
    expect(topbarActivity({ status: "进行中", stage: stage("modeling", null) })).toEqual({ kind: "active", text: "当前活动：整理建模" });
    expect(currentActivityText("clarifying")).toBe("当前活动：澄清");
  });

  it("任务空闲写「当前无活动」；任务没有阶段写「任务进行中」；任务已经结束写它的状态", () => {
    expect(topbarActivity({ status: "进行中", stage: stage("idle") })).toEqual({ kind: "idle", text: NO_ACTIVITY_TEXT });
    expect(topbarActivity({ status: "进行中", stage: null })).toEqual({ kind: "plain", text: "任务进行中" });
    expect(topbarActivity({ status: "进行中" })).toEqual({ kind: "plain", text: "任务进行中" });
    expect(topbarActivity({ status: "已完成", stage: stage("document") })).toEqual({ kind: "closed", text: "任务已完成" });
    expect(topbarActivity({ status: "已放弃", stage: stage("idle") })).toEqual({ kind: "closed", text: "任务已放弃" });
  });
});

describe("工作视图的顶栏", () => {
  it("有活动在进行：一枚可以点的「当前活动：某项活动 ▾」，去任务起点页；没有「开展工作」", () => {
    page(overallTask({ stage: stage("writing") }));
    expect(chip()).toHaveTextContent("当前活动：写条目 ▾");
    expect(chip().tagName).toBe("A");
    expect(chip()).toHaveAttribute("href", href.task("TASK-001"));
    expect(chip()).toHaveClass("chip", "ai");
    expect(screen.queryByTestId("start-work")).toBeNull();
    expect(document.querySelector(".topbar")).not.toHaveTextContent("任务进行中");
  });

  it("任务空闲：「当前无活动」不能点，旁边一枚深色的「开展工作」去任务起点页", () => {
    page(overallTask({ stage: stage("idle") }));
    expect(chip()).toHaveTextContent(NO_ACTIVITY_TEXT);
    expect(chip().tagName).toBe("SPAN");
    const start = screen.getByTestId("start-work");
    expect(start).toHaveTextContent(START_WORK_TEXT);
    expect(start).toHaveAttribute("href", href.task("TASK-001"));
    expect(start).toHaveClass("chip", "dark");
  });

  it("任务已经结束：只写任务的状态，不能点，没有「开展工作」", () => {
    page(overallTask({ status: "已完成", stage: stage("idle") }));
    expect(chip()).toHaveTextContent("任务已完成");
    expect(chip().tagName).toBe("SPAN");
    expect(screen.queryByTestId("start-work")).toBeNull();
  });

  it("任务没有阶段：照旧写「任务进行中」，不能点，没有「开展工作」", () => {
    page(overallTask({ stage: null }));
    expect(chip()).toHaveTextContent("任务进行中");
    expect(chip().tagName).toBe("SPAN");
    expect(screen.queryByTestId("start-work")).toBeNull();
  });
});
