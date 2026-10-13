// 任务起点页上由数据算出的几句话与去向：任务名旁的一句状态、每格资产由哪些活动产出、工作流程卡上的标签，
// 以及从任务列表打开一个任务时该去起点页还是工作台。只算，不画。

import { api } from "../api/client";
import type { AssetCell, CatalogFlow, SessionListEntry, TaskStatusView } from "../api/types";
import { byRecentActivity } from "../components/task/SessionList";
import { href } from "../router";

/** 六类资产是不是都还空着：这时起点页显示「三步开始」指引。没有资产现状（早先的后端、没有阶段的任务）不算空着。 */
export function allAssetsEmpty(assets: AssetCell[] | undefined): boolean {
  return !!assets && assets.length > 0 && assets.every((one) => one.count === 0);
}

/**
 * 任务名旁的一句状态：六类资产都空着写「尚无需求资产」；有活动在进行写「当前活动：某项活动」；
 * 空闲而且发布过写「已发布第 N 版 · 当前无活动」；空闲、有内容、没有发布过写「当前无活动」。没有任务状况时不写。
 */
export function stateLine(status: TaskStatusView | null): string {
  if (!status) return "";
  if (allAssetsEmpty(status.assets) && status.activity.kind === "idle") return "尚无需求资产";
  if (status.activity.kind !== "idle") return `当前活动：${status.activity.name}`;
  const versions = status.assets?.find((one) => one.key === "versions");
  return versions && versions.count > 0 ? `已发布${versions.text} · 当前无活动` : "当前无活动";
}

/** 一格资产下面写由哪些活动产出；材料没有产出它的活动，写来源是上传。 */
export function producedLine(cell: AssetCell): string {
  return cell.produced_by.length > 0 ? cell.produced_by.join("、") : "来源：上传";
}

/** 工作流程卡标题旁的标签：正在进行、推荐、前置条件未满足；别的情形不写。 */
export function flowTag(flow: CatalogFlow): { text: string; kind: "now" | "rec" | "off" } | null {
  if (flow.state === FLOW_ACTIVE) return { text: FLOW_ACTIVE, kind: "now" };
  if (!flow.enabled) return { text: "前置条件未满足", kind: "off" };
  return flow.recommended ? { text: "推荐", kind: "rec" } : null;
}

/** 后端给的「正在进行」那一句状态（agent/src/lib/stage.ts 的 LAUNCH_ACTIVE）。 */
export const FLOW_ACTIVE = "正在进行";

/** 工作流程卡右下角提示的字：没有走过是「开展」，走过是「继续」。 */
export function flowButton(flow: CatalogFlow): string {
  return flow.at === null ? "开展" : "继续";
}

/** 流程走过时卡片底部的一句：从哪一站接着。没有走过不写。 */
export function flowResumeNote(flow: CatalogFlow): string {
  const at = flow.nodes.find((one) => one.key === flow.at);
  return at ? `从「${at.name}」接着` : "";
}

/** 最近活动的那条会话；一条都没有是 null。 */
export function latestSession(sessions: SessionListEntry[]): SessionListEntry | null {
  const rows = byRecentActivity(sessions);
  return rows.find((one) => one.last_active_at) ?? rows[0] ?? null;
}

/**
 * 从任务列表或侧栏打开一个任务时去哪里：业务说明至少有一节、又有会话，就进工作台（最近活动的那条会话）；
 * 否则进任务起点页。与有没有活动在进行无关。取不到任务状况时也进起点页。
 */
export async function taskEntryHref(taskId: string): Promise<string> {
  try {
    const { status } = await api.taskStatus(taskId);
    const sections = status?.assets?.find((one) => one.key === "description")?.count ?? 0;
    if (sections > 0) {
      const session = latestSession(await api.listSessions(taskId));
      if (session) return href.work(taskId, session.session_id);
    }
  } catch {
    // 取不到：进起点页，那里会照实显示读不到的原因
  }
  return href.task(taskId);
}

/** 从任务列表或侧栏打开一个任务：照 taskEntryHref 定的去向跳过去。 */
export function openTask(taskId: string, to: (address: string) => void): void {
  void taskEntryHref(taskId).then(to);
}
