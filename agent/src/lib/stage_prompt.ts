/**
 * 有阶段的任务的系统提示怎样拼：读哪几份文件、按什么次序接、每一部分叫什么。不碰 pi，挂到事件上的那一半在 hooks/stage_prompt.ts。
 *
 * 拼出来的次序是：系统提示、平台说明的共用部分、任务类型说明的共用部分、平台说明里现在这项活动的那一段、
 * 这项活动在流程里的节点的出口、任务类型说明里现在这个阶段的那一段、用户启动这个工作项时写的范围说明（写了才有），
 * 最后是 pi 自己接在系统提示后面的那一截（工作目录、上下文文件）。
 * 按阶段的几段放在最后：换阶段时前面几部分一字不变，模型服务对请求开头相同的那一截不用重算。
 *
 * 活动的说明与节点的出口是分开的两处。活动的说明（做什么、不做什么、做到什么算够）一项活动一份文件，与它在不在流程里无关；
 * 出口（做完了提议什么、往回提议什么、用户说的话不属于这一段时怎样办）是这项活动在一条流程里的那个节点的事，写在流程的定义里
 * （agent/prompts/flows/initial.md，首次分析），一个节点一节。会话的工作项是流程的工作项时，两处接起来；工作项是单项活动时，
 * 出口换成固定的一段（STANDALONE_EXIT）：做够了就在回复里汇报结束，不提议进入别的活动。
 *
 * 会话空闲时（没有在进行的工作项，lib/stage.ts 的 IDLE）没有活动的说明可拼：用一段固定的开头（IDLE_OPENING）说明本会话现在空闲，
 * 后面接澄清那项活动的说明去掉标题与开头那一段话（从第一个「## 」小节起），不带任何节点的出口。任务类型一级澄清的那一段若有
 * 「## 出口」一节，也去掉（withoutSection）。
 *
 * 平台一级的文件在 agent/prompts/stages/（system.md、common.md 与六项活动各一份，文件名是 lib/stage.ts 里阶段的键），
 * 流程的定义在 agent/prompts/flows/。活动的定义与流程的定义开头两行 --- 之间有一段结构化的头（lib/activity_def.ts），
 * 给任务起点页的活动目录用，拼系统提示时去掉，只用其后的正文。stages 目录里另有一份 publish.md（发布）只有头，不是工作阶段，不拼。
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
 *
 * 调试模式下另有一个「提示词目录」（debugPromptDir）：目录里有哪一份，就用那一份代替产品自带的或任务目录里的，没有的照旧。
 * 只认固定的十六个文件名（promptDirNames），软链接不跟、超过 PROMPT_DIR_MAX_BYTES 的不读、不是合法 UTF-8 的不用，
 * 这几种情形那一份照旧用原来的，并在 notes 里写明原因。产品只读这个目录，不往里写。
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./db.ts";
import { validateDefinition } from "./definition.ts";
import { BUSY_TIMEOUT_MS } from "./schema.ts";
import { IDLE, type Position, STAGES, STAGE_NAMES, type Stage, gateStage } from "./stage.ts";
import { openActivityRecord, stageOf } from "./stage_read.ts";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

/** 平台一级按阶段拼的文件所在的目录。 */
export const PLATFORM_STAGES_DIR = join(PROMPTS_DIR, "stages");

/** 流程的定义所在的目录，与首次分析这条流程的文件名。 */
export const PLATFORM_FLOWS_DIR = join(PROMPTS_DIR, "flows");
export const FLOWS_SUBDIR = "flows";
export const FLOW_INITIAL_FILE = "initial.md";

/** 平台 skill 的目录：它是早先的任务读的那一份，有阶段的任务不读它，认任务 skill 时要把它排除。 */
export const PLATFORM_SKILL_DIR = join(PROMPTS_DIR, "skills", "taskwright-executor");

export const SYSTEM_FILE = "system.md";
export const COMMON_FILE = "common.md";
/** 任务 skill 的目录里放按阶段的几段的子目录。 */
export const TASK_STAGES_SUBDIR = "stages";

/** 某个阶段的那一段的文件名。会话空闲时用澄清的那一份。 */
export function stageFile(stage: Position): string {
  return `${gateStage(stage)}.md`;
}

/** 讲怎样离开这一段（提议进入下一段、谁能移动）的那一节的标题：流程的定义里每个节点有这一节；会话空闲时拼的文字里不带它。 */
export const EXIT_HEADING = "出口";

/** 流程的定义里一个节点那一节的一级标题。 */
export function nodeHeading(stage: Stage): string {
  return `节点：${STAGE_NAMES[stage]}`;
}

/**
 * 从流程的定义里取出一个节点那一节的正文：从「# 节点：某阶段」的下一行起，到下一个一级标题之前。没有这一节时返回 null。
 * 正文里的小节照原样是二级标题（「## 出口」「## 用户说的话不属于本段时」），接在活动的说明后面正好与它的各节平级。
 */
export function nodeSection(text: string, stage: Stage): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^#\s+/.test(line) && line.replace(/^#\s+/, "").trim() === nodeHeading(stage));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#\s+/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** 去掉一份活动说明开头的标题与那一段话：从第一个二级小节起；一个二级小节都没有时原样返回。 */
export function withoutOpening(text: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => /^##\s+/.test(line));
  return first < 0 ? text : lines.slice(first).join("\n");
}

/** 会话空闲时（自由讨论的会话，或者它的工作项已经结束）接在共用部分后面的那一段的开头：后面接澄清那项活动的说明（去掉它自己的标题与开头那一段话）。 */
export const IDLE_OPENING = "# 现在：自由讨论\n\n" +
  "本会话现在没有在进行的工作项：它是自由讨论的会话，或者它的工作项已经结束。下面的规矩与澄清一段相同，但不写需求条目，不提议进入任何阶段，" +
  "也不提议开始哪一项活动；用户上传了材料也不自行核读。用户要做哪一项活动，请他从任务起点页启动一个工作项。";

/** 工作项是单项活动时，代替节点出口的那一段。 */
export const STANDALONE_EXIT = "## 出口\n\n" +
  "本会话的工作项是单项活动，不在工作流程里。这项活动做够了就在回复里汇报结束，不提议进入别的活动：" +
  "在成文的话里说清做到了哪里、还差什么，回复里写 `activity_done: true`；回复送达之后这个工作项结束，本会话此后按自由讨论办。" +
  "不要发进入下一段或者退回前面阶段的卡片，用户点了也不算数。用户说的事不属于这项活动时：能在这项活动里顺手做的照做；" +
  "这项活动做不了的（工具会拒绝），说明要做那件事请用户从任务起点页启动相应的工作项。";

/**
 * 去掉一份 Markdown 文字里标题是 heading 的二级小节：从「## heading」那一行起，到下一个一级或二级标题之前（没有下一个就到末尾）。
 * 更深的标题（###）算在这一节里，一起去掉。没有这一节时原样返回。
 */
export function withoutSection(text: string, heading: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    const title = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (title && title[1].length <= 2) skipping = title[1].length === 2 && title[2] === heading;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * 用户启动工作项时写了范围说明：这个工作项进行期间，它的各条会话的系统提示里按活动拼的几段后面接这一段。
 * 工作项结束之后就没有了。
 */
export function scopeSection(scope: string): string {
  return "## 本次范围说明\n\n" +
    "用户启动这个工作项时写了范围说明。这一次照它说的范围做；它没有说到的，照上面的说明。\n\n" +
    `本次范围说明：${scope.trim()}`;
}

/** 拼进系统提示的一部分是什么。 */
export type PartKind = "system" | "platform_common" | "task_common" | "platform_stage" | "node_exit" | "task_stage" | "scope" | "tail";

/** 每一部分给人看的名字。 */
export const PART_NAMES: Record<PartKind, string> = {
  system: "系统提示",
  platform_common: "平台说明的共用部分",
  task_common: "任务类型说明的共用部分",
  platform_stage: "平台说明里这个阶段的那一段",
  node_exit: "这个阶段在流程里的出口",
  task_stage: "任务类型说明里这个阶段的那一段",
  scope: "本次范围说明",
  tail: "助手程序接在后面的工作目录等",
};

/** 一部分的文字出自哪里：产品自带的文件、任务目录里的文件、调试模式的提示词目录里的文件、助手程序（pi）自己。 */
export type PartOrigin = "builtin" | "task" | "prompt_dir" | "pi";

/** 出处给人看的名字。 */
export const ORIGIN_NAMES: Record<PartOrigin, string> = { builtin: "产品自带", task: "任务目录", prompt_dir: "提示词目录", pi: "助手程序" };

export interface PromptPart {
  part: PartKind;
  from: PartOrigin;
  /**
   * 文件的路径：产品自带的相对代码仓根目录，任务目录里的相对任务目录，提示词目录里的相对那个目录；不是文件的为 null
   * （pi 接的那一截；工作项是单项活动时代替节点出口的那一段固定文字；范围说明，它出自任务库，from 写任务目录）。
   */
  file: string | null;
  text: string;
}

export interface StagePrompt {
  /** 这一份是为哪个阶段拼的；会话空闲时是 idle。 */
  stage: Position;
  /** 整份文字：各部分去掉末尾的空白之后用一个空行隔开。 */
  text: string;
  parts: PromptPart[];
  /** 提示词目录里有而没有用上的文件，各一句原因；没有时是空的。 */
  notes: string[];
}

/** pi 加载的一个 skill：名字与它的 SKILL.md 在哪里（before_agent_start 事件的 systemPromptOptions.skills 里就是这个样子）。 */
export interface LoadedSkill {
  name: string;
  filePath: string;
}

/** 去掉 SKILL.md 开头两行 --- 之间的 frontmatter，留下正文。活动的定义与流程的定义开头的头也用它去掉。 */
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

/** 提示词目录里一份文件最大多少字节：超过的不读。 */
export const PROMPT_DIR_MAX_BYTES = 256 * 1024;

/** 提示词目录里的一个路径是什么：可以用的普通文件、不在、在但是不用（原因写在 reason 里）。不跟软链接。 */
export type PlainState = ({ kind: "file" } & FileStamp) | { kind: "absent" } | { kind: "refused"; reason: string };

/** 读文件的几个动作。拼接与缓存都经它，测试里换成记次数的。 */
export interface PromptIo {
  /** 是普通文件时返回它的修改时刻与大小，不在或不是文件时返回 null。 */
  stamp(path: string): FileStamp | null;
  read(path: string): string;
  /** 提示词目录里的文件用它看：不跟软链接，太大的不要。 */
  plain(path: string): PlainState;
  /** 提示词目录里的文件用它读：不是合法的 UTF-8 时返回 null。 */
  readStrict(path: string): string | null;
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
  plain(path) {
    const found = lstatSync(path, { throwIfNoEntry: false });
    if (!found) return { kind: "absent" };
    if (found.isSymbolicLink()) return { kind: "refused", reason: "它是一个软链接" };
    if (!found.isFile()) return { kind: "refused", reason: "它不是普通文件" };
    if (found.size > PROMPT_DIR_MAX_BYTES) return { kind: "refused", reason: `它有 ${found.size} 字节，超过了 ${PROMPT_DIR_MAX_BYTES} 字节的上限` };
    return { kind: "file", mtimeMs: found.mtimeMs, size: found.size };
  },
  readStrict(path) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
    } catch {
      return null;
    }
  },
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
  /** 任务现在在哪个阶段；空闲时是 idle。 */
  stage: Position;
  /** 这条会话的工作项是不是流程的工作项；不给当作是。单项活动的工作项为假：节点的出口换成固定的一段。空闲时不看它。 */
  inFlow?: boolean;
  /** 用户启动这条会话的工作项时写的范围说明；没有写不给或者给 null。空闲时不看它。 */
  scope?: string | null;
  /** 任务目录：任务目录里的文件路径相对它来写。 */
  workspaceDir: string;
  /** pi 加载的全部 skill。 */
  skills: readonly LoadedSkill[];
  /** pi 接在后面的那一截（piTail 的结果）。 */
  tail: string;
  /** 平台一级的文件所在的目录；缺省是产品自带的那一个，测试里换成别的。 */
  platformDir?: string;
  /** 调试模式的提示词目录（绝对路径）；不给或为 null 时不看。 */
  promptDir?: string | null;
}

/** 提示词目录里放任务类型一级的文件的子目录。 */
export const PROMPT_DIR_TASK_SUBDIR = "task-type";

/** 某一部分在提示词目录里对应的文件名（相对那个目录）。pi 接的那一截没有对应的文件。会话空闲时按阶段的两份是澄清的。 */
export function promptDirName(part: Exclude<PartKind, "tail">, stage: Position): string {
  if (part === "system") return SYSTEM_FILE;
  if (part === "platform_common") return COMMON_FILE;
  if (part === "platform_stage") return stageFile(stage);
  if (part === "node_exit") return `${FLOWS_SUBDIR}/${FLOW_INITIAL_FILE}`;
  return `${PROMPT_DIR_TASK_SUBDIR}/${part === "task_common" ? COMMON_FILE : stageFile(stage)}`;
}

/** 提示词目录里认的全部文件名：平台一级八份、流程的定义一份、任务类型一级七份。别的名字一概不读。 */
export function promptDirNames(): string[] {
  return [SYSTEM_FILE, COMMON_FILE, ...STAGES.map(stageFile), `${FLOWS_SUBDIR}/${FLOW_INITIAL_FILE}`,
    `${PROMPT_DIR_TASK_SUBDIR}/${COMMON_FILE}`, ...STAGES.map((one) => `${PROMPT_DIR_TASK_SUBDIR}/${stageFile(one)}`)];
}

/** 平台一级的文件写进 file 一项时相对的目录：代码仓根目录。 */
const REPO_ROOT = resolve(PROMPTS_DIR, "..", "..");

/** 拼的时候要读的一份文件。 */
interface Source {
  part: PartKind;
  from: PartOrigin;
  /** 写进 PromptPart.file 的路径。 */
  file: string;
  path: string;
}

/** 系统提示里的一个位置（按拼接的先后排，最多六个）：这一次打算读哪几份文件，以及用来看它们变没变的属性。 */
interface Slot {
  part: Exclude<PartKind, "tail">;
  /** 平台一级的三个位置缺了文件就拼不成；任务类型一级的没有就跳过。 */
  required: boolean;
  /** 原来的文件：产品自带的或任务目录里的，只列存在的。 */
  own: Source[];
  /** 原来的文件里应当有而没有的那一份的路径（只有平台一级的会有）。 */
  missing: string | null;
  /** 提示词目录里代替它们的那一份；没有或不能用时是 null。 */
  override: Source | null;
  /** 提示词目录里那一份在而不能用时的原因。 */
  note: string | null;
  /** 这个位置看过的每份文件的路径与属性。 */
  stamps: unknown[];
}

/** 这一次有没有节点的出口要从流程的定义里取：会话的工作项是流程的工作项时有；空闲、工作项是单项活动时没有。 */
function wantsNodeExit(input: ComposeInput): boolean {
  return input.stage !== IDLE && (input.inFlow ?? true);
}

/** 某个阶段的几个位置。只查文件的属性，不读内容。 */
function slots(input: ComposeInput, io: PromptIo): Slot[] {
  const platformDir = input.platformDir ?? PLATFORM_STAGES_DIR;
  // 流程的定义：产品自带的在 agent/prompts/flows/；平台一级的目录换成别的时（测试），在那个目录的 flows/ 下。
  const flowPath = join(input.platformDir ? join(input.platformDir, FLOWS_SUBDIR) : PLATFORM_FLOWS_DIR, FLOW_INITIAL_FILE);
  const builtin = (part: PartKind, name: string): Source => {
    const path = join(platformDir, name);
    return { part, from: "builtin", file: relative(REPO_ROOT, path), path };
  };
  const inTask = (part: PartKind, path: string): Source => ({ part, from: "task", file: relative(resolve(input.workspaceDir), resolve(path)), path });
  const skills = taskSkills(input.skills);
  const wanted: [Slot["part"], boolean, Source[]][] = [
    ["system", true, [builtin("system", SYSTEM_FILE)]],
    ["platform_common", true, [builtin("platform_common", COMMON_FILE)]],
    ["task_common", false, skills.map((one) => inTask("task_common", one.filePath))],
    ["platform_stage", true, [builtin("platform_stage", stageFile(input.stage))]],
    ...(wantsNodeExit(input) ? [["node_exit", true, [{ part: "node_exit", from: "builtin", file: relative(REPO_ROOT, flowPath), path: flowPath }]] as [Slot["part"], boolean, Source[]]] : []),
    ["task_stage", false, skills.map((one) => inTask("task_stage", join(dirname(one.filePath), TASK_STAGES_SUBDIR, stageFile(input.stage))))],
  ];
  return wanted.map(([part, required, sources]) => {
    const stamps: unknown[] = [];
    const own: Source[] = [];
    let missing: string | null = null;
    for (const one of sources) {
      const stamp = io.stamp(one.path);
      stamps.push([one.path, stamp?.mtimeMs ?? null, stamp?.size ?? null]);
      if (stamp !== null) own.push(one);
      else if (required) missing ??= one.path;
    }
    let override: Source | null = null;
    let note: string | null = null;
    if (input.promptDir) {
      const name = promptDirName(part, input.stage);
      const path = join(input.promptDir, name);
      const state = io.plain(path);
      stamps.push([path, state.kind, state.kind === "file" ? state.mtimeMs : null, state.kind === "file" ? state.size : null]);
      if (state.kind === "file") override = { part, from: "prompt_dir", file: name, path };
      else if (state.kind === "refused") note = `提示词目录里的 ${name} 没有用上：${state.reason}。这一部分照旧用${own.length > 0 ? ORIGIN_NAMES[own[0].from] : "原来"}的。`;
    }
    return { part, required, own, missing, override, note, stamps };
  });
}

/** 照五个位置读文件、拼出系统提示。 */
function fromSlots(input: ComposeInput, all: readonly Slot[], io: PromptIo): StagePrompt {
  const parts: PromptPart[] = [];
  const notes: string[] = [];
  const idle = input.stage === IDLE;
  /** 一份文件的文字拼进去之前怎样取：任务 skill 去掉 frontmatter；节点的出口只取这个节点的那一节；空闲时见文件头。 */
  const shaped = (part: PartKind, text: string, path: string): string => {
    if (part === "task_common") return skillBody(text);
    // 活动的定义与流程的定义开头的头（lib/activity_def.ts）不进系统提示：只用正文。
    if (part === "platform_stage" || part === "node_exit") text = skillBody(text);
    if (part === "node_exit") {
      const section = nodeSection(text, input.stage as Stage);
      if (section === null) throw new Error(`流程的定义里没有「# ${nodeHeading(input.stage as Stage)}」这一节：${path}`);
      return section;
    }
    if (idle && part === "platform_stage") return `${IDLE_OPENING}\n\n${withoutOpening(withoutSection(text, EXIT_HEADING))}`;
    if (idle && part === "task_stage") return withoutSection(text, EXIT_HEADING);
    return text;
  };
  const add = (source: Pick<Source, "part" | "from"> & { file: string | null; path?: string }, text: string) => {
    const body = shaped(source.part, text, source.path ?? "").replace(/\s+$/, "");
    if (body) parts.push({ part: source.part, from: source.from, file: source.file, text: body });
  };
  for (const slot of all) {
    if (slot.note) notes.push(slot.note);
    if (slot.override) {
      const text = io.readStrict(slot.override.path);
      if (text !== null) {
        add(slot.override, text);
        continue;
      }
      notes.push(`提示词目录里的 ${slot.override.file} 没有用上：它不是合法的 UTF-8 文字。这一部分照旧用${slot.own.length > 0 ? ORIGIN_NAMES[slot.own[0].from] : "原来"}的。`);
    }
    if (slot.missing !== null) throw new Error(`拼系统提示要用的文件不在：${slot.missing}`);
    for (const one of slot.own) add(one, io.read(one.path));
    // 工作项是单项活动：活动的说明后面接固定的一段，代替节点的出口。
    if (slot.part === "platform_stage" && !idle && !(input.inFlow ?? true)) parts.push({ part: "node_exit", from: "builtin", file: null, text: STANDALONE_EXIT });
  }
  // 范围说明：接在按活动拼的几段的最后。
  if (!idle && input.scope?.trim()) parts.push({ part: "scope", from: "task", file: null, text: scopeSection(input.scope) });
  add({ part: "tail", from: "pi", file: null }, input.tail);
  return { stage: input.stage, text: parts.map((one) => one.text).join("\n\n"), parts, notes };
}

/**
 * 拼出某个阶段的系统提示。平台一级的三份文件（系统提示、共用部分、这个阶段的那一段）与任务在流程里时流程的定义，
 * 缺了任何一份而提示词目录里又没有代替它的，就抛错，调用方这时不换系统提示；任务类型一级的文件没有就跳过。
 */
export function composeStagePrompt(input: ComposeInput, io: PromptIo = NODE_IO): StagePrompt {
  return fromSlots(input, slots(input, io), io);
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

  get(input: ComposeInput): CachedPrompt {
    // 这一次的输入与各份文件的属性合成一把钥匙：与上一次相同就是没变。
    const all = slots(input, this.io);
    const key = JSON.stringify([input.stage, input.inFlow ?? true, input.scope ?? null, input.tail, input.promptDir ?? null, all.map((one) => one.stamps)]);
    if (this.last && this.last.key === key) return { prompt: this.last.prompt, how: "reused" };
    try {
      const prompt = fromSlots(input, all, this.io);
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
 * 这条会话现在在哪个阶段（或者空闲），只读：看的是这条会话属于的工作项。任务库不在、库里还没有任务、或者是早先建的任务
 * （没有「总体分析」集合）时返回 null：这些情形都不换系统提示。
 */
export function stageInWorkspace(workspaceDir: string, sessionId: string | null): Position | null {
  return whereInWorkspace(workspaceDir, sessionId)?.stage ?? null;
}

/**
 * 同上，另带这条会话的工作项是不是流程的工作项（空闲时为假），与用户启动它时写的范围说明（没有写、空闲时为 null）。
 * 不换系统提示的那几种情形返回 null。
 */
export function whereInWorkspace(workspaceDir: string, sessionId: string | null): { stage: Position; inFlow: boolean; scope: string | null } | null {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; definition_text: string } | undefined;
    if (!task) return null;
    const stage = stageOf(db, workspaceDir, task.task_id, validateDefinition(JSON.parse(task.definition_text)), sessionId);
    if (stage === null) return null;
    const open = openActivityRecord(db, task.task_id, sessionId);
    return { stage, inFlow: open !== null && open.flow !== null, scope: stage === IDLE ? null : open?.scope ?? null };
  } finally {
    db.close();
  }
}

// ───────────── 调试模式的提示词目录 ─────────────

/** 后端在调试模式下起 pi 时给的环境变量：值是产品设置文件的路径。与 backend/src/launch.ts 里的同名常量是一份约定。 */
export const ENV_DEBUG_SETTINGS = "TASKWRIGHT_DEBUG_SETTINGS_FILE";

export interface DebugPromptDir {
  /** 是不是调试模式：后端给了那个环境变量才是。 */
  debug: boolean;
  /** 设置里写的提示词目录（可以用时）；没有设、或者设的不是一个存在的目录时是 null。 */
  dir: string | null;
  /** 设了而不能用时的原因。 */
  note?: string;
}

/**
 * 这一次运行的提示词目录，每次运行开始时现读（读一个小的 JSON 文件），所以在设置里换了目录不用重启。
 * 不是调试模式时不读任何文件：设置文件里留着以前设的目录也不起作用。
 */
export function debugPromptDir(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): DebugPromptDir {
  const settings = (env[ENV_DEBUG_SETTINGS] ?? "").trim();
  if (!settings) return { debug: false, dir: null };
  let dir: unknown;
  try {
    dir = JSON.parse(readFileSync(settings, "utf-8"))?.debug?.prompt_dir;
  } catch {
    return { debug: true, dir: null };
  }
  if (typeof dir !== "string" || dir === "") return { debug: true, dir: null };
  if (!isAbsolute(dir)) return { debug: true, dir: null, note: `设置里的提示词目录不是绝对路径：${dir}。这次没有用它。` };
  try {
    if (statSync(dir).isDirectory()) return { debug: true, dir };
  } catch {
    // 不在：下面一并说明
  }
  return { debug: true, dir: null, note: `设置里的提示词目录不存在或者不是目录：${dir}。这次没有用它。` };
}
