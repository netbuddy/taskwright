// 设置页面的「调试」一栏：服务没有开调试模式时没有这一栏；开着时多出来，里面是提示词目录：
// 没有设时说明用的都是原来的说明；填了目录点保存，列出固定的十三个文件名各自会怎样；后端拒绝时把原话显示出来；点「不用目录」清掉。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { ApiError, api } from "../api/client";
import type { ModelConfig, PromptDirView, ServiceInfo } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { SettingsPage } from "../pages/SettingsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const service = (debug: boolean | undefined): ServiceInfo => ({
  ok: true, app: "taskwright", version: "0.5.0", mode: "server", pid: 1, port: 8790, ...(debug === undefined ? {} : { debug }),
  capabilities: { exit: false, model: true, model_config: true, model_test: true },
});
const NAMES = ["system.md", "common.md", "reading.md", "clarifying.md", "modeling.md", "writing.md", "reviewing.md",
  "task-type/common.md", "task-type/reading.md", "task-type/clarifying.md", "task-type/modeling.md", "task-type/writing.md", "task-type/reviewing.md"];
const view = (dir: string | null, states: Record<string, [PromptDirView["files"][number]["state"], string | null]> = {}, over: Partial<PromptDirView> = {}): PromptDirView => ({
  prompt_dir: dir, usable: dir === null ? null : true, note: null,
  files: NAMES.map((name) => ({ name, state: states[name]?.[0] ?? "absent", reason: states[name]?.[1] ?? null })), ...over,
});

function page(info: ServiceInfo) {
  vi.spyOn(api, "serviceInfo").mockResolvedValue(info);
  vi.spyOn(api, "modelConfig").mockResolvedValue({ ok: true, providers: [], selection: { language: null, embedding: null } } as unknown as ModelConfig);
  render(
    <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>
      <SettingsPage />
    </ServiceProvider></ToastProvider></AntApp></ConfigProvider>,
  );
}

describe("设置页面的「调试」一栏", () => {
  it("服务没有开调试模式（或者是较早的后端、没有这一项）：左边没有「调试」，也不去读提示词目录", async () => {
    for (const debug of [false, undefined]) {
      const read = vi.spyOn(api, "promptDir");
      page(service(debug));
      await screen.findByTestId("settings-nav-appearance");
      await waitFor(() => expect(api.serviceInfo).toHaveBeenCalled());
      expect(screen.queryByTestId("settings-nav-debug")).toBeNull();
      expect(read).not.toHaveBeenCalled();
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it("开着调试模式：左边多出「调试」；没有设目录时说明用的都是原来的说明，没有清单，「不用目录」点不了", async () => {
    vi.spyOn(api, "promptDir").mockResolvedValue(view(null));
    page(service(true));
    fireEvent.click(await screen.findByTestId("settings-nav-debug"));
    expect(await screen.findByTestId("prompt-dir-none")).toHaveTextContent("现在没有设目录，用的都是原来的说明。");
    expect(screen.queryByTestId("prompt-dir-files")).toBeNull();
    expect(screen.getByTestId("prompt-dir-clear")).toBeDisabled();
    expect(screen.getByTestId("debug-settings")).toHaveTextContent("请只在自己的电脑上用");
  });

  it("填目录点保存：列出十三个文件名各自会怎样；目录里有而不用的写明原因；再点「不用目录」清掉", async () => {
    vi.spyOn(api, "promptDir").mockResolvedValue(view(null));
    const set = vi.spyOn(api, "setPromptDir").mockImplementation(async (path: string) => path === "" ? view(null)
      : view(path, { "clarifying.md": ["used", null], "system.md": ["refused", "它是一个软链接，这一份照旧用原来的。"] }));
    page(service(true));
    fireEvent.click(await screen.findByTestId("settings-nav-debug"));
    await screen.findByTestId("prompt-dir-none");
    fireEvent.change(screen.getByTestId("prompt-dir-input"), { target: { value: "/data/prompts" } });
    fireEvent.click(screen.getByTestId("prompt-dir-save"));
    const table = await screen.findByTestId("prompt-dir-files");
    expect(set).toHaveBeenCalledWith("/data/prompts");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(13);
    expect(screen.getByTestId("prompt-file-clarifying.md")).toHaveTextContent("用目录里的这一份。");
    expect(screen.getByTestId("prompt-file-system.md")).toHaveTextContent("目录里有，但是不用：它是一个软链接，这一份照旧用原来的。");
    expect(screen.getByTestId("prompt-file-task-type/writing.md")).toHaveTextContent("目录里没有，用原来的。");
    expect(screen.queryByTestId("prompt-dir-none")).toBeNull();
    expect(screen.getByTestId("prompt-dir-input")).toHaveValue("/data/prompts");

    fireEvent.click(screen.getByTestId("prompt-dir-clear"));
    await screen.findByTestId("prompt-dir-none");
    expect(set).toHaveBeenLastCalledWith("");
    expect(screen.queryByTestId("prompt-dir-files")).toBeNull();
    expect(screen.getByTestId("prompt-dir-input")).toHaveValue("");
  });

  it("后端不收这个目录：把它的原话显示出来，原来设的不变；设了的目录后来不在了，显示后端给的那句说明", async () => {
    vi.spyOn(api, "promptDir").mockResolvedValue(view("/gone", {}, { usable: false, note: "这个目录不存在或者不是目录：/gone。现在每次运行用的都是产品自带的文字。" }));
    vi.spyOn(api, "setPromptDir").mockRejectedValue(new ApiError("bad_request", "提示词目录要写绝对路径，现在写的是「prompts」。", 400));
    page(service(true));
    fireEvent.click(await screen.findByTestId("settings-nav-debug"));
    expect(await screen.findByTestId("prompt-dir-note")).toHaveTextContent("这个目录不存在或者不是目录：/gone。现在每次运行用的都是产品自带的文字。");
    fireEvent.change(screen.getByTestId("prompt-dir-input"), { target: { value: "prompts" } });
    fireEvent.click(screen.getByTestId("prompt-dir-save"));
    expect(await screen.findByTestId("prompt-dir-error")).toHaveTextContent("提示词目录要写绝对路径，现在写的是「prompts」。");
    expect(screen.getByTestId("prompt-dir-input")).toHaveValue("prompts");
  });
});
