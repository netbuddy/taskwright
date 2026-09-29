// 页面收到 502、503、504 而返回体里没有接口约定的说明时（任务服务停了或正在重启，转发的那一层回的），
// 提示写「连不上任务服务……」，不写状态码；带说明的照说明写，其余状态码照旧。四处兜底句都一样：普通请求（空的返回体、
// 不是 JSON 的返回体）、读 Word 原始字节、下载文档。
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, GATEWAY_TEXT } from "../api/client";

afterEach(() => vi.unstubAllGlobals());

function reply(status: number, body: string, type = "text/plain") {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "Content-Type": type } })));
}
async function failure(call: () => Promise<unknown>): Promise<ApiError> {
  try { await call(); } catch (e) { return e as ApiError; }
  throw new Error("没有出错");
}
const calls: [string, () => Promise<unknown>][] = [
  ["普通请求", () => api.getTask("TASK-1")],
  ["读 Word 原始字节", () => api.materialRaw("TASK-1", "inputs/a.docx")],
  ["下载文档", () => api.downloadDocument("TASK-1", {})],
];

describe("502、503、504 的提示", () => {
  for (const [name, call] of calls) {
    it(`${name}：没有说明的 502、503、504 写连不上任务服务`, async () => {
      for (const status of [502, 503, 504]) {
        reply(status, "");
        expect((await failure(call)).message, `${status} 空的返回体`).toBe(GATEWAY_TEXT);
        reply(status, "<html><body>Bad Gateway</body></html>", "text/html");
        expect((await failure(call)).message, `${status} 不是 JSON`).toBe(GATEWAY_TEXT);
      }
    });

    it(`${name}：返回体里带说明的照说明写`, async () => {
      reply(503, JSON.stringify({ ok: false, error: { code: "unavailable", message: "助手现在不可用。" } }), "application/json");
      expect((await failure(call)).message).toBe("助手现在不可用。");
    });
  }

  it("其余状态码照旧写状态码", async () => {
    reply(500, "");
    expect((await failure(() => api.getTask("TASK-1"))).message).toBe("请求没有成功（HTTP 500）。");
    reply(500, "<html></html>", "text/html");
    expect((await failure(() => api.getTask("TASK-1"))).message).toBe("服务返回了看不懂的内容（HTTP 500）。");
    reply(500, "");
    expect((await failure(() => api.materialRaw("TASK-1", "inputs/a.docx"))).message).toBe("请求没有成功（HTTP 500）。");
    reply(500, "");
    expect((await failure(() => api.downloadDocument("TASK-1", {}))).message).toBe("下载没有成功（HTTP 500）。");
  });
});
