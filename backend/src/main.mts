/**
 * 启动任务服务。
 *
 * 用法：
 *   node backend/src/main.mts --tasks <任务目录的上级目录> --runs <归档目录> --port <端口> [--host 0.0.0.0] [--profile dev]
 *
 * --tasks 与 --runs 不给时放在用户数据目录下（见 paths.ts 的 userDataDir），不写进安装位置。服务缺省绑 0.0.0.0。
 * 启动次序：先读启动配置、建服务，再监听端口；pi 不在启动时起，打开会话或说话时按需再起。
 * 日志除了写标准输出，也追加到日志目录下当天的文件里（双击启动时没有终端）；日志目录缺省在用户数据目录下，可用
 * 环境变量 TASKWRIGHT_LOG_DIR 改。收到 SIGTERM 或 SIGINT 时停止接新连接、关掉各任务的 pi、删掉本服务写的占用标记，然后退出。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { format, parseArgs } from "node:util";
import { makeServer } from "./http.ts";
import { expandUser, loadProfile } from "./launch.ts";
import { logDir, userDataDir } from "./paths.ts";
import { Service } from "./service.ts";

/** 把 console.log 与 console.error 的每一行同时追加到日志文件里；写不进去不影响服务。 */
function teeLogs(): void {
  const dir = process.env.TASKWRIGHT_LOG_DIR || logDir();
  const now = new Date();
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const file = join(dir, `backend-${day}.log`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  for (const name of ["log", "error"] as const) {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      original(...args);
      try {
        appendFileSync(file, format(...args) + "\n", "utf-8");
      } catch {
        // 日志文件写不进去就只写标准输出
      }
    };
  }
}

const { values } = parseArgs({
  options: {
    tasks: { type: "string" },
    runs: { type: "string" },
    port: { type: "string" },
    host: { type: "string", default: "0.0.0.0" },
    profile: { type: "string", default: "dev" },
  },
  strict: true,
});
if (!values.port) {
  process.stderr.write("缺少参数：--port。\n");
  process.exit(2);
}
const port = Number(values.port);
if (!Number.isInteger(port)) {
  process.stderr.write(`--port 要写一个整数，现在是「${values.port}」。\n`);
  process.exit(2);
}

teeLogs();
const tasksDir = expandUser(values.tasks ?? join(userDataDir(), "tasks"));
const runsDir = expandUser(values.runs ?? join(userDataDir(), "runs"));
const service = new Service(tasksDir, runsDir, loadProfile(values.profile!), { port });
const server = makeServer(service);
server.listen(port, values.host, () => {
  console.log(`任务服务在 http://${values.host}:${port}/api/v1/tasks ，任务目录 ${tasksDir}，归档 ${runsDir}`);
});

let closing = false;
async function stop(): Promise<void> {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  try {
    await service.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
