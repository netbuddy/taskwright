// 任务状况卡上每一行怎样写。数据是后端的状况接口算好的（GET /tasks/{task_id}/status），这里只把它变成要画的句子，不另取数据。
// 接口与这里的字段按「当前活动」命名（activity）：现在它总是一个阶段，页面上那一行的标签写「阶段」。

import { STATUS_NEXT_TEXT } from "../../../agent/src/lib/stage";
import type { Task, TaskStatusView } from "../api/types";
import { formatTime } from "./format";
import { isDeprecated, pagesOf } from "./overall";
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

/** 「阶段」一行：在哪个阶段、是第几个、最近一次是谁在什么时候移进来的；一次都没有移过时写任务从这里开始。 */
export function activityLine(activity: TaskStatusView["activity"]): string {
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

/**
 * 新建会话的开头要不要放一张状况卡：任务有阶段、还在进行中，这条会话一条消息都没有（也没有更早的一段、没有正在发送的话），
 * 而且总体分析里已经有在用的主题页。新任务的第一条会话还没有主题页，不放：那时中栏有两个开头的按钮。
 */
export function wantsOpeningStatus(task: Task | null, messages: number, outgoing: number, hasEarlier: boolean, closed: boolean): boolean {
  if (!task?.stage || closed || messages > 0 || outgoing > 0 || hasEarlier) return false;
  return pagesOf(task).some((page) => !isDeprecated(page));
}
