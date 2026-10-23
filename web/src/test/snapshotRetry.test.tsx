// 读一条会话的整份数据：页面等得比助手启动的上限更久（100 秒）；因为助手正在启动、或者正在另一条会话里工作而读不到时，
// 隔 3 秒自动再读，读到或者换成别的错误为止。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { api, ApiError, SNAPSHOT_TIMEOUT_MS } from "../api/client";
import type { StreamHandlers } from "../api/events";
import type { Snapshot } from "../api/types";
import { SNAPSHOT_RETRY_MS, snapshotRetryText } from "../state/snapshotRetry";
import { useWorkView } from "../state/useWorkView";

let handlers: StreamHandlers | null = null;
vi.mock("../api/events", () => ({
  openEventStream: (_url: string, _last: () => number | null, h: StreamHandlers) => { handlers = h; return () => {}; },
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); handlers = null; });

const SNAPSHOT = {
  seq: 0, generated_at: "", executor: { state: "idle", text: "", active_session: "S-1" },
  session: { session_id: "S-1", name: "会话", started_at: "", last_active_at: "" },
  task: { task_id: "TASK-1", task_name: "任务", task_type: "需求工程", domain_tag: null, started_at: "", definition: { collections: [] }, completion: null, items: [] },
  materials: [], conversation: { messages: [], has_earlier: false, earliest_id: null }, current_work: null,
} as unknown as Snapshot;

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("整份数据读不到时自动再读", () => {
  // 第一次连上事件流时页面可能连着读两次（读到之前的那次失败得很快时）；下面按第一次读完之后的次数往上数。
  it("助手正在启动、正在另一条会话里工作：隔 3 秒再读，读到为止，错误随之清掉", async () => {
    vi.useFakeTimers();
    let answer = (): Promise<Snapshot> => Promise.reject(new ApiError("executor_starting", "助手正在启动，请稍候。", 503));
    const read = vi.spyOn(api, "snapshot").mockImplementation(() => answer());
    const { result } = renderHook(() => useWorkView("TASK-1", "S-1"));
    await act(async () => handlers!.onStatus!("open"));
    await flush();
    const first = read.mock.calls.length;
    expect(result.current.loadErrorCode).toBe("executor_starting");
    answer = () => Promise.reject(new ApiError("session_busy", "助手正在另一条会话里工作，做完才能在这里继续。", 409));
    await wait(SNAPSHOT_RETRY_MS - 100);
    expect(read).toHaveBeenCalledTimes(first);
    await wait(100);
    expect(read).toHaveBeenCalledTimes(first + 1);
    expect(result.current.loadErrorCode).toBe("session_busy");
    answer = () => Promise.resolve(SNAPSHOT);
    await wait(SNAPSHOT_RETRY_MS);
    expect(read).toHaveBeenCalledTimes(first + 2);
    expect([result.current.state.phase, result.current.loadError, result.current.loadErrorCode]).toEqual(["ready", null, null]);
    await wait(SNAPSHOT_RETRY_MS * 3);
    expect(read).toHaveBeenCalledTimes(first + 2);
  });

  it("别的错误（没有这条会话）：不自动再读，照旧报错", async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(api, "snapshot").mockRejectedValue(new ApiError("not_found", "这个任务实例里没有会话 S-1。", 404));
    const { result } = renderHook(() => useWorkView("TASK-1", "S-1"));
    await act(async () => handlers!.onStatus!("open"));
    await flush();
    const first = read.mock.calls.length;
    await wait(SNAPSHOT_RETRY_MS * 4);
    expect(read).toHaveBeenCalledTimes(first);
    expect(result.current.loadErrorCode).toBe("not_found");
  });

  it("离开页面之后不再自动读", async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(api, "snapshot").mockRejectedValue(new ApiError("executor_starting", "助手正在启动，请稍候。", 503));
    const { unmount } = renderHook(() => useWorkView("TASK-1", "S-1"));
    await act(async () => handlers!.onStatus!("open"));
    await flush();
    const first = read.mock.calls.length;
    unmount();
    await wait(SNAPSHOT_RETRY_MS * 3);
    expect(read).toHaveBeenCalledTimes(first);
  });

  it("等待期间整页的那句：两种错误各一句，别的错误为空", () => {
    expect(snapshotRetryText("executor_starting")).toBe("助手正在启动，几秒后自动重试。");
    expect(snapshotRetryText("session_busy")).toBe("助手正在另一条会话里工作，做完之后自动打开这条会话。");
    expect(snapshotRetryText("timeout")).toBeNull();
    expect(snapshotRetryText(null)).toBeNull();
  });
});

describe("整份数据的等待时限", () => {
  it("等 100 秒：启动慢时 30 秒、60 秒都还在等，100 秒才放弃", async () => {
    expect(SNAPSHOT_TIMEOUT_MS).toBe(100_000);
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_ok, fail) => {
      init.signal?.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })));
    let settled: ApiError | null = null;
    const pending = api.snapshot("TASK-1", "S-1").catch((e: ApiError) => (settled = e));
    await vi.advanceTimersByTimeAsync(99_900);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(settled!.code).toBe("timeout");
  });
});
