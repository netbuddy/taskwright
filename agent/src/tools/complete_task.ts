/**
 * 「完成任务」工具（complete_task）：完成条件全部满足之后，执行者调用它把任务标为已完成。
 * 本文件只做三件事：声明参数（没有参数）、从会话分支读出用户在完成卡片上的点击、调用 lib/complete_task.ts 的核心函数。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeTask } from "../lib/complete_task.ts";
import { lastCompletionClick } from "../lib/completion_consent.ts";
import { currentRun, requireUnderstanding } from "../lib/dialogue_acts.ts";
import { isUnderstandingGate, reportStopped, stopAtLimit } from "../lib/rejection_limit.ts";
import { withRejectionRecord, workIdOf } from "../lib/tool_rejection.ts";

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
      // 对话理解：这一轮没有有效的理解就拒绝（lib/dialogue_acts.ts）。
      const branch = ctx.sessionManager.getBranch() as never;
      // 被拒时把拒绝记进 tool_rejection 表（lib/tool_rejection.ts），拒绝文字照样交还模型。
      const rejection = { workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), callId: toolCallId, toolName: TOOL_NAME,
        workId: workIdOf(currentRun(branch)?.userEntryId) };
      return withRejectionRecord(rejection, _params, () => {
        requireUnderstanding(ctx.cwd, ctx.sessionManager.getSessionId(), branch, "完成任务", TOOL_NAME);
        // 用户的同意：会话里最近一次对「这个任务是否已经完成」卡片的点击（lib/completion_consent.ts）。
        const click = lastCompletionClick(branch);
        const outcome = completeTask({
          workspaceDir: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
          callId: toolCallId,
          consent: click ? { source: "card", click } : null,
        });
        return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
      }).catch((error: unknown) => {
        // 因为没有合格的理解而被拒、而且这一轮连续被拒到上限：返回「出错并结束本次运行」的结果（lib/rejection_limit.ts）。
        // 输入不合规的拒绝不算，照常抛出，让模型改正之后再试。
        const stopped = stopAtLimit(error, branch, isUnderstandingGate(error));
        if (!stopped) throw error;
        reportStopped(ctx.ui, TOOL_NAME, stopped);
        return stopped;
      });
    },
  });
}
