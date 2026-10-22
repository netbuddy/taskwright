/**
 * 自带的 read 与 grep 按材料 role拦的挂点：当前活动的声明写了「sources_from_roles」时，读或搜的材料里有role不在清单里的，
 * 这次调用不执行，工具结果是一句拒绝（怎样判见 lib/source_roles.ts）。别的活动、会话空闲、没有任务库时什么都不做。
 * ls 与 find 只给文件名，不拦：助手要看得到放了哪些材料。
 *
 * pi 的约定：tool_call 事件在工具执行之前触发，处理函数返回 { block: true, reason } 就不执行，reason 作为工具结果交给助手。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refusedMaterial, roleLimitInWorkspace } from "../lib/source_roles.ts";
import { fillText } from "../lib/texts.ts";

type CallEvent = { toolName: string; input: Record<string, unknown> };
type CallContext = { cwd: string; sessionManager?: { getSessionId(): string } };

/** 处理一次 tool_call：要拦返回 { block, reason }，放行返回 undefined。单独导出是为了不起 pi 也能测。 */
export function sourceRoleBlock(event: CallEvent, ctx: CallContext): { block: true; reason: string } | undefined {
  if (event.toolName !== "read" && event.toolName !== "grep") return undefined;
  const limit = roleLimitInWorkspace(ctx.cwd, ctx.sessionManager?.getSessionId() ?? null);
  if (limit === null) return undefined;
  const refused = refusedMaterial(ctx.cwd, limit, event.toolName, event.input);
  if (refused === null) return undefined;
  const roles = limit.allowed.map((one) => `「${one}」`).join("、");
  const values = { material: refused.path, role: refused.role, roles };
  const reason = event.toolName === "grep"
    ? fillText("source.grep_refused", { ...values, kinds: limit.allowed.join("或") })
    : fillText("source.read_refused", values);
  return { block: true, reason };
}

export function registerSourceRoles(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => sourceRoleBlock(event, ctx));
}
