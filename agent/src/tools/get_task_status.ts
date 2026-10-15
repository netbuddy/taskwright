/**
 * 「查询任务状态」工具（get_task_status）：各集合的条目、完成条件逐项满足情况、未解决的问题条目、
 * 最近一次修订序号与事件序号、每份材料的分段与引用情况，以及任务选用的知识库与里面的文档。只读，输出与交付物看板（/tw-board）同源。
 *
 * 本文件只声明参数、调用 lib/task_query.ts 的 getTaskStatus、把结果转成 pi 要的返回形状。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getTaskStatus } from "../lib/task_query.ts";
import { fillText } from "../lib/texts.ts";

/** 工具名。`--tools` 白名单里也要写上它。 */
export const TOOL_NAME = "get_task_status";

export function registerGetTaskStatus(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "查询任务状态",
    description: fillText("get_task_status.description"),
    promptSnippet: fillText("get_task_status.snippet"),
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal, _onUpdate, ctx: ExtensionContext) {
      const outcome = getTaskStatus(ctx.cwd, ctx.sessionManager.getSessionId());
      return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
    },
  });
}
