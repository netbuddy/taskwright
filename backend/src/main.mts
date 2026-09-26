/**
 * 启动任务服务。
 *
 * 用法：
 *   node backend/src/main.mts --tasks <任务目录的上级目录> --runs <归档目录> --port <端口> [--mode desktop|server] [--host 地址] [--profile dev]
 *
 * --tasks 与 --runs 不给时放在用户数据目录下（见 paths.ts 的 userDataDir），不写进安装位置。
 * 运行形态 --mode 缺省 server：缺省绑 0.0.0.0，没有退出接口。desktop 是单机桌面用：缺省只绑 127.0.0.1，并注册只接受本机请求的
 * 退出接口 POST /api/v1/service/exit。--host 给了以它为准。两种形态的日志写法相同：写标准输出，也追加到日志文件。
 * --port 给的端口被占时依次试后面的端口，最多 10 个；实际端口打印到日志、写进占用标记，并由 GET /api/v1/service 回出。
 * 启动次序：先读启动配置、建服务，再监听端口；pi 不在启动时起，打开会话或说话时按需再起。
 * 日志除了写标准输出，也追加到日志目录下当天的文件里（双击启动时没有终端）；日志目录缺省在用户数据目录下，可用
 * 环境变量 TASKWRIGHT_LOG_DIR 改。收到 SIGTERM 或 SIGINT、或者桌面形态下收到退出请求时，停止接新连接、关掉各任务的 pi、
 * 删掉本服务写的占用标记，然后退出。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { format, parseArgs } from "node:util";
import { makeServer } from "./http.ts";
import { expandUser, loadProfile } from "./launch.ts";
import { NoFreePort, defaultHost, listenFrom } from "./listen.ts";
import { logDir, userDataDir } from "./paths.ts";
import { MODES, type Mode, Service } from "./service.ts";

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
    host: { type: "string" },
    mode: { type: "string", default: "server" },
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
if (!(MODES as readonly string[]).includes(values.mode!)) {
  process.stderr.write(`--mode 只能是 desktop 或 server，现在是「${values.mode}」。\n`);
  process.exit(2);
}
const mode = values.mode as Mode;
const host = defaultHost(mode, values.host);

teeLogs();
const tasksDir = expandUser(values.tasks ?? join(userDataDir(), "tasks"));
const runsDir = expandUser(values.runs ?? join(userDataDir(), "runs"));
const service = new Service(tasksDir, runsDir, loadProfile(values.profile!), { port, mode });
const server = makeServer(service);

let closing = false;
async function stop(): Promise<void> {
  if (closing) return;
  closing = true;
  // 先停止接新连接，再关各任务的 pi（执行者状态「已退出」还推得到开着的事件流上，与 Python 版相同），
  // 然后各条事件流写完手上的事件、正常结束，空闲的连接关掉；连接都关了就退出，最多等 2 秒。
  const closed = new Promise((ok) => server.close(ok));
  try {
    await service.close();
  } finally {
    server.closeIdleConnections();
    await Promise.race([closed, new Promise((ok) => setTimeout(ok, 2000))]);
    server.closeAllConnections();
    process.exit(0);
  }
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
service.exitHandler = () => {
  console.log("收到本机发来的退出请求，服务收尾后退出。");
  void stop();
};

try {
  const actual = await listenFrom(server, port, host);
  service.port = actual;
  if (actual !== port) console.log(`端口 ${port} 被占用，改用端口 ${actual}。`);
  console.log(`任务服务在 http://${host}:${actual}/api/v1/tasks ，任务目录 ${tasksDir}，归档 ${runsDir}，运行形态 ${mode}`);
} catch (error) {
  console.error(error instanceof NoFreePort ? error.message : `服务没有起来：${(error as Error).message}`);
  process.exit(1);
}
