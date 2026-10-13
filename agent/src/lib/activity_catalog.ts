/**
 * 需求资产六类的现状、前置条件满足没有、给页面的活动目录。只算，不读文件、不读库：事实由调用方读好交进来
 * （算灯用的那一份 lib/stage.ts 的 LampInput，与活动、流程的头 lib/activity_def.ts）。
 *
 * 能不能开展一项活动只看数据：材料有没有、业务说明有几节、图是不是都看过、需求条目有没有、有没有已确认的条目、
 * 评审有没有未处理的发现。与之前做没做过哪一项活动、流程走到哪里无关。另有一条不是前提的约束：任务正在流程里做这一项活动时，
 * 不能同时把它单独开展一遍；一个任务同一时刻只有一项活动在进行。
 */

import {
  ACTIVITY_NAMES, ASSETS, ASSET_NAMES, type ActivityDef, type ActivityKey, type AssetKey, type Condition, type FlowDef, type FlowKey, MODE_NAMES, type Mode,
  PUBLISH, READ_NAMES, prerequisiteText,
} from "./activity_def.ts";
import { CHAPTERS, chapterLayout } from "./overall_chapters.ts";
import { FLOW_INITIAL, IDLE, LAUNCH_ACTIVE, LAUNCH_READY, type LampInput, type Position, type Stage, flowStartNode, isStage } from "./stage.ts";

/** 算六类资产的现状与前置条件要的数。 */
export interface AssetFacts {
  /** 材料的份数（由 Word、PDF 生成的文字版不另算），与其中还没有被任何一节或问题引用的份数。 */
  materials: number;
  materialsUnread: number;
  /** 业务说明的节数：在用的主题页，按章归好的与未归类的都算，章的导语页不算。 */
  sections: number;
  /** 在用的主题页里待核实的页数（有助手补充而用户没有确认的内容）。 */
  sectionsPending: number;
  /** 还没有了结的待澄清问题数。 */
  openQuestions: number;
  /** 图的张数，与其中用户还没有看过现在内容的张数。 */
  diagrams: number;
  diagramsUnviewed: number;
  /** 需求条目（总体分析与问题之外各集合的条目）的条数；其中用户没有看过的、待核实的、已确认的（看过而且不待核实）各几条。 */
  items: number;
  itemsUnread: number;
  itemsPending: number;
  itemsConfirmed: number;
  /** 评审过几轮；当前评审不合规、还没有处理的条目数。 */
  reviewRounds: number;
  openFindings: number;
  /** 已发布到第几版；没有发布过是 0。 */
  versions: number;
}

/** 从算灯用的事实里数出上面这些。 */
export function assetFacts(input: LampInput): AssetFacts {
  const cited = new Set(input.citedDocuments.map((one) => one.split("#")[0]));
  const layout = chapterLayout(input.pages.map((one) => ({
    item_id: one.item_id, labels: one.tags, parent: one.parent, deprecated: one.deprecated, intro: CHAPTERS.find((chapter) => chapter.name === one.intro)?.no ?? null,
  })));
  const sections = layout.chapters.reduce((sum, one) => sum + one.sections.filter((section) => section.no !== null).length, 0)
    + layout.unsorted.filter((one) => !one.deprecated).length;
  const questions = new Set(input.questions.map((one) => one.item_id));
  const items = input.items.filter((one) => !questions.has(one.item_id));
  return {
    materials: input.materials.length,
    materialsUnread: input.materials.filter((one) => !cited.has(one)).length,
    sections,
    sectionsPending: input.pages.filter((one) => !one.deprecated && one.pending).length,
    openQuestions: input.questions.filter((one) => one.open).length,
    diagrams: input.diagrams.length,
    diagramsUnviewed: input.diagrams.filter((one) => !one.viewed).length,
    items: items.length,
    itemsUnread: items.filter((one) => one.viewed !== true).length,
    itemsPending: items.filter((one) => one.pending).length,
    itemsConfirmed: items.filter((one) => one.viewed === true && !one.pending).length,
    reviewRounds: input.review.rounds ?? (input.review.any ? 1 : 0),
    openFindings: input.review.failing.length,
    versions: 0,
  };
}

/** 一个前置条件现在满足没有。 */
export function conditionMet(condition: Condition, facts: AssetFacts): boolean {
  switch (condition) {
    case "has_materials": return facts.materials > 0;
    case "has_pages": return facts.sections > 0;
    case "diagrams_viewed": return facts.diagramsUnviewed === 0;
    case "has_items": return facts.items > 0;
    case "has_confirmed_items": return facts.itemsConfirmed > 0;
    case "no_open_findings": return facts.reviewRounds > 0 && facts.openFindings === 0;
    case "confirmations_clear":
      return facts.itemsUnread === 0 && facts.itemsPending === 0 && facts.diagramsUnviewed === 0 && facts.sectionsPending === 0 && facts.openQuestions === 0;
    case "has_version": return facts.versions > 0;
  }
}

/** 一个前置条件没有满足时说缺什么的那半句，不带句号。 */
export function unmetText(condition: Condition, facts: AssetFacts): string {
  switch (condition) {
    case "has_materials": return "还没有项目材料";
    case "has_pages": return "业务说明还没有内容";
    case "diagrams_viewed": return `有 ${facts.diagramsUnviewed} 张分析模型还没有查看`;
    case "has_items": return "还没有需求条目";
    case "has_confirmed_items": return "还没有已确认的需求条目";
    case "no_open_findings": return facts.reviewRounds === 0 ? "还没有评审过" : `评审还有 ${facts.openFindings} 条未处理`;
    case "confirmations_clear": return "还有待确认的内容";
    case "has_version": return "还没有已发布的版本";
  }
}

/** 几个前置条件里没有满足的合成一句（用分号隔开，不带句号）；都满足是 null。 */
export function blockedText(requires: readonly Condition[], facts: AssetFacts): string | null {
  const unmet = requires.filter((one) => !conditionMet(one, facts));
  return unmet.length === 0 ? null : unmet.map((one) => unmetText(one, facts)).join("；");
}

/** 六项活动（六个工作阶段）各自现在缺什么前提；不缺是 null。 */
export function blockedByStage(activities: readonly ActivityDef[], facts: AssetFacts): Record<Stage, string | null> {
  const out = {} as Record<Stage, string | null>;
  for (const one of activities) if (isStage(one.key)) out[one.key] = blockedText(one.requires, facts);
  return out;
}

/** 六类资产里一类的现状：页面上一格。 */
export interface AssetCell {
  key: AssetKey;
  name: string;
  /** 数量；评审与确认是评审过几轮，文档与版本是发布到第几版。 */
  count: number;
  /** 数量的单位。 */
  unit: string;
  /** 格里的大字：数量加单位；没有评审过是「未评审」，没有发布过是「未发布」。 */
  text: string;
  /** 大字下面的一句；没有可说的是空文字。 */
  note: string;
  /** 由哪些活动产出：写这一类的各项活动的名称。 */
  produced_by: string[];
}

/** 六类资产的现状，照 ASSETS 的次序。 */
export function assetCells(facts: AssetFacts, activities: readonly ActivityDef[]): AssetCell[] {
  const itemsNote = [facts.itemsUnread > 0 ? `${facts.itemsUnread} 未读` : "", facts.itemsPending > 0 ? `${facts.itemsPending} 待核实` : ""].filter(Boolean).join(" · ");
  const shown: Record<AssetKey, [count: number, unit: string, text: string | null, note: string]> = {
    materials: [facts.materials, "份", null, facts.materials === 0 ? "" : facts.materialsUnread === 0 ? "均已核读" : `${facts.materialsUnread} 份未核读`],
    description: [facts.sections, "节", null, facts.openQuestions > 0 ? `${facts.openQuestions} 处待澄清` : facts.sections > 0 ? "无待澄清事项" : ""],
    models: [facts.diagrams, "张", null, facts.diagrams === 0 ? "" : facts.diagramsUnviewed === 0 ? "均已查看" : `${facts.diagramsUnviewed} 未查看`],
    items: [facts.items, "条", null, facts.items === 0 ? "" : itemsNote || "均已确认"],
    review: [facts.reviewRounds, "轮", facts.reviewRounds === 0 ? "未评审" : null, facts.openFindings > 0 ? `${facts.openFindings} 未处理` : facts.reviewRounds > 0 ? "无未处理发现" : ""],
    versions: [facts.versions, "版", facts.versions === 0 ? "未发布" : `第 ${facts.versions} 版`, ""],
  };
  return ASSETS.map((key) => {
    const [count, unit, text, note] = shown[key];
    return {
      key, name: ASSET_NAMES[key], count, unit, text: text ?? `${count} ${unit}`, note,
      produced_by: activities.filter((one) => one.writes.includes(key)).map((one) => one.name),
    };
  });
}

/** 带名称的一个键。 */
export interface Named {
  key: string;
  name: string;
}

/** 活动目录里的一项单项活动。 */
export interface CatalogActivity {
  key: ActivityKey;
  name: string;
  mode: Mode;
  mode_name: string;
  purpose: string;
  reads: Named[];
  writes: Named[];
  /** 前置条件的一句，取自定义，与现在满足没有无关。 */
  prerequisite_text: string;
  example: string;
  /** 现在能不能开展。 */
  enabled: boolean;
  /** 现在的状态一句：可以开展、正在进行、正在工作流程中进行、此版本尚未提供，或者缺什么前提。 */
  state: string;
  recommended: boolean;
}

/** 活动目录里的一条工作流程。 */
export interface CatalogFlow {
  key: FlowKey;
  name: string;
  purpose: string;
  applies: string;
  /** 各站，按先后。 */
  nodes: Named[];
  inputs: string;
  prerequisite_text: string;
  example: string;
  enabled: boolean;
  state: string;
  /** 推荐：没有发布过版本时是首次分析，发布过之后是需求变更。 */
  recommended: boolean;
  /** 流程走到的站；没有走过、或者这条流程现在还不能开展时是 null。 */
  at: ActivityKey | null;
  /** 现在开展这条流程应当从哪一站开始：走过就是走到的那一站，没有走过时有材料从核读材料、没有材料从澄清；这条流程现在还不能开展时是 null。 */
  start: Stage | null;
}

export interface Catalog {
  flows: CatalogFlow[];
  activities: CatalogActivity[];
}

/** 任务现在在哪里：位置、现在这项活动在不在首次分析流程里、首次分析走到的节点。 */
export interface CatalogWhere {
  position: Position;
  inFlow: boolean;
  flowNode: Stage | null;
}

/** 任务正在首次分析流程里做这项活动时，单项活动里同名那一项的状态。 */
export const CATALOG_IN_FLOW = "正在工作流程中进行";
/** 还不能开展的活动（发布）的状态。 */
export const CATALOG_LATER = "此版本尚未提供";

/** 给页面的活动目录：两条工作流程与七项单项活动，各带现在能不能开展。 */
export function catalog(defs: { activities: readonly ActivityDef[]; flows: readonly FlowDef[] }, facts: AssetFacts, where: CatalogWhere): Catalog {
  const at = where.position === IDLE ? null : where.position;
  const inFlowNow = at !== null && where.inFlow;
  const activities: CatalogActivity[] = defs.activities.map((one) => {
    const base = {
      key: one.key, name: one.name, mode: one.mode, mode_name: MODE_NAMES[one.mode], purpose: one.purpose,
      reads: one.reads.map((key) => ({ key, name: READ_NAMES[key] })), writes: one.writes.map((key) => ({ key, name: ASSET_NAMES[key] })),
      prerequisite_text: prerequisiteText(one.requires), example: one.example, recommended: false,
    };
    const blocked = blockedText(one.requires, facts);
    // 发布现在还不能开展：缺前提时说缺什么，不缺时说明这个版本还没有。
    if (one.key === PUBLISH) return { ...base, enabled: false, state: blocked ?? CATALOG_LATER };
    if (at === one.key) return { ...base, enabled: false, state: where.inFlow ? CATALOG_IN_FLOW : LAUNCH_ACTIVE };
    return { ...base, enabled: blocked === null, state: blocked ?? LAUNCH_READY };
  });
  const flows: CatalogFlow[] = defs.flows.map((one) => {
    const initial = one.key === FLOW_INITIAL;
    const blocked = blockedText(one.requires, facts);
    const active = initial && inFlowNow;
    return {
      key: one.key, name: one.name, purpose: one.purpose, applies: one.applies, nodes: one.nodes.map((key) => ({ key, name: ACTIVITY_NAMES[key] })), inputs: one.inputs,
      prerequisite_text: prerequisiteText(one.requires), example: one.example,
      // 只有首次分析现在能开展；需求变更要有已发布的版本，而且它的各站还没有定义。
      enabled: initial && !active && blocked === null,
      state: active ? LAUNCH_ACTIVE : blocked ?? (initial ? LAUNCH_READY : CATALOG_LATER),
      recommended: initial ? facts.versions === 0 : facts.versions > 0,
      at: initial ? where.flowNode : null,
      start: initial ? where.flowNode ?? flowStartNode(facts.materials > 0) : null,
    };
  });
  return { flows, activities };
}
