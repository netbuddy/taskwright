/**
 * 任务定义按会话给视图的挂点：助手用自带的 read 读任务定义文件时，把返回换成本会话的视图（lib/definition_view_read.ts 算视图文字，
 * lib/definition_view.ts 定视图的样子）。原文件不改；别的会话、程序的校验、get_task_status 工具照旧读原文件。不拦调用。
 * 换了的那次在工具结果的 details 里留一个标记（definition_view），写明给的是哪个位置的视图。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { definitionReadView } from "../lib/definition_view_read.ts";
import { resolvedPath } from "../lib/tool_limits.ts";

type ResultEvent = { toolName: string; input: Record<string, unknown>; isError: boolean; details?: unknown };
type ResultContext = { cwd: string; sessionManager?: { getSessionId(): string } };

/** 处理一次 tool_result：要换就返回换上的内容与 details，不换返回 undefined。单独导出是为了不起 pi 也能测。 */
export function definitionViewFor(event: ResultEvent, ctx: ResultContext) {
  if (event.toolName !== "read" || event.isError) return undefined;
  const view = definitionReadView(ctx.cwd, ctx.sessionManager?.getSessionId() ?? null, resolvedPath(ctx.cwd, event.input.path));
  if (view === null) return undefined;
  return {
    content: [{ type: "text" as const, text: view.text }],
    details: { ...((event.details as Record<string, unknown> | undefined) ?? {}), definition_view: { stage: view.stage } },
  };
}

export function registerDefinitionView(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event, ctx) => definitionViewFor(event, ctx));
}
