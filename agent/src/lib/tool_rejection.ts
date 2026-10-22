/**
 * 工具拒绝的留痕：执行者的一次工具调用被工具拒绝时，往任务库的 tool_rejection 表记一行（表的说明见 schema.ts 的 TOOL_REJECTION_SQL）。
 *
 * 被拒的调用什么都没有写，拒绝文字原样交还模型；以前这件事只留在 pi 的会话文件与 Langfuse 里。这里在工具的登记处
 * 包一层（withRejectionRecord）：执行函数抛出拒绝时，另开一个事务记下这一行，再把原来的异常原样抛出，模型看到的文字不变。
 *
 * 只记「因输入不合规被拒」与「缺前置步骤被拒」两种（reason_kind 为 input 与 gate，按原因码定，见 GATE_CODES）。模型服务出错、库打不开、
 * 任务库不在本服务的任务目录之下，都不是输入的问题，不记（见 rejectionOf）。记录本身失败时只在标准错误上记一行，
 * 不影响拒绝文字交还模型。
 *
 * 拒绝文字分两层：事实（哪里不对，面向人）与指引（接下来该怎么做，只给助手）。抛出的异常带着 fact 与 guidance 两项时
 * 按两层分开存；只有一段文字的，整段存进事实层，指引层为空。
 *
 * 每一次拒绝另带原因码（异常的 codes 一项）：原因码就是拒绝语模板的键的前两段（agent/prompts/runtime/ 下 rejections_*.md，
 * 例如 save_revision.collection_unknown），一次拒绝有几个原因时按出现的先后列几个。表里 reason_code 存第一个，reason_codes 存全部。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import type { DatabaseSync } from "node:sqlite";
import { wallClockText } from "./db.ts";
import { NoDatabaseYet, OutsideTasksRoot, withTaskDatabase } from "./schema.ts";

/** 被拒输入存进库里时最多留这么多个字符。 */
export const INPUT_EXCERPT_LIMIT = 2000;

/** 拒绝的两种原因：input 是输入不合规，gate 是缺了前置步骤（还没写理解、阶段不对、用户还没同意等）。 */
export type ReasonKind = "input" | "gate";

/**
 * 守门类的原因码：缺了前置步骤，不是输入写错了。共用的守门（gate.*）十五种，加上发布版本的完成条件与用户同意四种。
 */
export const GATE_CODES: ReadonlySet<string> = new Set([
  "gate.understanding_missing", "gate.understanding_invalid", "gate.stage_item_write", "gate.stage_page_write", "gate.activity_page_write", "gate.stage_diagram", "gate.stage_review",
  "gate.stage_publish", "gate.overall_no_viewed_topic", "gate.problem_new_status_direct", "gate.problem_consent_missing", "gate.problem_consent_wrong_option",
  "gate.problem_consent_stale", "gate.problem_consent_batch_conflict", "gate.activity_done_not_single_activity",
  "publish_version.completion_unmet", "publish_version.consent_none", "publish_version.consent_declined", "publish_version.consent_stale",
]);

/** 一次拒绝算哪一种：第一个原因码是守门类的就是 gate，别的（包括没有原因码的）是 input。 */
export function reasonKindOf(codes: readonly string[]): ReasonKind {
  return codes.length > 0 && GATE_CODES.has(codes[0]) ? "gate" : "input";
}

/** 一次拒绝分好的两层文字、原因码与原因种类。 */
export interface RejectionLayers {
  fact: string;
  guidance: string;
  codes: string[];
  reasonKind: ReasonKind;
}

/**
 * 带两层文字与原因码的拒绝。message 是交还模型的原文，一字不改；fact 与 guidance 是同一段话拆开的两层，只用于留痕；
 * codes 是这次拒绝的原因码，按出现的先后。
 */
export class ToolRejection extends Error {
  fact: string;
  guidance: string;
  codes: string[];
  constructor(message: string, fact: string, guidance: string, codes: readonly string[] = []) {
    super(message);
    this.fact = fact;
    this.guidance = guidance;
    this.codes = [...codes];
  }
  get reasonKind(): ReasonKind {
    return reasonKindOf(this.codes);
  }
}

/** 给不是 ToolRejection 的拒绝（例如评审的 ReviewError）记上原因码，原样返回它。 */
export function withCodes<E extends Error>(error: E, codes: readonly string[]): E {
  (error as E & { codes?: string[] }).codes = [...codes];
  return error;
}

/** 异常带着的原因码；没有带时是空的。 */
export function codesOf(error: unknown): string[] {
  const codes = (error as { codes?: unknown } | null)?.codes;
  return Array.isArray(codes) && codes.every((one) => typeof one === "string") ? [...codes] : [];
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
  const codes = codesOf(error);
  const layered = error as { fact?: unknown; guidance?: unknown };
  if (typeof layered.fact === "string") {
    return { fact: layered.fact, guidance: typeof layered.guidance === "string" ? layered.guidance : "", codes, reasonKind: reasonKindOf(codes) };
  }
  return { fact: error.message, guidance: "", codes, reasonKind: reasonKindOf(codes) };
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
    "INSERT INTO tool_rejection (task_id, session_id, work_id, call_id, tool_name, reason_kind, fact, guidance, input_excerpt, created_at, reason_code, reason_codes) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    task?.task_id ?? null, call.sessionId, call.workId ?? null, call.callId, call.toolName, layers.reasonKind,
    layers.fact, layers.guidance === "" ? null : layers.guidance, inputExcerpt(params), wallClockText(),
    layers.codes[0] ?? null, layers.codes.length ? JSON.stringify(layers.codes) : null,
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
