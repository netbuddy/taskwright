/**
 * 启动任务服务的函数：命令行入口 main.mts 与打包后的启动程序都调它。参数对象进，实际端口与停止函数出。
 *
 * 做的事依次是：日志同时追加到日志目录下当天的文件（双击启动时没有终端）→ 读启动配置、建服务 → 从给的端口起监听
 * （被占时依次换后面的端口）。pi 不在启动时起，打开会话或说话时按需再起。
 *
 * ownProcess 为真（缺省）时，本函数把整个进程交给这个服务：收到 SIGTERM、SIGINT、SIGHUP（关掉终端或 Windows 的控制台窗口时
 * 发来的就是它；Windows 另接 Ctrl+Break 的 SIGBREAK），或者桌面形态下收到退出请求时，停止接新连接、关掉各任务的 pi、
 * 删掉本服务写的占用标记，然后退出进程。测试在同一进程里起服务时传 false，自己调 stop。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { format } from "node:util";
import { makeServer } from "./http.ts";
import { expandUser, loadProfile } from "./launch.ts";
import { defaultHost, listenFrom } from "./listen.ts";
import { logDir, userDataDir } from "./paths.ts";
import { MODES, type Mode, Service } from "./service.ts";

export interface StartOptions {
  /** 起始端口：被占时依次试后面的，最多 10 个。 */
  port: number;
  /** 运行形态，缺省 server。 */
  mode?: Mode;
  /** 绑定地址；不给时按运行形态定（desktop 是 127.0.0.1，server 是 0.0.0.0）。 */
  host?: string;
  /** 放任务目录的上级目录；不给时在用户数据目录下。 */
  tasks?: string;
  /** 归档目录；不给时在用户数据目录下。 */
  runs?: string;
  /** 知识库根目录；不给时在用户数据目录下，与任务目录并列。 */
  knowledge?: string;
  /** 启动配置名，缺省 dev。 */
  profile?: string;
  /** 网页静态文件所在的目录；给了就由本服务出页面（不以 /api/ 开头的 GET 请求）。 */
  web?: string;
  /** 是否把进程交给这个服务（接信号、收到退出请求时退出进程），缺省是。 */
  ownProcess?: boolean;
}

export interface Started {
  service: Service;
  server: Server;
  /** 实际监听的端口。 */
  port: number;
  host: string;
  tasksDir: string;
  runsDir: string;
  knowledgeDir: string;
  /** 停止接新连接、关掉各任务的 pi、删掉占用标记；不退出进程。重复调用只做一次。 */
  stop: () => Promise<void>;
}

/** 启动参数不对：说明写在 message 里，原样给用户看。 */
export class StartError extends Error {}

let teed = false;

/** 把 console.log 与 console.error 的每一行同时追加到日志文件里；写不进去不影响服务。一个进程只接一次。 */
function teeLogs(): void {
  if (teed) return;
  teed = true;
  // 终端关掉之后再往标准输出写会出错；不接住会让收尾做不完。
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
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
      try {
        original(...args);
      } catch {
        // 标准输出已经不在（终端关了），只写日志文件
      }
      try {
        appendFileSync(file, format(...args) + "\n", "utf-8");
      } catch {
        // 日志文件写不进去就只写标准输出
      }
    };
  }
}

/** 进程要接的退出信号：Windows 另加 Ctrl+Break。 */
export function exitSignals(platform = process.platform): NodeJS.Signals[] {
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  if (platform === "win32") signals.push("SIGBREAK");
  return signals;
}

export async function startService(options: StartOptions): Promise<Started> {
  const mode = options.mode ?? "server";
  if (!(MODES as readonly string[]).includes(mode)) throw new StartError(`--mode 只能是 desktop 或 server，现在是「${mode}」。`);
  if (!Number.isInteger(options.port)) throw new StartError(`--port 要写一个整数，现在是「${options.port}」。`);
  const host = defaultHost(mode, options.host);
  const ownProcess = options.ownProcess ?? true;

  teeLogs();
  const tasksDir = expandUser(options.tasks ?? join(userDataDir(), "tasks"));
  const runsDir = expandUser(options.runs ?? join(userDataDir(), "runs"));
  const knowledgeDir = expandUser(options.knowledge ?? join(userDataDir(), "knowledge"));
  const service = new Service(tasksDir, runsDir, loadProfile(options.profile ?? "dev"), { port: options.port, mode, knowledgeDir });
  const server = makeServer(service, { webDir: options.web ?? null });

  let closing: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    // 先停止接新连接，再关各任务的 pi（执行者状态「已退出」还推得到开着的事件流上），
    // 然后各条事件流写完手上的事件、正常结束，空闲的连接关掉；连接都关了就算停好，最多等 2 秒。
    closing ??= (async () => {
      const closed = new Promise((ok) => server.close(ok));
      try {
        await service.close();
      } finally {
        server.closeIdleConnections();
        await Promise.race([closed, new Promise((ok) => setTimeout(ok, 2000))]);
        server.closeAllConnections();
      }
    })();
    return closing;
  };

  if (ownProcess) {
    const stopAndExit = () => void stop().finally(() => process.exit(0));
    for (const signal of exitSignals()) process.on(signal, stopAndExit);
    service.exitHandler = () => {
      console.log("收到本机发来的退出请求，服务收尾后退出。");
      stopAndExit();
    };
  }

  const port = await listenFrom(server, options.port, host);
  service.port = port;
  if (options.port !== 0 && port !== options.port) console.log(`端口 ${options.port} 被占用，改用端口 ${port}。`);
  const web = options.web ? `，网页 ${options.web}` : "";
  console.log(`任务服务在 http://${host}:${port}/api/v1/tasks ，任务目录 ${tasksDir}，归档 ${runsDir}，知识库 ${service.knowledge!.root}，运行形态 ${mode}${web}`);
  return { service, server, port, host, tasksDir, runsDir, knowledgeDir: service.knowledge!.root, stop };
}
