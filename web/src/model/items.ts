// 条目的几样由数据算出的状态，界面上的标签与筛选都用它们，不写死任何集合名或字段名。

import type { Completion, CompletionCondition, FieldDef, FieldValue, Item, Review, Task } from "../api/types";

export type ReviewState = { state: "pending" } | { state: "passed" } | { state: "failed"; findings: number };
export type ConfirmState = "pending" | "confirmed" | "stale" | "rejected";

/** 当前版本的评审状态：取针对当前版本的最近一条评审记录；没写版本号的评审按当前版本算。 */
export function reviewState(item: Item): ReviewState {
  const mine = item.reviews.filter((r: Review) => r.version_no === undefined || r.version_no === item.version_no);
  const last = mine[mine.length - 1];
  if (!last) return { state: "pending" };
  if (last.verdict === "合规") return { state: "passed" };
  return { state: "failed", findings: last.findings?.length ?? 0 };
}

/** 确认状态：最近一条确认记录；确认过的版本不是当前版本时是「确认已失效」。 */
export function confirmState(item: Item): ConfirmState {
  const last = item.confirmations[item.confirmations.length - 1];
  if (!last) return "pending";
  if (!last.accepted) return "rejected";
  if (item.confirmation_stale || last.version_no !== item.version_no) return "stale";
  return "confirmed";
}

/** 最近一次被接受的确认所在的版本号。 */
export function confirmedVersion(item: Item): number | null {
  const accepted = [...item.confirmations].reverse().find((c) => c.accepted);
  return accepted ? accepted.version_no : null;
}

export function hasExecutorSupplement(item: Item): boolean {
  return item.sources.some((s) => s.kind === "执行者补充");
}

export type ItemFilter = "all" | "review_pending" | "review_failed" | "confirm_pending" | "confirmed" | "stale" | "supplement";

export const FILTERS: { key: ItemFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "review_pending", label: "待评审" },
  { key: "review_failed", label: "评审不通过" },
  { key: "confirm_pending", label: "待你确认" },
  { key: "confirmed", label: "已确认" },
  { key: "stale", label: "确认已失效" },
  { key: "supplement", label: "有助手补充的内容" },
];

export function matchesFilter(item: Item, filter: ItemFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "review_pending":
      return reviewState(item).state === "pending";
    case "review_failed":
      return reviewState(item).state === "failed";
    case "confirm_pending":
      return confirmState(item) === "pending" || confirmState(item) === "rejected";
    case "confirmed":
      return confirmState(item) === "confirmed";
    case "stale":
      return confirmState(item) === "stale";
    case "supplement":
      return hasExecutorSupplement(item);
  }
}

/**
 * 「先不管」（keep_pending）适用的条目：所在集合有一个枚举字段，取值里有接口约定写明的「用户决定保留」。
 * 按取值认，不按字段名认；任务定义里没有这种字段时不显示这个按钮。
 */
export const KEEP_PENDING_VALUE = "用户决定保留";

export function keepPendingField(task: Task, collection: string): FieldDef | null {
  const def = task.definition.collections.find((c) => c.name === collection);
  return def?.fields.find((f) => f.type === "枚举" && (f.values ?? []).includes(KEEP_PENDING_VALUE)) ?? null;
}

/**
 * 卡片头部那一行上下文：「关于{集合名} {条目编号}：{标题}」。
 * 待定事项一类的集合（按「用户决定保留」这个取值认出来，见 keepPendingField）另列两样：
 * 状态字段以外的枚举字段（例如种类），以及标题以外、有内容的文本字段（例如执行者写的建议的处理）。
 * 字段名都取自任务定义，不写死。
 */
export interface ItemContext {
  itemId: string;
  label: string;
  /** 条目的标题；条目不在交付物里时写明这一点。卡片上写成「编号小标签＋标题」。 */
  title: string;
  extras: { name: string; value: string }[];
  pending: boolean;
  version: number | null;
}

export function itemContext(task: Task | null, itemId: string): ItemContext {
  const item = task?.items.find((i) => i.item_id === itemId);
  if (!task || !item) return { itemId, label: `关于 ${itemId}（这个条目现在不在交付物里）`, title: "这个条目现在不在交付物里", extras: [], pending: false, version: null };
  const def = task.definition.collections.find((c) => c.name === item.collection);
  const keep = keepPendingField(task, item.collection);
  const extras: ItemContext["extras"] = [];
  if (def && keep) {
    for (const f of def.fields.slice(1)) {
      const value = item.fields[f.name];
      if (f.name === keep.name || isEmptyValue(value)) continue;
      if (f.type === "枚举" || f.type === "文本") extras.push({ name: f.name, value: Array.isArray(value) ? value.join("；") : String(value) });
    }
  }
  return { itemId, label: `关于${item.collection} ${item.item_id}：${item.title}`, title: item.title, extras, pending: !!keep, version: item.version_no };
}

/** 一项完成条件的状态；旧后端没有 state 时按 met 推断。 */
export function conditionState(c: CompletionCondition): "met" | "unmet" | "empty" {
  return c.state ?? (c.met ? "met" : "unmet");
}

/** 还差几项，所有地方都用这个数，不用「满足了几条」：集合为空的条件不算已满足，也不算还差。 */
export function unmetCount(completion: Completion): number {
  return completion.unmet_count ?? completion.conditions.filter((c) => conditionState(c) === "unmet").length;
}

/** 完成条件的一句话：「要完成任务，还差 N 项。」或「完成条件都已满足。」 */
export function completionHeadline(completion: Completion): string {
  const n = unmetCount(completion);
  return n === 0 ? "完成条件都已满足。" : `要完成任务，还差 ${n} 项。`;
}

/** 按集合分组的完成条件，保持接口给的先后次序。 */
export function groupConditions(completion: Completion): [string, Completion["conditions"]][] {
  const groups = new Map<string, Completion["conditions"]>();
  for (const c of completion.conditions) {
    if (!groups.has(c.collection)) groups.set(c.collection, []);
    groups.get(c.collection)!.push(c);
  }
  return [...groups];
}

/** 字段的空值：文本空白、列表为空、null。 */
export function isEmptyValue(value: FieldValue | undefined): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.filter((s) => String(s).trim() !== "").length === 0;
  return String(value).trim() === "";
}

export function isListField(def: FieldDef): boolean {
  return def.type === "文本列表" || def.type === "条目引用";
}

/** 按「支持哪一处」挑出支持某个字段的来源；supports 为空的来源支持整个条目。 */
export function sourcesFor(item: Item, field: string): Item["sources"] {
  return item.sources.filter((s) => (s.supports?.length ?? 0) > 0 && s.supports!.some((x) => x.field === field));
}
