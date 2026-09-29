/**
 * 模拟用户的驱动程序：用后端的会话类（backend/src/pi_session.ts 的 PiSession）启动并驱动模拟用户的 pi。
 * 拼命令行、应答界面请求、写归档都走后端那一份，演练程序不另写一份。
 *
 * 由 Python 的驾驭程序（sim/launch_user.py 的 UserAgentProcess）作为子进程启动，两边经标准输入与标准输出按行交换 JSON，
 * 一行一个对象。
 *
 * 收到的命令：
 *   {"cmd": "start", "profile": {启动配置}, "cwd": 工作目录, "runs": 归档目录, "label": 会话标签, "session_file": 要续接的会话文件（可以不给）}
 *   {"cmd": "send", "text": 唤起模拟用户的一句话}
 *   {"cmd": "close"}
 * 回给驾驭程序的消息：
 *   {"type": "started", "session_id": pi 的会话编号, "archive": 原始事件流的文件名}
 *   {"type": "event", "event": {pi 的一条事件，原样}}      这一轮的每条事件，直到这一轮结束
 *   {"type": "turn_end"}                                   这一轮结束（agent_settled，压缩中则到 compaction_end）
 *   {"type": "closed"}                                     已经关掉 pi，随后退出
 *   {"type": "error", "stage": "start" | "send" | "close" | "input", "message": 给人看的原因, "exited": pi 是否已经不在了}
 *
 * 标准输出只用来交换这些 JSON。会话类在个别情形下用 console.log 打日志（例如续接时改写了会话文件记的工作目录），
 * 这里把 console.log 与 console.info 改道到标准错误，免得混进标准输出。标准输入关掉时，关掉 pi 再退出。
 */

import { basename } from "node:path";
import { createInterface } from "node:readline";
import { format } from "node:util";
import { PiSession, technicalOf } from "../backend/src/pi_session.ts";

console.log = (...args: unknown[]) => { process.stderr.write(format(...args) + "\n"); };
console.info = console.log;

function reply(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const technical = technicalOf(error);
  return technical && technical !== text ? `${text}（${technical}）` : text;
}

let session: PiSession | null = null;
const gone = () => session === null || !session.alive();

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  if (!line.trim()) continue;
  let command: Record<string, any>;
  try {
    command = JSON.parse(line);
  } catch {
    reply({ type: "error", stage: "input", message: "驱动程序收到的一行不是 JSON。", exited: gone() });
    continue;
  }
  if (command.cmd === "start") {
    try {
      if (session !== null) throw new Error("模拟用户已经启动过了，不要重复启动。");
      session = new PiSession(command.profile, command.cwd, command.runs, command.label ?? "user-agent");
      await session.start(typeof command.session_file === "string" && command.session_file ? command.session_file : null);
      const state = await session.getState();
      reply({ type: "started", session_id: state.sessionId ?? null, archive: session.archivePath ? basename(session.archivePath) : null });
    } catch (error) {
      reply({ type: "error", stage: "start", message: reason(error), exited: gone() });
    }
  } else if (command.cmd === "send") {
    if (session === null) {
      reply({ type: "error", stage: "send", message: "模拟用户还没有启动，先发 start。", exited: true });
      continue;
    }
    try {
      for await (const event of session.send(String(command.text ?? ""))) reply({ type: "event", event });
      reply({ type: "turn_end" });
    } catch (error) {
      reply({ type: "error", stage: "send", message: reason(error), exited: gone() });
    }
  } else if (command.cmd === "close") {
    try {
      await session?.close();
      reply({ type: "closed" });
    } catch (error) {
      reply({ type: "error", stage: "close", message: reason(error), exited: gone() });
    }
    session = null;
    break;
  } else {
    reply({ type: "error", stage: "input", message: `驱动程序不认识命令「${String(command.cmd)}」。`, exited: gone() });
  }
}
input.close();
if (session !== null) await session.close();
process.exit(0);
