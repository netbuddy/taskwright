// 按服务信息的能力清单显示的两样：没有模型时的顶部提示；桌面形态下「本机用户」菜单里的「退出服务」（二次确认、退出后整屏）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { ServiceInfo } from "../api/types";
import { Shell } from "../components/Shell";
import { MODEL_SETUP_URL, ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";

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
  it("capabilities.model 为 false 时顶部出白话提示，链接到部署文档的配置说明，「详情」展开原因；为 true 时不出", async () => {
    const reason = "在模型登记文件 /x/models.json 和登录凭据文件 /x/auth.json 里都没有找到「local/qwen」。";
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info({ capabilities: { exit: true, model: false }, model: { name: "local/qwen", reason } }));
    page();
    const banner = await screen.findByTestId("no-model-banner");
    expect(banner).toHaveTextContent("还没有配置模型服务，助手无法工作。请按说明放置配置文件后重新启动。");
    expect(screen.getByRole("link", { name: "查看配置说明" })).toHaveAttribute("href", MODEL_SETUP_URL);
    expect(banner).not.toHaveTextContent(reason);
    fireEvent.click(screen.getByTestId("no-model-detail"));
    expect(banner).toHaveTextContent(reason);
    for (const word of ["profile", "pi ", "投影"]) expect(banner.textContent).not.toContain(word);
    cleanup();

    vi.spyOn(api, "serviceInfo").mockResolvedValue(info());
    page();
    await screen.findByText("页面主体");
    await waitFor(() => expect(api.serviceInfo).toHaveBeenCalled());
    expect(screen.queryByTestId("no-model-banner")).toBeNull();
  });
});

describe("退出服务", () => {
  it("只在桌面形态（capabilities.exit 为 true）有「本机用户」菜单；服务器形态与取不到服务信息时侧栏底部照旧只写「本机用户」", async () => {
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info({ mode: "server", capabilities: { exit: false, model: true } }));
    page();
    await waitFor(() => expect(api.serviceInfo).toHaveBeenCalled());
    await screen.findByText("本机用户");
    expect(screen.queryByTestId("user-menu-button")).toBeNull();
    cleanup();

    vi.spyOn(api, "serviceInfo").mockRejectedValue(new Error("没有这个接口"));
    page();
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
