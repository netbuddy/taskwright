// 全站提示条：四种语气的时长（成功 4 秒、警告 8 秒、进行中与失败不自己消失）、新的在最上面、最多叠三条、
// 鼠标停在上面暂停计时、同一个 key 原地更新、末尾动作；以及工作视图里服务器问题与事件流断开重连两种报法。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { ToastProvider, useToast, type ToastApi } from "../components/Toasts";
import { RECONNECTED_TEXT, RECONNECTING_TEXT, useConnectionToast, useProblemToasts } from "../components/work/workToasts";
import type { StreamStatus } from "../api/events";
import type { Problem } from "../api/types";

afterEach(() => { cleanup(); vi.useRealTimers(); });

/** 渲染一个提示条容器，把它的接口交给测试。 */
function mount(): ToastApi {
  let api: ToastApi | null = null;
  const Grab = () => { const t = useToast(); useEffect(() => { api = t; }, [t]); return null; };
  render(<ToastProvider><Grab /></ToastProvider>);
  return api!;
}
const shown = () => [...document.querySelectorAll(".tw-toast:not(.leaving)")].map((e) => e.querySelector(".tx")?.textContent);
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("提示条", () => {
  it("成功 4 秒后淡出，警告 8 秒后淡出，失败停住直到点 ×", () => {
    vi.useFakeTimers();
    const t = mount();
    act(() => { t.success("已保存"); t.warning("模型服务暂时不可用"); t.error("没有保存"); });
    advance(4100);
    expect(shown()).toEqual(["没有保存", "模型服务暂时不可用"]);
    advance(4000);
    expect(shown()).toEqual(["没有保存"]);
    advance(60000);
    expect(shown()).toEqual(["没有保存"]);
    fireEvent.click(screen.getByTestId("toast-close"));
    expect(shown()).toEqual([]);
  });

  it("新的在最上面；成功、进行中、警告最多叠三条，多出的最旧一条先收起", () => {
    vi.useFakeTimers();
    const t = mount();
    act(() => { t.success("一"); t.warning("二"); t.running("r", "三"); t.success("四"); });
    expect(shown()).toEqual(["四", "三", "二"]);
  });

  it("失败提示不算在三条里、也不被挤掉：几条失败都留着，逐条点 × 才关", () => {
    vi.useFakeTimers();
    const t = mount();
    act(() => { t.error("失败一"); t.error("失败二"); t.error("失败三"); t.error("失败四"); });
    act(() => { t.success("成功一"); t.success("成功二"); t.warning("警告一"); t.success("成功三"); });
    expect(shown()).toEqual(["成功三", "警告一", "成功二", "失败四", "失败三", "失败二", "失败一"]);
    advance(60000);
    expect(shown()).toEqual(["失败四", "失败三", "失败二", "失败一"]);
    fireEvent.click(screen.getAllByTestId("toast-close")[0]);
    expect(shown()).toEqual(["失败三", "失败二", "失败一"]);
  });

  it("鼠标停在上面时暂停计时，移开后按剩下的时间接着计", () => {
    vi.useFakeTimers();
    const t = mount();
    act(() => { t.success("已上传"); });
    advance(3000);
    fireEvent.mouseEnter(screen.getByTestId("toast-ok"));
    advance(10000);
    expect(shown()).toEqual(["已上传"]);
    fireEvent.mouseLeave(screen.getByTestId("toast-ok"));
    advance(900);
    expect(shown()).toEqual(["已上传"]);
    advance(200);
    expect(shown()).toEqual([]);
  });

  it("同一个 key 原地更新：进行中换成成功，不另起一条；进行中不自己消失", () => {
    vi.useFakeTimers();
    const t = mount();
    act(() => { t.running("r", "评审中 1/4", { progress: 0.25 }); });
    advance(60000);
    expect(shown()).toEqual(["评审中 1/4"]);
    act(() => { t.success("评审完了", { key: "r" }); });
    expect(shown()).toEqual(["评审完了"]);
    expect(screen.getByTestId("toast-ok")).toBeInTheDocument();
  });

  it("末尾的动作：点了执行并收起这一条", () => {
    const t = mount();
    const open = vi.fn();
    act(() => { t.error("没有保存", { action: { label: "打开最新", onClick: open } }); });
    fireEvent.click(screen.getByText("打开最新"));
    expect(open).toHaveBeenCalled();
    expect(shown()).toEqual([]);
  });
});

describe("工作视图里的两种报法", () => {
  it("服务器问题：带重试信息的报警告，同一种问题再次重试时重新出现；其余报失败", () => {
    vi.useFakeTimers();
    const Probe = ({ problems }: { problems: Problem[] }) => { useProblemToasts(problems); return null; };
    const retry = (n: number): Problem => ({ code: "model_unavailable", text: `模型服务暂时不可用，正在第 ${n} 次重试。`, retry: { attempt: n, after_ms: 2000 } });
    const { rerender } = render(<ToastProvider><Probe problems={[retry(1)]} /></ToastProvider>);
    expect(screen.getByTestId("toast-warn")).toHaveTextContent("第 1 次重试");
    advance(9000);
    expect(screen.queryByTestId("toast-warn")).toBeNull();
    const stop: Problem = { code: "no_reply", text: "助手这次没有说话就停下了，你可以再问它一句。", retry: null };
    rerender(<ToastProvider><Probe problems={[retry(1), retry(2), stop]} /></ToastProvider>);
    expect(screen.getByTestId("toast-warn")).toHaveTextContent("第 2 次重试");
    expect(screen.getByTestId("toast-bad")).toHaveTextContent("助手这次没有说话就停下了");
  });

  it("事件流断开：警告，淡出后情况还在就重新出现；连上之后换成一条成功", () => {
    vi.useFakeTimers();
    const Probe = ({ stream }: { stream: StreamStatus }) => { useConnectionToast(stream); return null; };
    const { rerender } = render(<ToastProvider><Probe stream="open" /></ToastProvider>);
    expect(shown()).toEqual([]);
    rerender(<ToastProvider><Probe stream="reconnecting" /></ToastProvider>);
    expect(shown()).toEqual([RECONNECTING_TEXT]);
    advance(8300);
    expect(shown()).toEqual([]);
    advance(1300);
    expect(shown()).toEqual([RECONNECTING_TEXT]);
    rerender(<ToastProvider><Probe stream="open" /></ToastProvider>);
    expect(shown()).toEqual([RECONNECTED_TEXT]);
  });
});
