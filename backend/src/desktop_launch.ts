/**
 * 产品包启动程序（release/app/main.ts）用的几样小判断，放在这里好单独测试。只用 Node 的内置模块。
 *
 * - launcherCommand：命令行第一个参数是哪个子命令（data、service、observatory），都不是时起服务。
 * - relaunchCommand：重起这个服务应当跑的命令（写进环境变量 TASKWRIGHT_RELAUNCH，见 service_process.ts）。AppImage 重新运行
 *   AppImage 文件本身，单个可执行文件重新运行它自己，参数照用户给的；从代码仓里直接用 node 跑时不给。
 * - findPython：observatory 子命令找 Python 解释器：依次是环境变量 TASKWRIGHT_PYTHON、python3、python（Windows 再试 py -3），
 *   版本要在 3.9 以上。观测台只用标准库，产品包不带 Python，用机器上已有的。
 * - observatoryLaunch：起观测台的命令行与环境：PYTHONPATH 指向包里的 observatory/，观测台起 agent 脚本用的 node 指向产品包自己
 *   （单个可执行文件经 TASKWRIGHT_RUN_SCRIPT 跑脚本，见观测台 taskpage.py 的 node_command）。
 */

import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";

export type LauncherCommand = "data" | "service" | "observatory" | null;

/** 命令行第一个参数（process.argv[2]）对应的子命令；不是子命令时是 null（起服务）。 */
export function launcherCommand(argv: string[]): LauncherCommand {
  const first = argv[2];
  return first === "data" || first === "service" || first === "observatory" ? first : null;
}

/** 重起这个服务应当跑的命令；从代码仓里直接用 node 跑时是 null（照 process.execPath 与 process.argv 重起就对）。 */
export function relaunchCommand(argv: string[], env: NodeJS.ProcessEnv, singleExecutable: boolean, execPath: string): string[] | null {
  const rest = argv.slice(2);
  if (env.APPIMAGE) return [env.APPIMAGE, ...rest];
  if (singleExecutable) return [execPath, ...rest];
  return null;
}

/** 观测台需要的最低 Python 版本。 */
export const PYTHON_MIN: [number, number] = [3, 9];
export const NO_PYTHON_TEXT = "观测台需要 Python 3.9 以上，请安装后重试（或设 TASKWRIGHT_PYTHON）";

/** 运行一个候选解释器取它的版本；取不到时 null。测试里换成假的。 */
export type PythonProbe = (command: string, prefix: string[]) => string | null;

export const probePython: PythonProbe = (command, prefix) => {
  const done = spawnSync(command, [...prefix, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf-8", windowsHide: true, timeout: 15_000 });
  return done.status === 0 ? done.stdout.trim() : null;
};

export type FoundPython = { command: string; prefix: string[]; version: string } | { error: string };

/** 按 TASKWRIGHT_PYTHON、python3、python（Windows 再试 py -3）的次序找第一个能运行的解释器；它的版本低于 3.9 或一个都没有时给出那句提示。 */
export function findPython(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, probe: PythonProbe = probePython): FoundPython {
  const given = (env.TASKWRIGHT_PYTHON ?? "").trim();
  const candidates: [string, string[]][] = given ? [[given, []]]
    : [["python3", []], ["python", []], ...(platform === "win32" ? [["py", ["-3"]] as [string, string[]]] : [])];
  for (const [command, prefix] of candidates) {
    const version = probe(command, prefix);
    if (version === null) continue;
    const [major, minor] = version.split(".").map(Number);
    if (major > PYTHON_MIN[0] || (major === PYTHON_MIN[0] && minor >= PYTHON_MIN[1])) return { command, prefix, version };
    return { error: `${NO_PYTHON_TEXT}。找到的 ${[command, ...prefix].join(" ")} 是 ${version} 版。` };
  }
  return { error: `${NO_PYTHON_TEXT}。` };
}

/** 起观测台：命令行、环境与它监听的端口（用户没给 --port 时是观测台的默认端口 8770）。 */
export function observatoryLaunch(python: { command: string; prefix: string[] }, root: string, args: string[], env: NodeJS.ProcessEnv,
  singleExecutable: boolean, execPath: string): { command: string; args: string[]; env: NodeJS.ProcessEnv; port: number } {
  let port = 8770;
  args.forEach((one, i) => {
    if (one === "--port" && args[i + 1]) port = Number(args[i + 1]);
    else if (one.startsWith("--port=")) port = Number(one.slice("--port=".length));
  });
  const path = join(root, "observatory");
  return {
    command: python.command,
    args: [...python.prefix, "-m", "taskwright_observatory", ...args],
    env: {
      ...env,
      PYTHONPATH: env.PYTHONPATH ? `${path}${delimiter}${env.PYTHONPATH}` : path,
      TASKWRIGHT_OBSERVATORY_NODE: execPath,
      ...(singleExecutable ? { TASKWRIGHT_OBSERVATORY_NODE_SEA: "1" } : {}),
    },
    port,
  };
}
