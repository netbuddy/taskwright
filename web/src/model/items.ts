// 条目的几样由数据算出的状态，界面上的标签与筛选都用它们，不写死任何集合名或字段名。

import type { Completion, CompletionCondition, FieldDef, FieldValue, Finding, Item, Review, ReviewRule, Task, Waiver } from "../api/types";
// 带 .ts 扩展名：助手一侧的贯穿测试用 node 直接加载本文件（本文件别的引用都只是类型）。
import { reviewVerdict, underCurrentRules, type VerdictState } from "../../../agent/src/lib/review_verdict.ts";

/**
 * 评审状态：待评审、通过（advice 是可选规则给的建议条数）、不通过（problems 是必选规则的问题处数；kept 是用户保留写法的那条记录）。
 * 给了 task 时只认当前规则指纹下的评审记录（规则改了之后，旧记录不再算，条目回到待评审）。
 */
export type ReviewState = { state: "pending" } | { state: "passed"; advice: number } | { state: "failed"; problems: number; advice: number; kept: Waiver | null };
export type ConfirmState = "pending" | "confirmed" | "stale" | "rejected";

/** 条目在当前所在的修订上的评审结论（agent/src/lib/review_verdict.ts，以当前规则下最后一条记录为准）；basis 是依据的那条记录。 */
export function itemVerdict(item: Item, task?: Task): { state: VerdictState; basis: Review | null; waiver: Waiver | null } {
  // 没写修订号的评审按当前所在的修订算；没带事件序号（早期的后端）时按列表里的先后，保留算在全部评审之后。
  const reviews = item.reviews.map((r, i) => ({ revision_no: r.revision_no ?? item.revision_no, verdict: r.verdict, rules_hash: r.rules_hash, seq: r.seq ?? i, r }));
  const waivers = (item.waivers ?? []).map((w) => ({ revision_no: w.revision_no, revoked: !!w.revoked, seq: w.seq ?? Number.MAX_SAFE_INTEGER, w }));
  const v = reviewVerdict(item.revision_no, reviews, waivers, currentHash(task, item.collection));
  return { state: v.state, basis: v.basis?.r ?? null, waiver: v.waiver?.w ?? null };
}

/** 条目当前所在的修订上的评审状态，按评审结论（itemVerdict）：已保留算作不通过、带上那条保留。 */
export function reviewState(item: Item, task?: Task): ReviewState {
  const { state, basis, waiver } = itemVerdict(item, task);
  if (!basis) return { state: "pending" };
  const findings = basis.findings ?? [];
  const problems = findings.filter(isProblem).length;
  if (state === "passed") return { state: "passed", advice: findings.length - problems };
  // 早期的评审记录没有级别：不合规的每条发现都算问题。
  return { state: "failed", problems: findings.some((f) => f.level) ? problems : findings.length, advice: findings.some((f) => f.level) ? findings.length - problems : 0,
    kept: waiver };
}

/** 一个集合现在的规则指纹；没有时为 null（不按指纹区分）。 */
export function currentHash(task: Task | undefined, collection: string): string | null {
  return task?.definition.collections.find((c) => c.name === collection)?.rules_hash ?? null;
}

/** 条目当前所在的修订上、当前规则下的评审记录，按先后。没给 task 时不按指纹区分。 */
export function currentReviews(item: Item, task?: Task): Review[] {
  const hash = currentHash(task, item.collection);
  return item.reviews.filter((r: Review) => (r.revision_no === undefined || r.revision_no === item.revision_no) && underCurrentRules(r.rules_hash, hash));
}

/** 规则改了之后要重评的条目：当前修订上有评审记录，但都不在当前规则下。 */
export function needsRereview(task: Task): Item[] {
  return task.items.filter((i) => needsReview(task, i.collection)
    && i.reviews.some((r) => r.revision_no === i.revision_no) && currentReviews(i, task).length === 0);
}

/** 一个批次是第几次评审；不认识的批次为 null。 */
export function batchNo(task: Task, batchId: string | null | undefined): number | null {
  if (!batchId) return null;
  return task.review_batches?.find((b) => b.batch_id === batchId)?.no ?? null;
}

/**
 * 一条不合规记录里的发现现在的处理状态：已在修订 N 改、已保留、未处理；superseded 是同一修订上被后来的记录取代、条目已经通过
 * （只出现在同一修订只评一次之前留下的数据里），不写状态词，也不算未处理。按条目现在的评审结论（itemVerdict）认：
 * - 依据的那条：不通过是未处理，已保留是已保留；
 * - 更早修订上的：条目现在通过或已保留，是已在修订 N 改（N 是条目当前所在的修订），否则未处理；
 * - 当前修订上、按改之前的规则评出的（规则指纹与集合现在的不同）：old_rules，不管条目后来有没有按新规则重评、保留；
 *   它不再算数，不算未处理，页签角标也不数它；
 * - 当前修订上、不是依据的其余记录（被后来的记录取代）：随条目现在的结论，通过是 superseded，已保留是已保留，其余未处理。
 */
export type FindingStatus = { kind: "fixed"; revision: number } | { kind: "kept"; reason: string | null } | { kind: "open" } | { kind: "superseded" }
  | { kind: "old_rules" };

export function findingStatus(item: Item, review: Review, task?: Task): FindingStatus {
  const { state, basis, waiver } = itemVerdict(item, task);
  const onCurrent = (review.revision_no ?? item.revision_no) === item.revision_no;
  if (onCurrent && !underCurrentRules(review.rules_hash, currentHash(task, item.collection))) return { kind: "old_rules" };
  if (state === "waived" && (review === basis || (review.revision_no ?? item.revision_no) === item.revision_no)) return { kind: "kept", reason: waiver!.reason };
  if ((review.revision_no ?? item.revision_no) < item.revision_no) {
    return state === "passed" || state === "waived" ? { kind: "fixed", revision: item.revision_no } : { kind: "open" };
  }
  if (review !== basis && state === "passed") return { kind: "superseded" };
  return { kind: "open" };
}

/** 发现状态的说法：「已在修订 8 改」「已保留：理由」「按改之前的规则评出，不再算数」「未处理」；被取代的不写。 */
export const OLD_RULES_TEXT = "按改之前的规则评出，不再算数";

export function findingStatusText(s: FindingStatus): string {
  if (s.kind === "fixed") return `已在修订 ${s.revision} 改`;
  if (s.kind === "kept") return s.reason ? `已保留：${s.reason}` : "已保留";
  if (s.kind === "superseded") return "";
  if (s.kind === "old_rules") return OLD_RULES_TEXT;
  return "未处理";
}

/** 未处理的问题数：每个要评审的条目，评审结论是不通过时依据的那条记录里的问题（必选规则的发现）。评审页签的角标用它。 */
export function openProblems(task: Task): number {
  let n = 0;
  for (const item of task.items) {
    if (!needsReview(task, item.collection)) continue;
    const { state, basis } = itemVerdict(item, task);
    if (state === "failed") n += (basis!.findings ?? []).filter(isProblem).length;
  }
  return n;
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
  return task.items.filter((i) => needsReview(task, i.collection) && matchesFilter(i, "review_pending", task));
}

/** 评审不通过：要评审的集合里、评审结论（itemVerdict）是不通过的条目；用户保留了写法的不算，见 keptReview。 */
export function failedReview(task: Task): Item[] {
  return task.items.filter((i) => needsReview(task, i.collection) && matchesFilter(i, "review_failed", task));
}

/** 已保留写法：要评审的集合里、评审不通过但用户保留了现在的写法的条目（评审结论为 waived，按用户的决定算通过）。 */
export function keptReview(task: Task): Item[] {
  return task.items.filter((i) => needsReview(task, i.collection) && matchesFilter(i, "review_kept", task));
}

/**
 * 一个集合里评审四种状态各有几个条目：待评审、评审通过、评审不通过（没有保留的）、已保留写法。任务页看板用它；
 * 与条目区的汇总行、筛选用同一个判断（matchesFilter），三处的数对同一个任务相同。
 */
export function reviewCounts(task: Task, collection: string): { pending: number; passed: number; failed: number; kept: number } {
  const items = task.items.filter((i) => i.collection === collection);
  const n = (filter: ItemFilter) => items.filter((i) => matchesFilter(i, filter, task)).length;
  return { pending: n("review_pending"), passed: n("review_passed"), failed: n("review_failed"), kept: n("review_kept") };
}

/** 某个集合里编号为 ruleId 的那条规则；找不到时为 undefined。 */
export function ruleOf(task: Task, collection: string, ruleId: string | null | undefined): ReviewRule | undefined {
  if (!ruleId) return undefined;
  return task.definition.collections.find((c) => c.name === collection)?.review_rules?.find((r) => r.id === ruleId);
}

/**
 * 评审通过的说明能列出哪些规则。评审记录里没有记规则清单，只记了规则指纹（规则文件全文加关闭、升为必选两份名单算出）：
 * - list：记录的指纹与集合现在的指纹都不为空并且相同，这次核对的就是现在生效的规则；off 是这个任务里已经关闭、这次没有核对的条数。
 *   记下的那句话里的条数与现在生效的规则条数对不上时，不列，按 changed 处理，免得列出一份条数对不上的清单。
 * - changed：两边都不为空但是不同，评审之后规则改过，列不出当时核对的规则。
 * - none：有一边为空（没有规则文件的集合，或早期没有记指纹的记录），或者没有记下那句话：不列，也不说明。
 */
export type PassRules = { kind: "list"; rules: ReviewRule[]; off: number } | { kind: "changed" } | { kind: "none" };

export function passRules(task: Task, collection: string, review: Review): PassRules {
  const c = task.definition.collections.find((one) => one.name === collection);
  const now = c?.rules_hash ?? null;
  const then = review.rules_hash ?? null;
  const count = /按 (\d+) 条规则/.exec(review.reason ?? "")?.[1];
  if (!now || !then || count === undefined) return { kind: "none" };
  const rules = c?.review_rules ?? null;
  if (now !== then || !rules || rules.length !== Number(count)) return { kind: "changed" };
  return { kind: "list", rules, off: (c?.all_rules ?? []).filter((r) => r.state === "off").length };
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

export type ItemFilter = "all" | "review_pending" | "review_failed" | "review_kept" | "review_passed" | "unread" | "read" | "supplement";

export const FILTERS: { key: ItemFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "review_pending", label: "待评审" },
  { key: "review_failed", label: "评审不通过" },
  { key: "review_kept", label: "已保留写法" },
  { key: "review_passed", label: "评审通过" },
  { key: "unread", label: "未读" },
  { key: "read", label: "已读" },
  { key: "supplement", label: "有助手补充的内容" },
];

export function matchesFilter(item: Item, filter: ItemFilter, task?: Task): boolean {
  switch (filter) {
    case "all":
      return true;
    case "review_pending":
      return reviewState(item, task).state === "pending";
    // 评审三种按评审结论（itemVerdict）分：不通过只列没有保留的，保留了写法的单列一种；汇总行与看板的计数用同一个判断。
    case "review_failed":
      return itemVerdict(item, task).state === "failed";
    case "review_kept":
      return itemVerdict(item, task).state === "waived";
    case "review_passed":
      return reviewState(item, task).state === "passed";
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

/**
 * 问题跟着条目走：问题条目一类的集合（见 keepPendingField）里，「条目引用」类型的字段（需求规格里是「关联条目」）
 * 列着这个问题牵涉的条目。下面几个函数由此派生，不另存关系，也不写死集合名或字段名。
 */
export const RESOLVED_VALUE = "已解决";

/** 一个问题条目牵涉的条目编号：它所有「条目引用」字段里的编号，去重、按出现先后。 */
export function issueRefs(task: Task, issue: Item): string[] {
  const def = task.definition.collections.find((c) => c.name === issue.collection);
  const ids = (def?.fields ?? []).filter((f) => f.type === "条目引用")
    .flatMap((f) => { const v = issue.fields[f.name]; return Array.isArray(v) ? v.map(String) : v ? [String(v)] : []; });
  return [...new Set(ids)];
}

/** 问题条目的状态取值；不是问题条目一类时为 null。 */
export function issueStatus(task: Task, issue: Item): string | null {
  const f = keepPendingField(task, issue.collection);
  return f ? String(issue.fields[f.name] ?? "") : null;
}

/** 问题还没了结：状态既不是「已解决」也不是「用户决定保留」。 */
export function isOpenIssue(task: Task, issue: Item): boolean {
  const s = issueStatus(task, issue);
  return s !== null && s !== RESOLVED_VALUE && s !== KEEP_PENDING_VALUE;
}

/** 牵涉某个条目的全部问题条目，按编号排序（编号里的数字按数值比，TBD-010 排在 TBD-009 之后）。 */
export function issuesOf(task: Task, itemId: string): Item[] {
  return task.items
    .filter((i) => keepPendingField(task, i.collection) && i.item_id !== itemId && issueRefs(task, i).includes(itemId))
    .sort((a, b) => a.item_id.localeCompare(b.item_id, undefined, { numeric: true }));
}

/** 牵涉某个条目、还没了结的问题条目；列表行上「问题 N」的 N 就是它的个数。 */
export function unresolvedIssuesOf(task: Task, itemId: string): Item[] {
  return issuesOf(task, itemId).filter((i) => isOpenIssue(task, i));
}

/**
 * 条目的主状态：「这条现在还缺什么」，一个条目同时有几件事时只取排在最前面的一件，先后是
 * 评审不通过（有未处理的问题）→ 未读 → 待评审 → 已保留（问题全部按用户决定保留）→ 有牵涉它的未解决问题。
 * 都没有时 kind 为 null，界面上不挂主状态徽标。评审三种只在要评审的集合出现，未读只在要求用户看过的集合出现。
 * issues 是牵涉这条、还没解决的问题个数：主状态是前四种之一时，界面另挂一枚「问题 N」。
 * 问题条目一类的集合（见 keepPendingField）不用这个，只写它自己的状态字段。
 */
export type MainStatusKind = "failed" | "unread" | "pending" | "kept" | "issues";
export interface MainStatus {
  kind: MainStatusKind | null;
  /** 评审状态；不评审的集合为 null。 */
  review: ReviewState | null;
  /** 未读与否；不要求用户看过的集合为 null。 */
  unread: boolean | null;
  issues: number;
}

export function mainStatus(task: Task, item: Item): MainStatus {
  const review = needsReview(task, item.collection) ? reviewState(item, task) : null;
  const unread = needsReading(task, item.collection) ? isUnread(item) : null;
  const issues = unresolvedIssuesOf(task, item.item_id).length;
  const kind: MainStatusKind | null = review?.state === "failed" && !review.kept ? "failed"
    : unread ? "unread"
    : review?.state === "pending" ? "pending"
    : review?.state === "failed" ? "kept"
    : issues > 0 ? "issues"
    : null;
  return { kind, review, unread, issues };
}

/** 主状态徽标上的字。 */
export function mainStatusText(s: MainStatus): string {
  const problems = s.review?.state === "failed" ? s.review.problems : 0;
  switch (s.kind) {
    case "failed": return `评审不通过 ${problems} 处`;
    case "unread": return "未读";
    case "pending": return "待评审";
    case "kept": return `评审不通过 ${problems} 处 · 已保留`;
    case "issues": return `问题 ${s.issues} 未解决`;
    default: return "";
  }
}

/** 悬停主徽标看到的全部状态：评审结论、已读到哪次修订、问题数，每件一行。 */
export function mainStatusDetail(s: MainStatus, item: Item): string {
  const lines: string[] = [];
  if (s.review) {
    const r = s.review;
    lines.push(r.state === "pending" ? "评审：当前修订还没有评审结论"
      : r.state === "passed" ? `评审：通过${r.advice ? `，另有 ${r.advice} 条建议` : ""}`
      : r.kept ? `评审：不通过 ${r.problems} 处，你保留了现在的写法，按你的决定算通过` : `评审：不通过 ${r.problems} 处，还没处理`);
  }
  if (s.unread !== null) {
    const seen = lastViewedRevision(item);
    lines.push(s.unread ? "未读：你还没打开看过" : `已读：你看过修订 ${seen}${seen !== item.revision_no ? `，之后又改到修订 ${item.revision_no}` : ""}`);
  }
  lines.push(s.issues ? `问题：牵涉这条的有 ${s.issues} 个还没解决` : "问题：没有牵涉这条、还没解决的");
  return lines.join("\n");
}

/** 用户在问题卡片上写了回答、点「回答」时发给助手的那句话。 */
export function issueAnswerText(issueId: string, answer: string): string {
  return `回答 ${issueId}：${answer.trim()}`;
}
