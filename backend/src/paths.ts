/**
 * 仓根目录：启动时算一次，任务类型模板、启动配置、理解格式的 schema 等资源文件一律从这里定位，
 * 不在各模块里各自拼相对路径。以后打包成单个可执行文件时，只改这一处的算法。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 任务类型模板所在的目录：每个子目录是一种任务类型的起始文件。 */
export const TASK_TYPES_DIR = join(REPO_ROOT, "task-types");

/**
 * 仓根目录下的一个相对路径。以 agent/ 开头的路径在设了 TASKWRIGHT_AGENT_DIR 时改从那个目录找：打包成 AppImage 时，
 * 打包层把 agent/ 复制到用户缓存目录里一个每个版本固定不变的位置并用这个变量指过来，pi 加载扩展时的编译缓存才能命中。
 * 启动配置里写的是绝对路径时原样返回，不接在仓根目录下面。
 */
export function fromRoot(relative: string): string {
  if (isAbsolute(relative)) return relative;
  const agentDir = process.env.TASKWRIGHT_AGENT_DIR;
  const parts = relative.split(/[\\/]+/);
  if (agentDir && parts[0] === "agent") return join(agentDir, ...parts.slice(1));
  return join(REPO_ROOT, ...parts);
}

/** 启动配置所在的目录。 */
export const PROFILE_DIR = join(REPO_ROOT, "backend", "profiles");

/** 理解格式的 schema：用户行为各功能的中文名写在它的 $defs.user_function 的 x-names 里。 */
export const INTENT_SCHEMA_PATH = join(REPO_ROOT, "agent", "prompts", "schemas", "user_intent.schema.json");

/**
 * 用户数据目录：安装位置可能是只读的，任务目录与归档目录缺省放在这里。
 * Linux 取 $XDG_DATA_HOME（缺省 ~/.local/share），Windows 取 %LOCALAPPDATA%，macOS 取 $HOME/Library/Application Support。
 */
export function userDataDir(): string {
  return userDataDirFor(process.platform, process.env, homedir());
}

/** userDataDir 的算法本身：平台、环境变量与主目录由调用方给（测试各平台的缺省值用）。 */
export function userDataDirFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv | Record<string, string | undefined>, home: string): string {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Taskwright");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Taskwright");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "taskwright");
}

/** 指定数据目录的环境变量：桌面包的启动程序与任务服务都认它。 */
export const ENV_DATA_DIR = "TASKWRIGHT_DATA_DIR";

/**
 * 数据目录：服务级库（service_db.ts）、数据升级前的备份 backups/ 与升级报告放在这里；任务目录、归档目录、知识库目录没有另给时
 * 也在它下面（tasks、runs、knowledge）。按这个次序定：命令行给的 --data；环境变量 TASKWRIGHT_DATA_DIR；给了 --tasks 时取它的
 * 上一级目录；都没有才是用户数据目录。第三条是为了只给 --tasks 的用法（开发与测试）：那时不把服务级库写到用户本人的数据目录里去。
 */
export function dataDirectory(given?: string | null, tasks?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  if (given) return resolve(given);
  if (env[ENV_DATA_DIR]) return resolve(env[ENV_DATA_DIR]!);
  if (tasks) return dirname(resolve(tasks));
  return userDataDir();
}

/** 日志目录：服务的日志除了写标准输出，也写一份到这里（双击启动时没有终端）。 */
export function logDir(): string {
  return join(userDataDir(), "logs");
}

/** 产品版本号：取仓根 package.json 的 version；读不到时写 unknown。 */
export function appVersion(): string {
  try {
    const version = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).version;
    return typeof version === "string" && version ? version : "unknown";
  } catch {
    return "unknown";
  }
}
