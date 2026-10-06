// 按服务信息的能力清单显示的两样：没有模型时的顶部提示；桌面形态下「本机用户」菜单里的「退出服务」（二次确认、退出后整屏）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { ServiceInfo } from "../api/types";
import { Shell } from "../components/Shell";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { settled } from "./settled";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const info = (over: Partial<ServiceInfo> = {}): ServiceInfo => ({
  ok: true, app: "taskwright", version: "0.3.0", mode: "desktop", pid: 1, port: 8950,
  capabilities: { exit: true, model: true }, model: { name: "local/qwen", reason: "在模型登记文件 /x/models.json 里找到了「local/qwen」。" }, ...over,
});

function page() {
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  return render(
    <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>
      <Shell><div>页面主体</div></Shell>
    </ServiceProvider></ToastProvider></AntApp></ConfigProvider>,
  );
}

describe("无模型提示", () => {
  it("capabilities.model 为 false 时顶部出白话提示，「去配置模型」进设置页面，「详情」展开原因；为 true 时不出", async () => {
    const reason = "在模型登记文件 /x/models.json 和登录凭据文件 /x/auth.json 里都没有找到「local/qwen」。";
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info({ capabilities: { exit: true, model: false }, model: { name: "local/qwen", reason } }));
    page();
    const banner = await screen.findByTestId("no-model-banner");
    expect(banner).toHaveTextContent("还没有选定语言模型，助手现在不能工作。");
    expect(screen.queryByRole("link", { name: "查看配置说明" })).toBeNull();
    expect(banner).not.toHaveTextContent(reason);
    fireEvent.click(screen.getByTestId("no-model-detail"));
    expect(banner).toHaveTextContent(reason);
    for (const word of ["profile", "pi ", "投影"]) expect(banner.textContent).not.toContain(word);
    window.location.hash = "#/tasks";
    fireEvent.click(screen.getByTestId("go-model-settings"));
    expect(window.location.hash).toBe("#/settings/models");
    cleanup();

    vi.spyOn(api, "serviceInfo").mockResolvedValue(info());
    page();
    await screen.findByText("页面主体");
    // 桌面形态的「本机用户」菜单按钮出现，说明服务信息已经进了页面；这时再看没有提示。
    await screen.findByTestId("user-menu-button");
    expect(screen.queryByTestId("no-model-banner")).toBeNull();
  });
});

describe("退出服务", () => {
  it("只在桌面形态（capabilities.exit 为 true）有「本机用户」菜单；服务器形态与取不到服务信息时侧栏底部照旧只写「本机用户」", async () => {
    const server = vi.spyOn(api, "serviceInfo").mockResolvedValue(info({ mode: "server", capabilities: { exit: false, model: true } }));
    page();
    // 服务器形态的服务信息在页面上不留可见标志（侧栏与还没取到时一样），等它处理完再看。
    await settled(server);
    await screen.findByText("本机用户");
    expect(screen.queryByTestId("user-menu-button")).toBeNull();
    cleanup();

    const failed = vi.spyOn(api, "serviceInfo").mockRejectedValue(new Error("没有这个接口"));
    page();
    await settled(failed);
    await screen.findByText("本机用户");
    expect(screen.queryByTestId("user-menu-button")).toBeNull();
    cleanup();

    vi.spyOn(api, "serviceInfo").mockResolvedValue(info());
    page();
    fireEvent.click(await screen.findByTestId("user-menu-button"));
    expect(screen.getByTestId("user-menu")).toHaveTextContent("服务在本机运行：");
    expect(screen.getByTestId("exit-service")).toHaveTextContent("退出服务");
  });

  it("点「退出服务」先二次确认；取消不退出；确认后调退出接口，页面换成「服务已退出，可以关闭此窗口」", async () => {
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info());
    const exit = vi.spyOn(api, "exitService").mockResolvedValue({ ok: true });
    page();
    fireEvent.click(await screen.findByTestId("user-menu-button"));
    fireEvent.click(screen.getByTestId("exit-service"));
    expect(await screen.findByText("退出后页面将无法使用，确定退出？")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(exit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("user-menu-button"));
    fireEvent.click(screen.getByTestId("exit-service"));
    await screen.findByText("退出后页面将无法使用，确定退出？");
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(await screen.findByTestId("service-exited")).toHaveTextContent("服务已退出，可以关闭此窗口");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("页面主体")).toBeNull();
  });
});
