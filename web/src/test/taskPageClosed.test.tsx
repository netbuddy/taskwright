// 任务起点页在任务结束之后：没有活动目录与「进入工作台」，上传框一样不显示，只读说明写明原因；进行中的任务有「进入工作台」。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { TaskPage } from "../pages/TaskPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function taskPage(status: string) {
  const detail = {
    task_id: "TASK-C", task_name: "结束之后", task_type: "演示", domain_tag: null, status, started_at: "", ended_at: null,
    definition: { collections: [] }, items: [], completion: null, sessions: [], materials: [],
  } as unknown as TaskDetail;
  vi.spyOn(api, "getTask").mockResolvedValue(detail);
  vi.spyOn(api, "taskStatus").mockResolvedValue({ ok: true, status: null });
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "serviceInfo").mockRejectedValue(new Error("没有这个接口"));
  render(<ConfigProvider><AntApp><ToastProvider><ServiceProvider><TaskPage taskId="TASK-C" /></ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
}

describe("任务起点页的「进入工作台」", () => {
  it("任务进行中：显示，可以点", async () => {
    taskPage("进行中");
    expect(await screen.findByRole("button", { name: "进入工作台" })).toBeEnabled();
  });

  it.each(["已完成", "已放弃"])("任务%s：不显示，只读说明写明不能开展活动", async (status) => {
    taskPage(status);
    // 先等到只读说明出现（页面已按这个任务的状态画好），再断言按钮不在。
    await screen.findByText(`这个任务${status}，整页只读：不能开展活动、新建会话、上传材料或修改条目。`);
    expect(screen.queryByRole("button", { name: "进入工作台" })).toBeNull();
    expect(screen.getByTestId("task-status")).toHaveTextContent(status);
  });
});
