/**
 * 给自带的 grep 与 read 的返回定量（lib/tool_limits.ts）：grep 的返回太多时截短并加一句话，经状态栏报一行事实；
 * read 读知识库目录下的文件而没有写要读几行时补上行数。两件都不拦调用。本文件只做接线。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { envKnowledgeRoot } from "../lib/knowledge.ts";
import { capGrep, knowledgeReadLimit, reportCapped } from "../lib/tool_limits.ts";

export function registerToolLimits(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "read") return undefined;
    const input = event.input as { path?: unknown; limit?: unknown };
    const limit = knowledgeReadLimit(input, ctx.cwd, envKnowledgeRoot());
    // 要改参数就直接改 event.input，不返回东西：这次调用照常执行。
    if (limit !== null) input.limit = limit;
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "grep" || event.isError) return undefined;
    const content = event.content;
    if (content.length !== 1 || content[0].type !== "text") return undefined;
    const capped = capGrep(content[0].text);
    if (!capped) return undefined;
    reportCapped(ctx.ui, capped);
    // details 里留一个标记，过程摘要据此写「只看了前几行」。
    return {
      content: [{ type: "text" as const, text: capped.text }],
      details: { ...((event.details as Record<string, unknown> | undefined) ?? {}), capped: { shown_lines: capped.shown_lines, total_lines: capped.total_lines } },
    };
  });
}
