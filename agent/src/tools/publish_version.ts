/**
 * 「发布版本」工具（publish_version）：完成条件全部满足、用户在卡片上同意之后，执行者调用它发布一个版本。
 * 本文件只做三件事：声明参数（只有一句可选的发布说明）、从会话分支读出用户在完成卡片上的点击、调用 lib/publish_version.ts 的核心函数，
 * 文档存档请任务服务写（lib/version_archive.ts）。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { publishWithArchive } from "../lib/publish_version.ts";
import { archiveWithService } from "../lib/version_archive.ts";
import { lastCompletionClick } from "../lib/completion_consent.ts";
import { currentRun, requireUnderstanding } from "../lib/dialogue_acts.ts";
import { isUnderstandingGate, reportStopped, stopAtLimit } from "../lib/rejection_limit.ts";
import { withRejectionRecord, workIdOf } from "../lib/tool_rejection.ts";

export const TOOL_NAME = "publish_version";

export function registerPublishVersion(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "发布版本",
    description:
      "完成条件全部满足、用户在卡片上同意之后调用，发布一个版本：记下版本号、发布时的修订号与发布说明，并把这一版生成的文档存下来。" +
      "它只核对事实：每个条目在当前所在的修订有没有评审通过的记录、用户有没有看过（没有未读的条目）、有没有状态为未解决的问题条目、" +
      "集合里至少有没有一个条目等，与看板上的完成条件同一组核对；还核对用户同意了发布、同意之后交付物没有新的修订。" +
      "有没满足的它会拒绝，并逐条告诉你缺什么；这时把缺的告诉用户，不要反复调用。发布之后任务照常可以修改，以后再发布新的一版。",
    promptSnippet: "完成条件全部满足、用户同意之后，发布一个版本",
    parameters: Type.Object({
      note: Type.Optional(Type.String({ description: "发布说明，一句话，例如「首版，覆盖借阅主流程」；可以不写。" })),
    }, { additionalProperties: true }),
    executionMode: "sequential",
    async execute(toolCallId: string, _params: unknown, signal, _onUpdate, ctx: ExtensionContext) {
      // 对话理解：这一轮没有有效的理解就拒绝（lib/dialogue_acts.ts）。
      const branch = ctx.sessionManager.getBranch() as never;
      // 被拒时把拒绝记进 tool_rejection 表（lib/tool_rejection.ts），拒绝文字照样交还模型。
      const rejection = { workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), callId: toolCallId, toolName: TOOL_NAME,
        workId: workIdOf(currentRun(branch)?.userEntryId) };
      return withRejectionRecord(rejection, _params, () => {
        requireUnderstanding(ctx.cwd, ctx.sessionManager.getSessionId(), branch, "发布版本", TOOL_NAME);
        // 用户的同意：会话里最近一次对「这个任务是否已经完成」卡片的点击（lib/completion_consent.ts）。
        const click = lastCompletionClick(branch);
        const note = typeof (_params as { note?: unknown } | null)?.note === "string" ? (_params as { note: string }).note : null;
        return publishWithArchive({
          workspaceDir: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
          callId: toolCallId,
          consent: click ? { source: "card", click } : null,
          note,
        }, (ready) => archiveWithService(ctx.cwd, ready, { signal: signal ?? undefined }))
          .then((outcome) => ({ content: [{ type: "text" as const, text: outcome.text }], details: outcome.details }));
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
