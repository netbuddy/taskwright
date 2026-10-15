/**
 * 「查找知识库」工具（search_knowledge）：在这个任务选用的知识库里按意思与按字面两路找与一句话最相关的几个片段，
 * 每个带所在的知识库与文档、位置、它在两路里各排第几、出处的写法与逐字的原文。只读。
 *
 * 本文件只声明参数、调用 lib/knowledge_search.ts 的 searchKnowledge、把结果转成 pi 要的返回形状。
 * 两路是任务服务算的（按意思那一路要调嵌入模型）；没有选嵌入模型、文档还没有换算好时任务服务退到只按字面找，结果照样给。
 * 任务服务联系不上时 searchKnowledge 回一句说明与接下来怎么办，不抛异常；只有参数写错时抛异常，pi 把异常文字交还模型。
 * 说明文字在 agent/prompts/tools/search_knowledge.md。说明里的规矩（查知识库用这一个工具、不要用 grep 去翻知识库、
 * 查到的片段就是逐字的原文）与任务现状消息的知识库一段、平台说明第二节第 4 条是同一条，改一处要三处一起改。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { envKnowledgeRoot } from "../lib/knowledge.ts";
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, searchKnowledge } from "../lib/knowledge_search.ts";
import { fillText } from "../lib/texts.ts";

/** 工具名。`--tools` 白名单里也要写上它。 */
export const TOOL_NAME = "search_knowledge";

const parameters = Type.Object({
  query: Type.String({ description: fillText("search_knowledge.param.query") }),
  limit: Type.Optional(Type.Integer({ description: fillText("search_knowledge.param.limit", { max: SEARCH_MAX_LIMIT, default: SEARCH_DEFAULT_LIMIT }), minimum: 1, maximum: SEARCH_MAX_LIMIT })),
});

export function registerSearchKnowledge(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "查找知识库",
    description: fillText("search_knowledge.description"),
    promptSnippet: fillText("search_knowledge.snippet"),
    parameters,
    async execute(_toolCallId: string, params: { query?: unknown; limit?: unknown }, signal, _onUpdate, ctx: ExtensionContext) {
      const outcome = await searchKnowledge(ctx.cwd, envKnowledgeRoot(), params, { signal: signal ?? undefined });
      return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
    },
  });
}
