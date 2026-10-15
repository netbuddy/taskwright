// 任务页的「导出为用户画像」：服务开着调试模式才有这个按钮；点了让后端把这个任务里用户说过的话整理成草稿，存成一份 JSON 文件，
// 文件名用后端给的，内容就是后端给的画像；取不到时报出原因，不存文件。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { ApiError, api } from "../api/client";
import type { ServiceInfo, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import * as download from "../model/download";
import { TaskPage } from "../pages/TaskPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const info = (debug: boolean | undefined): ServiceInfo => ({ ok: true, app: "taskwright", version: "0.5.0", mode: "server", pid: 1, port: 8940,
  ...(debug === undefined ? {} : { debug }), capabilities: { exit: false, model: true, model_config: true, knowledge: false } });
const TASK = { task_id: "TASK-P", task_name: "图书馆借还", task_type: "需求工程", domain_tag: null, started_at: "2026-10-10T09:00:00",
  definition: { collections: [] }, items: [], completion: null, latest_revision: 0, sessions: [], materials: [], knowledge_libraries: [] } as unknown as TaskDetail;
const PERSONA = { 名字: "", 说明: "由任务「图书馆借还」（TASK-P）导出的草稿", 人设: "", 目标: "", 答不上的说法: [], 材料: ["材料.md"], 熟悉的材料: ["材料.md"], 材料说明: "",
  隐藏事实: [{ 事实: "预约的书到馆后留三天。", 关键词: [], 必须同时出现: [], 问到的迹象: [] }], 接受底线: [] };

async function page(debug: boolean | undefined) {
  vi.spyOn(api, "getTask").mockResolvedValue(TASK);
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  const service = vi.spyOn(api, "serviceInfo").mockResolvedValue(info(debug));
  const draft = vi.spyOn(api, "personaDraft").mockResolvedValue({ file_name: "persona-TASK-P.json", persona: PERSONA, sessions: 2, facts: 1, skipped: [] });
  const saved = vi.spyOn(download, "saveBlob").mockImplementation(() => {});
  render(<ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider><TaskPage taskId="TASK-P" /></ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
  await screen.findByTestId("task-page");
  await waitFor(() => expect(service).toHaveBeenCalled());
  return { draft, saved };
}

describe("任务页的导出为用户画像", () => {
  it("服务开着调试模式：有这个按钮；点了把后端整理的草稿存成文件，文件名用后端给的，并说明导出了几条", async () => {
    const { draft, saved } = await page(true);
    const button = await screen.findByTestId("export-persona");
    expect(button).toHaveTextContent("导出为用户画像");
    fireEvent.click(button);
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(draft).toHaveBeenCalledWith("TASK-P");
    const [blob, name] = saved.mock.calls[0];
    expect(name).toBe("persona-TASK-P.json");
    expect((blob as Blob).type).toBe("application/json");
    expect(JSON.parse(await (blob as Blob).text())).toEqual(PERSONA);
    expect(await screen.findByText("已导出 1 条，来自 2 条会话。关键词、人设与目标要你自己补。")).toBeInTheDocument();
  });

  it("后端取不到（例如服务重启后不再是调试模式）：报出原因，不存文件", async () => {
    const { draft, saved } = await page(true);
    draft.mockRejectedValue(new ApiError("not_found", "这个接口只在调试模式下可用：启动服务时加上 --debug。", 404));
    fireEvent.click(await screen.findByTestId("export-persona"));
    expect(await screen.findByText("这个接口只在调试模式下可用：启动服务时加上 --debug。")).toBeInTheDocument();
    expect(saved).not.toHaveBeenCalled();
  });

  it("服务没有开调试模式（或者是较早的后端、没有这一项）：没有这个按钮", async () => {
    for (const debug of [false, undefined]) {
      await page(debug);
      expect(screen.queryByTestId("export-persona")).toBeNull();
      cleanup();
      vi.restoreAllMocks();
    }
  });
});
