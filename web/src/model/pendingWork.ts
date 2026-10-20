// 任务起点页「待处理事项」一节与澄清输入页「待澄清问题」勾选块上由数据算出的东西。只算，不画。
// 数据都是现成的，不另取：任务详情（GET …/tasks/{task_id}）里的条目、图、评审批次与各阶段的灯（task.stage.lamps，每盏灯列出它差的编号），
// 任务状况里的工作项清单与活动目录。五类：
//   · 待澄清问题：问题集合里种类为「待澄清」、还没有了结的条目；阻断下游的在前，不阻断的只注条数与回看时机；
//   · 待决定事项：澄清阶段「每个决定都有目标」那盏灯与写条目阶段「没有待定标记」那盏灯列出的页、图或条目；
//   · 待核实条目：写条目阶段「没有待核实的条目」那盏灯列出的条目；
//   · 未查看的分析模型：图清单里还没有看过现在内容的图；
//   · 评审发现：评审确认阶段「评审没有未处理的发现」那盏灯列出的条目。
// 末尾「推进建议」一句由流程工作项现在所在的站、阻断下游的问题与那一站的灯推出；任务没有流程工作项时没有这一句。

import type { CatalogFlow, Item, StageKey, StageLamp, Task, TaskStatusView, WorkItemView } from "../api/types";
import { RESOLVED_VALUE, issueRefs, issueStatus, keepPendingField } from "./items";
import { allAssetsEmpty } from "./startPage";
import { basisNote, isBlockingQuestion, questionRevisit } from "./overall";
import { STAGE_NAMES, clarifyKind, lampShort, reportOnlyStation } from "./stage";

/** 问题集合里「种类」这一项取这个值的才是待澄清问题（另两种是范围外、后续迭代）。 */
export const QUESTION_KIND_FIELD = "种类";
/** 一组里至多列几行，多的写一句「还有 N 条」。 */
export const PENDING_ROWS = 5;

/** 一行：编号、标题、下面一行小字。 */
export interface PendingRow {
  id: string;
  title: string;
  note: string;
}

export interface PendingWork {
  /** 阻断下游的待澄清问题；一条都没有时是不阻断的那些。 */
  questions: PendingRow[];
  /** 阻断下游的问题有几条。 */
  blocking: number;
  /** 没有列在上面的不阻断问题：条数与各自的回看时机（去重）。 */
  notBlocking: { count: number; revisit: string[] };
  decisions: PendingRow[];
  pendingItems: PendingRow[];
  unviewedModels: PendingRow[];
  findings: PendingRow[];
  /** 评审过没有：没有评审过时评审发现一组写「尚未发起评审」。 */
  reviewed: boolean;
}

const lampOf = (task: Task, stage: StageKey, key: string): StageLamp | null =>
  task.stage?.lamps?.[stage]?.find((one) => one.key === key) ?? null;
const lampItems = (task: Task, stage: StageKey, key: string): string[] => {
  const lamp = lampOf(task, stage, key);
  return lamp && lamp.ok === false ? lamp.items : [];
};
const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** 一个编号在页面上叫什么：条目取标题，图取图名；都不是就照写编号。 */
function nameOf(task: Task, id: string): string {
  const item = task.items.find((one) => one.item_id === id);
  if (item) return item.title || id;
  const diagram = (task.diagrams ?? []).find((one) => one.diagram_id === id);
  return diagram ? diagram.name : id;
}

/** 还没有了结的待澄清问题：问题集合（有「用户决定保留」那一项的集合）里状态既不是已解决也不是用户决定保留、种类是要澄清的（待澄清、冲突、缺失，或者没写种类）条目。 */
export function openClarifyQuestions(task: Task): Item[] {
  return task.items
    .filter((one) => keepPendingField(task, one.collection) !== null)
    .filter((one) => { const status = issueStatus(task, one); return status !== RESOLVED_VALUE && status !== "用户决定保留"; })
    .filter((one) => clarifyKind(one.fields[QUESTION_KIND_FIELD]))
    .sort((a, b) => byNumber(a.item_id, b.item_id));
}

function questionRow(task: Task, question: Item): PendingRow {
  const related = issueRefs(task, question).map((id) => `${id}「${nameOf(task, id)}」`);
  const parts = [related.length ? `关联：${related.join("、")}` : "", isBlockingQuestion(question) ? "" : questionRevisit(question) ? `${questionRevisit(question)}回看` : ""].filter(Boolean);
  return { id: question.item_id, title: question.title || question.item_id, note: parts.join(" · ") };
}

/** 待决定事项：「决定」页没有「目标」上级的，与还标着「待定」的页、图或条目；同一个编号只列一次，按编号。 */
function decisionRows(task: Task): PendingRow[] {
  const aimless = lampItems(task, "clarifying", "decisions_have_goal");
  const marked = lampItems(task, "writing", "no_pending_marks");
  return [...new Set([...aimless, ...marked])].sort(byNumber).map((id) => ({
    id, title: nameOf(task, id),
    note: [aimless.includes(id) ? "「决定」还没有写为了哪个目标" : "", marked.includes(id) ? "还标着「待定」" : ""].filter(Boolean).join(" · "),
  }));
}

function pendingItemRows(task: Task): PendingRow[] {
  return lampItems(task, "writing", "no_pending_items").sort(byNumber).map((id) => {
    const item = task.items.find((one) => one.item_id === id);
    const basis = item ? basisNote(task, item) : null;
    return { id, title: nameOf(task, id), note: basis ? basis.text : "有助手补的内容，等你核实" };
  });
}

function modelRows(task: Task): PendingRow[] {
  return (task.diagrams ?? []).filter((one) => one.viewed === false).sort((a, b) => byNumber(a.diagram_id, b.diagram_id))
    .map((one) => ({ id: one.diagram_id, title: one.name, note: `${one.kind_name} · 修订 ${one.revision_no}，现在的内容还没有看过` }));
}

function findingRows(task: Task): PendingRow[] {
  return lampItems(task, "reviewing", "reviews_no_open_findings").sort(byNumber)
    .map((id) => ({ id, title: nameOf(task, id), note: "评审不合规，还没有处理" }));
}

/** 起点页「待处理事项」一节的内容；任务没有阶段时是 null。 */
export function pendingWork(task: Task): PendingWork | null {
  if (!task.stage) return null;
  const open = openClarifyQuestions(task);
  const blocking = open.filter(isBlockingQuestion);
  const rest = open.filter((one) => !isBlockingQuestion(one));
  const listed = blocking.length ? blocking : rest;
  const others = blocking.length ? rest : [];
  return {
    questions: listed.map((one) => questionRow(task, one)),
    blocking: blocking.length,
    notBlocking: { count: others.length, revisit: [...new Set(others.map(questionRevisit).filter(Boolean))] },
    decisions: decisionRows(task),
    pendingItems: pendingItemRows(task),
    unviewedModels: modelRows(task),
    findings: findingRows(task),
    reviewed: (task.review_batches ?? []).length > 0,
  };
}

/** 这一节显示不显示：任务有阶段、有需求资产（六格不全空）时显示。 */
export function showsPendingWork(task: Task, status: TaskStatusView | null): boolean {
  return !!task.stage && !!status && !allAssetsEmpty(status.assets);
}

/** 「另有 N 条不阻断，评审确认时回看」：不阻断的问题没有列出来时的那一句；没有时是 null。 */
export function notBlockingLine(work: PendingWork): string | null {
  const { count, revisit } = work.notBlocking;
  if (count === 0) return null;
  return `另有 ${count} 条不阻断${revisit.length ? `，${revisit.join("、")}回看` : ""}`;
}

/** 做某项活动的工作项（单项活动是那一项、流程正在那一站），最近有动静的那个；没有是 null。 */
export function workItemDoing(status: TaskStatusView | null, activity: StageKey): WorkItemView | null {
  return status?.work_items?.find((one) => one.activity === activity) ?? null;
}

/** 编号排成一句：「Q-007、Q-009」，多于三个写「Q-007、Q-009、Q-010 等 5 条」。 */
function idList(ids: string[]): string {
  return ids.length > 3 ? `${ids.slice(0, 3).join("、")} 等 ${ids.length} 条` : ids.join("、");
}

/**
 * 「推进建议」：任务里有流程工作项时才有。阻断下游的问题（在澄清及以后的站；核读材料时它们正要留给澄清去问）与待核实的条目（在写条目及以后的站）
 * 先要处理，写「解决 …并核实 …之后，需求分析可进入第 N 站「Y」」；
 * 没有这两样时看这一站的灯：都齐了写可以进入下一站，没齐写这一站还差什么；只报数、不判的站（核读材料）写由用户看过数字后决定。已经在最后一站时不写下一站。
 */
export function adviceLine(task: Task, status: TaskStatusView | null, work: PendingWork): string | null {
  const item = status?.work_items?.find((one) => one.kind === "flow");
  if (!item || !item.node || !item.ordinal) return null;
  const flow: CatalogFlow | undefined = status?.catalog?.flows.find((one) => one.work_item?.record_id === item.record_id) ?? status?.catalog?.flows[0];
  const nodes = (flow?.nodes ?? []).filter((one) => one.key in STAGE_NAMES);
  const at = nodes.findIndex((one) => one.key === item.node);
  const next = at >= 0 ? nodes[at + 1] ?? null : null;
  const here = `第 ${item.ordinal} 站「${STAGE_NAMES[item.node]}」`;
  const ahead = next ? `${item.name}可进入第 ${item.ordinal + 1} 站「${next.name}」` : `${item.name}已在最后一站`;
  const late = ["writing", "reviewing", "document"].includes(item.node);
  const todo = [
    work.blocking && item.node !== "reading" ? `解决 ${idList(work.questions.map((one) => one.id))}` : "",
    late && work.pendingItems.length ? `核实 ${idList(work.pendingItems.map((one) => one.id))}` : "",
  ].filter(Boolean);
  if (todo.length) return `${todo.join("并")}之后，${ahead}。`;
  const lamps = task.stage?.lamps?.[item.node] ?? [];
  if (reportOnlyStation(lamps)) {
    return next ? `${here}不判是否做够，看过数字后由你决定是否进入第 ${item.ordinal + 1} 站「${next.name}」。` : `${item.name}在${here}，这一站不判是否做够，由你判断。`;
  }
  const short = lamps.filter((one) => one.ok === false).map((one) => lampShort(one.summary).replace(/[。.]+$/, ""));
  if (short.length) return `${item.name}在${here}，这一站还差：${short.join("；")}。`;
  return next ? `${here}的几项都齐了，${ahead}。` : `${item.name}在${here}，这一站的几项都齐了。`;
}

/** 澄清输入页的勾选块：待澄清问题（阻断下游的在前）与待决定事项，各带一句小字。 */
export interface PickRow extends PendingRow {
  kind: "blocking" | "question" | "decision";
}

export function pickRows(task: Task): PickRow[] {
  if (!task.stage) return [];
  const open = openClarifyQuestions(task);
  const row = (one: Item, kind: PickRow["kind"]): PickRow => {
    const base = questionRow(task, one);
    return { ...base, kind, note: [kind === "blocking" ? "阻断下游" : "不阻断", base.note].filter(Boolean).join(" · ") };
  };
  return [
    ...open.filter(isBlockingQuestion).map((one) => row(one, "blocking")),
    ...open.filter((one) => !isBlockingQuestion(one)).map((one) => row(one, "question")),
    ...decisionRows(task).map((one) => ({ ...one, kind: "decision" as const, note: ["待决定事项", one.note].filter(Boolean).join(" · ") })),
  ];
}

/** 勾选的编号写进范围说明的那一句：「只澄清这几项：TBD-002、OA-005。」；一个都没有勾是空串。 */
export function pickedScope(ids: string[]): string {
  return ids.length ? `只澄清这几项：${ids.join("、")}。` : "";
}

/** 发出的范围说明：勾选的那一句在前，用户自己写的接在后面（隔一个换行）；两样都没有是空串。 */
export function composeScope(ids: string[], written: string): string {
  return [pickedScope(ids), written.trim()].filter(Boolean).join("\n");
}
