/**
 * 「查看条目」工具（get_item）：按条目编号取它的全部字段、来源、评审与确认状态，以及它改动过的修订号列表；
 * 缺省看最新内容，给了修订号看它截至那次修订的内容。只读。
 *
 * 本文件只声明参数、调用 lib/task_query.ts 的 getItem、把结果转成 pi 要的返回形状。查不到时 getItem 抛异常，
 * pi 把异常文字交还模型。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getItem } from "../lib/task_query.ts";

/** 工具名。`--tools` 白名单里也要写上它。 */
export const TOOL_NAME = "get_item";

const parameters = Type.Object({
  item_id: Type.String({ description: "条目编号，例如 UC-001、TBD-002。" }),
  revision_no: Type.Optional(Type.Integer({ description: "要看这个条目截至哪次修订的内容。不写就是最新内容。" })),
});

export function registerGetItem(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "查看条目",
    description:
      "按条目编号查看一个条目的全部字段与来源（种类、出处、摘录、支持哪个字段），它当前所在的修订号、改动过的修订号，以及评审与确认状态。" +
      "不写 revision_no 看最新内容。修改条目之前先用它看当前内容与修订号，再带着修订号去改。只读，不改任何东西。",
    promptSnippet: "查看一个条目的全部字段、来源与当前所在的修订号（只读）",
    parameters,
    async execute(_toolCallId: string, params: { item_id?: unknown; revision_no?: unknown }, _signal, _onUpdate, ctx: ExtensionContext) {
      const outcome = getItem(ctx.cwd, params, ctx.sessionManager.getSessionId());
      return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
    },
  });
}
