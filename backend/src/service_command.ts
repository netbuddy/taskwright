/**
 * 命令行的 service 命令（后端外壳是 node backend/src/main.mts service …）：按进程文件（service_process.ts）查看、停止、重启一个
 * 数据目录的服务。不起服务，也不按端口、名字或目录去找进程：只认进程文件里记的那一个。
 *
 *   service status  [--data <数据目录>]   查看：进程号、端口、启动时刻、版本、是否在运行。退出码 0 在运行；1 不在（文件是残留）；2 没有进程文件。
 *   service stop    [--data <数据目录>]   停止：核对是这个服务之后发 SIGTERM，每 0.5 秒看一次，最多等 20 秒；退出后确认进程文件已删。
 *                                          不发 SIGKILL（强杀会留下占用标记与写到一半的文件），超时就报出来让人看。退出码 0 停了；1 没停成；2 没有进程文件。
 *   service restart [--data <数据目录>]   重启：先读下进程文件（停止会删它），停止之后照它记的 node、命令行、工作目录与环境变量重新起，
 *                                          脱离终端、在后台运行；每 0.5 秒请求一次 GET /api/v1/service，最多等 30 秒，答了就打印新的进程号与端口。
 *                                          环境以执行这条命令的环境为底，去掉要记下的那几类变量（service_process.ts 的 isRecordedEnv），换成进程文件里记的。
 *                                          新进程的标准输出与标准错误接到日志目录下的 service-<年月日-时分秒>.out：服务打印的内容两处都有（服务自己照旧写 backend-<当天>.log），
 *                                          这个文件另外接住日志文件里没有的输出，例如进程没能起来时 node 的报错。
 *                                          退出码 0 起来了；1 没停成或者没起来；2 没有进程文件。
 * 进程是不是这个服务：读 /proc/<进程号>/cmdline，与进程文件记的命令行逐项相同才算；读不到 /proc（Windows）时只看进程活着没有，
 * 输出里写「没有核对命令行」。
 */

import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { locate } from "./data_upgrade.ts";
import { logDir } from "./paths.ts";
import { type ProcessFile, isAlive, isRecordedEnv, processFilePath, processState, readProcessFile, removeProcessFile } from "./service_process.ts";

const USAGE = "用法：taskwright service status|stop|restart [--data <数据目录>]";

type Print = (line: string) => void;

/** 每隔多久看一次、最多等多久（毫秒）。测试里可以改小。 */
export const timing = { pollMs: 500, stopMs: 20_000, startMs: 30_000 };

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** argv 是 service 之后的参数。返回退出码。 */
export async function serviceCommand(argv: string[], out: Print = (line) => process.stdout.write(line + "\n"),
  err: Print = (line) => process.stderr.write(line + "\n")): Promise<number> {
  const [verb, ...rest] = argv;
  let values: Record<string, any>;
  try {
    values = parseArgs({ args: rest, options: { data: { type: "string" } }, strict: true }).values;
  } catch (error) {
    err(`参数不对：${(error as Error).message}。\n${USAGE}`);
    return 2;
  }
  if (verb !== "status" && verb !== "stop" && verb !== "restart") {
    err(verb ? `没有「service ${verb}」这个命令。\n${USAGE}` : `service 后面要写做什么。\n${USAGE}`);
    return 2;
  }
  const { dataDir } = locate({ data: values.data });
  const file = readProcessFile(dataDir);
  if (!file) {
    err(`没有进程文件 ${processFilePath(dataDir)}：这个数据目录的服务没有在运行，或者不是用这个程序起的。`);
    return 2;
  }
  if (verb === "status") return status(file, out);
  if (verb === "stop") return stop(dataDir, file, out, err);
  return restart(dataDir, file, out, err);
}

/** 进程文件记的那个服务的几行说明。 */
function describe(file: ProcessFile): string[] {
  return [`进程号 ${file.pid}，端口 ${file.port}（${file.host}），运行形态 ${file.mode}`, `启动于 ${file.started_at}，版本 ${file.product_version}`];
}

function status(file: ProcessFile, out: Print): number {
  const state = processState(file);
  for (const line of describe(file)) out(line);
  if (state.same) {
    out(state.verified ? "在运行。" : "在运行（没有核对命令行：这个系统读不到 /proc）。");
    return 0;
  }
  out(state.alive
    ? `残留：进程号 ${file.pid} 活着，但它的命令行与进程文件记的不同，不是这个服务。`
    : `残留：进程号 ${file.pid} 已经不在了。`);
  return 1;
}

/** 停止进程文件记的那个服务；返回退出码。 */
async function stop(dataDir: string, file: ProcessFile, out: Print, err: Print): Promise<number> {
  const state = processState(file);
  if (!state.same) {
    err(state.alive
      ? `没有停止：进程号 ${file.pid} 活着，但它的命令行与进程文件记的不同，不是这个服务（进程文件是残留）。`
      : `没有停止：进程号 ${file.pid} 已经不在了，进程文件是残留。`);
    return 1;
  }
  out(`向进程号 ${file.pid} 发送 SIGTERM${state.verified ? "" : "（没有核对命令行：这个系统读不到 /proc）"}。`);
  try {
    process.kill(file.pid, "SIGTERM");
  } catch (error) {
    err(`没能发送 SIGTERM：${(error as Error).message}`);
    return 1;
  }
  const until = Date.now() + timing.stopMs;
  while (isAlive(file.pid)) {
    if (Date.now() >= until) {
      err(`等了 ${timing.stopMs / 1000} 秒，进程号 ${file.pid} 还没有退出。没有强行结束它，请查看日志后再处理。`);
      return 1;
    }
    await sleep(timing.pollMs);
  }
  removeProcessFile(dataDir, file.pid);
  out(`已停止（进程号 ${file.pid}）。`);
  return 0;
}

/** 重启：停止之后照进程文件重新起，等它答话。 */
async function restart(dataDir: string, file: ProcessFile, out: Print, err: Print): Promise<number> {
  const stopped = await stop(dataDir, file, out, err);
  if (stopped !== 0) return stopped;
  // 环境：执行这条命令的环境为底，去掉记录类的变量，换成进程文件里记的。
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !isRecordedEnv(name)));
  Object.assign(env, file.env);
  const logs = logDir(dataDir, null, env);
  mkdirSync(logs, { recursive: true });
  const stamp = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const outFile = join(logs, `service-${stamp.getFullYear()}${two(stamp.getMonth() + 1)}${two(stamp.getDate())}-${two(stamp.getHours())}${two(stamp.getMinutes())}${two(stamp.getSeconds())}.out`);
  const fd = openSync(outFile, "a");
  let pid: number | undefined;
  try {
    const child = spawn(file.node, file.argv.slice(1), { cwd: file.cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(fd);
  }
  const names = Object.keys(file.env).sort();
  out(`照进程文件重新起服务：${file.node} ${file.argv.slice(1).join(" ")}（工作目录 ${file.cwd}）。`);
  out(`用了进程文件里记的环境变量：${names.length ? names.join("、") : "没有"}。输出接到 ${outFile}。`);
  const until = Date.now() + timing.startMs;
  while (Date.now() < until) {
    await sleep(timing.pollMs);
    const now = readProcessFile(dataDir);
    if (!now || now.pid === file.pid) continue;
    const host = now.host === "0.0.0.0" || now.host === "::" ? "127.0.0.1" : now.host;
    try {
      const res = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${now.port}/api/v1/service`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        out(`已重启：新的进程号 ${now.pid}，端口 ${now.port}。`);
        return 0;
      }
    } catch {
      // 还没有答话，接着等
    }
  }
  err(`等了 ${timing.startMs / 1000} 秒，新起的服务${pid ? `（进程号 ${pid}）` : ""}还没有答话。请看 ${outFile} 与日志目录下当天的日志。`);
  return 1;
}
