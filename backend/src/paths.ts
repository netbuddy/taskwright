/**
 * 仓根目录：启动时算一次，任务类型模板、启动配置、理解格式的 schema 等资源文件一律从这里定位，
 * 不在各模块里各自拼相对路径。以后打包成单个可执行文件时，只改这一处的算法。
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 任务类型模板所在的目录：每个子目录是一种任务类型的起始文件。 */
export const TASK_TYPES_DIR = join(REPO_ROOT, "task-types");

/**
 * 仓根目录下的一个相对路径。以 agent/ 开头的路径在设了 TASKWRIGHT_AGENT_DIR 时改从那个目录找：打包成 AppImage 时，
 * 打包层把 agent/ 复制到用户缓存目录里一个每个版本固定不变的位置并用这个变量指过来，pi 加载扩展时的编译缓存才能命中。
 */
export function fromRoot(relative: string): string {
  const agentDir = process.env.TASKWRIGHT_AGENT_DIR;
  const parts = relative.split(/[\\/]+/);
  if (agentDir && parts[0] === "agent") return join(agentDir, ...parts.slice(1));
  return join(REPO_ROOT, ...parts);
}

/** 启动配置所在的目录（与 Python 版共用同一份）。 */
export const PROFILE_DIR = join(REPO_ROOT, "server", "taskwright_server", "profiles");

/** 理解格式的 schema：用户行为各功能的中文名写在它的 $defs.user_function 的 x-names 里。 */
export const INTENT_SCHEMA_PATH = join(REPO_ROOT, "agent", "prompts", "schemas", "user_intent.schema.json");

/**
 * 用户数据目录：安装位置可能是只读的，任务目录与归档目录缺省放在这里。
 * Linux 取 $XDG_DATA_HOME（缺省 ~/.local/share），Windows 取 %LOCALAPPDATA%，macOS 取 ~/Library/Application Support。
 */
export function userDataDir(): string {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Taskwright");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Taskwright");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "taskwright");
}

/** 日志目录：服务的日志除了写标准输出，也写一份到这里（双击启动时没有终端）。 */
export function logDir(): string {
  return join(userDataDir(), "logs");
}
