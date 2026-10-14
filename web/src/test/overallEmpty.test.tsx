// 业务说明还没有内容时，工作台的业务说明首页只写一句：内容由核读材料、澄清写进来，从头编制请在任务起点启动需求分析。
// 早先这里有「通读材料起草」「逐项澄清」两个按钮（把任务移到那个阶段再替用户发话），工作项与会话绑定之后去掉了：
// 一条会话建立时就定了做哪个工作项，不在会话里换。平常页面上也没有阶段条（只在调试页签里）。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { ServiceInfo, StageView, Task, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState, type WorkState } from "../state/workState";
import { overallTask } from "./fixtures/overallTask";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const info: ServiceInfo = { ok: true, app: "taskwright", version: "0.5.0", mode: "server", pid: 1, port: 8940, capabilities: { exit: false, model: true, model_config: true } };
const stage = (current: StageView["current"]): StageView => ({ current, moved_by: null, moved_at: null, reason: null,
  lamps: { reading: [], clarifying: [], modeling: [], writing: [], reviewing: [], document: [] } });
const MATERIAL = { path: "inputs/材料.md", bytes: 10, modified_at: "" };

function page(task: Task, over: Partial<WorkState> = {}) {
  const state: WorkState = { ...initialWorkState("S-1"), phase: "ready", task, materials: [MATERIAL],
    executor: { state: "idle", text: "", active_session: null, at: "" } as WorkState["executor"], ...over };
  (useWorkView as Mock).mockReturnValue({ state, log: [], dispatch: vi.fn(), stream: "open", loadError: null, loadErrorCode: null, reload: vi.fn() });
  vi.spyOn(api, "getTask").mockResolvedValue({ ...task, sessions: [], materials: [] } as unknown as TaskDetail);
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  vi.spyOn(api, "serviceInfo").mockResolvedValue(info);
  const calls: string[] = [];
  const action = vi.spyOn(api, "action").mockImplementation(async (_task, _session, req) => { calls.push(`action:${req.kind}`); return { ok: true, op_id: "ui-op-1" } as never; });
  const sendMessage = vi.spyOn(api, "sendMessage").mockImplementation(async (_task, _session, req) => { calls.push(`message:${req.text}`); return { ok: true } as never; });
  render(
    <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>
      <WorkViewPage taskId="TASK-001" sessionId="S-1" collection="总体分析" />
    </ServiceProvider></ToastProvider></AntApp></ConfigProvider>,
  );
  return { calls, action, sendMessage };
}
const empty = (over: Partial<Task> = {}) => overallTask({ items: [], stage: stage("clarifying"), ...over });

describe("业务说明还没有内容时的工作台", () => {
  it("只写一句说明，没有「通读材料起草」「逐项澄清」两个按钮；页面上没有阶段条；不发任何请求", () => {
    const { calls } = page(empty());
    expect(screen.getByTestId("overall-empty")).toHaveTextContent("业务说明还没有内容。核读材料、澄清这两项活动把内容写进来：要从头编制，请在任务起点启动需求分析。");
    expect([screen.queryByTestId("start-reading"), screen.queryByTestId("start-clarifying"), screen.queryByTestId("overall-start"), screen.queryByTestId("stage-bar")]).toEqual([null, null, null, null]);
    expect(screen.queryByText(/通读材料起草|逐项澄清/)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("任务没有阶段、或者已经有内容时没有这一句", () => {
    page(overallTask({ items: [], stage: null }));
    expect(screen.queryByTestId("overall-empty")).toBeNull();
    cleanup();
    page(overallTask({ stage: stage("clarifying") }));
    expect(screen.getByTestId("overall-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("overall-empty")).toBeNull();
  });
});
