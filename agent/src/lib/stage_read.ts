/**
 * 工作的阶段里读写任务库的那一半（不读库的在 lib/stage.ts）：任务现在在哪个阶段、记一次移动。
 *
 * 承载是活动记录表：任务里开展过的每一项活动一行，现在的六个阶段就是六项活动，都在首次分析这条流程里。
 * 任务现在在哪个阶段看还没有结束的那条活动记录。没有在进行的记录，任务就是空闲（lib/stage.ts 的 IDLE）：刚建好的任务一条记录
 * 都没有，是空闲；助手汇报单独开展的活动做完了之后，也是空闲。早先（格式版本 5 之前与 0.5）没有记录的任务按有没有材料
 * 算在核读材料或澄清，现在不再有这个缺省。
 * 移动阶段就是结束现在这项活动、开始另一项：前一条记录填上结束的时刻，再插一条新的。
 * 早先建的任务（任务定义里没有「总体分析」集合）没有阶段：stageOf 返回 null，调用方据此什么都不做。
 *
 * 记活动开始的函数（recordStageMove）只管写，这次行不行由 startActivity 先判。
 */

import type { DatabaseSync } from "node:sqlite";
import { type Entry, chooseActOf } from "./completion_consent.ts";
import { checkCompletion } from "./conditions.ts";
import { emit, wallClockText } from "./db.ts";
import { type TaskDefinition, keepPendingField, validateDefinition } from "./definition.ts";
import { diagramViewed, latestVersion, liveDiagrams, readDiagrams, viewedDiagramRevisions } from "./diagram.ts";
import { classLinked, drawnItemIds, hasBranch } from "./diagram_scan.ts";
import { OVERALL_COLLECTION, OVERALL_FIELDS, hasOverall, isDeprecated } from "./overall_analysis.ts";
import { overallState } from "./overall_read.ts";
import { rulesTable } from "./overall_views.ts";
import { currentRulesHash, verdictAt } from "./review_state.ts";
import { ELEMENT_FIGURE, NoDatabaseYet, SOURCE_DOCUMENT, SOURCE_FIGURE, SOURCE_ITEM, TASK_ACTIVE, elementClause, withTaskDatabase } from "./schema.ts";
import { openProposal } from "./stage_proposal.ts";
import {
  ACTIVITY_DONE_REASON, BACK_OPTIONS, ENTER_OPTIONS, FLOW_INITIAL, IDLE, STAGES, KIND_CLASS, KIND_FLOWCHART, type Lamp, type LampDiagram, type LampInput, type LaunchFacts, type LaunchView,
  type Position, QUESTION_OPEN_STATUS, type Refusal, STAGE_NAMES, type Stage, type StageActor, type StartHow,
  activityBlocked, activityDoneRefusal, isPosition, isStage, lampLines, launchView, QUESTION_BLOCKING_FIELD, hasPendingMark, lampPage, lampQuestion, nextStage, stageBackedBy, stageEnteredBy, stageLamps,
  startHow, switchedReason,
} from "./stage.ts";
import { listMaterials } from "./task_status.ts";

/**
 * 记活动开始与结束的两个事件名。移动阶段记两条：先一条 ACTIVITY_ENDED 结束现在这项活动，再一条 ACTIVITY_STARTED 开始另一项。
 * 开始那一条的内容：activity（哪一项活动）、node（所属节点）、flow（所属流程）、from（开始之前任务在哪个阶段）、actor、reason、run_id。
 * 结束那一条的内容：activity、node、reason、actor。
 */
export const EVENT_ACTIVITY_STARTED = "ACTIVITY_STARTED";
export const EVENT_ACTIVITY_ENDED = "ACTIVITY_ENDED";
/**
 * 早先记一次移动用的事件名（格式版本 4 及更早）：一次移动一条，内容是 stage（移到哪个阶段）、from、actor、reason、run_id、flow。
 * 现在不再记这种事件；升级上来的库里它们原样留着，读事件的几处两种名字都认。
 */
export const EVENT_STAGE_MOVED = "STAGE_MOVED";

const TABLE = "activity_record";

/** 活动记录表里的一行。 */
export interface ActivityRecord {
  record_id: number;
  /** 哪一项活动：现在就是六个阶段之一。 */
  activity: Stage;
  /** 所属节点：在流程里开展时与活动同一个写法；单独开展时为 null（现在没有这种记录）。 */
  node: string | null;
  /** 所属流程（lib/stage.ts 的 FLOW_INITIAL 等）；单独开展时为 null（现在没有这种记录）。 */
  flow: string | null;
  /**
   * 开始这项活动之前任务在哪个阶段：取自记下开始的那条事件的内容，事件里写的是 null（开始之前任务空闲）就是 null；
   * 那条事件已经不在时，取前一条记录的活动，没有前一条是 null。
   */
  from: Stage | null;
  actor: StageActor;
  reason: string;
  run_id: string | null;
  session_id: string;
  call_id: string;
  started_at: string;
  /** 结束的时刻；还在进行为 null。 */
  ended_at: string | null;
  started_seq: number;
  ended_seq: number | null;
}

/**
 * 读活动记录的列：表里的各列，加上从记下开始的那条事件的内容里取的「从哪个阶段来」。那条事件在，就照它写的（它写 null 是开始之前任务空闲）；
 * 那条事件已经不在时，取前一条记录的活动。
 */
const RECORD_COLUMNS = "r.record_id, r.activity, r.node, r.flow, r.actor, r.reason, r.run_id, r.session_id, r.call_id, r.started_at, r.ended_at, r.started_seq, r.ended_seq, " +
  "CASE WHEN e.seq IS NOT NULL AND json_valid(e.payload) THEN json_extract(e.payload, '$.from') ELSE " +
  `(SELECT p.activity FROM ${TABLE} p WHERE p.task_id = r.task_id AND p.started_seq < r.started_seq ORDER BY p.started_seq DESC LIMIT 1) END AS "from"`;
const RECORD_FROM = `${TABLE} r LEFT JOIN event e ON e.seq = r.started_seq`;

type RecordRow = Omit<ActivityRecord, "from"> & { from: unknown };
const recordOf = (row: RecordRow): ActivityRecord => ({
  ...row, record_id: Number(row.record_id), started_seq: Number(row.started_seq), ended_seq: row.ended_seq === null ? null : Number(row.ended_seq),
  from: isStage(row.from) ? row.from : null,
});

/** 库里有没有活动记录表：只读的一侧会遇到还没有升级过的库。 */
export function hasActivityTable(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE) !== undefined;
}

/** 全部活动记录，按开始的先后排。 */
export function activityRecords(db: DatabaseSync, taskId: string): ActivityRecord[] {
  if (!hasActivityTable(db)) return [];
  const rows = db.prepare(`SELECT ${RECORD_COLUMNS} FROM ${RECORD_FROM} WHERE r.task_id = ? ORDER BY r.started_seq`).all(taskId) as unknown as RecordRow[];
  return rows.map(recordOf);
}

/**
 * 任务现在在进行的那项活动的记录：还没有结束的记录里开始得最晚的一条。一条都没有（或者库还没有这张表）时是 null。
 * 活动的写法不是六个阶段之一的记录不认。
 */
export function openActivityRecord(db: DatabaseSync, taskId: string): ActivityRecord | null {
  if (!hasActivityTable(db)) return null;
  const row = db.prepare(`SELECT ${RECORD_COLUMNS} FROM ${RECORD_FROM} WHERE r.task_id = ? AND r.ended_at IS NULL ORDER BY r.started_seq DESC LIMIT 1`).get(taskId) as RecordRow | undefined;
  return row && isStage(row.activity) ? recordOf(row) : null;
}

/** 任务目录里有没有材料：材料目录第一层至少有一个文件（与任务现状消息列材料用的是同一个清单）。 */
export function taskHasMaterials(workspaceDir: string, materialsDir: string): boolean {
  return listMaterials(workspaceDir, materialsDir).files.length > 0;
}

/**
 * 任务现在在哪里：有还没有结束的活动记录就是那项活动（那个阶段）；没有就是空闲。
 * 不管任务有没有阶段，调用方先用 hasOverall 判。
 */
export function currentStage(db: DatabaseSync, taskId: string): Position {
  return openActivityRecord(db, taskId)?.activity ?? IDLE;
}

/** 任务现在在哪个阶段（或者空闲）；早先建的任务（没有「总体分析」集合）没有阶段，返回 null。 */
export function stageOf(db: DatabaseSync, workspaceDir: string, taskId: string, definition: Pick<TaskDefinition, "collections" | "materialsDir">): Position | null {
  if (!hasOverall(definition.collections)) return null;
  return currentStage(db, taskId);
}

/** 首次分析走到的节点：最近一条带节点的活动记录的节点；任务还没有在流程里开展过活动时是 null。 */
export function flowNode(db: DatabaseSync, taskId: string): Stage | null {
  if (!hasActivityTable(db)) return null;
  const row = db.prepare(`SELECT node FROM ${TABLE} WHERE task_id = ? AND node IS NOT NULL ORDER BY started_seq DESC LIMIT 1`).get(taskId) as { node: string } | undefined;
  return row && isStage(row.node) ? row.node : null;
}

/** 一次活动开始要记下的几样。 */
export interface StageMove {
  taskId: string;
  sessionId: string;
  /** 助手开始时的运行号；用户开始时为 null。 */
  runId: string | null;
  callId: string;
  actor: StageActor;
  /** 开始之前任务在哪里：一个阶段，或者空闲。 */
  from: Position;
  to: Stage;
  reason: string;
  /** 是不是在首次分析流程里开始；不给当作是。单独开展时为假，记录的节点与流程两列为空。 */
  inFlow?: boolean;
  /** 原来那项活动结束的起因；不给时与 reason 相同。 */
  endReason?: string;
}

/**
 * 记一次活动开始（移动阶段就是在流程里开始另一项活动）：先把还在进行的活动记录结束（记一条事件 ACTIVITY_ENDED，记录填上这一刻与
 * 这条事件的序号），再记一条事件 ACTIVITY_STARTED、插一条新的活动记录，返回开始那条事件的序号。任务没有在进行的活动时（空闲）
 * 没有可结束的，只记开始的一条，这时事件里的 from 是 null。
 * 在流程里开始时，新记录的节点与活动同一个写法，所属流程是首次分析；单独开展时这两列为空。事件的内容里也写这两样。
 * 必须在调用方已经开好的写事务里调用（withTaskDatabase），好让两条事件、两处记录与同一次调用里别的写入一起提交。
 */
export function recordStageMove(db: DatabaseSync, move: StageMove): number {
  // 库不检查活动的取值（lib/schema.ts），所以写之前在这里判：不是阶段表里的写法就不记。
  if (!isStage(move.to) || !isPosition(move.from)) throw new Error(`阶段记录里的阶段写法不对：从「${String(move.from)}」到「${String(move.to)}」。`);
  const who = { taskId: move.taskId, sessionId: move.sessionId, callId: move.callId, actor: move.actor };
  const at = wallClockText();
  endOpenRecords(db, who, at, move.endReason ?? move.reason);
  const inFlow = move.inFlow ?? true;
  const node = inFlow ? move.to : null, flow = inFlow ? FLOW_INITIAL : null;
  const seq = emit(db, {
    ...who, name: EVENT_ACTIVITY_STARTED,
    payload: { activity: move.to, node, flow, from: move.from === IDLE ? null : move.from, actor: move.actor, reason: move.reason, run_id: move.runId },
  });
  db.prepare(
    `INSERT INTO ${TABLE} (task_id, session_id, run_id, call_id, actor, activity, node, flow, reason, started_at, started_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(move.taskId, move.sessionId, move.runId, move.callId, move.actor, move.to, node, flow, move.reason, at, seq);
  return seq;
}

/** 把任务还在进行的活动记录都结束：每条记一条事件 ACTIVITY_ENDED，填上结束的时刻与那条事件的序号。返回结束了的那几条记录的活动与事件序号。 */
function endOpenRecords(db: DatabaseSync, who: { taskId: string; sessionId: string; callId: string; actor: StageActor }, at: string, reason: string):
  { activity: string; node: string | null; seq: number }[] {
  const open = db.prepare(`SELECT record_id, activity, node FROM ${TABLE} WHERE task_id = ? AND ended_at IS NULL ORDER BY started_seq`).all(who.taskId) as
    { record_id: number; activity: string; node: string | null }[];
  return open.map((one) => {
    const seq = emit(db, { ...who, name: EVENT_ACTIVITY_ENDED, payload: { activity: one.activity, node: one.node, reason, actor: who.actor } });
    db.prepare(`UPDATE ${TABLE} SET ended_at = ?, ended_seq = ? WHERE record_id = ?`).run(at, seq, one.record_id);
    return { activity: one.activity, node: one.node, seq };
  });
}

/**
 * 助手汇报单独开展的活动做完了：把那条活动记录结束，任务随之空闲。只有任务正在单独开展一项活动时才做；
 * 任务在流程里的某个阶段、任务空闲、任务没有阶段时什么都不记，返回 null。做了返回结束的是哪一项活动与那条事件的序号。
 * 必须在调用方已经开好的写事务里调用。
 */
export function endStandaloneActivity(db: DatabaseSync, who: { taskId: string; sessionId: string; callId: string; actor: StageActor }): { activity: Stage; event_seq: number } | null {
  const open = openActivityRecord(db, who.taskId);
  if (open === null || open.node !== null) return null;
  const ended = endOpenRecords(db, who, wallClockText(), ACTIVITY_DONE_REASON);
  return { activity: open.activity, event_seq: ended.at(-1)!.seq };
}

/**
 * 「回复」里写了 activity_done: true 时用：任务正在单独开展一项活动就返回 null（可以结束）；任务在流程里的某个阶段、
 * 任务空闲时返回拒绝的事实与怎么办（lib/stage.ts 的 activityDoneRefusal）。任务没有阶段（早先建的任务）、库还不在时也拒绝。自己开事务。
 */
export function activityDoneGate(workspaceDir: string): Refusal | null {
  const none: Refusal = ["回复里写了 activity_done，而这个任务没有活动可以结束", "去掉 activity_done 这一项再回复"];
  try {
    return withTaskDatabase(workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string } | undefined;
      const where = task ? whereIs(db, workspaceDir, task.task_id) : null;
      if (where === null) return none;
      return where.from !== IDLE && !where.fromInFlow ? null : activityDoneRefusal(where.from);
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) return none;
    throw error;
  }
}

/**
 * 助手在回复里汇报单独开展的活动做完了：结束那条活动记录（endStandaloneActivity），发起方记助手。自己开事务。
 * 任务这时已经不在单独开展的活动里（或者没有任务）时什么都不记，返回 null。
 */
export function reportActivityDone(workspaceDir: string, sessionId: string, callId: string): { activity: Stage; event_seq: number } | null {
  try {
    return withTaskDatabase(workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id, status FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; status: string } | undefined;
      if (!task || task.status !== TASK_ACTIVE) return null;
      return endStandaloneActivity(db, { taskId: task.task_id, sessionId, callId, actor: "executor" });
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) return null;
    throw error;
  }
}

/**
 * 一次移动（一次活动开始）的结果。moved 为真是记下了；为假时 why 写原因：same 原地不动（同一项活动、同一种开展方式），
 * user_only 开展活动要由用户决定，no_stages 这个任务没有阶段（早先建的任务），not_ready 单独开展这项活动缺前提（blocked 里写缺什么），
 * not_in_flow 任务不在首次分析流程里（空闲或者正在单独开展一项活动），卡片上的进入与退回不算数。
 * from 是开始之前任务在哪里（一个阶段或者空闲），任务没有阶段时为 null。记下了的另带 how（怎样开始的，lib/stage.ts 的 StartHow）与 in_flow。
 */
export interface StageMoveOutcome {
  requested: Stage;
  from: Position | null;
  moved: boolean;
  /** 没有移成的原因；not_next 与 not_back 只出现在卡片点击上：点的那个阶段不是紧挨着的下一段、不在现在这个阶段之前。 */
  why: "same" | "user_only" | "no_stages" | "not_next" | "not_back" | "not_ready" | "not_in_flow" | null;
  event_seq: number | null;
  how?: StartHow;
  in_flow?: boolean;
  /** why 为 not_ready 时：缺什么。 */
  blocked?: string;
}

/** 任务现在的位置、现在这项活动在不在流程里、首次分析走到的节点。任务没有阶段（或者库里没有这个任务）时为 null。 */
function whereIs(db: DatabaseSync, workspaceDir: string, taskId: string): { from: Position; fromInFlow: boolean; flowBefore: Stage | null; definition: TaskDefinition } | null {
  const task = db.prepare("SELECT definition_text FROM task WHERE task_id = ?").get(taskId) as { definition_text: string } | undefined;
  if (!task) return null;
  const definition = validateDefinition(JSON.parse(task.definition_text));
  const from = stageOf(db, workspaceDir, taskId, definition);
  if (from === null) return null;
  const open = openActivityRecord(db, taskId);
  return { from, fromInFlow: open !== null && open.node !== null, flowBefore: flowNode(db, taskId), definition };
}

/**
 * 想让任务开始一项活动：在流程里开始（inFlow 为真，移动阶段、启动或继续首次分析都是它），或者单独开展（inFlow 为假）。
 * 先看任务有没有阶段、这次行不行，行就记下。不行不抛错，原因写在结果里，由调用方决定怎样告诉助手或用户。
 * 开展活动只由用户决定；任务已经在同一项活动、同一种开展方式里时不记；单独开展要够前提（lib/stage.ts 的 activityBlocked），
 * 在流程里开始不查前提。有别的活动在进行、这次又不是流程里的移动时，原来那条记录结束的起因写「用户改做某项活动」。
 * 必须在调用方已经开好的写事务里调用。
 */
export function startActivity(db: DatabaseSync, workspaceDir: string, who: Omit<StageMove, "from" | "to" | "reason" | "inFlow" | "endReason">,
  to: Stage, inFlow: boolean, reason: string): StageMoveOutcome {
  const where = whereIs(db, workspaceDir, who.taskId);
  if (where === null) return { requested: to, from: null, moved: false, why: "no_stages", event_seq: null };
  const { from, fromInFlow, flowBefore } = where;
  const none = { requested: to, from, moved: false, event_seq: null };
  if (from === to && fromInFlow === inFlow) return { ...none, why: "same" };
  if (who.actor !== "user") return { ...none, why: "user_only" };
  if (!inFlow) {
    const blocked = activityBlocked(to, launchFacts(db, workspaceDir, who.taskId, where.definition));
    if (blocked !== null) return { ...none, why: "not_ready", blocked };
  }
  const how = startHow(inFlow, fromInFlow, flowBefore);
  const event_seq = recordStageMove(db, { ...who, from, to, reason, inFlow, ...(how !== "move" && from !== IDLE ? { endReason: switchedReason(to) } : {}) });
  return { requested: to, from, moved: true, why: null, event_seq, how, in_flow: inFlow };
}

/**
 * 想把任务移到某个阶段：就是在首次分析流程里开始那项活动（startActivity）。任务空闲或者正在单独开展一项活动时，
 * 这是启动或继续首次分析。必须在调用方已经开好的写事务里调用。
 */
export function moveStage(db: DatabaseSync, workspaceDir: string, who: Omit<StageMove, "from" | "to" | "reason" | "inFlow" | "endReason">, to: Stage, reason: string): StageMoveOutcome {
  return startActivity(db, workspaceDir, who, to, true, reason);
}

/** 算「开展一项活动」那一节要的事实（lib/stage.ts 的 LaunchFacts）：任务现在的位置、流程走到哪里、有没有材料、几页主题、几条需求条目。只读。 */
export function launchFacts(db: DatabaseSync, workspaceDir: string, taskId: string, definition: TaskDefinition): LaunchFacts {
  const open = openActivityRecord(db, taskId);
  const hasMaterials = taskHasMaterials(workspaceDir, definition.materialsDir);
  const position = currentStage(db, taskId);
  const questions = new Set(definition.collections.filter((one) => keepPendingField(one) !== null).map((one) => one.name));
  const live = db.prepare(
    "SELECT i.collection, v.fields FROM item i JOIN item_version v ON v.task_id = i.task_id AND v.item_id = i.item_id " +
      "AND v.revision_no = (SELECT MAX(revision_no) FROM item_version w WHERE w.task_id = i.task_id AND w.item_id = i.item_id) " +
      "WHERE i.task_id = ? AND i.deleted_in_revision IS NULL",
  ).all(taskId) as { collection: string; fields: string }[];
  const pages = live.filter((one) => one.collection === OVERALL_COLLECTION && !isDeprecatedText(one.fields)).length;
  const items = live.filter((one) => one.collection !== OVERALL_COLLECTION && !questions.has(one.collection)).length;
  return { position, inFlow: open !== null && open.node !== null, flowNode: flowNode(db, taskId), hasMaterials, pages, items };
}

/** 一页主题现在的字段内容（库里存的 JSON 文字）是不是已废弃。读不出来当作在用。 */
function isDeprecatedText(fields: string): boolean {
  try {
    return isDeprecated(JSON.parse(fields) as Record<string, unknown>);
  } catch {
    return false;
  }
}

/** 用户在卡片上点了「进入某个阶段」时，那条阶段记录里写的理由。 */
export function enterReason(to: Stage): string {
  return `用户在卡片上选了「${ENTER_OPTIONS[to].text}」`;
}
/**
 * 用户在卡片上点了「退回某个阶段」时，那条阶段记录里写的理由：点的是哪一项，后面接卡片的问句（助手在那里写为什么要退回）。
 * 问句是空的时只写点的是哪一项。
 */
export function backReason(to: Exclude<Stage, "document">, question: string): string {
  const said = question.trim();
  return `用户在卡片上选了「${BACK_OPTIONS[to].text}」${said ? `：${said}` : ""}`;
}
/** 点的是「开始写条目」时的理由。 */
export const START_ITEMS_REASON = enterReason("writing");

/**
 * 用户点了一张卡片上的选项：点的是助手提议的那张请选择卡片上「进入」或「退回」某个阶段的选项时，替用户记一次移动。
 * 进入的键各进入一个阶段（lib/stage.ts 的 ENTER_OPTIONS）：进入澄清、进入整理建模、开始写条目、进入评审确认、进入编写文档，
 * 以及任务空闲时的「开始核读材料」。
 * 先在会话当前分支上找到点的那条回复，确认它确实是助手发的请选择、选项里有这个键。这条分支上找不到那条回复时（卡片是在另一条会话里发的，
 * 用户从输入框上方的「待决定」一行或者任务状况卡上点了进入），改为核对任务库里开着的提议（lib/stage_proposal.ts）：点的键是它的进入键、
 * 给了回复编号时又正是它那一条，才算。两样都认不出就不记（返回 null），点击照常往下走。
 * 进入与退回是首次分析流程里的事，按任务现在在哪里判：
 * - 任务在流程里的某个阶段：次序不对的点击不记（why 为 not_next 或 not_back）。进入澄清、进入整理建模、进入评审确认、进入编写文档只在任务
 *   正处在紧挨着的前一段时才算；开始写条目在写条目之前的哪一段点都算（用户可以跳过中间的阶段），任务已经过了写条目时点它是退回写条目；
 *   退回的目标要在现在这个阶段之前。
 * - 任务空闲：只有「开始核读材料」算，它启动（或继续）首次分析、从核读材料开始；别的进入与退回都不算（why 为 not_in_flow）。
 * - 任务正在单独开展一项活动：进入与退回都不算（why 为 not_in_flow）。
 * 任务没有阶段、任务不在进行中、任务本来就在那个阶段时也不记，结果里写明原因。自己开事务，在卡片点击的处理函数里、
 * 发那句固定的话之前调用，这样助手回应这次点击的那一次运行从头就在新的阶段。
 */
export function recordStageCardClick(workspaceDir: string, sessionId: string, branch: readonly Entry[],
  click: { opId: string; replyEntry: unknown; optionKey: unknown }): StageMoveOutcome | null {
  const to = stageEnteredBy(click.optionKey);
  const back = to === null ? stageBackedBy(click.optionKey) : null;
  if (to === null && back === null) return null;
  // 回复编号没有给、或者给的是空文字（开着的提议没有记下它在哪条回复上时，页面只能这样发）：都当作没有给。
  const replyEntry = typeof click.replyEntry === "string" && click.replyEntry !== "" ? click.replyEntry : null;
  const card = replyEntry !== null ? branch.find((entry) => entry.id === replyEntry) : undefined;
  // 那条回复在这条分支上：照它自己判，是别的东西（用户的话、别的卡片、卡片上没有这个键）就不认，不再去看开着的提议。
  const act = card ? chooseActOf(card) : null;
  if (card && (!act || !act.options.some((option: { key?: unknown } | null) => option?.key === click.optionKey))) return null;
  try {
    return withTaskDatabase(workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id, status, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
        { task_id: string; status: string; definition_text: string } | undefined;
      if (!task || task.status !== TASK_ACTIVE) return null;
      let cardQuestion = typeof act?.text === "string" ? act.text : "";
      if (!card) {
        const open = openProposal(db, task.task_id);
        if (open === null || open.kind === "review" || open.enter.key !== click.optionKey) return null;
        if (replyEntry !== null && replyEntry !== open.reply_entry) return null;
        cardQuestion = open.text;
      }
      const where = whereIs(db, workspaceDir, task.task_id);
      const from = where?.from ?? null;
      const who = { taskId: task.task_id, sessionId, runId: null, callId: click.opId, actor: "user" as const };
      const unmoved = (why: "not_back" | "not_next" | "not_in_flow") => ({ requested: (back ?? to)!, from, moved: false, why, event_seq: null });
      if (where !== null && !where.fromInFlow) {
        // 任务空闲或者正在单独开展一项活动：只有空闲时的「开始核读材料」算。
        if (from === IDLE && to === "reading") return moveStage(db, workspaceDir, who, to, enterReason(to));
        return unmoved("not_in_flow");
      }
      if (back !== null) {
        // 退回：目标要在现在这个阶段之前；卡片的问句（助手写的原因）记进理由。
        if (from !== null && from !== IDLE && STAGES.indexOf(back) >= STAGES.indexOf(from)) return unmoved("not_back");
        return moveStage(db, workspaceDir, who, back, backReason(back, cardQuestion));
      }
      if (to !== "writing" && from !== null && from !== IDLE && nextStage(from) !== to) return unmoved("not_next");
      return moveStage(db, workspaceDir, who, to!, enterReason(to!));
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) return null;
    throw error;
  }
}

// ───────────── 现在在哪个阶段、每个阶段还差什么 ─────────────

/** 完成条件里要求评审的那一条的名字（与 lib/review.ts 的 REVIEW_CONDITION 同一个；这里不从它导入，免得两个文件互相导入）。 */
const REVIEWED_CONDITION = "每个条目评审通过";

/**
 * 材料清单里不是由别的文件生成的那几个。由 Word 或 PDF 材料生成的文字版（x.docx.md、早先的 x.docx.txt、x.pdf.md）与分段清单
 * （x.docx.segments.json、x.pdf.segments.json）旁边有那份原件时是生成出来的，不算一份材料。paths 是 listMaterials 列出的路径。
 */
export function sourceMaterials(paths: readonly string[]): string[] {
  const present = new Set(paths);
  const derived = (path: string): boolean => [".segments.json", ".md", ".txt"].some((suffix) => {
    if (!path.toLowerCase().endsWith(suffix)) return false;
    const stem = path.slice(0, -suffix.length);
    return /\.(docx|pdf)$/i.test(stem) && present.has(stem);
  });
  return paths.filter((one) => !derived(one));
}

/**
 * 任务现在的阶段（或者空闲）、最近一次是谁在什么时候为什么移的，以及六个阶段各自的几盏灯。谁、什么时候、为什么三项说的是
 * 还在进行的那条活动记录：一次都没有移过时、任务空闲时都为 null。空闲没有自己的灯。
 */
export interface StageSummary {
  current: Position;
  /** 现在这项活动在首次分析流程里的节点：在流程里时与 current 同一个写法；单独开展、空闲时为 null。 */
  node: Stage | null;
  /** 首次分析走到的节点（最近一条带节点的活动记录）；没有走过是 null。 */
  flow_node: Stage | null;
  /** 任务状况卡上「开展一项活动」一节的内容（lib/stage.ts 的 LaunchView）。 */
  launch: LaunchView;
  moved_by: StageActor | null;
  /** 最近一次移动的时刻（库里的本地时间写法）。 */
  moved_at: string | null;
  reason: string | null;
  lamps: Record<Stage, Lamp[]>;
}

/** 任务里还在的图各自算灯要的几样（lib/stage.ts 的 LampDiagram）。只读。 */
export function lampDiagrams(db: DatabaseSync, taskId: string, definition: TaskDefinition): LampDiagram[] {
  const records = liveDiagrams(readDiagrams(db, taskId));
  const seen = viewedDiagramRevisions(db, taskId);
  if (records.length === 0) return [];
  const prefixes = definition.collections.map((one) => one.prefix);
  const cited = db.prepare(
    `SELECT locator FROM item_source WHERE task_id = ? AND item_id = ? AND revision_no = ? AND kind = ?${elementClause(db, ELEMENT_FIGURE)} ORDER BY position`,
  );
  return records.map((record) => {
    const now = latestVersion(record)!;
    return {
      diagram_id: record.diagram_id, kind: now.kind,
      sources: [...new Set((cited.all(taskId, record.diagram_id, now.revision_no, SOURCE_ITEM) as { locator: string }[]).map((row) => row.locator.trim()))],
      drawn: drawnItemIds(now.mermaid, prefixes),
      linked: now.kind === KIND_CLASS ? classLinked(now.mermaid, prefixes) : [],
      branches: now.kind === KIND_FLOWCHART && hasBranch(now.mermaid),
      viewed: diagramViewed(record, seen),
      marked: hasPendingMark(now.mermaid),
    };
  });
}

/**
 * 算灯要的事实里只从任务库就读得出的那一部分：页、条目、问题、集合名、被引用的文档、图、规则冲突。只读。
 * 另外三样要看任务目录（材料清单、评审规则文件、完成条件的核对），由 lampInput 补上；模拟器的评测只有库的副本，只用这一部分
 * （cli/overall_state.mts）。
 */
export function lampFacts(db: DatabaseSync, taskId: string, definition: TaskDefinition): Omit<LampInput, "materials" | "review" | "completion"> {
  const state = overallState(db, taskId, definition);
  const statusFieldOf = new Map(definition.collections.flatMap((one) => {
    const field = keepPendingField(one);
    return field ? [[one.name, field.name] as [string, string]] : [];
  }));
  // 问题条目里说事情的那句话：它所在集合的第一个字段（需求规格这一类任务里是「事项」）。
  const subjectFieldOf = new Map(definition.collections.map((one) => [one.name, one.fields[0]?.name ?? ""]));
  const sourcesOf = (itemId: string) => state.sources.get(itemId) ?? [];
  const pages = state.items.filter((one) => one.collection === OVERALL_COLLECTION);
  const others = state.items.filter((one) => one.collection !== OVERALL_COLLECTION);
  const questions = others.filter((one) => statusFieldOf.has(one.collection));
  const diagrams = lampDiagrams(db, taskId, definition);
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const rules = rulesTable(
    pages.map((one) => ({ item_id: one.item_id, fields: one.fields, sources: sourcesOf(one.item_id), created_at: null })),
    questions.map((one) => ({
      item_id: one.item_id, subject: text(one.fields[subjectFieldOf.get(one.collection)!]), open: one.fields[statusFieldOf.get(one.collection)!] === QUESTION_OPEN_STATUS,
      kind: null, suggestion: "", sources: sourcesOf(one.item_id), created_at: null,
    })),
  );
  return {
    pages: pages.map((one) => lampPage(one.item_id, one.fields, state.viewed.get(one.item_id) === true, state.verification.get(one.item_id)?.pending_verification === true)),
    items: others.map((one) => {
      const verification = state.verification.get(one.item_id)!;
      return {
        item_id: one.item_id, collection: one.collection,
        cites: sourcesOf(one.item_id).filter((s) => s.kind === SOURCE_ITEM).map((s) => s.locator),
        citesDiagrams: [...new Set(sourcesOf(one.item_id).filter((s) => s.kind === SOURCE_FIGURE).map((s) => s.locator))],
        pending: verification.pending_verification || verification.basis_pending !== null,
        // 问题条目自己不算标着待定的地方：它就是用来记没定的事的。
        marked: !statusFieldOf.has(one.collection) && hasPendingMark(one.fields),
      };
    }),
    questions: questions.map((one) => lampQuestion(one.item_id, one.fields, statusFieldOf.get(one.collection)!)),
    collections: definition.collections.map((one) => one.name),
    citedDocuments: [...pages, ...questions].flatMap((one) => sourcesOf(one.item_id).filter((s) => s.kind === SOURCE_DOCUMENT).map((s) => s.locator)),
    diagrams,
    ruleConflicts: rules.conflicts,
    declared: {
      intro: definition.collections.some((one) => one.name === OVERALL_COLLECTION && one.fields.some((field) => field.name === OVERALL_FIELDS.intro)),
      blocking: definition.collections.some((one) => keepPendingField(one) !== null && one.fields.some((field) => field.name === QUESTION_BLOCKING_FIELD)),
    },
  };
}

/** 从任务库与任务目录里读出算灯要的全部事实（lib/stage.ts 的 LampInput）。只读。 */
export function lampInput(db: DatabaseSync, workspaceDir: string, taskId: string, definition: TaskDefinition): LampInput {
  const facts = lampFacts(db, taskId, definition);
  const reviewed = new Set(Object.entries(definition.completion).filter(([, names]) => names.includes(REVIEWED_CONDITION)).map(([name]) => name));
  const revisionOf = new Map((db.prepare(
    "SELECT i.item_id, (SELECT MAX(revision_no) FROM item_version w WHERE w.task_id = i.task_id AND w.item_id = i.item_id) AS no FROM item i WHERE i.task_id = ? AND i.deleted_in_revision IS NULL",
  ).all(taskId) as { item_id: string; no: number }[]).map((row) => [row.item_id, Number(row.no)]));
  const hashOf = new Map<string, string | null>();
  const failing = facts.items.filter((one) => {
    if (!reviewed.has(one.collection)) return false;
    if (!hashOf.has(one.collection)) hashOf.set(one.collection, currentRulesHash(db, workspaceDir, one.collection));
    return verdictAt(db, taskId, one.item_id, revisionOf.get(one.item_id)!, hashOf.get(one.collection)!).state === "failed";
  }).map((one) => one.item_id);
  const completion = checkCompletion(db, taskId, definition.completion, { workspaceDir });
  return {
    ...facts,
    materials: sourceMaterials(listMaterials(workspaceDir, definition.materialsDir).files.map((one) => one.path)),
    review: { failing, any: db.prepare("SELECT 1 FROM review WHERE task_id = ? LIMIT 1").get(taskId) !== undefined },
    completion: {
      satisfied: completion.every((one) => one.satisfied),
      unmet: completion.filter((one) => !one.satisfied).map((one) => `「${one.collection}」${one.condition}：${one.summary}`),
    },
  };
}

/**
 * 任务现在的阶段与每个阶段的几盏灯。早先建的任务（没有「总体分析」集合）没有阶段，返回 null。只读：
 * 助手的查询任务状态与后端的整份数据都经这里，所以两侧说的是同一回事。
 */
export function stageSummary(db: DatabaseSync, workspaceDir: string, taskId: string, definition: TaskDefinition): StageSummary | null {
  if (!hasOverall(definition.collections)) return null;
  const open = openActivityRecord(db, taskId);
  const facts = launchFacts(db, workspaceDir, taskId, definition);
  return {
    current: facts.position,
    node: facts.position !== IDLE && facts.inFlow ? facts.position : null,
    flow_node: facts.flowNode,
    launch: launchView(facts),
    moved_by: open?.actor ?? null,
    moved_at: open?.started_at ?? null,
    reason: open ? open.reason : null,
    lamps: stageLamps(lampInput(db, workspaceDir, taskId, definition)),
  };
}

/**
 * 同上，但任务与它的定义由这里自己从库里取（库里的第一个任务）：给手里只有库连接与任务目录的调用方用（后端的整份数据）。
 * 库里还没有任务时返回 null。
 */
export function stageSummaryOf(db: DatabaseSync, workspaceDir: string): StageSummary | null {
  const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; definition_text: string } | undefined;
  return task ? stageSummary(db, workspaceDir, task.task_id, validateDefinition(JSON.parse(task.definition_text))) : null;
}

/** 任务空闲时给助手看的那一句。 */
export const IDLE_LINE = "任务现在空闲：没有在进行的活动。开展哪一项活动由用户决定。";

/**
 * 给助手看的一段：任务现在在哪个阶段、最近一次是谁在什么时候为什么移的，以及这一段还差什么（只说现在这个阶段的几盏灯）。
 * 查询任务状态的返回末尾用它。任务空闲时只有一句，不说灯：空闲没有自己的灯。
 */
export function stageLines(summary: StageSummary): string[] {
  if (summary.current === IDLE) return [IDLE_LINE];
  const name = STAGE_NAMES[summary.current];
  const reason = (summary.reason ?? "").replace(/[。.\s]+$/, "");
  if (summary.node === null && summary.moved_by !== null) {
    // 单独开展的活动：不在首次分析流程里，做够了由助手汇报结束。
    return [
      `任务现在在单独开展${name}这项活动，不在首次分析流程里（${summary.moved_by === "user" ? "用户" : "助手"}在 ${(summary.moved_at ?? "").slice(0, 16).replace("T", " ")} 开始的${reason ? `，理由：${reason}` : ""}）。` +
        "这项活动做够了就在回复里汇报结束（回复里写 activity_done: true），不提议进入别的活动。",
      ...lampLines(summary.current, summary.lamps[summary.current]),
    ];
  }
  const head = summary.moved_by === null
    ? `任务现在在${name}阶段（任务建好之后还没有人移动过）。`
    : `任务现在在${name}阶段（${summary.moved_by === "user" ? "用户" : "助手"}在 ${(summary.moved_at ?? "").slice(0, 16).replace("T", " ")} 移过来的${reason ? `，理由：${reason}` : ""}）。`;
  return [head, ...lampLines(summary.current, summary.lamps[summary.current])];
}
