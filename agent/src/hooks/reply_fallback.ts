/**
 * 兜底：一次运行结束时，执行者如果没有经「回复」工具说话，就追加一句固定的话让它改用回复工具重说。
 *
 * 挂在 agent_end 上。判据只看事实：这次低层运行的最后一条消息是不是「回复」工具一次成功的结果
 * （pi 在「回复」合格、带着结束标记时才会以它收尾）。不是的话，情形有两种：模型直接输出了正文，
 * 或者只调用了别的工具就停了。这时用 sendUserMessage 追加一条固定文字，并以 followUp 方式排队；
 * pi 在 agent_end 之后看到队列里有消息，会接着跑，不会先发 agent_settled。
 *
 * 不兜底的情形：最后一条助手消息是出错（error，可能由 pi 自动重试，也可能是模型服务的问题）或被中止
 * （aborted，用户或后端主动停的）。这两种都不是执行者没按规矩说话。
 *
 * 连续兜底两次仍不合格就停止，不再追加，留给后端按接口约定第 5.2 节第 3 条转发正文。用户（经 RPC 或界面）
 * 再说一句话时计数清零。每次兜底与放弃都经状态栏报一行事实（键名 taskwright-reply-fallback），
 * 出现在事件流里，后端补记与观测台都看得到；不写库。
 *
 * 这是扩展点代码，只做兜底：它不判断内容，不改任何数据，出错时 pi 只记一行日志，不影响回复工具本身的核对。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REPLY_TOOL_NAME } from "../lib/reply.ts";

/** 兜底时追加的那句话。固定文字，不随情形变。 */
export const FALLBACK_TEXT = "请用 reply 工具把要对用户说的话发出来";

/** 同一句用户的话之后，最多连续兜底几次。 */
export const MAX_FALLBACKS = 2;

/** 往后端报兜底事实用的状态栏键名。 */
export const FALLBACK_STATUS_KEY = "taskwright-reply-fallback";

type Message = { role?: string; toolName?: string; isError?: boolean; stopReason?: string; content?: unknown };

/** 这次运行是不是以一次成功的「回复」收尾。 */
export function endedWithReply(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  return last?.role === "toolResult" && last.toolName === REPLY_TOOL_NAME && last.isError !== true;
}

/** 这次运行最后一条助手消息的停止原因。 */
function lastStopReason(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i].stopReason;
  }
  return undefined;
}

export function registerReplyFallback(pi: ExtensionAPI): void {
  let fallbacks = 0;

  pi.on("input", async (event) => {
    // 我们自己经 sendUserMessage 追加的那句话来源是 extension，不清零；用户新说的话清零。
    if (event.source !== "extension") fallbacks = 0;
    return undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    const messages = (event.messages ?? []) as Message[];
    const report = (fact: Record<string, unknown>) =>
      ctx.ui.setStatus(FALLBACK_STATUS_KEY, JSON.stringify({ ...fact, 已兜底次数: fallbacks, 时刻: Date.now() }));

    if (endedWithReply(messages)) {
      if (fallbacks > 0) report({ 结果: "兜底之后执行者经回复工具说了话" });
      fallbacks = 0;
      return;
    }
    const stop = lastStopReason(messages);
    if (stop === "error" || stop === "aborted") return;
    if (fallbacks >= MAX_FALLBACKS) {
      report({ 结果: `已经连续兜底 ${MAX_FALLBACKS} 次仍没有经回复工具说话，不再追加`, 最后的停止原因: stop ?? "没有助手消息" });
      return;
    }
    fallbacks += 1;
    report({ 结果: "这次运行没有以一次成功的回复收尾，已追加一句话要求改用回复工具", 最后的停止原因: stop ?? "没有助手消息" });
    pi.sendUserMessage(FALLBACK_TEXT, { deliverAs: "followUp" });
  });
}
