/**
 * 「查找知识库」工具（search_knowledge）：在这个任务选用的知识库里按意思与按字面两路找与一句话最相关的几个片段，
 * 每个带所在的知识库与文档、位置、它在两路里各排第几、出处的写法与逐字的原文。只读。
 *
 * 本文件只声明参数、调用 lib/knowledge_search.ts 的 searchKnowledge、把结果转成 pi 要的返回形状。
 * 两路是任务服务算的（按意思那一路要调嵌入模型）；没有选嵌入模型、文档还没有换算好时任务服务退到只按字面找，结果照样给。
 * 任务服务联系不上时 searchKnowledge 回一句说明与接下来怎么办，不抛异常；只有参数写错时抛异常，pi 把异常文字交还模型。
 * 说明里的规矩（查知识库用这一个工具、不要用 grep 去翻知识库、查到的片段就是逐字的原文）与系统提示、
 * 任务现状消息的知识库一段、平台 skill 第二节第 4 条是同一条，改一处要四处一起改。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { envKnowledgeRoot } from "../lib/knowledge.ts";
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, searchKnowledge } from "../lib/knowledge_search.ts";

/** 工具名。`--tools` 白名单里也要写上它。 */
export const TOOL_NAME = "search_knowledge";

const parameters = Type.Object({
  query: Type.String({ description: "要找的内容，用一句完整的话写出来，例如「图书超期不还怎样罚款、上限是多少」；不要只写一个词。材料里的说法可以直接写进去。" }),
  limit: Type.Optional(Type.Integer({ description: `要几个片段。不用写；写的话是 1 到 ${SEARCH_MAX_LIMIT} 的整数，不写是 ${SEARCH_DEFAULT_LIMIT}。`, minimum: 1, maximum: SEARCH_MAX_LIMIT })),
});

export function registerSearchKnowledge(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "查找知识库",
    description:
      "在这个任务选用的知识库里查找：把你写的一句话与知识库文档的每个片段按意思、按字面两路比较，返回最相关的几个片段，" +
      "每个带知识库名、文档名、片段的标题、位置、出处的写法与逐字的原文。用词不同也找得到，例如材料说「超期不还」而规范里写的是「逾期」；" +
      "知道条号或原话时把它写进去，按字面那一路会找到。" +
      "查知识库用这一个工具：材料把具体规定指给了别的文档（例如「按公司规范执行」「见术语表」），或者不知道规范里这件事叫什么时就查。" +
      "一次查一件事，要查几件就分几次查。不用写 limit；结果说还有几条没有列出时，把问题缩小再查。" +
      "排在前面不等于就是你要的规定：一个片段里有多条规定时逐条看，材料的说法与规范的用词常不同。" +
      "查到的片段就是逐字的原文，摘录从片段逐字抄，不必再读知识库文件核对。" +
      "不要用 grep 去翻知识库，命中太多也拿不全。只读，不改任何东西。",
    promptSnippet: "在任务选用的知识库里查找相关的片段（只读）",
    parameters,
    async execute(_toolCallId: string, params: { query?: unknown; limit?: unknown }, signal, _onUpdate, ctx: ExtensionContext) {
      const outcome = await searchKnowledge(ctx.cwd, envKnowledgeRoot(), params, { signal: signal ?? undefined });
      return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
    },
  });
}
