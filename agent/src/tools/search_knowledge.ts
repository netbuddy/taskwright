/**
 * 「按意思查找知识库」工具（search_knowledge）：在这个任务选用的知识库里找与一句话意思最相近的几个片段，
 * 每个带相近程度、所在的知识库与文档、读原文用的路径与行号、片段的正文。只读。
 *
 * 本文件只声明参数、调用 lib/knowledge_search.ts 的 searchKnowledge、把结果转成 pi 要的返回形状。
 * 比远近是任务服务算的（要调嵌入模型）；知识库的文档还没有换算好、没有选嵌入模型、任务服务联系不上时，
 * searchKnowledge 回一句说明与接下来怎么办，不抛异常；只有参数写错时抛异常，pi 把异常文字交还模型。
 * 说明里的规矩（查知识库只用这一个工具、知识库目录不能用 grep、find、ls、文档不整份读、查到后读原文核对）与系统提示、
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
  limit: Type.Optional(Type.Integer({ description: `最多返回几个片段，1 到 ${SEARCH_MAX_LIMIT}，不写是 ${SEARCH_DEFAULT_LIMIT}。`, minimum: 1, maximum: SEARCH_MAX_LIMIT })),
});

export function registerSearchKnowledge(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "按意思查找知识库",
    description:
      "在这个任务选用的知识库里按意思查找：把你写的一句话与知识库文档的每个片段比较意思上的远近，返回最相近的几个片段，" +
      "每个带相近程度、知识库名、文档名、片段的标题、读原文用的路径与行号、片段的正文。用词不同也找得到，例如材料说「超期不还」而规范里写的是「逾期」。" +
      "查知识库只用这一个工具：材料把具体规定指给了别的文档（例如「按公司规范执行」「见术语表」），或者不知道规范里这件事叫什么时就查。" +
      "一次查一件事，要查几件就分几次查。知识库目录不能用 grep、find 搜，也不能用 ls 看，知识库文档不要整份读。" +
      "返回的片段只是线索：排在前面不等于就是你要的规定，引用之前按返回的位置用 read 读原文核对，一次不超过 120 行，摘录与出处照知识库来源的规矩写。" +
      "知识库的文档还没有换算好时，它会告诉你现在还不能查，这时请告诉用户先去换算。只读，不改任何东西。",
    promptSnippet: "在任务选用的知识库里按意思查找相近的片段（只读）",
    parameters,
    async execute(_toolCallId: string, params: { query?: unknown; limit?: unknown }, signal, _onUpdate, ctx: ExtensionContext) {
      const outcome = await searchKnowledge(ctx.cwd, envKnowledgeRoot(), params, { signal: signal ?? undefined });
      return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
    },
  });
}
