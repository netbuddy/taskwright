/**
 * 工具拒绝的留痕：执行者的一次工具调用被工具拒绝时，往任务库的 tool_rejection 表记一行（表的说明见 schema.ts 的 TOOL_REJECTION_SQL）。
 *
 * 被拒的调用什么都没有写，拒绝文字原样交还模型；以前这件事只留在 pi 的会话文件与 Langfuse 里。这里在工具的登记处
 * 包一层（withRejectionRecord）：执行函数抛出拒绝时，另开一个事务记下这一行，再把原来的异常原样抛出，模型看到的文字不变。
 *
 * 只记「因输入不合规被拒」与「缺前置步骤被拒」两种（reason_kind 为 input 与 gate）。模型服务出错、库打不开、
 * 任务库不在本服务的任务目录之下，都不是输入的问题，不记（见 rejectionOf）。记录本身失败时只在标准错误上记一行，
 * 不影响拒绝文字交还模型。
 *
 * 拒绝文字分两层：事实（哪里不对，面向人）与指引（接下来该怎么做，只给助手）。抛出的异常带着 fact 与 guidance 两项时
 * 按两层分开存；只有一段文字的，整段存进事实层，指引层为空。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import type { DatabaseSync } from "node:sqlite";
import { wallClockText } from "./db.ts";
import { NoDatabaseYet, OutsideTasksRoot, withTaskDatabase } from "./schema.ts";

/** 被拒输入存进库里时最多留这么多个字符。 */
export const INPUT_EXCERPT_LIMIT = 2000;

/** 拒绝的两种原因：input 是输入不合规，gate 是缺了前置步骤（这一轮还没写理解）。 */
export type ReasonKind = "input" | "gate";

/** 一次拒绝分好的两层文字与原因种类。 */
export interface RejectionLayers {
  fact: string;
  guidance: string;
  reasonKind: ReasonKind;
}

/**
 * 带两层文字的拒绝。message 是交还模型的原文，一字不改；fact 与 guidance 是同一段话拆开的两层，只用于留痕。
 */
export class ToolRejection extends Error {
  fact: string;
  guidance: string;
  reasonKind: ReasonKind;
  constructor(message: string, fact: string, guidance: string, reasonKind: ReasonKind = "input") {
    super(message);
    this.fact = fact;
    this.guidance = guidance;
    this.reasonKind = reasonKind;
  }
}

/** 工具明知不是输入问题、不该记下的拒绝（例如评审时没有可用的模型、上一批评审还没做完）打上这个标记。 */
export const NOT_INPUT_PROBLEM = Symbol("not-input-problem");

/** 给一个异常打上 NOT_INPUT_PROBLEM 标记，原样返回它，写法是 throw notInputProblem(new ReviewError(...))。 */
export function notInputProblem<E extends Error>(error: E): E {
  (error as E & { [NOT_INPUT_PROBLEM]?: boolean })[NOT_INPUT_PROBLEM] = true;
  return error;
}

/**
 * 一个异常算不算要记下的拒绝：算就返回分好的两层文字，不算返回 null。
 * 不算的有：Node 与 SQLite 的系统错误（带 code 一项，例如库被锁住）、库还没有建、任务库不在本服务的任务目录之下、
 * 打了 NOT_INPUT_PROBLEM 标记的。其余的都是工具按事实核对之后给出的拒绝。
 */
export function rejectionOf(error: unknown): RejectionLayers | null {
  if (!(error instanceof Error)) return null;
  if ((error as { [NOT_INPUT_PROBLEM]?: boolean })[NOT_INPUT_PROBLEM]) return null;
  if (error instanceof NoDatabaseYet || error instanceof OutsideTasksRoot) return null;
  if (typeof (error as { code?: unknown }).code === "string") return null;
  const layered = error as Partial<RejectionLayers>;
  if (typeof layered.fact === "string") {
    return {
      fact: layered.fact,
      guidance: typeof layered.guidance === "string" ? layered.guidance : "",
      reasonKind: layered.reasonKind === "gate" ? "gate" : "input",
    };
  }
  return { fact: error.message, guidance: "", reasonKind: "input" };
}

/** 被拒的输入写成 JSON，只留前 2000 个字符。 */
export function inputExcerpt(params: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(params === undefined ? null : params) ?? "null";
  } catch {
    text = String(params);
  }
  return text.length > INPUT_EXCERPT_LIMIT ? text.slice(0, INPUT_EXCERPT_LIMIT) : text;
}

/** 由引出这次运行的那句用户的话的会话条目编号得到工作编号（与后端的工作编号同一写法）。 */
export function workIdOf(userEntryId: string | null | undefined): string | null {
  return userEntryId ? `w-${userEntryId}` : null;
}

/** 记一次拒绝要知道的：在哪个任务目录、哪条会话、哪次工作、哪次工具调用、哪个工具。 */
export interface RejectionCall {
  workspaceDir: string;
  sessionId: string;
  callId: string;
  toolName: string;
  workId?: string | null;
}

/** 往 tool_rejection 表写一行，返回它的编号。必须在调用方已经开好的事务里调用。 */
export function insertRejection(db: DatabaseSync, call: RejectionCall, layers: RejectionLayers, params: unknown): number {
  const task = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string } | undefined;
  const result = db.prepare(
    "INSERT INTO tool_rejection (task_id, session_id, work_id, call_id, tool_name, reason_kind, fact, guidance, input_excerpt, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    task?.task_id ?? null, call.sessionId, call.workId ?? null, call.callId, call.toolName, layers.reasonKind,
    layers.fact, layers.guidance === "" ? null : layers.guidance, inputExcerpt(params), wallClockText(),
  );
  return Number(result.lastInsertRowid);
}

/**
 * 记下一次拒绝：是要记的拒绝就另开一个事务写一行，返回它的编号；不是、或者任务目录里还没有库，返回 null。
 * 记录失败不抛异常，只在标准错误上记一行：拒绝文字照样要交还模型。
 */
export function recordRejection(call: RejectionCall, error: unknown, params: unknown): number | null {
  const layers = rejectionOf(error);
  if (!layers) return null;
  try {
    return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => insertRejection(db, call, layers, params));
  } catch (failure) {
    if (!(failure instanceof NoDatabaseYet)) {
      process.stderr.write(`提醒：${call.toolName} 的一次拒绝没能记进 tool_rejection 表：${(failure as Error).message}\n`);
    }
    return null;
  }
}

/**
 * 工具登记处用的外壳：执行 body，它抛出拒绝时先记下，再把原来的异常原样抛出。
 */
export async function withRejectionRecord<T>(call: RejectionCall, params: unknown, body: () => T | Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    recordRejection(call, error, params);
    throw error;
  }
}
