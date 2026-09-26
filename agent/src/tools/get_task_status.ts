/**
 * 「查询任务状态」工具（get_task_status）：各集合的条目、完成条件逐项满足情况、未解决的问题条目、
 * 最近一次修订序号与事件序号，以及每份材料的分段与引用情况。只读，输出与交付物看板（/tw-board）同源。
 *
 * 本文件只声明参数、调用 lib/task_query.ts 的 getTaskStatus、把结果转成 pi 要的返回形状。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getTaskStatus } from "../lib/task_query.ts";

/** 工具名。`--tools` 白名单里也要写上它。 */
export const TOOL_NAME = "get_task_status";

export function registerGetTaskStatus(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "查询任务状态",
    description:
      "查询任务现在的状态：每个集合有哪些条目、完成条件逐项满足没有（没满足的是哪几个条目）、还有哪些未解决的问题条目、" +
      "哪些条目用户还没看过（未读清单）、最近一次修订的修订号。想知道任务进行到哪一步、还缺什么时用它，不要凭记忆；" +
      "问用户要不要完成任务之前先用它看未读清单。它也列出每份材料分成的块与各块被引用的情况。只读，不改任何东西。",
    promptSnippet: "查询任务进行到哪一步、完成条件还缺什么（只读）",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal, _onUpdate, ctx: ExtensionContext) {
      const outcome = getTaskStatus(ctx.cwd, ctx.sessionManager.getSessionId());
      return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
    },
  });
}
