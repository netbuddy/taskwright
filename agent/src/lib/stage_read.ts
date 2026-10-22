/**
 * 工作的阶段里读写任务库的那一半（不读库的在 lib/stage.ts）：一条会话现在在做什么、启动一个工作项、流程换站、删除一个工作项。
 *
 * 承载是活动记录表与工作项的会话表（lib/schema.ts）。活动记录表一行是一个工作项，也就是一次启动：启动一项单项活动，或者启动一条
 * 工作流程（现在只有需求分析）。每条会话在建立时指向一个工作项，或者不指向任何工作项（自由讨论的会话），之后不改；
 * 一个工作项可以先后有几条会话，一个任务可以同时有几个工作项，其中流程的工作项至多一个。工作项没有终点，不要了由用户删除，
 * 它的会话随之归档。
 * 助手在一条会话里能写什么，看这条会话指向的工作项现在做的是哪一项活动：会话不属于任何工作项（自由讨论的会话、归档的会话）时
 * 按空闲办（lib/stage.ts 的 IDLE）。任务一级没有「现在在哪个阶段」。
 * 流程的工作项换站（进入下一段、退回前面的阶段）只更新这一行的活动与所在的一站，记一条事件，不另开一行。
 * 早先建的任务（任务定义里没有「业务说明」集合）没有阶段：stageOf 返回 null，调用方据此什么都不做。
 */

import { assetNamesOf } from "./asset_names.ts";
import type { DatabaseSync } from "node:sqlite";
import { type AssetCell, type AssetFacts, type Catalog, assetCells, assetFacts, blockedByStage, blockedText, catalog, missingSlot } from "./activity_catalog.ts";
import { DefinitionHeadError } from "./activity_def.ts";
import { type Definitions, activityNameOf, activityStage, definitionsFor, flowNameOf } from "./activity_def_read.ts";
import { type Entry, chooseActOf } from "./completion_consent.ts";
import { checkCompletion } from "./conditions.ts";
import { emit, wallClockText } from "./db.ts";
import { type TaskDefinition, keepPendingField, validateDefinition } from "./definition.ts";
import { diagramViewed, latestVersion, liveDiagrams, readDiagrams, viewedDiagramRevisions } from "./diagram.ts";
import { classLinked, drawnItemIds, hasBranch } from "./diagram_scan.ts";
import { OVERALL_COLLECTION, OVERALL_FIELDS, hasOverall } from "./overall_analysis.ts";
import { overallState } from "./overall_read.ts";
import { rulesTable } from "./overall_views.ts";
import { EVENT_REVIEW_BATCH, currentRulesHash, verdictAt } from "./review_state.ts";
import {
  ELEMENT_FIGURE, NoDatabaseYet, SOURCE_DOCUMENT, SOURCE_FIGURE, SOURCE_ITEM, elementClause, withTaskDatabase,
} from "./schema.ts";
import { openProposal } from "./stage_proposal.ts";
import {
  FLOW_ANALYSIS, FLOW_NAMES, type FlowItemRef, IDLE, STAGES, KIND_CLASS, KIND_FLOWCHART, type Lamp, type LampDiagram, type LampInput, type MaterialCoverage, type LaunchFacts, type LaunchView,
  type Position, QUESTION_OPEN_STATUS, type Refusal, STAGE_NAMES, type Stage, type StageActor, type StartHow, type WriteKind,
  activityDoneRefusal, flowKeyOf, isStage, lampLines, launchView, QUESTION_BLOCKING_FIELD, hasPendingMark, lampPage, lampQuestion, stageLamps, cardMove, gotoOption, nextStepOption,
} from "./stage.ts";
import { refusalText } from "./texts.ts";
import { listMaterials } from "./task_status.ts";
import { materialRoles, roleOf } from "./material_db.ts";
import { envSegmentParams, materialFacts } from "./segments.ts";
import { versionCount } from "./versions.ts";

/**
 * 工作项的三种事件。
 * - ACTIVITY_STARTED：启动了一个工作项。内容：record_id（工作项的记录号）、activity（做的是哪一项活动）、node 与 flow（流程的工作项
 *   是启动的那一站与流程的键，单项活动的为 null）、from（恒为 null）、actor、reason、run_id，写了范围说明时另有 scope。
 * - ACTIVITY_NODE_ENTERED：流程的工作项换了一站。内容：record_id、flow、node（到哪一站）、from（从哪一站）、
 *   direction（forward 是进入后面的阶段，back 是退回前面的阶段）、actor、reason、run_id。
 * - WORK_ITEM_DELETED：用户删除了一个工作项。内容：record_id、activity、node、flow、scope（有才写）、archived_sessions（随之归档了几条会话）、
 *   actor、reason。
 * 早先另有 ACTIVITY_ENDED（一项活动结束）：格式版本 7 之前一次移动记一对「结束、开始」，内容里没有 record_id；升级上来的库里它们原样留着，
 * 现在不再记。
 */
export const EVENT_ACTIVITY_STARTED = "ACTIVITY_STARTED";
export const EVENT_ACTIVITY_ENDED = "ACTIVITY_ENDED";
export const EVENT_NODE_ENTERED = "ACTIVITY_NODE_ENTERED";
export const EVENT_WORK_ITEM_DELETED = "WORK_ITEM_DELETED";
/**
 * 早先记一次移动用的事件名（格式版本 4 及更早）：一次移动一条，内容是 stage（移到哪个阶段）、from、actor、reason、run_id、flow。
 * 现在不再记这种事件；升级上来的库里它们原样留着，读事件的几处几种名字都认。
 */
export const EVENT_STAGE_MOVED = "STAGE_MOVED";

const TABLE = "activity_record";
const SESSIONS = "work_item_session";

/** 活动记录表里的一行：一个工作项。 */
export interface ActivityRecord {
  record_id: number;
  /** 现在做的是哪一项活动：任务类型声明里的活动标识符；早先的记录是六个阶段键之一。工作流的工作项随换站更新。 */
  activity: string;
  /** 流程的工作项现在在哪一站（与活动同一个写法）；单项活动的工作项为 null。 */
  node: string | null;
  /** 流程的工作项属于哪条流程（lib/stage.ts 的 FLOW_ANALYSIS）；单项活动的工作项为 null。 */
  flow: string | null;
  /**
   * 早先（格式版本 7 之前）记的「开始这项活动之前任务在哪个阶段」：取自记下启动的那条事件的内容。现在启动的工作项恒为 null。
   */
  from: Stage | null;
  actor: StageActor;
  reason: string;
  run_id: string | null;
  /** 启动这个工作项时所在的会话。 */
  session_id: string;
  call_id: string;
  started_at: string;
  started_seq: number;
  /** 用户启动时写的范围说明；没有写是 null。 */
  scope: string | null;
}

/**
 * 读活动记录的列：表里的各列，加上从记下启动的那条事件的内容里取的「从哪个阶段来」（早先的记录才有）。
 * 早先的流程键 initial 读成现在的写法。
 */
const RECORD_COLUMNS = "r.record_id, r.activity, r.node, r.flow, r.actor, r.reason, r.run_id, r.session_id, r.call_id, r.started_at, r.started_seq, r.scope, " +
  "CASE WHEN e.seq IS NOT NULL AND json_valid(e.payload) THEN json_extract(e.payload, '$.from') ELSE NULL END AS \"from\"";
const RECORD_FROM = `${TABLE} r LEFT JOIN event e ON e.seq = r.started_seq`;

type RecordRow = Omit<ActivityRecord, "from"> & { from: unknown };
const recordOf = (row: RecordRow): ActivityRecord => ({
  ...row, record_id: Number(row.record_id), started_seq: Number(row.started_seq), flow: flowKeyOf(row.flow),
  from: isStage(row.from) ? row.from : null, scope: typeof row.scope === "string" && row.scope !== "" ? row.scope : null,
});

/** 一行活动记录的活动是不是一段非空的文字：是才认这一行（取值合不合规由写入的一侧先判）。 */
const hasActivity = (row: RecordRow): boolean => typeof row.activity === "string" && row.activity !== "";

/** 全部工作项，按启动的先后排。活动一列是空的记录不认。 */
export function activityRecords(db: DatabaseSync, taskId: string): ActivityRecord[] {
  const rows = db.prepare(`SELECT ${RECORD_COLUMNS} FROM ${RECORD_FROM} WHERE r.task_id = ? ORDER BY r.started_seq, r.record_id`).all(taskId) as unknown as RecordRow[];
  return rows.filter(hasActivity).map(recordOf);
}

/** 按记录号取一个工作项；没有时是 null。 */
export function workItemById(db: DatabaseSync, taskId: string, recordId: number): ActivityRecord | null {
  const row = db.prepare(`SELECT ${RECORD_COLUMNS} FROM ${RECORD_FROM} WHERE r.task_id = ? AND r.record_id = ?`).get(taskId, recordId) as RecordRow | undefined;
  return row && hasActivity(row) ? recordOf(row) : null;
}

/**
 * 这条会话属于哪个工作项；会话不属于任何工作项（自由讨论的会话、归档的会话）、没有给会话编号时是 null。
 */
export function sessionWorkItem(db: DatabaseSync, taskId: string, sessionId: string | null | undefined): ActivityRecord | null {
  if (!sessionId) return null;
  const row = db.prepare(
    `SELECT ${RECORD_COLUMNS} FROM ${RECORD_FROM} JOIN ${SESSIONS} s ON s.record_id = r.record_id WHERE r.task_id = ? AND s.session_id = ? AND s.archived_at IS NULL`,
  ).get(taskId, sessionId) as RecordRow | undefined;
  return row && hasActivity(row) ? recordOf(row) : null;
}

/** 这条会话正在做的工作项：与 sessionWorkItem 相同（工作项没有终点，会话属于哪个工作项就是在做哪个）。 */
export function openActivityRecord(db: DatabaseSync, taskId: string, sessionId: string | null | undefined): ActivityRecord | null {
  return sessionWorkItem(db, taskId, sessionId);
}

/** 每条挂在工作项上的会话各属于哪个工作项（会话编号到记录号），与挂上的时刻。归档的会话不在里面。 */
export function workItemSessions(db: DatabaseSync, taskId: string): { session_id: string; record_id: number; attached_at: string }[] {
  const rows = db.prepare(`SELECT session_id, record_id, attached_at FROM ${SESSIONS} WHERE task_id = ? AND archived_at IS NULL ORDER BY attached_at, rowid`).all(taskId) as
    { session_id: string; record_id: number; attached_at: string }[];
  return rows.map((row) => ({ ...row, record_id: Number(row.record_id) }));
}

/** 归档的会话（它们的工作项被删除了）：会话编号到归档的时刻（库里的本地时间写法）与它曾属于的那个已经删除的工作项的记录号。 */
export function archivedSessions(db: DatabaseSync, taskId: string): Map<string, { archived_at: string; record_id: number }> {
  const rows = db.prepare(`SELECT session_id, archived_at, record_id FROM ${SESSIONS} WHERE task_id = ? AND archived_at IS NOT NULL`).all(taskId) as
    { session_id: string; archived_at: string; record_id: number }[];
  return new Map(rows.map((row) => [row.session_id, { archived_at: row.archived_at, record_id: Number(row.record_id) }]));
}

/** 任务目录里有没有材料：材料目录第一层至少有一个文件（与任务现状消息列材料用的是同一个清单）。 */
export function taskHasMaterials(workspaceDir: string, materialsDir: string): boolean {
  return listMaterials(workspaceDir, materialsDir).files.length > 0;
}

/**
 * 这条会话现在在哪里：它正在做的工作项现在做的那项活动（那个阶段）；没有就是空闲。不管任务有没有阶段，调用方先用 hasOverall 判。
 * 只认阶段键：只给早先的记录（活动标识符与阶段键相同）与测试用；活动标识符不是阶段键的工作项在这里认不出、按空闲算。要位置用 stageOf。
 */
export function currentStage(db: DatabaseSync, taskId: string, sessionId: string | null | undefined): Position {
  const activity = openActivityRecord(db, taskId, sessionId)?.activity;
  return activity !== undefined && isStage(activity) ? activity : IDLE;
}

/**
 * 一个活动标识符算作哪个阶段（lib/activity_def_read.ts 的 activityStage）。声明读不出来时，阶段键照它自己算（早先的记录），
 * 别的键抛错（DefinitionHeadError）。
 */
export function positionOf(workspaceDir: string, definition: Pick<TaskDefinition, "skillPath">, key: string): Stage {
  const found = definitionsOrError(workspaceDir, definition);
  if (found.defs) return activityStage(found.defs, key);
  if (isStage(key)) return key;
  throw new DefinitionHeadError(`活动的定义读不出来，认不出活动记录里的「${key}」：${found.error}`);
}

/** 这条会话现在在哪个阶段（或者空闲）；早先建的任务（没有「业务说明」集合）没有阶段，返回 null。 */
export function stageOf(db: DatabaseSync, workspaceDir: string, taskId: string, definition: Pick<TaskDefinition, "collections" | "materialsDir" | "skillPath">,
  sessionId: string | null | undefined): Position | null {
  if (!hasOverall(definition.collections)) return null;
  const open = openActivityRecord(db, taskId, sessionId);
  return open ? positionOf(workspaceDir, definition, open.activity) : IDLE;
}

/** 在这个位置助手能做哪几类写入：取这个任务的活动声明生成的获准能力表（lib/activity_def_read.ts）。声明读不出来时抛错。 */
export function allowedAt(workspaceDir: string, definition: Pick<TaskDefinition, "skillPath">, stage: Position): readonly WriteKind[] {
  return definitionsFor(workspaceDir, definition.skillPath).allowed[stage];
}

/**
 * 一个工作项是哪一种、叫什么：工作流的工作项叫工作流的名字，单项活动的叫活动的名字。给了声明（defs）时名字取自声明，
 * 声明里没有、或者没有给时取 FLOW_NAMES 与 STAGE_NAMES，再没有就是键本身。
 */
export function workItemName(item: Pick<ActivityRecord, "activity" | "flow">, defs: Definitions | null = null): string {
  return item.flow !== null ? flowNameOf(defs, item.flow) : activityNameOf(defs, item.activity);
}

/**
 * 属于一个工作项的会话在建立时起的名字：单项活动是活动的名字，例如「整理建模」；流程是「需求分析」，不带所在的那一站
 * （站会往下走，名字不跟着改，带上站名会被读成现在的阶段）；写了范围说明的在后面接「 · 」与范围说明的前 12 个字。
 */
export const SESSION_NAME_SCOPE_LENGTH = 12;
export function workItemSessionName(item: Pick<ActivityRecord, "activity" | "flow" | "scope">, defs: Definitions | null = null): string {
  const base = workItemName(item, defs);
  const scope = [...(item.scope ?? "").replace(/\s+/g, " ").trim()].slice(0, SESSION_NAME_SCOPE_LENGTH).join("");
  return scope ? `${base} · ${scope}` : base;
}

/** 做一次写入的是谁：哪个任务、哪条会话、哪次调用（助手的工具调用编号或者界面操作的操作编号）、助手还是用户。 */
export interface Who {
  taskId: string;
  sessionId: string;
  /** 助手做的时候的运行号；用户做的时候为 null。 */
  runId: string | null;
  callId: string;
  actor: StageActor;
}

/** 把一条会话挂到一个工作项上。一条会话只属于一个工作项：已经挂过的会话不改。 */
export function attachSession(db: DatabaseSync, taskId: string, recordId: number, sessionId: string, at: string = wallClockText()): void {
  db.prepare(`INSERT OR IGNORE INTO ${SESSIONS} (session_id, record_id, task_id, attached_at) VALUES (?, ?, ?, ?)`).run(sessionId, recordId, taskId, at);
}

/**
 * 启动一个工作项：插一行活动记录，把启动时所在的会话挂上去，记一条事件 ACTIVITY_STARTED。返回记录号与那条事件的序号。
 * 在工作流里启动时（flow 不是 null），这一行的所在一站与活动同一个写法，所属工作流由调用方给出；单项活动的这两列为空。
 * 写了范围说明时记进范围说明一列，事件的内容里也带上（scope）。这次行不行由 startActivity 先判，这里只管写。
 * 必须在调用方已经开好的写事务里调用（withTaskDatabase）。
 */
export function launchWorkItem(db: DatabaseSync, launch: Who & { to: string; flow: string | null; reason: string; scope?: string }): { record_id: number; event_seq: number } {
  // 库不检查活动的取值（lib/schema.ts）；是不是声明里的活动由 startActivity 先判，这里只拦空的。
  if (typeof launch.to !== "string" || launch.to === "") throw new Error(`活动记录里的活动写法不对：「${String(launch.to)}」。`);
  if (launch.flow !== null && (typeof launch.flow !== "string" || launch.flow === "")) throw new Error(`活动记录里的所属工作流写法不对：「${String(launch.flow)}」。`);
  const at = wallClockText();
  const flow = launch.flow, node = flow !== null ? launch.to : null;
  const scope = (launch.scope ?? "").trim() || null;
  // 事件的内容里要写记录号，所以先定下它：用过的最大记录号加一（在同一个写事务里，不会与别的写入撞上）。
  // 用过的最大记录号取自增计数与表里现有的最大记录号两者的大者：删掉的工作项的记录号不再用。
  const counted = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get() !== undefined;
  const used = counted ? db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(TABLE) as { seq: number } | undefined : undefined;
  const recordId = Math.max(Number(used?.seq ?? 0), Number((db.prepare(`SELECT COALESCE(MAX(record_id), 0) AS top FROM ${TABLE}`).get() as { top: number }).top)) + 1;
  const seq = emit(db, {
    taskId: launch.taskId, sessionId: launch.sessionId, callId: launch.callId, actor: launch.actor, name: EVENT_ACTIVITY_STARTED,
    payload: { record_id: recordId, activity: launch.to, node, flow, from: null, actor: launch.actor, reason: launch.reason, run_id: launch.runId, ...(scope ? { scope } : {}) },
  });
  db.prepare(
    `INSERT INTO ${TABLE} (record_id, task_id, session_id, run_id, call_id, actor, activity, node, flow, reason, started_at, started_seq, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(recordId, launch.taskId, launch.sessionId, launch.runId, launch.callId, launch.actor, launch.to, node, flow, launch.reason, at, seq, scope);
  attachSession(db, launch.taskId, recordId, launch.sessionId, at);
  return { record_id: recordId, event_seq: seq };
}

/**
 * 流程的工作项换一站：更新这一行的活动与所在的一站，记一条事件 ACTIVITY_NODE_ENTERED，返回那条事件的序号。不另开一行。
 * steps 是这条工作流声明的各步（活动标识符）：给了时要去的一步要在里面，方向按各步的先后算；没有给（声明读不出来）时只认阶段键。
 * 去的一步或者现在这一步不在各步里时，方向按阶段的先后算；都不是阶段时记 forward。必须在调用方已经开好的写事务里调用。
 */
export function enterNode(db: DatabaseSync, item: ActivityRecord, to: string, who: Who, reason: string, steps: readonly string[] | null = null): number {
  if (steps !== null ? !steps.includes(to) : !isStage(to)) throw new Error(`活动记录里的活动写法不对：「${String(to)}」。`);
  const order = (list: readonly string[]): number | null => {
    const a = list.indexOf(to), b = list.indexOf(item.activity);
    return a < 0 || b < 0 ? null : a - b;
  };
  const delta = (steps !== null ? order(steps) : null) ?? order(STAGES) ?? 1;
  const seq = emit(db, {
    taskId: who.taskId, sessionId: who.sessionId, callId: who.callId, actor: who.actor, name: EVENT_NODE_ENTERED,
    payload: { record_id: item.record_id, flow: item.flow, node: to, from: item.node, direction: delta > 0 ? "forward" : "back",
      actor: who.actor, reason, run_id: who.runId },
  });
  db.prepare(`UPDATE ${TABLE} SET activity = ?, node = ? WHERE record_id = ?`).run(to, to, item.record_id);
  return seq;
}

/**
 * 删除一个工作项：记一条事件 WORK_ITEM_DELETED，把它的会话全部归档（记下归档的时刻，记录号照旧留着；守门按归档的时刻判断，
 * 归档的会话不属于任何工作项），删掉活动记录那一行。
 * 修订与别的事件都不动。返回随之归档了几条会话与那条事件的序号。必须在调用方已经开好的写事务里调用。
 */
export function deleteWorkItem(db: DatabaseSync, item: ActivityRecord, who: Omit<Who, "runId">, reason: string): { archived: number; event_seq: number } {
  const archived = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${SESSIONS} WHERE record_id = ? AND archived_at IS NULL`).get(item.record_id) as { n: number }).n);
  const seq = emit(db, {
    taskId: who.taskId, sessionId: who.sessionId, callId: who.callId, actor: who.actor, name: EVENT_WORK_ITEM_DELETED,
    payload: { record_id: item.record_id, activity: item.activity, node: item.node, flow: item.flow, ...(item.scope ? { scope: item.scope } : {}),
      archived_sessions: archived, actor: who.actor, reason },
  });
  db.prepare(`UPDATE ${SESSIONS} SET archived_at = ? WHERE record_id = ? AND archived_at IS NULL`).run(wallClockText(), item.record_id);
  db.prepare(`DELETE FROM ${TABLE} WHERE record_id = ?`).run(item.record_id);
  return { archived, event_seq: seq };
}

/**
 * 「回复」里写了 activity_done: true 时用：这条会话正在做一个单项活动的工作项就返回 null（可以汇报）；工作项是流程的、
 * 会话不属于哪个工作项时返回拒绝的事实与怎么办（lib/stage.ts 的 activityDoneRefusal）。任务没有阶段（早先建的任务）、库还不在时也拒绝。
 * 汇报做完只是回复下面的一句话，不改任何记录。自己开事务。
 */
export function activityDoneGate(workspaceDir: string, sessionId: string): Refusal | null {
  const none: Refusal = refusalText("gate.activity_done_not_single_activity.no_stages");
  try {
    return withTaskDatabase(workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string } | undefined;
      const where = task ? whereIs(db, workspaceDir, task.task_id, sessionId) : null;
      if (where === null) return none;
      return where.item !== null && where.item.flow === null ? null : activityDoneRefusal(where.from);
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) return none;
    throw error;
  }
}

/**
 * 助手在回复里汇报这条会话的工作项做完了时，那条回复下面要写的是哪一项活动：这条会话正在做单项活动的工作项时是那项活动，
 * 别的情形（流程的工作项、自由讨论的会话、没有任务）是 null。只读，不改任何记录。
 */
export function activityDoneOf(workspaceDir: string, sessionId: string): { activity: string; record_id: number } | null {
  try {
    return withTaskDatabase(workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string } | undefined;
      const open = task ? sessionWorkItem(db, task.task_id, sessionId) : null;
      return open !== null && open.flow === null ? { activity: open.activity, record_id: open.record_id } : null;
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) return null;
    throw error;
  }
}

/**
 * 一次启动或者一次换站的结果。moved 为真是记下了；为假时 why 写原因：same 原地不动（流程的工作项已经在那一站），
 * user_only 启动与换站要由用户决定，no_stages 这个任务没有阶段（早先建的任务），not_ready 启动这项单项活动缺前提（blocked 里写缺什么），
 * not_in_flow 这条会话不在做流程的工作项（自由讨论的会话、归档的会话、单项活动的工作项），卡片上的进入与退回不算数，
 * session_bound 这条会话已经属于一个工作项，不能再在它上面启动另一个，flow_exists 任务里已有流程的工作项（existing 里写是哪一个），
 * 不能再以流程方式启动；只在启动时出现的几种：unknown_activity 声明里没有这项活动，not_startable 这项活动只能由用户发起（发布），
 * not_alone 这项活动声明为不能单独启动、却要单项启动（逆向解析只在工作流里做），missing_slot 工作流的必填材料槽位还空着（slot_name 写是哪一个），
 * unknown_flow 声明里没有这条工作流，not_a_step 这项活动不是这条工作流的一步，no_definitions 活动的声明读不出来（message 里写原因）。
 * from 是这条会话当时在哪里（一个阶段或者空闲），任务没有阶段时为 null。记下了的另带 how（lib/stage.ts 的 StartHow）、in_flow 与工作项的记录号。
 */
export interface StageMoveOutcome {
  /** 要启动或者要去的那项活动的键。 */
  requested: string;
  from: Position | null;
  moved: boolean;
  /** 没有做成的原因；not_next 与 not_back 只出现在卡片点击上：点的那个阶段不是紧挨着的下一段、不在现在这个阶段之前。 */
  why: "same" | "user_only" | "no_stages" | "not_next" | "not_back" | "not_ready" | "not_in_flow" | "session_bound" | "flow_exists"
    | "unknown_activity" | "not_startable" | "not_alone" | "unknown_flow" | "not_a_step" | "missing_slot" | "no_definitions" | null;
  event_seq: number | null;
  how?: StartHow;
  in_flow?: boolean;
  record_id?: number;
  /** why 为 not_ready 时：缺什么。 */
  blocked?: string;
  /** why 为 flow_exists 时：任务里已有的那个流程的工作项。 */
  existing?: FlowItemRef;
  /** why 为 no_definitions 时：声明为什么读不出来。 */
  message?: string;
  /** why 为 missing_slot 时：还空着的那个必填材料槽位的名称。 */
  slot_name?: string;
}

/** 这条会话现在的位置与它正在做的工作项（没有是 null）。任务没有阶段（或者库里没有这个任务）时为 null。 */
function whereIs(db: DatabaseSync, workspaceDir: string, taskId: string, sessionId: string | null | undefined):
  { from: Position; item: ActivityRecord | null; definition: TaskDefinition } | null {
  const task = db.prepare("SELECT definition_text FROM task WHERE task_id = ?").get(taskId) as { definition_text: string } | undefined;
  if (!task) return null;
  const definition = validateDefinition(JSON.parse(task.definition_text));
  if (!hasOverall(definition.collections)) return null;
  const item = openActivityRecord(db, taskId, sessionId);
  return { from: item ? positionOf(workspaceDir, definition, item.activity) : IDLE, item, definition };
}

/**
 * 在一条会话上启动一个工作项：启动一条工作流（flow 是它的键，to 是从哪一步启动），或者启动一项单项活动（flow 为 null）。
 * to 是任务类型声明里的活动标识符。先看任务有没有阶段、这次行不行，行就记下。不行不抛错，原因写在结果里，由调用方决定怎样告诉助手或用户。
 * 启动只由用户决定；这条会话已经属于一个工作项时不能再启动（一条会话只属于一个工作项，要做别的另开一条会话）；
 * 声明里要有这项活动，它不能是只能由用户发起的那种（发布）；单项启动时它要能单独启动（声明的 alone）；在工作流里启动时声明里要有这条工作流、to 要是它的一步，
 * 任务里已有工作流的工作项（不论哪条）就不能启动：一个任务同一时刻至多一个工作流的工作项。
 * 单项活动要够前提（这项活动声明的 requires，lib/activity_catalog.ts 的 blockedText），在工作流里启动不查前提；
 * 同一项单项活动已经有工作项时不拦：再启动是另起一个。
 * scope 是用户写的范围说明（可以不写）。必须在调用方已经开好的写事务里调用。
 */
export function startActivity(db: DatabaseSync, workspaceDir: string, who: Who, to: string, flow: string | null, reason: string, scope = ""): StageMoveOutcome {
  const where = whereIs(db, workspaceDir, who.taskId, who.sessionId);
  if (where === null) return { requested: to, from: null, moved: false, why: "no_stages", event_seq: null };
  const none = { requested: to, from: where.from, moved: false, event_seq: null };
  if (who.actor !== "user") return { ...none, why: "user_only" };
  if (sessionWorkItem(db, who.taskId, who.sessionId) !== null) return { ...none, why: "session_bound" };
  const found = definitionsOrError(workspaceDir, where.definition);
  // 声明读不出来：单项活动照早先的办法按缺前提拦（缺的是「活动的定义读不出来」），在工作流里启动拦下并写明原因。
  if (!found.defs) return flow === null ? { ...none, why: "not_ready", blocked: `活动的定义读不出来：${found.error}` } : { ...none, why: "no_definitions", message: found.error };
  const activity = found.defs.activities.find((one) => one.key === to);
  if (!activity) return { ...none, why: "unknown_activity" };
  if (activity.mode === "user_only") return { ...none, why: "not_startable" };
  // 声明为不能单独启动的活动（逆向解析）只在工作流里做：单项启动拦下，在工作流里启动照常。
  if (flow === null && !activity.alone) return { ...none, why: "not_alone" };
  if (flow !== null) {
    const declared = found.defs.flows.find((one) => one.key === flow);
    if (!declared) return { ...none, why: "unknown_flow" };
    if (!declared.steps.includes(to)) return { ...none, why: "not_a_step" };
    const existing = flowWorkItem(db, who.taskId, found.defs);
    if (existing !== null) return { ...none, why: "flow_exists", existing };
    // 必填的收材料的槽位要有材料（按放进的槽位数，lib/activity_catalog.ts 的 missingSlot）；没有槽位的工作流不查。
    const slot = declared.slots.length > 0 ? missingSlot(declared.slots, assetFacts(lampInput(db, workspaceDir, who.taskId, where.definition))) : undefined;
    if (slot !== undefined) return { ...none, why: "missing_slot", slot_name: slot.name };
  } else {
    const blocked = blockedText(activity.requires, assetFacts(lampInput(db, workspaceDir, who.taskId, where.definition)));
    if (blocked !== null) return { ...none, why: "not_ready", blocked };
  }
  const { record_id, event_seq } = launchWorkItem(db, { ...who, to, flow, reason, scope });
  const inFlow = flow !== null;
  return { requested: to, from: where.from, moved: true, why: null, event_seq, how: inFlow ? "launch" : "alone", in_flow: inFlow, record_id };
}

/**
 * 想把这条会话的工作项移到流程的另一站（进入下一段、退回前面的阶段）：这条会话要正在做一个流程的工作项。
 * 换站只由用户决定；已经在那一站时不记。必须在调用方已经开好的写事务里调用。
 */
export function moveStage(db: DatabaseSync, workspaceDir: string, who: Who, to: Stage, reason: string): StageMoveOutcome {
  const where = whereIs(db, workspaceDir, who.taskId, who.sessionId);
  if (where === null) return { requested: to, from: null, moved: false, why: "no_stages", event_seq: null };
  const none = { requested: to, from: where.from, moved: false, event_seq: null };
  if (where.item === null || where.item.flow === null) return { ...none, why: "not_in_flow" };
  // 原地不动按活动标识符比：工作流里两步可以算作同一个阶段（逆向解析与核读都算作核读），从一步到另一步不是原地不动。
  if (where.item.activity === to) return { ...none, why: "same" };
  if (who.actor !== "user") return { ...none, why: "user_only" };
  const flowKey = where.item.flow;
  const steps = definitionsOrError(workspaceDir, where.definition).defs?.flows.find((one) => one.key === flowKey)?.steps ?? null;
  const event_seq = enterNode(db, where.item, to, who, reason, steps);
  return { requested: to, from: where.from, moved: true, why: null, event_seq, how: "move", in_flow: true, record_id: where.item.record_id };
}

/**
 * 这个任务的活动与流程的声明（lib/activity_def_read.ts：任务 skill 目录里的，没有就回退读产品自带的）。读不出来（文件不在、
 * 声明缺栏）时不抛错，返回原因：调用方据此不出活动目录、不让启动任何一项单项活动，别的照常。
 */
export function definitionsOrError(workspaceDir: string, definition: Pick<TaskDefinition, "skillPath">): { defs: Definitions; error: null } | { defs: null; error: string } {
  try {
    return { defs: definitionsFor(workspaceDir, definition.skillPath), error: null };
  } catch (error) {
    if (error instanceof DefinitionHeadError) return { defs: null, error: error.message };
    throw error;
  }
}

/** 库里第一个任务的活动与工作流的声明（见 definitionsOrError）；库里没有任务、声明读不出来时是 null。只读。 */
export function taskDefinitionsOf(db: DatabaseSync, workspaceDir: string): Definitions | null {
  const task = db.prepare("SELECT definition_text FROM task ORDER BY started_at LIMIT 1").get() as { definition_text: string } | undefined;
  return task ? definitionsOrError(workspaceDir, validateDefinition(JSON.parse(task.definition_text))).defs : null;
}

/** 活动的定义读不出来时，六项活动缺的前提都写这一句。 */
function allBlocked(reason: string): Record<Stage, string | null> {
  return Object.fromEntries(STAGES.map((one) => [one, `活动的定义读不出来：${reason}`])) as Record<Stage, string | null>;
}

/**
 * 算启动一项活动要的事实（lib/stage.ts 的 LaunchFacts）：这条会话现在的位置、有没有材料、六项活动各自缺什么前提。
 * 前提只看数据（需求资产六类的现状，lib/activity_catalog.ts）。assets 是已经数好的现状，不给时这里自己读库去数。只读。
 */
export function launchFacts(db: DatabaseSync, workspaceDir: string, taskId: string, definition: TaskDefinition, sessionId: string | null | undefined, assets?: AssetFacts): LaunchFacts {
  const open = openActivityRecord(db, taskId, sessionId);
  const facts = assets ?? assetFacts(lampInput(db, workspaceDir, taskId, definition));
  const found = definitionsOrError(workspaceDir, definition);
  return {
    position: open ? positionOf(workspaceDir, definition, open.activity) : IDLE, inFlow: open !== null && open.flow !== null, flowNode: null,
    flowItem: flowWorkItem(db, taskId, found.defs), hasMaterials: facts.materials > 0,
    blocked: found.defs ? blockedByStage(found.defs.activities, facts) : allBlocked(found.error),
  };
}

/**
 * 任务里已有的那个流程的工作项（一个任务至多一个）；没有是 null。早先的库里若有几个，取最早启动的那个。
 * 给了声明（defs）时名字取自声明（见 workItemName）。
 */
export function flowWorkItem(db: DatabaseSync, taskId: string, defs: Definitions | null = null): FlowItemRef | null {
  const item = activityRecords(db, taskId).find((one) => one.flow !== null);
  return item ? { record_id: item.record_id, name: workItemName(item, defs), node: item.activity } : null;
}

/** 工作项各有几个：单项活动的按活动数，流程的按流程的键数。 */
export function activeCounts(db: DatabaseSync, taskId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const one of activityRecords(db, taskId)) {
    const key = one.flow ?? one.activity;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** 用户在卡片上点了往前走的那一项时，那次换站记的理由：点的那一项的文字。 */
export function enterReason(option: string): string {
  return `用户在卡片上选了「${option}」`;
}
/**
 * 用户在卡片上点了往回退的那一项时，那次换站记的理由：点的是哪一项，后面接卡片的问句（助手在那里写为什么要退回）。
 * 问句是空的时只写点的是哪一项。
 */
export function backReason(option: string, question: string): string {
  const said = question.trim();
  return `用户在卡片上选了「${option}」${said ? `：${said}` : ""}`;
}

/**
 * 用户点了一张卡片上的选项：点的是助手提议的那张请选择卡片上转移的那一项（进入下一步 next_step、转到某一步 goto:<活动标识符>，
 * 早先的固定键照 lib/stage.ts 的 LEGACY_CARD_MOVES 换）时，替用户记一次换站。
 * 先在会话当前分支上找到点的那条回复，确认它确实是助手发的请选择、选项里有这个键。这条分支上找不到那条回复时（卡片是在同一个工作项的
 * 另一条会话里发的，用户从输入框上方的「待决定」一行点了），改为核对这条会话的工作项开着的提议（lib/stage_proposal.ts）：点的键是它生效的那一项、
 * 给了回复编号时又正是它那一条，才算。两样都认不出就不记（返回 null），点击照常往下走。
 * 转移是工作流里的事，按这条会话的工作项判：
 * - 这条会话正在做一个工作流的工作项：要去哪一步由程序推出来——进入下一步是工作流声明的 steps 里现在这一步的下一步，转到某一步就是那一步；
 *   要去的那一步要在这条工作流的各步里（why 为 not_next），它的活动声明的 requires 要满足（why 为 not_ready，blocked 写缺什么），然后换站。
 *   在现在这一步之前的算退回，理由里接卡片的问句。
 * - 别的情形（自由讨论的会话、归档的会话、单项活动的工作项）：都不算（why 为 not_in_flow）。
 * 任务没有阶段、工作项本来就在那一站时也不记，结果里写明原因。自己开事务，在卡片点击的处理函数里、
 * 发那句固定的话之前调用，这样助手回应这次点击的那一次运行从头就在新的阶段。
 */
export function recordStageCardClick(workspaceDir: string, sessionId: string, branch: readonly Entry[],
  click: { opId: string; replyEntry: unknown; optionKey: unknown }): StageMoveOutcome | null {
  const move = cardMove(click.optionKey);
  if (move === null || move.kind === "stay") return null;
  // 回复编号没有给、或者给的是空文字（开着的提议没有记下它在哪条回复上时，页面只能这样发）：都当作没有给。
  const replyEntry = typeof click.replyEntry === "string" && click.replyEntry !== "" ? click.replyEntry : null;
  const card = replyEntry !== null ? branch.find((entry) => entry.id === replyEntry) : undefined;
  // 那条回复在这条分支上：照它自己判，是别的东西（用户的话、别的卡片、卡片上没有这个键）就不认，不再去看开着的提议。
  const act = card ? chooseActOf(card) : null;
  const option = act?.options.find((one: { key?: unknown } | null) => one?.key === click.optionKey) as { key: string; text?: unknown } | undefined;
  if (card && (!act || !option)) return null;
  try {
    return withTaskDatabase(workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
        { task_id: string; definition_text: string } | undefined;
      if (!task) return null;
      let cardQuestion = typeof act?.text === "string" ? act.text : "";
      let optionText = typeof option?.text === "string" ? option.text : "";
      if (!card) {
        const open = openProposal(db, task.task_id, sessionId);
        if (open === null || open.kind === "review" || open.enter.key !== click.optionKey) return null;
        if (replyEntry !== null && replyEntry !== open.reply_entry) return null;
        cardQuestion = open.text;
        optionText = open.enter.text;
      }
      const definition = validateDefinition(JSON.parse(task.definition_text));
      const where = whereIs(db, workspaceDir, task.task_id, sessionId);
      const from = where?.from ?? null;
      const who: Who = { taskId: task.task_id, sessionId, runId: null, callId: click.opId, actor: "user" };
      const fromStage = from !== null && from !== IDLE ? from : null;
      const to = move.kind === "next" ? (fromStage && where?.item ? nextStepStage(workspaceDir, definition, where.item.flow, where.item.activity) : null) : move.to;
      const unmoved = (why: "not_next" | "not_in_flow" | "not_ready", blocked?: string) =>
        ({ requested: to ?? fromStage ?? "reading", from, moved: false, why, event_seq: null, ...(blocked ? { blocked } : {}) });
      // 这条会话不在做工作流的工作项：转移都不算数。任务没有阶段时照常交给 moveStage，它写明原因（no_stages）。
      if (where !== null && (where.item === null || where.item.flow === null)) return unmoved("not_in_flow");
      if (where === null && to !== null) return moveStage(db, workspaceDir, who, to, enterReason(optionText || gotoOption(to, null).text));
      if (to === null) return unmoved("not_next");
      // 早先的固定键自带方向：「退回某段」只认前面的阶段，「进入某段」只认后面的阶段，方向不对的不记（点的是一张早先的卡片）。
      if (move.kind === "goto" && move.back !== undefined && fromStage !== null) {
        const before = STAGES.indexOf(to) < STAGES.indexOf(fromStage);
        if (move.back && !before) return { ...unmoved("not_next"), why: "not_back" as const };
        if (!move.back && before) return unmoved("not_next");
      }
      // 要去的那一步要在这条工作流的各步里，它的 requires 要满足。
      const found = definitionsOrError(workspaceDir, definition);
      if (found.defs) {
        const flow = found.defs.flows.find((one) => one.key === (where?.item?.flow ?? FLOW_ANALYSIS));
        const target = found.defs.activities.find((one) => one.stage === to);
        if (!flow || !target || !flow.steps.includes(target.key)) return unmoved("not_next");
        const blocked = blockedText(target.requires, assetFacts(lampInput(db, workspaceDir, task.task_id, definition)));
        if (blocked !== null) return unmoved("not_ready", blocked);
      }
      const back = fromStage !== null && STAGES.indexOf(to) < STAGES.indexOf(fromStage);
      const text = optionText || (move.kind === "next" ? nextStepOption(to).text : gotoOption(to, from).text);
      return moveStage(db, workspaceDir, who, to, back ? backReason(text, cardQuestion) : enterReason(text));
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) return null;
    throw error;
  }
}

/**
 * 一条工作流里某一步的下一步算作哪个阶段：在工作流声明的各步（steps）里找 from（活动标识符）的位置，取它之后那一项活动的阶段；
 * from 不在各步里、这一步是最后一步、下一项活动只能由用户发起（发布）、或者声明读不出来时是 null。flow 为 null 时按需求分析。
 * 按各步的位置找而不按阶段找：一条工作流里两步可以算作同一个阶段（逆向解析与核读都算作核读）。
 */
export function nextStepStage(workspaceDir: string, definition: Pick<TaskDefinition, "skillPath">, flow: string | null, from: string): Stage | null {
  const found = definitionsOrError(workspaceDir, definition);
  if (!found.defs) return null;
  const steps = found.defs.flows.find((one) => one.key === (flow ?? FLOW_ANALYSIS))?.steps ?? [];
  const at = steps.indexOf(from);
  if (at < 0 || at + 1 >= steps.length) return null;
  return found.defs.activities.find((one) => one.key === steps[at + 1])?.stage ?? null;
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

/** 一条会话属于的工作项里给页面与助手看的几样。 */
export interface WorkItemBrief {
  record_id: number;
  /** flow 是流程的工作项，activity 是单项活动的工作项。 */
  kind: "flow" | "activity";
  /** 工作项的名字：流程的名字或者活动的名字。 */
  name: string;
  /** 现在做的是哪一项活动（任务类型声明里的活动标识符）。 */
  activity: string;
  /** 那项活动的名字（取自声明，见 activityNameOf）。 */
  activity_name: string;
  flow: string | null;
  scope: string | null;
  /** 启动的时刻（库里的本地时间写法）。 */
  started_at: string;
}

export function workItemBrief(item: ActivityRecord, defs: Definitions | null = null): WorkItemBrief {
  return { record_id: item.record_id, kind: item.flow !== null ? "flow" : "activity", name: workItemName(item, defs), activity: item.activity, activity_name: activityNameOf(defs, item.activity), flow: item.flow,
    scope: item.scope, started_at: item.started_at };
}

/**
 * 一条会话现在的阶段（或者空闲）、最近一次是谁在什么时候为什么启动或者换站的，以及六个阶段各自的几盏灯。谁、什么时候、为什么三项说的是
 * 这条会话正在做的工作项：流程的工作项换过站时是最近一次换站，没有换过、单项活动的是启动；会话空闲时都为 null。空闲没有自己的灯。
 */
export interface StageSummary {
  current: Position;
  /**
   * 这条会话正在做的工作项在流程里的哪一站：活动标识符（早先的记录与 current 同一个写法；逆向解析这类算作某个阶段的活动，current 是那个阶段）；
   * 单项活动的工作项、空闲时为 null。
   */
  node: string | null;
  /** 与 node 相同，留给还按「流程走到哪一站」读的页面。 */
  flow_node: string | null;
  /** 这条会话属于的工作项；自由讨论的会话、归档的会话为 null。 */
  work_item: WorkItemBrief | null;
  /** 早先任务状况卡上「开展一项活动」一节的内容（lib/stage.ts 的 LaunchView）；新的页面不用它。 */
  launch: LaunchView;
  /** 需求资产六类的现状（lib/activity_catalog.ts 的 AssetCell），照材料与证据、业务说明、分析模型、需求条目、评审与确认、文档与版本的次序。 */
  assets: AssetCell[];
  /** 给页面的活动目录：两条工作流程与七项单项活动，各带现在能不能启动。活动的定义读不出来时为 null，原因在 catalog_error。 */
  catalog: Catalog | null;
  catalog_error: string | null;
  moved_by: StageActor | null;
  /** 最近一次启动或者换站的时刻（库里的本地时间写法）。 */
  moved_at: string | null;
  reason: string | null;
  /** 用户启动这条会话的工作项时写的范围说明；没有写、会话空闲时为 null。 */
  scope: string | null;
  lamps: Record<Stage, Lamp[]>;
}

/** 任务里还在的图各自算灯要的几样（lib/stage.ts 的 LampDiagram）。只读。 */
export function lampDiagrams(db: DatabaseSync, taskId: string, definition: TaskDefinition): LampDiagram[] {
  const records = liveDiagrams(readDiagrams(db, taskId));
  const seen = viewedDiagramRevisions(db, taskId);
  if (records.length === 0) return [];
  const prefixes = definition.collections.map((one) => one.prefix);
  const cited = db.prepare(
    `SELECT locator FROM item_source WHERE task_id = ? AND item_id = ? AND revision_no = ? AND kind = ?${elementClause(ELEMENT_FIGURE)} ORDER BY position`,
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
        viewed: state.viewed.get(one.item_id) === true,
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

/**
 * 每份材料被引用的情况（核读材料那一盏报数用），按 materials 的次序。块数取材料的分段清单（lib/segments.ts 的 materialFacts）：
 * 一块里有一段（PDF 是页内的一块）被引用就算这一块有引用。分段清单读不到的 Word、PDF 材料不列，报数时退回只说有没有引用。
 */
function materialCoverage(db: DatabaseSync, workspaceDir: string, taskId: string, listed: string[], materials: readonly string[]): MaterialCoverage[] {
  const facts = new Map(materialFacts(db, taskId, workspaceDir, listed, envSegmentParams()).map((one) => [one.path, one]));
  return materials.flatMap((path) => {
    const one = facts.get(path);
    if (!one) return [];
    if (one.kind === "text") return [{ path, blocks: null, cited_blocks: null, citations: one.cited }];
    if (one.blocks.length === 0) return [];
    return [{ path, blocks: one.blocks.length, cited_blocks: one.blocks.filter((block) => block.items > 0).length, citations: 0 }];
  });
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
  const listed = listMaterials(workspaceDir, definition.materialsDir).files.map((one) => one.path);
  const materials = sourceMaterials(listed);
  // 按槽位数材料：材料表里还在的那一行记着槽位（lib/material_db.ts）；生成的文字版不在 materials 里，所以不算。
  const roles = materialRoles(db);
  const materialsBySlot: Record<string, number> = {};
  for (const path of materials) {
    const slot = roleOf(roles, path).slot;
    if (slot !== null) materialsBySlot[slot] = (materialsBySlot[slot] ?? 0) + 1;
  }
  return {
    ...facts,
    materials,
    materialsBySlot,
    coverage: materialCoverage(db, workspaceDir, taskId, listed, materials),
    review: {
      failing, any: db.prepare("SELECT 1 FROM review WHERE task_id = ? LIMIT 1").get(taskId) !== undefined,
      // 评审过几轮：一次评审（一个批次）结束时记一条摘要事件。
      rounds: Number((db.prepare("SELECT COUNT(*) AS n FROM event WHERE task_id = ? AND name = ?").get(taskId, EVENT_REVIEW_BATCH) as { n: number }).n),
    },
    completion: {
      satisfied: completion.every((one) => one.satisfied),
      unmet: completion.filter((one) => !one.satisfied).map((one) => `「${one.collection}」${one.condition}：${one.summary}`),
    },
    versions: versionCount(db, taskId),
  };
}

/**
 * 一个工作项最近一次换站是谁在什么时候为什么做的；没有换过站（或者是单项活动）时是它的启动。
 * 升级上来的流程的工作项，早先的每一次移动记的是另外两种事件（没有工作项的记录号）：这个工作项启动之后的那些也算它的换站，
 * 这样升级前后读出来的「最近一次」是同一次。
 */
export function lastMove(db: DatabaseSync, item: ActivityRecord): { actor: StageActor; at: string; reason: string } {
  const row = item.flow === null ? undefined : db.prepare(
    "SELECT actor, at, payload FROM event WHERE task_id = (SELECT task_id FROM activity_record WHERE record_id = ?) AND json_valid(payload) AND seq > ? AND (" +
      "(name = ? AND json_extract(payload, '$.record_id') = ?) OR " +
      "(name IN ('STAGE_MOVED', 'ACTIVITY_STARTED') AND json_extract(payload, '$.record_id') IS NULL AND (name = 'STAGE_MOVED' OR json_extract(payload, '$.node') IS NOT NULL))" +
      ") ORDER BY seq DESC LIMIT 1",
  ).get(item.record_id, item.started_seq, EVENT_NODE_ENTERED, item.record_id) as { actor: string; at: string; payload: string } | undefined;
  if (!row) return { actor: item.actor, at: item.started_at, reason: item.reason };
  const reason = (JSON.parse(row.payload) as { reason?: unknown }).reason;
  return { actor: row.actor === "executor" ? "executor" : "user", at: row.at, reason: typeof reason === "string" ? reason : "" };
}

/**
 * 一条会话现在的阶段与每个阶段的几盏灯。早先建的任务（没有「业务说明」集合）没有阶段，返回 null。只读：
 * 助手的查询任务状态与后端的整份数据都经这里，所以两侧说的是同一回事。sessionId 是哪条会话；不给（null）时按自由讨论的会话算。
 */
export function stageSummary(db: DatabaseSync, workspaceDir: string, taskId: string, definition: TaskDefinition, sessionId: string | null): StageSummary | null {
  if (!hasOverall(definition.collections)) return null;
  const open = sessionWorkItem(db, taskId, sessionId);
  const input = lampInput(db, workspaceDir, taskId, definition);
  const assets = assetFacts(input);
  const facts = launchFacts(db, workspaceDir, taskId, definition, sessionId, assets);
  const found = definitionsOrError(workspaceDir, definition);
  const node = open !== null && open.flow !== null ? open.activity : null;
  const moved = open ? lastMove(db, open) : null;
  return {
    current: facts.position,
    node,
    flow_node: node,
    work_item: open ? workItemBrief(open, found.defs) : null,
    launch: launchView(facts),
    assets: assetCells(assets, found.defs?.activities ?? [], assetNamesOf(definition)),
    catalog: found.defs ? catalog(found.defs, assetNamesOf(definition), assets, activeCounts(db, taskId), facts.flowItem) : null,
    catalog_error: found.error,
    moved_by: moved?.actor ?? null,
    moved_at: moved?.at ?? null,
    reason: moved ? moved.reason : null,
    scope: open?.scope ?? null,
    lamps: stageLamps(input),
  };
}

/**
 * 同上，但任务与它的定义由这里自己从库里取（库里的第一个任务）：给手里只有库连接与任务目录的调用方用（后端的整份数据）。
 * 库里还没有任务时返回 null。
 */
export function stageSummaryOf(db: DatabaseSync, workspaceDir: string, sessionId: string | null): StageSummary | null {
  const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; definition_text: string } | undefined;
  return task ? stageSummary(db, workspaceDir, task.task_id, validateDefinition(JSON.parse(task.definition_text)), sessionId) : null;
}

/** 自由讨论的会话（包括归档的会话）里给助手看的那一句。 */
export const IDLE_LINE = "本会话是自由讨论，不属于任何工作项：你可以立主题页、改主题页、记问题条目，不写需求条目，也不提议进入哪一项活动。启动哪一项活动由用户从任务起点页决定。";

/**
 * 给助手看的一段：这条会话的工作项是什么、现在在哪一站、最近一次是谁在什么时候为什么启动或者换站的，以及这一段还差什么（只说现在这个阶段的几盏灯）。
 * 助手查任务现状的那个工具在返回末尾用它。会话空闲时只有一句，不说灯：空闲没有自己的灯。
 */
export function stageLines(summary: StageSummary): string[] {
  if (summary.current === IDLE) return [IDLE_LINE];
  const name = STAGE_NAMES[summary.current];
  const reason = (summary.reason ?? "").replace(/[。.\s]+$/, "");
  const who = summary.moved_by === "executor" ? "助手" : "用户";
  const at = (summary.moved_at ?? "").slice(0, 16).replace("T", " ");
  if (summary.node === null) {
    // 单项活动的工作项：不在流程里，做够了由助手汇报做完（只是一句话，工作项照旧留着）。
    return [
      `本会话的工作项是单项活动「${name}」，不在工作流程里（${who}在 ${at} 启动的${reason ? `，理由：${reason}` : ""}）。` +
        "这项活动做够了就在回复里汇报做完（回复里写 activity_done: true），不提议进入别的活动。",
      ...lampLines(summary.current, summary.lamps[summary.current]),
    ];
  }
  const flow = summary.work_item?.name ?? FLOW_NAMES[FLOW_ANALYSIS];
  return [
    `本会话的工作项是工作流程「${flow}」，现在在${name}阶段（${who}在 ${at} 到这一站的${reason ? `，理由：${reason}` : ""}）。`,
    ...lampLines(summary.current, summary.lamps[summary.current]),
  ];
}
