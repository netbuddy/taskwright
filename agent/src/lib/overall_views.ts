/**
 * 从业务说明的页与问题条目算出来的三张表：规则表、业务目标、决策记录与待澄清事项。只算不存：任务里的页与问题变了，表跟着变。
 *
 * - 规则表：各页「已经定下的」逐条列出，每条带它的出处；助手发现两条规则互相矛盾时记一条问题条目（说事情的那句话以
 *   「规则冲突：」开头），这条问题还没有了结期间，它指到的规则在表里标为冲突。
 * - 业务目标：标签为「目标」的页按上级主题排成树，标签为「决定」的页挂在它上级的目标下，带上为什么这样决定。
 * - 决策记录与待澄清事项：标签为「决定」的页与还没有了结的问题条目，按时间先后合成一张表。
 *
 * 这里的函数只吃调用方读好的普通对象，不读库。本文件除了 overall_analysis.ts 与 stage.ts 不导入别的模块：助手一侧算灯、
 * 后端给页面的整份数据都调它，页面也可以直接导入（agent/tests/web_imports.test.ts 守着）。
 */

import { OVERALL_FIELDS, isDeprecated, tagsOf } from "./overall_analysis.ts";
import { TAG_DECISION, TAG_GOAL } from "./stage.ts";

/** 记规则冲突的问题条目，说事情的那句话以它开头。 */
export const RULE_CONFLICT_PREFIX = "规则冲突：";

/** 一条来源里这三张表要看的几样。supports 是它支持哪几处；空列表是支持整个条目。 */
export interface ViewSource {
  kind: string;
  locator: string;
  excerpt: string;
  supports: readonly { field: string; index?: number | null }[];
}

/** 业务说明的一页：编号、现在的字段内容、它当前修订上的来源、第一次保存的时刻（取不到是 null）。 */
export interface ViewPage {
  item_id: string;
  fields: Record<string, unknown>;
  sources: readonly ViewSource[];
  created_at: string | null;
}

/**
 * 一条问题条目。subject 是说事情的那句话（需求规格这一类任务里是「事项」字段）；open 是它还没有了结（状态仍是未解决）；
 * kind 是它的种类（待澄清、范围外这一类，集合没有这个字段时是 null）；suggestion 是建议的处理（没有写是空文字）。
 */
export interface ViewQuestion {
  item_id: string;
  subject: string;
  open: boolean;
  kind: string | null;
  suggestion: string;
  sources: readonly ViewSource[];
  created_at: string | null;
}

const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string" && one.trim() !== "") : []);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const titleOf = (page: ViewPage): string => text(page.fields[OVERALL_FIELDS.title]);
const inUse = (pages: readonly ViewPage[]): ViewPage[] => pages.filter((one) => !isDeprecated(one.fields));

// ───────────── 规则表 ─────────────

/** 规则表的一行：哪一页的第几条规则（index 从 0 起，是它在「已经定下的」里的位置）、规则的文字、出处、标它冲突的问题条目。 */
export interface RuleRow {
  item_id: string;
  title: string;
  index: number;
  text: string;
  sources: { kind: string; locator: string; excerpt: string }[];
  /** 把这条规则标为冲突的问题条目的编号；没有是空列表。 */
  conflicts: string[];
}

export interface RulesTable {
  rows: RuleRow[];
  /** 还没有了结的规则冲突问题的编号，按给出的先后。 */
  conflicts: string[];
  /** 其中对不上任何一条规则的那几条（它的来源没有指到哪一页的哪一条规则），免得在表里看不到。 */
  unmatched: string[];
}

/** 一条问题条目是不是还没有了结的规则冲突。 */
export function isOpenRuleConflict(question: Pick<ViewQuestion, "subject" | "open">): boolean {
  return question.open && question.subject.trim().startsWith(RULE_CONFLICT_PREFIX);
}

/**
 * 规则表：在用的各页「已经定下的」逐条列出，照页给出的先后与每页里的先后。
 * 出处：这一页当前修订上支持这一条的各条来源（supports 指到「已经定下的」的这一项；指到整个字段或者整个条目的来源每一条都算）。
 * 冲突怎样对上：还没有了结的规则冲突问题，它的来源里种类为「条目」、出处是这一页、摘录与这条规则的文字互相包含的，这条规则标为冲突。
 */
export function rulesTable(pages: readonly ViewPage[], questions: readonly ViewQuestion[]): RulesTable {
  const rows: RuleRow[] = [];
  for (const page of inUse(pages)) {
    const settled = page.fields[OVERALL_FIELDS.settled];
    if (!Array.isArray(settled)) continue;
    settled.forEach((value, index) => {
      if (typeof value !== "string" || value.trim() === "") return;
      const sources = page.sources
        .filter((one) => one.supports.length === 0 || one.supports.some((at) => at.field === OVERALL_FIELDS.settled && (at.index === undefined || at.index === null || at.index === index)))
        .map((one) => ({ kind: one.kind, locator: one.locator, excerpt: one.excerpt }));
      rows.push({ item_id: page.item_id, title: titleOf(page), index, text: value.trim(), sources, conflicts: [] });
    });
  }
  const conflicts: string[] = [];
  const unmatched: string[] = [];
  for (const question of questions) {
    if (!isOpenRuleConflict(question)) continue;
    conflicts.push(question.item_id);
    let matched = false;
    for (const source of question.sources) {
      const excerpt = source.excerpt.trim();
      if (source.kind !== "条目" || excerpt === "") continue;
      for (const row of rows) {
        if (row.item_id !== source.locator.trim() || !(row.text.includes(excerpt) || excerpt.includes(row.text))) continue;
        matched = true;
        if (!row.conflicts.includes(question.item_id)) row.conflicts.push(question.item_id);
      }
    }
    if (!matched) unmatched.push(question.item_id);
  }
  return { rows, conflicts, unmatched };
}

// ───────────── 业务目标 ─────────────

/** 挂在目标下的一个决定：编号、标题、为什么这样决定（「已经定下的」的第一条；没有就取「它是什么」的第一段；都没有是空文字）。 */
export interface DecisionLeaf {
  item_id: string;
  title: string;
  why: string;
}

/** 目标树上的一个目标：它下面的目标与挂在它下面的决定。 */
export interface GoalNode {
  item_id: string;
  title: string;
  goals: GoalNode[];
  decisions: DecisionLeaf[];
}

export interface GoalTree {
  /** 最上层的目标：没有上级主题，或者上级主题不是一页在用的目标。 */
  roots: GoalNode[];
  /** 没有挂到任何目标下的决定：没有上级主题，或者上级主题不是一页在用的目标。 */
  loose: DecisionLeaf[];
}

const parentOf = (page: ViewPage): string | null => {
  const value = page.fields[OVERALL_FIELDS.parent];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : texts(value)[0]?.trim() ?? null;
};

/** 一个决定为什么这样定。 */
export function whyOf(fields: Record<string, unknown>): string {
  const first = texts(fields[OVERALL_FIELDS.settled])[0];
  if (first) return first.trim();
  return text(fields[OVERALL_FIELDS.what]).split(/\n\s*\n/)[0]?.trim() ?? "";
}

/**
 * 业务目标：在用的页里标签含「目标」的按上级主题排成树，标签含「决定」的挂在它上级的目标下。一页同时贴了两个标签时算目标。
 * 同一层里照页给出的先后。上级主题写成了环（甲的上级是乙、乙的上级是甲）时，环上的目标都排到最上层，不丢。
 */
export function goalTree(pages: readonly ViewPage[]): GoalTree {
  const live = inUse(pages);
  const goals = live.filter((one) => tagsOf(one.fields).includes(TAG_GOAL));
  const nodes = new Map<string, GoalNode>(goals.map((one) => [one.item_id, { item_id: one.item_id, title: titleOf(one), goals: [], decisions: [] }]));
  const loose: DecisionLeaf[] = [];
  for (const page of live) {
    if (nodes.has(page.item_id) || !tagsOf(page.fields).includes(TAG_DECISION)) continue;
    const leaf = { item_id: page.item_id, title: titleOf(page), why: whyOf(page.fields) };
    const parent = parentOf(page);
    const under = parent !== null ? nodes.get(parent) : undefined;
    if (under) under.decisions.push(leaf);
    else loose.push(leaf);
  }
  // 顺着上级主题往上走能走到头（走到没有目标上级的那一页）的目标挂在它的上级下；走不到头的在环上，排到最上层。
  const parentGoal = (id: string): string | null => {
    const page = goals.find((one) => one.item_id === id)!;
    const parent = parentOf(page);
    return parent !== null && parent !== id && nodes.has(parent) ? parent : null;
  };
  const onCycle = (id: string): boolean => {
    const seen = new Set<string>([id]);
    for (let at = parentGoal(id); at !== null; at = parentGoal(at)) {
      if (seen.has(at)) return true;
      seen.add(at);
    }
    return false;
  };
  const roots: GoalNode[] = [];
  for (const goal of goals) {
    const node = nodes.get(goal.item_id)!;
    const parent = parentGoal(goal.item_id);
    if (parent === null || onCycle(goal.item_id)) roots.push(node);
    else nodes.get(parent)!.goals.push(node);
  }
  return { roots, loose };
}

// ───────────── 决策记录与待澄清事项 ─────────────

/**
 * 决策记录与待澄清事项里的一行。entry 是 decision（一页决定）或 question（一条还没有了结的问题）；
 * title 是决定的标题或问题说事情的那句话；at 是它第一次保存的时刻；note 是决定为什么这样定，或者问题的建议的处理；
 * question_kind 是问题的种类，决定这一行是 null。
 */
export interface DecisionRow {
  entry: "decision" | "question";
  item_id: string;
  title: string;
  at: string | null;
  note: string;
  question_kind: string | null;
}

/**
 * 决策记录与待澄清事项：在用的页里标签含「决定」的，与还没有了结的问题条目，按第一次保存的时刻从早到晚合成一张表；
 * 时刻相同或者取不到时刻的，照给出的先后（页在前、问题在后），取不到时刻的排在最后。
 */
export function decisionsAndOpenQuestions(pages: readonly ViewPage[], questions: readonly ViewQuestion[]): DecisionRow[] {
  const rows: DecisionRow[] = [
    ...inUse(pages).filter((one) => tagsOf(one.fields).includes(TAG_DECISION))
      .map((one): DecisionRow => ({ entry: "decision", item_id: one.item_id, title: titleOf(one), at: one.created_at, note: whyOf(one.fields), question_kind: null })),
    ...questions.filter((one) => one.open)
      .map((one): DecisionRow => ({ entry: "question", item_id: one.item_id, title: one.subject.trim(), at: one.created_at, note: one.suggestion.trim(), question_kind: one.kind })),
  ];
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (a.row.at === b.row.at) return a.index - b.index;
      if (a.row.at === null) return 1;
      if (b.row.at === null) return -1;
      return a.row.at < b.row.at ? -1 : a.row.at > b.row.at ? 1 : a.index - b.index;
    })
    .map((one) => one.row);
}
