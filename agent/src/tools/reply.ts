/**
 * 「回复」工具：执行者对用户说的每一句话都经它发出。
 *
 * 本文件只做三件事：声明参数、从会话当前分支读出这一轮的工具调用与自己所在的助手消息、调用 lib/reply.ts
 * 里的核对函数。合格时返回 terminate: true，pi 执行完这一批工具就结束本次运行，不再请求模型；
 * 不合格时核对函数抛出异常，pi 把异常文字交还模型重写（被拒的结果不带结束标记，pi 一定会再开一轮）。
 *
 * 参数的形状这里只做最宽的声明，逐项的核对都在核对函数里做，好让不对的地方得到逐条的中文说明，
 * 而不是 pi 的一句英文的参数校验失败。
 *
 * 给建议值（suggest）的依据与「保存修订」的来源同一套逐字核对（lib/save_revision.ts 的 checkQuotes），核对后的依据写进送达的回复。
 *
 * 对话理解：执行之前先核对这一轮有没有有效的理解（lib/dialogue_acts.ts 的 requireUnderstanding），没有就拒绝；
 * 合格送达之后把告知与向用户要的回应记进对话行为表（recordReplyActs），编号写进返回的文字与 details.acts，
 * details.event_seq 是那条 EXECUTOR_ACTS_RECORDED 事件的序号（没有要记的行为、或者还没有任务库时为空）。
 * details.answers_card 是用户这句话回答了的卡片（卡片所在回复的编号，列表）：不由执行者填，从这一轮理解的 responds_to 算出。
 * details.resends_card 是这张卡片重发的那一张所在回复的编号（act.resends 写了才有）。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REPLY_TOOL_NAME, consecutiveReplyRejections, decideReply, lastAssistantTurn, openRevisionLookup, outlineReadingOf } from "../lib/reply.ts";
import { spoken } from "../lib/speak.ts";
import { currentRun, openResendLookup, recordReplyActs, requireUnderstanding } from "../lib/dialogue_acts.ts";
import { reportStopped, stopAtLimit } from "../lib/rejection_limit.ts";
import { withRejectionRecord, workIdOf } from "../lib/tool_rejection.ts";
import { checkQuotes } from "../lib/save_revision.ts";
import { envKnowledgeRoot } from "../lib/knowledge.ts";
import { userMessagesOnBranch } from "./save_revision.ts";
import { activityDoneGate, activityDoneOf } from "../lib/stage_read.ts";
import { fillText } from "../lib/texts.ts";

/** 工具名。模型调用时写的就是它，`--tools` 白名单里也要写上它。 */
export const TOOL_NAME = REPLY_TOOL_NAME;

// 参数里的每一项在形状上都声明成可选的：pi 在调用执行函数之前按形状校验参数，缺项时给的是一句英文；
// 声明成可选之后，缺什么由核对函数用中文逐条说明。说明文字里仍写明哪些项必须写。
const itemRef = Type.Object(
  {
    item_id: Type.Optional(Type.String({ description: fillText("reply.param.item_ref.item_id") })),
    revision_no: Type.Optional(Type.Integer({ description: fillText("reply.param.item_ref.revision_no") })),
  },
  { additionalProperties: true },
);

const act = Type.Object(
  {
    kind: Type.Optional(Type.String({
      description: fillText("reply.param.act.kind"),
    })),
    text: Type.Optional(Type.String({
      description: fillText("reply.param.act.text"),
    })),
    items: Type.Optional(
      Type.Array(itemRef, {
        description: fillText("reply.param.act.items"),
      }),
    ),
    scope: Type.Optional(Type.String({
      description: fillText("reply.param.act.scope"),
    })),
    options: Type.Optional(
      Type.Array(Type.Object({ key: Type.Optional(Type.String()), text: Type.Optional(Type.String()), reason: Type.Optional(Type.String()) }, { additionalProperties: true }), {
        description: fillText("reply.param.act.options"),
      }),
    ),
    multiple: Type.Optional(Type.Boolean({ description: fillText("reply.param.act.multiple") })),
    topic: Type.Optional(Type.String({ description: fillText("reply.param.act.topic") })),
    value: Type.Optional(Type.String({ description: fillText("reply.param.act.value") })),
    resends: Type.Optional(Type.String({
      description: fillText("reply.param.act.resends"),
    })),
    basis: Type.Optional(
      Type.Array(
        Type.Object({ kind: Type.Optional(Type.String()), locator: Type.Optional(Type.String()), excerpt: Type.Optional(Type.String()) }, { additionalProperties: true }),
        {
          description: fillText("reply.param.act.basis"),
        },
      ),
    ),
    preview: Type.Optional(
      Type.Array(Type.Object({ effect: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }, { additionalProperties: true }), {
        description: fillText("reply.param.act.preview"),
      }),
    ),
  },
  { additionalProperties: true },
);

const inform = Type.Object(
  {
    text: Type.Optional(Type.String({ description: fillText("reply.param.informs.text") })),
    items: Type.Optional(Type.Array(itemRef, {
      description: fillText("reply.param.informs.items"),
    })),
  },
  { additionalProperties: true },
);

const parameters = Type.Object({
  informs: Type.Optional(Type.Array(Type.Union([inform, Type.String()]), {
    description: fillText("reply.param.informs"),
  })),
  act: Type.Optional(Type.Union([Type.Null(), act], {
    description: fillText("reply.param.act"),
  })),
  text: Type.Optional(Type.String({
    description: fillText("reply.param.text"),
  })),
  activity_done: Type.Optional(Type.Union([Type.Null(), Type.Boolean()], {
    description: fillText("reply.param.activity_done"),
  })),
});

export function registerReply(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "回复",
    description: fillText("reply.description"),
    promptSnippet: fillText("reply.snippet"),
    promptGuidelines: [
      fillText("reply.guideline.1"),
    ],
    parameters,
    executionMode: "sequential",
    async execute(toolCallId: string, params: unknown, _signal, _onUpdate, ctx: ExtensionContext) {
      const branch = ctx.sessionManager.getBranch() as Parameters<typeof lastAssistantTurn>[0];
      const turn = lastAssistantTurn(branch);
      // 被拒时把拒绝记进 tool_rejection 表（lib/tool_rejection.ts），拒绝文字照样交还模型。
      const rejection = { workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), callId: toolCallId, toolName: TOOL_NAME,
        workId: workIdOf(currentRun(branch as never)?.userEntryId) };
      const decided = withRejectionRecord(rejection, params, () => {
        requireUnderstanding(ctx.cwd, ctx.sessionManager.getSessionId(), branch as never, "回复", TOOL_NAME);
        const lookup = openRevisionLookup(ctx.cwd);
        const resend = openResendLookup(ctx.cwd, ctx.sessionManager.getSessionId());
        try {
          return decideReply(params, {
            toolCallId,
            callsThisTurn: turn.calls,
            outlineReading: outlineReadingOf(ctx.cwd, ctx.sessionManager.getSessionId()),
            lastUserText: userMessagesOnBranch(ctx).at(-1)?.text ?? null,
            revisionFact: lookup.revisionFact,
            currentRevisionOf: lookup.currentRevisionOf,
            problemItem: lookup.problemItem,
            priorRejections: consecutiveReplyRejections(branch),
            resendFact: resend.resendFact,
            // 回复里写了 activity_done 时：这条会话正在做一个单项活动的工作项才行。
            activityDoneRefusal: () => activityDoneGate(ctx.cwd, ctx.sessionManager.getSessionId()),
            // 给建议值的依据：与保存修订的来源同一套逐字核对。
            checkBasis: (raw, errors, whereOf) =>
              checkQuotes(ctx.cwd, ctx.sessionManager.getSessionId(), userMessagesOnBranch(ctx), raw, errors, whereOf, envKnowledgeRoot()),
          });
        } finally {
          lookup.close();
          resend.close();
        }
      });
      let decision: Awaited<typeof decided>;
      try {
        decision = await decided;
      } catch (error) {
        // 这一轮连续被拒到上限：不再抛异常让模型接着试，返回「出错并结束本次运行」的结果（lib/rejection_limit.ts）。
        const stopped = stopAtLimit(error, branch as never);
        if (!stopped) throw error;
        reportStopped(ctx.ui, TOOL_NAME, stopped);
        return stopped;
      }
      const messageId = turn.calls.some((call) => call.id === toolCallId) ? turn.entryId : null;
      const sessionId = ctx.sessionManager.getSessionId();
      const recorded = recordReplyActs(ctx.cwd, sessionId, branch as never, decision.reply, messageId, toolCallId);
      // 助手汇报这条会话的工作项（单项活动）做完了：只是回复下面的一句话，工作项照旧留着，不改任何记录。
      const done = decision.reply.activity_done ? activityDoneOf(ctx.cwd, sessionId) : null;
      // degraded 为真：连续被拒到上限之后放行的纯文字回复，正文在 reply.text。
      return spoken(recorded?.text ? fillText("result.reply.delivered_with", { recorded: recorded.text }) : fillText("result.reply.delivered"), {
        delivered: true,
        reply: decision.reply,
        degraded: decision.degraded,
        message_id: messageId,
        event_seq: recorded?.eventSeq ?? null,
        acts: recorded?.acts ?? [],
        // 用户这句话回答了哪几张卡片（卡片所在回复的编号）：从这一轮理解的 responds_to 算出，页面据此把卡片标成答过。
        answers_card: recorded?.answersCard ?? [],
        // 这张卡片重发的是哪一张（原来那张所在回复的编号）：页面据此把原来那张收成一句；不是重发时不带这一项。
        ...(recorded?.resendsCard ? { resends_card: recorded.resendsCard } : {}),
        // 这条回复汇报做完的是哪个工作项（哪一项单项活动、工作项的记录号）：页面据此在回复下面写一行；没有汇报时不带这一项。
        ...(done ? { activity_done: done } : {}),
      });
    },
  });
}
