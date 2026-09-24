/**
 * 扩展入口：只做登记，不含任何逻辑。
 *
 * 这一版登记「保存修订」「完成任务」两个写入工具、「查看条目」与「查询任务状态」两个只读工具，以及执行者对用户说话一律要经的「回复」工具，合格时它结束本次运行
 * （2026-09-21 起任务由用户在界面上创建，执行者不再有「创建任务」工具，
 * 创建任务走不经 pi 的命令行入口 cli/create_task.mts），挂一个在打开会话时追加任务现状消息的扩展、
 * 一个在执行者没有经「回复」说话就停下时追加一句话要它重说的兜底扩展，
 * 两个扩展命令 /tw-user（用户在界面上的直接操作，不经模型写库）与 /tw-ui（卡片点击，带标注地发一句话），
 * 一个只读的扩展命令 /tw-board（在终端界面里打印交付物看板），「回复」与「保存修订」两个工具在终端界面里的渲染器
 * （只有 pi 的交互模式调用，RPC 模式不调；经 withTuiRenderers 并进工具定义），
 * 另外挂一个只读的小扩展：它把几样只有 pi 进程
 * 内部才拿得到的事实（激活的工具清单、pi 给每一轮的轮号、这次运行在 Langfuse 里那条运行记录的编号）
 * 报给进程外的后端，不改任何数据。以后新增的工具与兜底逻辑分别放在 tools/ 与 hooks/ 目录下，
 * 本文件只把它们挂上来。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSaveRevision } from "./tools/save_revision.ts";
import { registerBackendReports } from "./hooks/report_to_backend.ts";
import { registerTaskStatus } from "./hooks/task_status.ts";
import { registerReply } from "./tools/reply.ts";
import { registerReplyFallback } from "./hooks/reply_fallback.ts";
import { registerUserCommands } from "./hooks/user_commands.ts";
import { registerBoardCommand } from "./hooks/board_command.ts";
import { withTuiRenderers } from "./hooks/tui_render.ts";
import { registerGetItem } from "./tools/get_item.ts";
import { registerGetTaskStatus } from "./tools/get_task_status.ts";
import { registerCompleteTask } from "./tools/complete_task.ts";

export default function (pi: ExtensionAPI) {
  registerSaveRevision(withTuiRenderers(pi));
  registerGetItem(pi);
  registerGetTaskStatus(pi);
  registerCompleteTask(pi);
  registerBackendReports(pi);
  registerTaskStatus(pi);
  registerReply(withTuiRenderers(pi));
  registerReplyFallback(pi);
  registerUserCommands(pi);
  registerBoardCommand(pi);
}
