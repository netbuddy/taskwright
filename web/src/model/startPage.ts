// 任务起点页上由数据算出的几句话与去向：任务名旁的一句状态、每格资产由哪些活动产出、工作流程卡上的标签、工作项卡上的几句，
// 以及从任务列表打开一个任务时该去起点页还是工作台。只算，不画。

import { api } from "../api/client";
import type { AssetCell, CatalogFlow, SessionListEntry, TaskStatusView, WorkItemView } from "../api/types";
import { formatTime, formatTimeShort } from "./format";
import { byRecentActivity } from "../components/task/SessionList";
import { href } from "../router";

/** 六类资产是不是都还空着：这时起点页显示「三步开始」指引。没有资产现状（早先的后端、没有阶段的任务）不算空着。 */
export function allAssetsEmpty(assets: AssetCell[] | undefined): boolean {
  return !!assets && assets.length > 0 && assets.every((one) => one.count === 0);
}

/**
 * 任务名旁的一句状态：没有工作项、六类资产又都空着写「尚无需求资产」；否则写工作项的个数与发布的情形，
 * 例如「3 个工作项 · 未发布」「没有工作项 · 已发布第 1 版」。任务一级没有「当前活动」：工作项可以有几个，一样一样列在下面。
 * 没有任务状况时不写。
 */
export function stateLine(status: TaskStatusView | null): string {
  if (!status) return "";
  const items = status.work_items ?? [];
  if (items.length === 0 && allAssetsEmpty(status.assets)) return "尚无需求资产";
  const versions = status.assets?.find((one) => one.key === "versions");
  return `${items.length > 0 ? `${items.length} 个工作项` : "没有工作项"} · ${versions && versions.count > 0 ? `已发布${versions.text}` : "未发布"}`;
}

/** 一格资产下面写由哪些活动产出；材料没有产出它的活动，写来源是上传。 */
export function producedLine(cell: AssetCell): string {
  return cell.produced_by.length > 0 ? cell.produced_by.join("、") : "来源：上传";
}

/** 这条流程是不是任务里已有的那个流程工作项（一个任务至多一个流程工作项，活动目录的每条流程都带着它）。 */
export function flowInProgress(flow: CatalogFlow): boolean {
  return !!flow.work_item && flow.work_item.name === flow.name;
}

/** 后端给的「已有流程工作项……」那一句状态的开头（agent/src/lib/stage.ts 的 flowExistsText）：别的流程正在进行，这一条因此不能启动。 */
const FLOW_TAKEN = "已有流程工作项";
/** 后端给的「此版本尚未提供」那一句状态（agent/src/lib/activity_catalog.ts 的 CATALOG_LATER）：前提满足，但这一版还不能启动这条流程。 */
const FLOW_LATER = "此版本尚未提供";

/**
 * 工作流程卡标题旁的标签：这条流程已有工作项写「已在进行」；前提满足而这一版还没有提供写「此版本尚未提供」（例如有了发布版本之后的需求变更）；
 * 缺前提不能启动写「前置条件未满足」；能启动而且推荐的写「推荐」；
 * 别的情形不写（例如另一条流程正在进行，这一条因此不能启动：卡片底部写原因）。
 */
export function flowTag(flow: CatalogFlow): { text: string; kind: "now" | "rec" | "off" } | null {
  if (flowInProgress(flow)) return { text: "已在进行", kind: "now" };
  if (!flow.enabled && flow.state === FLOW_LATER) return { text: FLOW_LATER, kind: "off" };
  if (!flow.enabled && !flow.state.startsWith(FLOW_TAKEN)) return { text: "前置条件未满足", kind: "off" };
  return flow.enabled && flow.recommended ? { text: "推荐", kind: "rec" } : null;
}

/** 已有工作项的流程卡底部那一句：在第几站。站名取自流程的各站，第几站照各站的次序数。 */
export function flowPositionLine(flow: CatalogFlow): string {
  const at = flow.work_item ? flow.nodes.findIndex((one) => one.key === flow.work_item!.node) : -1;
  return at >= 0 ? `已在进行，位于第 ${at + 1} 站「${flow.nodes[at].name}」` : "已在进行";
}

/** 卡片右下角提示的字。 */
export const START_ARROW = "启动 →";
/** 能进输入页、但还不能启动的流程卡右下角的字（例如需求再工程缺必填的材料：进去补上传）。 */
export const INPUT_ARROW = "去提供输入 →";

/** 工作项卡标题下的一句：哪一种、哪天启动的（月-日）；流程的工作项另注明它是本任务唯一的流程工作项。 */
export function workItemMeta(item: WorkItemView): string {
  const day = item.started_at ? formatTime(item.started_at).slice(5, 10) : "";
  return `${day ? `${day} 启动` : "启动时刻不详"}${item.kind === "flow" ? " · 本任务唯一的流程工作项" : ""}`;
}

/** 流程的工作项现在在哪一站：「现在在第 N 站「X」」；单项活动的没有这一句（返回空文字）。 */
export function workItemPosition(item: WorkItemView): string {
  return item.kind === "flow" && item.ordinal !== null ? `现在在第 ${item.ordinal} 站「${item.activity_name}」。` : "";
}

/** 工作项卡上会话的一行：几条会话，最近有动静的是哪一条、什么时候；都还没有说过话时写明。 */
export function workItemSessionsLine(item: WorkItemView): string {
  const latest = item.latest_session;
  if (item.session_count === 0 || !latest) return "还没有会话";
  if (!latest.last_active_at) return `${item.session_count} 条会话 · 还没有说过话`;
  return `${item.session_count} 条会话 · 最近 ${formatTimeShort(latest.last_active_at)}「${latest.name ?? item.session_name}」`;
}

/** 删除一个工作项之前确认框里的那段话：会归档几条会话、归档之后怎样；流程的工作项另说明删了之后怎样重新开始。 */
export function deleteConfirmText(item: Pick<WorkItemView, "name" | "kind" | "session_count">): string {
  const archived = item.session_count > 0 ? `它的 ${item.session_count} 条会话将归档：会话列表里默认不再列出，打开后按自由讨论办。` : "它还没有会话。";
  const flow = item.kind === "flow" ? `删除之后可以重新启动「${item.name}」，但原来所在的一站不保留。` : "";
  return `${archived}需求资产与修订都不受影响。${flow}删除之后不能恢复。`;
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
