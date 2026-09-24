// 条目的几样由数据算出的状态，界面上的标签与筛选都用它们，不写死任何集合名或字段名。

import type { Completion, CompletionCondition, FieldDef, FieldValue, Finding, Item, Review, ReviewRule, Task } from "../api/types";

/** 评审状态：待评审、通过（advice 是可选规则给的建议条数）、不通过（problems 是必选规则的问题处数）。 */
export type ReviewState = { state: "pending" } | { state: "passed"; advice: number } | { state: "failed"; problems: number; advice: number };
export type ConfirmState = "pending" | "confirmed" | "stale" | "rejected";

/** 条目当前所在的修订上的评审状态：取针对这次修订的最近一条评审记录；没写修订号的评审按当前所在的修订算。 */
export function reviewState(item: Item): ReviewState {
  const last = currentReview(item);
  if (!last) return { state: "pending" };
  const findings = last.findings ?? [];
  const problems = findings.filter(isProblem).length;
  if (last.verdict === "合规") return { state: "passed", advice: findings.length - problems };
  // 早期的评审记录没有级别：不合规的每条发现都算问题。
  return { state: "failed", problems: findings.some((f) => f.level) ? problems : findings.length, advice: findings.some((f) => f.level) ? findings.length - problems : 0 };
}

/** 条目当前所在的修订上最近一条评审记录；没有时为 undefined。 */
export function currentReview(item: Item): Review | undefined {
  return item.reviews.filter((r: Review) => r.revision_no === undefined || r.revision_no === item.revision_no).pop();
}

/** 必选规则的发现叫「问题」，可选规则的叫「建议」。没有级别的早期发现按问题算。 */
export function isProblem(f: Finding): boolean {
  return f.level !== "可选";
}

/**
 * 这个集合要不要评审：接口给了 needs_review 就用它；旧后端没给时看完成条件里有没有「每个条目评审通过」，
 * 完成条件也还没算出来时按「不是问题条目一类」估计。
 */
export function needsReview(task: Task, collection: string): boolean {
  const def = task.definition.collections.find((c) => c.name === collection);
  if (def?.needs_review !== undefined) return def.needs_review;
  const conditions = task.completion?.conditions;
  if (conditions && conditions.length > 0) return conditions.some((c) => c.collection === collection && c.name === REVIEW_CONDITION);
  return keepPendingField(task, collection) === null;
}

/** 待评审：要评审的集合里、当前所在的修订还没有任何评审记录的条目，按条目区的顺序。「评审 N 条待评审的条目」的 N 就是它的条数。 */
export function pendingReview(task: Task): Item[] {
  return task.items.filter((i) => needsReview(task, i.collection) && reviewState(i).state === "pending");
}

/** 评审不通过：要评审的集合里、当前所在的修订上最近一条评审是不合规的条目。 */
export function failedReview(task: Task): Item[] {
  return task.items.filter((i) => needsReview(task, i.collection) && reviewState(i).state === "failed");
}

/** 某个集合里编号为 ruleId 的那条规则；找不到时为 undefined。 */
export function ruleOf(task: Task, collection: string, ruleId: string | null | undefined): ReviewRule | undefined {
  if (!ruleId) return undefined;
  return task.definition.collections.find((c) => c.name === collection)?.review_rules?.find((r) => r.id === ruleId);
}

/**
 * 确认状态：最近一条确认标记；确认过的修订不是条目当前所在的修订时是 stale（看过之后又被改过）。
 * 这是「当前修订看过没有」，只用来决定打开详情时要不要补记一条已读、字段边框何时停住；
 * 界面上的已读与未读是条目级的，见 isUnread。
 */
export function confirmState(item: Item): ConfirmState {
  const last = item.confirmations[item.confirmations.length - 1];
  if (!last) return "pending";
  if (!last.accepted) return "rejected";
  if (item.confirmation_stale || last.revision_no !== item.revision_no) return "stale";
  return "confirmed";
}

export function hasExecutorSupplement(item: Item): boolean {
  return item.sources.some((s) => s.kind === "执行者补充");
}

/** 用户看过这个条目当前所在的修订：当前修订上最近一条确认标记是接受。 */
export function seenCurrent(item: Item): boolean {
  return confirmState(item) === "confirmed";
}

/**
 * 未读：用户从没看过这个条目（任何一次修订上都没有接受的确认标记）。已读是条目级、单向的：打开过一次详情就一直是已读，
 * 助手后来改出新修订也不翻回未读；「助手改过、你还没看」只用「刚改」标签与字段边框提示，不挡完成。
 */
export function isUnread(item: Item): boolean {
  return !item.confirmations.some((c) => c.accepted);
}

/** 用户最后一次看过的修订：最近一条接受记录所在的修订；从没看过时为 null。 */
export function lastViewedRevision(item: Item): number | null {
  const accepted = [...item.confirmations].reverse().find((c) => c.accepted);
  return accepted ? accepted.revision_no : null;
}

/** 完成条件里「每个条目用户确认」这个条件名。未读只对要求它的集合有意义。 */
export const CONFIRM_CONDITION = "每个条目用户确认";
/** 完成条件里「每个条目评审通过」这个条件名。 */
export const REVIEW_CONDITION = "每个条目评审通过";

/**
 * 这个集合要不要用户看过：完成条件里对它要求了「每个条目用户确认」。完成条件还没算出来时，
 * 按「不是问题条目一类」估计（问题条目一类靠状态字段收口，见 keepPendingField）。
 */
export function needsReading(task: Task, collection: string): boolean {
  const conditions = task.completion?.conditions;
  if (conditions && conditions.length > 0) return conditions.some((c) => c.collection === collection && c.name === CONFIRM_CONDITION);
  return keepPendingField(task, collection) === null;
}

/** 未读清单：要求用户看过的集合里从没看过的条目，按条目区的顺序。 */
export function unreadItems(task: Task): Item[] {
  return task.items.filter((i) => needsReading(task, i.collection) && isUnread(i));
}

/**
 * 用户打开一个条目的详情时要不要记一条已读：任务进行中、这个集合要求用户看过、当前所在的修订还没有记过，才返回要标的目标
 * （条目与它当前所在的修订），否则返回 null。看过旧修订的条目再打开也记，库里据此如实留下用户最后看过哪次修订。
 */
export function viewTarget(task: Task | null, itemId: string | null): { item_id: string; base_revision: number } | null {
  if (!task || !itemId || task.status !== "进行中") return null;
  const item = task.items.find((i) => i.item_id === itemId);
  if (!item || !needsReading(task, item.collection) || seenCurrent(item)) return null;
  return { item_id: item.item_id, base_revision: item.revision_no };
}

/** 助手工作中，写入按钮为什么不能用（与条目区顶部的横幅同一句）。 */
export const BUSY_TEXT = "助手正在工作，结束后你可以继续修改";

/**
 * 写入按钮灰化时悬停说明的原因，按先后取第一条：任务已结束、助手不可用、助手工作中、正在保存、看的是旧修订。
 * 都不是时返回 undefined（按钮可用，不带说明）。
 */
export function writeOffReason(task: Task | null, o: { readOnly?: boolean; writesOff?: boolean; pending?: boolean; old?: boolean }): string | undefined {
  if (task && task.status !== "进行中") return `任务已${task.status === "已放弃" ? "放弃" : "结束"}，不能再改。`;
  if (o.readOnly) return "助手现在不可用，暂时不能改。";
  if (o.writesOff) return BUSY_TEXT;
  if (o.pending) return "正在保存上一次修改，存好之后再操作。";
  if (o.old) return "你在看旧修订，回到最新才能改。";
  return undefined;
}

/**
 * 评审按钮灰化时悬停说明的原因，按先后取第一条：任务已结束、助手不可用、助手工作中、上一批还在评、没有要评的条目。
 * 都不是时返回 undefined（按钮可用）。
 */
export function reviewOffReason(task: Task | null, o: { readOnly?: boolean; writesOff?: boolean; running?: boolean; count: number }): string | undefined {
  if (task && task.status !== "进行中") return `任务已${task.status === "已放弃" ? "放弃" : "结束"}，不能再评审。`;
  if (o.readOnly) return "助手现在不可用，暂时不能评审。";
  if (o.writesOff) return "助手正在工作，结束之后才能发起评审。";
  if (o.running) return "上一批评审还在进行，评完之后再发起。";
  if (o.count === 0) return "没有待评审的条目。";
  return undefined;
}

export type ItemFilter = "all" | "review_pending" | "review_failed" | "review_passed" | "unread" | "read" | "supplement";

export const FILTERS: { key: ItemFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "review_pending", label: "待评审" },
  { key: "review_failed", label: "评审不通过" },
  { key: "review_passed", label: "评审通过" },
  { key: "unread", label: "未读" },
  { key: "read", label: "已读" },
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
    case "review_passed":
      return reviewState(item).state === "passed";
    case "unread":
      return isUnread(item);
    case "read":
      return !isUnread(item);
    case "supplement":
      return hasExecutorSupplement(item);
  }
}

/**
 * 问题条目：「先不管」（keep_pending）适用的条目，所在集合有一个枚举字段，取值里有接口约定写明的「用户决定保留」。
 * 按取值认，不按字段名认；任务定义里没有这种字段时不显示这个按钮。
 */
export const KEEP_PENDING_VALUE = "用户决定保留";

export function keepPendingField(task: Task, collection: string): FieldDef | null {
  const def = task.definition.collections.find((c) => c.name === collection);
  return def?.fields.find((f) => f.type === "枚举" && (f.values ?? []).includes(KEEP_PENDING_VALUE)) ?? null;
}

/**
 * 卡片头部那一行上下文：「关于{集合名} {条目编号}：{标题}」。
 * 问题条目一类的集合（按「用户决定保留」这个取值认出来，见 keepPendingField）另列两样：
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
  /** 条目当前所在的修订。 */
  revision: number | null;
}

export function itemContext(task: Task | null, itemId: string): ItemContext {
  const item = task?.items.find((i) => i.item_id === itemId);
  if (!task || !item) return { itemId, label: `关于 ${itemId}（这个条目现在不在交付物里）`, title: "这个条目现在不在交付物里", extras: [], pending: false, revision: null };
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
  return { itemId, label: `关于${item.collection} ${item.item_id}：${item.title}`, title: item.title, extras, pending: !!keep, revision: item.revision_no };
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

/**
 * 列表里的「一句摘要」：标题字段之后第一个有内容的文本字段。按任务定义的字段顺序取，不写死集合名或字段名；
 * 需求规格这类任务里，功能用例取到「用例功能」，非功能需求与约束取到「需求语句」。
 */
export function summaryOf(task: Task, item: Item): string {
  const def = task.definition.collections.find((c) => c.name === item.collection);
  const f = def?.fields.slice(1).find((x) => x.type === "文本" && !isEmptyValue(item.fields[x.name]));
  return f ? String(item.fields[f.name]) : "";
}
