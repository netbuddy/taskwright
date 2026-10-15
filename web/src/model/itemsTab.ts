// 条目区停在哪个集合：集合的次序、一打开停在哪一个、记住用户上次停在哪一个页签。
// 次序：业务说明那一个集合排在最前，其余照任务定义里的先后。
// 记住：每个任务各记一个（集合名，或者不是集合的页签的键），存在浏览器本地；读写失败时当作没有记过，页面照常显示。

import type { CollectionDef, Task } from "../api/types";
import { OVERALL_COLLECTION, isOverall } from "./overall";

const storageKey = (taskId: string) => `taskwright.itemsTab.${taskId}`;

/** 各集合的先后：业务说明那一个集合在最前。 */
export function tabOrder(collections: CollectionDef[]): CollectionDef[] {
  return [...collections.filter((c) => isOverall(c.name)), ...collections.filter((c) => !isOverall(c.name))];
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
 * 一打开停在哪个集合，按先后取第一条成立的：
 * 选中的条目所在的集合；地址里要看一张图时是业务说明；地址里带的集合；记住的集合（任务里还有这个集合才算）；
 * 业务说明之外的集合一条条目都没有时，停在业务说明（先把事情想清楚）；否则停在业务说明之外的第一个集合。
 * 记住的是「材料与证据」这类不是集合的页签时，集合仍按这几条定，页签由条目区另看（model/assetTabs.ts 的 paneOfKey）。
 */
export function initialTab(task: Task, o: { selected?: string | null; collection?: string | null; diagram?: boolean }): { tab: string } {
  const order = tabOrder(task.definition.collections);
  const has = (name: string | null | undefined): name is string => !!name && order.some((c) => c.name === name);
  const first = order.find((c) => !isOverall(c.name))?.name ?? order[0]?.name ?? "";
  const selected = task.items.find((i) => i.item_id === o.selected)?.collection;
  if (has(selected)) return { tab: selected };
  if (o.diagram) return { tab: OVERALL_COLLECTION };
  if (has(o.collection)) return { tab: o.collection };
  const kept = readTab(task.task_id);
  if (has(kept)) return { tab: kept };
  if (!task.items.some((i) => !isOverall(i.collection))) return { tab: OVERALL_COLLECTION };
  return { tab: first };
}
