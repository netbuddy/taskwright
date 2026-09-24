/**
 * 只读小扩展：把几样「只有 pi 进程内部才拿得到」的事实报给进程外的后端。
 *
 * 为什么要它：后端与观测台在 pi 进程外面，只看得到 pi 标准输出里的那些事件。有几样东西
 * 那里没有，只有进程内的扩展接口拿得到：
 *
 * 1. **这次实际激活的工具清单。** RPC 模式（remote procedure call mode，远程过程调用模式：
 *    pi 不画界面，改成按行收发 JSON）没有读它的命令，只有 `pi.getActiveTools()` 有
 *    （`docs/extensions.md` 第 1685 行）。
 * 2. **pi 给每一轮的轮号 `turnIndex`。** RPC 的 `turn_start` 是个空事件，不带这个字段
 *    （`docs/rpc.md` 第 913 到 927 行）；`turnIndex` 只出现在扩展接口的事件上
 *    （`docs/extensions.md` 第 607 行）。
 * 3. **这次运行在 Langfuse 里那条运行记录的编号。** Langfuse 官方扩展在每次运行开始时
 *    （它订阅的是 `before_agent_start`）把编号写进本进程的环境变量
 *    `LANGFUSE_PI_PARENT_TRACE_ID`，运行结束时撤回。`turn_start` 比 `before_agent_start` 晚，
 *    所以在这里读得到。
 *
 * 怎么带出去：经一条不需要应答的状态栏请求（`ctx.ui.setStatus`）。RPC 模式下它会变成标准输出里
 * 的一行 `extension_ui_request`，后端照常归档；pi 不会等回答，所以不会让会话卡住。
 *
 * 它只读不写：不注册工具、不改任何数据、不影响模型看到的任何东西。每个处理函数里的异常都自己吞掉
 * 并把原因一起报出去——pi 对事件处理函数没有超时保护，也不该让观测把运行带倒。
 * 处理函数里只做取值与拼一个短字符串，没有任何耗时操作。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 报工具清单用的状态栏键名。后端认这个键。
 * 改这里要同时改后端 `server/taskwright_server/pi_session.py` 里的同名常量，两边是一份约定。
 */
export const ACTIVE_TOOLS_STATUS_KEY = "taskwright-active-tools";

/** 报每一轮开始时那几样事实用的状态栏键名。同样与后端是一份约定。 */
export const TURN_STATUS_KEY = "taskwright-turn";

/** Langfuse 官方扩展写当前运行记录编号的那个环境变量。 */
const PARENT_TRACE_ID_ENV = "LANGFUSE_PI_PARENT_TRACE_ID";

export function registerBackendReports(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    try {
      ctx.ui.setStatus(ACTIVE_TOOLS_STATUS_KEY, JSON.stringify(pi.getActiveTools()));
    } catch (error) {
      // 取不到就把原因报出去，让观测台显示「未知」并说明原因，而不是让启动失败。
      ctx.ui.setStatus(
        ACTIVE_TOOLS_STATUS_KEY,
        JSON.stringify({ 取不到工具清单: String(error) }),
      );
    }
  });

  pi.on("turn_start", async (event, ctx) => {
    try {
      const traceId = process.env[PARENT_TRACE_ID_ENV] ?? "";
      ctx.ui.setStatus(
        TURN_STATUS_KEY,
        JSON.stringify({
          turnIndex: (event as { turnIndex?: number }).turnIndex ?? null,
          timestamp: (event as { timestamp?: number }).timestamp ?? null,
          langfuseTraceId: traceId,
        }),
      );
    } catch (error) {
      ctx.ui.setStatus(TURN_STATUS_KEY, JSON.stringify({ 取不到本轮事实: String(error) }));
    }
  });
}
