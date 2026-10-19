// 工作视图与任务一级整页左边的导航栏上由数据算出的东西。只算，不画（画在 components/work/LeftNav.tsx）。
// 数据都是页面已经持有的：任务详情里的阶段与灯（task.stage）、会话清单、知识库清单，不另取。
//   · 开合：用户点过开合之后记在浏览器本地，以记忆为准；没有记忆时视口宽度不到 1280px 默认收起，否则展开（按像素，不随字号档位变；右侧栏另按 fontScale.ts 的 narrowViewport）；
//   · 流程进度：流程的工作项走到的那一站（会话清单里流程工作项的会话上记的 activity，不论打开的是哪条会话都相同）、那一站没通过的灯数、下一站；
//   · 会话：未归档的会话按建立时间倒序，当前会话单列在前；多于 SESSION_ROWS 条时折起；
//   · 待处理事项三行：取自 model/pendingWork.ts，与任务起点页「待处理事项」一节同一个口径。

import type { KnowledgeLibrary, SessionListEntry, StageKey, StageView, Task } from "../api/types";
import { pendingWork } from "./pendingWork";
import { STAGES, STAGE_NAMES, stageMarks, type StageMark } from "./stage";

const STORAGE_KEY = "taskwright.leftNav";

/** 记住的开合；没有记过、读不到时是 null。 */
export function readLeftNav(): "open" | "closed" | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "open" || value === "closed" ? value : null;
  } catch {
    return null;
  }
}

export function saveLeftNav(open: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // 浏览器不让存（隐私模式之类）：这一次照样开合，下次打开按视口宽度定
  }
}

/** 视口宽度不到这么多像素时，左栏没有记忆时默认收起。 */
export const LEFT_NAV_MIN_OPEN_PX = 1280;

/** 左栏一打开是展开还是收起：有记忆按记忆，否则视口不到 1280px 时收起。 */
export function initialLeftNavOpen(): boolean {
  const remembered = readLeftNav();
  return remembered ? remembered === "open" : window.innerWidth >= LEFT_NAV_MIN_OPEN_PX;
}

export interface FlowProgress {
  /** 流程的名字，例如「需求分析」。 */
  name: string;
  /** 流程走到第几站（从 1 起）。 */
  ordinal: number;
  stage: StageKey;
  /** 进度条上的六格。 */
  marks: { key: StageKey; name: string; mark: StageMark }[];
  /** 进度条下面那一句：「第 4 站 · 写条目 · 还差 2 件才能进评审确认」。 */
  line: string;
}

/**
 * 流程进度：流程的工作项走到的那一站。阶段（task.stage）是按会话算的，它的 flow_node 只在打开的是流程工作项的会话时才有，
 * 打开的正是流程工作项的会话时取它（随库事件就地更新）；别的会话里取自会话清单：属于流程工作项的会话上记着那个工作项现在做的活动（流程同时只有一个工作项）。
 * 任务没有流程工作项（只有单项活动或还没有启动工作项）时是 null，左栏不画这一段。
 * 「还差 M 件」是那一站没通过的灯数（各阶段的灯整个任务相同，task.stage.lamps 里六站都有）；都通过了写「这一站的几项都齐了」，在最后一站写「已在最后一站」。
 */
export function flowProgress(stage: StageView | null | undefined, sessions: readonly SessionListEntry[] | null | undefined): FlowProgress | null {
  const flowItem = (sessions ?? []).find((one) => !one.archived && one.work_item?.kind === "flow")?.work_item ?? null;
  const at = stage?.flow_node ?? flowItem?.activity ?? null;
  const name = (stage?.flow_node ? stage.work_item?.name : null) ?? flowItem?.name ?? null;
  if (!stage || !at || !(at in STAGE_NAMES)) return null;
  const index = STAGES.indexOf(at);
  const next = STAGES[index + 1] ?? null;
  const missing = (stage.lamps?.[at] ?? []).filter((one) => one.ok === false).length;
  const tail = !next ? ["已在最后一站", ...(missing > 0 ? [`还差 ${missing} 件`] : [])]
    : [missing > 0 ? `还差 ${missing} 件才能进${STAGE_NAMES[next]}` : "这一站的几项都齐了"];
  const line = [`第 ${index + 1} 站`, STAGE_NAMES[at], ...tail].join(" · ");
  return { name: name || "工作流程", ordinal: index + 1, stage: at, marks: stageMarks(at), line };
}

/** 左栏会话列表至多先列几条，多的折成「还有 N 条」。 */
export const SESSION_ROWS = 8;

/** 会话列表：当前会话在前，其余未归档的按建立时间倒序。 */
export function sessionRows(sessions: readonly SessionListEntry[], currentId: string | null | undefined): { current: SessionListEntry | null; others: SessionListEntry[] } {
  const live = sessions.filter((one) => !one.archived);
  const current = live.find((one) => one.session_id === currentId) ?? null;
  const others = live.filter((one) => one !== current).sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  return { current, others };
}

/** 待处理事项的一行。ids 是这一行列出的编号（点击与悬停用）。 */
export interface PendingLine {
  key: "decisions" | "questions" | "review";
  label: string;
  count: number;
  text: string;
  ids: string[];
}

export const PENDING_LABELS = { decisions: "待决定", questions: "待澄清问题", review: "请过目" } as const;
export const NOTHING_PENDING = "没有要你处理的事";

/**
 * 待处理事项三行，为零的那一行不列：待决定「N 项」；待澄清问题「N 条未了结」，有阻断下游的另写「阻断 K」；
 * 请过目是待核实的条目加还没有看过的图，列前两个编号，多于两个写「等 N 项」。任务没有阶段时是空清单。
 */
export function pendingLines(task: Task | null | undefined): PendingLine[] {
  const work = task ? pendingWork(task) : null;
  if (!work) return [];
  const questions = work.questions.length + work.notBlocking.count;
  const review = [...work.pendingItems, ...work.unviewedModels].map((one) => one.id);
  const lines: PendingLine[] = [
    { key: "decisions", label: PENDING_LABELS.decisions, count: work.decisions.length, text: `${work.decisions.length} 项`, ids: work.decisions.map((one) => one.id) },
    { key: "questions", label: PENDING_LABELS.questions, count: questions,
      text: `${questions} 条未了结${work.blocking ? ` · 阻断 ${work.blocking}` : ""}`, ids: work.questions.map((one) => one.id) },
    { key: "review", label: PENDING_LABELS.review, count: review.length,
      text: review.length > 2 ? `${review.slice(0, 2).join("、")} 等 ${review.length} 项` : review.join("、"), ids: review },
  ];
  return lines.filter((one) => one.count > 0);
}

/** 参考一段「知识库」那一行右边的字：「3 库 29 份」。服务没有知识库能力（libraries 为 undefined）时不显示这一行，还没取到时是 null。 */
export function knowledgeText(libraries: readonly KnowledgeLibrary[] | null | undefined): string | null {
  if (!libraries) return null;
  return `${libraries.length} 库 ${libraries.reduce((n, one) => n + one.documents.length, 0)} 份`;
}

/** 任务起点页「待处理事项」一节的元素编号：导航栏在起点页上点待处理事项的一行时滚到这里，从别处点过来时地址带 ?focus=pending。 */
export const PENDING_SECTION_ID = "tp-pending";
