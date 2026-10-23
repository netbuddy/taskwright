/**
 * 服务的进程文件：<数据目录>/run/service.json。一个数据目录一个服务，与占用标记同根。
 *
 * 服务（自己一个进程起的，startService 的 ownProcess）监听成功后写这个文件：进程号、实际监听的端口与地址、运行形态、启动时刻、
 * 产品版本、启动时的命令行（process.argv，另记 /proc 里看到的原样命令行 cmdline）、工作目录、TASKWRIGHT_ 开头的环境变量与
 * 另外几个（RECORDED_ENV）、node 的路径；正常退出时删掉。启动时发现旧文件而它记的进程还活着、命令行也对得上，就拒绝启动；
 * 进程已经不在（或者那个进程号已经是别的程序），就当残留覆盖掉。
 *
 * 不起服务的 service 命令（service_command.ts）只认这个文件里的那一个进程：查看、停止、重启都按它来，不按端口、名字或目录去找进程。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 进程文件所在的目录（数据目录下）与文件名。 */
export const RUN_DIR = "run";
export const PROCESS_FILE = "service.json";

export interface ProcessFile {
  pid: number;
  port: number;
  host: string;
  mode: string;
  started_at: string;
  product_version: string;
  /** 启动时的 process.argv（第一项是 node 的路径，第二项是脚本的路径）。重启照它起。 */
  argv: string[];
  /** 启动时 /proc/<pid>/cmdline 里的原样命令行；读不到（不是 Linux）时是 null。核对「是不是这个服务」用它。 */
  cmdline: string[] | null;
  cwd: string;
  /** 启动时 TASKWRIGHT_ 开头的环境变量与 RECORDED_ENV 里的几个。 */
  env: Record<string, string>;
  /** node 的路径（process.execPath）。 */
  node: string;
}

export const processFilePath = (dataDir: string) => join(dataDir, RUN_DIR, PROCESS_FILE);

/** 除 TASKWRIGHT_ 开头的以外要记下的环境变量：pi 的配置目录、临时目录与数据目录、代理。 */
export const RECORDED_ENV = ["PI_CODING_AGENT_DIR", "TMPDIR", "XDG_DATA_HOME", "NO_PROXY", "HTTP_PROXY", "HTTPS_PROXY"];

/** 要记下的环境变量：TASKWRIGHT_ 开头的与 RECORDED_ENV 里的几个。 */
export const isRecordedEnv = (name: string) => name.startsWith("TASKWRIGHT_") || RECORDED_ENV.includes(name);

export function recordedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => isRecordedEnv(entry[0]) && typeof entry[1] === "string"));
}

/** 读进程文件；不在、读不出、不是这个样子时是 null。 */
export function readProcessFile(dataDir: string): ProcessFile | null {
  try {
    const value = JSON.parse(readFileSync(processFilePath(dataDir), "utf-8"));
    return value && typeof value.pid === "number" && Array.isArray(value.argv) ? value as ProcessFile : null;
  } catch {
    return null;
  }
}

/** 写进程文件：先写临时文件再改名。 */
export function writeProcessFile(dataDir: string, value: ProcessFile): void {
  const dir = join(dataDir, RUN_DIR);
  mkdirSync(dir, { recursive: true });
  const file = processFilePath(dataDir);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(temp, file);
}

/** 删进程文件：只删记着 pid 这个进程的那一份（别的进程已经写了新的就不动）。 */
export function removeProcessFile(dataDir: string, pid: number): void {
  if (readProcessFile(dataDir)?.pid === pid) rmSync(processFilePath(dataDir), { force: true });
}

/**
 * 这个进程号还活着没有（没有权限发信号也算活着）。已经退出、只等父进程收尸的进程（Linux 的 /proc/<pid>/stat 状态是 Z）
 * 算不在：它不再做任何事，只是父进程还没有回收它。
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}

/** 一个进程在 /proc 里的原样命令行；读不到（进程不在、不是 Linux）时是 null。 */
export function cmdlineOf(pid: number | "self"): string[] | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    const parts = raw.split("\0");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  } catch {
    return null;
  }
}

/**
 * 进程文件记的那个进程现在怎样：alive 活着；verified 命令行核对过（读不到 /proc 时是 false，这时活着就当是它）；
 * same 是不是这个服务（活着，而且命令行与文件记的相同或者核对不了）。
 */
export interface ProcessState {
  alive: boolean;
  verified: boolean;
  same: boolean;
}

export function processState(file: ProcessFile): ProcessState {
  const alive = isAlive(file.pid);
  if (!alive) return { alive, verified: false, same: false };
  const now = cmdlineOf(file.pid);
  if (now === null || file.cmdline === null) return { alive, verified: false, same: true };
  return { alive, verified: true, same: JSON.stringify(now) === JSON.stringify(file.cmdline) };
}
