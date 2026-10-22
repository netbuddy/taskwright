/**
 * 活动的声明与流程的声明：写法、取值与校验。不读文件、不读库（读文件的在 lib/activity_def_read.ts）。
 *
 * 活动与流程都由任务类型给出，放在任务 skill 的目录下：activities/<标识符>.md 一项活动一份，flows/<标识符>.md 一条流程一份。
 * 文件开头两行 --- 之间是声明，一行一栏，写成「名字: 值」，与 SKILL.md 的写法相同；活动的声明之后是这类任务在这项活动里另外要做的事
 * （拼系统提示时接在活动模板与流程的出口后面）。标识符取自文件名，声明里不再写一遍。
 *
 * 活动的声明：name、mode、purpose、reads、writes、requires、example，另有 template（用平台的哪一份活动模板，agent/prompts/templates/）
 * 与 stage（过渡期的兼容栏：这项活动算作六个阶段里的哪一个；会话的位置、获准能力表、进度条都还按阶段算）。只能由用户发起的活动
 * （发布）没有模板也没有阶段，两栏都写空。
 * 流程的声明：flow 之外是 name、purpose、applies、steps（各步的活动标识符，按先后，用逗号隔开）、inputs、requires、example，
 * 另可以写 note.<活动标识符>：这一步的一句提示。同一项活动在一条流程里只能出现一次。
 * 另可以写 slot.<槽位键>：输入页上一个有名字、带 role 的上传位或填写位，一行一个，值写成
 * 「name=<名称>; accepts=materials|text; required=true|false; role=<名称>」，四项顺序固定；只有 accepts=text 的槽位 role 空着或省略。
 *
 * 需求资产分六类（ASSETS）。活动声明写它读哪几类、写哪几类：能不能启动只看要读的几类里有没有东西，
 * 与之前做没做过哪一项活动无关。「读」一栏另认两个写法：knowledge（知识库）与 all（全部资产）。
 * 前置条件（requires）是数据条件的键（CONDITIONS），一个都没有就是无前置条件。
 *
 * 活动的正文可以分段（声明里写 segments）：正文里一行「<!-- segment: 时机 -->」起一段，到下一个这样的行或者正文末尾止；
 * 第一个标记之前的是常驻段，进系统提示。时机只认 SEGMENT_TIMINGS：after_save 附在这条会话第一次保存修订做成的结果后面，
 * after_reply 附在第一次回复做成的结果后面（lib/activity_segments.ts）。声明里写的时机与正文里的标记要一一对上。
 * 没有写 segments 的活动正文整段常驻，与以前一样。
 */

import { ASSETS, type AssetKey } from "./assets.ts";
import { STAGES, STAGE_NAMES, type Stage, WRITE_KINDS, type WriteKind } from "./stage.ts";

export { ASSETS, type AssetKey };

/** 「读」一栏在六类资产之外另认的两个写法。 */
export const READ_KNOWLEDGE = "knowledge";
export const READ_ALL = "all";
export type ReadKey = AssetKey | typeof READ_KNOWLEDGE | typeof READ_ALL;
/** 「读」一栏各个写法给人看的名字：六类资产照任务定义的资产显示名，另两个是固定的。 */
export const readName = (key: ReadKey, assetNames: Readonly<Record<AssetKey, string>>): string =>
  key === READ_KNOWLEDGE ? "知识库" : key === READ_ALL ? "全部资产" : assetNames[key];

/** 发布这项活动的键：它不是工作阶段，只能由用户发起。 */
export const PUBLISH = "publish";
/** 全部活动：六个工作阶段加发布。 */
export const ACTIVITIES = [...STAGES, PUBLISH] as const;
export type ActivityKey = Stage | typeof PUBLISH;
export const ACTIVITY_NAMES: Record<ActivityKey, string> = { ...STAGE_NAMES, [PUBLISH]: "发布" };

/** 一项活动的方式：助手一口气做完再汇报、与用户一件一件说、只能由用户发起。 */
export const MODES = ["batch", "dialogue", "user_only"] as const;
export type Mode = (typeof MODES)[number];
export const MODE_NAMES: Record<Mode, string> = { batch: "批处理", dialogue: "逐项对话", user_only: "仅限用户发起" };

/** 活动与流程的标识符的写法：小写字母开头，小写字母、数字、短横线与下划线。 */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]*$/;
/** 流程的标识符；由任务类型的 flows/ 目录里有哪几份文件定。 */
export type FlowKey = string;

/**
 * 前置条件的键，都是数据条件：has_materials 至少一份材料；has_pages 业务说明至少一节；diagrams_viewed 图都看过（一张图都没有也算）；
 * has_items 有需求条目；has_confirmed_items 有已确认的需求条目；no_open_findings 评审没有未处理的发现；
 * confirmations_clear 没有待确认的内容；has_version 有已发布的版本。
 */
export const CONDITIONS = ["has_materials", "has_pages", "diagrams_viewed", "has_items", "has_confirmed_items", "no_open_findings", "confirmations_clear", "has_version"] as const;
export type Condition = (typeof CONDITIONS)[number];

/** 每个前置条件给人看的说法，接在「前置条件：」后面。 */
export const CONDITION_TEXTS: Record<Condition, string> = {
  has_materials: "至少一份项目材料",
  has_pages: "业务说明至少一节",
  diagrams_viewed: "分析模型均已查看",
  has_items: "存在需求条目",
  has_confirmed_items: "存在已确认的需求条目",
  no_open_findings: "评审无未处理发现",
  confirmations_clear: "确认记录待处理为 0",
  has_version: "存在已发布的版本",
};

/** 没有前置条件时写的那一句。 */
export const NO_PREREQUISITE_TEXT = "无前置条件；可从空白开始。";

/** 几个前置条件合成一句给人看的话。 */
export function prerequisiteText(requires: readonly Condition[]): string {
  return requires.length === 0 ? NO_PREREQUISITE_TEXT : `前置条件：${requires.map((one) => CONDITION_TEXTS[one]).join("，")}。`;
}

/** 活动正文的分段时机：附在第一次保存修订做成的结果后面、附在第一次回复做成的结果后面。常驻段不写时机。 */
export const SEGMENT_TIMINGS = ["after_save", "after_reply"] as const;
export type SegmentTiming = (typeof SEGMENT_TIMINGS)[number];
/** 正文里起一段的那一行。 */
const SEGMENT_MARK = /^<!-- segment: ([a-z_]+) -->$/;

/** 活动正文按分段标记切开：always 是第一个标记之前的常驻段，别的按时机。没有标记时整段都是常驻段。不核对时机写得对不对（见 checkSegments）。 */
export function splitSegments(body: string): { always: string; segments: Partial<Record<string, string>>; marks: string[] } {
  const segments: Record<string, string[]> = {};
  const marks: string[] = [];
  const always: string[] = [];
  let into = always;
  for (const line of body.split("\n")) {
    const hit = SEGMENT_MARK.exec(line.trim());
    if (!hit) {
      into.push(line);
      continue;
    }
    marks.push(hit[1]);
    into = segments[hit[1]] ??= [];
  }
  const tidy = (lines: string[]) => lines.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  return { always: tidy(always), segments: Object.fromEntries(Object.entries(segments).map(([key, lines]) => [key, tidy(lines)])), marks };
}

/** 声明里的 segments 与正文里的分段标记对不对得上：每个时机恰好一个标记、不多不少，每段不是空的。 */
function checkSegments(timings: SegmentTiming[], body: string, file: string): void {
  const { segments, marks } = splitSegments(body);
  const unknown = marks.find((one) => !(timings as string[]).includes(one));
  if (unknown) throw new DefinitionHeadError(`${file} 的正文里有分段标记「${unknown}」，声明的「segments」里没有它。`);
  const twice = marks.find((one, i) => marks.indexOf(one) !== i);
  if (twice) throw new DefinitionHeadError(`${file} 的正文里分段标记「${twice}」出现了两次。`);
  const missing = timings.find((one) => !marks.includes(one));
  if (missing) throw new DefinitionHeadError(`${file} 的声明里「segments」写了「${missing}」，正文里没有这一段的标记。`);
  const empty = timings.find((one) => !segments[one]);
  if (empty) throw new DefinitionHeadError(`${file} 的正文里「${empty}」这一段是空的。`);
}

/** 一项活动的声明。 */
export interface ActivityDef {
  /** 标识符，取自文件名。六个阶段与发布的那几项与它们的键相同。 */
  key: string;
  name: string;
  mode: Mode;
  /** 一句话目的。 */
  purpose: string;
  reads: ReadKey[];
  writes: AssetKey[];
  /**
   * 获准能力：做这项活动时助手能做哪几类写入（page、problem、diagram、item、review、publish）。工作项在做这项活动时，系统提示、
   * 定义视图与工具调用时的守卫都取这一栏（lib/activity_def_read.ts 的 allowedFor），不能超出它所用模板头里的那一栏。只能由用户发起的活动为空。
   */
  writesAllowed: WriteKind[];
  requires: Condition[];
  /** 一句例子。 */
  example: string;
  /** 用平台的哪一份活动模板；只能由用户发起的活动为 null。 */
  template: string | null;
  /** 算作哪个阶段（过渡期的兼容栏）；只能由用户发起的活动为 null。 */
  stage: Stage | null;
  /** 正文分了哪几段（不含常驻段）；没有分段时是空的。 */
  segments: SegmentTiming[];
  /**
   * 能不能单独启动（「alone」一栏，yes 或 no，不写或者空着是 yes）：不能的只在工作流里做，目录不给它单项卡，单项启动被拒。
   * 只看声明本身：只能由用户发起的活动（发布）能不能启动另由 mode 管（startActivity 的 not_startable 先拦）。
   */
  alone: boolean;
  /**
   * 新增别的集合的条目之前要不要过最低门（「gate_viewed_page」一栏，yes 或 no，不写或者空着是 yes；最低门见 lib/overall_analysis.ts 的
   * gateFact）。逆向解析写 no：它照原文立页立条目，那时用户还没看过任何页。
   */
  gateViewedPage: boolean;
  /**
   * 这项活动只认哪几种role的材料（「sources_from_roles」一栏，逗号隔开的材料 role名，不写是空的）：不空时，保存的「文档原文」来源
   * 所指的材料、以及自带的 read、grep 读的材料，role都要在这里面（lib/source_roles.ts）。逆向解析写「既有规格说明」。空的不限。
   */
  sourcesFromRoles: string[];
}

/** 槽位收什么：材料文件，或者一段文字。 */
export const SLOT_ACCEPTS = ["materials", "text"] as const;
export type SlotAccepts = (typeof SLOT_ACCEPTS)[number];

/** 工作流的声明里的一个槽位（slot.<键> 一行）。 */
export interface FlowSlot {
  key: string;
  name: string;
  accepts: SlotAccepts;
  required: boolean;
  /** 放进这个槽位的材料的 role；收文字的槽位是 null。 */
  role: string | null;
}

/** 一条流程的声明。 */
export interface FlowDef {
  key: FlowKey;
  name: string;
  purpose: string;
  /** 适用情形，一句。 */
  applies: string;
  /** 各步的活动标识符，按先后。 */
  steps: string[];
  /** 某一步的一句提示，键是活动标识符；没有写的没有。 */
  notes: Record<string, string>;
  /** 需要什么输入，一句。 */
  inputs: string;
  /** 输入页的槽位，按头里出现的先后；没有写的是空的。 */
  slots: FlowSlot[];
  /** 用户可能所处的几种处境（「cases」一栏，分号隔开的短句），任务起点页把它们画成一行可点的小签；没有写的是空的。 */
  cases: string[];
  requires: Condition[];
  /** 一段经过示例。 */
  example: string;
}

/** 头写得不对时抛的错：哪份文件、缺哪一栏或者哪一栏的值不认。 */
export class DefinitionHeadError extends Error {}

/**
 * 把一份定义文件拆成头与正文。头是开头两行 --- 之间的「名字: 值」，一行一栏；没有头时 head 为 null、正文是全文。
 * 正文开头的空行去掉。
 */
export function splitHead(text: string): { head: Record<string, string> | null; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) return { head: null, body: text };
  const head: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) head[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { head, body: match[2].replace(/^\n+/, "") };
}

/** 取头里必填的一栏：没有这一栏、或者值是空的，都报错。 */
function need(head: Record<string, string>, field: string, file: string): string {
  const value = head[field];
  if (value === undefined || value === "") throw new DefinitionHeadError(`${file} 的头里缺「${field}」一栏。`);
  return value;
}

/** 取头里的一栏并核对它是不是给定的几个写法之一。 */
function oneOf<T extends string>(head: Record<string, string>, field: string, allowed: readonly T[], file: string): T {
  const value = need(head, field, file);
  if (!(allowed as readonly string[]).includes(value)) throw new DefinitionHeadError(`${file} 的头里「${field}」写的是「${value}」，只能是 ${allowed.join("、")} 之一。`);
  return value as T;
}

/**
 * 取头里列表型的一栏：用逗号隔开的几个写法，每个都要在给定的写法里。这一栏必须有；required 为假时值可以是空的（空列表）。
 */
function listOf<T extends string>(head: Record<string, string>, field: string, allowed: readonly T[], file: string, required: boolean): T[] {
  if (head[field] === undefined) throw new DefinitionHeadError(`${file} 的头里缺「${field}」一栏。`);
  const values = head[field].split(/[,，]/).map((one) => one.trim()).filter(Boolean);
  if (required && values.length === 0) throw new DefinitionHeadError(`${file} 的头里「${field}」一栏是空的。`);
  for (const one of values) {
    if (!(allowed as readonly string[]).includes(one)) throw new DefinitionHeadError(`${file} 的头里「${field}」写了「${one}」，只能是 ${allowed.join("、")} 里的。`);
  }
  return values as T[];
}

/** 一份文件的头：没有头就报错。 */
function headOf(text: string, file: string): Record<string, string> {
  const { head } = splitHead(text);
  if (head === null) throw new DefinitionHeadError(`${file} 开头没有头（两行 --- 之间的那一段）。`);
  return head;
}

/** 读一项活动的声明并校验。key 是取自文件名的标识符，file 是报错时说的文件名。 */
export function parseActivityDef(text: string, key: string, file: string): ActivityDef {
  if (!IDENTIFIER_PATTERN.test(key)) throw new DefinitionHeadError(`${file} 的文件名「${key}」不能当活动的标识符：只能是小写字母开头的小写字母、数字、短横线与下划线。`);
  const head = headOf(text, file);
  const known = new Set(["name", "mode", "purpose", "reads", "writes", "writes_allowed", "requires", "example", "template", "stage", "segments", "alone", "gate_viewed_page", "sources_from_roles"]);
  const extra = Object.keys(head).filter((field) => !known.has(field));
  if (extra.length > 0) throw new DefinitionHeadError(`${file} 的声明里有不认的栏：${extra.join("、")}。`);
  const mode = oneOf(head, "mode", MODES, file);
  if (head.template === undefined) throw new DefinitionHeadError(`${file} 的声明里缺「template」一栏。`);
  if (head.stage === undefined) throw new DefinitionHeadError(`${file} 的声明里缺「stage」一栏。`);
  const template = head.template || null, stageText = head.stage || null;
  if (template !== null && !IDENTIFIER_PATTERN.test(template)) throw new DefinitionHeadError(`${file} 的声明里「template」写的是「${template}」，不是模板的写法。`);
  if (stageText !== null && !(STAGES as readonly string[]).includes(stageText)) {
    throw new DefinitionHeadError(`${file} 的声明里「stage」写的是「${stageText}」，只能是 ${STAGES.join("、")} 之一，或者空着。`);
  }
  // 只能由用户发起的活动不进系统提示，没有模板也不算阶段；别的活动两栏都要写。
  if (mode === "user_only" ? template !== null || stageText !== null : template === null || stageText === null) {
    throw new DefinitionHeadError(`${file} 的声明里「template」与「stage」：只能由用户发起的活动两栏都空着，别的活动两栏都要写。`);
  }
  const writesAllowed = listOf(head, "writes_allowed", WRITE_KINDS, file, mode !== "user_only");
  if (mode === "user_only" && writesAllowed.length > 0) throw new DefinitionHeadError(`${file} 的声明里「writes_allowed」：只能由用户发起的活动不经助手，这一栏空着。`);
  const segments = head.segments === undefined ? [] : listOf(head, "segments", SEGMENT_TIMINGS, file, true);
  if (segments.length > 0 && mode === "user_only") throw new DefinitionHeadError(`${file} 的声明里「segments」：只能由用户发起的活动不进系统提示，不分段。`);
  checkSegments(segments, splitHead(text).body, file);
  const sourcesFromRoles = (head.sources_from_roles ?? "").split(/[,，]/).map((one) => one.trim()).filter(Boolean);
  if (sourcesFromRoles.length > 0 && mode === "user_only") throw new DefinitionHeadError(`${file} 的声明里「sources_from_roles」：只能由用户发起的活动不经助手，不写这一栏。`);
  const yesNo = (field: string): boolean => {
    const text = (head[field] ?? "").trim();
    if (text !== "" && text !== "yes" && text !== "no") throw new DefinitionHeadError(`${file} 的声明里「${field}」写的是「${text}」，只能是 yes、no 之一，或者不写。`);
    return text !== "no";
  };
  return {
    key,
    name: need(head, "name", file),
    mode,
    purpose: need(head, "purpose", file),
    reads: listOf(head, "reads", [...ASSETS, READ_KNOWLEDGE, READ_ALL] as readonly ReadKey[], file, true),
    writes: listOf(head, "writes", ASSETS, file, true),
    writesAllowed,
    requires: listOf(head, "requires", CONDITIONS, file, false),
    example: need(head, "example", file),
    template,
    stage: stageText as Stage | null,
    segments,
    alone: yesNo("alone"),
    gateViewedPage: yesNo("gate_viewed_page"),
    sourcesFromRoles,
  };
}

/** 读一行槽位：「name=…; accepts=…; required=…; role=…」，四项顺序固定，收文字的槽位 role 可以省略。 */
function parseSlot(key: string, value: string, file: string): FlowSlot {
  const field = `slot.${key}`;
  const bad = (why: string) => new DefinitionHeadError(`${file} 的声明里「${field}」${why}`);
  if (!IDENTIFIER_PATTERN.test(key)) throw bad(`的键「${key}」不能当槽位的键：只能是小写字母开头的小写字母、数字、短横线与下划线。`);
  const parts = value.split(/[;；]/).map((one) => one.trim());
  if (parts.at(-1) === "") parts.pop();
  const names = ["name", "accepts", "required", "role"];
  const got: Record<string, string> = {};
  parts.forEach((part, i) => {
    const at = part.indexOf("=");
    const name = at > 0 ? part.slice(0, at).trim() : "";
    if (name !== names[i]) throw bad(`第 ${i + 1} 项应当是「${names[i]}=…」，写的是「${part}」：四项依次是 name、accepts、required、role。`);
    got[name] = part.slice(at + 1).trim();
  });
  if (!got.name) throw bad("缺名称（name）。");
  if (!(SLOT_ACCEPTS as readonly string[]).includes(got.accepts ?? "")) throw bad(`的 accepts 写的是「${got.accepts ?? ""}」，只能是 ${SLOT_ACCEPTS.join("、")} 之一。`);
  if (got.required !== "true" && got.required !== "false") throw bad(`的 required 写的是「${got.required ?? ""}」，只能是 true 或 false。`);
  const accepts = got.accepts as SlotAccepts, role = got.role ?? "";
  if (accepts === "materials" && role === "") throw bad("收材料，要写 role。");
  if (accepts === "text" && role !== "") throw bad(`收文字，role 要空着，写的是「${role}」。`);
  return { key, name: got.name, accepts, required: got.required === "true", role: accepts === "materials" ? role : null };
}

/** 读一条流程的声明并校验。activities 是这个任务类型的全部活动的标识符：各步只能写它们里的，同一项不能写两次。 */
/** 「cases」一栏：按中文或英文分号拆成短句，各去首尾空白；没有这一栏是空的，拆出空句抛错。 */
function casesOf(value: string | undefined, file: string): string[] {
  if (value === undefined || value.trim() === "") return [];
  const cases = value.split(/[;；]/).map((one) => one.trim());
  if (cases.some((one) => one === "")) throw new DefinitionHeadError(`${file} 的声明里「cases」有空句：用分号隔开的每一句都要写内容。`);
  return cases;
}

export function parseFlowDef(text: string, key: string, file: string, activities: readonly string[]): FlowDef {
  const head = headOf(text, file);
  const flow = need(head, "flow", file);
  if (flow !== key) throw new DefinitionHeadError(`${file} 的声明里「flow」写的是「${flow}」，应当与文件名相同。`);
  const steps = listOf(head, "steps", activities, file, true);
  const twice = steps.find((one, i) => steps.indexOf(one) !== i);
  if (twice) throw new DefinitionHeadError(`${file} 的声明里「steps」写了两次「${twice}」：同一项活动在一条流程里只能出现一次。`);
  const notes: Record<string, string> = {};
  for (const [field, value] of Object.entries(head)) {
    if (!field.startsWith("note.")) continue;
    const step = field.slice("note.".length);
    if (!steps.includes(step)) throw new DefinitionHeadError(`${file} 的声明里「${field}」说的「${step}」不在「steps」里。`);
    if (value) notes[step] = value;
  }
  // 拆头时同名的栏后一行盖掉前一行，所以槽位写没写两次要回到原文数。
  const headText = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  const slotLines = headText.split("\n").map((line) => /^slot\.([^:]*):/.exec(line)?.[1]?.trim()).filter((one) => one !== undefined);
  const twiceSlot = slotLines.find((one, i) => slotLines.indexOf(one) !== i);
  if (twiceSlot !== undefined) throw new DefinitionHeadError(`${file} 的声明里「slot.${twiceSlot}」写了两次：一个槽位只能写一行。`);
  const slots = Object.entries(head).filter(([field]) => field.startsWith("slot.")).map(([field, value]) => parseSlot(field.slice("slot.".length), value, file));
  const known = new Set(["flow", "name", "purpose", "applies", "steps", "inputs", "cases", "requires", "example"]);
  const extra = Object.keys(head).filter((field) => !known.has(field) && !field.startsWith("note.") && !field.startsWith("slot."));
  if (extra.length > 0) throw new DefinitionHeadError(`${file} 的声明里有不认的栏：${extra.join("、")}。`);
  return {
    key,
    name: need(head, "name", file),
    purpose: need(head, "purpose", file),
    applies: need(head, "applies", file),
    steps,
    notes,
    inputs: need(head, "inputs", file),
    slots,
    cases: casesOf(head.cases, file),
    requires: listOf(head, "requires", CONDITIONS, file, false),
    example: need(head, "example", file),
  };
}
