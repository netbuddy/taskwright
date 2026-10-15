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
import { fillText } from "../lib/texts.ts";

export const TOOL_NAME = "publish_version";

export function registerPublishVersion(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "发布版本",
    description: fillText("publish_version.description"),
    promptSnippet: fillText("publish_version.snippet"),
    parameters: Type.Object({
      note: Type.Optional(Type.String({ description: fillText("publish_version.param.note") })),
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
