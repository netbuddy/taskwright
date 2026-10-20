// 工作台「评审与确认」页签要的东西：待处理的发现一句汇总、评审历史表、确认记录表四行、发布的前置条件一句。
// 只算，不画（components/work/ReviewTab.tsx）。数据都在任务详情里：条目、图、评审批次（review_batches）与完成条件。

import type { Item, ReviewBatch, Task } from "../api/types";
import { requirementItems } from "./assetTabs";
import { failedReview, isUnread, keepPendingField, openProblems } from "./items";
import { QUESTION_KIND_FIELD, openClarifyQuestions } from "./pendingWork";
import { clarifyKind } from "./stage";
import { formatTimeShort } from "./format";

/** 一处待处理里最多点名几个，多的写「等 N 个」。 */
const NAMED = 3;
const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
function named(ids: string[], unit: string): string {
  const list = [...ids].sort(byNumber);
  return list.length <= NAMED ? list.join("、") : `${list.slice(0, NAMED).join("、")} 等 ${list.length} ${unit}`;
}

/** 「待处理的发现」那一句：评过没有、还有几处发现没有处理、在几个条目上。 */
export function findingsLine(task: Task): string {
  if (!(task.review_batches ?? []).length) return "还没有发起过评审。";
  const problems = openProblems(task);
  if (problems === 0) return "没有待处理的发现。";
  return `有 ${problems} 处发现待处理，在 ${failedReview(task).length} 个条目上。`;
}

/** 评审历史的一行。 */
export interface BatchRow {
  no: number;
  at: string;
  /** 评了几条。 */
  total: number;
  /** 发现几处（必须改的与建议的合计）。 */
  findings: number;
  /** 处理情况：全部通过；或不通过的条目现在还有几个没有处理。 */
  handled: string;
}

/** 评审历史表：最近的一轮在上。 */
export function batchRows(task: Task): BatchRow[] {
  const failing = new Set(failedReview(task).map((one) => one.item_id));
  return [...(task.review_batches ?? [])].sort((a, b) => b.no - a.no).map((batch) => ({
    no: batch.no, at: formatTimeShort(batch.at), total: batch.total, findings: batch.problems + batch.advice, handled: handledText(batch, failing),
  }));
}

function handledText(batch: ReviewBatch, failing: Set<string>): string {
  const left = batch.unfinished > 0 ? `${batch.unfinished} 条没有评完` : "";
  if (batch.failed === 0) return left || "全部通过";
  const open = batch.items.filter((one) => failing.has(one.item_id)).length;
  const verdict = open === 0 ? `${batch.failed} 条不通过，已处理` : `${batch.failed} 条不通过，还有 ${open} 条待处理`;
  return left ? `${verdict}；${left}` : verdict;
}

/** 确认记录表的一行：已确认几个、一共几个、待处理的话（没有待处理时为空）。 */
export interface ConfirmRow {
  name: string;
  done: number;
  total: number;
  pending: string;
}

/** 条目在它当前的修订上被用户看过（或确认过）。 */
const confirmedNow = (item: Item) => !isUnread(item) && !item.confirmation_stale;
/** 有助手补写的内容：当前修订上有种类为「助手补充」的来源。 */
const supplemented = (item: Item) => item.sources.some((one) => one.kind === "助手补充");

/** 确认记录表四行：需求条目、分析模型、助手补写待核实、待澄清问题。 */
export function confirmRows(task: Task): ConfirmRow[] {
  const items = requirementItems(task);
  const unread = items.filter((one) => !confirmedNow(one)).map((one) => one.item_id);
  const verify = items.filter((one) => one.pending_verification || !!one.basis_pending).map((one) => one.item_id);
  const diagrams = task.diagrams ?? [];
  const unseen = diagrams.filter((one) => one.viewed !== true).map((one) => one.diagram_id);
  const added = task.items.filter(supplemented);
  const waiting = added.filter((one) => one.pending_verification).map((one) => one.item_id);
  const questions = task.items.filter((one) => keepPendingField(task, one.collection) !== null
    && clarifyKind(one.fields[QUESTION_KIND_FIELD]));
  const open = openClarifyQuestions(task).map((one) => one.item_id);
  return [
    { name: "需求条目", done: items.length - unread.length, total: items.length,
      pending: [unread.length ? `${unread.length} 条未确认（${named(unread, "条")}）` : "", verify.length ? `${verify.length} 条待核实` : ""].filter(Boolean).join("，") },
    { name: "分析模型", done: diagrams.length - unseen.length, total: diagrams.length, pending: unseen.length ? `${named(unseen, "张")} 未查看` : "" },
    { name: "助手补写待核实", done: added.length - waiting.length, total: added.length, pending: waiting.length ? `${named(waiting, "处")} 待核实` : "" },
    { name: "待澄清问题", done: questions.length - open.length, total: questions.length, pending: open.length ? `${named(open, "项")} 未解决` : "" },
  ];
}

/** 末尾一句：发布的前置条件与现在满足了几条。 */
export function publishCondition(task: Task): string {
  const conditions = task.completion?.conditions ?? [];
  const met = conditions.filter((one) => one.met).length;
  return `发布的前置条件：完成条件全部满足（现在满足 ${met} / ${conditions.length} 条，逐条见「文档与版本」页签的发布前检查），并经你同意后在那里发布。`;
}
