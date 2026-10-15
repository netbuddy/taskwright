// 直接操作的等待：页面比任务服务等结果的 10 秒多等一会儿，任务服务的 busy_timeout 才到得了页面。
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTION_TIMEOUT_MS, ApiError, api } from "../api/client";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("直接操作的超时", () => {
  it("页面等 15 秒：10 秒时任务服务回的 busy_timeout 照样收到；没有回答时 15 秒才放弃", async () => {
    expect(ACTION_TIMEOUT_MS).toBe(15_000);
    vi.useFakeTimers();
    const said = "这次操作没有在 10 秒内得到结果，请稍后看是否已经生效。";
    // 任务服务 10 秒时回 busy_timeout
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((ok, fail) => {
      init.signal?.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
      setTimeout(() => ok(new Response(JSON.stringify({ ok: false, error: { code: "busy_timeout", message: said, data: { op_id: "op-1" } } }), { status: 503 })), 10_000);
    })));
    const answered = api.action("T1", "S1", { kind: "mark_viewed", targets: [], fields: {} } as never).catch((e: ApiError) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const got = await answered;
    expect([(got as ApiError).code, (got as ApiError).message]).toEqual(["busy_timeout", said]);

    // 任务服务一直不回：14.9 秒时还在等，15 秒放弃
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_ok, fail) => {
      init.signal?.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })));
    let settled: ApiError | null = null;
    const silent = api.action("T1", "S1", { kind: "mark_viewed", targets: [], fields: {} } as never).catch((e: ApiError) => (settled = e));
    await vi.advanceTimersByTimeAsync(14_900);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    await silent;
    expect(settled!.code).toBe("timeout");
  });
});
