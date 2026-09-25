/**
 * 记下执行者写的结构化输出（今天只有一种：对用户每句话的理解），并在一轮结束时检查每句话都有理解。
 *
 * 两处挂载：
 * · 助手消息落进会话的事件（message_end，role 为 assistant）：调用 lib/dialogue_acts.ts 的 recordFromAssistantMessage，
 *   扫这条消息的全部文字段，按登记表（lib/registered_outputs.ts）认出结构化输出并记下。
 *   pi 先等扩展处理完 message_end、再把这条助手消息写进会话、再执行它里面的工具调用（pi 0.85 的 agent-session 与
 *   agent-core 都等待事件处理函数），所以写表在工具执行之前完成：同一条消息里「先写理解、后调用保存修订」时，
 *   保存修订的门禁读得到这份理解。处理时这条助手消息还不在会话分支上，分支的末尾是它之前的那些条目。
 * · 运行安顿下来的事件（agent_settled：pi 不再自动重试、不再压缩、队列里也没有要续跑的消息，「回复」兜底追加的
 *   那句话续跑完也在它之前）：调用 recordAtSettle，这段处理里出现过的每句用户的话仍没有合格的理解就记一条失败
 *   （USER_INTENT_MISSING）。pi 先等扩展处理完 agent_settled 再把它发给后端，后端收到时失败已经记好了。
 *
 * 这是扩展点代码里唯一写库的地方（其余扩展点代码不写任务数据）：它写的是对话行为表与几种对话事件，
 * 不碰交付物。出错时不让运行失败，只经状态栏报一行原因（键名 taskwright-intent-error）；
 * 那时这一轮没有理解记录，三个工具的门禁会拒绝，执行者重写即可。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentRun, recordAtSettle, recordFromAssistantMessage } from "../lib/dialogue_acts.ts";
import { REGISTERED_OUTPUTS } from "../lib/registered_outputs.ts";

/** 要求这一轮先有理解的三个工具。 */
export const GATED_TOOLS = ["save_revision", "complete_task", "reply"] as const;

/** 报错用的状态栏键名。 */
export const INTENT_ERROR_KEY = "taskwright-intent-error";

export function registerIntentRecord(pi: ExtensionAPI): void {
  // 这段处理（上一次安顿之后）里出现过的用户的话；安顿时逐句检查。插话进来的话也在里面。
  const seen = new Set<string>();

  pi.on("message_end", async (event, ctx) => {
    const message = (event as { message?: { role?: string; content?: unknown; stopReason?: string } }).message;
    if (message?.role !== "assistant") return;
    try {
      const branch = ctx.sessionManager.getBranch() as never;
      const run = currentRun(branch);
      if (run) seen.add(run.userEntryId);
      recordFromAssistantMessage(ctx.cwd, ctx.sessionManager.getSessionId(), branch, message, REGISTERED_OUTPUTS);
    } catch (error) {
      ctx.ui.setStatus(INTENT_ERROR_KEY, `这一轮的理解没有记下：${(error as Error).message}`);
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const entries = [...seen];
    seen.clear();
    try {
      recordAtSettle(ctx.cwd, ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch() as never, entries, REGISTERED_OUTPUTS);
    } catch (error) {
      ctx.ui.setStatus(INTENT_ERROR_KEY, `这一轮结束时的理解检查没有做完：${(error as Error).message}`);
    }
  });
}
