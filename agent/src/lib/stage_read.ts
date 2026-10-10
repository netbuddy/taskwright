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
import { type Entry, chooseActOf } from "./completion_consent.ts";
import { checkCompletion } from "./conditions.ts";
import { emit, wallClockText } from "./db.ts";
import { type TaskDefinition, keepPendingField, validateDefinition } from "./definition.ts";
import { OVERALL_COLLECTION, hasOverall } from "./overall_analysis.ts";
import { overallState } from "./overall_read.ts";
import { currentRulesHash, verdictAt } from "./review_state.ts";
import { NoDatabaseYet, SOURCE_DOCUMENT, SOURCE_ITEM, TASK_ACTIVE, withTaskDatabase } from "./schema.ts";
import {
  type Lamp, type LampInput, NO_STAGES_TEXT, START_ITEMS_KEY, START_ITEMS_TEXT, type Stage, type StageActor, defaultStage, isStage, judgeMove, lampPage,
  lampQuestion, moveText, stageLamps,
} from "./stage.ts";
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

/**
 * 一次移动的结果。moved 为真是记下了；为假时 why 写原因：same 原地不动，user_only 进入写条目要由用户决定，
 * skip 助手往后跳着移，no_stages 这个任务没有阶段（早先建的任务）。from 是移动之前所在的阶段，任务没有阶段时为 null。
 */
export interface StageMoveOutcome {
  requested: Stage;
  from: Stage | null;
  moved: boolean;
  why: "same" | "user_only" | "skip" | "no_stages" | null;
  event_seq: number | null;
}

/**
 * 想把任务移到某个阶段：先看任务有没有阶段、这次移动行不行（lib/stage.ts 的 judgeMove），行就记下。不行不抛错，原因写在结果里，
 * 由调用方决定怎样告诉助手或用户。必须在调用方已经开好的写事务里调用。
 */
export function moveStage(db: DatabaseSync, workspaceDir: string, who: Omit<StageMove, "from" | "to" | "reason">, to: Stage, reason: string): StageMoveOutcome {
  const task = db.prepare("SELECT definition_text FROM task WHERE task_id = ?").get(who.taskId) as { definition_text: string } | undefined;
  const from = task ? stageOf(db, workspaceDir, who.taskId, validateDefinition(JSON.parse(task.definition_text))) : null;
  if (from === null) return { requested: to, from: null, moved: false, why: "no_stages", event_seq: null };
  const verdict = judgeMove(from, to, who.actor);
  if (!verdict.ok) return { requested: to, from, moved: false, why: verdict.why, event_seq: null };
  return { requested: to, from, moved: true, why: null, event_seq: recordStageMove(db, { ...who, from, to, reason }) };
}

/**
 * 助手在回复里写了 stage：判并记这次移动，交回给「回复」工具的三样（lib/dialogue_acts.ts 的 ReplyExtra）——
 * 接在「回复已送达。」后面的一句说明；移不成时留在回复那条事件里的 stage_declined（想移到哪里、为什么没移）；这次移动的结果。
 * 回复照常送达，移不成不算被拒。
 */
export function replyStageMove(db: DatabaseSync, workspaceDir: string, who: { taskId: string; sessionId: string; runId: string; callId: string },
  to: Stage, reason: string): { text: string; payload?: Record<string, unknown>; value: StageMoveOutcome } {
  const outcome = moveStage(db, workspaceDir, { ...who, actor: "executor" }, to, reason);
  if (outcome.from === null) return { text: NO_STAGES_TEXT, payload: { stage_declined: { stage: to, why: "no_stages" } }, value: outcome };
  const verdict = outcome.moved ? { ok: true as const } : { ok: false as const, why: outcome.why as "same" | "user_only" | "skip" };
  const text = moveText(outcome.from, to, verdict);
  return outcome.moved ? { text, value: outcome } : { text, payload: { stage_declined: { stage: to, from: outcome.from, why: outcome.why } }, value: outcome };
}

/** 用户在卡片上点了「开始写条目」时，那条阶段记录里写的理由。 */
export const START_ITEMS_REASON = `用户在卡片上选了「${START_ITEMS_TEXT}」`;

/**
 * 用户点了一张卡片上的选项：点的是助手提议进入写条目的那张请选择卡片上的「开始写条目」时，替用户记一次移到写条目。
 * 先在会话当前分支上找到点的那条回复，确认它确实是助手发的请选择、选项里有这个键；认不出就不记（返回 null），点击照常往下走。
 * 任务没有阶段、任务不在进行中、任务本来就在写条目时也不记，结果里写明原因。自己开事务，在卡片点击的处理函数里、发那句固定的话之前调用，
 * 这样助手回应这次点击的那一次运行从头就在写条目阶段。
 */
export function recordStartItemsClick(workspaceDir: string, sessionId: string, branch: readonly Entry[],
  click: { opId: string; replyEntry: unknown; optionKey: unknown }): StageMoveOutcome | null {
  if (click.optionKey !== START_ITEMS_KEY || typeof click.replyEntry !== "string") return null;
  const card = branch.find((entry) => entry.id === click.replyEntry);
  const act = card ? chooseActOf(card) : null;
  if (!act || !act.options.some((option: { key?: unknown } | null) => option?.key === START_ITEMS_KEY)) return null;
  try {
    return withTaskDatabase(workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id, status FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; status: string } | undefined;
      if (!task || task.status !== TASK_ACTIVE) return null;
      return moveStage(db, workspaceDir, { taskId: task.task_id, sessionId, runId: null, callId: click.opId, actor: "user" }, "writing", START_ITEMS_REASON);
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

/** 任务现在的阶段、最近一次是谁在什么时候为什么移的（一次都没有移过时三项为 null），以及五个阶段各自的几盏灯。 */
export interface StageSummary {
  current: Stage;
  moved_by: StageActor | null;
  /** 最近一次移动的时刻（库里的本地时间写法）。 */
  moved_at: string | null;
  reason: string | null;
  lamps: Record<Stage, Lamp[]>;
}

/** 从任务库里读出算灯要的全部事实（lib/stage.ts 的 LampInput）。只读。 */
export function lampInput(db: DatabaseSync, workspaceDir: string, taskId: string, definition: TaskDefinition): LampInput {
  const state = overallState(db, taskId, definition);
  const statusFieldOf = new Map(definition.collections.flatMap((one) => {
    const field = keepPendingField(one);
    return field ? [[one.name, field.name] as [string, string]] : [];
  }));
  const sourcesOf = (itemId: string) => state.sources.get(itemId) ?? [];
  const pages = state.items.filter((one) => one.collection === OVERALL_COLLECTION);
  const others = state.items.filter((one) => one.collection !== OVERALL_COLLECTION);
  const questions = others.filter((one) => statusFieldOf.has(one.collection));
  const reviewed = new Set(Object.entries(definition.completion).filter(([, names]) => names.includes(REVIEWED_CONDITION)).map(([name]) => name));
  const hashOf = new Map<string, string | null>();
  const failing = others.filter((one) => {
    if (!reviewed.has(one.collection)) return false;
    if (!hashOf.has(one.collection)) hashOf.set(one.collection, currentRulesHash(db, workspaceDir, one.collection));
    return verdictAt(db, taskId, one.item_id, one.revision_no, hashOf.get(one.collection)!).state === "failed";
  }).map((one) => one.item_id);
  const completion = checkCompletion(db, taskId, definition.completion, { workspaceDir });
  return {
    pages: pages.map((one) => lampPage(one.item_id, one.fields, state.viewed.get(one.item_id) === true)),
    items: others.map((one) => {
      const verification = state.verification.get(one.item_id)!;
      return {
        item_id: one.item_id, collection: one.collection,
        cites: sourcesOf(one.item_id).filter((s) => s.kind === SOURCE_ITEM).map((s) => s.locator),
        pending: verification.pending_verification || verification.basis_pending !== null,
      };
    }),
    questions: questions.map((one) => lampQuestion(one.item_id, one.fields, statusFieldOf.get(one.collection)!)),
    collections: definition.collections.map((one) => one.name),
    materials: sourceMaterials(listMaterials(workspaceDir, definition.materialsDir).files.map((one) => one.path)),
    citedDocuments: [...pages, ...questions].flatMap((one) => sourcesOf(one.item_id).filter((s) => s.kind === SOURCE_DOCUMENT).map((s) => s.locator)),
    mentions: state.mentions,
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
  const last = lastStageRecord(db, taskId);
  return {
    current: last?.stage ?? defaultStage(taskHasMaterials(workspaceDir, definition.materialsDir)),
    moved_by: last?.actor ?? null,
    moved_at: last?.created_at ?? null,
    reason: last ? last.reason : null,
    lamps: stageLamps(lampInput(db, workspaceDir, taskId, definition)),
  };
}
