// 活动输入页上由数据算出的东西：地址里的键指的是哪一条工作流程或哪一项单项活动、页上显示哪几块输入、
// 标题旁的一句、现在能不能启动、还缺什么输入、启动时发的字段与替用户发的第一句话。只算，不画。

import { ACTIVITY_START_TEXTS, SCOPE_MAX_LENGTH } from "../../../agent/src/lib/stage";
import type { ActivityCatalog, AssetCell, CatalogActivity, CatalogFlow, StageKey } from "../api/types";

export { SCOPE_MAX_LENGTH };

/** 输入页要启动的那一项：一条工作流程，或者一项单项活动。 */
export type StartTarget = { kind: "flow"; flow: CatalogFlow } | { kind: "activity"; activity: CatalogActivity };

/** 地址里的键在活动目录里指的是哪一项；目录里没有、或者是不能单独启动的活动（逆向解析只在工作流里做）就是 null。 */
export function startTarget(catalog: ActivityCatalog | null | undefined, key: string): StartTarget | null {
  const flow = catalog?.flows.find((one) => one.key === key);
  if (flow) return { kind: "flow", flow };
  const activity = catalog?.activities.find((one) => one.key === key && one.alone !== false);
  return activity ? { kind: "activity", activity } : null;
}

export const targetName = (target: StartTarget): string => (target.kind === "flow" ? target.flow.name : target.activity.name);

/** 一类资产现在的数量；没有资产现状时当作零。 */
export function assetCount(assets: AssetCell[] | undefined, key: string): number {
  return assets?.find((one) => one.key === key)?.count ?? 0;
}

/** 输入页上显示哪几块。 */
export interface InputBlocks {
  materials: boolean;
  knowledge: boolean;
  /** 目标系统描述：它就是会话的第一条消息。 */
  description: boolean;
  /** 范围说明：只有单项活动有。 */
  scope: boolean;
}

/**
 * 工作流程显示项目材料与领域知识库两块，业务说明还空着时另有目标系统描述。单项活动按它的定义里读哪几类资产来定：
 * 读材料的有项目材料一块，读知识库的有领域知识库一块；逐项对话、读业务说明的活动（澄清）在业务说明还空着时有目标系统描述；
 * 另有一块范围说明。hasKnowledge 是这个服务有没有知识库。
 */
export function inputBlocks(target: StartTarget, assets: AssetCell[] | undefined, hasKnowledge: boolean): InputBlocks {
  const blank = assetCount(assets, "description") === 0;
  if (target.kind === "flow") return { materials: true, knowledge: hasKnowledge, description: blank, scope: false };
  const reads = target.activity.reads.map((one) => one.key);
  return {
    materials: reads.includes("materials"),
    knowledge: hasKnowledge && reads.includes("knowledge"),
    description: blank && target.activity.mode === "dialogue" && reads.includes("description"),
    scope: true,
  };
}

/** 启动时发的几项：流程从它现在该开始的那一站开始，另带流程的键；这条流程现在不能启动时是 null。 */
export function startFields(target: StartTarget): { activity: string; in_flow: boolean; flow?: string } | null {
  if (target.kind === "activity") return { activity: target.activity.key, in_flow: false };
  return target.flow.start ? { activity: target.flow.start, in_flow: true, flow: target.flow.key } : null;
}

/** 启动的是哪一项活动（键与名字）：单项活动是它自己，流程是它的起始站；流程现在不能启动时是 null。 */
export function startActivityOf(target: StartTarget): { key: string; name: string } | null {
  if (target.kind === "activity") return target.activity;
  return target.flow.nodes.find((one) => one.key === target.flow.start) ?? null;
}

/**
 * 标题旁的一句。流程写从哪一站开始；不是从第一站开始时（没有材料），补一句有材料时从哪一站开始。单项活动写它的方式（批处理、逐项对话）。
 */
export function startSubtitle(target: StartTarget): string {
  if (target.kind === "activity") return target.activity.mode_name;
  const { flow } = target;
  const start = flow.nodes.find((one) => one.key === flow.start);
  if (!start) return "";
  const first = flow.nodes[0];
  return first && first.key !== start.key ? `从「${start.name}」开始；上传项目材料后从「${first.name}」开始` : `从「${start.name}」开始`;
}

/** 主按钮上的字：「启动某项」。 */
export function startButton(target: StartTarget): string {
  return `启动${targetName(target)}`;
}

/** 任务里已有的流程工作项（一个任务至多一个，不论哪条流程）：要启动的是流程、而任务里已经有一条时给它的记录号，别的情形是 null。 */
export function existingFlowItem(target: StartTarget): number | null {
  return target.kind === "flow" ? target.flow.work_item?.record_id ?? null : null;
}

/** 现在不能启动时写在主按钮旁的一句（缺什么前提，或者已有流程工作项）；能启动是 null。 */
export function blockedLine(target: StartTarget): string | null {
  const one = target.kind === "flow" ? target.flow : target.activity;
  return one.enabled ? null : `现在还不能启动：${one.state}。`;
}

/**
 * 还缺输入时写在主按钮旁的一句；不缺是 null。只有一种情形缺：启动工作流程，业务说明还空着，没有项目材料，又没有写目标系统描述，
 * 这时助手没有可以着手的东西。
 */
export function missingInput(target: StartTarget, blocks: InputBlocks, assets: AssetCell[] | undefined, description: string): string | null {
  if (target.kind !== "flow" || !blocks.description) return null;
  return assetCount(assets, "materials") === 0 && description.trim() === "" ? "请先上传项目材料，或填写目标系统描述。" : null;
}

/** 启动之后替用户发的第一句话：写了目标系统描述就是那段描述，没有写是这项活动的那句固定的话。 */
export function firstMessage(activity: { key: string; name: string }, description: string): string {
  return description.trim() || startText(activity);
}

/** 启动一项活动时那句固定的话：六个阶段各有一句（ACTIVITY_START_TEXTS），别的活动写「请开始某某。」（名字取自活动目录）。 */
export function startText(activity: { key: string; name: string }): string {
  return (ACTIVITY_START_TEXTS as Record<string, string>)[activity.key] ?? `请开始${activity.name}。`;
}

/** 前置条件那一句去掉开头的「前置条件：」，放在「前提」一栏里。 */
export const prerequisiteBody = (text: string): string => text.replace(/^前置条件：/, "");
