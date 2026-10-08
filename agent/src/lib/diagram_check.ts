/**
 * 保存图之前问任务服务校验 Mermaid 文本的写法。
 *
 * 校验要用 mermaid 的解析，那一份代码在任务服务那一边（backend/src/diagram_validate.ts）；助手这一侧只把图的种类与文本
 * 发给任务服务的校验接口（POST /api/v1/tasks/{任务编号}/diagrams/validate），拿回通过或者不通过的原因。
 * 任务服务在哪里，与「查找知识库」同一个办法（lib/knowledge_search.ts 的 backendAddresses）：读任务目录里的占用标记，
 * 先连本机回环地址上的那个端口，连不上再按标记里的主机名连一次。
 *
 * 这里从不抛异常：联系不上任务服务、它回答了错误、到时间没有回答、这次调用被取消，都回一个 reason 为 unavailable 的结果
 * （校验没有做成）。校验没有做成不等于文本写对了：保存图那一步据此不保存，并让助手告诉用户（lib/save_diagram.ts）。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { backendAddresses } from "./knowledge_search.ts";
import type { DiagramCheck } from "./save_diagram.ts";

/** 等任务服务回答最多等多久：校验的那一部分第一次用到时要加载，最长 30 秒，之后一份文本最多 2 秒。 */
export const VALIDATE_TIMEOUT_MS = 40_000;

/** 校验接口的路径（backend/src/http.ts 的路由，两边是一份约定）。 */
export const validatePath = (taskId: string): string => `/api/v1/tasks/${encodeURIComponent(taskId)}/diagrams/validate`;

/** 校验没有做成时的结果。why 是原因，写成半句话。 */
export const unavailable = (why: string): DiagramCheck =>
  ({ ok: false, reason: "unavailable", line: null, message: `这一次没有办法校验 Mermaid 文本（${why}）。这是程序这边的问题，不是文本写错了，请告诉用户。` });

export const UNREACHABLE_WHY = "联系不上系统里负责校验的那一部分";

export interface CheckOptions {
  /** 助手取消这次工具调用时中止它。 */
  signal?: AbortSignal;
  /** 发请求用的函数，缺省是自带的 fetch（测试里换成假的）。 */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** 问任务服务：这段 Mermaid 文本按这个种类写得对不对。 */
export async function checkWithService(taskDir: string, taskId: string, kind: string, mermaid: string, options: CheckOptions = {}): Promise<DiagramCheck> {
  const addresses = backendAddresses(taskDir);
  if (!addresses.length) return unavailable(UNREACHABLE_WHY);
  const send = options.fetch ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? VALIDATE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let status = 0;
  let body: any = null;
  for (const address of addresses) {
    try {
      const res = await send(address + validatePath(taskId), {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ kind, mermaid }), signal,
      });
      status = res.status;
      body = await res.json().catch(() => null);
      break;
    } catch {
      // 这个地址连不上（或者到时间没有回答）：试下一个
      if (signal.aborted) break;
    }
  }
  if (options.signal?.aborted) return unavailable("这次调用被取消了");
  if (status === 0) return unavailable(timeout.aborted ? "等了很久没有等到校验的结果" : UNREACHABLE_WHY);
  if (status !== 200 || body?.ok !== true || typeof body.valid !== "boolean") {
    const message = typeof body?.error?.message === "string" && body.error.message ? body.error.message : `HTTP ${status}`;
    return unavailable(`系统回答了错误：${message}`);
  }
  if (body.valid) return { ok: true };
  return {
    ok: false, reason: typeof body.reason === "string" ? body.reason : "syntax",
    line: typeof body.line === "number" ? body.line : null,
    message: typeof body.message === "string" && body.message ? body.message : "Mermaid 文本写得不对。",
  };
}
