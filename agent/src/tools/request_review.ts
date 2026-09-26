/**
 * 「请求评审」工具（request_review）：评审的主入口是用户在界面上点「评审」；这个工具只在用户在对话里要求评审时由执行者调用。
 * 本文件只做编排：核对参数，占用评审名额（同一时刻只跑一批，见 lib/review_ui.ts 的 reviewSlot），把 pi 的模型调用接到
 * lib/review_run.ts 的调度上（评审者用启动配置里的同一个模型，不带工具、干净上下文）。评审者的调用不经 pi 的运行循环，
 * Langfuse 里看不到，每次调用都记进 model_call。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkReviewParams } from "../lib/review.ts";
import { runReviews } from "../lib/review_run.ts";
import { piComplete, reviewSlot } from "../lib/review_ui.ts";
import { currentRun } from "../lib/dialogue_acts.ts";
import { withRejectionRecord, workIdOf } from "../lib/tool_rejection.ts";

export const TOOL_NAME = "request_review";

const parameters = Type.Object({
  items: Type.Optional(Type.Array(
    Type.Object(
      {
        item_id: Type.Optional(Type.String({ description: "条目编号，例如 UC-001。" })),
        revision_no: Type.Optional(Type.Integer({ description: "条目当前所在的修订号。" })),
      },
      { additionalProperties: true },
    ),
    { description: "要评审的条目，每项是 { item_id, revision_no }；不写就评全部待评审的条目。" },
  )),
});

export function registerRequestReview(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "请求评审",
    description:
      "只在用户在对话里要求评审时调用，请评审者按规则清单评审条目的当前内容；items 不写就评全部待评审的条目。" +
      "它逐条返回合规或不合规，以及每条发现（规则编号、字段、问题、改法），发现分问题（必选规则）与建议（可选规则）两类。" +
      "评审平时由用户在界面上发起，不要主动调用。",
    promptSnippet: "用户在对话里要求评审时，请评审者按规则清单评审条目",
    parameters,
    executionMode: "sequential",
    async execute(toolCallId: string, params: unknown, signal, _onUpdate, ctx: ExtensionContext) {
      // 被拒时把拒绝记进 tool_rejection 表（lib/tool_rejection.ts）；没有可用的模型、上一批评审还没做完两种不是输入的问题，不记。
      const rejection = { workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), callId: toolCallId, toolName: TOOL_NAME,
        workId: workIdOf(currentRun(ctx.sessionManager.getBranch() as never)?.userEntryId) };
      return withRejectionRecord(rejection, params, async () => {
        const requested = checkReviewParams(params);
        const { model, complete } = piComplete(ctx, toolCallId);
        const release = reviewSlot(ctx.cwd, toolCallId);
        try {
          const outcome = await runReviews(
            { workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), callId: toolCallId },
            requested,
            { model, signal, complete },
          );
          return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
        } finally {
          release();
        }
      });
    },
  });
}
