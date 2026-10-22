// 切换工作面板与启动确认框上由数据算出的几句话（components/work/SwitchWorkPanel.tsx）。只算，不画。
// 数据是这条会话的整份数据里的 stage（它属于的工作项、现在在哪一站）与带这条会话取的任务状况（全部工作项、资产现状、活动目录）。

import { IDLE } from "../../../agent/src/lib/stage";
import type { CatalogActivity, CatalogFlow, StageView, TaskStatusView, WorkItemView } from "../api/types";
import { activityLabel, flowStations, stageActivity } from "./stage";
import { formatTime } from "./format";
import { startText } from "./startInput";

/** 一个工作项启动的日子：月-日；时刻不详时是空文字。 */
const dayOf = (iso: string | null | undefined): string => (iso ? formatTime(iso).slice(5, 10) : "");

/** 本任务另有几个工作项（不算这条会话的那一个）。 */
export function otherItemCount(status: TaskStatusView | null, own: StageView["work_item"]): number {
  const items = status?.work_items ?? [];
  return items.filter((one) => one.record_id !== own?.record_id).length;
}

/**
 * 面板标题下的一句：这条会话属于哪个工作项、哪天启动的、流程在第几站，本任务另有几个工作项；
 * 自由讨论的会话写它不绑定活动、本任务有几个工作项。
 */
export function panelSubtitle(stage: StageView | null | undefined, status: TaskStatusView | null): string {
  const own = stage?.work_item ?? null;
  const others = otherItemCount(status, own);
  if (!own) return `本会话是自由讨论，不绑定活动 · ${others > 0 ? `本任务有 ${others} 个工作项` : "本任务还没有工作项"}`;
  const day = dayOf(own.started_at);
  const station = stage ? ownStation(stage, status) : null;
  const at = station ? ` · 位于第 ${station.ordinal} 站「${station.name}」` : "";
  return `本会话属于工作项「${own.name}」${day ? `（${day}）` : ""}${at} · ${others > 0 ? `本任务另有 ${others} 个工作项` : "本任务没有别的工作项"}`;
}

/**
 * 这条会话的流程工作项在哪一站：第几站（后端任务状况给的 ordinal，没有时按目录里这条流程的各站数）、站名与下一站（取自活动目录，
 * 跳过只能由用户发起的那一站）。不是流程的工作项时是 null。
 */
export function ownStation(stage: StageView, status?: TaskStatusView | null): { ordinal: number; name: string; next: string | null } | null {
  const own = stage.work_item;
  if (!own || own.kind !== "flow" || !stage.node) return null;
  const catalog = stage.catalog ?? status?.catalog ?? null;
  const stations = flowStations(catalog, own.flow);
  const at = stations.findIndex((one) => one.key === stage.node);
  const ordinal = status?.work_items?.find((one) => one.record_id === own.record_id)?.ordinal ?? (at >= 0 ? at + 1 : null);
  if (ordinal === null) return null;
  return { ordinal, name: at >= 0 ? stations[at].name : activityLabel(stage.node, catalog), next: at >= 0 ? stations[at + 1]?.name ?? null : null };
}

/** 第一组「本会话的工作项」的小标题：流程写「流程名 · 所在的一站」，单项活动写活动名。 */
export function ownItemHeading(stage: StageView, status?: TaskStatusView | null): string {
  const own = stage.work_item!;
  const station = ownStation(stage, status);
  return station ? `${own.name} · ${station.name}` : own.name;
}

/** 第一组卡片上的说明：流程写在第几站、做完之后助手提议进入哪一站；单项活动写做够了怎样办。 */
export function ownItemLine(stage: StageView, status?: TaskStatusView | null): string {
  const station = ownStation(stage, status);
  if (station) {
    return `现在在第 ${station.ordinal} 站「${station.name}」。${station.next ? `完成后助手将提议进入「${station.next}」。` : "这是最后一站，完成后请你过目。"}`;
  }
  return "单项活动：做够了由助手在回复里汇报做完，不提议下一站；工作项照旧留着，可以接着说。";
}

/** 「继续某项活动」：关掉面板，留在本会话。 */
export const continueLabel = (stage: StageView): string => `继续${stage.current === IDLE ? stage.work_item?.name ?? "" : activityLabel(stageActivity(stage), stage.catalog)}`;

/** 「其他活动」里能点的一项：单项活动或者工作流程。 */
export type LaunchPick = { kind: "activity"; activity: CatalogActivity } | { kind: "flow"; flow: CatalogFlow };

/** 确认框的标题。 */
export const confirmTitle = (pick: LaunchPick): string =>
  pick.kind === "activity" ? `启动活动「${pick.activity.name}」` : `启动工作流程「${pick.flow.name}」`;

/** 方式那半句：批处理一次做完再汇报，逐项对话一项一项问。 */
const MODE_HOW: Record<string, string> = { batch: "助手一次完成后汇报。", dialogue: "助手逐项与你对话。", user_only: "只能由你发起。" };

/** 确认框标题下的一句：目的与方式；流程写从哪一站开始。 */
export function confirmPurpose(pick: LaunchPick): string {
  if (pick.kind === "activity") return `${pick.activity.purpose}${pick.activity.mode_name}：${MODE_HOW[pick.activity.mode] ?? ""}`;
  const start = pick.flow.nodes.find((one) => one.key === pick.flow.start);
  return `${pick.flow.purpose}${start ? `从「${start.name}」开始，每站完成后助手提议下一站，由你确认。` : ""}`;
}

/**
 * 「这样启动之后」的几行：本会话怎样（不受影响，留在会话菜单里）、新会话怎样、受影响的条目（这项活动要写分析模型时才有）、
 * 已有的工作项（同一项活动已经有工作项时才有，写出它们各自的范围）。
 */
export function confirmEffects(pick: LaunchPick, stage: StageView | null | undefined, status: TaskStatusView | null): { label: string; text: string }[] {
  const own = stage?.work_item ?? null;
  const here = own
    ? `不受影响：「${own.name}」${stage && ownStation(stage, status) ? `仍在「${ownStation(stage, status)!.name}」` : "照旧留着"}；本会话留在会话菜单里，随时回来。`
    : "不受影响：本会话是自由讨论，留在会话菜单里，随时回来。";
  const rows = [
    { label: "本会话", text: here },
    { label: "新会话", text: "新建一条属于这个工作项的会话，助手从干净的上下文开始，带着下面的范围说明。" },
  ];
  if (pick.kind === "activity" && pick.activity.writes.some((one) => one.key === "models")) {
    rows.push({ label: "受影响的条目", text: "重画的模型若被条目依据，这些条目自动标为待核实，回到写条目时由助手修正。" });
  }
  if (pick.kind === "activity") {
    const same = (status?.work_items ?? []).filter((one: WorkItemView) => one.kind === "activity" && one.activity === pick.activity.key);
    if (same.length > 0) {
      const scopes = same.map((one) => one.scope ?? "没有写范围").join("；");
      rows.push({ label: "已有的工作项", text: `「${pick.activity.name}」已有 ${same.length} 个工作项（范围：${scopes}）。要接着做它，请取消并从任务起点页打开它的会话；要另做一次，继续。` });
    }
  }
  return rows;
}

/** 确认框的主按钮。 */
export const confirmButton = (pick: LaunchPick): string => `启动${pick.kind === "activity" ? pick.activity.name : pick.flow.name}（新建会话）`;

/** 启动之后替用户在新会话里发的第一句话（与活动输入页没有写目标系统描述时相同）。 */
export function confirmFirstMessage(pick: LaunchPick): string | null {
  const activity = pick.kind === "activity" ? pick.activity : pick.flow.nodes.find((one) => one.key === pick.flow.start);
  return activity ? startText(activity) : null;
}

/** 发给启动接口的那几项。流程从它的起始站启动；流程现在不能启动（没有起始站）时为 null。 */
export function confirmFields(pick: LaunchPick, scope: string): { activity: string; in_flow: boolean; flow?: string; scope?: string } | null {
  const note = scope.trim();
  const extra = note ? { scope: note } : {};
  if (pick.kind === "activity") return { activity: pick.activity.key, in_flow: false, ...extra };
  return pick.flow.start ? { activity: pick.flow.start, in_flow: true, flow: pick.flow.key, ...extra } : null;
}
