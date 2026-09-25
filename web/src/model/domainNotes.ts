// 可被引作来源的解释性条目（需求规格任务里是「领域说明」集合）在界面上的几样派生：
// 按任务定义「界面」一项的分组字段分组、谁引用了一个条目、一个条目与别的条目有没有联系。
// 集合名、字段名都取自任务定义；只有来源种类的名字「领域说明」是固定的（它与集合名相同，agent 侧 lib/schema.ts 同名常量）。
// 不另存任何关系：来源表与「条目引用」字段就是全部依据，与 agent 侧 lib/conditions.ts 的 unlinkedDomainNotes 同一口径。

import type { CollectionDef, Item, Task } from "../api/types";

/** 来源种类「领域说明」：出处是一条领域说明的条目编号。 */
export const SOURCE_DOMAIN_NOTE = "领域说明";

/** 分组字段空着时那一组的组名，与文档模板的归组一致。 */
export const EMPTY_GROUP = "（未填）";

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

/** 按分组字段把一个集合的条目分组：靠前的组按给定顺序排最前，其余按每组第一个条目在列表里的先后；组内保持原顺序。 */
export function groupItems(task: Task, collection: string): { name: string; items: Item[] }[] {
  const display = displayOf(task, collection);
  const groups = new Map<string, Item[]>();
  for (const item of task.items.filter((i) => i.collection === collection)) {
    const name = groupOf(item, display) || EMPTY_GROUP;
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  const leading = display?.leading_groups ?? [];
  const rank = (name: string) => (leading.includes(name) ? leading.indexOf(name) : leading.length);
  return [...groups.entries()].map(([name, items]) => ({ name, items }))
    .sort((a, b) => rank(a.name) - rank(b.name));
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
      if (s.kind !== SOURCE_DOMAIN_NOTE || s.locator !== itemId) continue;
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

/** 一句话写这个条目与别的条目的联系，给右侧栏用；unlinked 为真表示没有任何联系（三种都没有）。 */
export function linkPhrase(task: Task, item: Item): { text: string; unlinked: boolean } {
  const cited = citationsOf(task, item.item_id);
  const own = liveOwnRefs(task, item);
  const parts: string[] = [];
  const bySource = cited.filter((c) => c.how === "source");
  if (bySource.length) parts.push(`被 ${[...new Set(bySource.map((c) => `${c.item.item_id} 的${c.where.replace(/第 \d+ 条/g, "")}`))].join("、")}引用`);
  const byRef = cited.filter((c) => c.how === "ref");
  if (byRef.length) parts.push(`${[...new Set(byRef.map((c) => c.item.item_id))].join("、")} 关联了它`);
  if (own.length) parts.push(`关联了 ${own.join("、")}`);
  return parts.length ? { text: parts.join("；"), unlinked: false } : { text: "还没有和任何条目关联", unlinked: true };
}

/** 完成条件接口给的「还没有和任何条目关联」的提示里，这个集合涉及的条目编号。 */
export function unlinkedIds(task: Task, collection: string): string[] {
  return (task.completion?.hints ?? []).filter((h) => h.kind === "unlinked_domain_notes" && h.collection === collection).flatMap((h) => h.items);
}
