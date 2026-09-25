# hooks 目录

这个目录放扩展点代码：挂在 agent 循环各个事件上的代码，例如在某一步换掉可用的工具集、
在模型跑偏时兜底、把运行过程记到别处。

扩展点代码不写任务数据。任务数据只能由 `tools/` 下的工具写，这是本目录与 `tools/` 的分工。

目录里现在有：`report_to_backend.ts`（把几样只有 pi 进程内部才拿得到的事实报给后端，不写任何数据）、`user_commands.ts`（用户在界面上的直接操作对应的扩展命令，调用与工具相同的核心函数写库，发起方记为用户）、`board_command.ts`（终端里查看交付物的命令）、`task_status.ts`（会话开始时追加任务现状消息）、`reply_fallback.ts`（执行者没有经回复工具就结束时的兜底）、`tui_render.ts`（终端界面的渲染器）、`intent_record.ts`（助手消息落进会话时解析执行者写的理解）。

例外一处：`intent_record.ts` 写库。它写的是对话行为表 `dialogue_act` 与几种对话事件（`USER_INTENT_RECORDED`、`USER_INTENT_INVALID`、`USER_INTENT_MISSING`、`STRUCTURED_OUTPUT_UNMATCHED`），
不碰交付物。理解写在执行者一轮的文字输出里，不经任何工具，只有助手消息落进会话的事件拿得到它，所以只能在这里记；一轮结束时没有理解的失败也只有运行安顿下来的事件知道。
