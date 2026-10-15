/**
 * 「查看条目」工具（get_item）：按条目编号取它的全部字段、来源、评审与确认状态，以及它改动过的修订号列表；
 * 缺省看最新内容，给了修订号看它截至那次修订的内容。只读。
 *
 * 本文件只声明参数、调用 lib/task_query.ts 的 getItem、把结果转成 pi 要的返回形状。查不到时 getItem 抛异常，
 * 先记进拒绝表，pi 再把异常文字交还模型。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentRun } from "../lib/dialogue_acts.ts";
import { getItem } from "../lib/task_query.ts";
import { withRejectionRecord, workIdOf } from "../lib/tool_rejection.ts";
import { fillText } from "../lib/texts.ts";

/** 工具名。`--tools` 白名单里也要写上它。 */
export const TOOL_NAME = "get_item";

const parameters = Type.Object({
  item_id: Type.String({ description: fillText("get_item.param.item_id") }),
  revision_no: Type.Optional(Type.Integer({ description: fillText("get_item.param.revision_no") })),
});

export function registerGetItem(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "查看条目",
    description: fillText("get_item.description"),
    promptSnippet: fillText("get_item.snippet"),
    parameters,
    async execute(toolCallId: string, params: { item_id?: unknown; revision_no?: unknown }, _signal, _onUpdate, ctx: ExtensionContext) {
      // 被拒时把拒绝记进 tool_rejection 表（lib/tool_rejection.ts）；库或任务不在不是输入的问题，不记。
      const rejection = { workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), callId: toolCallId, toolName: TOOL_NAME,
        workId: workIdOf(currentRun(ctx.sessionManager.getBranch() as never)?.userEntryId) };
      return withRejectionRecord(rejection, params, () => {
        const outcome = getItem(ctx.cwd, params, ctx.sessionManager.getSessionId());
        return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
      });
    },
  });
}
