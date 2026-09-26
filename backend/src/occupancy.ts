/**
 * 任务占用标记：一个后端服务一个任务时，在任务目录里写一份 service.lock，免得两个后端同时服务同一份任务数据。
 *
 * service.lock 是一个 JSON 对象：端口（port）、进程号（pid）、启动时刻（started_at）、主机名（host）。
 * - 后端第一次接手一个任务（扫描任务目录时）写它，退出时删掉自己写的那些。
 * - 接手前发现已经有标记：同一台主机上、进程号还活着、不是本进程，就是别的服务在用，拒绝接手（claim 返回那份标记）；
 *   另一台主机写的标记判断不了死活，同样当作占用；进程号已经不在了的，是遗留的旧标记，覆盖并在日志里写明。
 * 观测台只读任务库，不看也不写这份标记。
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { pyStr, truthy } from "./py.ts";

export const LOCK_NAME = "service.lock";

export type Lock = Record<string, any>;

export function lockPath(taskDir: string): string {
  return join(taskDir, LOCK_NAME);
}

/** 读任务目录里的占用标记；没有或读不出时为 null。 */
export function readLock(taskDir: string): Lock | null {
  try {
    const value = JSON.parse(readFileSync(lockPath(taskDir), "utf-8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 同一台主机上这个进程号还在不在。 */
export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isOurs(lock: Lock | null): boolean {
  return Boolean(lock) && lock!.pid === process.pid && lock!.host === hostname();
}

/** 这份标记说明任务正被别的服务占用：别的主机写的，或者同一台主机上别的、还活着的进程写的。 */
export function occupiedByOther(lock: Lock | null): boolean {
  if (!lock || isOurs(lock)) return false;
  if (lock.host !== hostname()) return true;
  return pidAlive(lock.pid);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 本机时间「年-月-日T时:分:秒」，不带时区。 */
function localStamp(at = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** 标记文件的写法：键与值之间、各项之间各一个空格，末尾换行（与 Python 版写出的文件逐字相同）。 */
function lockText(lock: Lock): string {
  return "{" + Object.entries(lock).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + "}\n";
}

/** 接手一个任务：写上本服务的占用标记。任务正被别的服务占用时不写，返回那份标记；接手成功返回 null。 */
export function claim(taskDir: string, port: number | null): Lock | null {
  const existing = readLock(taskDir);
  if (occupiedByOther(existing)) return existing;
  if (existing && !isOurs(existing)) {
    console.log(`任务目录 ${basename(taskDir)} 里有一份遗留的占用标记（端口 ${pyStr(existing.port)}，进程 ${pyStr(existing.pid)} 已经不在了），本服务覆盖它。`);
  }
  const mine = { port, pid: process.pid, started_at: localStamp(), host: hostname() };
  const temp = join(taskDir, `${LOCK_NAME}.${process.pid}.tmp`);
  writeFileSync(temp, lockText(mine), "utf-8");
  renameSync(temp, lockPath(taskDir));
  return null;
}

/** 退出时删掉本服务写的占用标记；别人的不动。 */
export function release(taskDir: string): void {
  if (isOurs(readLock(taskDir))) {
    try {
      unlinkSync(lockPath(taskDir));
    } catch {
      // 已经不在了
    }
  }
}

/** 给人看的一句：这个任务正被哪个服务占用。 */
export function occupiedText(lock: Lock): string {
  const where = truthy(lock.port) ? `端口 ${pyStr(lock.port)} 的服务` : "另一个服务";
  const host = lock.host === hostname() ? "" : `（主机 ${pyStr(lock.host)}）`;
  return `这个任务正被${where}${host}占用，这里不能打开。`;
}
