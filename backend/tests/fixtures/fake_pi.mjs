// 测试用的假 pi：按 RPC 模式按行收发 JSON，不连模型。后端经 TASKWRIGHT_PI_ENTRY 把它当 pi 的入口脚本运行。
// 它认这几条命令：get_commands、get_state、get_entries、new_session、prompt、slow（永远不回，测超时）、refuse（回 success 为假）、
// die（立刻退出，退出码 3）。启动时先往标准错误写一行、往标准输出写一行不是 JSON 的字、报三个状态栏键与一个要应答的确认框；
// 收到 prompt 时按一次运行的样子发一串事件（含一次「回复」工具调用与一条扩展写入的自定义消息）。
import { createInterface } from "node:readline";

const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
process.stderr.write("假 pi 启动了\n");
process.stdout.write("这不是 JSON\n");
out({ type: "extension_ui_request", id: "u1", method: "setStatus", statusKey: "taskwright-active-tools", statusText: '["read","reply"]' });
out({ type: "extension_ui_request", id: "u2", method: "setStatus", statusKey: "taskwright-task-status",
  statusText: JSON.stringify({ text: "任务现状", details: { n: 1 }, entry_id: "e0000001", session_id: "S1" }) });
out({ type: "extension_ui_request", id: "u3", method: "confirm", title: "要继续吗" });

const entries = [];
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === "extension_ui_response") {
    out({ type: "debug_ui_answer", answer: command });
    continue;
  }
  const answer = (data) => out({ type: "response", id: command.id, command: command.type, success: true, data });
  if (command.type === "get_commands") answer({ commands: [{ name: "skill:taskwright-executor", description: "平台", source: "skill", sourceInfo: { path: "/x/SKILL.md" } }, { name: "tw-user", source: "extension" }] });
  else if (command.type === "get_state") answer({ sessionId: "S1", sessionFile: null, isCompacting: false });
  else if (command.type === "get_entries") answer({ entries });
  else if (command.type === "new_session") answer({});
  else if (command.type === "refuse") out({ type: "response", id: command.id, command: "refuse", success: false, error: "不认这条命令" });
  else if (command.type === "slow") continue;
  else if (command.type === "die") process.exit(3);
  else if (command.type === "prompt") {
    answer({});
    entries.push({ type: "message", id: "u0000001", parentId: null, timestamp: "2026-09-25T01:00:00.000Z", message: { role: "user", content: [{ type: "text", text: command.message }] } });
    out({ type: "agent_start" });
    out({ type: "extension_ui_request", id: "u4", method: "setStatus", statusKey: "taskwright-turn", statusText: '{"turnIndex":0,"timestamp":1,"langfuseTraceId":""}' });
    out({ type: "turn_start" });
    out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: command.message }] } });
    out({ type: "message_end", message: { role: "custom", customType: "taskwright-user-edit", content: "界面操作说明", details: { op_id: "ui-op-x" } } });
    out({ type: "tool_execution_start", toolCallId: "c1", toolName: "reply", args: { text: "好" } });
    out({ type: "tool_execution_end", toolCallId: "c1", toolName: "reply", isError: false, result: { details: { message_id: "a0000001", reply: { text: "好", informs: [], act: null } } } });
    out({ type: "turn_end" });
    out({ type: "agent_settled" });
  }
}
