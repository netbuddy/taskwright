/**
 * 工作的阶段里读写任务库的那一半（不读库的在 lib/stage.ts）：任务现在在哪个阶段、记一次移动。
 *
 * 任务现在在哪个阶段看阶段记录表里事件序号最大的一行；一行都没有时按任务有没有材料定，这个缺省不落库，每次现算：
 * 任务建好还没有上传材料时是澄清，随后上传了材料而还没有任何移动，就是核读材料；有了第一条记录之后只看记录。
 * 早先建的任务（任务定义里没有「总体分析」集合）没有阶段：stageOf 返回 null，调用方据此什么都不做。
 *
 * 记移动的函数只管写，这次移动行不行由调用方先用 lib/stage.ts 的 judgeMove 判过。
 */

import type { DatabaseSync } from "node:sqlite";
import { emit, wallClockText } from "./db.ts";
import type { TaskDefinition } from "./definition.ts";
import { hasOverall } from "./overall_analysis.ts";
import { type Stage, type StageActor, defaultStage, isStage } from "./stage.ts";
import { listMaterials } from "./task_status.ts";

/** 记下一次移动的事件名。 */
export const EVENT_STAGE_MOVED = "STAGE_MOVED";

const TABLE = "stage_record";

/** 阶段记录表里的一行。 */
export interface StageRecord {
  stage: Stage;
  from_stage: Stage;
  actor: StageActor;
  reason: string;
  run_id: string | null;
  session_id: string;
  call_id: string;
  event_seq: number;
  created_at: string;
}

/** 库里有没有阶段记录表：只读的一侧会遇到还没有升级过的库。 */
export function hasStageTable(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE) !== undefined;
}

/** 最近一次移动；一次都没有移过（或者库还没有这张表）时是 null。 */
export function lastStageRecord(db: DatabaseSync, taskId: string): StageRecord | null {
  if (!hasStageTable(db)) return null;
  const row = db.prepare(
    `SELECT stage, from_stage, actor, reason, run_id, session_id, call_id, event_seq, created_at FROM ${TABLE} WHERE task_id = ? ORDER BY event_seq DESC LIMIT 1`,
  ).get(taskId) as StageRecord | undefined;
  return row && isStage(row.stage) ? { ...row, event_seq: Number(row.event_seq) } : null;
}

/** 全部移动，按先后排。 */
export function stageRecords(db: DatabaseSync, taskId: string): StageRecord[] {
  if (!hasStageTable(db)) return [];
  const rows = db.prepare(
    `SELECT stage, from_stage, actor, reason, run_id, session_id, call_id, event_seq, created_at FROM ${TABLE} WHERE task_id = ? ORDER BY event_seq`,
  ).all(taskId) as unknown as StageRecord[];
  return rows.map((row) => ({ ...row, event_seq: Number(row.event_seq) }));
}

/** 任务目录里有没有材料：材料目录第一层至少有一个文件（与任务现状消息列材料用的是同一个清单）。 */
export function taskHasMaterials(workspaceDir: string, materialsDir: string): boolean {
  return listMaterials(workspaceDir, materialsDir).files.length > 0;
}

/** 任务现在在哪个阶段：有记录看最近一条，没有记录按有没有材料定。不管任务有没有阶段，调用方先用 hasOverall 判。 */
export function currentStage(db: DatabaseSync, taskId: string, hasMaterials: boolean): Stage {
  return lastStageRecord(db, taskId)?.stage ?? defaultStage(hasMaterials);
}

/** 任务现在在哪个阶段；早先建的任务（没有「总体分析」集合）没有阶段，返回 null。 */
export function stageOf(db: DatabaseSync, workspaceDir: string, taskId: string, definition: Pick<TaskDefinition, "collections" | "materialsDir">): Stage | null {
  if (!hasOverall(definition.collections)) return null;
  return currentStage(db, taskId, taskHasMaterials(workspaceDir, definition.materialsDir));
}

/** 一次移动要记下的几样。 */
export interface StageMove {
  taskId: string;
  sessionId: string;
  /** 助手移动时的运行号；用户移动时为 null。 */
  runId: string | null;
  callId: string;
  actor: StageActor;
  from: Stage;
  to: Stage;
  reason: string;
}

/**
 * 记一次移动：先记一条事件 STAGE_MOVED，再往阶段记录表插一行，返回事件序号。
 * 必须在调用方已经开好的写事务里调用（withTaskDatabase），好让事件、这一行与同一次调用里别的写入一起提交。
 */
export function recordStageMove(db: DatabaseSync, move: StageMove): number {
  const seq = emit(db, {
    taskId: move.taskId, sessionId: move.sessionId, callId: move.callId, name: EVENT_STAGE_MOVED, actor: move.actor,
    payload: { stage: move.to, from: move.from, actor: move.actor, reason: move.reason, run_id: move.runId },
  });
  db.prepare(
    `INSERT INTO ${TABLE} (task_id, session_id, run_id, call_id, actor, stage, from_stage, reason, event_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(move.taskId, move.sessionId, move.runId, move.callId, move.actor, move.to, move.from, move.reason, seq, wallClockText());
  return seq;
}
