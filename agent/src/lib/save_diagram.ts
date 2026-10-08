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
import { DIAGRAM_ID, DIAGRAM_KINDS, type DiagramRecord, diagramId, drawnItemIds, kindName, latestVersion, readDiagrams } from "./diagram.ts";
import { FALLBACK_TEXT } from "../hooks/reply_fallback.ts";
import { REPLAYED_TEXT, type Source, checkDiagramSources } from "./save_revision.ts";
import { ELEMENT_FIGURE, NoDatabaseYet, SOURCE_ITEM, withTaskDatabase } from "./schema.ts";
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

/** 校验没有通过时拒绝的话的开头。数连续几次没有通过校验时认的就是它（consecutiveDiagramFailures）。 */
export const VALIDATION_FAILED_TEXT = "这张图没有保存：Mermaid 文本没有通过校验。";
/** 到了上限时接在后面的话。 */
export const GIVE_UP_TEXT =
  `这一轮里图已经连续 ${VALIDATION_LIMIT} 次没有通过校验，不要再试：用 reply 告诉用户这张图哪里画不出来，问用户要不要换一种图或者画得小一些。`;
/** 已经到了上限还来保存时的拒绝：不再校验。开头同样是 VALIDATION_FAILED_TEXT，所以它自己也被数进去。 */
export const OVER_LIMIT_TEXT = `${VALIDATION_FAILED_TEXT}这一次没有再校验。${GIVE_UP_TEXT}`;
/** 校验没有做成时拒绝的话的开头。 */
export const UNAVAILABLE_TEXT = "这张图没有保存。";
/** 校验没有做成时接在后面的话。 */
export const TELL_USER_TEXT = "不要改了文本再试，用 reply 把这个情况告诉用户。";

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
}

const reject = (fact: string, guidance = ""): ToolRejection =>
  new ToolRejection(`这张图没有保存：${fact}。${guidance ? `\n怎么办：${guidance}。` : ""}`, fact, guidance);

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const given = (value: unknown): boolean => value !== undefined && value !== null;

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

/** 进行中的那一个任务与它的定义；没有或者不止一个时抛出说明。 */
function activeTask(db: DatabaseSync): { taskId: string; definition: TaskDefinition } {
  const running = activeTasks(db);
  if (running.length === 0) {
    throw notInputProblem(new Error("这个任务已经结束（已完成或已放弃），或者库里没有任务记录，所以图没有保存。请把这个情况如实告诉用户。"));
  }
  if (running.length > 1) {
    throw notInputProblem(new Error(`这个任务目录里有 ${running.length} 个进行中的任务，库里的记录有问题，所以图没有保存。请把这个情况告诉用户。`));
  }
  return { taskId: running[0].task_id, definition: validateDefinition(JSON.parse(running[0].definition_text)) };
}

/** 第 1 步：在库里核对参数与来源，得出要写的东西。不通过抛 ToolRejection。 */
function plan(db: DatabaseSync, call: CallContext, params: SaveDiagramParams): Plan {
  const { taskId, definition } = activeTask(db);
  const records = readDiagrams(db, taskId);
  const deleting = params.delete === true;
  if (given(params.delete) && typeof params.delete !== "boolean") throw reject("delete 写的不是真或假", "删除一张图时写 delete 为 true，别的时候不写");

  // 新增：不写 diagram。
  if (!given(params.diagram)) {
    if (deleting) throw reject("要删除图，但没有写是哪一张", "diagram 写要删除的图的编号，例如 D-001");
    if (given(params.base_revision)) throw reject("新画一张图时写了 base_revision", "新画的图还没有修订号，不要写 base_revision；要改已有的图就写上 diagram");
    const missing = [!isText(params.name) && "name（图名）", !given(params.kind) && "kind（图的种类）", !isText(params.mermaid) && "mermaid（Mermaid 文本）"].filter(Boolean);
    if (missing.length) throw reject(`新画一张图缺少 ${missing.join("、")}`);
    const content = checkContent(params);
    const errors: string[] = [];
    const sources = checkDiagramSources(db, taskId, definition, params.sources, call, errors);
    if (!sources) throw reject(errors.join("；"), "图至少要有一条来源：用户要你画图的那句话写一条「用户的话」，画进图里的每个条目各写一条种类为「条目」的来源");
    const drawn = checkDrawn(db, taskId, definition, content.mermaid!, sources);
    return { taskId, op: "add", record: null, name: content.name!, kind: content.kind!, mermaid: content.mermaid!, note: content.note ?? "", sources, validate: true, drawn };
  }

  // 修改与删除：图必须存在、没有删除，base_revision 是它现在的修订号。
  const id = typeof params.diagram === "string" ? params.diagram.trim() : "";
  const alive = records.filter((one) => one.deleted_in_revision === null).map((one) => one.diagram_id);
  const have = `现有的图是：${alive.length ? alive.join("、") : "（一张都没有）"}`;
  if (!DIAGRAM_ID.test(id)) throw reject(`diagram 写的 ${JSON.stringify(params.diagram)} 不是图的编号`, `图的编号是 D-001 这样的；${have}。新画一张图时不要写 diagram`);
  const record = records.find((one) => one.diagram_id === id);
  if (!record) throw reject(`这个任务里没有图 ${id}`, have);
  const current = latestVersion(record)!;
  if (record.deleted_in_revision !== null) throw reject(`图 ${id} 已经在它的修订 ${record.deleted_in_revision} 删除了`, have);
  if (!Number.isInteger(params.base_revision)) {
    throw reject(`${deleting ? "删除" : "修改"}图 ${id} 时没有写 base_revision，或者写的不是整数`, `${id} 现在是修订 ${current.revision_no}，base_revision 写 ${current.revision_no}`);
  }
  if (params.base_revision !== current.revision_no) {
    throw reject(`图 ${id} 现在是修订 ${current.revision_no}，你写的 base_revision 是 ${String(params.base_revision)}，它在你看过之后又改过`,
      `先用 get_item 看 ${id} 现在的样子，再决定怎样改`);
  }
  if (deleting) {
    const extra = (["name", "kind", "mermaid", "note", "sources"] as const).filter((key) => given(params[key]));
    if (extra.length) throw reject(`删除图 ${id} 时还写了 ${extra.join("、")}`, "删除时只写 diagram、base_revision 与 delete");
    return { taskId, op: "delete", record, name: current.name, kind: current.kind, mermaid: current.mermaid, note: current.note, sources: [], validate: false, drawn: [] };
  }

  const content = checkContent(params);
  const previous = sourcesOf(db, taskId, id, current.revision_no);
  let sources = previous;
  if (given(params.sources)) {
    const errors: string[] = [];
    const checked = checkDiagramSources(db, taskId, definition, params.sources, call, errors, previous);
    if (!checked) throw reject(errors.join("；"));
    sources = checked;
  }
  const merged = { name: content.name ?? current.name, kind: content.kind ?? current.kind, mermaid: content.mermaid ?? current.mermaid, note: content.note ?? current.note };
  const sameContent = merged.name === current.name && merged.kind === current.kind && merged.mermaid === current.mermaid && merged.note === current.note;
  if (sameContent && !given(params.sources)) {
    throw reject(`对图 ${id} 的修改与它在修订 ${current.revision_no} 的内容完全一样，没有改动任何东西`, "只写要改的那几项；不需要改就不用保存");
  }
  // 图里写的条目编号与来源对不对得上，只在这一次动了 Mermaid 文本或者来源时核对；只改图名或说明不核对。
  const touched = content.mermaid !== undefined || given(params.sources);
  const drawn = touched ? checkDrawn(db, taskId, definition, merged.mermaid, sources) : drawnItemIds(merged.mermaid, definition.collections.map((one) => one.prefix));
  return { taskId, op: "update", record, ...merged, sources, validate: content.mermaid !== undefined || merged.kind !== current.kind, drawn };
}

/** 图名、种类、Mermaid 文本、说明四项里给了的那几项，核对形状；没给的不在结果里。 */
function checkContent(params: SaveDiagramParams): { name?: string; kind?: string; mermaid?: string; note?: string } {
  const out: { name?: string; kind?: string; mermaid?: string; note?: string } = {};
  if (given(params.name)) {
    if (!isText(params.name)) throw reject("name（图名）是空的，或者不是文字");
    const name = params.name.trim();
    if ([...name].length > NAME_LIMIT) throw reject(`图名有 ${[...name].length} 个字，超过了 ${NAME_LIMIT} 个字`, "图名写短一些，要解释的话写进 note");
    if (/[\r\n]/.test(name)) throw reject("图名里有换行", "图名写成一行");
    out.name = name;
  }
  if (given(params.kind)) {
    if (typeof params.kind !== "string" || !(DIAGRAM_KINDS as readonly string[]).includes(params.kind)) {
      throw reject(`kind（图的种类）写的是 ${JSON.stringify(params.kind)}`,
        `kind 只能是 ${DIAGRAM_KINDS.map((one) => `${one}（${kindName(one)}）`).join("、")} 之一`);
    }
    out.kind = params.kind;
  }
  if (given(params.mermaid)) {
    if (!isText(params.mermaid)) throw reject("mermaid（Mermaid 文本）是空的，或者不是文字");
    out.mermaid = params.mermaid;
  }
  if (given(params.note)) {
    if (typeof params.note !== "string") throw reject("note（说明）不是文字");
    const note = params.note.trim();
    if ([...note].length > NOTE_LIMIT) throw reject(`说明有 ${[...note].length} 个字，超过了 ${NOTE_LIMIT} 个字`, "说明写一两句话");
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
    const parts = [missing.length ? `${missing.join("、")} 在这个任务里不存在` : "", deleted.length ? `${deleted.join("、")} 已经删除` : ""].filter(Boolean);
    throw reject(`Mermaid 文本里写的条目编号${parts.join("，")}`, "图里只写任务里现有的条目编号；用 get_task_status 可以看到现有的条目");
  }
  const cited = new Set(sources.filter((one) => one.kind === SOURCE_ITEM).map((one) => one.locator));
  const uncited = drawn.filter((id) => !cited.has(id));
  if (uncited.length) {
    throw reject(`图里画了 ${uncited.join("、")}，来源里没有写${uncited.length > 1 ? "它们" : "它"}`,
      `画进图里的每个条目各写一条种类为「条目」的来源，出处写条目编号，不用写摘录，例如 {"kind": "条目", "locator": "${uncited[0]}"}；` +
      "修改图时给了 sources 就是整份替换，要把还用得着的来源一起写上");
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

function savedText(id: string, op: Plan["op"], name: string, kind: string, revisionNo: number, drawn: string[]): string {
  if (op === "delete") return `已删除图 ${id}「${name}」（删除记作它的修订 ${revisionNo}）。`;
  return `已${op === "add" ? "保存" : "修改"}图 ${id}「${name}」（${kindName(kind)}），现在是修订 ${revisionNo}。` +
    `要再改这张图时 diagram 写 ${id}、base_revision 写 ${revisionNo}。` +
    (drawn.length ? `图里画了 ${drawn.length} 个条目：${drawn.join("、")}。` : "");
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
    text: savedText(id, one.op, one.name, one.kind, revisionNo, one.drawn),
    details: { task_id: one.taskId, diagram_id: id, revision_no: revisionNo, op: one.op, name: one.name, kind: one.kind, event_seq: seq, saved: true, drawn: one.drawn },
  };
}

function inDatabase<T>(call: CallContext, body: (db: DatabaseSync) => T): T {
  try {
    return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, body);
  } catch (error) {
    if (error instanceof NoDatabaseYet) {
      throw notInputProblem(new Error("这个任务目录里还没有任务记录，所以没有地方保存图，什么都没有写入。请把这个情况如实告诉用户。"));
    }
    throw error;
  }
}

/** 保存一张图。做成返回给模型的文字与结构化结果；不通过抛 ToolRejection（参数、来源、校验不过）或普通异常（校验没有做成、库的问题）。 */
export async function saveDiagram(call: CallContext, params: SaveDiagramParams, options: SaveDiagramOptions): Promise<ToolOutcome> {
  const first = inDatabase(call, (db) => savedBefore(db, call) ?? plan(db, call, params));
  if ("text" in first) return first;
  if (first.validate) {
    // 这一轮已经连续到了上限：不再校验，直接拒绝，直到用户再说话。
    if ((options.priorFailures ?? 0) >= VALIDATION_LIMIT) throw new ToolRejection(OVER_LIMIT_TEXT, "图已经连续几次没有通过校验，这一次没有再校验", GIVE_UP_TEXT);
    options.onTask?.(first.taskId);
    const check = await options.validate(first.kind, first.mermaid);
    if (!check.ok && check.reason === "unavailable") {
      throw notInputProblem(new Error(`${UNAVAILABLE_TEXT}${check.message}${TELL_USER_TEXT}`));
    }
    if (!check.ok) {
      const last = (options.priorFailures ?? 0) + 1 >= VALIDATION_LIMIT;
      throw new ToolRejection(`${VALIDATION_FAILED_TEXT}${check.message}${last ? `\n${GIVE_UP_TEXT}` : "\n照上面说的改了再保存。"}`,
        `Mermaid 文本没有通过校验：${check.message}`, last ? GIVE_UP_TEXT : "照校验说的改了再保存");
    }
  }
  // 校验是在事务之外等的，这中间库可能变了：重新核对一遍再写。
  return inDatabase(call, (db) => savedBefore(db, call) ?? write(db, call, plan(db, call, params)));
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
