/**
 * 需求资产六类的现状、前置条件满足没有、给页面的活动目录。只算，不读文件、不读库：事实由调用方读好交进来
 * （算灯用的那一份 lib/stage.ts 的 LampInput，与活动、流程的头 lib/activity_def.ts）。
 *
 * 能不能启动一项活动只看数据：材料有没有、业务说明有几节、图是不是都看过、需求条目有没有、有没有已确认的条目、
 * 评审有没有未处理的发现。与之前做没做过哪一项活动、别的工作项做到哪里无关：同一项活动已经有进行中的工作项也不拦。
 */

import {
  ACTIVITY_NAMES, ASSETS, type ActivityDef, type ActivityKey, type AssetKey, type Condition, type FlowDef, type FlowKey, type FlowSlot, MODE_NAMES, type Mode,
  PUBLISH, prerequisiteText, readName,
} from "./activity_def.ts";
import { CHAPTERS, chapterLayout } from "./overall_chapters.ts";
import { FLOW_ANALYSIS, type FlowItemRef, LAUNCH_READY, type LampInput, type Stage, flowExistsText, isStage } from "./stage.ts";

/** 算六类资产的现状与前置条件要的数。 */
export interface AssetFacts {
  /** 材料的份数（由 Word、PDF 生成的文字版不另算），与其中还没有被任何一节或问题引用的份数。 */
  materials: number;
  materialsUnread: number;
  /** 材料按放进的槽位（工作流声明里的槽位键）各几份：由 Word、PDF 生成的文字版不算，不经槽位上传的不计入任何键。 */
  materialsBySlot: Record<string, number>;
  /** 业务说明的节数：在用的主题页，按章归好的与未归类的都算，章的导语页不算。 */
  sections: number;
  /** 在用的主题页里待核实的页数（有助手补充而用户没有确认的内容）。 */
  sectionsPending: number;
  /** 还没有了结的待澄清问题数。 */
  openQuestions: number;
  /** 图的张数，与其中用户还没有看过现在内容的张数。 */
  diagrams: number;
  diagramsUnviewed: number;
  /** 需求条目（业务说明与问题之外各集合的条目）的条数；其中用户没有看过的、待核实的、已确认的（看过而且不待核实）各几条。 */
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
    materialsBySlot: { ...(input.materialsBySlot ?? {}) },
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
    versions: input.versions ?? 0,
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

/** 六类资产的现状，照 ASSETS 的次序；names 是任务定义的资产显示名（lib/asset_names.ts 的 assetNamesOf）。 */
export function assetCells(facts: AssetFacts, activities: readonly ActivityDef[], names: Readonly<Record<AssetKey, string>>): AssetCell[] {
  const itemsNote = [facts.itemsUnread > 0 ? `${facts.itemsUnread} 未读` : "", facts.itemsPending > 0 ? `${facts.itemsPending} 待核实` : ""].filter(Boolean).join(" · ");
  const shown: Record<AssetKey, [count: number, unit: string, text: string | null, note: string]> = {
    materials: [facts.materials, "份", null, facts.materials === 0 ? "" : facts.materialsUnread === 0 ? "均有引用" : `${facts.materialsUnread} 份未被引用`],
    description: [facts.sections, "节", null, facts.openQuestions > 0 ? `${facts.openQuestions} 处待澄清` : facts.sections > 0 ? "无待澄清事项" : ""],
    models: [facts.diagrams, "张", null, facts.diagrams === 0 ? "" : facts.diagramsUnviewed === 0 ? "均已查看" : `${facts.diagramsUnviewed} 未查看`],
    items: [facts.items, "条", null, facts.items === 0 ? "" : itemsNote || "均已确认"],
    review: [facts.reviewRounds, "轮", facts.reviewRounds === 0 ? "未评审" : null, facts.openFindings > 0 ? `${facts.openFindings} 未处理` : facts.reviewRounds > 0 ? "无未处理发现" : ""],
    versions: [facts.versions, "版", facts.versions === 0 ? "未发布" : `第 ${facts.versions} 版`, ""],
  };
  return ASSETS.map((key) => {
    const [count, unit, text, note] = shown[key];
    return {
      key, name: names[key], count, unit, text: text ?? `${count} ${unit}`, note,
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
  key: string;
  name: string;
  /** 这项活动算作哪个阶段（声明的 stage 一栏原样）；只能由用户发起的（发布）为 null。页面据此给不是阶段键的活动（逆向解析）取灯、画进度格。 */
  stage: Stage | null;
  /** 能不能单独启动（声明的「alone」一栏）：不能的只在工作流里做，页面不画它的单项卡。 */
  alone: boolean;
  mode: Mode;
  mode_name: string;
  purpose: string;
  reads: Named[];
  writes: Named[];
  /** 前置条件的一句，取自定义，与现在满足没有无关。 */
  prerequisite_text: string;
  example: string;
  /** 现在能不能启动：只看数据前提。 */
  enabled: boolean;
  /** 现在的状态一句：可以启动、此版本尚未提供，或者缺什么前提。 */
  state: string;
  recommended: boolean;
  /** 这项活动现在有几个工作项。 */
  active_count: number;
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
  /** 卡上「输入」一行：工作流声明了槽位时由槽位生成（各槽位的名称，必填的注「（必填）」），没有槽位时就是 inputs。 */
  inputs_text: string;
  /** 第一个还空着的必填材料槽位的名称（见 missingSlot）；都有了、或者没有必填的材料槽位时为 null。有它时这条工作流不能启动。 */
  missing_slot: string | null;
  /** 输入页的槽位，照工作流的声明原样给；没有声明槽位的是空的。页面现在还不读它。 */
  slots: FlowSlot[];
  /** 用户可能所处的几种处境（工作流声明的「cases」一栏原样），任务起点页画成一行可点的小签；没有写的是空的。 */
  cases: string[];
  prerequisite_text: string;
  example: string;
  /** 现在能不能启动：看数据前提，另外任务里已有流程的工作项（不论哪条流程）时不能启动。 */
  enabled: boolean;
  /** 现在的状态一句：可以启动、此版本尚未提供、缺什么前提，或者已有哪个流程工作项、在哪一站。 */
  state: string;
  /** 推荐：没有发布过版本时是需求分析，发布过之后是需求变更。 */
  recommended: boolean;
  /** 恒为 null：早先是「流程走到的站」，现在流程的位置记在各个工作项上，这一项只为还读它的页面留着。 */
  at: ActivityKey | null;
  /**
   * 现在启动这条流程应当从哪一站开始：各步里第一个前提都满足的那一站（需求分析有材料从核读材料、没有材料从澄清）；
   * 这条流程的前提、必填的材料槽位没有满足，或者它还没有提供时是 null。
   */
  start: string | null;
  /** 这条流程现在有几个工作项（至多一个）。 */
  active_count: number;
  /**
   * 任务里已有的流程工作项（一个任务至多一个，不论哪条流程，所以每条流程这一项相同）：记录号、名字、所在的一站；没有是 null。
   * 有它时流程都不能启动，页面把流程卡改成「打开它的会话」。
   */
  work_item: FlowItemRef | null;
}

export interface Catalog {
  flows: CatalogFlow[];
  activities: CatalogActivity[];
}

/** 工作流里第一个还空着的必填材料槽位：这个槽位里一份材料都没有（按 facts.materialsBySlot 数）；都有了是 undefined。 */
export function missingSlot(slots: readonly FlowSlot[], facts: Pick<AssetFacts, "materialsBySlot">): FlowSlot | undefined {
  return slots.find((it) => it.required && it.accepts === "materials" && (facts.materialsBySlot[it.key] ?? 0) === 0);
}

/** 由槽位生成「输入」一行：各槽位的名称按先后，必填的后面注「（必填）」；没有槽位时是 null。 */
export function slotsText(slots: readonly FlowSlot[]): string | null {
  return slots.length === 0 ? null : slots.map((it) => (it.required ? `${it.name}（必填）` : it.name)).join("、");
}

/** 还不能启动的活动（发布）的状态。 */
export const CATALOG_LATER = "此版本尚未提供";
/** 需求变更这条工作流的键。 */
export const FLOW_CHANGE = "change";
/**
 * 还没有提供的工作流：各站虽已声明，但还没有在页面上走过，不因规则按声明推导而悄悄开放；卡上那一句写 CATALOG_LATER。
 * 需求变更自己的子任务做完之后从这里去掉。
 */
export const FLOWS_NOT_YET: readonly string[] = [FLOW_CHANGE];

/**
 * 给页面的活动目录：任务类型声明的全部工作流与全部活动，各带现在能不能启动。单项活动能不能启动只看数据前提；counts 是工作项各有几个
 * （单项活动的按活动的键、流程的按流程的键），单项活动已经有工作项不拦，再启动是另起一个。工作流能不能启动、从哪一站开始由声明推导
 * （见 flows 一段）。flowItem 是任务里已有的流程工作项：有它时每条工作流都不能启动（一个任务同一时刻至多一个流程工作项）。
 */
export function catalog(defs: { activities: readonly ActivityDef[]; flows: readonly FlowDef[] }, names: Readonly<Record<AssetKey, string>>, facts: AssetFacts,
  counts: Readonly<Record<string, number>> = {}, flowItem: FlowItemRef | null = null): Catalog {
  const activities: CatalogActivity[] = defs.activities.map((one) => {
    const base = {
      key: one.key, name: one.name, stage: one.stage, alone: one.alone, mode: one.mode, mode_name: MODE_NAMES[one.mode], purpose: one.purpose,
      reads: one.reads.map((key) => ({ key, name: readName(key, names) })), writes: one.writes.map((key) => ({ key, name: names[key] })),
      prerequisite_text: prerequisiteText(one.requires), example: one.example, recommended: false, active_count: counts[one.key] ?? 0,
    };
    const blocked = blockedText(one.requires, facts);
    // 发布现在还不能启动：缺前提时说缺什么，不缺时说明这个版本还没有。
    if (one.key === PUBLISH) return { ...base, enabled: false, state: blocked ?? CATALOG_LATER };
    return { ...base, enabled: blocked === null, state: blocked ?? LAUNCH_READY };
  });
  const flows: CatalogFlow[] = defs.flows.map((one) => {
    const blocked = blockedText(one.requires, facts);
    const slot = missingSlot(one.slots, facts);
    const later = FLOWS_NOT_YET.includes(one.key);
    const open = blocked === null && slot === undefined && !later;
    // 起始站：各步里第一个前提都满足、不是只能由用户发起的那一站。
    const stepOf = (key: string) => defs.activities.find((activity) => activity.key === key);
    const start = open ? one.steps.find((key) => { const step = stepOf(key); return step !== undefined && step.mode !== "user_only" && blockedText(step.requires, facts) === null; }) ?? null : null;
    const first = stepOf(one.steps[0] ?? "");
    const unstartable = open && start === null ? (first ? blockedText(first.requires, facts) : null) ?? CATALOG_LATER : null;
    const state = flowItem !== null ? flowExistsText(flowItem, stepOf(flowItem.node)?.name)
      : blocked ?? (slot ? `还没有上传「${slot.name}」` : null) ?? (later ? CATALOG_LATER : null) ?? unstartable ?? LAUNCH_READY;
    return {
      key: one.key, name: one.name, purpose: one.purpose, applies: one.applies,
      nodes: one.steps.map((key) => ({ key, name: stepOf(key)?.name ?? key })), inputs: one.inputs, inputs_text: slotsText(one.slots) ?? one.inputs, missing_slot: slot?.name ?? null, slots: one.slots, cases: one.cases,
      prerequisite_text: prerequisiteText(one.requires), example: one.example,
      // 能启动：前提满足、必填的材料槽位有着落、不在尚未提供的名单里、有一站可以开始，而且任务里没有流程工作项。
      enabled: start !== null && flowItem === null,
      state,
      // 推荐：没有发布过版本时推荐需求分析，发布过之后推荐需求变更；需求再工程不推荐（从资产数量看不出有没有一份既有规格说明）。
      recommended: one.key === FLOW_ANALYSIS ? facts.versions === 0 : one.key === FLOW_CHANGE ? facts.versions > 0 : false,
      at: null,
      start,
      active_count: counts[one.key] ?? 0,
      work_item: flowItem,
    };
  });
  return { flows, activities };
}
