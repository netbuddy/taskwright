/**
 * 活动的定义与流程的定义开头那一段结构化的头：写法、取值与校验。不读文件、不读库（读文件的在 lib/activity_def_read.ts）。
 *
 * 每项活动一份定义文件（agent/prompts/stages/ 下以活动的键命名），每条流程一份（agent/prompts/flows/）。文件开头两行 --- 之间
 * 是头，一行一栏，写成「名字: 值」，与 SKILL.md 的写法相同；其后是给助手看的正文。拼系统提示时头去掉，只用正文
 * （lib/stage_prompt.ts）；任务起点页的活动目录、能不能启动一项活动，取自头。
 *
 * 需求资产分六类（ASSETS）。一项活动的头写它读哪几类、写哪几类：能不能启动只看要读的几类里有没有东西，
 * 与之前做没做过哪一项活动无关。「读」一栏另认两个写法：knowledge（知识库）与 all（全部资产）。
 * 前置条件（requires）是数据条件的键（CONDITIONS），一个都没有就是无前置条件。
 */

import { STAGES, STAGE_NAMES, type Stage } from "./stage.ts";

/** 需求资产的六类，按任务起点页上从左到右的次序。 */
export const ASSETS = ["materials", "description", "models", "items", "review", "versions"] as const;
export type AssetKey = (typeof ASSETS)[number];

export const ASSET_NAMES: Record<AssetKey, string> = {
  materials: "材料与证据",
  description: "业务说明",
  models: "分析模型",
  items: "需求条目",
  review: "评审与确认",
  versions: "文档与版本",
};

/** 「读」一栏在六类资产之外另认的两个写法。 */
export const READ_KNOWLEDGE = "knowledge";
export const READ_ALL = "all";
export type ReadKey = AssetKey | typeof READ_KNOWLEDGE | typeof READ_ALL;
export const READ_NAMES: Record<ReadKey, string> = { ...ASSET_NAMES, [READ_KNOWLEDGE]: "知识库", [READ_ALL]: "全部资产" };

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

/** 两条流程的键。 */
export const FLOW_KEYS = ["analysis", "change"] as const;
export type FlowKey = (typeof FLOW_KEYS)[number];

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

/** 一项活动的头。 */
export interface ActivityDef {
  key: ActivityKey;
  name: string;
  mode: Mode;
  /** 一句话目的。 */
  purpose: string;
  reads: ReadKey[];
  writes: AssetKey[];
  requires: Condition[];
  /** 一句例子。 */
  example: string;
}

/** 一条流程的头。 */
export interface FlowDef {
  key: FlowKey;
  name: string;
  purpose: string;
  /** 适用情形，一句。 */
  applies: string;
  /** 各站，按先后。 */
  nodes: ActivityKey[];
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

/** 读一项活动的头并校验。file 是报错时说的文件名。 */
export function parseActivityDef(text: string, file: string): ActivityDef {
  const head = headOf(text, file);
  return {
    key: oneOf(head, "activity", ACTIVITIES, file),
    name: need(head, "name", file),
    mode: oneOf(head, "mode", MODES, file),
    purpose: need(head, "purpose", file),
    reads: listOf(head, "reads", [...ASSETS, READ_KNOWLEDGE, READ_ALL] as readonly ReadKey[], file, true),
    writes: listOf(head, "writes", ASSETS, file, true),
    requires: listOf(head, "requires", CONDITIONS, file, false),
    example: need(head, "example", file),
  };
}

/** 读一条流程的头并校验。 */
export function parseFlowDef(text: string, file: string): FlowDef {
  const head = headOf(text, file);
  return {
    key: oneOf(head, "flow", FLOW_KEYS, file),
    name: need(head, "name", file),
    purpose: need(head, "purpose", file),
    applies: need(head, "applies", file),
    nodes: listOf(head, "nodes", ACTIVITIES, file, true),
    inputs: need(head, "inputs", file),
    requires: listOf(head, "requires", CONDITIONS, file, false),
    example: need(head, "example", file),
  };
}
