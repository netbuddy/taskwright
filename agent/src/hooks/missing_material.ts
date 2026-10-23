/**
 * 自带的 read 读缺失材料的挂点：材料表里有这份材料而文件不在（怎样判见 lib/missing_material.ts）时，这次调用不执行，
 * 工具结果是一句请用户补齐的话。别的路径、文件在的材料、没有任务库时什么都不做。grep、ls 不拦：搜不到、列不出缺的文件不会让助手编内容。
 *
 * pi 的约定：tool_call 事件在工具执行之前触发，处理函数返回 { block: true, reason } 就不执行，reason 作为工具结果交给助手。
 */

import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { missingMaterialOf } from "../lib/missing_material.ts";
import { fillText } from "../lib/texts.ts";

type CallEvent = { toolName: string; input: Record<string, unknown> };
type CallContext = { cwd: string };

/** 处理一次 tool_call：要拦返回 { block, reason }，放行返回 undefined。单独导出是为了不起 pi 也能测。 */
export function missingMaterialBlock(event: CallEvent, ctx: CallContext): { block: true; reason: string } | undefined {
  if (event.toolName !== "read") return undefined;
  const missing = missingMaterialOf(ctx.cwd, event.input);
  if (missing === null) return undefined;
  return { block: true, reason: fillText("source.read_missing_material", { name: basename(missing) }) };
}

export function registerMissingMaterial(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => missingMaterialBlock(event, ctx));
}
