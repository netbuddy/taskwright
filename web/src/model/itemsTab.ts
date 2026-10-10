// 条目区那一排页签：排成什么次序、一打开停在哪一个、记住用户上次停在哪一个。
// 次序：任务定义里有名叫「总体分析」的集合时把它排在最前，其余照任务定义里的先后；图表页签总在各集合之后。
// 记住：每个任务各记一个，存在浏览器本地；读写失败时当作没有记过，页面照常显示。
// 没有总体分析集合的早先任务，次序不变，记住的是它自己的集合名。

import type { CollectionDef, Task } from "../api/types";
import { OVERALL_COLLECTION, isOverall } from "./overall";

/** 记住的是图表页签（它不是集合）时存的值。 */
export const DIAGRAMS_TAB = "@diagrams";
const storageKey = (taskId: string) => `taskwright.itemsTab.${taskId}`;

/** 页签一排里各集合的先后。 */
export function tabOrder(collections: CollectionDef[]): CollectionDef[] {
  const overall = collections.filter((c) => isOverall(c.name));
  return overall.length ? [...overall, ...collections.filter((c) => !isOverall(c.name))] : collections;
}

export function readTab(taskId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(taskId));
  } catch {
    return null;
  }
}

export function saveTab(taskId: string, tab: string): void {
  try {
    window.localStorage.setItem(storageKey(taskId), tab);
  } catch {
    // 浏览器不让存（隐私模式之类）：这一次照样切过去，下次打开按缺省的来
  }
}

/**
 * 一打开停在哪个页签，按先后取第一条成立的：
 * 选中的条目所在的集合；地址里带的集合或图表页签；记住的页签（任务里还有这个集合才算）；
 * 任务里有总体分析、别的集合一条条目都没有时，停在总体分析（先把事情想清楚）；
 * 否则停在总体分析之外的第一个集合。
 */
export function initialTab(task: Task, o: { selected?: string | null; collection?: string | null; diagrams?: boolean }): { tab: string; diagrams: boolean } {
  const order = tabOrder(task.definition.collections);
  const has = (name: string | null | undefined): name is string => !!name && order.some((c) => c.name === name);
  const first = order.find((c) => !isOverall(c.name))?.name ?? order[0]?.name ?? "";
  const selected = task.items.find((i) => i.item_id === o.selected)?.collection;
  if (has(selected)) return { tab: selected, diagrams: false };
  if (o.diagrams) return { tab: first, diagrams: true };
  if (has(o.collection)) return { tab: o.collection, diagrams: false };
  const kept = readTab(task.task_id);
  if (kept === DIAGRAMS_TAB) return { tab: first, diagrams: true };
  if (has(kept)) return { tab: kept, diagrams: false };
  if (has(OVERALL_COLLECTION) && !task.items.some((i) => !isOverall(i.collection))) return { tab: OVERALL_COLLECTION, diagrams: false };
  return { tab: first, diagrams: false };
}
