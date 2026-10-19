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
 *
 * 需求资产分六类（ASSETS）。活动声明写它读哪几类、写哪几类：能不能启动只看要读的几类里有没有东西，
 * 与之前做没做过哪一项活动无关。「读」一栏另认两个写法：knowledge（知识库）与 all（全部资产）。
 * 前置条件（requires）是数据条件的键（CONDITIONS），一个都没有就是无前置条件。
 */

import { ASSETS, type AssetKey } from "./assets.ts";
import { STAGES, STAGE_NAMES, type Stage } from "./stage.ts";

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
  requires: Condition[];
  /** 一句例子。 */
  example: string;
  /** 用平台的哪一份活动模板；只能由用户发起的活动为 null。 */
  template: string | null;
  /** 算作哪个阶段（过渡期的兼容栏）；只能由用户发起的活动为 null。 */
  stage: Stage | null;
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
  const known = new Set(["name", "mode", "purpose", "reads", "writes", "requires", "example", "template", "stage"]);
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
  return {
    key,
    name: need(head, "name", file),
    mode,
    purpose: need(head, "purpose", file),
    reads: listOf(head, "reads", [...ASSETS, READ_KNOWLEDGE, READ_ALL] as readonly ReadKey[], file, true),
    writes: listOf(head, "writes", ASSETS, file, true),
    requires: listOf(head, "requires", CONDITIONS, file, false),
    example: need(head, "example", file),
    template,
    stage: stageText as Stage | null,
  };
}

/** 读一条流程的声明并校验。activities 是这个任务类型的全部活动的标识符：各步只能写它们里的，同一项不能写两次。 */
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
  const known = new Set(["flow", "name", "purpose", "applies", "steps", "inputs", "requires", "example"]);
  const extra = Object.keys(head).filter((field) => !known.has(field) && !field.startsWith("note."));
  if (extra.length > 0) throw new DefinitionHeadError(`${file} 的声明里有不认的栏：${extra.join("、")}。`);
  return {
    key,
    name: need(head, "name", file),
    purpose: need(head, "purpose", file),
    applies: need(head, "applies", file),
    steps,
    notes,
    inputs: need(head, "inputs", file),
    requires: listOf(head, "requires", CONDITIONS, file, false),
    example: need(head, "example", file),
  };
}
