/**
 * 结构化输出的识别：执行者这一轮写在文字里的 JSON，发给它什么 schema，就按那个 schema 把它认出来。
 *
 * 做法：
 * 1. 登记。每一种期待执行者写出的结构化输出登记一项（StructuredOutput）：名称、schema 文件、事实核对（可选）、记录函数。
 *    发给执行者的格式说明与这里用来匹配的 schema 是同一个文件（平台 skill 里的说明由 scripts/render-intent-schema.mjs
 *    从它生成）。登记表本身在 lib/registered_outputs.ts；本模块不认识任何一种具体的输出，不写死任何键名。
 * 2. 扫描。一条助手消息的全部文字段都扫，取出能当作 JSON 的片段：```json 或不写语言的 ``` 围栏里的，以及裸写的
 *    JSON 对象（以 {" 开头、括号配平的一段）；一段文字里可以有几个片段。思考与工具调用不扫。
 * 3. 匹配。每个片段按登记表的顺序逐个用 schemaErrors 校验，完整通过哪一种就是哪一种输出；再跑那一种的事实核对，
 *    不过就按那一种的办法记为无效，过了就记下。同一种输出，一句用户的话只记第一份合格的。
 * 4. 诊断。哪种都不通过的片段（未匹配），与解析不了的片段（无法解析），记一条事件 STRUCTURED_OUTPUT_UNMATCHED，
 *    附对每一种登记输出的校验错误或解析错误。它们只是诊断，不算失败：执行者文字里的 JSON 不一定是写给系统的，
 *    例如漏进文字通道的工具参数。
 * 5. 失败只有一种：这一轮结束时，每句用户的话都必须有的那种输出（requiredEachTurn）仍没有合格的一份，
 *    由那一种自己记失败（见 recordTurnEnd，扩展在 pi 的 agent_settled 上调用）。
 *
 * 本模块不依赖 pi，也不打开任务库：库由调用方打开、交进来，单元测试可以直接调用。
 */

import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { ACTOR_EXECUTOR, emit, load } from "./db.ts";
import { schemaErrors } from "./intent_schema.ts";

/** 事件名：这条助手消息里有没匹配上任何一种登记输出的片段，或者解析不了的片段。只是诊断，不算失败。 */
export const EVENT_STRUCTURED_OUTPUT_UNMATCHED = "STRUCTURED_OUTPUT_UNMATCHED";

/** 诊断里每个片段存多少字。观测台显示前 200 字。 */
const FRAGMENT_KEEP = 400;

type Json = Record<string, any>;

/** 这一轮：由哪句用户的话引出，记在哪个任务、哪条会话。 */
export interface Turn {
  taskId: string;
  sessionId: string;
  runId: string;
  userEntryId: string;
}

/** 一种登记的结构化输出。 */
export interface StructuredOutput {
  /** 登记名，例如 user_intent；诊断里按它列出对这一种的校验错误。 */
  name: string;
  /** schema 文件，仓内相对路径，只用来写进诊断与提示。 */
  schemaFile: string;
  /** schema 本身（从 schemaFile 读进来的）。 */
  schema: Json;
  /** 这一轮已经记下这种输出了没有；记下了，这一轮再写的就不再记。 */
  alreadyRecorded(db: DatabaseSync, turn: Turn): boolean;
  /** schema 之后的事实核对，返回逐条的问题，没有问题返回空列表。可以不写。 */
  checkFacts?(db: DatabaseSync, turn: Turn, value: unknown): string[];
  /** 记下一份合格的输出，返回事件序号。 */
  record(db: DatabaseSync, turn: Turn, value: unknown): number;
  /** 事实核对不过时记一条无效记录，返回事件序号。 */
  recordInvalid(db: DatabaseSync, turn: Turn, written: string, errors: string[]): number;
  /** recordInvalid 记的事件名；它的内容里要有 user_entry、reason（问题，几条用「；」连起来）与 written（写的原文）。 */
  invalidEvent: string;
  /** 每句用户的话都必须有一份时写这一项：这一轮结束时仍没有，就由它记一条失败，返回事件序号。 */
  requiredEachTurn?: { recordMissing(db: DatabaseSync, turn: Turn, nearest: string[]): number };
}

/** 读一个 schema 文件。登记一种新的输出时用它读 schema，发给执行者的格式说明也应当从同一个文件生成。 */
export function readSchema(path: string): Json {
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ───────────── 从文字里取片段 ─────────────

/** 从文字里取出的一个片段：解析得了带 value，解析不了带 parseError。 */
export interface Fragment {
  text: string;
  fenced: boolean;
  value?: unknown;
  parseError?: string;
}

const OPEN_FENCE = /```[ \t]*([^\n`]*)\r?\n/g;

function parsed(text: string, fenced: boolean): Fragment {
  try {
    return { text, fenced, value: JSON.parse(text) };
  } catch (error) {
    return { text, fenced, parseError: `JSON 解析不了（${(error as Error).message}）` };
  }
}

/**
 * 从 start 处的 { 起，按括号配平找到这个对象的结尾（字符串里的括号不算），返回结尾之后的位置；没配平返回 -1。
 */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 围栏之外的文字里裸写的 JSON 对象：以 { 开头、后面紧跟（可以隔空白）一个双引号，配平到结尾；配不平取到这段文字末尾。 */
function bareFragments(text: string): Fragment[] {
  const out: Fragment[] = [];
  const start = /\{\s*"/g;
  let match: RegExpExecArray | null;
  while ((match = start.exec(text))) {
    const end = balancedEnd(text, match.index);
    const body = text.slice(match.index, end < 0 ? text.length : end);
    out.push(parsed(body.trim(), false));
    if (end < 0) break;
    start.lastIndex = end;
  }
  return out;
}

/**
 * 一段文字里的全部 JSON 片段，按出现的先后排。围栏只认写了 json 的与不写语言、内容以 { 或 [ 开头的，
 * 别的语言的围栏（例如 ```ts）整块跳过；没有收尾的围栏取到文字末尾。围栏之外的文字找裸写的 JSON 对象。
 */
export function extractFragments(text: string): Fragment[] {
  const out: Fragment[] = [];
  let from = 0;
  OPEN_FENCE.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = OPEN_FENCE.exec(text))) {
    out.push(...bareFragments(text.slice(from, open.index)));
    const bodyStart = open.index + open[0].length;
    const close = text.indexOf("```", bodyStart);
    const body = text.slice(bodyStart, close < 0 ? text.length : close).trim();
    const lang = open[1].trim().toLowerCase();
    if (lang === "json" || (lang === "" && /^[{[]/.test(body))) out.push(parsed(body, true));
    from = close < 0 ? text.length : close + 3;
    OPEN_FENCE.lastIndex = from;
  }
  out.push(...bareFragments(text.slice(from)));
  return out;
}

/** 一条消息的全部文字段（不为空的），按先后排。思考与工具调用不算。 */
export function textParts(content: unknown): string[] {
  if (typeof content === "string") return content.trim() === "" ? [] : [content];
  return (Array.isArray(content) ? content : [])
    .filter((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "")
    .map((part: any) => part.text);
}

// ───────────── 匹配与记录 ─────────────

/** 一个没有记下的片段的诊断。 */
export interface FragmentDiagnosis {
  /** unmatched：哪种登记输出都不通过；unparseable：解析不了；invalid：匹配上了某一种，但事实核对不过。 */
  nature: "unmatched" | "unparseable" | "invalid";
  text: string;
  /** unmatched：对每一种登记输出的校验错误。 */
  errors?: Record<string, string[]>;
  /** unmatched：错误最少的那一种（离得最近的）；invalid：匹配上的那一种。 */
  nearest?: string;
  /** unparseable：解析错误。 */
  parse_error?: string;
  /** invalid：事实核对的问题。 */
  fact_errors?: string[];
}

export interface ScanOutcome {
  recorded: { name: string; eventSeq: number }[];
  diagnoses: FragmentDiagnosis[];
  /** 诊断事件的序号；没有未匹配或无法解析的片段时为 null。 */
  unmatchedSeq: number | null;
}

const keep = (text: string) => [...text].slice(0, FRAGMENT_KEEP).join("");

/** 片段按登记表逐个校验：第一种完整通过的返回它；都不通过返回对每一种的错误与错误最少的那一种。 */
export function matchFragment(value: unknown, outputs: readonly StructuredOutput[]):
  { output: StructuredOutput } | { errors: Record<string, string[]>; nearest: string | undefined } {
  const errors: Record<string, string[]> = {};
  let nearest: string | undefined;
  for (const output of outputs) {
    const found = schemaErrors(value, output.schema, "", output.schema);
    if (found.length === 0) return { output };
    errors[output.name] = found;
    if (nearest === undefined || found.length < errors[nearest].length) nearest = output.name;
  }
  return { errors, nearest };
}

/**
 * 扫一条助手消息的全部文字段，按登记表匹配并记录；未匹配与无法解析的片段合记一条诊断事件。
 * 必须在任务库的事务里调用（调用方用 withTaskDatabase 打开库）。
 */
export function recordOutputs(db: DatabaseSync, turn: Turn, content: unknown, outputs: readonly StructuredOutput[]): ScanOutcome {
  const outcome: ScanOutcome = { recorded: [], diagnoses: [], unmatchedSeq: null };
  for (const text of textParts(content)) {
    for (const fragment of extractFragments(text)) {
      if (fragment.parseError !== undefined) {
        outcome.diagnoses.push({ nature: "unparseable", text: keep(fragment.text), parse_error: fragment.parseError });
        continue;
      }
      const matched = matchFragment(fragment.value, outputs);
      if (!("output" in matched)) {
        outcome.diagnoses.push({ nature: "unmatched", text: keep(fragment.text), errors: matched.errors, nearest: matched.nearest });
        continue;
      }
      const output = matched.output;
      if (output.alreadyRecorded(db, turn)) continue;
      const factErrors = output.checkFacts?.(db, turn, fragment.value) ?? [];
      if (factErrors.length > 0) {
        output.recordInvalid(db, turn, fragment.text, factErrors);
        outcome.diagnoses.push({ nature: "invalid", text: keep(fragment.text), nearest: output.name, fact_errors: factErrors });
        continue;
      }
      outcome.recorded.push({ name: output.name, eventSeq: output.record(db, turn, fragment.value) });
    }
  }
  const unmatched = outcome.diagnoses.filter((one) => one.nature !== "invalid");
  if (unmatched.length > 0) {
    outcome.unmatchedSeq = emit(db, {
      taskId: turn.taskId, sessionId: turn.sessionId, callId: `outputs-${turn.userEntryId}`, name: EVENT_STRUCTURED_OUTPUT_UNMATCHED,
      actor: ACTOR_EXECUTOR,
      payload: { run_id: turn.runId, user_entry: turn.userEntryId, registered: outputs.map((one) => one.name), fragments: unmatched },
    });
  }
  return outcome;
}

/**
 * 一个片段离某一种输出最近的问题，写成一句：解析不了写解析错误；未匹配写它对 name 这一种的校验错误；
 * 事实核对不过写核对的问题。与 name 无关的片段（例如只是漏进文字的工具参数）也照样列出它对 name 的校验错误。
 */
function nearestProblem(one: FragmentDiagnosis, name: string): string {
  if (one.nature === "unparseable") return one.parse_error ?? "JSON 解析不了";
  if (one.nature === "invalid") return (one.fact_errors ?? []).join("；");
  return (one.errors?.[name] ?? []).join("；");
}

/**
 * 这一轮（这句用户的话）在库里记下的片段诊断：诊断事件里的未匹配与无法解析的片段，加上各种输出的无效记录。按先后排。
 */
export function turnDiagnoses(db: DatabaseSync, sessionId: string, userEntryId: string, outputs: readonly StructuredOutput[]): FragmentDiagnosis[] {
  const invalidOf = new Map(outputs.map((one) => [one.invalidEvent, one.name]));
  const names = [EVENT_STRUCTURED_OUTPUT_UNMATCHED, ...invalidOf.keys()];
  const rows = db.prepare(`SELECT name, payload FROM event WHERE session_id = ? AND name IN (${names.map(() => "?").join(", ")}) ORDER BY seq`)
    .all(sessionId, ...names) as { name: string; payload: string }[];
  const out: FragmentDiagnosis[] = [];
  for (const row of rows) {
    const payload = load(row.payload) as { user_entry?: string; fragments?: FragmentDiagnosis[]; reason?: string; written?: string };
    if (payload.user_entry !== userEntryId) continue;
    if (row.name === EVENT_STRUCTURED_OUTPUT_UNMATCHED) out.push(...(payload.fragments ?? []));
    else out.push({ nature: "invalid", text: payload.written ?? "", nearest: invalidOf.get(row.name), fact_errors: payload.reason ? [payload.reason] : [] });
  }
  return out;
}

/** 本轮各片段离 name 这一种输出最近的问题，一个片段一句；别的输出的无效记录不算。 */
export function nearestProblems(diagnoses: FragmentDiagnosis[], name: string): string[] {
  return diagnoses.filter((one) => one.nature !== "invalid" || one.nearest === name).map((one) => nearestProblem(one, name)).filter(Boolean);
}

/**
 * 这一轮结束时调用：每句用户的话都必须有的那几种输出，这一轮仍没有合格的一份，就由那一种记一条失败，
 * 附本轮各片段离它最近的问题。返回记了失败的输出名。必须在任务库的事务里调用。
 */
export function recordTurnEnd(db: DatabaseSync, turn: Turn, outputs: readonly StructuredOutput[]): string[] {
  const missing: string[] = [];
  for (const output of outputs) {
    if (!output.requiredEachTurn || output.alreadyRecorded(db, turn)) continue;
    const nearest = nearestProblems(turnDiagnoses(db, turn.sessionId, turn.userEntryId, outputs), output.name);
    output.requiredEachTurn.recordMissing(db, turn, nearest);
    missing.push(output.name);
  }
  return missing;
}
