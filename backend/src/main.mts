/**
 * 启动任务服务。
 *
 * 用法：
 *   node backend/src/main.mts --tasks <任务目录的上级目录> --runs <归档目录> --port <端口> [--mode desktop|server] [--host 地址] [--profile dev] [--web 网页目录]
 *
 * --tasks 与 --runs 不给时放在用户数据目录下（见 paths.ts 的 userDataDir），不写进安装位置。
 * 运行形态 --mode 缺省 server：缺省绑 0.0.0.0，没有退出接口。desktop 是单机桌面用：缺省只绑 127.0.0.1，并注册只接受本机请求的
 * 退出接口 POST /api/v1/service/exit。--host 给了以它为准。两种形态的日志写法相同：写标准输出，也追加到日志文件。
 * --port 给的端口被占时依次试后面的端口，最多 10 个；实际端口打印到日志、写进占用标记，并由 GET /api/v1/service 回出。
 * --web 给了网页静态文件所在的目录时，不以 /api/ 开头的 GET 请求从那里出文件，找不到的路径回首页 index.html。
 * 启动次序：先读启动配置、建服务，再监听端口；pi 不在启动时起，打开会话或说话时按需再起。
 * 日志除了写标准输出，也追加到日志目录下当天的文件里（双击启动时没有终端）；日志目录缺省在用户数据目录下，可用
 * 环境变量 TASKWRIGHT_LOG_DIR 改。收到 SIGTERM、SIGINT 或 SIGHUP（Windows 另有 SIGBREAK）、或者桌面形态下收到退出请求时，
 * 停止接新连接、关掉各任务的 pi、删掉本服务写的占用标记，然后退出。
 *
 * 本文件只是命令行外壳：检查参数后调 start.ts 的 startService；打包后的启动程序直接调 startService。
 */

import { parseArgs } from "node:util";
import { NoFreePort } from "./listen.ts";
import { MODES, type Mode } from "./service.ts";
import { startService } from "./start.ts";

const { values } = parseArgs({
  options: {
    tasks: { type: "string" },
    runs: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    mode: { type: "string", default: "server" },
    profile: { type: "string", default: "dev" },
    web: { type: "string" },
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

try {
  await startService({
    port, mode: values.mode as Mode, host: values.host, tasks: values.tasks, runs: values.runs, profile: values.profile, web: values.web,
  });
} catch (error) {
  console.error(error instanceof NoFreePort ? error.message : `服务没有起来：${(error as Error).message}`);
  process.exit(1);
}
