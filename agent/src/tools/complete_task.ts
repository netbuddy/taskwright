/**
 * 「完成任务」工具（complete_task）：完成条件全部满足之后，执行者调用它把任务标为已完成。
 * 本文件只做两件事：声明参数（没有参数）、调用 lib/complete_task.ts 的核心函数。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeTask } from "../lib/complete_task.ts";

export const TOOL_NAME = "complete_task";

export function registerCompleteTask(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "完成任务",
    description:
      "完成条件全部满足之后调用，把任务标为已完成。它只核对事实：每个条目在当前所在的修订有没有评审通过的记录、" +
      "用户有没有看过（没有未读的条目）、有没有状态为未解决的问题条目、集合里至少有没有一个条目等，与看板上的完成条件同一组核对。" +
      "有没满足的它会拒绝，并逐条告诉你缺什么；这时把缺的告诉用户，不要反复调用。",
    promptSnippet: "完成条件全部满足之后，把任务标为已完成",
    parameters: Type.Object({}, { additionalProperties: true }),
    executionMode: "sequential",
    async execute(toolCallId: string, _params: unknown, _signal, _onUpdate, ctx: ExtensionContext) {
      const outcome = completeTask({
        workspaceDir: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        callId: toolCallId,
      });
      return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
    },
  });
}
