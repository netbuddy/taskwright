// 设置页面的「外观」一栏：进设置页面先看到「模型」，点「外观」换过去；两张界面风格卡（暖纸、素白），没有选过时暖纸打勾；
// 点素白立刻换（html 的 data-theme）并存在浏览器本地，勾跟着走；再打开设置页面沿用上次选的；
// 每张卡的预览自己带那一种风格的 data-theme。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { ModelConfig, ServiceInfo } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { AppearanceSettings } from "../components/settings/AppearanceSettings";
import { THEME_STORAGE_KEY, applyTheme, readTheme } from "../model/theme";
import { SettingsPage } from "../pages/SettingsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

const onPage = () => document.documentElement.getAttribute("data-theme");
/** 相当于打开页面：main.tsx 在画页面之前把存着的选择套上。 */
const open = () => { applyTheme(readTheme()); return render(<AppearanceSettings />); };

describe("设置页面的「外观」一栏", () => {
  it("没有选过时是暖纸：暖纸那张卡打勾，素白那张没有", () => {
    open();
    expect(onPage()).toBe("paper");
    const cards = screen.getAllByRole("radio");
    expect(cards.map((card) => card.querySelector(".nm")?.textContent)).toEqual(["暖纸", "素白"]);
    expect(screen.getByTestId("style-paper")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("style-plain")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("style-on-paper")).toHaveTextContent("现在用的");
    expect(screen.queryByTestId("style-on-plain")).toBeNull();
  });

  it("点素白：立刻换成素白并存下来，勾跟着走；再点暖纸换回去", () => {
    open();
    fireEvent.click(screen.getByTestId("style-plain"));
    expect(onPage()).toBe("plain");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("plain");
    expect(screen.getByTestId("style-plain")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("style-paper")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("style-on-paper")).toBeNull();
    fireEvent.click(screen.getByTestId("style-paper"));
    expect(onPage()).toBe("paper");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("paper");
    expect(screen.getByTestId("style-paper")).toHaveAttribute("aria-checked", "true");
  });

  it("再次打开沿用上次选的", () => {
    const first = open();
    fireEvent.click(screen.getByTestId("style-plain"));
    first.unmount();
    document.documentElement.removeAttribute("data-theme");
    open();
    expect(onPage()).toBe("plain");
    expect(screen.getByTestId("style-plain")).toHaveAttribute("aria-checked", "true");
  });

  it("每张卡的预览带着那一种风格的 data-theme，不随页面当前的风格变", () => {
    open();
    const preview = (key: string) => screen.getByTestId(`style-${key}`).querySelector(".pv");
    expect(preview("paper")).toHaveAttribute("data-theme", "paper");
    expect(preview("plain")).toHaveAttribute("data-theme", "plain");
    fireEvent.click(screen.getByTestId("style-plain"));
    expect(preview("paper")).toHaveAttribute("data-theme", "paper");
    expect(preview("plain")).toHaveAttribute("data-theme", "plain");
  });

  it("文字只说「界面风格」「暖纸」「素白」", () => {
    open();
    const text = screen.getByTestId("appearance-settings").textContent ?? "";
    expect(text).toContain("界面风格");
    expect(text).not.toMatch(/主题|令牌|方案/);
  });
});

describe("设置页面的栏目", () => {
  const service: ServiceInfo = { ok: true, app: "taskwright", version: "0.4.3", mode: "server", pid: 1, port: 8940, capabilities: { exit: false, model: true, model_config: true } };
  const config: ModelConfig = { ok: true, editable: true, notice: null, selection: { language: null, embedding: null }, fallback: { model: "fake/fake-model", from: "启动配置" }, providers: [] };

  it("进来先看到「模型」，点「外观」换过去，再点「模型」换回来；「知识库」仍是灰的", async () => {
    vi.spyOn(api, "serviceInfo").mockResolvedValue(service);
    vi.spyOn(api, "modelConfig").mockResolvedValue(config);
    render(
      <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>
        <SettingsPage />
      </ServiceProvider></ToastProvider></AntApp></ConfigProvider>,
    );
    expect(await screen.findByTestId("model-settings")).toBeInTheDocument();
    expect(screen.getByTestId("settings-nav-model")).toHaveClass("on");
    expect(screen.queryByTestId("appearance-settings")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-nav-appearance"));
    expect(screen.getByTestId("appearance-settings")).toBeInTheDocument();
    expect(screen.getByTestId("settings-nav-appearance")).toHaveClass("on");
    expect(screen.getByTestId("settings-nav-model")).not.toHaveClass("on");
    expect(screen.queryByTestId("model-settings")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-nav-model"));
    expect(await screen.findByTestId("model-settings")).toBeInTheDocument();
    expect(screen.getByText("知识库").closest(".nav-item")).toHaveAttribute("aria-disabled", "true");
  });
});
