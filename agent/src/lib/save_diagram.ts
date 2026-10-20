/**
 * 「保存图」工具（save_diagram）的核心逻辑：新画一张图、修改一张已有的图，或者删除一张图。一次调用一张图。
 *
 * 图是任务的一种要素，不是集合里的条目（库表见 lib/schema.ts 的 DIAGRAM_SQL，读法见 lib/diagram.ts）：
 * - 内容是图名、种类、一段 Mermaid 文本与说明，没有字段；
 * - 修订号是这张图自己的，新增是修订 1，之后每改一次、删除一次各加一，不占任务的修订序号；
 * - 来源写在来源表里，产出方的种类是「图」；与条目的来源同一套种类与逐字核对（lib/save_revision.ts 的 checkDiagramSources），
 *   只是不写 supports，依据条目时可以不写摘录；
 * - 不评审，不算进完成条件，不用用户逐张确认。
 *
 * 三步：
 * 1. 在库里核对参数与来源（plan）：图在不在、base_revision 对不对、种类、图里写的条目编号是不是现有的条目、
 *    画进图里的条目是不是各有一条种类为「条目」的来源。不通过抛 ToolRejection，什么都不写。
 * 2. 校验 Mermaid 文本的写法（validate，由调用方给：工具那一层去问任务服务）。只在这一次给了 Mermaid 文本或者改了种类时校验。
 *    不通过不保存，把校验给的话原样交还；校验没有做成（unavailable）同样不保存，并说明这是程序这边的问题。
 * 3. 写库：重新核对一遍（校验是在事务之外等的，这中间库可能变了），再写图、内容、来源与一条 DIAGRAM_SAVED 事件。
 *
 * 连续校验不过：priorFailures 是这一轮里（自用户最近一句话起）图已经连续几次没有通过校验，由工具那一层从会话里数出来
 * （consecutiveDiagramFailures）。这一次是第 VALIDATION_LIMIT 次时，拒绝的话后面加一句「不要再试，告诉用户」；
 * 已经到了上限还来保存，不再校验，直接拒绝，直到用户再说话。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import type { DatabaseSync } from "node:sqlite";
import { type CallContext, type ToolOutcome, activeTasks } from "./create_task.ts";
import { ACTOR_EXECUTOR, ACTOR_USER, emit, wallClockText } from "./db.ts";
import { type TaskDefinition, validateDefinition } from "./definition.ts";
import { diagramRefusal } from "./stage.ts";
import { allowedAt, stageOf } from "./stage_read.ts";
import { DIAGRAM_ID, DIAGRAM_KINDS, type DiagramRecord, diagramId, drawnItemIds, kindName, latestVersion, readDiagrams } from "./diagram.ts";
import { FALLBACK_TEXT } from "../hooks/reply_fallback.ts";
import { REPLAYED_TEXT, type Source, checkDiagramSources, splitGuide } from "./save_revision.ts";
import { ELEMENT_FIGURE, NoDatabaseYet, SOURCE_ITEM, withTaskDatabase } from "./schema.ts";
import { type RefusalText, codeOf, fillText, refusalText } from "./texts.ts";
import { ToolRejection, notInputProblem } from "./tool_rejection.ts";

/** 工具名。 */
export const SAVE_DIAGRAM_TOOL_NAME = "save_diagram";
/** 图保存之后记的事件名。 */
export const EVENT_DIAGRAM_SAVED = "DIAGRAM_SAVED";
/** 图名最长多少个字。 */
export const NAME_LIMIT = 60;
/** 说明最长多少个字。 */
export const NOTE_LIMIT = 500;
/** 一轮里图连续几次没有通过校验就不再试。 */
export const VALIDATION_LIMIT = 3;

/** 校验没有通过时拒绝的话的开头（模板 part.mermaid_failed_head）。数连续几次没有通过校验时认的就是它（consecutiveDiagramFailures）。 */
export const VALIDATION_FAILED_TEXT = fillText("part.mermaid_failed_head");
/** 到了上限时接在后面的话。 */
export const GIVE_UP_TEXT = fillText("part.mermaid_give_up", { limit: VALIDATION_LIMIT });
/** 已经到了上限还来保存时的拒绝：不再校验。开头同样是 VALIDATION_FAILED_TEXT，所以它自己也被数进去。 */
export const OVER_LIMIT_TEXT = `${VALIDATION_FAILED_TEXT}${fillText("part.mermaid_not_checked")}${GIVE_UP_TEXT}`;

/** 任务服务校验一段 Mermaid 文本的结果（backend/src/diagram_validate.ts 的 DiagramCheck，两边是一份约定）。 */
export type DiagramCheck = { ok: true } | { ok: false; reason: string; line: number | null; message: string };
/** 校验函数：种类与 Mermaid 文本。工具那一层给的是去问任务服务的那一个；联系不上时它回 reason 为 unavailable 的结果，不抛异常。 */
export type ValidateDiagram = (kind: string, mermaid: string) => Promise<DiagramCheck>;
/** 核对通过、要去校验之前，把任务编号告诉调用方（校验接口的路径里要写它）。 */
export type OnTask = (taskId: string) => void;

export interface SaveDiagramParams {
  diagram?: unknown;
  base_revision?: unknown;
  name?: unknown;
  kind?: unknown;
  mermaid?: unknown;
  note?: unknown;
  sources?: unknown;
  delete?: unknown;
}

export interface SaveDiagramOptions {
  validate: ValidateDiagram;
  /** 这一轮里图已经连续几次没有通过校验（不含这一次）。不给当作 0。 */
  priorFailures?: number;
  onTask?: OnTask;
  /**
   * 用户在页面上改图（lib/user_diagram.ts）：不核对「Mermaid 文本里写的条目编号是现有的条目」与「画进图里的条目各有一条来源」。
   * 用户随手改文本不强求来源；写了任务里没有的编号，页面的「图里画了谁」会标出来。图里画了哪些条目照常重算。
   */
  userEdit?: boolean;
}

/** 核对通过之后要写的东西。 */
interface Plan {
  taskId: string;
  op: "add" | "update" | "delete";
  /** 修改与删除时是哪一张图；新增时为 null，编号写库时才定。 */
  record: DiagramRecord | null;
  name: string;
  kind: string;
  mermaid: string;
  note: string;
  /** 这次修订下的来源；删除时为空。 */
  sources: Source[];
  /** 这一次要不要校验 Mermaid 文本：新增，或者修改时给了文本、改了种类。 */
  validate: boolean;
  /** 图里画了哪些条目（从 Mermaid 文本里扫出来的）。 */
  drawn: string[];
  /** 这一次因为条目从图里删掉了而从来源里去掉的条目编号（只有修改图时会有）。 */
  dropped: string[];
}

const reject = (fact: string, guidance = "", codes: string[] = []): ToolRejection =>
  new ToolRejection(`${fillText("part.diagram_head", { fact })}${guidance ? `\n${fillText("part.save_guidance", { guidance })}` : ""}`, fact, guidance, codes);
/** 按拒绝语的键拒绝（键写在调用处的 refusalText 里，守护测试才扫得到）。 */
const refused = (refusal: RefusalText): ToolRejection => reject(refusal.fact, refusal.guidance, [refusal.code]);

/**
 * 来源核对的错误（每条带着拒绝语的键与两层文字，见 save_revision.ts 的 splitGuide）合成一次拒绝：事实用「；」接起来，指引也是；
 * 调用处给了指引的用它。原因码按错误的先后。
 */
function sourcesRejection(errors: string[], guidance = ""): ToolRejection {
  const parts = errors.map(splitGuide);
  const guides = parts.map((one) => one.guidance).filter(Boolean);
  return reject(parts.map((one) => one.fact).join("；"), guidance || guides.join("；"), parts.filter((one) => one.key).map((one) => codeOf(one.key)));
}

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const given = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * 工具的参数模式里 sources 是必填的一项（可以是 null），pi 在调用工具之前核对，漏写会被它拦下。这里在核对之前把没有写的补成 null：
 * null 与没有写在核心函数里是一回事（见 given），新画而没有来源的照常得到中文的拒绝，修改与删除照旧可以不写。
 * 不是对象的参数原样交回，由 pi 去拒绝。
 */
export function withSourcesKey(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args) || "sources" in args) return args;
  return { ...args, sources: null };
}

/** 这张图在它当前修订下的来源。 */
function sourcesOf(db: DatabaseSync, taskId: string, id: string, revisionNo: number): Source[] {
  const rows = db.prepare(
    "SELECT kind, locator, excerpt, normalized_value, depends_revision FROM item_source " +
      "WHERE task_id = ? AND element_kind = ? AND item_id = ? AND revision_no = ? ORDER BY position",
  ).all(taskId, ELEMENT_FIGURE, id, revisionNo) as { kind: string; locator: string; excerpt: string; normalized_value: string | null; depends_revision: number | null }[];
  return rows.map((row) => ({
    kind: row.kind, locator: row.locator, excerpt: row.excerpt, supports: [],
    ...(row.normalized_value !== null ? { normalized_value: row.normalized_value } : {}),
    ...(row.depends_revision !== null ? { depends_revision: row.depends_revision } : {}),
  }));
}

/** 库里那一个任务与它的定义；没有或者不止一个时抛出说明。 */
function activeTask(db: DatabaseSync): { taskId: string; definition: TaskDefinition } {
  const running = activeTasks(db);
  if (running.length === 0) {
    throw notInputProblem(new Error(fillText("save_diagram.no_task")));
  }
  if (running.length > 1) {
    throw notInputProblem(new Error(fillText("save_diagram.several_tasks", { count: running.length })));
  }
  return { taskId: running[0].task_id, definition: validateDefinition(JSON.parse(running[0].definition_text)) };
}

/** 第 1 步：在库里核对参数与来源，得出要写的东西。不通过抛 ToolRejection。 */
function plan(db: DatabaseSync, call: CallContext, params: SaveDiagramParams, userEdit = false): Plan {
  const { taskId, definition } = activeTask(db);
  // 工作的阶段（lib/stage.ts）：助手在核读材料与澄清两个阶段、会话空闲时不能画图、改图、删图，看的是这条会话的工作项。用户在页面上改图不看阶段；早先建的任务没有阶段。
  if (!userEdit && call.actor !== ACTOR_USER) {
    const stage = stageOf(db, call.workspaceDir, taskId, definition, call.sessionId);
    const refusal = stage ? diagramRefusal(stage, allowedAt(call.workspaceDir, definition, stage)) : null;
    if (refusal) throw refused(refusal);
  }
  const records = readDiagrams(db, taskId);
  const deleting = params.delete === true;
  if (given(params.delete) && typeof params.delete !== "boolean") throw refused(refusalText("save_diagram.delete_not_boolean"));

  // 新增：不写 diagram。
  if (!given(params.diagram)) {
    if (deleting) throw refused(refusalText("save_diagram.delete_without_diagram"));
    if (given(params.base_revision)) throw refused(refusalText("save_diagram.add_base_revision_given"));
    const missing = [
      !isText(params.name) && fillText("part.diagram_missing_name"), !given(params.kind) && fillText("part.diagram_missing_kind"),
      !isText(params.mermaid) && fillText("part.diagram_missing_mermaid"),
    ].filter(Boolean);
    if (missing.length) throw refused(refusalText("save_diagram.add_fields_missing", { missing: missing.join("、") }));
    const content = checkContent(params);
    const errors: string[] = [];
    const sources = checkDiagramSources(db, taskId, definition, params.sources, call, errors);
    if (!sources) throw sourcesRejection(errors, fillText("part.diagram_sources_guide"));
    const drawn = checkDrawn(db, taskId, definition, content.mermaid!, sources);
    return { taskId, op: "add", record: null, name: content.name!, kind: content.kind!, mermaid: content.mermaid!, note: content.note ?? "", sources, validate: true, drawn, dropped: [] };
  }

  // 修改与删除：图必须存在、没有删除，base_revision 是它现在的修订号。
  const id = typeof params.diagram === "string" ? params.diagram.trim() : "";
  const alive = records.filter((one) => one.deleted_in_revision === null).map((one) => one.diagram_id);
  const have = fillText("part.diagram_have", { list: alive.length ? alive.join("、") : fillText("part.diagram_none") });
  if (!DIAGRAM_ID.test(id)) throw refused(refusalText("save_diagram.diagram_id_invalid", { given: String(JSON.stringify(params.diagram)), have }));
  const record = records.find((one) => one.diagram_id === id);
  if (!record) throw refused(refusalText("save_diagram.diagram_not_found", { id, have }));
  const current = latestVersion(record)!;
  if (record.deleted_in_revision !== null) throw refused(refusalText("save_diagram.diagram_deleted", { id, revision: record.deleted_in_revision, have }));
  if (!Number.isInteger(params.base_revision)) {
    const op = deleting ? fillText("part.diagram_op_delete") : fillText("part.diagram_op_update");
    throw refused(refusalText("save_diagram.base_revision_missing", { op, id, now: current.revision_no }));
  }
  if (params.base_revision !== current.revision_no) {
    throw refused(refusalText("save_diagram.base_revision_stale", { id, now: current.revision_no, given: String(params.base_revision) }));
  }
  if (deleting) {
    const extra = (["name", "kind", "mermaid", "note", "sources"] as const).filter((key) => given(params[key]));
    if (extra.length) throw refused(refusalText("save_diagram.delete_extra_fields", { id, fields: extra.join("、") }));
    return { taskId, op: "delete", record, name: current.name, kind: current.kind, mermaid: current.mermaid, note: current.note, sources: [], validate: false, drawn: [], dropped: [] };
  }

  const content = checkContent(params);
  const previous = sourcesOf(db, taskId, id, current.revision_no);
  let sources = previous;
  if (given(params.sources)) {
    const errors: string[] = [];
    const checked = checkDiagramSources(db, taskId, definition, params.sources, call, errors, previous);
    if (!checked) throw sourcesRejection(errors);
    sources = checked;
  }
  const merged = { name: content.name ?? current.name, kind: content.kind ?? current.kind, mermaid: content.mermaid ?? current.mermaid, note: content.note ?? current.note };
  // 改了 Mermaid 文本时按新文本重算「条目」来源：上一修订的文本里画着、这一版文本里不再出现的条目，来源去掉（不论来源是沿用的还是这次又写上的）；
  // 仍然画着的保留；上一修订的文本里本来就没画、只是当依据引用的条目也保留；新加的来源照常核对。
  const prefixes = definition.collections.map((one) => one.prefix);
  const dropped = content.mermaid === undefined ? [] : drawnItemIds(current.mermaid, prefixes).filter((id) => !drawnItemIds(content.mermaid!, prefixes).includes(id));
  if (dropped.length) sources = sources.filter((one) => !(one.kind === SOURCE_ITEM && dropped.includes(one.locator)));
  const sameContent = merged.name === current.name && merged.kind === current.kind && merged.mermaid === current.mermaid && merged.note === current.note;
  if (sameContent && !given(params.sources)) {
    throw refused(refusalText("save_diagram.nothing_changed", { id, revision: current.revision_no }));
  }
  // 图里写的条目编号与来源对不对得上，只在这一次动了 Mermaid 文本或者来源时核对；只改图名或说明不核对，用户在页面上改图也不核对。
  const touched = content.mermaid !== undefined || given(params.sources);
  const drawn = touched && !userEdit ? checkDrawn(db, taskId, definition, merged.mermaid, sources) : drawnItemIds(merged.mermaid, definition.collections.map((one) => one.prefix));
  return { taskId, op: "update", record, ...merged, sources, validate: content.mermaid !== undefined || merged.kind !== current.kind, drawn, dropped };
}

/** 图名、种类、Mermaid 文本、说明四项里给了的那几项，核对形状；没给的不在结果里。 */
function checkContent(params: SaveDiagramParams): { name?: string; kind?: string; mermaid?: string; note?: string } {
  const out: { name?: string; kind?: string; mermaid?: string; note?: string } = {};
  if (given(params.name)) {
    if (!isText(params.name)) throw refused(refusalText("save_diagram.name_empty"));
    const name = params.name.trim();
    if ([...name].length > NAME_LIMIT) throw refused(refusalText("save_diagram.name_too_long", { length: [...name].length, limit: NAME_LIMIT }));
    if (/[\r\n]/.test(name)) throw refused(refusalText("save_diagram.name_multiline"));
    out.name = name;
  }
  if (given(params.kind)) {
    if (typeof params.kind !== "string" || !(DIAGRAM_KINDS as readonly string[]).includes(params.kind)) {
      throw refused(refusalText("save_diagram.kind_invalid", {
        given: String(JSON.stringify(params.kind)), kinds: DIAGRAM_KINDS.map((one) => `${one}（${kindName(one)}）`).join("、"),
      }));
    }
    out.kind = params.kind;
  }
  if (given(params.mermaid)) {
    if (!isText(params.mermaid)) throw refused(refusalText("save_diagram.mermaid_empty"));
    out.mermaid = params.mermaid;
  }
  if (given(params.note)) {
    if (typeof params.note !== "string") throw refused(refusalText("save_diagram.note_not_text"));
    const note = params.note.trim();
    if ([...note].length > NOTE_LIMIT) throw refused(refusalText("save_diagram.note_too_long", { length: [...note].length, limit: NOTE_LIMIT }));
    out.note = note;
  }
  return out;
}

/**
 * 图里写的条目编号与来源对不对得上：写进 Mermaid 文本的条目编号必须是现有、没有删除的条目；画进图里的每个条目必须各有一条
 * 种类为「条目」的来源（这样被画的条目之后改了，图上才标得出「依据已变」）。通过返回图里画了哪些条目。
 */
function checkDrawn(db: DatabaseSync, taskId: string, definition: TaskDefinition, mermaid: string, sources: Source[]): string[] {
  const drawn = drawnItemIds(mermaid, definition.collections.map((one) => one.prefix));
  if (drawn.length === 0) return drawn;
  const rows = db.prepare("SELECT item_id, deleted_in_revision FROM item WHERE task_id = ?").all(taskId) as { item_id: string; deleted_in_revision: number | null }[];
  const state = new Map(rows.map((row) => [row.item_id, row.deleted_in_revision]));
  const missing = drawn.filter((id) => !state.has(id));
  const deleted = drawn.filter((id) => state.has(id) && state.get(id) !== null);
  if (missing.length || deleted.length) {
    const parts = [
      missing.length ? fillText("part.drawn_missing", { items: missing.join("、") }) : "", deleted.length ? fillText("part.drawn_deleted", { items: deleted.join("、") }) : "",
    ].filter(Boolean);
    throw refused(refusalText("save_diagram.drawn_item_invalid", { parts: parts.join("，") }));
  }
  const cited = new Set(sources.filter((one) => one.kind === SOURCE_ITEM).map((one) => one.locator));
  const uncited = drawn.filter((id) => !cited.has(id));
  if (uncited.length) {
    throw refused(refusalText("save_diagram.drawn_item_uncited", {
      items: uncited.join("、"), pronoun: uncited.length > 1 ? fillText("part.them") : fillText("part.it"), first: uncited[0],
    }));
  }
  return drawn;
}

/** 这个调用编号是不是已经保存过一张图（模型重试、同一次调用重发）：保存过就照那一次的结果交回。 */
function savedBefore(db: DatabaseSync, call: CallContext): ToolOutcome | null {
  if (call.actor === ACTOR_USER || call.callId === "") return null;
  const hit = db.prepare(
    "SELECT task_id, diagram_id, revision_no, op, name, kind, event_seq FROM diagram_version WHERE call_id = ? AND task_id IN (SELECT task_id FROM task) ORDER BY revision_no LIMIT 1",
  ).get(call.callId) as { task_id: string; diagram_id: string; revision_no: number; op: Plan["op"]; name: string; kind: string; event_seq: number } | undefined;
  if (!hit) return null;
  return {
    text: `${savedText(hit.diagram_id, hit.op, hit.name, hit.kind, hit.revision_no, [])}\n${REPLAYED_TEXT}`,
    details: { task_id: hit.task_id, diagram_id: hit.diagram_id, revision_no: hit.revision_no, op: hit.op, name: hit.name, kind: hit.kind, event_seq: hit.event_seq, saved: true, replayed: true },
  };
}

function savedText(id: string, op: Plan["op"], name: string, kind: string, revisionNo: number, drawn: string[], dropped: string[] = []): string {
  if (op === "delete") return fillText("result.save_diagram.deleted", { id, name, revision: revisionNo });
  const done = op === "add" ? fillText("result.save_diagram.done_add") : fillText("result.save_diagram.done_update");
  return fillText("result.save_diagram.saved", { done, id, name, kind: kindName(kind), revision: revisionNo }) +
    (drawn.length ? fillText("result.save_diagram.drawn", { count: drawn.length, items: drawn.join("、") }) : "") +
    (dropped.length ? fillText("result.save_diagram.dropped", { items: dropped.join("、") }) : "");
}

/** 第 3 步：写图、内容、来源与事件。 */
function write(db: DatabaseSync, call: CallContext, one: Plan): ToolOutcome {
  const actor = call.actor ?? ACTOR_EXECUTOR;
  const serial = one.record ? one.record.serial
    : Number((db.prepare("SELECT COALESCE(MAX(serial), 0) AS n FROM diagram WHERE task_id = ?").get(one.taskId) as { n: number }).n) + 1;
  const id = one.record ? one.record.diagram_id : diagramId(serial);
  const revisionNo = one.record ? latestVersion(one.record)!.revision_no + 1 : 1;
  const seq = emit(db, {
    taskId: one.taskId, sessionId: call.sessionId, callId: call.callId, name: EVENT_DIAGRAM_SAVED,
    payload: { diagram_id: id, revision_no: revisionNo, op: one.op, name: one.name, kind: one.kind },
    actor,
  });
  if (one.op === "add") {
    db.prepare("INSERT INTO diagram (task_id, diagram_id, serial, deleted_in_revision, event_seq, deleted_event_seq) VALUES (?, ?, ?, NULL, ?, NULL)")
      .run(one.taskId, id, serial, seq);
  }
  if (one.op === "delete") {
    db.prepare("UPDATE diagram SET deleted_in_revision = ?, deleted_event_seq = ? WHERE task_id = ? AND diagram_id = ?").run(revisionNo, seq, one.taskId, id);
  }
  db.prepare(
    "INSERT INTO diagram_version (task_id, diagram_id, revision_no, op, name, kind, mermaid, note, actor, session_id, call_id, created_at, event_seq) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(one.taskId, id, revisionNo, one.op, one.name, one.kind, one.mermaid, one.note, actor, call.sessionId, call.callId, wallClockText(), seq);
  const insertSource = db.prepare(
    "INSERT INTO item_source (task_id, element_kind, item_id, revision_no, position, support_no, kind, locator, excerpt, field, field_index, event_seq, normalized_value, depends_revision) " +
      "VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?, ?)",
  );
  one.sources.forEach((source, index) => {
    insertSource.run(one.taskId, ELEMENT_FIGURE, id, revisionNo, index + 1, source.kind, source.locator, source.excerpt, seq,
      source.normalized_value ?? null, typeof source.depends_revision === "number" ? source.depends_revision : null);
  });
  return {
    text: savedText(id, one.op, one.name, one.kind, revisionNo, one.drawn, one.dropped),
    details: { task_id: one.taskId, diagram_id: id, revision_no: revisionNo, op: one.op, name: one.name, kind: one.kind, event_seq: seq, saved: true, drawn: one.drawn, ...(one.dropped.length ? { dropped_sources: one.dropped } : {}) },
  };
}

function inDatabase<T>(call: CallContext, body: (db: DatabaseSync) => T): T {
  try {
    return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, body);
  } catch (error) {
    if (error instanceof NoDatabaseYet) {
      throw notInputProblem(new Error(fillText("save_diagram.no_database")));
    }
    throw error;
  }
}

/** 保存一张图。做成返回给模型的文字与结构化结果；不通过抛 ToolRejection（参数、来源、校验不过）或普通异常（校验没有做成、库的问题）。 */
export async function saveDiagram(call: CallContext, params: SaveDiagramParams, options: SaveDiagramOptions): Promise<ToolOutcome> {
  const userEdit = options.userEdit === true;
  const first = inDatabase(call, (db) => savedBefore(db, call) ?? plan(db, call, params, userEdit));
  if ("text" in first) return first;
  if (first.validate) {
    // 这一轮已经连续到了上限：不再校验，直接拒绝，直到用户再说话。
    if ((options.priorFailures ?? 0) >= VALIDATION_LIMIT) {
      const refusal = refusalText("save_diagram.mermaid_over_limit");
      throw new ToolRejection(OVER_LIMIT_TEXT, refusal.fact, GIVE_UP_TEXT, [refusal.code]);
    }
    options.onTask?.(first.taskId);
    const check = await options.validate(first.kind, first.mermaid);
    if (!check.ok && check.reason === "unavailable") {
      throw notInputProblem(new Error(fillText("save_diagram.validation_unavailable", { message: check.message })));
    }
    if (!check.ok) {
      const last = (options.priorFailures ?? 0) + 1 >= VALIDATION_LIMIT;
      const refusal = refusalText("save_diagram.mermaid_invalid", { message: check.message });
      throw new ToolRejection(`${VALIDATION_FAILED_TEXT}${check.message}\n${last ? GIVE_UP_TEXT : fillText("part.mermaid_fix")}`,
        refusal.fact, last ? GIVE_UP_TEXT : refusal.guidance, [refusal.code]);
    }
  }
  // 校验是在事务之外等的，这中间库可能变了：重新核对一遍再写。
  return inDatabase(call, (db) => savedBefore(db, call) ?? write(db, call, plan(db, call, params, userEdit)));
}

type BranchEntry = { type: string; message?: { role?: string; toolName?: string; isError?: boolean; content?: unknown } };

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : (Array.isArray(content) ? content : []).map((part: any) => (part?.type === "text" ? part.text : "")).join("");

/**
 * 这一轮里图已经连续几次没有通过校验：从会话当前分支的末尾往回数「保存图」的结果，是「没有通过校验」的拒绝就加一；
 * 数到一次做成了的保存图、或者一条用户消息为止（兜底扩展追加的那句固定的话不算用户说话）。别的工具调用、
 * 保存图因为别的原因被拒（参数不对、来源不对、校验没有做成）都不打断、也不算数。
 */
export function consecutiveDiagramFailures(branch: BranchEntry[]): number {
  let count = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || !entry.message) continue;
    const { role, toolName } = entry.message;
    if (role === "toolResult" && toolName === SAVE_DIAGRAM_TOOL_NAME) {
      if (entry.message.isError !== true) break;
      if (textOf(entry.message.content).includes(VALIDATION_FAILED_TEXT)) count += 1;
    } else if (role === "user") {
      if (textOf(entry.message.content).trim() !== FALLBACK_TEXT) break;
    }
  }
  return count;
}
