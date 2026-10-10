/**
 * 有阶段的任务的系统提示怎样拼：读哪几份文件、按什么次序接、每一部分叫什么。不碰 pi，挂到事件上的那一半在 hooks/stage_prompt.ts。
 *
 * 拼出来的次序是：系统提示、平台说明的共用部分、任务类型说明的共用部分、平台说明里现在这个阶段的那一段、
 * 任务类型说明里现在这个阶段的那一段，最后是 pi 自己接在系统提示后面的那一截（工作目录、上下文文件）。
 * 按阶段的两段放在最后：换阶段时前面几部分一字不变，模型服务对请求开头相同的那一截不用重算。
 *
 * 平台一级的文件在 agent/prompts/stages/（system.md、common.md 与五个阶段各一份，文件名是 lib/stage.ts 里阶段的键）。
 * 任务类型一级的文件在任务目录里那份任务 skill 的目录下：SKILL.md 的正文是共用部分，旁边的 stages/<阶段的键>.md 是那个阶段的一段，
 * 没有这个文件就是这一段没有内容。早先建任务时复制进任务目录的是整份的 SKILL.md、没有 stages 目录，照同样的规则读出来就是
 * 「共用部分是整份文字、按阶段的那一段为空」。
 *
 * pi 的 skill 清单那一段不接回去：说明已经整份放在系统提示里，清单里那句「任务对得上就去读 skill 的文件」会让模型把
 * 早先的任务用的那份平台说明（五个阶段的做法都在里面）又读进来。
 *
 * 不是每次运行都重读重拼（StagePromptCache）：进程里记着上一次拼的那一份与它用到的每份文件的修改时刻和大小，
 * 下一次只看阶段与这些文件变没变（只查文件的属性，不读内容），没变就把上一份原样交回，变了才重读重拼；
 * 重拼出错时沿用上一份并把原因带出去。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./db.ts";
import { validateDefinition } from "./definition.ts";
import { BUSY_TIMEOUT_MS } from "./schema.ts";
import { type Stage } from "./stage.ts";
import { stageOf } from "./stage_read.ts";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

/** 平台一级按阶段拼的文件所在的目录。 */
export const PLATFORM_STAGES_DIR = join(PROMPTS_DIR, "stages");

/** 平台 skill 的目录：它是早先的任务读的那一份，有阶段的任务不读它，认任务 skill 时要把它排除。 */
export const PLATFORM_SKILL_DIR = join(PROMPTS_DIR, "skills", "taskwright-executor");

export const SYSTEM_FILE = "system.md";
export const COMMON_FILE = "common.md";
/** 任务 skill 的目录里放按阶段的几段的子目录。 */
export const TASK_STAGES_SUBDIR = "stages";

/** 某个阶段的那一段的文件名。 */
export function stageFile(stage: Stage): string {
  return `${stage}.md`;
}

/** 拼进系统提示的一部分是什么。 */
export type PartKind = "system" | "platform_common" | "task_common" | "platform_stage" | "task_stage" | "tail";

/** 每一部分给人看的名字。 */
export const PART_NAMES: Record<PartKind, string> = {
  system: "系统提示",
  platform_common: "平台说明的共用部分",
  task_common: "任务类型说明的共用部分",
  platform_stage: "平台说明里这个阶段的那一段",
  task_stage: "任务类型说明里这个阶段的那一段",
  tail: "助手程序接在后面的工作目录等",
};

/** 一部分的文字出自哪里：产品自带的文件、任务目录里的文件、助手程序（pi）自己。 */
export type PartOrigin = "builtin" | "task" | "pi";

export interface PromptPart {
  part: PartKind;
  from: PartOrigin;
  /** 文件的路径：产品自带的相对代码仓根目录，任务目录里的相对任务目录；不是文件的（pi 接的那一截）为 null。 */
  file: string | null;
  text: string;
}

export interface StagePrompt {
  stage: Stage;
  /** 整份文字：各部分去掉末尾的空白之后用一个空行隔开。 */
  text: string;
  parts: PromptPart[];
}

/** pi 加载的一个 skill：名字与它的 SKILL.md 在哪里（before_agent_start 事件的 systemPromptOptions.skills 里就是这个样子）。 */
export interface LoadedSkill {
  name: string;
  filePath: string;
}

/** 去掉 SKILL.md 开头两行 --- 之间的 frontmatter，留下正文。 */
export function skillBody(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(text);
  return (match ? match[1] : text).replace(/^\n+/, "");
}

/** 内容的摘要值：SHA-256 取前 16 位十六进制，与后端启动记录里文件的摘要值是同一种算法。 */
export function digestOf(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex").slice(0, 16);
}

/** 一份文件的修改时刻与大小：用来看它变没变，不用读内容。 */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

/** 读文件的两个动作。拼接与缓存都经它，测试里换成记次数的。 */
export interface PromptIo {
  /** 是普通文件时返回它的修改时刻与大小，不在或不是文件时返回 null。 */
  stamp(path: string): FileStamp | null;
  read(path: string): string;
}

export const NODE_IO: PromptIo = {
  stamp(path) {
    try {
      const found = statSync(path);
      return found.isFile() ? { mtimeMs: found.mtimeMs, size: found.size } : null;
    } catch {
      return null;
    }
  },
  read: (path) => readFileSync(path, "utf-8"),
};

/**
 * pi 接在启动参数给的系统提示后面的那一截，去掉 skill 清单。
 * current 是事件给的当前系统提示，custom 是启动参数给的那一段（事件的 systemPromptOptions.customPrompt）。
 * current 不是以 custom 开头时（别的扩展先改过），只取工作目录那一段；取不到就是空的。
 */
export function piTail(current: string, custom: string): string {
  const withoutSkills = current.replace(/<skills>[\s\S]*?<\/skills>/, "");
  if (custom && current.startsWith(custom)) return withoutSkills.slice(custom.length).replace(/\n{3,}/g, "\n\n").trim();
  return /<cwd>[\s\S]*?<\/cwd>/.exec(withoutSkills)?.[0] ?? "";
}

/** 任务 skill：pi 加载的 skill 里除了平台 skill 之外的那些，按 pi 给的次序。 */
export function taskSkills(skills: readonly LoadedSkill[]): LoadedSkill[] {
  return skills.filter((one) => resolve(dirname(one.filePath)) !== resolve(PLATFORM_SKILL_DIR));
}

export interface ComposeInput {
  stage: Stage;
  /** 任务目录：任务目录里的文件路径相对它来写。 */
  workspaceDir: string;
  /** pi 加载的全部 skill。 */
  skills: readonly LoadedSkill[];
  /** pi 接在后面的那一截（piTail 的结果）。 */
  tail: string;
  /** 平台一级的文件所在的目录；缺省是产品自带的那一个，测试里换成别的。 */
  platformDir?: string;
}

/** 平台一级的文件写进 file 一项时相对的目录：代码仓根目录。 */
const REPO_ROOT = resolve(PROMPTS_DIR, "..", "..");

/** 拼的时候可能用到的一份文件：是哪一部分、在哪里、缺了行不行。 */
interface Candidate {
  part: PartKind;
  from: PartOrigin;
  /** 写进 PromptPart.file 的路径。 */
  file: string;
  path: string;
  /** 平台一级的三份缺了就拼不成；任务类型一级的没有就跳过。 */
  required: boolean;
}

/** 某个阶段要看的全部文件，按拼接的先后排。 */
function candidates(input: ComposeInput): Candidate[] {
  const platformDir = input.platformDir ?? PLATFORM_STAGES_DIR;
  const builtin = (part: PartKind, name: string): Candidate => {
    const path = join(platformDir, name);
    return { part, from: "builtin", file: relative(REPO_ROOT, path), path, required: true };
  };
  const inTask = (part: PartKind, path: string): Candidate => ({ part, from: "task", file: relative(resolve(input.workspaceDir), resolve(path)), path, required: false });
  const skills = taskSkills(input.skills);
  return [
    builtin("system", SYSTEM_FILE),
    builtin("platform_common", COMMON_FILE),
    ...skills.map((one) => inTask("task_common", one.filePath)),
    builtin("platform_stage", stageFile(input.stage)),
    ...skills.map((one) => inTask("task_stage", join(dirname(one.filePath), TASK_STAGES_SUBDIR, stageFile(input.stage)))),
  ];
}

/**
 * 拼出某个阶段的系统提示。平台一级的三份文件（系统提示、共用部分、这个阶段的那一段）缺了任何一份都抛错，
 * 调用方这时不换系统提示；任务类型一级的文件没有就跳过。
 */
export function composeStagePrompt(input: ComposeInput, io: PromptIo = NODE_IO): StagePrompt {
  const parts: PromptPart[] = [];
  const add = (part: PartKind, from: PartOrigin, file: string | null, text: string) => {
    const trimmed = text.replace(/\s+$/, "");
    if (trimmed) parts.push({ part, from, file, text: trimmed });
  };
  for (const one of candidates(input)) {
    if (io.stamp(one.path) === null) {
      if (one.required) throw new Error(`拼系统提示要用的文件不在：${one.path}`);
      continue;
    }
    const text = io.read(one.path);
    add(one.part, one.from, one.file, one.part === "task_common" ? skillBody(text) : text);
  }
  add("tail", "pi", null, input.tail);
  return { stage: input.stage, text: parts.map((one) => one.text).join("\n\n"), parts };
}

/** 这一次拿到的系统提示是怎样来的：重读重拼的、沿用上一份的、重拼出错而沿用上一份的。 */
export type ComposeHow = "recomposed" | "reused" | "kept_after_error";

/** 给人看的说法。 */
export const HOW_NAMES: Record<ComposeHow, string> = { recomposed: "重拼", reused: "沿用", kept_after_error: "重拼出错，沿用上一份" };

export interface CachedPrompt {
  prompt: StagePrompt;
  how: ComposeHow;
  /** 重拼出错时的原因；别的情形没有这一项。 */
  error?: string;
}

/**
 * 记着上一次拼的那一份。每次要系统提示时只看阶段、pi 接的那一截与各份文件的修改时刻和大小变没变：
 * 没变就把上一份原样交回（不读任何文件的内容），变了才重读重拼。重拼出错而手里有上一份时沿用上一份，并带上原因；
 * 手里什么都没有时把错抛给调用方。一个 pi 进程（一条任务的会话）用一个实例。
 */
export class StagePromptCache {
  private last: { key: string; prompt: StagePrompt } | null = null;
  private readonly io: PromptIo;

  constructor(io: PromptIo = NODE_IO) {
    this.io = io;
  }

  /** 这一次的输入与文件现状合成的一把钥匙：与上一次相同就是没变。 */
  private keyOf(input: ComposeInput): string {
    return JSON.stringify([input.stage, input.tail, candidates(input).map((one) => {
      const stamp = this.io.stamp(one.path);
      return [one.path, stamp?.mtimeMs ?? null, stamp?.size ?? null];
    })]);
  }

  get(input: ComposeInput): CachedPrompt {
    const key = this.keyOf(input);
    if (this.last && this.last.key === key) return { prompt: this.last.prompt, how: "reused" };
    try {
      const prompt = composeStagePrompt(input, this.io);
      this.last = { key, prompt };
      return { prompt, how: "recomposed" };
    } catch (error) {
      if (!this.last) throw error;
      return { prompt: this.last.prompt, how: "kept_after_error", error: (error as Error).message };
    }
  }
}

/** 一部分的几样事实，不带文字：报给后端、记进归档用。 */
export interface PartFact {
  part: PartKind;
  from: PartOrigin;
  file: string | null;
  bytes: number;
  lines: number;
  digest: string;
}

export function partFact(one: PromptPart): PartFact {
  return { part: one.part, from: one.from, file: one.file, bytes: Buffer.byteLength(one.text, "utf-8"), lines: one.text.split("\n").length, digest: digestOf(one.text) };
}

/**
 * 任务现在在哪个阶段，只读。任务库不在、库里还没有任务、或者是早先建的任务（没有「总体分析」集合）时返回 null：
 * 这些情形都不换系统提示。
 */
export function stageInWorkspace(workspaceDir: string): Stage | null {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; definition_text: string } | undefined;
    if (!task) return null;
    return stageOf(db, workspaceDir, task.task_id, validateDefinition(JSON.parse(task.definition_text)));
  } finally {
    db.close();
  }
}
