/**
 * 「请求评审」工具（request_review）：执行者保存条目之后调用，交给评审者按规矩文档评。
 * 本文件只做编排：核对参数，把 pi 的模型调用接到 lib/review_run.ts 的调度上（评审者用启动配置里的同一个模型，
 * 不带工具、干净上下文）。评审者的调用不经 pi 的运行循环，Langfuse 里看不到，每次调用都记进 model_call。
 * 点名的条目全都已经连续三次不合规、一条也没有评时，按拒绝返回，理由里带前三次的发现。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ReviewError, checkReviewParams } from "../lib/review.ts";
import { runReviews } from "../lib/review_run.ts";

export const TOOL_NAME = "request_review";

const parameters = Type.Object({
  items: Type.Optional(Type.Array(
    Type.Object(
      {
        item_id: Type.Optional(Type.String({ description: "条目编号，例如 UC-001。" })),
        revision_no: Type.Optional(Type.Integer({ description: "条目当前所在的修订号；只能评条目当前所在的修订。" })),
      },
      { additionalProperties: true },
    ),
    { description: "要评审的条目，每项是 { item_id, revision_no }。不写就评全部还没有评审通过的条目。" },
  )),
});

export function registerRequestReview(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "请求评审",
    description:
      "保存条目之后调用，请评审者按领域规矩文档评审条目的当前内容。items 不写就评全部还没有评审通过的条目。" +
      "它会逐条告诉你合规还是不合规，不合规的列出每一处发现（哪个字段、第几项、问题、建议）；按发现改好之后再请求评审。" +
      "同一条目在同一次修订下连续三次不合规就不再评，这时要把三次的发现原样转给用户，问他怎么办。",
    promptSnippet: "保存条目之后请评审者按规矩文档评审（合规或不合规，附逐条发现）",
    parameters,
    executionMode: "sequential",
    async execute(toolCallId: string, params: unknown, signal, _onUpdate, ctx: ExtensionContext) {
      const requested = checkReviewParams(params);
      const model = ctx.model;
      if (!model) throw new ReviewError("现在没有可用的模型，评审者无法评审，什么都没有评。");
      const outcome = await runReviews(
        { workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), callId: toolCallId },
        requested,
        {
          model: `${model.provider}/${model.id}`,
          signal,
          complete: async (system, user, itemSignal, attempt, item) => {
            const response = await ctx.modelRegistry.complete(model, {
              systemPrompt: system,
              messages: [{ role: "user" as const, timestamp: Date.now(), content: [{ type: "text" as const, text: user }] }],
            }, { sessionId: `review-${toolCallId}-${item.item_id}-${attempt}`, signal: itemSignal });
            const r = response as { stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number } };
            if (r.stopReason === "error" || r.stopReason === "aborted") throw new Error(r.errorMessage ?? "模型服务报错");
            return {
              text: response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""),
              inputTokens: r.usage?.input ?? null,
              outputTokens: r.usage?.output ?? null,
            };
          },
        },
      );
      if (outcome.details.results.length === 0) throw new ReviewError(outcome.text);
      return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
    },
  });
}
