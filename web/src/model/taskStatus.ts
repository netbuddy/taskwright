// 对话区「工作进展」卡上每一行怎样写，与新会话开头那一行。数据是后端的状况接口算好的（GET /tasks/{task_id}/status?session=…，
// 接口叫「任务状况」），这里只把它变成要画的句子，不另取数据。接口里的 activity 说的是这条会话：它属于流程的工作项、单项活动的工作项，
// 或者不属于任何工作项（自由讨论）。早先卡上另有一节「开展一项活动」，工作项与会话绑定之后退役了，启动工作在任务起点页与切换工作面板里。

import { STATUS_NEXT_TEXT } from "../../../agent/src/lib/stage";
import type { Task, TaskStatusView } from "../api/types";
import type { AssetCell, CatalogFlow, WorkItemBrief, WorkItemView } from "../api/types";
import { formatTime } from "./format";
import { flowName, lampShort } from "./stage";

export { STATUS_NEXT_TEXT };

export const STATUS_TITLE = "工作进展";
export const STATUS_BUTTON = "工作进展";
/** 输入框里打这一句，与点「工作进展」入口相同：不发给助手。 */
export const STATUS_COMMAND = "/状况";
/** 替用户发那句固定的话（STATUS_NEXT_TEXT），请助手据任务现状汇报、说下一步。 */
export const STATUS_NEXT_LABEL = "请助手汇报当前状况";
/** 打开切换工作面板的那个按钮。 */
export const OTHER_WORK_LABEL = "其他工作…";
/** 用户调出工作进展时对话区里的那一行。 */
export const STATUS_CALLED_LINE = "界面操作：用户调出工作进展";
/** 自由讨论的会话开头那一行。 */
export const FREE_SESSION_LINE = "新会话 · 自由讨论（不绑定活动）";
export const NOT_STARTED = "尚未开始";
export const NOTHING_MISSING = "这一段的几项都齐了";

/** 「月-日 时:分」：状况卡上的时刻不写年份。 */
export function shortMoment(iso: string | null | undefined): string {
  const full = formatTime(iso);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(full) ? full.slice(5) : full;
}

/**
 * 会话开头的那一行：属于工作项的会话写「新会话 · 属于工作项「整理建模」（10-13 09:02）」，括号里是工作项启动的时刻；
 * 自由讨论的会话写「新会话 · 自由讨论（不绑定活动）」。
 */
export function newSessionLine(work: WorkItemBrief | null | undefined): string {
  if (!work) return FREE_SESSION_LINE;
  return `新会话 · 属于工作项「${work.name}」${work.started_at ? `（${shortMoment(work.started_at)}）` : ""}`;
}

/** 标题：「工作进展 · 10-13 09:10」，时刻是取数的那一刻。 */
export function statusTitle(status: Pick<TaskStatusView, "generated_at">): string {
  return `${STATUS_TITLE} · ${shortMoment(status.generated_at)}`;
}
/** 标题后面的小字：这张卡是程序算的。 */
export const STATUS_SUBTITLE = "程序据任务记录生成";

/** 「版本」一行：发布过写「已发布第 N 版」，没有写「未发布」；没有资产现状（早先的后端）时是 null，不画这一行。 */
export function versionLine(assets: AssetCell[] | undefined): string | null {
  const cell = assets?.find((one) => one.key === "versions");
  if (!cell) return null;
  return cell.count > 0 ? `已发布${cell.text}` : "未发布";
}

/** 「工作项」一行：「3 个工作项：需求分析（第 2 站「澄清」）、整理建模、澄清」；没有时写「没有工作项」。早先的后端不给工作项清单时是 null。 */
export function workItemsLine(items: WorkItemView[] | undefined): string | null {
  if (!items) return null;
  if (items.length === 0) return "没有工作项";
  const names = items.map((one) => (one.kind === "flow" && one.ordinal ? `${one.name}（第 ${one.ordinal} 站「${one.activity_name}」）` : one.name));
  return `${items.length} 个工作项：${names.join("、")}`;
}

/** 业务说明、模型、需求条目三行取资产现状那一格：「9 节，无待澄清事项」「4 张，均已查看」；没有那一格时是 null（照早先的写法）。 */
export function assetLine(assets: AssetCell[] | undefined, key: string): string | null {
  const cell = assets?.find((one) => one.key === key);
  if (!cell) return null;
  return cell.note ? `${cell.text}，${cell.note}` : cell.text;
}

/**
 * 卡上的主按钮：任务的推荐流程现在能启动时是「启动需求分析」或「启动需求变更」（进它的输入页）；已有流程工作项、推荐的流程还不能启动时没有。
 */
export function recommendedFlow(flows: CatalogFlow[] | undefined): CatalogFlow | null {
  return flows?.find((one) => one.recommended && one.enabled) ?? null;
}

/** 主按钮下面的一句：启动会新建会话，本会话怎样。sessionWork 是本会话的工作项名；自由讨论的会话是 null。 */
export function launchNote(flow: CatalogFlow, sessionWork: string | null): string {
  return `「启动${flow.name}」会新建一条属于它的会话；${sessionWork ? `本会话照旧属于工作项「${sessionWork}」` : "本会话留作自由讨论"}。`;
}

/** 第一行的标签。 */
export const SESSION_ROW_LABEL = "本会话";

/**
 * 「本会话」一行：流程的工作项写「需求分析 · 第 4 站「写条目」 · 10-13 09:02 进入」，没有换过站时写启动的时刻；
 * 单项活动的工作项写「整理建模 · 10-13 09:02 启动」；自由讨论的会话写「自由讨论（不绑定活动）」。
 */
export function activityLine(activity: TaskStatusView["activity"]): string {
  if (activity.kind === "idle") return "自由讨论（不绑定活动）";
  const at = activity.moved_at ? shortMoment(activity.moved_at) : "";
  if (activity.kind === "activity") return `${activity.name}${at ? ` · ${at} 启动` : ""}`;
  return `${flowName(activity.flow)} · 第 ${activity.ordinal} 站「${activity.name}」${at ? ` · ${at} 进入` : ""}`;
}

/** 「业务说明」一行：一共几节、各章几节、未归类几页；待澄清另给，页面上加重。一节都没有时写尚未开始。 */
export function descriptionLine(description: TaskStatusView["description"]): { text: string; open: string | null } {
  const open = description.open_questions > 0 ? `${description.open_questions} 处待澄清` : null;
  if (description.sections === 0) return { text: NOT_STARTED, open };
  const parts = description.chapters.map((one) => `${one.name} ${one.sections}`);
  if (description.unsorted > 0) parts.push(`未归类 ${description.unsorted}`);
  return { text: `${description.sections} 节：${parts.join(" · ")}`, open };
}

/** 「模型」一行：每种图几张；一张都没有时写尚未开始。 */
export function modelsLine(models: TaskStatusView["models"]): string {
  return models.length ? models.map((one) => `${one.name} ${one.count}`).join(" · ") : NOT_STARTED;
}

/** 「需求条目」一行：有条目的集合各写几条、其中几条已确认；都没有条目时写尚未开始。 */
export function itemsLine(items: TaskStatusView["items"]): string {
  const written = items.filter((one) => one.total > 0);
  return written.length ? written.map((one) => `${one.collection} ${one.total} 条，已确认 ${one.viewed} 条`).join(" · ") : NOT_STARTED;
}

/** 「这一段还差」一行：没有通过的灯各取前半句（与阶段条上的写法相同），去掉句号用分号接起来；都通过时写齐了。 */
export function missingLine(missing: TaskStatusView["missing"]): string {
  if (!missing.length) return NOTHING_MISSING;
  return missing.map((one) => lampShort(one.summary).replace(/[。.]+$/, "")).join("；");
}

/** 一条会话里还没有人说过话：没有用户的话，也没有助手的回复。会话一开头系统放的任务现状说明、界面操作的通知不算。 */
export function nobodySpoke(messages: readonly { type: string }[]): boolean {
  return !messages.some((one) => one.type === "user_message" || one.type === "assistant_reply");
}

/**
 * 新建会话的开头要不要放一张工作进展卡：任务有阶段、还在进行中，这条会话里还没有人说过话（也没有更早的一段、没有正在发送的话）。
 * spoken 是这条会话里用户的话与助手的回复一共几条（见 nobodySpoke）。
 */
export function wantsOpeningStatus(task: Task | null, spoken: number, outgoing: number, hasEarlier: boolean, closed: boolean): boolean {
  return !!task?.stage && !closed && spoken === 0 && outgoing === 0 && !hasEarlier;
}
