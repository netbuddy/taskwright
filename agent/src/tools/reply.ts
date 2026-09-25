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
 * 对话理解：执行之前先核对这一轮有没有有效的理解（lib/dialogue_acts.ts 的 requireUnderstanding），没有就拒绝；
 * 合格送达之后把告知与末位主行为记进对话行为表（recordReplyActs），编号写进返回的文字与 details.acts，
 * details.event_seq 是那条 EXECUTOR_ACTS_RECORDED 事件的序号（没有要记的行为、或者还没有任务库时为空）。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REPLY_TOOL_NAME, consecutiveReplyRejections, decideReply, lastAssistantTurn, openRevisionLookup } from "../lib/reply.ts";
import { spoken } from "../lib/speak.ts";
import { recordReplyActs, requireUnderstanding } from "../lib/dialogue_acts.ts";

/** 工具名。模型调用时写的就是它，`--tools` 白名单里也要写上它。 */
export const TOOL_NAME = REPLY_TOOL_NAME;

// 参数里的每一项在形状上都声明成可选的：pi 在调用执行函数之前按形状校验参数，缺项时给的是一句英文；
// 声明成可选之后，缺什么由核对函数用中文逐条说明。说明文字里仍写明哪些项必须写。
const itemRef = Type.Object(
  {
    item_id: Type.Optional(Type.String({ description: "条目编号，例如 CON-004。必须写。" })),
    revision_no: Type.Optional(Type.Integer({ description: "这个条目当前所在的修订号（「UC-001 现在是修订 N」里的 N）。必须写。" })),
  },
  { additionalProperties: true },
);

const act = Type.Object(
  {
    kind: Type.Optional(Type.String({
      description:
        "末位主行为的种类，只能是五者之一：ask 是提问，confirm 是请用户确认某几个条目当前的内容，" +
        "suggest 是给一个建议值，choose 是请用户从几个选项里选一个，propose 是提议下一步怎么做。必须写。",
    })),
    text: Type.Optional(Type.String({ description: "问题、请确认的话、建议或提议的内容，一句完整的话。必须写。" })),
    items: Type.Optional(
      Type.Array(itemRef, {
        description:
          "关联的条目或问题条目，每项写条目编号与它当前所在的修订号。提问（ask）、请确认（confirm）、给建议值（suggest）、" +
          "提议（propose）必须写；提问、给建议值、提议与任何条目都无关时不写它，改写 scope: \"general\"。请选择（choose）可以不写。",
      }),
    ),
    scope: Type.Optional(Type.String({
      description: "只用于提问（ask）、给建议值（suggest）、提议（propose）三种；请选择（choose）与请确认（confirm）不写 scope。取值只有 general：表示这一问、这条建议或提议与任何条目都无关，这时 items 不写。",
    })),
    options: Type.Optional(
      Type.Array(Type.Object({ key: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }, { additionalProperties: true }), {
        description: "只有请选择（choose）写：至少两个选项，每项是 { key, text }，key 不能重复。",
      }),
    ),
    value: Type.Optional(Type.String({ description: "只有给建议值（suggest）写，而且必须写：你建议的那个值。" })),
    basis: Type.Optional(
      Type.Array(
        Type.Object({ kind: Type.Optional(Type.String()), locator: Type.Optional(Type.String()), excerpt: Type.Optional(Type.String()) }, { additionalProperties: true }),
        {
          description:
            "只有给建议值（suggest）写，而且必须写：建议的依据，至少一条。kind 是「文档原文」「用户的话」「执行者补充」之一，" +
            "locator 是出处，excerpt 是摘录的原文。",
        },
      ),
    ),
    preview: Type.Optional(
      Type.Array(Type.Object({ effect: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }, { additionalProperties: true }), {
        description:
          "只有提议（propose）写：这个提议做下去之后条目会怎样变，每项是 { effect, text }，effect 是 remove、add、change 之一。" +
          "提议会撤掉条目或大改条目时必须写。",
      }),
    ),
  },
  { additionalProperties: true },
);

const parameters = Type.Object({
  informs: Type.Optional(Type.Array(Type.String(), {
    description: "零到多条告知，每条一句完整的话，只写事实（例如你刚保存了什么）。必须写；没有要告知的事写空列表。",
  })),
  act: Type.Optional(Type.Union([Type.Null(), act], {
    description: "至多一个末位主行为，放在告知之后。必须写；这一轮不需要用户做什么时写 null。",
  })),
  text: Type.Optional(Type.String({ description: "给用户读的成文的话：把告知与主行为连成一段自然的话。必须写，不能是空白。" })),
});

export function registerReply(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "回复",
    description:
      "把你要对用户说的话发给用户。你对用户说的每一句话都要经这个工具发出，不要直接输出正文" +
      "（你按平台 skill「先写理解」一节在文字里写的那份理解不是正文）。" +
      "这个工具是你本次回应的最后一步：要单独调用它，不要与其他工具在同一轮里一起调用，也不要连着调用两次；" +
      "调用之后不要再输出任何正文。一次回复由零到多条告知、至多一个末位主行为（提问、请确认、给建议值、请选择、提议之一）" +
      "与一段成文的话组成。它只核对形式与条目是否存在，不评判内容；形式不对时它会逐条告诉你哪里不对，请照着改好再调用。",
    promptSnippet: "把要对用户说的话发给用户，本次回应的最后一步，单独调用",
    promptGuidelines: [
      "对用户说的每一句话都经 reply 发出；reply 要单独调用，不与其他工具同一轮，调用之后不再输出正文。",
    ],
    parameters,
    executionMode: "sequential",
    async execute(toolCallId: string, params: unknown, _signal, _onUpdate, ctx: ExtensionContext) {
      const branch = ctx.sessionManager.getBranch() as Parameters<typeof lastAssistantTurn>[0];
      const turn = lastAssistantTurn(branch);
      requireUnderstanding(ctx.cwd, ctx.sessionManager.getSessionId(), branch as never, "回复", TOOL_NAME);
      const lookup = openRevisionLookup(ctx.cwd);
      let decision;
      try {
        decision = decideReply(params, {
          toolCallId,
          callsThisTurn: turn.calls,
          revisionFact: lookup.revisionFact,
          currentRevisionOf: lookup.currentRevisionOf,
          priorRejections: consecutiveReplyRejections(branch),
        });
      } finally {
        lookup.close();
      }
      const messageId = turn.calls.some((call) => call.id === toolCallId) ? turn.entryId : null;
      const recorded = recordReplyActs(ctx.cwd, ctx.sessionManager.getSessionId(), branch as never, decision.reply, messageId, toolCallId);
      // degraded 为真：连续被拒到上限之后放行的纯文字回复，正文在 reply.text。
      return spoken(recorded?.text ? `回复已送达。${recorded.text}` : "回复已送达", {
        delivered: true,
        reply: decision.reply,
        degraded: decision.degraded,
        message_id: messageId,
        event_seq: recorded?.eventSeq ?? null,
        acts: recorded?.acts ?? [],
      });
    },
  });
}
