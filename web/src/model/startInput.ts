// 活动输入页上由数据算出的东西：地址里的键指的是哪一条工作流程或哪一项单项活动、页上显示哪几块输入、
// 标题旁的一句、现在能不能开展、还缺什么输入、开展时发的字段与替用户发的第一句话。只算，不画。

import { ACTIVITY_START_TEXTS, SCOPE_MAX_LENGTH } from "../../../agent/src/lib/stage";
import type { ActivityCatalog, AssetCell, CatalogActivity, CatalogFlow, StageKey, TaskStatusView } from "../api/types";

export { SCOPE_MAX_LENGTH };

/** 输入页要开展的那一项：一条工作流程，或者一项单项活动。 */
export type StartTarget = { kind: "flow"; flow: CatalogFlow } | { kind: "activity"; activity: CatalogActivity };

/** 地址里的键在活动目录里指的是哪一项；目录里没有就是 null。 */
export function startTarget(catalog: ActivityCatalog | null | undefined, key: string): StartTarget | null {
  const flow = catalog?.flows.find((one) => one.key === key);
  if (flow) return { kind: "flow", flow };
  const activity = catalog?.activities.find((one) => one.key === key);
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

/** 开展时发的两项：流程从它现在该开始的那一站开始；这条流程现在不能开展时是 null。 */
export function startFields(target: StartTarget): { activity: StageKey; in_flow: boolean } | null {
  if (target.kind === "activity") return { activity: target.activity.key as StageKey, in_flow: false };
  return target.flow.start ? { activity: target.flow.start, in_flow: true } : null;
}

/**
 * 标题旁的一句。流程写从哪一站开始或接着；没有走过、又不是从第一站开始时（没有材料），补一句有材料时从哪一站开始。
 * 单项活动写它的方式（批处理、逐项对话）。
 */
export function startSubtitle(target: StartTarget): string {
  if (target.kind === "activity") return target.activity.mode_name;
  const { flow } = target;
  const start = flow.nodes.find((one) => one.key === flow.start);
  if (!start) return "";
  if (flow.at !== null) return `从「${start.name}」接着`;
  const first = flow.nodes[0];
  return first && first.key !== start.key ? `从「${start.name}」开始；上传项目材料后从「${first.name}」开始` : `从「${start.name}」开始`;
}

/** 主按钮上的字：走过的流程是「继续」，别的是「开展」。 */
export function startButton(target: StartTarget): string {
  return `${target.kind === "flow" && target.flow.at !== null ? "继续" : "开展"}${targetName(target)}`;
}

/** 这一项是不是正在进行（单独开展着，或者在工作流程里做着）。 */
export function inProgress(target: StartTarget): boolean {
  return (target.kind === "flow" ? target.flow : target.activity).state.startsWith("正在");
}

/** 现在不能开展时写在主按钮旁的一句（正在进行，或者缺什么前提）；能开展是 null。 */
export function blockedLine(target: StartTarget): string | null {
  const one = target.kind === "flow" ? target.flow : target.activity;
  if (one.enabled) return null;
  return one.state.startsWith("正在") ? `「${one.name}」${one.state}。` : `现在还不能开展：${one.state}。`;
}

/**
 * 还缺输入时写在主按钮旁的一句；不缺是 null。只有一种情形缺：开展工作流程，业务说明还空着，没有项目材料，又没有写目标系统描述，
 * 这时助手没有可以着手的东西。
 */
export function missingInput(target: StartTarget, blocks: InputBlocks, assets: AssetCell[] | undefined, description: string): string | null {
  if (target.kind !== "flow" || !blocks.description) return null;
  return assetCount(assets, "materials") === 0 && description.trim() === "" ? "请先上传项目材料，或填写目标系统描述。" : null;
}

/** 开展之后替用户发的第一句话：写了目标系统描述就是那段描述，没有写是这项活动的那句固定的话。 */
export function firstMessage(activity: StageKey, description: string): string {
  return description.trim() || ACTIVITY_START_TEXTS[activity];
}

/** 有别的活动在进行时，「开展后」一块里先写的一句；没有、或者正在进行的就是要开展的这一项，是 null。 */
export function endsCurrentLine(status: TaskStatusView | null, target: StartTarget): string | null {
  if (!status || status.activity.kind === "idle") return null;
  if (target.kind === "activity" && target.activity.key === status.activity.key && status.activity.kind === "activity") return null;
  return `当前活动「${status.activity.name}」随即结束。`;
}

/** 前置条件那一句去掉开头的「前置条件：」，放在「前提」一栏里。 */
export const prerequisiteBody = (text: string): string => text.replace(/^前置条件：/, "");
