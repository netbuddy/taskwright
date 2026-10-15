// 任务定义写了「界面」一项的集合在界面上的几样派生：
// 条目的分组字段值、谁引用了一个条目、这个条目自己引用了哪些还在的条目。
// 集合名、字段名都取自任务定义；引用它的来源种类是「条目」（出处写条目编号），与依据别的集合的条目是同一种。
// 不另存任何关系：来源表与「条目引用」字段就是全部依据。

import type { CollectionDef, Item, Task } from "../api/types";
import { SOURCE_ITEM } from "./items";

type Display = NonNullable<CollectionDef["display"]>;

/** 这个集合在任务定义里的「界面」一项；没写时为 null。 */
export function displayOf(task: Task, collection: string): Display | null {
  return task.definition.collections.find((c) => c.name === collection)?.display ?? null;
}

/** 一个条目的分组字段值；没有分组字段时为空串。 */
export function groupOf(item: Item, display: Display | null): string {
  if (!display?.group_field) return "";
  const v = item.fields[display.group_field];
  return Array.isArray(v) ? v.join("、") : String(v ?? "").trim();
}

/** 一个条目所有「条目引用」字段里的编号，去掉它自己。 */
export function refsOf(task: Task, item: Item): string[] {
  const def = task.definition.collections.find((c) => c.name === item.collection);
  return (def?.fields ?? []).filter((f) => f.type === "条目引用")
    .flatMap((f) => (Array.isArray(item.fields[f.name]) ? (item.fields[f.name] as string[]) : []))
    .filter((id) => id !== item.item_id);
}

/** 别的条目怎样联系到这个条目：把它写成来源（how 为 source，where 是支持的字段），或者在条目引用字段里写了它（how 为 ref）。 */
export interface Citation {
  item: Item;
  how: "source" | "ref";
  where: string;
  excerpt?: string;
}

/** 引用了 itemId 的别的条目，按条目区的顺序；同一个条目的几条来源各算一条。 */
export function citationsOf(task: Task, itemId: string): Citation[] {
  const out: Citation[] = [];
  for (const other of task.items) {
    if (other.item_id === itemId) continue;
    for (const s of other.sources) {
      if (s.kind !== SOURCE_ITEM || s.locator !== itemId) continue;
      const supports = s.supports ?? [];
      out.push({ item: other, how: "source", excerpt: s.excerpt,
        where: supports.length ? supports.map((x) => (x.index != null ? `${x.field}第 ${x.index + 1} 条` : x.field)).join("、") : "整个条目" });
    }
    if (refsOf(task, other).includes(itemId)) {
      const def = task.definition.collections.find((c) => c.name === other.collection);
      const fields = (def?.fields ?? []).filter((f) => f.type === "条目引用" && Array.isArray(other.fields[f.name]) && (other.fields[f.name] as string[]).includes(itemId));
      out.push({ item: other, how: "ref", where: fields.map((f) => f.name).join("、") });
    }
  }
  return out;
}

/** 这个条目自己的条目引用字段里、还在交付物里的那些条目。 */
export function liveOwnRefs(task: Task, item: Item): string[] {
  const live = new Set(task.items.map((i) => i.item_id));
  return refsOf(task, item).filter((id) => live.has(id));
}
