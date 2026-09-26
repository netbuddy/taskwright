/**
 * 启动配置：把 profiles/ 下的启动配置读成一条 pi 命令行与一份环境变量。全部代码里拼 pi 命令行的地方只有 buildCommand 这一处。
 *
 * 配置文件里不写任何机器上的绝对路径，也不写任何密钥。随机器变化的东西经环境变量给：
 *   TASKWRIGHT_LANGFUSE_PLUGIN    Langfuse 观测插件所在的目录（或直接指向它的扩展入口文件）；
 *   TASKWRIGHT_LANGFUSE_ENV_FILE  存放 Langfuse 密钥与服务地址的文件，这个文件在代码仓之外；
 *   TASKWRIGHT_PI_ENTRY           pi 的入口脚本（pi 目录下的 dist/bundle/cli.js）。给了就用当前的 Node 运行它，
 *                                 不在 PATH 里找 pi；打包进单个可执行文件时由打包层给（见 piSpawn）。
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { readTextFile } from "./files.ts";
import { byCodePoint } from "./library.ts";
import { PROFILE_DIR, fromRoot } from "./paths.ts";

export const ENV_PLUGIN = "TASKWRIGHT_LANGFUSE_PLUGIN";
export const ENV_KEY_FILE = "TASKWRIGHT_LANGFUSE_ENV_FILE";
export const ENV_TRACING_ENVIRONMENT = "LANGFUSE_TRACING_ENVIRONMENT";
export const ENV_PI_ENTRY = "TASKWRIGHT_PI_ENTRY";
/** 单个可执行文件里起 Node 脚本时，要运行的脚本经这个环境变量交给引导程序。 */
export const ENV_RUN_SCRIPT = "TASKWRIGHT_RUN_SCRIPT";

export type Profile = Record<string, any>;

/** 启动配置有问题，带一句说明缺什么、怎么补。 */
export class LaunchError extends Error {}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function expandUser(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** 读一份启动配置。name 是 profiles 目录下的文件名，不带扩展名。 */
export function loadProfile(name = "dev"): Profile {
  const path = join(PROFILE_DIR, `${name}.json`);
  if (!isFile(path)) {
    const available = readdirSync(PROFILE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort(byCodePoint).join("、") || "（一个都没有）";
    throw new LaunchError(`找不到启动配置「${name}」。可用的配置有：${available}。`);
  }
  return JSON.parse(readTextFile(path));
}

/** 读一个每行写着「名字=值」的文件。以井号开头的行与空行跳过，值两头的引号去掉。 */
export function readEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of readTextFile(path).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    let value = line.slice(at + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
    values[line.slice(0, at).trim()] = value;
  }
  return values;
}

/** 把配置里的一条扩展说明解析成一个真实存在的文件路径。缺了非必需的就返回 null。 */
export function resolveExtension(entry: Record<string, any>): string | null {
  const name = entry.name ?? "（没写名字的扩展）";
  const source = entry.source;
  if (source === "repo") {
    const path = fromRoot(entry.path);
    if (!isFile(path)) throw new LaunchError(`扩展「${name}」应当在代码仓的 ${entry.path}，但那里没有这个文件。`);
    return path;
  }
  if (source === "env") {
    const variable = entry.env;
    const raw = (process.env[variable] ?? "").trim();
    if (!raw) {
      if (entry.required ?? true) {
        throw new LaunchError(`扩展「${name}」要靠环境变量 ${variable} 指路，但这个变量没有设。把它设成插件所在的目录，再重新启动。`);
      }
      return null;
    }
    let path = expandUser(raw);
    if (isDir(path)) path = join(path, entry.entry ?? "src/index.ts");
    if (!isFile(path)) throw new LaunchError(`扩展「${name}」按环境变量 ${variable} 找到的位置不是一个文件：${path}`);
    return path;
  }
  throw new LaunchError(`扩展「${name}」的 source 只能写 repo 或 env，现在写的是 ${source === undefined || source === null ? "None" : `'${source}'`}。`);
}

/** 平台 skill 所在的目录；配置没写这一项返回 null，写了但目录里没有 SKILL.md 就报错。 */
export function platformSkillDir(profile: Profile): string | null {
  const rel = profile.platform_skill;
  if (!rel) return null;
  const path = fromRoot(rel);
  if (!isFile(join(path, "SKILL.md"))) throw new LaunchError(`配置里写的平台 skill 应当在代码仓的 ${rel}/SKILL.md，但那里没有这个文件。`);
  return path;
}

/** 组装交给 pi 进程的环境变量。密钥从代码仓之外的那个文件读进来，只经环境变量传给 pi，不落任何文件、不进命令行参数。 */
export function buildEnvironment(profile: Profile): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const keyFile = (process.env[ENV_KEY_FILE] ?? "").trim();
  let loaded: Record<string, string> = {};
  if (keyFile) {
    const path = expandUser(keyFile);
    if (!isFile(path)) throw new LaunchError(`环境变量 ${ENV_KEY_FILE} 指向的文件不存在：${path}`);
    loaded = readEnvFile(path);
  }
  for (const name of profile.env_passthrough ?? []) {
    const value = loaded[name] || process.env[name];
    if (value) env[name] = value;
  }
  const tag = (profile.langfuse || {}).environment;
  if (tag) env[ENV_TRACING_ENVIRONMENT] = env[ENV_TRACING_ENVIRONMENT] || tag;
  return env;
}

export function describeExtensions(profile: Profile): [string, string | null][] {
  return (profile.extensions ?? []).map((entry: Record<string, any>) => [entry.name ?? "（没写名字的扩展）", resolveExtension(entry)]);
}

/** 在 PATH 里找一个可执行文件，与 Python 的 shutil.which 相同；找不到时为 null。 */
export function which(name: string): string | null {
  if (name.includes("/")) return isFile(name) ? name : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
    } catch {
      // 这个目录里没有
    }
  }
  return null;
}

/**
 * 起 pi 用哪个可执行文件。三种情形：
 * 1. 设了 TASKWRIGHT_PI_ENTRY（pi 的入口脚本）：用当前的 Node 运行它；在单个可执行文件里，当前可执行文件就是 Node，
 *    但运行它会启动内嵌的程序，所以把脚本放进 TASKWRIGHT_RUN_SCRIPT 交给引导程序，参数里不写脚本；
 * 2. 否则在 PATH 里找启动配置里写的可执行文件（缺省 pi），与 Python 版相同。
 * 返回记进后端补记的命令行开头、实际起进程用的可执行文件与参数开头、要另加的环境变量。
 */
export function piLauncher(profile: Profile): { shown: string[]; command: string; prefix: string[]; env: Record<string, string> } {
  const entry = (process.env[ENV_PI_ENTRY] ?? "").trim();
  if (entry) {
    const script = resolve(expandUser(entry));
    if (!isFile(script)) throw new LaunchError(`环境变量 ${ENV_PI_ENTRY} 指向的 pi 入口脚本不存在：${script}`);
    if (isSingleExecutable()) return { shown: [process.execPath, script], command: process.execPath, prefix: [], env: { [ENV_RUN_SCRIPT]: script } };
    return { shown: [process.execPath, script], command: process.execPath, prefix: [script], env: {} };
  }
  const executable = which(profile.executable ?? "pi");
  if (executable === null) throw new LaunchError("在 PATH 里找不到 pi 命令，先把 pi 装好再启动。");
  return { shown: [executable], command: executable, prefix: [], env: {} };
}

let seaState: boolean | null = null;
/** 当前进程是不是 Node 单个可执行文件（SEA）。 */
export function isSingleExecutable(): boolean {
  if (seaState === null) {
    try {
      const sea = process.getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
      seaState = Boolean(sea?.isSea?.());
    } catch {
      seaState = false;
    }
  }
  return seaState;
}

export interface Command {
  /** 记进后端补记的命令行（与 Python 版相同的写法：可执行文件在前，后面是参数）。 */
  argv: string[];
  /** 实际起进程用的可执行文件与参数。 */
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * 组装启动 pi 的命令行与环境变量。这是全部代码里唯一拼 pi 命令行的地方。
 * sessionFile 给了就让 pi 接着那个会话文件往下跑；interactive 为真时不写 --mode（pi 自带的终端界面），其余参数一字不差。
 */
export function buildCommand(profile: Profile, workspace: string, sessionDir: string, sessionFile: string | null = null, interactive = false): Command {
  const launcher = piLauncher(profile);
  const args: string[] = interactive ? [] : ["--mode", profile.mode ?? "rpc"];
  for (const [, path] of describeExtensions(profile)) if (path !== null) args.push("-e", path);
  const flags = profile.flags ?? {};
  if (flags.no_extensions) args.push("--no-extensions");
  if (flags.no_skills) args.push("--no-skills");
  if (flags.approve) args.push("--approve");
  if (flags.offline) args.push("--offline");
  const tools = profile.tools;
  if (tools && tools.length) args.push("--tools", tools.join(","));
  if (profile.model) args.push("--model", profile.model);
  if (profile.thinking) args.push("--thinking", profile.thinking);
  // 先传平台 skill，再传任务目录里的技能：两个 --skill 的先后决定 pi 的 skill 清单里的顺序。
  const platform = platformSkillDir(profile);
  if (platform !== null) args.push("--skill", platform);
  const skillsDir = profile.workspace_skills_dir;
  if (skillsDir && isDir(join(workspace, skillsDir))) args.push("--skill", resolve(workspace, skillsDir));
  args.push("--session-dir", sessionDir);
  if (sessionFile !== null) args.push("--session", sessionFile);
  const promptFile = profile.system_prompt_file;
  if (promptFile) {
    const path = fromRoot(promptFile);
    if (!isFile(path)) throw new LaunchError(`配置里写的系统提示文件不存在：${promptFile}`);
    args.push("--system-prompt", readTextFile(path));
  }
  return {
    argv: [...launcher.shown, ...args], command: launcher.command, args: [...launcher.prefix, ...args],
    env: { ...buildEnvironment(profile), ...launcher.env },
  };
}

/** 这一次启动的几样事实，交给会话类写进后端补记。 */
export function startupRecord(profile: Profile, argv: string[]) {
  return {
    命令行: [...argv],
    扩展: describeExtensions(profile).map(([name, path]) => ({ 名字: name, 解析到的文件: path ?? "", 文件在不在: path !== null })),
    工具白名单: [...(profile.tools || [])],
    模型: profile.model ?? "",
    环境标签: (profile.langfuse || {}).environment ?? "",
    "平台 skill": platformSkillRecord(profile),
  };
}

export function platformSkillRecord(profile: Profile) {
  const path = platformSkillDir(profile);
  if (path === null) return { 有没有: false, 说明: "启动配置里没有写 platform_skill，这次没有加载平台 skill。" };
  return { 有没有: true, 代码仓里的路径: profile.platform_skill, 目录: path, 文件: digestFiles(path, path) };
}

// ───────────── 启动那一刻的知识仓库与上下文文件 ─────────────

export const KNOWLEDGE_DIRS = [".pi/skills", "docs"];
export const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** base 下的全部项（含目录），相对 base 的各级名字，按逐级名字排序（与 Python 的 sorted(rglob) 相同）。 */
function walk(base: string): string[][] {
  const out: string[][] = [];
  const visit = (parts: string[]) => {
    let names: string[];
    try {
      names = readdirSync(join(base, ...parts));
    } catch {
      return;
    }
    for (const name of names) {
      const next = [...parts, name];
      out.push(next);
      if (isDir(join(base, ...next))) visit(next);
    }
  };
  visit([]);
  return out.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const d = byCodePoint(a[i], b[i]);
      if (d) return d;
    }
    return a.length - b.length;
  });
}

/** base 下每份文件的路径（相对 relativeTo）、字节数与摘要值（SHA-256 的前 16 位）。 */
export function digestFiles(base: string, relativeTo: string): Record<string, unknown>[] {
  const files: Record<string, unknown>[] = [];
  for (const parts of walk(base)) {
    const path = join(base, ...parts);
    if (!isFile(path)) continue;
    const rel = relative(relativeTo, path);
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch (error) {
      files.push({ 路径: rel, 字节数: null, 摘要值: "", 说明: `读不出来：${(error as Error).message}` });
      continue;
    }
    files.push({ 路径: rel, 字节数: data.length, 摘要值: createHash("sha256").update(data).digest("hex").slice(0, 16) });
  }
  return files;
}

/** 启动那一刻知识仓库里每份文件的路径、字节数与内容摘要值；配置了平台 skill 时它的文件也记进来。 */
export function knowledgeSnapshot(workspace: string, profile: Profile | null = null) {
  const files: Record<string, unknown>[] = [];
  for (const sub of KNOWLEDGE_DIRS) {
    const base = join(workspace, sub);
    if (isDir(base)) files.push(...digestFiles(base, workspace));
  }
  const where = [...KNOWLEDGE_DIRS];
  const platform = profile ? platformSkillDir(profile) : null;
  if (platform !== null) {
    for (const one of digestFiles(platform, platform)) {
      files.push({ ...one, 路径: join(platform, String(one["路径"])), 来自: "平台 skill", 代码仓里的路径: `${profile!.platform_skill}/${one["路径"]}` });
    }
    where.push(`代码仓的 ${profile!.platform_skill}（平台 skill）`);
  }
  return { 摘要算法: "SHA-256 取前 16 位十六进制", 位置: where, 文件: files };
}

/** pi 会放进系统提示的上下文文件：照 pi 的发现规则在磁盘上查一遍（pi 的 RPC 没有查询这一项的命令）。 */
export function contextFileCandidates(argv: string[], workspace: string, env: Record<string, string>) {
  const disabled = argv.includes("--no-context-files") || argv.includes("-nc");
  const agentDir = expandUser(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
  const found: string[] = [];
  const ancestors: string[] = [];
  let current = resolve(workspace);
  for (;;) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const directories = [agentDir, ...ancestors.reverse()];
  for (const directory of directories) {
    for (const name of CONTEXT_FILE_NAMES) {
      const candidate = join(directory, name);
      if (isFile(candidate)) {
        if (!found.includes(candidate)) found.push(candidate);
        break;
      }
    }
  }
  return {
    取得到吗: false,
    为什么取不到: "pi 的 RPC 没有查询上下文文件的命令，扩展之外的程序拿不到 pi 实际加载的清单。",
    命令行关掉了上下文文件吗: disabled,
    "照 pi 的发现规则在磁盘上查到的": disabled ? [] : found,
    查了哪些目录: directories,
    说明: disabled ? "命令行带了 --no-context-files，pi 不会加载任何上下文文件。"
      : "下面这份是后端照 pi 的发现规则在启动那一刻查到的，不是 pi 报告的；要核实 pi 实际放进了什么，看 Langfuse 里第一条生成记录的系统提示有没有 <project_context> 一节。",
  };
}

