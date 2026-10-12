// 工作视图里与阶段有关的两处接线：顶栏下面的阶段条（任务有阶段才有），与总体分析还没有一页主题时的两个开头
// （「通读材料起草」「逐项澄清」）：先发界面操作把任务移到那个阶段，移成了再替用户发那句固定的话；没移成就不发话。
// 助手正在工作时两个按钮都不可用；任务没有材料时「通读材料起草」不可用；已经有主题、或者任务没有阶段时不显示这两个按钮。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { ApiError, api } from "../api/client";
import type { ServiceInfo, StageView, Task, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { NO_MATERIALS_TEXT, STAGE_STARTS } from "../model/stage";
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

describe("工作视图里的两个开头", () => {
  it("任务有阶段：业务说明还没有内容时有两个开头；不开调试模式时页面上没有阶段条；任务没有阶段：没有两个开头", () => {
    page(empty());
    expect(screen.queryByTestId("stage-bar")).toBeNull();
    expect(screen.getByTestId("overall-start")).toBeInTheDocument();
    cleanup();
    page(overallTask({ items: [], stage: null }));
    expect(screen.queryByTestId("stage-bar")).toBeNull();
    expect(screen.queryByTestId("overall-start")).toBeNull();
  });

  it("点「通读材料起草」：先发界面操作把任务移到核读材料，再替用户发那句固定的话", async () => {
    const { calls, action, sendMessage } = page(empty());
    expect(screen.getByTestId("start-reading")).toHaveTextContent("通读材料起草");
    fireEvent.click(screen.getByTestId("start-reading"));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(calls).toEqual(["action:move_stage", `message:${STAGE_STARTS.reading.text}`]);
    expect(action.mock.calls[0][2]).toMatchObject({ kind: "move_stage", targets: [], fields: { stage: "核读材料" }, notify_executor: false });
    expect(STAGE_STARTS.reading.text).toBe("请通读材料，把材料里已经写明的概念、角色、流程与目标各立一页主题。");
  });

  it("点「逐项澄清」：先移到澄清，再发那句固定的话", async () => {
    const { calls, action } = page(empty({ stage: stage("reading") }));
    expect(screen.getByTestId("start-clarifying")).toHaveTextContent("逐项澄清");
    fireEvent.click(screen.getByTestId("start-clarifying"));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls).toEqual(["action:move_stage", "message:请逐项澄清：一次只问一件事，先给出候选再问。"]);
    expect(action.mock.calls[0][2]).toMatchObject({ fields: { stage: "澄清" } });
  });

  it("移动阶段被拒（例如助手正在别处工作）：报一条失败提示，不发话", async () => {
    const { action, sendMessage } = page(empty());
    action.mockRejectedValue(new ApiError("session_busy", "助手正在工作，做完这一轮再操作。", 409, { reason: "working" }));
    fireEvent.click(screen.getByTestId("start-reading"));
    expect(await screen.findByText("助手正在工作，做完这一轮再操作。")).toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("助手正在工作时两个按钮都不可用，悬停写原因；任务没有材料时「通读材料起草」不可用，「逐项澄清」照常", () => {
    page(empty(), { executor: { state: "working", text: "", active_session: "S-1", at: "" } as WorkState["executor"] });
    for (const id of ["start-reading", "start-clarifying"]) {
      expect(screen.getByTestId(id)).toBeDisabled();
      expect(screen.getByTestId(id).getAttribute("title")).toMatch(/助手正在工作/);
    }
    cleanup();
    page(empty(), { materials: [] });
    expect(screen.getByTestId("start-reading")).toBeDisabled();
    expect(screen.getByTestId("start-reading")).toHaveAttribute("title", NO_MATERIALS_TEXT);
    expect(screen.getByTestId("start-clarifying")).not.toBeDisabled();
    // 由别的材料生成的文件不算一份材料。
    cleanup();
    page(empty(), { materials: [{ path: "inputs/x.docx.md", bytes: 1, modified_at: "", derived_from: "inputs/x.docx" }] });
    expect(screen.getByTestId("start-reading")).toBeDisabled();
  });

  it("已经有主题时不显示这两个按钮", () => {
    page(overallTask({ stage: stage("clarifying") }));
    expect(screen.getByTestId("overall-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("overall-start")).toBeNull();
  });
});
