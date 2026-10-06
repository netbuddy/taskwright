// 工作视图顶上的无模型提示与设置入口：capabilities.model 为 false 时顶上出「还没有选定语言模型」与「去配置模型」；
// 顶栏的「设置」与左边竖栏底部的图标都进设置页面。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { ServiceInfo, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState } from "../state/workState";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const info = (model: boolean): ServiceInfo => ({
  ok: true, app: "taskwright", version: "0.4.1", mode: "server", pid: 1, port: 8940,
  capabilities: { exit: false, model, model_config: true }, model: { name: "fake/fake-model", reason: "在模型登记文件 models.json 里没有找到「fake/fake-model」。" },
});

function page(model: boolean) {
  (useWorkView as Mock).mockReturnValue({ state: initialWorkState("S-1"), log: [], dispatch: vi.fn(), stream: "open", loadError: null, loadErrorCode: null, reload: vi.fn() });
  vi.spyOn(api, "getTask").mockResolvedValue({ task_id: "TASK-001", task_name: "图书馆借还", sessions: [], materials: [] } as unknown as TaskDetail);
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  const service = vi.spyOn(api, "serviceInfo").mockResolvedValue(info(model));
  render(
    <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>
      <WorkViewPage taskId="TASK-001" sessionId="S-1" />
    </ServiceProvider></ToastProvider></AntApp></ConfigProvider>,
  );
  return service;
}

describe("工作视图顶上的无模型提示与设置入口", () => {
  it("没有可用模型时工作视图顶上有提示「还没有选定语言模型，助手现在不能工作。」，点「去配置模型」进设置页面", async () => {
    page(false);
    const banner = await screen.findByTestId("no-model-banner");
    expect(banner).toHaveTextContent("还没有选定语言模型，助手现在不能工作。");
    window.location.hash = "#/tasks/TASK-001/sessions/S-1";
    fireEvent.click(screen.getByTestId("go-model-settings"));
    expect(window.location.hash).toBe("#/settings/models");
  });

  it("有可用模型时不出提示；顶栏的「设置」与竖栏底部的图标都进设置页面", async () => {
    const service = page(true);
    await vi.waitFor(() => expect(service).toHaveBeenCalled());
    await screen.findByTestId("open-settings");
    expect(screen.queryByTestId("no-model-banner")).toBeNull();
    for (const id of ["open-settings", "rail-settings"]) {
      window.location.hash = "#/tasks/TASK-001/sessions/S-1";
      fireEvent.click(screen.getByTestId(id));
      expect(window.location.hash).toBe("#/settings/models");
    }
  });
});
