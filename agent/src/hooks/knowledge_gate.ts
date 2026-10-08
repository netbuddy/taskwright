/**
 * 知识库目录对自带的 grep、find、ls 关门：订阅工具调用事件，要搜或要看的范围包含知识库目录时把这次调用拦下，
 * 交还助手一句话请它改用按意思查找（search_knowledge），并经状态栏报一行事实。该不该拦由 lib/knowledge_gate.ts 判断，
 * 本文件只做接线。没有知识库根目录时什么都不拦。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { envKnowledgeRoot } from "../lib/knowledge.ts";
import { blockedCall, reportBlocked } from "../lib/knowledge_gate.ts";

export function registerKnowledgeGate(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const blocked = blockedCall(event.toolName, event.input as { path?: unknown }, ctx.cwd, envKnowledgeRoot());
    if (!blocked) return undefined;
    reportBlocked(ctx.ui, event.toolName, blocked);
    return { block: true, reason: blocked.reason };
  });
}
