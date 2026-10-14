/**
 * 桌面包的目录：全部放在一个根下，删掉这一个目录就等于卸载。根是数据目录（--data、环境变量 TASKWRIGHT_DATA_DIR，都没有时是
 * paths.ts 的 userDataDir：Linux ~/.local/share/taskwright，Windows %LOCALAPPDATA%\\Taskwright，macOS $HOME/Library/Application Support/Taskwright）。
 * 根下除了任务、归档、知识库、日志、备份、产品设置与服务级库，还有两个子目录：
 *   pi/      Taskwright 自己的 pi 配置目录（settings.json、models.json、auth.json）。桌面包启动时把 PI_CODING_AGENT_DIR 指过来，
 *            模型设置页的读写、按 pi 设置文件取缺省模型的规则（launch.ts）都跟着它走；产品不再读写用户本人的 ~/.pi/agent。
 *   cache/   程序内容：单可执行文件解压出的 payload/<构建号>/，AppImage 复制出的 agent-<构建号>/。新构建解压或复制成功后删掉旧构建的。
 * PI_CODING_AGENT_DIR 与 TASKWRIGHT_CACHE_DIR 给了时照给的。仓内开发与测试不经桌面包的启动程序，用法不变。
 *
 * 这里只放算法与文件操作，由启动程序（release/app/main.ts）在起服务之前调用；单可执行文件的引导脚本（release/app/boot.cjs）
 * 在解压之前就要知道 cache/ 在哪里，它照同一个规则另写了一份（它只能用 Node 自带的模块）。
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { updateJsonFile } from "./config_files.ts";
import { expandUser } from "./launch.ts";
import { settingsFile } from "./product_settings.ts";

/** 根下两个子目录的名字。 */
export const PI_SUBDIR = "pi";
export const CACHE_SUBDIR = "cache";
/** 从本机 pi 的配置复制过来时，在自己的 pi/ 里留的记号文件。 */
export const COPIED_MARK = ".copied-from-pi.json";
/** 首次启动时从本机 pi 的配置目录复制哪几个文件（有的才复制）。 */
export const ADOPTED_FILES = ["models.json", "auth.json", "settings.json"] as const;

export interface DesktopLayout {
  root: string;
  /** pi 配置目录；piGiven 为真时是 PI_CODING_AGENT_DIR 给的。 */
  pi: string;
  piGiven: boolean;
  /** 程序缓存目录；TASKWRIGHT_CACHE_DIR 给了时照给的。 */
  cache: string;
}

/** 一个根下的布局。 */
export function desktopLayout(root: string, env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): DesktopLayout {
  const given = (env.PI_CODING_AGENT_DIR ?? "").trim();
  const cache = (env.TASKWRIGHT_CACHE_DIR ?? "").trim();
  return {
    root: resolve(root),
    pi: given ? resolve(expandUser(given)) : join(resolve(root), PI_SUBDIR), piGiven: given !== "",
    cache: cache ? resolve(cache) : join(resolve(root), CACHE_SUBDIR),
  };
}

export interface CopiedMark {
  /** 从哪个目录复制的。 */
  from: string;
  /** 复制的时刻（ISO 写法）。 */
  at: string;
  files: string[];
}

/**
 * 首次启动时接过本机 pi 的配置：自己的 pi/ 里 models.json 与 auth.json 都没有，而 legacy（本机 pi 的配置目录，一般是 ~/.pi/agent）里
 * 有其中之一时，把 ADOPTED_FILES 里有的几个复制过来（是复制，不是链接；auth.json 保持只有本人能读），产品设置里为 legacy 记的
 * 那一份（登记过的模型服务、选定的模型）也照样记到 pi/ 名下，再留一个记号文件。别的情形什么都不做，返回 null。
 * 之后产品只读写 pi/，不再碰 legacy。
 */
export async function adoptPiConfig(piDir: string, legacy: string, env: NodeJS.ProcessEnv | Record<string, string> = process.env, now: () => Date = () => new Date()): Promise<CopiedMark | null> {
  const has = (dir: string, name: string) => existsSync(join(dir, name));
  if (resolve(piDir) === resolve(legacy)) return null;
  if (has(piDir, "models.json") || has(piDir, "auth.json")) return null;
  if (!has(legacy, "models.json") && !has(legacy, "auth.json")) return null;
  mkdirSync(piDir, { recursive: true });
  const files: string[] = [];
  for (const name of ADOPTED_FILES) {
    const from = join(legacy, name);
    if (!existsSync(from) || !statSync(from).isFile()) continue;
    copyFileSync(from, join(piDir, name));
    if (name === "auth.json") chmodSync(join(piDir, name), 0o600);
    files.push(name);
  }
  // 产品设置按 pi 配置目录的绝对路径分开记：把 legacy 名下的那一份照样记到 pi/ 名下（pi/ 名下已经有的不动）。
  const settings = settingsFile(env);
  if (existsSync(settings)) {
    await updateJsonFile(settings, (value) => {
      const dirs = value.pi_dirs;
      const old = dirs?.[resolve(legacy)];
      if (!dirs || !old || dirs[resolve(piDir)]) return false;
      dirs[resolve(piDir)] = JSON.parse(JSON.stringify(old));
      return true;
    });
  }
  const mark: CopiedMark = { from: resolve(legacy), at: now().toISOString(), files };
  writeFileSync(join(piDir, COPIED_MARK), JSON.stringify(mark, null, 2) + "\n", "utf-8");
  return mark;
}

/** 自己的 pi/ 是不是从本机 pi 的配置复制来的；不是、读不出时是 null。模型设置页据此写一句。 */
export function readCopiedMark(piDir: string): CopiedMark | null {
  try {
    const value = JSON.parse(readFileSync(join(piDir, COPIED_MARK), "utf-8"));
    if (typeof value?.from !== "string" || typeof value?.at !== "string") return null;
    return { from: value.from, at: value.at, files: Array.isArray(value.files) ? value.files.filter((one: unknown) => typeof one === "string") : [] };
  } catch {
    return null;
  }
}

/**
 * 删掉旧构建的程序内容：cache/payload/ 下除 keepPayload 之外的目录，cache/ 下除 keepAgent 之外的 agent-<构建号> 目录。
 * 名字里带 .tmp- 的是另一次启动正在解压或复制的，不动。返回删掉的目录（相对 cache/ 的写法）。
 */
export function pruneOldBuilds(cacheDir: string, keep: { payload?: string | null; agent?: string | null }): string[] {
  const removed: string[] = [];
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((one) => one.isDirectory()).map((one) => one.name);
    } catch {
      return [];
    }
  };
  if (keep.payload) {
    for (const name of list(join(cacheDir, "payload"))) {
      if (name === keep.payload || name.includes(".tmp-")) continue;
      rmSync(join(cacheDir, "payload", name), { recursive: true, force: true });
      removed.push(`payload/${name}`);
    }
  }
  if (keep.agent) {
    for (const name of list(cacheDir)) {
      if (!name.startsWith("agent-") || name === keep.agent || name.includes(".tmp-")) continue;
      rmSync(join(cacheDir, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}
