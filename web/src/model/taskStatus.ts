// 任务状况卡上每一行怎样写。数据是后端的状况接口算好的（GET /tasks/{task_id}/status），这里只把它变成要画的句子，不另取数据。
// 接口与这里的字段按「当前活动」命名（activity）：任务在首次分析流程里的某个阶段时，页面上那一行的标签写「阶段」；
// 用户单独开展一项活动、任务空闲时写「活动」。卡上另有一节「开展一项活动」（launch），三组：正在进行的、流程、单独开展的六项。

import { STATUS_NEXT_TEXT } from "../../../agent/src/lib/stage";
import type { Task, TaskStatusView } from "../api/types";
import { formatTime } from "./format";
import { lampShort } from "./stage";

export { STATUS_NEXT_TEXT };

export const STATUS_TITLE = "任务状况";
export const STATUS_BUTTON = "任务状况";
/** 输入框里打这一句，与点「任务状况」入口相同：不发给助手。 */
export const STATUS_COMMAND = "/状况";
export const STATUS_NEXT_LABEL = "请助手说明下一步";
/** 用户调出任务状况时对话区里的那一行。 */
export const STATUS_CALLED_LINE = "界面操作：用户调出任务状况";
/** 新建会话的开头，状况卡前面的那一行小字。 */
export const NEW_SESSION_LINE = "新建会话 · 助手从干净的上下文开始，交付物还是这一份";
export const NOT_STARTED = "尚未开始";
export const NOTHING_MISSING = "这一段的几项都齐了";

/** 「月-日 时:分」：状况卡上的时刻不写年份。 */
export function shortMoment(iso: string | null | undefined): string {
  const full = formatTime(iso);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(full) ? full.slice(5) : full;
}

/** 标题后面的小字：这张卡是程序算的，什么时候算的。 */
export function statusSubtitle(status: Pick<TaskStatusView, "generated_at">): string {
  return `程序据任务记录生成 · ${shortMoment(status.generated_at)}`;
}

/** 那一行的标签：在流程里的阶段写「阶段」，单独开展的活动与空闲写「活动」。 */
export function activityLabel(activity: TaskStatusView["activity"]): string {
  return activity.kind === "stage" ? "阶段" : "活动";
}

/** 「开展一项活动」一节的标题与各组的标签。 */
export const LAUNCH_TITLE = "开展一项活动";
export const LAUNCH_CURRENT_LABEL = "正在进行";
export const LAUNCH_FLOW_LABEL = "流程";
export const LAUNCH_ALONE_LABEL = "单独开展";
export const LAUNCH_LATER_LABEL = "以后";
/** 这一节下面的一句：不选也可以。 */
export const LAUNCH_HINT = "不选也可以，直接在下面说话就行。";

/**
 * 「阶段」一行：在哪个阶段、是第几个、最近一次是谁在什么时候移进来的；一次都没有移过时写任务从这里开始。
 * 用户单独开展的活动写「整理建模（单独开展）· 时刻 由你开始」；空闲只写「空闲」。
 */
export function activityLine(activity: TaskStatusView["activity"]): string {
  if (activity.kind === "idle") return activity.name;
  if (activity.kind === "activity") {
    const by = activity.moved_by === "executor" ? "助手" : "你";
    return `${activity.name}（单独开展）${activity.moved_at ? `· ${shortMoment(activity.moved_at)} 由${by}开始` : ""}`;
  }
  const head = `${activity.name}（第 ${activity.ordinal} 阶段）`;
  if (!activity.moved_by || !activity.moved_at) return `${head}· 任务从这个阶段开始`;
  return `${head}· ${shortMoment(activity.moved_at)} 由${activity.moved_by === "user" ? "你" : "助手"}移入`;
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
 * 新建会话的开头要不要放一张状况卡：任务有阶段、还在进行中，这条会话里还没有人说过话（也没有更早的一段、没有正在发送的话）。
 * 新任务的第一条会话也放：任务从空闲起，卡上「开展一项活动」一节是开始工作的地方。
 * spoken 是这条会话里用户的话与助手的回复一共几条（见 nobodySpoke）。
 */
export function wantsOpeningStatus(task: Task | null, spoken: number, outgoing: number, hasEarlier: boolean, closed: boolean): boolean {
  return !!task?.stage && !closed && spoken === 0 && outgoing === 0 && !hasEarlier;
}
