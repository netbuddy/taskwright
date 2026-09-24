/**
 * 「完成任务」工具（complete_task）：完成条件全部满足之后，执行者调用它把任务标为已完成。
 * 本文件只做三件事：声明参数（没有参数）、读开发期开关、调用 lib/complete_task.ts 的核心函数。
 *
 * 开发期开关：环境变量 TASKWRIGHT_DEV_REVIEW_AS_MET 为 1 时，「每个条目评审通过」暂时视为满足（评审工具还没有）。
 * 默认关；演练时在启动后端之前设好，后端启动 pi 时原样传给它。说明写在 server/taskwright_server/profiles/dev.json 的「开发期开关」一项。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REVIEW_SWITCH_ENV, completeTask, reviewSwitchOn } from "../lib/complete_task.ts";
import { requireUnderstanding } from "../lib/dialogue_acts.ts";

export const TOOL_NAME = "complete_task";

export { REVIEW_SWITCH_ENV };

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
      requireUnderstanding(ctx.cwd, ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch() as never, "完成任务", TOOL_NAME);
      const outcome = completeTask({
        workspaceDir: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        callId: toolCallId,
        treatReviewAsMet: reviewSwitchOn(),
      });
      return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
    },
  });
}
