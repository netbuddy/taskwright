/**
 * 任务现状消息的挂点：pi 打开一条会话（启动时新建、启动时续接旧会话、RPC 的 new_session 换一条新会话）
 * 时，往会话里追加一条自定义消息（customType 为 taskwright-task-status），内容见 lib/task_status.ts。
 *
 * 挂在 session_start 上：pi 每打开一条会话发一次（reason 为 startup、new、resume、fork），扩展重载时
 * 也发一次（reason 为 reload），重载时会话没变，所以跳过 reload，免得重复追加。此时没有运行在进行，
 * pi.sendMessage 直接把消息加进会话（不触发模型请求）。新会话在第一条助手消息之前 pi 不写会话文件，
 * 这条消息先在内存里，等第一条助手消息时与用户消息一起按先后写进文件，所以文件里它在用户第一句话前面。
 *
 * pi 在启动时先打开会话、后开始往标准输出写事件，所以启动那一刻追加的这条消息，RPC 的事件流里看不到它的
 * message_start 与 message_end（实测）。为了让进程外的后端知道，追加之后再经状态栏报一次：键名
 * taskwright-task-status，值是 JSON（种类、文字、details、这条消息在会话里的条目编号）。
 *
 * 它不写库；读库出错时只经状态栏报出原因，不让打开会话失败。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type SessionFacts, TASK_STATUS_CUSTOM_TYPE, taskStatusMessage } from "../lib/task_status.ts";

/** 报错用的状态栏键名。 */
export const TASK_STATUS_ERROR_KEY = "taskwright-task-status-error";

/** 把追加的现状消息报给后端用的状态栏键名。与 server/taskwright_server/pi_session.py 里的同名常量是一份约定。 */
export const TASK_STATUS_REPORT_KEY = "taskwright-task-status";

type Entry = { type: string; timestamp?: string; customType?: string; message?: { role?: string } };

/** 从当前分支读出本模块要的几样事实。 */
export function sessionFacts(branch: Entry[]): SessionFacts {
  let hasUserMessage = false;
  let hasStatusMessage = false;
  let lastMessageAt: number | null = null;
  for (const entry of branch) {
    if (entry.type === "message" && entry.message?.role === "user") hasUserMessage = true;
    if (entry.type === "custom_message" && entry.customType === TASK_STATUS_CUSTOM_TYPE) hasStatusMessage = true;
    if ((entry.type === "message" || entry.type === "custom_message") && entry.timestamp) {
      const at = Date.parse(entry.timestamp);
      if (!Number.isNaN(at)) lastMessageAt = at;
    }
  }
  return { hasUserMessage, hasStatusMessage, lastMessageAt };
}

export function registerTaskStatus(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if ((event as { reason?: string }).reason === "reload") return;
    try {
      const facts = sessionFacts(ctx.sessionManager.getBranch() as Entry[]);
      const message = taskStatusMessage(ctx.cwd, facts, ctx.sessionManager.getSessionId());
      if (!message) return;
      pi.sendMessage({ customType: TASK_STATUS_CUSTOM_TYPE, content: message.text, display: true, details: message.details });
      // 没有运行在进行时 sendMessage 是同步追加的，此刻会话的叶子就是这条消息。
      ctx.ui.setStatus(
        TASK_STATUS_REPORT_KEY,
        JSON.stringify({
          kind: message.kind,
          text: message.text,
          details: message.details,
          entry_id: ctx.sessionManager.getLeafId(),
          session_id: ctx.sessionManager.getSessionId(),
        }),
      );
    } catch (error) {
      ctx.ui.setStatus(TASK_STATUS_ERROR_KEY, `任务现状消息没有写成：${(error as Error).message}`);
    }
  });
}
