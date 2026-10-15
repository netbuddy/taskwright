/**
 * 「保存修订」工具：执行者把一批按条目的操作（新增、修改、删除）交给它，它把这批操作存成整份交付物的
 * 一次新修订。它只存不评审，也不代表任务完成。
 *
 * 本文件只做三件事：声明参数、调用 lib/save_revision.ts 里的核心函数、把结果转成 pi 要的返回形状。
 * 参数的形状这里只做最宽的声明，逐项的核对都在核心函数里做，好让不对的地方得到逐条的中文说明，
 * 而不是 pi 的一句英文的参数校验失败。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "../lib/create_task.ts";
import { ACTOR_EXECUTOR } from "../lib/db.ts";
import { saveRevision } from "../lib/save_revision.ts";
import { envKnowledgeRoot } from "../lib/knowledge.ts";
import { currentRun, requireUnderstanding } from "../lib/dialogue_acts.ts";
import { problemClicks } from "../lib/problem_consent.ts";
import { isUnderstandingGate, reportStopped, stopAtLimit } from "../lib/rejection_limit.ts";
import { withRejectionRecord, workIdOf } from "../lib/tool_rejection.ts";
import { fillText } from "../lib/texts.ts";

/** 工具名。模型调用时写的就是它，`--tools` 白名单里也要写上它。 */
export const TOOL_NAME = "save_revision";

const support = Type.Object(
  {
    field: Type.String({ description: fillText("save_revision.param.operations.sources.supports.field") }),
    index: Type.Optional(
      Type.Integer({ description: fillText("save_revision.param.operations.sources.supports.index") }),
    ),
  },
  { additionalProperties: true },
);

const source = Type.Object(
  {
    kind: Type.String({ description: fillText("save_revision.param.operations.sources.kind") }),
    locator: Type.Optional(
      Type.String({
        description: fillText("save_revision.param.operations.sources.locator"),
      }),
    ),
    excerpt: Type.String({ description: fillText("save_revision.param.operations.sources.excerpt") }),
    normalized_value: Type.Optional(
      Type.String({
        description: fillText("save_revision.param.operations.sources.normalized_value"),
      }),
    ),
    supports: Type.Optional(
      Type.Array(support, {
        description: fillText("save_revision.param.operations.sources.supports"),
      }),
    ),
  },
  { additionalProperties: true },
);

const operation = Type.Object(
  {
    op: Type.String({ description: fillText("save_revision.param.operations.op") }),
    collection: Type.Optional(Type.String({ description: fillText("save_revision.param.operations.collection") })),
    item: Type.Optional(Type.String({ description: fillText("save_revision.param.operations.item") })),
    base_revision: Type.Optional(
      Type.Integer({
        description: fillText("save_revision.param.operations.base_revision"),
      }),
    ),
    fields: Type.Optional(
      Type.Object({}, {
        additionalProperties: true,
        description: fillText("save_revision.param.operations.fields"),
      }),
    ),
    sources: Type.Optional(
      Type.Array(source, {
        description: fillText("save_revision.param.operations.sources"),
      }),
    ),
  },
  { additionalProperties: true },
);

const parameters = Type.Object({
  operations: Type.Array(operation, {
    description: fillText("save_revision.param.operations"),
  }),
});

/**
 * 当前会话分支上的全部用户消息（pi 的 user 角色），按先后排。扩展追加的自定义消息（custom_message）
 * 条目类型不同，不在其中。读会话是同步的内存读取，在调用核心函数之前做，核心函数的事务里不读会话。
 */
export function userMessagesOnBranch(ctx: ExtensionContext): UserMessage[] {
  const out: UserMessage[] = [];
  for (const entry of ctx.sessionManager.getBranch() as Array<{ id: string; type: string; message?: any }>) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = typeof content === "string"
      ? content
      : (Array.isArray(content) ? content : []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
    out.push({ entryId: entry.id, text });
  }
  return out;
}

export function registerSaveRevision(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "保存修订",
    description: fillText("save_revision.description"),
    promptSnippet: fillText("save_revision.snippet"),
    parameters,
    executionMode: "sequential",
    async execute(toolCallId: string, params: { operations: unknown }, _signal, _onUpdate, ctx: ExtensionContext) {
      // 对话理解：这一轮没有有效的理解就拒绝；修订记下是因用户哪一项对话行为而做（intentEntry）。
      const branch = ctx.sessionManager.getBranch() as never;
      const run = currentRun(branch);
      // 被拒时把拒绝记进 tool_rejection 表（lib/tool_rejection.ts），拒绝文字照样交还模型。
      const rejection = { workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), callId: toolCallId, toolName: TOOL_NAME, workId: workIdOf(run?.userEntryId) };
      return withRejectionRecord(rejection, params, () => {
        requireUnderstanding(ctx.cwd, ctx.sessionManager.getSessionId(), branch, "保存修订", TOOL_NAME);
        const outcome = saveRevision(
          {
            workspaceDir: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            callId: toolCallId,
            actor: ACTOR_EXECUTOR,
            userMessages: userMessagesOnBranch(ctx),
            problemClicks: problemClicks(branch),
            intentEntry: run?.userEntryId ?? null,
            knowledgeRoot: envKnowledgeRoot(),
          },
          params,
        );
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
