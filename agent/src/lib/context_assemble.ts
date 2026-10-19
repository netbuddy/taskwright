/**
 * 有阶段的任务的系统提示怎样拼：按会话的三样输入选段、按固定的次序接起来。不碰 pi，挂到事件上的那一半在 hooks/stage_prompt.ts。
 *
 * 三样输入：活动的头（方式、读哪几类、写哪几类，lib/activity_def.ts）、获准能力表（这个位置助手能做哪几类写入，lib/stage.ts 的 allowedWrites）、
 * 会话的位置（工作流的工作项、单项活动的工作项、空闲）。拼出来的次序是：
 *   1 系统提示（agent/prompts/system.md）
 *   2 一段由程序生成的位置说明：本次会话在哪里、主要做什么、获准做什么（模板 stage_prompt.position）
 *   3 平台说明里 when 是 always 的模块，按次序号（agent/prompts/capabilities/，lib/prompt_modules.ts）
 *   4 平台说明里条件满足的模块，按次序号
 *   5 活动模板（agent/prompts/templates/<模板>.md，「现在这个阶段」；用哪一份看活动声明的 template）
 *   6 任务类型说明的共用部分（任务 skill 的 SKILL.md 正文）
 *   7 任务类型说明里这项活动的补充（任务 skill 目录下 activities/<活动>.md 声明之后的正文，没有就没有；工作流之外去掉收尾一节）
 *   8 工作流声明里这一步的提示（note.<活动标识符>，写了才有）。工作流里的转移（各步、上一步、下一步、分工表）由程序从声明推出来，
 *     填进第 4 步里 planning/flow_transitions 模块的占位；单项活动的收尾与空闲的规矩也是第 4 步里的模块
 *   9 用户启动工作项时写的说明（写了才有）
 *   10 pi 自己接在后面的那一截（工作目录等）
 *
 * 活动与工作流的声明从任务 skill 的目录读，任务目录里没有就回退读产品自带的（lib/activity_def_read.ts）；回退时这两部分的出处写产品自带。
 *
 * 空闲时没有活动：按算作澄清的那项活动的声明选模块，获准能力是空闲那一份；活动模板 idle.md 的头写着 based_on: clarifying，
 * 正文用澄清的模板去掉标题与开头那一段话、去掉「出口」一节；任务类型的补充同样用澄清的那一份去掉「出口」一节。
 *
 * 拼不成一律抛错（PromptAssemblyError），调用方停下这次运行，不沿用以前拼好的任何一份：平台说明缺了 REQUIRED_MODULES 里的模块、
 * 模块的头不对、重名、次序号相同、活动模板或系统提示的文件不在、任务类型里没有这条工作流、模块里有填不上的占位。
 *
 * 不是每次运行都重读重拼（ContextCache）：进程里记着上一次拼的那一份，与一把钥匙：各项输入、模块目录的指纹（文件清单与每份的修改时刻和大小）、
 * 别的几份文件的修改时刻和大小。钥匙没变就原样交回，变了才重读重拼；重拼出错时把错抛出去并忘掉上一份。
 *
 * 调试模式下另有一个「提示词目录」（debugPromptDir）：目录里有哪一份，就用那一份代替原来的，没有的照旧。认的文件名与产品自带的
 * 相对路径相同（system.md、capabilities/<能力>/<模块>.md、templates/<模板>.md），任务类型一级的是
 * task-type/common.md（SKILL.md 的正文）与 task-type/<活动>.md（这项活动的文件）。只能代替已有的，不能多出一份模块：
 * 代替的模块的头照样要合规（名字与次序号与原来的相同），否则拼不成。软链接不跟、超过 PROMPT_DIR_MAX_BYTES 的不读、
 * 不是合法 UTF-8 的不用，这几种情形照旧用原来的并在 notes 里写明原因。产品只读这个目录，不往里写。
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { type ActivityDef, ASSETS, type AssetKey, DefinitionHeadError, prerequisiteText, splitHead } from "./activity_def.ts";
import { assetNamesOf } from "./asset_names.ts";
import { ACTIVITIES_SUBDIR, type Definitions, definitionsFor } from "./activity_def_read.ts";
import { databasePath } from "./db.ts";
import { validateDefinition } from "./definition.ts";
import {
  type PromptModule, PromptAssemblyError, type SessionKind, type Situation, WRITE_KINDS, loadModules, modulesStamp, parseModule, requireModules, selectModules,
} from "./prompt_modules.ts";
import { BUSY_TIMEOUT_MS } from "./schema.ts";
import { FLOW_ANALYSIS, FLOW_NAMES, IDLE, type Position, STAGES, STAGE_NAMES, type Stage, type WriteKind, allowedWrites, gateStage, isStage } from "./stage.ts";
import { openActivityRecord, stageOf } from "./stage_read.ts";
import { fillText } from "./texts.ts";

export { PromptAssemblyError } from "./prompt_modules.ts";

/** 产品自带的提示词目录 agent/prompts/。 */
export const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");
/** 写进 PromptPart.file 的产品自带文件的路径相对它：代码仓根目录。 */
const REPO_ROOT = resolve(PROMPTS_DIR, "..", "..");

/** 几个子目录与文件，相对提示词目录（也是调试模式的提示词目录里认的文件名）。 */
export const SYSTEM_FILE = "system.md";
export const CAPABILITIES_SUBDIR = "capabilities";
export const TEMPLATES_SUBDIR = "templates";
/** 缺省的工作流：会话的工作项是工作流的工作项而没有说是哪一条时，按需求分析。 */
export const DEFAULT_FLOW = FLOW_ANALYSIS;
/** 空闲时用的活动模板。 */
export const IDLE_TEMPLATE = "idle";
/** 调试模式的提示词目录里放任务类型一级的文件的子目录，与其中 SKILL.md 正文的那一份的名字。 */
export const PROMPT_DIR_TASK_SUBDIR = "task-type";
export const PROMPT_DIR_TASK_COMMON = "common.md";

/**
 * 平台说明必须有的模块：缺了任何一个就拼不成（哪怕这次会话用不着它），免得删掉或改错名字的模块悄悄地不进系统提示。
 */
export const REQUIRED_MODULES = [
  "system_message", "task_definition", "tools_general", "sources", "three_facts", "work_items",
  "materials", "knowledge", "batches", "reply_full", "reply_brief", "reply_confirm", "understanding_full", "understanding_brief",
  "review", "confirm_publish", "pages_full", "pages_brief", "problems", "items_full", "items_brief", "diagrams_full", "diagrams_brief",
  "stage_cards", "retell", "flow_transitions", "standalone_exit", "idle_rules",
] as const;

/** 讲怎样离开这一段的那一节的标题：空闲时拼的文字里不带它。 */
export const EXIT_HEADING = "出口";

/** 去掉一份活动说明开头的标题与那一段话：从第一个二级小节起；一个二级小节都没有时原样返回。 */
export function withoutOpening(text: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => /^##\s+/.test(line));
  return first < 0 ? text : lines.slice(first).join("\n");
}

/** 去掉一份 Markdown 文字里标题是 heading 的二级小节（含其中更深的标题），到下一个一级或二级标题之前。没有这一节时原样返回。 */
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

/** 用户启动工作项时写了启动时写的说明：这个工作项的各条会话的系统提示里接这一段。 */
export function scopeSection(scope: string): string {
  return fillText("stage_prompt.scope", { scope: scope.trim() });
}

/** 去掉开头两行 --- 之间的头，留下正文（SKILL.md 的 frontmatter、活动与模板的头都这样去掉）。 */
export function skillBody(text: string): string {
  return splitHead(text).body.replace(/^\n+/, "");
}

/** 内容的摘要值：SHA-256 取前 16 位十六进制，与后端启动记录里文件的摘要值是同一种算法。 */
export function digestOf(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex").slice(0, 16);
}

// ───────────── 活动模板 ─────────────

/** 一份活动模板的头：模板的键、这个模板允许的写入（获准能力的上限）、沿用哪一份模板的正文（空闲用）。 */
export interface TemplateHead {
  template: string;
  writesAllowed: WriteKind[];
  basedOn: string | null;
}

/** 读一份活动模板。file 是报错时说的文件名。 */
export function parseTemplate(text: string, file: string): { head: TemplateHead; body: string } {
  const { head, body } = splitHead(text);
  if (head === null) throw new PromptAssemblyError(`${file} 开头没有头（两行 --- 之间的那一段）。`);
  const template = head.template ?? "";
  if (!template) throw new PromptAssemblyError(`${file} 的头里缺「template」一栏。`);
  const writes = (head.writes_allowed ?? "").split(/[,，]/).map((one) => one.trim()).filter(Boolean);
  for (const one of writes) {
    if (!(WRITE_KINDS as readonly string[]).includes(one)) throw new PromptAssemblyError(`${file} 的头里「writes_allowed」写了「${one}」，只能是 ${WRITE_KINDS.join("、")} 里的。`);
  }
  const known = new Set(["template", "writes_allowed", "based_on"]);
  const extra = Object.keys(head).filter((key) => !known.has(key));
  if (extra.length > 0) throw new PromptAssemblyError(`${file} 的头里有不认的栏：${extra.join("、")}。`);
  return { head: { template, writesAllowed: writes as WriteKind[], basedOn: head.based_on || null }, body: body.replace(/^\n+/, "").replace(/\s+$/, "") };
}

// ───────────── 拼出来的东西 ─────────────

/** 拼进系统提示的一部分是什么。 */
export type PartKind = "system" | "position" | "module" | "template" | "task_common" | "task_activity" | "flow_note" | "scope" | "tail";

/** 每一部分给人看的名字。 */
export const PART_NAMES: Record<PartKind, string> = {
  system: "系统提示",
  position: "本次会话的位置说明",
  module: "平台说明的一个模块",
  template: "活动模板",
  task_common: "任务类型说明的共用部分",
  task_activity: "任务类型说明里这项活动的补充",
  flow_note: "工作流声明里这一步的提示",
  scope: "本次范围说明",
  tail: "助手程序接在后面的工作目录等",
};

/** 一部分的文字出自哪里：产品自带的文件、任务目录里的文件、调试模式的提示词目录里的文件、程序生成的、助手程序（pi）自己。 */
export type PartOrigin = "builtin" | "task" | "prompt_dir" | "generated" | "pi";

export const ORIGIN_NAMES: Record<PartOrigin, string> = { builtin: "产品自带", task: "任务目录", prompt_dir: "提示词目录", generated: "程序生成", pi: "助手程序" };

export interface PromptPart {
  part: PartKind;
  from: PartOrigin;
  /** 文件的路径：产品自带的相对代码仓根目录，任务目录里的相对任务目录，提示词目录里的相对那个目录；不是文件的为 null。 */
  file: string | null;
  /** 模块的名字；别的部分没有。 */
  module?: string;
  text: string;
}

export interface StagePrompt {
  /** 这一份是为哪个位置拼的：六个阶段之一，或者 idle。 */
  stage: Position;
  /** 整份文字：各部分去掉末尾的空白之后用一个空行隔开。 */
  text: string;
  parts: PromptPart[];
  /** 提示词目录里有而没有用上的文件，各一句原因；没有时是空的。 */
  notes: string[];
}

/** pi 加载的一个 skill：名字与它的 SKILL.md 在哪里。 */
export interface LoadedSkill {
  name: string;
  filePath: string;
}

/** 一份文件的修改时刻与大小。 */
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
  stamp(path: string): FileStamp | null;
  read(path: string): string;
  plain(path: string): PlainState;
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

/** pi 接在启动参数给的系统提示后面的那一截，去掉 skill 清单。 */
export function piTail(current: string, custom: string): string {
  const withoutSkills = current.replace(/<skills>[\s\S]*?<\/skills>/, "");
  if (custom && current.startsWith(custom)) return withoutSkills.slice(custom.length).replace(/\n{3,}/g, "\n\n").trim();
  return /<cwd>[\s\S]*?<\/cwd>/.exec(withoutSkills)?.[0] ?? "";
}

// ───────────── 拼 ─────────────

export interface ComposeInput {
  /** 会话在哪个阶段；空闲时是 idle。 */
  stage: Position;
  /** 会话的工作项是不是工作流的工作项；不给当作是。空闲时不看它。 */
  inFlow?: boolean;
  /** 启动时写的说明；没有写不给或者给 null。空闲时不看它。 */
  scope?: string | null;
  /** 任务目录。 */
  workspaceDir: string;
  /** pi 加载的全部 skill（只有任务目录里任务类型的那一份）。 */
  skills: readonly LoadedSkill[];
  /** pi 接在后面的那一截（piTail 的结果）。 */
  tail: string;
  /** 平台一级的提示词目录；缺省是产品自带的 agent/prompts/，测试里换成别的。 */
  platformDir?: string;
  /** 调试模式的提示词目录（绝对路径）；不给或为 null 时不看。 */
  promptDir?: string | null;
  /** 会话的工作项是工作流的工作项时，是哪一条工作流（标识符）；不给按 DEFAULT_FLOW。 */
  flow?: string | null;
  /** 会话的工作项做的是哪一项活动（活动记录里的键）；不给时按算作这个阶段的那一项活动。空闲时不看它。 */
  activity?: string | null;
  /** 这个任务类型的活动与工作流的声明；缺省从任务 skill 的目录读（lib/activity_def_read.ts，没有就回退读产品自带的）。 */
  definitions?: Definitions;
  /** 任务定义的资产显示名；不给时按 lib/asset_names.ts 的回退（产品自带的任务定义）。 */
  assetNames?: Readonly<Record<AssetKey, string>>;
}

/** 这次拼用的资产显示名。 */
const assetNamesFor = (input: ComposeInput): Readonly<Record<AssetKey, string>> => input.assetNames ?? assetNamesOf(null);

/** 这次拼要用的活动与工作流的声明。没有任务 skill 时拼不成。 */
function definitionsOf(input: ComposeInput): Definitions {
  if (input.definitions) return input.definitions;
  const skill = input.skills[0];
  if (!skill) throw new PromptAssemblyError("任务目录里没有任务类型的 skill，读不到活动的定义。");
  try {
    return definitionsFor(input.workspaceDir, relative(resolve(input.workspaceDir), resolve(skill.filePath)));
  } catch (error) {
    if (error instanceof DefinitionHeadError) throw new PromptAssemblyError(error.message);
    throw error;
  }
}

/** 会话的位置是三种里的哪一种。 */
function sessionKind(input: ComposeInput): SessionKind {
  if (input.stage === IDLE) return "idle";
  return input.inFlow ?? true ? "flow" : "single";
}

/**
 * 这次会话按哪项活动的声明选段：先按工作项的活动键在声明里找；找不到而这个键正好是阶段的键时（既有任务的记录），
 * 或者没有给活动键时，按算作这个阶段的第一项活动；空闲时是算作澄清的第一项活动。
 */
function activityOf(input: ComposeInput): ActivityDef {
  const all = definitionsOf(input).activities;
  if (input.stage !== IDLE && input.activity) {
    const byKey = all.find((one) => one.key === input.activity);
    if (byKey) return byKey;
    if (!isStage(input.activity)) throw new PromptAssemblyError(`活动记录里的「${input.activity}」在任务类型的活动声明里找不到，也不是阶段的键。`);
  }
  const stage = gateStage(input.stage);
  const found = all.find((one) => one.stage === stage);
  if (!found) throw new PromptAssemblyError(`没有算作「${stage}」这个阶段的活动。`);
  return found;
}

/** 这次会话的三样输入合成的 Situation。 */
export function situationOf(input: ComposeInput, activity: ActivityDef = activityOf(input)): Situation {
  if (activity.mode === "user_only") throw new PromptAssemblyError(`「${activity.name}」只能由用户发起，不是工作阶段，没有系统提示。`);
  return { mode: activity.mode, reads: activity.reads, writes: activity.writes, allowed: allowedWrites(input.stage), session: sessionKind(input) };
}

/** 位置说明的「在哪里」那半句。 */
function whereText(input: ComposeInput, kind: SessionKind): string {
  if (kind === "idle") return fillText("stage_prompt.where_idle");
  const name = activityOf(input).name;
  const flowKey = input.flow ?? DEFAULT_FLOW;
  const flow = definitionsOf(input).flows.find((one) => one.key === flowKey)?.name ?? FLOW_NAMES[flowKey] ?? flowKey;
  return kind === "flow" ? fillText("stage_prompt.where_flow", { flow, node: name }) : fillText("stage_prompt.where_single", { activity: name });
}

/** 位置说明里每一类获准写入的说法。 */
const CAN_TEXT: Record<WriteKind, string> = {
  page: fillText("stage_prompt.can_page"),
  problem: fillText("stage_prompt.can_problem"),
  diagram: fillText("stage_prompt.can_diagram"),
  item: fillText("stage_prompt.can_item"),
  review: fillText("stage_prompt.can_review"),
  publish: fillText("stage_prompt.can_publish"),
};

/** 程序生成的那一段位置说明。 */
export function positionText(input: ComposeInput, activity: ActivityDef, at: Situation): string {
  const main = at.session === "idle" ? fillText("stage_prompt.main_idle") : activity.writes.map((one) => assetNamesFor(input)[one]).join("、");
  const allowed = at.allowed.map((one) => CAN_TEXT[one]).join("、");
  return fillText("stage_prompt.position", { where: whereText(input, at.session), main, allowed });
}

/** 平台一级的几份文件的绝对路径。 */
function platformPaths(input: ComposeInput) {
  const dir = input.platformDir ?? PROMPTS_DIR;
  return {
    dir,
    system: join(dir, SYSTEM_FILE),
    capabilities: join(dir, CAPABILITIES_SUBDIR),
    template: (key: string) => join(dir, TEMPLATES_SUBDIR, `${key}.md`),
  };
}

/** 产品自带的文件写进 file 的路径：在代码仓里的相对代码仓根目录，测试里换了平台目录的相对那个目录。 */
function builtinName(input: ComposeInput, path: string): string {
  return relative(input.platformDir ? input.platformDir : REPO_ROOT, path);
}

/** 拼的时候要读的一份文件：原来的路径，与提示词目录里代替它的那一份的名字。 */
interface Wanted {
  part: PartKind;
  from: "builtin" | "task";
  path: string;
  file: string;
  /** 调试模式的提示词目录里代替它的文件名。 */
  override: string;
  /** 这份文件不在时：required 抛错，否则跳过。 */
  required: boolean;
}

/** 这一次打算读的文件（不含模块，模块整个目录一起看），按拼接的先后。只看路径，不读内容。 */
function wantedFiles(input: ComposeInput, activity: ActivityDef, template: string): Wanted[] {
  const p = platformPaths(input);
  const key = activity.key;
  const inTask = (path: string) => relative(resolve(input.workspaceDir), resolve(path));
  const out: Wanted[] = [
    { part: "system", from: "builtin", path: p.system, file: builtinName(input, p.system), override: SYSTEM_FILE, required: true },
    { part: "template", from: "builtin", path: p.template(template), file: builtinName(input, p.template(template)), override: `${TEMPLATES_SUBDIR}/${template}.md`, required: true },
  ];
  for (const skill of input.skills) {
    out.push({ part: "task_common", from: "task", path: skill.filePath, file: inTask(skill.filePath), override: `${PROMPT_DIR_TASK_SUBDIR}/${PROMPT_DIR_TASK_COMMON}`, required: false });
  }
  // 活动与工作流的文件在任务 skill 的目录里；回退读产品自带的那一份时，出处写产品自带、路径相对代码仓根目录。
  const defs = definitionsOf(input);
  const typeFile = (path: string) => (defs.fallback ? { from: "builtin" as const, file: relative(REPO_ROOT, path) } : { from: "task" as const, file: inTask(path) });
  const path = join(defs.dir, ACTIVITIES_SUBDIR, `${key}.md`);
  out.push({ part: "task_activity", ...typeFile(path), path, override: `${PROMPT_DIR_TASK_SUBDIR}/${key}.md`, required: false });
  return out;
}

/** 一份文件读出来的文字，与它出自哪里；提示词目录里那一份不能用时的原因进 notes。不在而不是 required 时返回 null。 */
function readWanted(one: Wanted, input: ComposeInput, io: PromptIo, notes: string[]): { text: string; from: PartOrigin; file: string } | null {
  if (input.promptDir) {
    const path = join(input.promptDir, one.override);
    const state = io.plain(path);
    if (state.kind === "file") {
      const text = io.readStrict(path);
      if (text !== null) return { text, from: "prompt_dir", file: one.override };
      notes.push(`提示词目录里的 ${one.override} 没有用上：它不是合法的 UTF-8 文字。这一部分照旧用原来的。`);
    } else if (state.kind === "refused") {
      notes.push(`提示词目录里的 ${one.override} 没有用上：${state.reason}。这一部分照旧用原来的。`);
    }
  }
  if (io.stamp(one.path) === null) {
    if (one.required) throw new PromptAssemblyError(`拼系统提示要用的文件不在：${one.path}`);
    return null;
  }
  return { text: io.read(one.path), from: one.from, file: one.file };
}

/** 读模块目录：产品自带的，再用提示词目录里同名路径的文件代替。 */
function readModules(input: ComposeInput, io: PromptIo, notes: string[]): { modules: PromptModule[]; overridden: Set<string> } {
  const modules = loadModules(platformPaths(input).capabilities);
  const overridden = new Set<string>();
  if (!input.promptDir) return { modules, overridden };
  const replaced = modules.map((one) => {
    const name = `${CAPABILITIES_SUBDIR}/${one.file}`;
    const path = join(input.promptDir!, name);
    const state = io.plain(path);
    if (state.kind === "refused") notes.push(`提示词目录里的 ${name} 没有用上：${state.reason}。这一部分照旧用原来的。`);
    if (state.kind !== "file") return one;
    const text = io.readStrict(path);
    if (text === null) {
      notes.push(`提示词目录里的 ${name} 没有用上：它不是合法的 UTF-8 文字。这一部分照旧用原来的。`);
      return one;
    }
    const got = parseModule(text, one.capability, one.file);
    if (got.name !== one.name || got.order !== one.order) {
      throw new PromptAssemblyError(`提示词目录里的 ${name} 的名字或次序号与产品自带的那一份不同（${got.name}、${got.order}；原来是 ${one.name}、${one.order}）：只能代替，不能改名或换次序。`);
    }
    overridden.add(one.name);
    return got;
  });
  return { modules: replaced, overridden };
}

/** 活动补充里讲这一步怎样收尾的那一节的标题：在工作流之外（单项活动、空闲）去掉。 */
export const ENDING_HEADING = "这一步怎样收尾";

/** 这次会话所在的工作流的声明；任务类型里没有这条工作流就拼不成。 */
function currentFlow(input: ComposeInput) {
  const flowKey = input.flow ?? DEFAULT_FLOW;
  const found = definitionsOf(input).flows.find((one) => one.key === flowKey);
  if (!found) throw new PromptAssemblyError(`任务类型里没有「${flowKey}」这条工作流的声明。`);
  return found;
}

/**
 * 工作流里的转移由程序从声明推出来，填进模块里的占位：flow 工作流的名字、steps 各步、here 现在这一步、prev 上一步的那半句、
 * next 下一步的那一句（下一步只能由用户发起时只说条件，不发卡片）、division 分工表（每类资产由哪几步负责，按各活动声明的 writes）。
 */
export function flowSlots(input: ComposeInput, activity: ActivityDef): Record<string, string> {
  const defs = definitionsOf(input);
  const flow = currentFlow(input);
  const steps = flow.steps.map((key) => defs.activities.find((one) => one.key === key)!);
  const at = steps.findIndex((one) => one.key === activity.key);
  if (at < 0) throw new PromptAssemblyError(`活动「${activity.name}」不在工作流「${flow.name}」的各步里。`);
  const prev = steps[at - 1], next = steps[at + 1];
  const nextText = !next ? fillText("stage_prompt.flow_last")
    : next.mode === "user_only" ? fillText("stage_prompt.flow_next_user_only", { name: next.name, requires: prerequisiteText(next.requires).replace(/。$/, "") })
      : fillText("stage_prompt.flow_next", { name: next.name });
  const division = ASSETS.map((asset) => {
    const owners = steps.filter((one) => one.writes.includes(asset)).map((one) => one.name);
    return owners.length === 0 ? null : fillText("stage_prompt.division_line", { asset: assetNamesFor(input)[asset], steps: owners.join("、") });
  }).filter((one): one is string => one !== null).join("\n");
  return {
    flow: flow.name, steps: steps.map((one) => one.name).join("、"), here: activity.name,
    prev: prev ? fillText("stage_prompt.flow_prev", { name: prev.name }) : fillText("stage_prompt.flow_first"), next: nextText, division,
  };
}

/** 把一个模块正文里的 {{名字}} 换成 slots 里的值；正文里有占位而这次没有可填的值（不在工作流里、或者名字不认）就拼不成。 */
function fillSlots(module: PromptModule, slots: Record<string, string> | null): string {
  return module.body.replace(/\{\{([a-z_]+)\}\}/g, (_whole, name: string) => {
    const value = slots?.[name];
    if (value === undefined) throw new PromptAssemblyError(`模块 ${module.file} 里的占位「{{${name}}}」这次没有可填的值。`);
    return value;
  });
}

/** 拼出这次会话的系统提示。拼不成就抛 PromptAssemblyError。 */
export function composeContext(input: ComposeInput, io: PromptIo = NODE_IO): StagePrompt {
  const activity = activityOf(input);
  const at = situationOf(input, activity);
  const notes: string[] = [];
  const parts: PromptPart[] = [];
  const add = (part: PromptPart) => {
    const text = part.text.replace(/\s+$/, "");
    if (text) parts.push({ ...part, text });
  };
  const templateKey = at.session === "idle" ? IDLE_TEMPLATE : activity.template!;
  const files = wantedFiles(input, activity, templateKey);
  const byPart = (part: PartKind) => files.filter((one) => one.part === part);

  // 1 系统提示
  const system = readWanted(byPart("system")[0], input, io, notes)!;
  add({ part: "system", from: system.from, file: system.file, text: system.text });
  // 2 位置说明
  add({ part: "position", from: "generated", file: null, text: positionText(input, activity, at) });
  // 3、4 模块
  const { modules, overridden: replaced } = readModules(input, io, notes);
  requireModules(modules, REQUIRED_MODULES);
  const slots = at.session === "flow" ? flowSlots(input, activity) : null;
  for (const one of selectModules(modules, at)) {
    const overridden = replaced.has(one.name);
    const file = overridden ? `${CAPABILITIES_SUBDIR}/${one.file}` : builtinName(input, join(platformPaths(input).capabilities, one.file));
    add({ part: "module", from: overridden ? "prompt_dir" : "builtin", file, module: one.name, text: fillSlots(one, slots) });
  }
  // 5 活动模板
  const templateFile = readWanted(byPart("template")[0], input, io, notes)!;
  const template = parseTemplate(templateFile.text, templateFile.file);
  if (template.head.template !== templateKey) throw new PromptAssemblyError(`${templateFile.file} 的头里「template」写的是「${template.head.template}」，应当是「${templateKey}」。`);
  let templateText = template.body;
  if (template.head.basedOn) {
    const base = readWanted({ ...byPart("template")[0], path: platformPaths(input).template(template.head.basedOn),
      file: builtinName(input, platformPaths(input).template(template.head.basedOn)), override: `${TEMPLATES_SUBDIR}/${template.head.basedOn}.md` }, input, io, notes)!;
    const basedOn = parseTemplate(base.text, base.file);
    templateText = withoutOpening(withoutSection(basedOn.body, EXIT_HEADING));
  }
  add({ part: "template", from: templateFile.from, file: templateFile.file, text: templateText });
  // 6 任务类型的共用部分
  for (const one of byPart("task_common")) {
    const got = readWanted(one, input, io, notes);
    if (got) add({ part: "task_common", from: got.from, file: got.file, text: skillBody(got.text) });
  }
  // 7 任务类型的活动补充：在工作流之外（单项活动、空闲）去掉「出口」与收尾一节，那两节说的是工作流里怎样提议下一步。
  for (const one of byPart("task_activity")) {
    const got = readWanted(one, input, io, notes);
    if (!got) continue;
    const body = skillBody(got.text);
    add({ part: "task_activity", from: got.from, file: got.file, text: at.session === "flow" ? body : withoutSection(withoutSection(body, EXIT_HEADING), ENDING_HEADING) });
  }
  // 8 工作流声明里这一步的提示（note.<活动标识符>），写了才有。
  if (at.session === "flow") {
    const note = currentFlow(input).notes[activity.key];
    if (note) add({ part: "flow_note", from: definitionsOf(input).fallback ? "builtin" : "task", file: null, text: note });
  }
  // 9 启动时写的说明
  if (at.session !== "idle" && input.scope?.trim()) add({ part: "scope", from: "task", file: null, text: scopeSection(input.scope) });
  // 10 pi 接的那一截
  add({ part: "tail", from: "pi", file: null, text: input.tail });
  return { stage: input.stage, text: parts.map((one) => one.text).join("\n\n"), parts, notes };
}

// ───────────── 缓存 ─────────────

/** 这一次拿到的系统提示是怎样来的：重读重拼的、沿用上一份的。 */
export type ComposeHow = "recomposed" | "reused";
export const HOW_NAMES: Record<ComposeHow, string> = { recomposed: "重拼", reused: "沿用" };

export interface CachedPrompt {
  prompt: StagePrompt;
  how: ComposeHow;
}

/** 这次输入要看的全部文件的属性，合成钥匙的一部分。只查属性，不读内容。 */
function stampsOf(input: ComposeInput, io: PromptIo): unknown[] {
  const activity = activityOf(input);
  const templateKey = sessionKind(input) === "idle" ? IDLE_TEMPLATE : activity.template!;
  const p = platformPaths(input);
  const paths = [...wantedFiles(input, activity, templateKey).map((one) => one.path), p.template(activity.template!)];
  const out: unknown[] = paths.map((path) => [path, io.stamp(path)]);
  out.push(["modules", modulesStamp(p.capabilities)]);
  if (input.promptDir) {
    const names = [...wantedFiles(input, activity, templateKey).map((one) => one.override), `${TEMPLATES_SUBDIR}/${activity.template!}.md`];
    out.push(["prompt_dir_modules", modulesStamp(join(input.promptDir, CAPABILITIES_SUBDIR))]);
    for (const name of names) out.push([name, io.plain(join(input.promptDir, name))]);
  }
  return out;
}

/**
 * 记着上一次拼的那一份。每次要系统提示时只看输入与各份文件的属性变没变：没变就把上一份原样交回（不读任何文件的内容），
 * 变了才重读重拼。重拼出错时把错抛给调用方并忘掉上一份：不沿用，下一次照样重读重拼。一个 pi 进程（一条任务的会话）用一个实例。
 */
export class ContextCache {
  private last: { key: string; prompt: StagePrompt } | null = null;
  private readonly io: PromptIo;

  constructor(io: PromptIo = NODE_IO) {
    this.io = io;
  }

  get(input: ComposeInput): CachedPrompt {
    let key: string;
    try {
      key = JSON.stringify([input.stage, input.inFlow ?? true, input.flow ?? null, input.activity ?? null, input.assetNames ?? null, input.scope ?? null, input.tail, input.promptDir ?? null, input.workspaceDir,
        input.skills.map((one) => one.filePath), stampsOf(input, this.io), definitionsOf(input)]);
    } catch (error) {
      this.last = null;
      throw error;
    }
    if (this.last && this.last.key === key) return { prompt: this.last.prompt, how: "reused" };
    this.last = null;
    const prompt = composeContext(input, this.io);
    this.last = { key, prompt };
    return { prompt, how: "recomposed" };
  }
}

/** 一部分的几样事实，不带文字：报给后端、记进归档用。 */
export interface PartFact {
  part: PartKind;
  from: PartOrigin;
  file: string | null;
  module?: string;
  bytes: number;
  lines: number;
  digest: string;
}

export function partFact(one: PromptPart): PartFact {
  return { part: one.part, from: one.from, file: one.file, ...(one.module ? { module: one.module } : {}),
    bytes: Buffer.byteLength(one.text, "utf-8"), lines: one.text.split("\n").length, digest: digestOf(one.text) };
}

// ───────────── 会话在哪里 ─────────────

/**
 * 这条会话现在在哪个阶段（或者空闲），这条会话的工作项是不是工作流的工作项、是哪一条工作流、做的是哪一项活动（活动记录里的键；空闲时没有），
 * 与用户启动它时写的说明。只读。
 * 任务库不在、库里还没有任务、或者是早先建的任务（没有「业务说明」集合）时返回 null：这些情形都不换系统提示。
 *
 * 活动记录里记的是活动的标识符：经这个任务类型的活动声明换成它算作的阶段（stage 一栏）。声明里找不到这个标识符、而它正好是
 * 六个阶段的键之一时，按那个阶段办（既有任务的记录就是这样，活动的标识符与阶段的键相同）；既找不到又不是阶段的键，或者活动的
 * 声明读不出来，就抛 PromptAssemblyError，这次运行停下。
 */
export function whereInWorkspace(workspaceDir: string, sessionId: string | null): { stage: Position; inFlow: boolean; flow: string | null; scope: string | null; activity?: string;
  assetNames?: Record<AssetKey, string> } | null {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; definition_text: string } | undefined;
    if (!task) return null;
    const definition = validateDefinition(JSON.parse(task.definition_text));
    const recorded = stageOf(db, workspaceDir, task.task_id, definition, sessionId) as string | null;
    if (recorded === null) return null;
    const open = openActivityRecord(db, task.task_id, sessionId);
    if (recorded === IDLE) return { stage: IDLE, inFlow: false, flow: null, scope: null };
    return { stage: positionOfActivity(workspaceDir, definition.skillPath, recorded), inFlow: open !== null && open.flow !== null, flow: open?.flow ?? null,
      scope: open?.scope ?? null, activity: recorded, assetNames: assetNamesOf(definition) };
  } finally {
    db.close();
  }
}

/** 活动记录里的一个标识符算作哪个阶段（见 whereInWorkspace）。 */
export function positionOfActivity(workspaceDir: string, skillPath: string, key: string): Stage {
  let found: ActivityDef | undefined;
  try {
    found = definitionsFor(workspaceDir, skillPath).activities.find((one) => one.key === key);
  } catch (error) {
    if (error instanceof DefinitionHeadError) throw new PromptAssemblyError(error.message);
    throw error;
  }
  if (found?.stage) return found.stage;
  if (!found && isStage(key)) return key;
  throw new PromptAssemblyError(found ? `活动「${found.name}」只能由用户发起，会话不会在它里面。` : `活动记录里的「${key}」在任务类型的活动声明里找不到，也不是阶段的键。`);
}

/** 同上，只要位置。 */
export function stageInWorkspace(workspaceDir: string, sessionId: string | null): Position | null {
  return whereInWorkspace(workspaceDir, sessionId)?.stage ?? null;
}

// ───────────── 调试模式的提示词目录 ─────────────

/** 调试模式的提示词目录里认的全部文件名：产品自带的系统提示、每个模块、每份活动模板与工作流的定义，加上任务类型一级的几份。 */
export function promptDirNames(platformDir: string = PROMPTS_DIR): string[] {
  const modules = loadModules(join(platformDir, CAPABILITIES_SUBDIR)).map((one) => `${CAPABILITIES_SUBDIR}/${one.file}`);
  const templates = [...STAGES, IDLE_TEMPLATE].map((key) => `${TEMPLATES_SUBDIR}/${key}.md`);
  return [SYSTEM_FILE, ...modules, ...templates,
    `${PROMPT_DIR_TASK_SUBDIR}/${PROMPT_DIR_TASK_COMMON}`, ...STAGES.map((one) => `${PROMPT_DIR_TASK_SUBDIR}/${one}.md`)];
}

/** 后端在调试模式下起 pi 时给的环境变量：值是产品设置文件的路径。与 backend/src/launch.ts 里的同名常量是一份约定。 */
export const ENV_DEBUG_SETTINGS = "TASKWRIGHT_DEBUG_SETTINGS_FILE";

export interface DebugPromptDir {
  debug: boolean;
  dir: string | null;
  note?: string;
}

/** 这一次运行的提示词目录，每次运行开始时现读。不是调试模式时不读任何文件。 */
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
