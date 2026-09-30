// 「评审」页签各块的内容，全部由任务数据按条目现在的评审结论（itemVerdict）算出，页签不另存状态：
//   · 要处理的：结论是不通过（没有保留）的条目，它依据的那条记录里的问题（必选规则的发现）；
//   · 建议：有结论的条目，依据的那条记录里的建议（可选规则的发现），不影响通过；
//   · 已经没事的：结论是通过的条目，与你保留了写法的条目；
//   · 评审记录：每次评审一行，最新的在上。
// 只认条目当前所在的修订、当前规则下的记录，所以已经改掉的问题、按改之前的规则评出的发现都不在这里；
// 条目改过之后还没有重新评审的，旧的问题也不在这里，只算进「还没有评审」的个数。

import type { Finding, Item, Review, ReviewBatch, Task, Waiver } from "../api/types";
import { isProblem, itemVerdict, needsRereview, needsReview, openProblems, pendingReview } from "./items";

/** 一个条目在某一块里的几处发现。 */
export interface FindingGroup {
  item: Item;
  findings: Finding[];
}

export interface ReviewOverview {
  /** 要评审的集合里有没有条目。 */
  hasItems: boolean;
  /** 还没有评审的条目（含规则改过之后要重新评审的）。 */
  pending: Item[];
  /** 其中因为规则改过而要重新评审的个数。 */
  rereview: number;
  /** 要处理的问题，按条目分组，条目按条目区的顺序。 */
  problems: FindingGroup[];
  /** 问题的处数；与页签行上的个数同一个函数（openProblems）。 */
  problemCount: number;
  /** 建议，按条目分组。 */
  advice: FindingGroup[];
  adviceCount: number;
  /** 评审通过的条目与它依据的那条记录。 */
  passed: { item: Item; review: Review }[];
  /** 你保留了写法的条目：依据的那条记录里的问题与那次保留。 */
  kept: { item: Item; findings: Finding[]; waiver: Waiver }[];
  /** 评审过的批次，最新的在上。 */
  batches: ReviewBatch[];
}

export function reviewOverview(task: Task): ReviewOverview {
  const reviewable = task.items.filter((i) => needsReview(task, i.collection));
  const pending = pendingReview(task);
  const rereview = new Set(needsRereview(task).map((i) => i.item_id));
  const problems: FindingGroup[] = [];
  const advice: FindingGroup[] = [];
  const passed: ReviewOverview["passed"] = [];
  const kept: ReviewOverview["kept"] = [];
  for (const item of reviewable) {
    const { state, basis, waiver } = itemVerdict(item, task);
    if (!basis) continue;
    const findings = basis.findings ?? [];
    const ps = findings.filter(isProblem);
    const as = findings.filter((f) => !isProblem(f));
    if (as.length) advice.push({ item, findings: as });
    if (state === "failed" && ps.length) problems.push({ item, findings: ps });
    if (state === "passed") passed.push({ item, review: basis });
    if (state === "waived" && waiver) kept.push({ item, findings: ps, waiver });
  }
  return {
    hasItems: reviewable.length > 0,
    pending,
    rereview: pending.filter((i) => rereview.has(i.item_id)).length,
    problems,
    problemCount: openProblems(task),
    advice,
    adviceCount: advice.reduce((n, g) => n + g.findings.length, 0),
    passed,
    kept,
    batches: [...(task.review_batches ?? [])].reverse(),
  };
}

/** 发现在条目里的位置：「基本流程 第 2 项」；不是列表里的某一项时只写字段名。index 从 0 起，显示时加 1。 */
export function findingWhere(f: Finding): string {
  return f.index != null ? `${f.field} 第 ${f.index + 1} 项` : f.field;
}

/** 顶上一行里「还没有评审」的那一句；没有待评审的条目时为 null。 */
export function pendingSentence(pending: number, rereview: number): string | null {
  if (pending === 0) return null;
  if (rereview === pending) return `规则改过，${pending} 个条目要重新评审。`;
  if (rereview > 0) return `${pending} 个条目还没有评审，其中 ${rereview} 个是因为规则改过。`;
  return `${pending} 个条目还没有评审。`;
}

/** 评审记录的一行（时刻另写）：「评审了 5 个条目：4 个通过，1 个有问题。」个数为 0 的一项不写。 */
export function batchSentence(b: ReviewBatch): string {
  const parts = [b.passed ? `${b.passed} 个通过` : "", b.failed ? `${b.failed} 个有问题` : "", b.unfinished ? `${b.unfinished} 个没有评完` : ""].filter(Boolean);
  return `评审了 ${b.total} 个条目${parts.length ? `：${parts.join("，")}` : ""}。`;
}
