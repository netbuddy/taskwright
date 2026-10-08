/**
 * 只读地读一个任务的库，拼成接口要的形状。本模块不写库，也不做判断。
 *
 * 读法的纪律：读事务只包住查询语句（显式 BEGIN 与 COMMIT，一次取完），拼内容、算完成条件都在 COMMIT 之后做，
 * 不留长读事务（长开的读事务会让 -wal 文件一直变大）。
 * 完成条件在同一进程里调用 agent 的 conditions.ts（与「完成任务」门禁同一组函数），算不出来时给 null。
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkCompletion, completionBrief, completionHints } from "../../agent/src/lib/conditions.ts";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { type DiagramRecord, drawnItemIds, kindName, latestVersion, liveDiagrams, readDiagrams } from "../../agent/src/lib/diagram.ts";
import { LOCATIONS_SUFFIX, isLocationTable } from "../../agent/src/lib/docx_locations.ts";
import { pdfFacts, pdfSourceName } from "./projection.ts";
import { reviewVerdict } from "../../agent/src/lib/review_verdict.ts";
import {
  DEFAULT_MATERIALS_DIR, type ParsedDefinition, type Row, type SourceRow,
  columnNames, itemKey, jsonOrText, openReadonly, parseDefinition, readSources, tableNames,
} from "../../agent/src/lib/task_read.ts";
import * as clock from "./clock.ts";
import { ApiError } from "./errors.ts";
import { readTextFile } from "./files.ts";
import { functionNames } from "./work_summary.ts";
import { isObject, or, truthy } from "./py.ts";

export const ACTOR_USER = "user";

export function dbFile(taskDir: string): string {
  return join(taskDir, DB_NAME);
}

/** 只读打开任务目录的库；库文件不存在或是空文件时为 null。 */
export function openRo(taskDir: string): DatabaseSync | null {
  const path = dbFile(taskDir);
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return null;
  } catch {
    return null;
  }
  return openReadonly(path);
}

/** 库里的发起方写法换成接口的写法：最早格式里的「模型」算执行者。 */
export function actorWord(actor: unknown): string {
  return actor === ACTOR_USER ? ACTOR_USER : "executor";
}

/** 值写成文字，与 Python 的 str() 对字符串与数字的写法相同。 */
function str(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** 条目的标题：集合声明的第一个字段在这一版里的值。 */
export function titleOf(fields: Record<string, any> | null | undefined, collection: ParsedDefinition["集合"][number] | null | undefined): string {
  if (!truthy(fields) || !collection || !truthy(collection["字段"])) return "";
  const value = fields![collection["字段"][0]["名"]];
  // 列表里的空项跳过：保存修订与界面修改都不让写进空项，这里是库数据异常时的兜底。
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined && v !== "").map(str).join("、");
  return str(or(value, ""));
}

export const REVIEW_CONDITION = "每个条目评审通过";
export const RULE_REQUIRED = "必选";

/** 任务定义原文里各集合的「评审规矩」：集合名 → {"规则文件", "关闭", "升为必选"}。没写的集合不在里面。 */
export function reviewSpecs(definitionText: unknown): Record<string, Record<string, any>> {
  const raw = definitionText ? jsonOrText(definitionText) : null;
  const deliverable = isObject(raw) && isObject(raw["交付物"]) ? raw["交付物"] : {};
  const out: Record<string, Record<string, any>> = {};
  for (const entry of or(deliverable["条目集合"], []) as any[]) {
    const spec = isObject(entry) ? entry["评审规矩"] : null;
    if (isObject(spec) && typeof spec["规则文件"] === "string") out["名称" in entry ? entry["名称"] : ""] = spec;
  }
  return out;
}

function readRules(taskDir: string, spec: Record<string, any>): { ok: true; rules: any } | { ok: false } {
  try {
    return { ok: true, rules: JSON.parse(readTextFile(join(taskDir, spec["规则文件"]))) };
  } catch {
    return { ok: false };
  }
}

/** 一个集合实际要评的规则：去掉关闭的，把升为必选的改成必选。没写评审规矩或规则文件读不出来时为 null。 */
export function effectiveRules(taskDir: string | null, spec: Record<string, any> | undefined): any[] | null {
  if (!spec || taskDir === null) return null;
  const got = readRules(taskDir, spec);
  if (!got.ok || !Array.isArray(got.rules)) return null;
  const off = new Set(or(spec["关闭"], []) as unknown[]);
  const promote = new Set(or(spec["升为必选"], []) as unknown[]);
  return got.rules.filter((r: unknown) => isObject(r) && !off.has(r["编号"] ?? null)).map((r: any) => ({
    id: r["编号"] ?? null, level: promote.has(r["编号"] ?? null) ? RULE_REQUIRED : (r["级别"] ?? null), text: r["条文"] ?? null,
    counter_example: r["反例"] ?? null, example: r["正例"] ?? null,
  }));
}

/** 规则指纹：与 agent/src/lib/review_state.ts 的 rulesHashText 同一个算法。 */
export function rulesHashText(fileText: string, off: unknown[], promote: unknown[]): string {
  const text = `${fileText}\n--\n关闭:${off.join(",")}\n升为必选:${promote.join(",")}`;
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
}

/**
 * 一个集合现在的规则指纹；没写评审规矩、没给任务目录或规则文件读不到时为 null。
 * 规则文件按原始内容读（不统一行尾），与 agent 侧 review_state.ts 读法相同，评审者与后端算出的指纹才一致。
 */
export function rulesHash(taskDir: string | null, spec: Record<string, any> | undefined): string | null {
  if (!spec || taskDir === null) return null;
  let text: string;
  try {
    text = readFileSync(join(taskDir, spec["规则文件"]), "utf-8");
  } catch {
    return null;
  }
  return rulesHashText(text, [...(or(spec["关闭"], []) as unknown[])], [...(or(spec["升为必选"], []) as unknown[])]);
}

/** 规则文件里的全部规则，连同这个任务的开关状态 state：required、optional、off、promoted。给评审页签的规则区用。 */
export function allRules(taskDir: string | null, spec: Record<string, any> | undefined): any[] | null {
  if (!spec || taskDir === null) return null;
  const got = readRules(taskDir, spec);
  if (!got.ok) return null;
  const off = new Set(or(spec["关闭"], []) as unknown[]);
  const promote = new Set(or(spec["升为必选"], []) as unknown[]);
  const out = [];
  for (const r of Array.isArray(got.rules) ? got.rules : []) {
    if (!isObject(r)) continue;
    const rid = r["编号"] ?? null;
    const state = r["级别"] === RULE_REQUIRED ? "required" : off.has(rid) ? "off" : promote.has(rid) ? "promoted" : "optional";
    out.push({ id: rid, level: r["级别"] ?? null, text: r["条文"] ?? null, counter_example: r["反例"] ?? null, example: r["正例"] ?? null, state });
  }
  return out;
}

/** 一个集合的评审部分：要不要评审、生效的规则清单、全部规则与开关、规则指纹。 */
export function collectionReviewView(definition: ParsedDefinition, name: string, definitionText: unknown, taskDir: string | null) {
  const spec = reviewSpecs(definitionText)[name];
  const conditions = (definition["完成条件"] || {})[name] ?? [];
  return {
    needs_review: Array.isArray(conditions) || typeof conditions === "string" ? conditions.includes(REVIEW_CONDITION) : false,
    review_rules: effectiveRules(taskDir, spec),
    all_rules: allRules(taskDir, spec),
    rule_switches: spec ? { off: [...(or(spec["关闭"], []) as unknown[])], promote: [...(or(spec["升为必选"], []) as unknown[])] } : null,
    rules_hash: rulesHash(taskDir, spec),
  };
}

/** 集合的「界面」一项换成接口的写法：side_tab、group_field、leading_groups、note。没写时为 null。 */
export function displayView(raw: Record<string, any> | null | undefined) {
  if (!truthy(raw)) return null;
  return {
    side_tab: raw!["右侧栏页签"] === true, group_field: or(raw!["分组字段"], null),
    leading_groups: (or(raw!["靠前的组"], []) as unknown[]).map(str), note: or(raw!["说明"], null),
  };
}

/** 任务定义里前端要的那部分：集合名、前缀、字段、显示方式，以及每个集合的评审部分。 */
export function definitionView(definition: ParsedDefinition, definitionText: unknown = null, taskDir: string | null = null) {
  return {
    collections: definition["集合"].map((c) => ({
      name: c["名称"], prefix: c["编号前缀"],
      fields: c["字段"].map((f) => ({ name: f["名"], type: f["类型"], required: Boolean(f["必填"]), values: f["取值"] ?? null })),
      display: displayView(c["界面"]),
      ...collectionReviewView(definition, c["名称"], definitionText, taskDir),
    })),
  };
}

/** 一次评审（批次）：第几次、批次编号、时刻、谁发起、范围与计数。row 是 REVIEW_BATCH 事件那一行。 */
export function batchView(no: number, row: Row) {
  const p = or(jsonOrText(row.payload), {}) as Record<string, any>;
  const out: Record<string, any> = {
    no, batch_id: or(p.batch_id, row.call_id), at: clock.fromLocalText(row.at),
    started_by: or(p.started_by, actorWord(row.actor)), scope: p.scope ?? null,
    items: or(p.items, []), forced: or(p.forced, []),
  };
  for (const k of ["total", "passed", "failed", "unfinished", "problems", "advice"]) out[k] = k in p ? p[k] : 0;
  return out;
}

/** 依据方是任务里的要素的两种来源：另一个条目，或者一张图（图这种要素还没有做出来）。 */
const SOURCE_ITEM = "条目";
const SOURCE_FIGURE = "图";
/** 产出方是哪种要素：条目，或者图。 */
const ELEMENT_ITEM = "条目";
const ELEMENT_FIGURE = "图";

/** 接口里的一条来源。后三项只在种类是「条目」或「图」时有（见 Library.sourcesOf）。 */
export interface SourceView {
  kind: string;
  locator: string;
  excerpt: string;
  supports: { field: string; index: number | null }[];
  /** 引用那一刻对方的修订号；库里没有记下时为 null。 */
  depends_revision?: number | null;
  /** 对方现在的修订号；对方已经删除（或者找不到）时为 null。 */
  current_revision?: number | null;
  /** 依据的现状："changed" 是对方在引用之后改过，"deleted" 是对方已经删除，null 是没有变。 */
  stale?: "changed" | "deleted" | null;
}

export function sourceView(one: SourceRow): SourceView {
  return {
    kind: one["种类"], locator: one["出处"], excerpt: one["摘录"],
    supports: (one["支持"] || []).map((s) => ({ field: s["字段"], index: s["第几项"] })),
    ...(one["依据的修订"] !== undefined ? { depends_revision: one["依据的修订"] } : {}),
  };
}

// ───────────────────────── 完成条件 ─────────────────────────

/**
 * 按任务定义的完成条件逐项核对，给接口的 completion 形状；算不出来时返回 null。totals 是每个集合现有的条目数。
 * 核对在同一进程里调用 agent 的 checkCompletion，库另开一个只读连接，与门禁用的是同一组函数。
 */
export function completion(taskDir: string, taskId: string, definition: ParsedDefinition, totals: Record<string, number>) {
  let out: any;
  try {
    const dbPath = dbFile(taskDir);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const conditionsDef = definition["完成条件"];
      const results = checkCompletion(db, taskId, conditionsDef as any, { workspaceDir: dirname(resolve(dbPath)) });
      // 结果按 JSON 走一遍，与「经命令行拿到的结果」同一个样子（没有值的键不出现）。
      out = JSON.parse(JSON.stringify({ results, brief: completionBrief(results), hints: completionHints(db, taskId, conditionsDef as any) }));
    } finally {
      db.close();
    }
  } catch {
    out = null;
  }
  const results = isObject(out) ? out.results : null;
  if (!Array.isArray(results)) return null;
  const conditions = results.map((r: any) => {
    const total = totals[r.collection] ?? 0;
    const missing = (or(r.unmet, []) as any[]).filter((u) => truthy(u.item)).map((u) => u.item);
    // met 是门禁意义上的满足（暂无条目也算）；state 给报告用：met、unmet、empty（集合为空，这一条无从谈起）
    return {
      collection: r.collection, name: r.condition, met: Boolean(r.satisfied),
      state: or(r.state, r.satisfied ? "met" : "unmet"),
      done: total - missing.length, total, missing, note: "summary" in r ? r.summary : "",
    };
  });
  // hints：完成条件之外的提示，不是门禁，每项 {kind, collection, items, summary}。
  const hints = (or(out.hints, []) as unknown[]).filter(isObject);
  return {
    all_met: conditions.every((c: any) => c.met), unmet_count: conditions.filter((c: any) => c.state === "unmet").length,
    brief: "brief" in out ? out.brief : "", conditions, hints,
  };
}

/**
 * 每条会话产生了几次修订：修订表按会话编号计数，返回「会话编号 → 次数」。库另开一个只读连接；还没有库、或者读不出来时为空表。
 */
export function revisionCountsBySession(taskDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  try {
    const db = new DatabaseSync(dbFile(taskDir), { readOnly: true });
    try {
      for (const row of db.prepare("SELECT session_id, COUNT(*) AS n FROM revision GROUP BY session_id").all() as Row[]) {
        counts.set(String(row.session_id), Number(row.n));
      }
    } finally {
      db.close();
    }
  } catch {
    counts.clear();
  }
  return counts;
}

// ───────────────────────── 读库（都在显式开好的读事务里） ─────────────────────────

/** 在一个读事务里取一次库的全部所需，取完就提交；之后的拼装只用内存里的这些行。 */
export function inReadTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN");
  try {
    return body();
  } finally {
    db.exec("COMMIT");
  }
}

/** 修订统一之前建的库：条目内容表还有 version_no 列。本版本不支持这种库，库表改动不做迁移。 */
export function isPreRevision(db: DatabaseSync): boolean {
  return columnNames(db, "item_version").has("version_no");
}

export const OLD_FORMAT_TEXT = "这个任务是旧格式（修订统一之前建的，条目还按内容版本号记），本版本不支持。请新建一个任务。";

const all = (db: DatabaseSync, sql: string, ...params: any[]) => (db.prepare(sql).all(...params) as Row[]).map((r) => ({ ...r }));

export interface LibraryData {
  task: Row | null;
  seq: number;
  events?: Row[];
  items?: Row[];
  contents?: Row[];
  revisions?: number[];
  sources?: Map<string, SourceRow[]>;
  /** 任务里的全部图（删掉的也在）与图的来源（键是图的编号加图自己的修订号）。还没有图的表的旧库里是空的。 */
  diagrams?: DiagramRecord[];
  diagram_sources?: Map<string, SourceRow[]>;
  event_meta?: Map<number, { actor: any; at: any; call_id: any }>;
  reviews?: Row[];
  findings?: Map<number, any[]>;
  waivers?: Row[];
  batches?: Row[];
  confirmations?: Row[];
  /** 最后一条评审进度，同一个操作编号已经有评审结束时为 null；只在 readAll 的 withReview 为真时取。 */
  open_review?: { seq: number; payload: Record<string, any> } | null;
  task_dir?: string | null;
}

/**
 * 一个读事务里把任务、事件（afterSeq 之后的，或不取）、条目、条目在各次修订下的内容、来源、评审、确认都取出来。
 * withReview 为真时另取还没有结束的那批评审的最后一条进度（整份数据用）。
 */
export function readAll(db: DatabaseSync, afterSeq: number | null = null, withReview = false): LibraryData {
  if (isPreRevision(db)) throw new ApiError("old_format", OLD_FORMAT_TEXT);
  return inReadTransaction(db, () => {
    const taskRow = db.prepare("SELECT * FROM task ORDER BY started_at LIMIT 1").get() as Row | undefined;
    const seq = Number((db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM event").get() as Row).n);
    if (!taskRow) return { task: null, seq };
    const task = { ...taskRow };
    const tid = task.task_id;
    const eventMeta = new Map<number, { actor: any; at: any; call_id: any }>();
    for (const x of all(db, "SELECT seq, actor, at, call_id FROM event")) eventMeta.set(x.seq, { actor: x.actor, at: x.at, call_id: x.call_id });
    return {
      task,
      seq,
      events: afterSeq !== null ? all(db, "SELECT * FROM event WHERE seq > ? ORDER BY seq", afterSeq || 0) : [],
      items: all(db, "SELECT * FROM item WHERE task_id = ?", tid),
      contents: all(db, "SELECT * FROM item_version WHERE task_id = ? ORDER BY item_id, revision_no", tid),
      revisions: all(db, "SELECT revision_no FROM revision WHERE task_id = ? ORDER BY revision_no", tid).map((x) => x.revision_no),
      sources: readSources(db, tid),
      diagrams: readDiagrams(db, tid),
      diagram_sources: readSources(db, tid, ELEMENT_FIGURE),
      event_meta: eventMeta,
      reviews: readReviews(db, tid),
      findings: readFindings(db, tid),
      waivers: readWaivers(db, tid),
      batches: all(db, "SELECT seq, at, actor, call_id, payload FROM event WHERE task_id = ? AND name = 'REVIEW_BATCH' ORDER BY seq", tid),
      confirmations: all(db,
        "SELECT j.item_id, j.revision_no, j.attitude, g.created_at, g.basis, g.call_id, j.judgement_id " +
        "FROM judgement_item j JOIN judgement g ON g.judgement_id = j.judgement_id WHERE j.task_id = ? ORDER BY j.judgement_id", tid),
      ...(withReview ? { open_review: openReview(db) } : {}),
    };
  });
}

/** 任务库里最后一条评审进度；同一个操作编号已经有评审结束时为 null。 */
function openReview(db: DatabaseSync): { seq: number; payload: Record<string, any> } | null {
  const last = db.prepare("SELECT seq, payload FROM event WHERE name = 'REVIEW_PROGRESS' ORDER BY seq DESC LIMIT 1").get() as Row | undefined;
  if (!last) return null;
  const payload = or(jsonOrText(last.payload), {}) as Record<string, any>;
  const finished = all(db, "SELECT payload FROM event WHERE name = 'REVIEW_FINISHED'")
    .some((row) => (or(jsonOrText(row.payload), {}) as Record<string, any>).op_id === payload.op_id);
  return finished ? null : { seq: Number(last.seq), payload };
}

/**
 * 整份数据里的进行中的评审（review_in_progress）：形状与评审进度事件里的几项相同。since 是这个助手启动之前任务库的最大事件序号，
 * 助手现在没有在运行时为 null；进度写于这个助手启动之前（助手在评审中途退出过）也为 null，免得页面一直显示「评审中」。
 */
export function reviewInProgress(data: LibraryData, since: number | null): { op_id: string | null; done: number | null; total: number | null; current: string[] } | null {
  const open = data.open_review ?? null;
  if (since === null || open === null || open.seq <= since) return null;
  const p = open.payload;
  return { op_id: p.op_id ?? null, done: p.done ?? null, total: p.total ?? null, current: or(p.current, []) as string[] };
}

/** 任务库现在的最大事件序号；没有库时为 0。 */
export function maxSeq(taskDir: string): number {
  const db = openRo(taskDir);
  if (db === null) return 0;
  try {
    return Number((db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM event").get() as Row).n);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/** 评审记录，按先后（写下它的事件序号）；早期的库没有批次、指纹、重评几列，读作空。 */
export function readReviews(db: DatabaseSync, taskId: string): Row[] {
  const cols = columnNames(db, "review");
  const extra = ["batch_id", "rules_hash", "forced"].every((c) => cols.has(c))
    ? ", batch_id, rules_hash, forced" : ", NULL AS batch_id, NULL AS rules_hash, 0 AS forced";
  return all(db, `SELECT item_id, revision_no, verdict, reason, created_at, review_id, event_seq${extra} FROM review WHERE task_id = ? ORDER BY event_seq, review_id`, taskId);
}

/** 评审豁免（用户保留的写法），含已撤销的，按先后；早期的库没有这张表，读作空。 */
export function readWaivers(db: DatabaseSync, taskId: string): Row[] {
  if (!tableNames(db).has("review_waiver")) return [];
  return all(db, "SELECT item_id, revision_no, reason, source, created_at, revoked_at, event_seq FROM review_waiver WHERE task_id = ? ORDER BY event_seq, waiver_id", taskId);
}

/** 评审发现：评审编号 → 逐条发现（接口的形状）。发现表没有规则编号与级别两列的旧库，这两项读作空。 */
export function readFindings(db: DatabaseSync, taskId: string): Map<number, any[]> {
  const out = new Map<number, any[]>();
  if (!tableNames(db).has("review_finding")) return out;
  const cols = columnNames(db, "review_finding");
  const extra = cols.has("rule_id") && cols.has("level") ? ", rule_id, level" : ", NULL AS rule_id, NULL AS level";
  for (const row of all(db, `SELECT review_id, field, item_index, problem, suggestion${extra} FROM review_finding WHERE task_id = ? ORDER BY review_id, ordinal`, taskId)) {
    if (!out.has(row.review_id)) out.set(row.review_id, []);
    out.get(row.review_id)!.push({ rule_id: row.rule_id, level: row.level, field: row.field, index: row.item_index, problem: row.problem, suggestion: row.suggestion });
  }
  return out;
}

// ───────────────────────── 拼装 ─────────────────────────

/** 把 readAll 取出的行拼成接口的形状。 */
export class Library {
  readonly data: LibraryData;
  readonly definition: ParsedDefinition;
  readonly collections: Map<string, ParsedDefinition["集合"][number]>;
  /** 条目在某次修订下的内容，键见 itemKey。条目只在它被新增、修改或恢复的那些修订下有一行。 */
  readonly contents: Map<string, Row>;
  readonly items: Map<string, Row>;

  constructor(data: LibraryData) {
    this.data = data;
    this.definition = parseDefinition(data.task!.definition_text);
    this.collections = new Map(this.definition["集合"].map((c) => [c["名称"], c]));
    this.contents = new Map((data.contents || []).map((v) => [itemKey(v.item_id, v.revision_no), v]));
    this.items = new Map((data.items || []).map((i) => [i.item_id, i]));
  }

  get taskId(): string {
    return this.data.task!.task_id;
  }

  /** 条目在修订 revisionNo 下的内容（那次修订改动过它时才有）。 */
  fieldsOf(itemId: string, revisionNo: number | null | undefined): Record<string, any> | null {
    const v = revisionNo !== null && revisionNo !== undefined ? this.contents.get(itemKey(itemId, revisionNo)) : undefined;
    return v ? jsonOrText(v.fields) : null;
  }

  /**
   * 条目在某次修订下的来源。依据另一个条目的来源另带两项，都是现算的、不存库：对方现在的修订号（current_revision），
   * 与依据的现状（stale）——对方已经删除是 "deleted"；对方现在的修订号大于引用时记下的修订号是 "changed"（依据已变）；
   * 否则是 null。依据图的来源这两项先给 null：图这种要素还没有做出来。
   */
  sourcesOf(itemId: string, revisionNo: number | null | undefined): SourceView[] {
    if (!revisionNo) return [];
    return (this.data.sources?.get(itemKey(itemId, revisionNo)) || []).map((row) => this.withBasisState(sourceView(row)));
  }

  /** 给依据另一个条目（或图）的来源带上对方现在的修订号与依据的现状；别的种类原样。 */
  withBasisState(one: SourceView): SourceView {
    if (one.kind === SOURCE_FIGURE) return { ...one, current_revision: null, stale: null };
    if (one.kind !== SOURCE_ITEM) return one;
    const cited = this.items.get(one.locator);
    if (!cited || cited.deleted_in_revision !== null) return { ...one, current_revision: null, stale: "deleted" as const };
    const current = this.currentRevision(one.locator);
    const then = one.depends_revision ?? null;
    return { ...one, current_revision: current, stale: then !== null && current !== null && current > then ? "changed" as const : null };
  }

  /** 图在它自己的某次修订下的来源，与条目的来源同形；依据条目的同样带依据的现状。 */
  diagramSourcesOf(diagramId: string, revisionNo: number): SourceView[] {
    return (this.data.diagram_sources?.get(itemKey(diagramId, revisionNo)) || []).map((row) => this.withBasisState(sourceView(row)));
  }

  /** 图的列表里的一项：编号、图名、种类、它自己现在的修订号、最近一次是谁在什么时候改的、什么时候画的、有几条来源。 */
  diagramRow(record: DiagramRecord) {
    const now = latestVersion(record)!;
    return {
      diagram_id: record.diagram_id, name: now.name, kind: now.kind, kind_name: kindName(now.kind),
      revision_no: now.revision_no, revision_by: actorWord(now.actor), revision_at: clock.fromLocalText(now.created_at),
      created_at: clock.fromLocalText(record.versions[0].created_at),
      source_count: (this.data.diagram_sources?.get(itemKey(record.diagram_id, now.revision_no)) || []).length,
    };
  }

  /** 还在的图，按编号排。 */
  diagramsView() {
    return liveDiagrams(this.data.diagrams || []).map((record) => this.diagramRow(record));
  }

  /**
   * 一张图的详情：列表里的各项，加 Mermaid 文本、说明、它改动过的修订号、来源、被谁依据（现在没有要素能依据图，是空列表）、
   * 图里画了谁（drawn）。drawn 是从 Mermaid 文本里扫条目编号得出的补充视图，不存库：每项是条目编号、条目现在的标题与状态
   * （live 还在、deleted 已经删除、missing 任务里没有这个编号）。已经删除的图也给得出详情（deleted 为真），没有这张图返回 null。
   */
  diagramView(diagramId: string) {
    const record = (this.data.diagrams || []).find((one) => one.diagram_id === diagramId);
    if (!record || record.versions.length === 0) return null;
    const now = latestVersion(record)!;
    // 删除那一次修订不带来源：已经删除的图给它删除之前那一次的来源。
    const sourcesAt = record.deleted_in_revision !== null && record.versions.length > 1 ? record.versions[record.versions.length - 2].revision_no : now.revision_no;
    const prefixes = [...this.collections.values()].map((one) => one["编号前缀"]);
    const drawn = drawnItemIds(now.mermaid, prefixes).map((id) => {
      const item = this.items.get(id);
      if (!item) return { item_id: id, title: null, state: "missing" as const };
      const fields = this.fieldsOf(id, this.currentRevision(id)) ?? {};
      return { item_id: id, title: titleOf(fields, this.collections.get(item.collection)), state: item.deleted_in_revision === null ? "live" as const : "deleted" as const };
    });
    return {
      ...this.diagramRow(record), deleted: record.deleted_in_revision !== null,
      mermaid: now.mermaid, note: now.note, revisions: record.versions.map((one) => one.revision_no),
      sources: this.diagramSourcesOf(diagramId, sourcesAt),
      depended_by: [] as { element_kind: string; id: string; revision_no: number | null }[],
      drawn,
    };
  }

  /**
   * 被谁依据：每个条目被哪些要素当作依据，键是被依据的条目编号。只数还没有删除的条目在它当前修订下的来源，与还没有删除的图
   * 在它当前修订下的来源；一个要素有几条来源都依据同一个条目时只列一次。每项是产出方的种类（条目或图）、编号与它当前的修订号
   * （图的是图自己的修订号），先是条目（照条目清单的顺序）、后是图（照编号）。现算，不存库。
   */
  dependedBy(order: Row[]): Map<string, { element_kind: string; id: string; revision_no: number | null }[]> {
    const out = new Map<string, { element_kind: string; id: string; revision_no: number | null }[]>();
    for (const i of order) {
      if (i.deleted_in_revision !== null) continue;
      const no = this.currentRevision(i.item_id);
      for (const one of this.data.sources?.get(itemKey(i.item_id, no)) || []) {
        if (one["种类"] !== SOURCE_ITEM || one["出处"] === i.item_id) continue;
        let list = out.get(one["出处"]);
        if (!list) out.set(one["出处"], (list = []));
        if (!list.some((have) => have.id === i.item_id)) list.push({ element_kind: ELEMENT_ITEM, id: i.item_id, revision_no: no });
      }
    }
    for (const record of liveDiagrams(this.data.diagrams || [])) {
      const no = latestVersion(record)!.revision_no;
      for (const one of this.data.diagram_sources?.get(itemKey(record.diagram_id, no)) || []) {
        if (one["种类"] !== SOURCE_ITEM) continue;
        let list = out.get(one["出处"]);
        if (!list) out.set(one["出处"], (list = []));
        if (!list.some((have) => have.element_kind === ELEMENT_FIGURE && have.id === record.diagram_id)) list.push({ element_kind: ELEMENT_FIGURE, id: record.diagram_id, revision_no: no });
      }
    }
    return out;
  }

  reviewsOf(itemId: string, revisionNo: number | null = null) {
    const findings = this.data.findings || new Map();
    return (this.data.reviews || [])
      .filter((r) => r.item_id === itemId && (revisionNo === null || r.revision_no === revisionNo))
      .map((r) => ({
        revision_no: r.revision_no, verdict: r.verdict, reason: r.reason, findings: findings.get(r.review_id) || [],
        at: clock.fromLocalText(r.created_at), batch_id: r.batch_id ?? null, rules_hash: r.rules_hash ?? null, forced: truthy(r.forced),
        seq: r.event_seq,
      }));
  }

  /** 条目的保留记录（含已撤销的），按先后。seq 是记下它的事件序号，页面据此认保留在哪一条评审之后。 */
  waiversOf(itemId: string) {
    return (this.data.waivers || []).filter((w) => w.item_id === itemId).map((w) => ({
      revision_no: w.revision_no, reason: w.reason, source: w.source, at: clock.fromLocalText(w.created_at), revoked: w.revoked_at !== null,
      seq: w.event_seq,
    }));
  }

  /** 条目在某次修订上的评审结论（agent/src/lib/review_verdict.ts），按条目所在集合现在的规则指纹认记录。 */
  verdictOf(itemId: string, revisionNo: number) {
    const collection = this.items.get(itemId)?.collection;
    const spec = collection === undefined ? undefined : reviewSpecs(this.data.task!.definition_text)[collection];
    return reviewVerdict(revisionNo, this.reviewsOf(itemId), this.waiversOf(itemId), rulesHash(this.data.task_dir ?? null, spec));
  }

  /** 评审批次：每次评审一项，按先后，第几次评审即 no。 */
  batchesView() {
    return (this.data.batches || []).map((b, n) => batchView(n + 1, b));
  }

  confirmationsOf(itemId: string, revisionNo: number | null = null) {
    const out = [];
    for (const c of this.data.confirmations || []) {
      if (c.item_id !== itemId || (revisionNo !== null && c.revision_no !== revisionNo)) continue;
      const basis = or(jsonOrText(c.basis), []) as unknown;
      // 确认标记的依据：已读、界面修改、界面点击；都不是的是早期版本由执行者登记的「用户的话」。
      const said = new Set(Array.isArray(basis) ? basis.filter(isObject).map((b) => b["依据"] ?? null) : []);
      const kind = said.has("已读") ? "viewed" : said.has("界面点击") ? "ui_click" : said.has("界面修改") ? "ui_edit" : "user_words";
      out.push({ revision_no: c.revision_no, accepted: c.attitude === "接受", at: clock.fromLocalText(c.created_at), basis: kind });
    }
    return out;
  }

  /** 条目改动过的修订号，从早到晚。 */
  itemRevisions(itemId: string): number[] {
    return [...this.contents.values()].filter((v) => v.item_id === itemId).map((v) => v.revision_no as number).sort((a, b) => a - b);
  }

  /** 条目当前所在的修订：它最近一次被新增、修改或恢复的那次修订。 */
  currentRevision(itemId: string): number | null {
    const numbers = this.itemRevisions(itemId);
    return numbers.length ? numbers[numbers.length - 1] : null;
  }

  /** 任务最新的修订号；还没有修订时是 0。 */
  latestRevision(): number {
    const list = this.data.revisions || [];
    return list.length ? Math.max(...list) : 0;
  }

  /** 修订 revisionNo 时交付物里有哪些条目，以及每个条目那时的内容来自哪次修订：[条目编号, 内容所在的修订号]。 */
  aliveAt(revisionNo: number): [string, number][] {
    const out: [string, number][] = [];
    for (const i of this.items.values()) {
      if (i.added_in_revision > revisionNo) continue;
      if (i.deleted_in_revision !== null && i.deleted_in_revision <= revisionNo) continue;
      const upto = this.itemRevisions(i.item_id).filter((no) => no <= revisionNo);
      if (upto.length) out.push([i.item_id, upto[upto.length - 1]]);
    }
    return out;
  }

  totals(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of this.collections.keys()) out[name] = 0;
    for (const i of this.items.values()) {
      if (i.deleted_in_revision === null) out[i.collection] = (out[i.collection] ?? 0) + 1;
    }
    return out;
  }

  /** 整份数据里的 task。 */
  taskView() {
    const task = this.data.task!;
    const order = new Map([...this.collections.keys()].map((name, n) => [name, n]));
    const sorted = [...this.items.values()].sort((a, b) =>
      (order.get(a.collection) ?? 99) - (order.get(b.collection) ?? 99) || (a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0));
    const items = [];
    const dependedBy = this.dependedBy(sorted);
    for (const i of sorted) {
      if (i.deleted_in_revision !== null) continue;
      const no = this.currentRevision(i.item_id);
      const v = this.contents.get(itemKey(i.item_id, no))!;
      const meta = this.data.event_meta?.get(v.event_seq) ?? ({} as Record<string, any>);
      const fields = or(jsonOrText(v.fields), {}) as Record<string, any>;
      const confirmations = this.confirmationsOf(i.item_id);
      const accepted = confirmations.filter((c) => c.accepted);
      const latestForCurrent = confirmations.filter((c) => c.revision_no === no);
      const currentOk = latestForCurrent.length > 0 && latestForCurrent[latestForCurrent.length - 1].accepted;
      items.push({
        item_id: i.item_id, collection: i.collection,
        title: titleOf(fields, this.collections.get(i.collection)),
        revision_no: no, revision_by: actorWord(meta.actor ?? ""), revision_at: clock.fromLocalText(meta.at ?? null),
        revisions: this.itemRevisions(i.item_id),
        fields, sources: this.sourcesOf(i.item_id, no),
        depended_by: dependedBy.get(i.item_id) ?? [],
        reviews: this.reviewsOf(i.item_id),
        waivers: this.waiversOf(i.item_id),
        confirmations,
        // 确认挂在「条目加修订」上：有过接受记录，但条目当前所在的修订上最近一条态度不是接受，就是确认已失效。
        confirmation_stale: accepted.length > 0 && !currentOk,
        // 已读是条目级、单向的：在任何一次修订上有过接受的标记就不算未读，之后再改也不翻回未读。
        viewed: accepted.length > 0,
        confirmation_basis: currentOk ? latestForCurrent[latestForCurrent.length - 1].basis
          : accepted.length ? accepted[accepted.length - 1].basis : null,
      });
    }
    return {
      task_id: task.task_id,
      task_name: or(task.task_name, this.definition["任务名"]),
      task_type: this.definition["任务名"],
      domain_tag: task.domain_tag ?? null,
      status: task.status,
      started_at: clock.fromLocalText(task.started_at),
      ended_at: clock.fromLocalText(task.ended_at),
      definition: definitionView(this.definition, task.definition_text ?? null, this.data.task_dir ?? null),
      completion: null as any,
      items,
      diagrams: this.diagramsView(),
      latest_revision: this.latestRevision(),
      review_batches: this.batchesView(),
    };
  }

  /** 条目在它改动过的每次修订下的内容，从早到晚。 */
  revisionsView(itemId: string) {
    return this.itemRevisions(itemId).map((no) => {
      const v = this.contents.get(itemKey(itemId, no))!;
      const meta = this.data.event_meta?.get(v.event_seq) ?? ({} as Record<string, any>);
      return {
        revision_no: no, by: actorWord(meta.actor ?? ""), at: clock.fromLocalText(meta.at ?? null),
        fields: or(jsonOrText(v.fields), {}), sources: this.sourcesOf(itemId, no), reviews: this.reviewsOf(itemId, no),
        confirmations: this.confirmationsOf(itemId, no),
      };
    });
  }
}

/** 事件 payload 里的一条发现，写成接口的形状（与整份数据里 reviews[].findings 相同）。 */
export function findingView(one: Record<string, any>) {
  return { rule_id: one.rule_id ?? null, level: one.level ?? null, field: one.field ?? null, index: one.index ?? null,
    problem: one.problem ?? null, suggestion: one.suggestion ?? null };
}

/**
 * 一行事件拼成 [事件名, data]；不认识的事件名返回 null。字段与来源取条目在那次修订下的内容。
 *
 * 返回 null 的事件不推给页面，所以页面收到的事件序号会跳号。任务库里有五种记录有意不推，页面从别处拿到对应的内容：
 * - USER_INTENT_RECORDED（记下助手对一句话的理解）、USER_INTENT_INVALID（理解事实核对没通过）、USER_INTENT_MISSING
 *   （这一轮结束时仍没有理解）、STRUCTURED_OUTPUT_UNMATCHED（助手文字里有对不上登记格式的片段）：这四种合成「理解为」那一行，
 *   由后端读任务库算出（work_summary.ts 的 understandingLines），实时随 step 与 work_summary 推送，刷新之后在对话记录的摘要里。
 * - EXECUTOR_ACTS_RECORDED（助手回复时记下的行为）：回复的内容由「回复」工具的结果带到页面，实时是 assistant_reply，
 *   刷新之后在对话记录里；这条记录本身只供助手查询与观测台使用。
 */
export function eventPayload(lib: Library, e: Row): [string, Record<string, any>] | null {
  const payload = or(jsonOrText(e.payload), {}) as Record<string, any>;
  const base = { seq: e.seq, at: clock.fromLocalText(e.at), task_id: e.task_id };
  const actor = actorWord(e.actor);
  const opId = actor === ACTOR_USER ? e.call_id : null;
  if (e.name === "REVISION_SAVED") {
    const ops = (or(payload.operations, []) as Record<string, any>[]).map((op) => {
      const item = op.item ?? null;
      const after = op.to_revision ?? null;
      const before = op.from_revision ?? null;
      const fields = lib.fieldsOf(item, after);
      return {
        op: op.op ?? null, collection: op.collection ?? null, item_id: item,
        title: titleOf(fields !== null ? fields : lib.fieldsOf(item, before), lib.collections.get(op.collection)),
        revision_before: before, revision_after: after, fields, sources: lib.sourcesOf(item, after),
      };
    });
    return ["deliverable_changed", { ...base, revision_no: payload.revision_no ?? null, actor, op_id: opId,
      undo_of_revision: payload.undo_of_revision ?? null, operations: ops, completion: null }];
  }
  if (e.name === "TASK_CREATED") {
    return ["task_changed", { ...base, task_name: payload.task_name ?? null, status_before: null, status_after: "进行中", actor, completion: null }];
  }
  if (e.name === "DIAGRAM_SAVED") {
    // 图新增、修改或删除了一次。只带是哪一张、它自己改后的修订号、做了什么与图名、种类（连同中文名）；内容与来源由图的接口取。
    return ["diagram_changed", { ...base, actor, op_id: opId, diagram_id: payload.diagram_id ?? null, revision_no: payload.revision_no ?? null,
      op: payload.op ?? null, name: payload.name ?? null, kind: payload.kind ?? null,
      kind_name: typeof payload.kind === "string" ? kindName(payload.kind) : null }];
  }
  if (e.name === "TASK_COMPLETED") {
    const task = lib.data.task!;
    return ["task_changed", { ...base, task_name: or(task.task_name, lib.definition["任务名"]), status_before: or(payload.status_before, "进行中"),
      status_after: or(payload.status_after, "已完成"), actor, completion: null }];
  }
  if (e.name === "ITEM_VIEWED") return ["item_viewed", { ...base, items: or(payload.items, []), op_id: opId, completion: null }];
  if (e.name === "REVIEW_RECORDED") {
    return ["review_recorded", { ...base, item_id: payload.item_id ?? null, revision_no: payload.revision_no ?? null, verdict: payload.verdict ?? null,
      reason: payload.reason ?? null, findings: (or(payload.findings, []) as Record<string, any>[]).map(findingView),
      batch_id: payload.batch_id ?? null, rules_hash: payload.rules_hash ?? null, forced: truthy(payload.forced), op_id: opId, completion: null }];
  }
  if (e.name === "REVIEW_UNFINISHED") {
    return ["review_unfinished", { ...base, item_id: payload.item_id ?? null, revision_no: payload.revision_no ?? null, reason: payload.reason ?? null,
      op_id: opId, completion: null }];
  }
  if (e.name === "REVIEW_PROGRESS") {
    return ["review_progress", { ...base, op_id: payload.op_id ?? null, done: payload.done ?? null, total: payload.total ?? null,
      current: or(payload.current, []), item_id: payload.item_id ?? null, completion: null }];
  }
  if (e.name === "REVIEW_FINISHED") {
    return ["review_finished", { ...base, op_id: payload.op_id ?? null, total: payload.total ?? null, passed: payload.passed ?? null,
      failed: payload.failed ?? null, unfinished: payload.unfinished ?? null, results: or(payload.results, []), error: payload.error ?? null, completion: null }];
  }
  if (e.name === "REVIEW_BATCH") {
    const earlier = (lib.data.batches || []).filter((b) => b.seq < e.seq);
    return ["review_batch", { ...base, ...batchView(earlier.length + 1, { seq: e.seq, at: e.at, actor: e.actor, call_id: e.call_id, payload: e.payload }), completion: null }];
  }
  if (e.name === "REVIEW_WAIVED" || e.name === "REVIEW_UNWAIVED") {
    return [e.name === "REVIEW_WAIVED" ? "review_waived" : "review_unwaived", { ...base, items: or(payload.items, []), reason: payload.reason ?? null,
      source: payload.source ?? null, op_id: opId, completion: null }];
  }
  if (e.name === "REVIEW_RULES_CHANGED") {
    const name = payload.collection ?? null;
    return ["review_rules_changed", { ...base, collection: name, off: or(payload.off, []), promote: or(payload.promote, []), op_id: opId, completion: null,
      ...collectionReviewView(lib.definition, name, lib.data.task!.definition_text ?? null, lib.data.task_dir ?? null) }];
  }
  if (e.name === "CONFIRMATION_RECORDED") {
    return ["confirmation_recorded", { ...base, items: or(payload.items, []), basis: or(payload.basis, "ui_click"), op_id: opId, completion: null }];
  }
  return null;
}

/** 取 afterSeq 之后的全部事件并拼好；完成条件算一次，附在最后一条上。返回 [事件列表, 当前最大序号]。 */
export function libraryEvents(taskDir: string, afterSeq: number): [[string, Record<string, any>][], number] {
  const db = openRo(taskDir);
  if (db === null) return [[], 0];
  let data: LibraryData;
  try {
    data = readAll(db, afterSeq);
  } finally {
    db.close();
  }
  if (data.task === null || !(data.events || []).length) return [[], data.seq];
  data.task_dir = taskDir;
  const lib = new Library(data);
  const out = (data.events || []).map((e) => eventPayload(lib, e)).filter((p): p is [string, Record<string, any>] => p !== null);
  if (out.length) out[out.length - 1][1].completion = completion(taskDir, lib.taskId, lib.definition, lib.totals());
  return [out, data.seq];
}

/** 库里当前最大的事件序号：每次新开连接、查完就关，不留读事务。库不在或读不出时是 0。 */
export function currentMax(taskDir: string): number {
  const db = openRo(taskDir);
  if (db === null) return 0;
  try {
    return Number((db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM event").get() as Row).n);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/** 取整份库，读事务只包住查询；库打不开时为 null。 */
function readTask(taskDir: string, withReview = false): LibraryData | null {
  const db = openRo(taskDir);
  if (db === null) return null;
  try {
    return readAll(db, null, withReview);
  } finally {
    db.close();
  }
}

/**
 * 整份数据里的 seq、task 与进行中的评审：取号与读表在同一个读事务里；完成条件在提交之后算。
 * reviewSince 见 reviewInProgress：这个助手启动之前的最大事件序号，助手没有在运行时为 null。
 */
export function taskSnapshot(taskDir: string, reviewSince: number | null = null):
  [number, ReturnType<Library["taskView"]> | null, ReturnType<typeof reviewInProgress>] {
  const data = readTask(taskDir, true);
  if (data === null) return [0, null, null];
  if (data.task === null) return [data.seq, null, null];
  data.task_dir = taskDir;
  const lib = new Library(data);
  const view = lib.taskView();
  view.completion = completion(taskDir, lib.taskId, lib.definition, lib.totals());
  return [data.seq, view, reviewInProgress(data, reviewSince)];
}

/** 图的列表（还在的图）；任务目录里还没有库或者没有任务时是空列表。 */
export function diagramList(taskDir: string) {
  const data = readTask(taskDir);
  if (data === null || data.task === null) return [];
  return new Library(data).diagramsView();
}

/** 一张图的详情；没有这张图返回 null。 */
export function diagramDetail(taskDir: string, diagramId: string) {
  const data = readTask(taskDir);
  if (data === null || data.task === null) return null;
  return new Library(data).diagramView(diagramId);
}

export function itemRevisions(taskDir: string, itemId: string) {
  const data = readTask(taskDir);
  if (data === null || data.task === null) return null;
  const lib = new Library(data);
  return lib.items.has(itemId) ? lib.revisionsView(itemId) : null;
}

/** 生成文档用：整份库拼好的 Library。带上任务目录，评审结论才能按现在的规则指纹认记录（与页面一致）。 */
export function libraryOf(taskDir: string): Library {
  const db = openRo(taskDir)!;
  let data: LibraryData;
  try {
    data = readAll(db);
  } finally {
    db.close();
  }
  data.task_dir = taskDir;
  return new Library(data);
}

/** 键按字母排好之后的 JSON 写法，用来逐字段比较两次修订的值。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (isObject(value)) return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value === undefined ? null : value);
}

/** 前后两次修订逐字段比较，列出值不同的字段名，按任务定义里的字段顺序。新增、删除时（有一边为空）不列。 */
export function changedFields(before: Record<string, any> | null, after: Record<string, any> | null, collection: ParsedDefinition["集合"][number] | undefined): string[] {
  if (before === null || after === null || !collection) return [];
  return (or(collection["字段"], []) as ParsedDefinition["集合"][number]["字段"])
    .filter((f) => canonical(before[f["名"]]) !== canonical(after[f["名"]]))
    .map((f) => f["名"]);
}

/**
 * 按调用编号查一次调用在任务库里留下的事实，给过程摘要用：保存修订形成的修订（修订号与碰到的条目，条目取自那次修订的
 * REVISION_SAVED 事件），以及哪些调用把任务标为了已完成（TASK_COMPLETED 事件）。用户让助手停下时，工具可能已经写进了库、
 * 只是结果没来得及回到会话里，摘要据此如实写「保存了修订 N」「把任务标为已完成」。只读；库不在或读不出时两样都是空的。
 */
export function callFacts(taskDir: string | null): { revision: (callId: string) => Record<string, any> | null; completed: (callId: string) => boolean } {
  const revisions = new Map<string, Record<string, any>>();
  const completed = new Set<string>();
  const db = (() => {
    try {
      return taskDir === null ? null : openRo(taskDir);
    } catch {
      return null;
    }
  })();
  if (db !== null) {
    try {
      inReadTransaction(db, () => {
        const events = new Map(all(db, "SELECT seq, payload FROM event WHERE name = 'REVISION_SAVED'").map((x) => [x.seq as number, x]));
        for (const row of all(db, "SELECT revision_no, call_id, event_seq FROM revision")) {
          if (!row.call_id) continue;
          const payload = or(jsonOrText(events.get(row.event_seq as number)?.payload ?? null), {}) as Record<string, any>;
          revisions.set(String(row.call_id), { revision_no: row.revision_no, operations: or(payload.operations, []) });
        }
        for (const row of all(db, "SELECT call_id FROM event WHERE name = 'TASK_COMPLETED'")) if (row.call_id) completed.add(String(row.call_id));
      });
    } catch {
      // 旧格式或读不出：当作查不到
    } finally {
      db.close();
    }
  }
  return { revision: (callId) => revisions.get(callId) ?? null, completed: (callId) => completed.has(callId) };
}

/**
 * 修订日志的库部分：每次修订一项，最新的在前。每项写这次修订的时刻、发起方、产生它的会话与调用编号，以及碰到的条目：
 * 操作、编号、标题、所属集合、改前改后所在的修订、改了哪些字段。修订表的 intent_act_id 对得上对话行为表里的一项用户行为时，
 * 另带 intent（编号、功能码、功能的中文名、摘要）。触发它的事与工作编号要读会话记录，由调用方补。任务还没有创建时返回 null。
 */
export function revisionLog(taskDir: string) {
  const db = openRo(taskDir);
  if (db === null) return null;
  let data: LibraryData;
  let rows: Row[];
  let events: Map<number, Row>;
  let intents: Map<string, any>;
  try {
    data = readAll(db);
    if (data.task === null) return null;
    const tid = data.task.task_id;
    ({ rows, events, intents } = inReadTransaction(db, () => {
      const rows = all(db, "SELECT * FROM revision WHERE task_id = ? ORDER BY revision_no", tid);
      const events = new Map(all(db, "SELECT * FROM event WHERE name = 'REVISION_SAVED'").map((x) => [x.seq as number, x]));
      return { rows, events, intents: intentActs(db, tid, rows) };
    }));
  } finally {
    db.close();
  }
  const lib = new Library(data);
  const out = [];
  for (const row of [...rows].reverse()) {
    const event = events.get(row.event_seq) ?? ({} as Row);
    const payload = or(jsonOrText(event.payload ?? null), {}) as Record<string, any>;
    const ops = (or(payload.operations, []) as any[]).map((op) => {
      const item = op.item ?? null;
      const beforeNo = op.from_revision ?? null;
      const afterNo = op.to_revision ?? null;
      const before = lib.fieldsOf(item, beforeNo);
      const after = lib.fieldsOf(item, afterNo);
      const coll = lib.collections.get(op.collection);
      return {
        op: op.op ?? null, item_id: item, collection: op.collection ?? null,
        title: titleOf(after !== null ? after : before, coll),
        revision_before: beforeNo, revision_after: afterNo,
        fields_changed: op.op === "update" ? changedFields(before, after, coll) : [],
      };
    });
    out.push({
      revision_no: row.revision_no, at: clock.fromLocalText(or(event.at, row.created_at)),
      by: actorWord(event.actor ?? ""), session_id: row.session_id, call_id: row.call_id,
      undo_of_revision: payload.undo_of_revision ?? null, operations: ops,
      intent: intents.get(`${row.session_id}\u0000${row.intent_act_id ?? null}`) ?? null,
    });
  }
  return out;
}

/** 修订表里被 intent_act_id 引用的那几项用户行为，键是「会话编号\0行为编号」。库里没有对话行为表时为空。 */
function intentActs(db: DatabaseSync, taskId: string, rows: Row[]): Map<string, any> {
  const wanted = new Map<string, [any, any]>();
  for (const r of rows) if (truthy(r.intent_act_id)) wanted.set(`${r.session_id}\u0000${r.intent_act_id}`, [r.session_id, r.intent_act_id]);
  const out = new Map<string, any>();
  if (wanted.size === 0 || !tableNames(db).has("dialogue_act")) return out;
  const names = functionNames();
  for (const [key, [sessionId, actId]] of wanted) {
    const row = db.prepare("SELECT function, summary FROM dialogue_act WHERE task_id = ? AND session_id = ? AND act_id = ? AND speaker = 'user'")
      .get(taskId, sessionId, actId) as Row | undefined;
    if (row) out.set(key, { act_id: actId, function: row.function, function_name: names[row.function] ?? row.function, summary: row.summary });
  }
  return out;
}

/**
 * 文件名 name 是由同一个目录里的哪个文件生成的；present 是这个目录里全部文件的名字。由 Word 材料生成的是投影（x.docx.md，
 * 0.2 的任务里是 x.docx.txt）、分段清单（x.docx.segments.json）与位置表（x.docx.locations.json），由 PDF 材料生成的是
 * x.pdf.md、x.pdf.segments.json 与 x.pdf.locations.json。不是这几种，或者它的那份 Word、PDF 文件不在这个目录里时是 null。
 * 材料清单的 derived_from 与任务现状消息给页面的材料清单（conversation.ts 的 taskStatusDisplayDetails）都用它。
 */
export function derivedSourceName(name: string, present: ReadonlySet<string>): string | null {
  const pdf = pdfSourceName(name);
  if (pdf !== null) return present.has(pdf) ? pdf : null;
  if (name.toLowerCase().endsWith(".docx.segments.json")) {
    const stem = name.slice(0, -".segments.json".length);
    return present.has(stem) ? stem : null;
  }
  if (isLocationTable(name)) {
    const stem = name.slice(0, -LOCATIONS_SUFFIX.length);
    return present.has(stem) ? stem : null;
  }
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const stem = name.slice(0, dot);
  const ext = name.slice(dot + 1).toLowerCase();
  return (ext === "md" || ext === "txt") && stem.toLowerCase().endsWith(".docx") && present.has(stem) ? stem : null;
}

/**
 * 材料清单：材料目录里的文件（不含子目录，Word 材料的图片目录因此不列），按名字排。由 Word 材料生成的投影（x.docx.md，
 * 0.2 的任务里是 x.docx.txt）、分段清单（x.docx.segments.json）与位置表（x.docx.locations.json）旁边有那份 .docx 时，derived_from 写那份 .docx 的路径，
 * 界面据此不单独列出；其余为 null。由 PDF 材料生成的投影、分段清单与位置表（x.pdf.md、x.pdf.segments.json、x.pdf.locations.json）同样处理。
 * PDF 材料另带 pdf 一项：总页数、块的总数、没有文字的页码（读自它的位置表；位置表不在时没有这一项）。
 */
export function materials(taskDir: string, definition: ParsedDefinition | Record<string, any> | null) {
  const rel = or((definition || {})["材料目录"], DEFAULT_MATERIALS_DIR) as string;
  const folder = join(taskDir, rel);
  let names: string[];
  try {
    if (!statSync(folder).isDirectory()) return [];
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const files: [string, ReturnType<typeof statSync>][] = [];
  for (const name of names.sort(byCodePoint)) {
    try {
      const st = statSync(join(folder, name), { bigint: true });
      if (st.isFile()) files.push([name, st as any]);
    } catch {
      continue;
    }
  }
  const present = new Set(files.map(([name]) => name));
  const sourceOf = (name: string): string | null => {
    const source = derivedSourceName(name, present);
    return source === null ? null : `${rel}${source}`;
  };
  return files.map(([name, st]: [string, any]) => {
    const facts = name.toLowerCase().endsWith(".pdf") ? pdfFacts(join(folder, name)) : null;
    return {
      path: `${rel}${name}`, bytes: Number(st.size), modified_at: clock.fromEpochNs(st.mtimeNs), derived_from: sourceOf(name),
      ...(facts ? { pdf: facts } : {}),
    };
  });
}

/** 按码位比较两个字符串（与 Python 的字符串排序相同）。 */
export function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

