// 服务退出与断线：收到 service_exiting 之后整页换成退出画面（文字按运行形态）、不再重连、先前的提示都收起；
// 断开超过一分钟换成「连不上服务」并放慢重连，连上之后回到正常。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { api } from "../api/client";
import { openEventStream, SLOW_RETRY_MS, UNREACHABLE_AFTER_MS, type StreamStatus } from "../api/events";
import type { ServiceInfo } from "../api/types";
import { ExitedScreen, ServiceProvider } from "../components/ServiceControls";
import { ToastProvider, useToast } from "../components/Toasts";
import { useWorkView } from "../state/useWorkView";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const info = (mode: ServiceInfo["mode"]): ServiceInfo => ({ ok: true, app: "taskwright", version: "0.3.0", mode, pid: 1, port: 8950,
  capabilities: { exit: mode === "desktop", model: true } });

/** 一条事件流的回应：依次交出给定的几段文字，然后结束。 */
function streamOf(...chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: encoder.encode(chunks[i++]), done: false } : { value: undefined, done: true }) }) } };
}

describe("服务退出的通知", () => {
  for (const [mode, text] of [["server", "服务已停止。恢复之后刷新这个页面即可继续。"], ["desktop", "服务已退出，可以关闭此窗口"]] as const) {
    it(`${mode} 形态：事件流收到 service_exiting 之后换成退出画面，不再重连，先前的提示都收起`, async () => {
      vi.spyOn(api, "serviceInfo").mockResolvedValue(info(mode));
      vi.spyOn(api, "snapshot").mockReturnValue(new Promise(() => {}));
      const fetch = vi.fn(async () => streamOf(": connected\n\n", `event: service_exiting\ndata: {"mode": "${mode}", "at": "2026-09-27T10:00:00+08:00"}\n\n`));
      vi.stubGlobal("fetch", fetch);
      function Page() {
        const toast = useToast();
        useEffect(() => { toast.warning("先前的一条提示"); }, []);
        useWorkView("TASK-1", "S1");
        return <div>工作视图</div>;
      }
      render(<ToastProvider><ServiceProvider><Page /></ServiceProvider></ToastProvider>);
      const screenEl = await screen.findByTestId("service-exited");
      expect(screenEl).toHaveTextContent(text);
      expect(screenEl).toHaveAttribute("data-mode", mode);
      expect(screen.queryByText("工作视图")).toBeNull();
      await waitFor(() => expect(screen.queryByText("先前的一条提示")).toBeNull());
      await act(() => new Promise((ok) => setTimeout(ok, 1500)));
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }

  it("退出画面：桌面形态沿用原来的文字与第二行，服务器形态只有一句", () => {
    render(<ExitedScreen mode="desktop" />);
    expect(screen.getByTestId("service-exited")).toHaveTextContent("服务已退出，可以关闭此窗口要再用时，重新双击程序即可。");
    cleanup();
    render(<ExitedScreen mode="server" />);
    expect(screen.getByTestId("service-exited").textContent).toBe("服务已停止。恢复之后刷新这个页面即可继续。");
  });
});

describe("断线之后的重连", () => {
  it("连不上时照旧加倍间隔重连；断开满一分钟换成 unreachable、每 30 秒重连一次；连上之后回到 open", async () => {
    vi.useFakeTimers();
    let up = false;
    const fetch = vi.fn(async () => { if (!up) throw new TypeError("连不上"); return { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}) }) } }; });
    vi.stubGlobal("fetch", fetch);
    const statuses: StreamStatus[] = [];
    const close = openEventStream("/x", () => null, { onMessage: () => {}, onStatus: (s) => statuses.push(s) });
    const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
    await settle();
    expect(statuses).toEqual(["connecting", "reconnecting"]);
    // 1、2、4、8、15、15、15 秒之后的几次都还不满一分钟
    for (const ms of [1000, 2000, 4000, 8000, 15000, 15000]) { await vi.advanceTimersByTimeAsync(ms); await settle(); }
    expect(statuses.filter((s) => s === "unreachable")).toEqual([]);
    await vi.advanceTimersByTimeAsync(15000); await settle();
    expect(statuses.at(-1)).toBe("unreachable");
    expect(UNREACHABLE_AFTER_MS).toBe(60_000);
    const calls = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SLOW_RETRY_MS - 1000); await settle();
    expect(fetch.mock.calls.length, "放慢之后 30 秒内不再请求").toBe(calls);
    up = true;
    await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(fetch.mock.calls.length).toBe(calls + 1);
    expect(statuses.at(-1)).toBe("open");
    close();
  });
});
