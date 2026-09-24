/**
 * 工具块排版的命令行入口：给后端的终端对话客户端 server/taskwright_server/chat.py 用。
 *
 * chat.py 是 Python 写的，而「回复」与「保存修订」怎样显示只在 lib/tool_render.ts 里写一份（pi 的终端界面也用它），
 * 所以 chat.py 每遇到这两个工具的结果，就起一个 Node 子进程运行本文件，把结果交进来，拿回排好的几行。
 *
 * 用法：标准输入给一个 JSON 对象
 *   {"tool": "reply" 或 "save_revision", "is_error": 真或假, "text": 工具返回的文字,
 *    "details": 工具返回的 details, "args": 调用参数, "workspace": 任务目录}
 * 标准输出是一个 JSON 字符串数组，每项一行。认不出的工具返回空数组。
 */

import { REPLY_TOOL_NAME } from "../lib/reply.ts";
import {
  type SavedOperation,
  replyLines,
  replyRejectedLines,
  saveRejectedLines,
  savedLines,
  titlesForOperations,
} from "../lib/tool_render.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const input = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
const details = input.details ?? {};

let lines: string[] = [];
if (input.tool === REPLY_TOOL_NAME) {
  lines = input.is_error ? replyRejectedLines(input.text ?? "") : replyLines(details.reply ?? input.args ?? {});
} else if (input.tool === "save_revision") {
  if (input.is_error) {
    lines = saveRejectedLines(input.text ?? "");
  } else {
    const operations = (details.operations ?? []) as SavedOperation[];
    lines = savedLines(details, input.workspace ? titlesForOperations(input.workspace, operations) : {});
  }
}
process.stdout.write(JSON.stringify(lines));
