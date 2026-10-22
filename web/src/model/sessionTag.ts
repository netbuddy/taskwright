// 会话清单（顶栏的会话菜单、任务起点页的会话一节）上每条会话旁的那个标签：它属于哪个工作项。
// 流程的工作项写「需求分析 · 写条目」（流程名加现在所在的站），单项活动的工作项写活动名，不属于任何工作项的写「自由讨论」，
// 归档的会话（它的工作项被删除了）写「已归档」。工作项没有终点，没有「已做完」这种标签。

import type { SessionListEntry } from "../api/types";
import { STAGE_NAMES } from "./stage";

export const FREE_TAG = "自由讨论";
export const ARCHIVED_TAG = "已归档";
/** 清单底部的开关：归档的会话默认不列出。 */
export const SHOW_ARCHIVED = "显示已归档的会话";
export const SHOW_ARCHIVED_NOTE = "删除工作项时它的会话归档，默认不列出";

/** 一条会话旁的标签；早先的后端不给 work_item 时是 null，不画标签。 */
export function sessionTag(session: SessionListEntry): string | null {
  if (session.archived) return ARCHIVED_TAG;
  if (session.work_item === undefined) return null;
  const work = session.work_item;
  if (!work) return FREE_TAG;
  // 站名：后端给的活动名（取自任务类型的声明），早先的后端不给时是阶段的名字，再没有就是活动标识符本身。
  return work.kind === "flow" ? `${work.name} · ${work.activity_name ?? (STAGE_NAMES as Record<string, string>)[work.activity] ?? work.activity}` : work.name;
}

/** 列不列归档的会话：开着时，未归档的在前（照原来的次序），归档的接在后面；关着时只有未归档的。 */
export function withArchived(sessions: SessionListEntry[], archived: SessionListEntry[] | null): SessionListEntry[] {
  if (!archived) return sessions;
  const shown = new Set(sessions.map((one) => one.session_id));
  return [...sessions, ...archived.filter((one) => one.archived && !shown.has(one.session_id))];
}
