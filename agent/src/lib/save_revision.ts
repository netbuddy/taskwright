/**
 * 「保存修订」的核心逻辑：执行者交来一批按条目的操作（新增、修改、删除），它们一起形成整份交付物的
 * 一次新修订。
 *
 * 这里的核对全部是事实与形式核对：集合与字段是否存在、值的类型是否对得上、必填字段是否为空、
 * 来源三项是否齐全、来源所支持的字段是否存在、被改被删的条目是否存在、改前修订号是否还是这个条目当前所在的修订。
 *
 * 条目没有单独的版本号：条目在某一时刻的内容由「条目编号加修订号」标识，条目改动过的那些修订号天然不连续
 * （UC-001 在修订 4、修订 9 改过）。条目「当前所在的修订」指它最近一次被新增、修改或恢复的那次修订。
 * 代码不判断内容好坏，没有任何关键词清单；用例写得好不好、EARS 句式对不对，由评审者对照规矩文档判断。
 *
 * 种类为「用户的话」的来源，出处由本函数代填：在调用方交来的当前会话分支的用户消息里，从最近往前找
 * 逐字包含这段摘录的那一条，填「会话编号#会话条目编号」；找不到就拒绝。模型看不到会话条目编号，
 * 所以不让它填；这一步同时是一条逐字核对。
 *
 * 种类为「用户的话」的来源可以另带 normalized_value：写进字段的值与原话不同时（原话「应该是三十天吧」，写入「30 天」），
 * 写入的值记在这里，存进来源表的同名列。工具只核对摘录逐字，不核对改写是否合理。
 *
 * 对话理解：调用方给了 intentEntry（这一轮是由哪句用户的话引出的）时，从对话行为表里取与这次操作的条目相同的那项用户行为，
 * 编号写进修订表的 intent_act_id 与事件内容（取法见 lib/dialogue_acts.ts 的 revisionIntent）。
 *
 * 种类为「文档原文」的来源（执行者交来的），摘录必须逐字是出处所指材料文件里连续的一段（换行按 \n 归一后比），
 * 否则界面上点来源找不到原文；跳句拼接、改字、出处不是文件的，都拒绝。用户在界面上撤销时交回的旧来源不再核对。
 * 出处是 Word 材料（.docx）时要写段落号（inputs/x.docx#p37），摘录对着它的投影 x.docx.md（0.2 的任务里是 x.docx.txt）里那一段核对，规则见 lib/docx_source.ts。
 *
 * 出处以 knowledge/ 开头的「文档原文」来源指向知识库里的文档（knowledge/<知识库编号>/<文档名>，Word 文档加段落号），
 * 到知识库根目录下那个知识库的 files/ 里读文件，摘录照材料的规矩逐字核对。只能引用这个任务选用的知识库里的文档；
 * 没有知识库、知识库没有选用或已经不在、文档找不到的，新写的来源拒绝，旧来源原样再交的照收（见下面「保留下来的旧来源」一段）。
 * 其余出处解析之后必须落在任务目录里：任务目录之外的绝对路径、用 .. 绕出去的相对路径都按读不到处理。
 *
 * 写库、记事件、各项核对同在一个立即事务里；任何一个操作不通过，整次调用全部不写入，
 * 拒绝的文字逐条列出哪个操作的哪一处不对。本模块不依赖 pi。
 *
 * 修改时原来的来源宁可多留（lib/source_carry.ts）：执行者改了字段，原来的来源按内容跟着走——没改的内容上的一律保留，列表插入、
 * 删除别的项、调换先后之后序号改指原来那一项，删掉的项上的去掉，改写了的内容上的照旧留着并在结果末尾提醒它检查；这次给的来源
 * 接在后面，与原来同一句摘录的合成一条。执行者要去掉某条来源，用只给 sources、不改字段的修改整体重新标注，结果里写明去掉了哪几条。
 * 保留下来的旧来源不再核对摘录。执行者把旧来源原样再交一次（例如整体重新标注）时照常核对，只有一种例外：出处指向知识库里的文档、
 * 而这份文档现在读不到（文档从知识库删了、知识库不再选用或已经不在），就不核对、原样收下——来源是过去引用时的记录，文档没了不等于
 * 引用错了。材料出处没有这个例外：进入了对话的材料不能删除，被引用过的材料文件一定还在，读不到就与新写的来源一样拒绝。
 * 新写的来源指向读不到的文件一律拒绝。
 * 用户在界面上的操作照旧：交来的来源整体替换（可以是空列表：用户改写之后条目可以没有来源），不交就全部沿用。
 *
 * 「用户直接修改」是早期版本在用户直接改字段时写下的来源，现在不再写。旧修订里的这种记录原样留在库里，但修改时一律不沿用，
 * 当作不存在：不算进「改完之后至少一条来源」，提醒与「去掉了哪几条」里也不提它；用户撤销时交回的旧来源照原样恢复。
 *
 * 问题条目的状态：执行者把它改为「已解决」或「用户决定保留」之前，用户要在「这个问题是否已解决」的卡片上点过对应的那一项，
 * 而且点了之后这个问题条目与它牵涉的条目没有再改过；新增问题条目时状态不能直接写成这两种。规则在 lib/problem_consent.ts，
 * 点击由调用方从会话分支读好交进来（CallContext.problemClicks）。用户在界面上的操作不受这条限制。
 *
 * 按调用编号判重（幂等）：同一次工具调用被重放（模型重试、pi 重发）时，库里已有这个调用编号形成的修订，
 * 就不再核对也不再写入，原样交回第一次的结果并注明「之前已经保存过」（savedBefore）；修订表上另有唯一索引兜底（schema.ts）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ACTOR_EXECUTOR, ACTOR_USER, EVENT_REVISION_SAVED, databasePath, dump, emit, load, wallClockText } from "./db.ts";
import {
  type CollectionDef,
  type FieldDef,
  FIELD_ENUM,
  FIELD_ITEM_REF,
  FIELD_TEXT,
  FIELD_TEXT_LIST,
  PROBLEM_BLOCKING_FIELD,
  PROBLEM_EDITABLE_FIELDS,
  PROBLEM_LANDED_FIELD,
  PROBLEM_NOT_BLOCKING,
  PROBLEM_REVISIT_FIELD,
  type TaskDefinition,
  keepPendingField,
  validateDefinition,
} from "./definition.ts";
import { type CallContext, type ToolOutcome, type UserMessage, activeTasks } from "./create_task.ts";
import {
  DOCX_LOCATOR, PROJECTION_SUFFIXES, SPAN_LIMIT, inTextBox, isLegacyProjection, paragraphsWith, placeExcerpt, projectionParagraphs, projectionTablePositions,
} from "./docx_source.ts";
import { DIAGRAM_ID, type DiagramRecord, latestVersion as latestDiagramVersion, readDiagrams } from "./diagram.ts";
import { parsePdfLocator } from "./pdf_locations.ts";
import { PDF_SPAN_LIMIT, pdfProjectionUnits, pdfUnitIndex, pdfUnitsWith, placePdfExcerpt } from "./pdf_source.ts";
import { BUSY_TIMEOUT_MS, EXECUTOR_SOURCE_KINDS, NoDatabaseYet, SOURCE_DOCUMENT, ELEMENT_ITEM, SOURCE_FIGURE, SOURCE_ITEM, SOURCE_SUPPLEMENT, SOURCE_KINDS, SOURCE_USER_EDIT, SOURCE_USER_WORDS, withTaskDatabase } from "./schema.ts";
import { clickEventSeq, revisionIntent } from "./dialogue_acts.ts";
import { type RewrittenSupport, carrySources, mergeGiven, sameQuote } from "./source_carry.ts";
import { libraryNames, selectedLibraryIds } from "./knowledge.ts";
import { isKnowledgeLocator, parseKnowledgeLocator } from "./knowledge_locator.ts";
import { OVERALL_COLLECTION, OVERALL_FIELDS, gateFact, hasOverall, isDeprecated, pageProblems, seeAlsoOf } from "./overall_analysis.ts";
import { overallState } from "./overall_read.ts";
import { type Position, itemRefusal, pageRefusal } from "./stage.ts";
import { stageOf } from "./stage_read.ts";
import { CONSENT_OPTION, type ProblemFacts, RESOLVED_STATUS, judgeProblemStatus, newProblemStatus } from "./problem_consent.ts";
import { codeOf, fillText, refusalText, textPrefix } from "./texts.ts";
import { ToolRejection, notInputProblem } from "./tool_rejection.ts";

/** 一条来源所支持的一处：某个字段，列表型字段还可以指到其中一项（从 0 起）。 */
export interface Support {
  field: string;
  index?: number;
}

/** 一条来源：种类、出处、摘录，以及它支持哪几处。supports 为空列表表示支持整个条目。 */
export interface Source {
  kind: string;
  locator: string;
  excerpt: string;
  supports: Support[];
  /** 只有种类为「用户的话」时可能有：写入字段的值与原话不同时，写入的值。 */
  normalized_value?: string;
  /**
   * 只有种类为「条目」（或「图」）时有：引用那一刻对方的修订号。THIS_REVISION 表示对方在这一次保存里才新增或修改，
   * 写库时换成这一次的修订号。沿用下来的来源保留原来的号；助手重新写上同一条来源时换成最新的号。
   */
  depends_revision?: number | typeof THIS_REVISION | null;
}

/** 来源依据的条目在这一次保存里才新增或修改：它的修订号就是这一次的。 */
export const THIS_REVISION = "this" as const;

/** 「用户的话」的出处写法：会话编号与会话条目编号之间用 # 隔开。读取一侧按同一写法拆开。 */
export function userWordsLocator(sessionId: string, entryId: string): string {
  return `${sessionId}#${entryId}`;
}

/** 模型交来的一个操作。三种操作共用一个形状，按 op 区分，各自只看自己用得到的键。 */
export interface Operation {
  op?: unknown;
  collection?: unknown;
  item?: unknown;
  fields?: unknown;
  sources?: unknown;
  base_revision?: unknown;
}

type Fields = Record<string, unknown>;

interface ItemRow {
  item_id: string;
  collection: string;
  serial: number;
  deleted_in_revision: number | null;
}

interface VersionRow {
  revision_no: number;
  fields: string;
  actor: string;
}

interface SourceRow {
  position: number;
  kind: string;
  locator: string;
  excerpt: string;
  field: string | null;
  field_index: number | null;
  normalized_value: string | null;
  depends_revision?: number | null;
}

/** 发起方写成中文。拒绝原因的事实一层也给人看，所以执行者写作「助手」。 */
function actorText(actor: string): string {
  if (actor === ACTOR_USER) return fillText("part.actor_user");
  if (actor === ACTOR_EXECUTOR) return fillText("part.actor_executor");
  return `「${actor}」`;
}

/** 核对通过之后，一个操作要写进库里的样子。 */
type Planned =
  | { op: "add"; collection: CollectionDef; fields: Fields; sources: Source[]; notes: string[] }
  | { op: "update"; itemId: string; collection: string; fromRevision: number; fields: Fields; sources: Source[]; notes: string[] }
  | { op: "delete"; itemId: string; collection: string; fromRevision: number }
  | { op: "restore"; itemId: string; collection: string; fromRevision: number; fields: Fields; sources: Source[]; notes: string[] };

const OP_NAMES: Record<string, string> = {
  get add() { return fillText("part.op_add"); }, get update() { return fillText("part.op_update"); },
  get delete() { return fillText("part.op_delete"); }, get restore() { return fillText("part.op_restore"); },
};

/**
 * 拒绝原因分两层：事实（改了什么、为什么不行，一句话，面向人）与指引（接下来该怎么做，只给助手）。
 * 核对函数往 errors 里推的一条文字用 problem（或 problemText）把拒绝语的键与两层编在一起，组装时再拆开（splitGuide）。
 * 给模型的正文每个操作两行：「- 操作 N（……）：事实」与「  怎么办：指引」；后端的过程摘要只取事实（backend/src/work_summary.ts）。
 */
export interface RejectReason {
  label: string;
  fact: string;
  guidance: string;
  /** 这个操作的几条原因各自的拒绝语键（agent/prompts/runtime/ 下 rejections_*.md），按出现的先后；原因码是键的前两段。 */
  keys: string[];
}
const GUIDE = "\u0000";
const KEY = "\u0001";
/** 指引那一行的开头（「怎么办：」）。后端的过程摘要按它认出指引（backend/src/work_summary.ts）。 */
export const GUIDANCE_PREFIX = textPrefix("part.save_guidance");
/** 一条带拒绝语键的错误：键、事实与指引编进一段文字（errors 列表里的一项），组装时再拆开（splitGuide）。key 是完整的键（可以带变体）。 */
export function problemText(refusal: { key: string; fact: string; guidance: string }): string {
  return `${refusal.key}${KEY}${refusal.fact}${GUIDE}${refusal.guidance}`;
}
/** 取好的拒绝语编成一条错误（键写在调用处的 refusalText 里，守护测试才扫得到）。 */
export const problem = (refusal: RefusalText): string => problemText(refusal);
/** 一个操作的若干条错误拼成一条原因：事实用「；」接起来，指引也是。subject 是事实里没点到条目时补在前面的主语。 */
function reasonOf(label: string, subject: string, errors: string[]): RejectReason {
  const facts: string[] = [];
  const guides: string[] = [];
  const keys: string[] = [];
  for (const one of errors) {
    const { key, fact, guidance } = splitGuide(one);
    facts.push(fact);
    if (guidance) guides.push(guidance);
    if (key) keys.push(key);
  }
  const fact = facts.join("；");
  return { label, fact: fact.includes(subject) ? fact : fillText("part.subject_join", { subject, fact }), guidance: guides.join("；"), keys };
}
/** 一个操作只有一条原因时的样子。 */
const single = (label: string, one: RefusalText): RejectReason => ({ label, fact: one.fact, guidance: one.guidance, keys: [one.key] });
/** 拒绝的正文：给模型看，两层都在。 */
export function rejectionText(reasons: RejectReason[]): string {
  return `${fillText("part.save_head", { count: reasons.length })}\n` +
    reasons.map((r) => `- ${r.label}：${r.fact}。${r.guidance ? `\n  ${fillText("part.save_guidance", { guidance: r.guidance })}` : ""}`).join("\n") +
    `\n${fillText("part.save_tail")}`;
}
/**
 * 保存修订被拒时抛的错：正文是 rejectionText，reasons 带结构化的两层。
 * fact 与 guidance 是逐个操作的两层文字各接成一段（一个操作一行），供拒绝留痕（lib/tool_rejection.ts）分开存。
 */
export class SaveRejected extends Error {
  reasons: RejectReason[];
  fact: string;
  guidance: string;
  /** 全部原因的拒绝语键与原因码（键的前两段），按操作与出现的先后。 */
  keys: string[];
  codes: string[];
  constructor(reasons: RejectReason[]) {
    super(rejectionText(reasons));
    this.reasons = reasons;
    this.keys = reasons.flatMap((r) => r.keys);
    this.codes = this.keys.map(codeOf);
    this.fact = reasons.map((r) => `${r.label}：${r.fact}`).join("\n");
    this.guidance = reasons.filter((r) => r.guidance).map((r) => `${r.label}：${r.guidance}`).join("\n");
  }
}

/**
 * 「保存修订」的参数。operations 是模型或扩展命令交来的操作列表；undo_of_revision 只由用户在界面上的
 * 「撤销」经扩展命令填，写进事件内容，说明这次修订是在撤销哪次修订。
 * 操作种类 restore（把删掉的条目恢复成删除前的样子）同样只给撤销用：发起方不是用户时拒绝。
 */
export interface SaveRevisionParams {
  operations?: unknown;
  undo_of_revision?: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 一个字段值算不算空：空白文字、空列表、全是空白文字的列表都算空。 */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.every((one) => typeof one === "string" && one.trim() === "");
  return false;
}

/** 把一组字段里值为空的去掉。可选字段写空值就等于不填，库里不留一个空键。 */
function dropEmpty(fields: Fields): Fields {
  const kept: Fields = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!isEmptyValue(value)) kept[name] = value;
  }
  return kept;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 执行一次「保存修订」。拒绝一律用抛异常的方式，抛出的文字原样交给模型。
 * afterWrite 只给界面直接操作用：修订写好之后、事务提交之前在同一个事务里调用它，用来随修订一起写确认标记；
 * 它抛异常时整次保存连同修订一起回滚。工具调用不传它。
 */
export function saveRevision(
  call: CallContext,
  params: SaveRevisionParams,
  afterWrite?: (db: DatabaseSync, outcome: ToolOutcome) => void,
): ToolOutcome {
  try {
    return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => {
      const outcome = save(db, call, params);
      afterWrite?.(db, outcome);
      return outcome;
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) throw notInputProblem(new Error(fillText("save_revision.no_database")));
    throw error;
  }
}

function save(db: DatabaseSync, call: CallContext, params: SaveRevisionParams): ToolOutcome {
  // 同一次工具调用重放（模型重试、pi 重发）：第一次已经形成了修订，就原样交回第一次的结果，不再写一遍。
  // 放在一切核对之前：任务在两次之间结束了、条目又被改过，都不影响「这次调用已经保存过」这件事。
  // 用户在界面上的操作不走这里：操作编号由后端每次新生成，不会重放。调用编号为空文字（模型服务没给编号）时无从判重。
  if (call.actor !== ACTOR_USER && call.callId !== "") {
    const replay = savedBefore(db, call.callId);
    if (replay) return replay;
  }
  const running = activeTasks(db);
  if (running.length === 0) throw notInputProblem(new Error(fillText("save_revision.no_task")));
  if (running.length > 1) {
    throw notInputProblem(new Error(fillText("save_revision.several_tasks", { count: running.length, ids: running.map((one) => one.task_id).join("、") })));
  }
  const taskId = running[0].task_id;
  const definition = validateDefinition(JSON.parse(running[0].definition_text));

  const operations = params.operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    const text = fillText("save_revision.operations_empty");
    throw new ToolRejection(text, text, "", ["save_revision.operations_empty"]);
  }

  const items = itemsOf(db, taskId);
  const latestVersion = latestVersionOf(db, taskId);
  const sourcesOf = (itemId: string, revisionNo: number): Source[] => {
    const rows = db
      .prepare(
        "SELECT position, kind, locator, excerpt, field, field_index, normalized_value, depends_revision FROM item_source " +
          "WHERE task_id = ? AND item_id = ? AND revision_no = ? AND element_kind = ? ORDER BY position, support_no",
      )
      .all(taskId, itemId, revisionNo, ELEMENT_ITEM) as unknown as SourceRow[];
    const byPosition = new Map<number, Source>();
    for (const row of rows) {
      let source = byPosition.get(row.position);
      if (!source) {
        source = { kind: row.kind, locator: row.locator, excerpt: row.excerpt, supports: [] };
        if (row.normalized_value !== null) source.normalized_value = row.normalized_value;
        if (row.depends_revision !== null && row.depends_revision !== undefined) source.depends_revision = row.depends_revision;
        byPosition.set(row.position, source);
      }
      if (row.field !== null) {
        source.supports.push(row.field_index === null ? { field: row.field } : { field: row.field, index: row.field_index });
      }
    }
    return [...byPosition.values()];
  };
  const userMessages = call.userMessages ?? [];
  const materialText = materialReader(call.workspaceDir, definition.materialsDir, call.knowledgeRoot ?? null);

  // 这次调用里要删掉的条目，以及被修改或删除过的条目。先扫一遍，
  // 好让「条目引用」的核对知道哪些条目在这次调用之后就不在了。
  const deletedHere = new Set<string>();
  // 这一批里被修改、删除的条目：问题条目改状态时，同一批里又改了它牵涉的条目，算用户点头之后改过。
  const changedHere = new Set<string>();
  for (const one of operations) {
    if (isObject(one) && one.op === "delete" && typeof one.item === "string") deletedHere.add(one.item);
    if (isObject(one) && one.op !== "add" && typeof one.item === "string") changedHere.add(one.item);
  }
  const problemFacts: ProblemFacts = {
    clicks: call.problemClicks ?? [],
    clickSeq: (userEntryId) => clickEventSeq(db, taskId, call.sessionId, userEntryId),
    changedAfter: (itemId, seq) => {
      const version = db.prepare("SELECT MAX(revision_no) AS n FROM item_version WHERE task_id = ? AND item_id = ? AND event_seq > ?")
        .get(taskId, itemId, seq) as { n: number | null };
      if (version.n !== null) return fillText("part.changed_to", { revision: version.n });
      const row = items.get(itemId);
      return row && row.deleted_in_revision !== null && deletedAfter(db, taskId, itemId, seq) ? fillText("part.deleted_at", { revision: row.deleted_in_revision }) : null;
    },
  };
  const touched = new Map<string, number>();
  // 这一批里新增的条目会拿到的编号：与 write 里分配编号的规矩相同（集合历史上的最大流水号加一，按操作顺序依次取）。
  // 排在前面的新增操作产生的条目，后面的操作可以引用；引用排在后面才新增的条目仍拒绝。
  const addedAt = new Map<string, number>();
  // 这一批里已经通过核对的新增与修改将要保存的内容：后面的操作把它们当作依据时，摘录对着这里核对，修订号是这一次的。
  const written = new Map<string, { collection: string; fields: Record<string, unknown> }>();
  const diagrams = readDiagrams(db, taskId);
  const itemSources = (number: number, self: string | null) => itemSourceLookups(definition, items, latestVersion, { deletedHere, addedAt, written }, number, self, diagrams);
  // 这一批里新增的条目各在哪个集合里（条目引用字段「只许本集合」的核对要查）。
  const addedIn = new Map<string, string>();
  const refs: RefLookups = {
    collectionOf: (itemId) => items.get(itemId)?.collection ?? addedIn.get(itemId) ?? null,
    fieldsOf: (itemId) => written.get(itemId)?.fields ?? (items.has(itemId) ? (JSON.parse(latestVersion(itemId).fields) as Record<string, unknown>) : null),
  };
  /**
   * 一章至多一页在用的导语页：业务说明的一页写了「导语所属章」、又没有废弃时，看别的在用页有没有已经写了同一章的
   * （库里现有的取它现在的内容，这一批里前面的操作写过的取写过之后的）。有就记一条原因。self 是这一页自己的编号，新增时为 null。
   */
  const introOwners = (chapter: unknown, self: string | null): string[] => {
    const ids = new Set<string>([...items.keys(), ...written.keys()]);
    return [...ids].filter((id) => {
      if (id === self || deletedHere.has(id)) return false;
      const row = items.get(id);
      if (row ? row.collection !== OVERALL_COLLECTION || row.deleted_in_revision !== null : written.get(id)!.collection !== OVERALL_COLLECTION) return false;
      const fields = refs.fieldsOf(id);
      return !!fields && fields[OVERALL_FIELDS.intro] === chapter && !isDeprecated(fields);
    });
  };
  {
    const serialOf = new Map<string, number>();
    for (const row of items.values()) {
      if (row.serial > (serialOf.get(row.collection) ?? 0)) serialOf.set(row.collection, row.serial);
    }
    operations.forEach((one, index) => {
      if (!isObject(one) || one.op !== "add") return;
      const collection = definition.collections.find((c) => c.name === one.collection);
      if (!collection) return;
      const serial = (serialOf.get(collection.name) ?? 0) + 1;
      serialOf.set(collection.name, serial);
      addedAt.set(`${collection.prefix}-${String(serial).padStart(3, "0")}`, index + 1);
      addedIn.set(`${collection.prefix}-${String(serial).padStart(3, "0")}`, collection.name);
    });
  }

  // 最低门（任务定义里有业务说明集合时才设）：助手往业务说明与问题集合之外的集合里新增条目之前，任务里要已经有一页
  // 在用的主题贴了标签、有例子、用户又看过。只看这次保存之前库里已有的页：同一批里才新增的页用户还没有看过。
  const gate = call.actor !== ACTOR_USER && hasOverall(definition.collections) ? gateFact(overallState(db, taskId, definition).pages) : null;
  // 工作的阶段（任务有业务说明集合时才有，lib/stage.ts）：助手这一刻能写什么看这次调用所在的会话的阶段，取的是这条会话正在做的工作项（会话空闲时按澄清的规矩拦）。
  // 用户在界面上的操作不看阶段。早先建的任务没有阶段，stage 是 null，下面几处都不拦。
  const stage: Position | null = call.actor !== ACTOR_USER ? stageOf(db, call.workspaceDir, taskId, definition, call.sessionId) : null;
  /** 这个阶段助手能不能对这个集合的条目做这种操作；不能时返回两层拒绝文字。changed 是修改业务说明的页时改动了的字段名。 */
  const stageRefusal = (collection: CollectionDef, kind: "add" | "update" | "delete", changed: readonly string[] = []) => {
    if (stage === null) return null;
    if (collection.name === OVERALL_COLLECTION) return pageRefusal(stage, kind, changed);
    return keepPendingField(collection) === null ? itemRefusal(stage, kind, collection.name) : null;
  };

  const problems: RejectReason[] = [];
  const planned: Planned[] = [];

  operations.forEach((raw, index) => {
    const number = index + 1;
    const errors: string[] = [];
    /** 业务说明的一页写了「导语所属章」时，核对这一章还没有别的在用的导语页。 */
    const checkIntroPage = (fields: Fields, self: string | null): void => {
      const chapter = fields[OVERALL_FIELDS.intro];
      if (isEmptyValue(chapter) || isDeprecated(fields)) return;
      const owners = introOwners(chapter, self);
      if (owners.length === 0) return;
      errors.push(problem(refusalText("save_revision.overall_intro_duplicate", { chapter: String(chapter), owners: owners.join("、") })));
    };
    const plain = fillText("part.op_label", { no: number });
    if (!isObject(raw)) {
      problems.push(single(plain, refusalText("save_revision.op_not_object", { no: number })));
      return;
    }
    const op = raw.op;
    if (op === "restore" && call.actor !== ACTOR_USER) {
      problems.push(single(plain, refusalText("save_revision.restore_by_assistant")));
      return;
    }
    if (op !== "add" && op !== "update" && op !== "delete" && op !== "restore") {
      problems.push(single(plain, refusalText("save_revision.op_kind_invalid", { no: number, given: String(JSON.stringify(op)) })));
      return;
    }
    /** 条目引用里的一个编号能不能用：能用返回 null，不能用返回一条带键的错误（事实层是接在 part.field_ref 后面的那半句）。 */
    const checkRef = (itemId: unknown): string | null => {
      if (typeof itemId !== "string" || itemId.trim() === "") return problem(refusalText("save_revision.field_ref_target_missing.not_id"));
      const row = items.get(itemId);
      if (!row) {
        const at = addedAt.get(itemId);
        if (at === undefined) return problem(refusalText("save_revision.field_ref_target_missing"));
        if (at < number) return null;
        return at === number ? problem(refusalText("save_revision.field_ref_self.batch")) : problem(refusalText("save_revision.field_ref_target_order", { item: itemId, at }));
      }
      if (row.deleted_in_revision !== null) return problem(refusalText("save_revision.field_ref_target_deleted", { revision: row.deleted_in_revision }));
      if (deletedHere.has(itemId)) return problem(refusalText("save_revision.field_ref_target_deleted.here"));
      return null;
    };

    if (op === "add") {
      const collection = definition.collections.find((one) => one.name === raw.collection);
      const label = fillText("part.op_label_add", { no: number, collection: String(raw.collection) });
      if (!collection) {
        problems.push(single(label, refusalText("save_revision.collection_unknown", {
          collection: String(raw.collection), collections: definition.collections.map((one) => `「${one.name}」`).join("、"),
        })));
        return;
      }
      const staged = stageRefusal(collection, "add");
      if (staged) errors.push(problemText(staged));
      if (gate !== null && collection.name !== OVERALL_COLLECTION && keepPendingField(collection) === null) errors.push(problemText(gate));
      if (raw.item !== undefined) errors.push(problem(refusalText("save_revision.add_item_given")));
      if (!isObject(raw.fields)) {
        errors.push(problem(refusalText("save_revision.add_fields_not_object")));
      } else {
        checkFields(collection, raw.fields, checkRef, errors, refs, [...addedAt].find(([, at]) => at === number)?.[0] ?? null);
        const status = keepPendingField(collection);
        const refusal = status && call.actor !== ACTOR_USER
          ? newProblemStatus(raw.fields[status.name], (status.values ?? []).find((value) => !Object.hasOwn(CONSENT_OPTION, value)) ?? null) : null;
        if (refusal) errors.push(problemText(refusal));
        if (call.actor !== ACTOR_USER) checkProblemContent(collection, raw.fields, true, undefined, errors);
        if (collection.name === OVERALL_COLLECTION) checkIntroPage(raw.fields, null);
        for (const field of collection.fields) {
          if (field.required && isEmptyValue(raw.fields[field.name])) {
            errors.push(problem(refusalText("save_revision.required_field_empty", { field: field.name })));
          }
        }
      }
      if (raw.base_revision !== undefined) errors.push(problem(refusalText("save_revision.add_base_revision_given")));
      const notes: string[] = [];
      const sources = checkSources(raw.sources, true, errors, call.sessionId, userMessages, call.actor, materialText, itemSources(number, null), undefined, [], false,
        relocatedNote(number, notes));
      const fields = isObject(raw.fields) ? dropEmpty(raw.fields) : {};
      if (sources) checkSupports(collection, fields, sources, false, errors);
      if (sources && collection.name === OVERALL_COLLECTION && call.actor !== ACTOR_USER) {
        for (const one of pageProblems(fields, sources)) errors.push(problemText(one));
      }
      if (sources && call.actor !== ACTOR_USER && keepPendingField(collection) === null) {
        for (const one of quotedProblems(fields, sources)) errors.push(problemText(one));
      }
      if (errors.length > 0) {
        problems.push(reasonOf(label, fillText("part.subject_add", { collection: collection.name }), errors));
        return;
      }
      planned.push({ op: "add", collection, fields, sources: sources!, notes });
      const newId = [...addedAt].find(([, at]) => at === number)?.[0];
      if (newId) written.set(newId, { collection: collection.name, fields });
      return;
    }

    // 修改与删除：条目必须存在且没有被删除。
    const itemId = raw.item;
    const label = fillText("part.op_label_item", { no: number, op: OP_NAMES[op], item: String(itemId) });
    if (typeof itemId !== "string" || itemId.trim() === "") {
      problems.push(single(label, refusalText("save_revision.item_id_missing", { op: OP_NAMES[op] })));
      return;
    }
    const row = items.get(itemId);
    if (!row) {
      const alive = [...items.values()].filter((one) => one.deleted_in_revision === null).map((one) => one.item_id);
      problems.push(single(label, refusalText("save_revision.item_not_found", { item: itemId, alive: alive.length ? alive.join("、") : fillText("part.no_items") })));
      return;
    }
    if (op === "restore" && row.deleted_in_revision === null) {
      problems.push(single(label, refusalText("save_revision.restore_not_deleted", { item: itemId })));
      return;
    }
    if (op !== "restore" && row.deleted_in_revision !== null) {
      problems.push(single(label, refusalText("save_revision.item_already_deleted", { op: OP_NAMES[op], item: itemId, revision: row.deleted_in_revision })));
      return;
    }
    if (touched.has(itemId)) {
      problems.push(single(label, refusalText("save_revision.item_duplicate_in_batch", { item: itemId, at: touched.get(itemId)! })));
      return;
    }
    touched.set(itemId, number);
    const current = latestVersion(itemId);

    // 改前修订号：模型必须写出它所见的这个条目所在的修订号，与库里的不符就拒绝，免得按旧内容盖掉别人的修改。
    const base = raw.base_revision;
    if (base === undefined || base === null) {
      problems.push(single(label, refusalText("save_revision.base_revision_missing", { op: OP_NAMES[op], item: itemId })));
      return;
    }
    if (typeof base !== "number" || !Number.isInteger(base) || base < 1) {
      problems.push(single(label, refusalText("save_revision.base_revision_invalid", { op: OP_NAMES[op], item: itemId, given: String(JSON.stringify(base)) })));
      return;
    }
    if (base !== current.revision_no) {
      problems.push(base < current.revision_no
        ? single(label, refusalText("save_revision.base_revision_stale.older", { item: itemId, actor: actorText(current.actor), now: current.revision_no, seen: base, fields: current.fields }))
        : single(label, refusalText("save_revision.base_revision_stale", { item: itemId, now: current.revision_no, seen: base, fields: current.fields })));
      return;
    }

    const collection = definition.collections.find((one) => one.name === row.collection)!;
    if (op === "delete") {
      const staged = stageRefusal(collection, "delete");
      if (staged) {
        problems.push({ label, fact: staged.fact, guidance: staged.guidance, keys: [staged.key] });
        return;
      }
      planned.push({ op: "delete", itemId, collection: row.collection, fromRevision: current.revision_no });
      return;
    }

    const before = load(current.fields) as Fields;
    let merged: Fields = before;
    if (raw.fields !== undefined && !isObject(raw.fields)) {
      errors.push(problem(refusalText("save_revision.update_fields_not_object")));
    } else if (isObject(raw.fields)) {
      checkFields(collection, raw.fields, checkRef, errors, refs, itemId);
      if (call.actor !== ACTOR_USER) {
        checkProblemUpdate(collection, itemId, before, raw.fields, errors);
        checkProblemStatus(collection, itemId, before, raw.fields, changedHere, problemFacts, errors);
      }
      merged = dropEmpty({ ...before, ...raw.fields });
      if (call.actor !== ACTOR_USER) {
        checkProblemContent(collection, merged, PROBLEM_BLOCKING_FIELD in raw.fields || PROBLEM_REVISIT_FIELD in raw.fields, before[keepPendingField(collection)?.name ?? ""], errors);
      }
      if (collection.name === OVERALL_COLLECTION) checkIntroPage(merged, itemId);
      for (const field of collection.fields) {
        if (field.required && field.name in raw.fields && isEmptyValue(raw.fields[field.name])) {
          errors.push(problem(refusalText("save_revision.required_field_cleared", { field: field.name })));
        }
      }
    }
    if (op === "update") {
      // 这个阶段能不能改它：别的集合的条目要到写条目阶段；评审确认阶段业务说明的页只能改状态与改看，所以要看这次改动了哪几个字段。
      const changed = [...new Set([...Object.keys(before), ...Object.keys(merged)])].filter((name) => !sameJson(before[name], merged[name]));
      const staged = stageRefusal(collection, "update", changed);
      if (staged) errors.push(problemText(staged));
    }
    // 旧的「用户直接修改」当作不存在（见文件开头）。用户的操作（直接修改、撤销）都交来完整的来源，不经这里沿用，撤销照原样恢复。
    const previousSources = sourcesOf(itemId, current.revision_no).filter((one) => one.kind !== SOURCE_USER_EDIT);
    const inherited = raw.sources === undefined;
    const notes: string[] = [];
    const given = inherited ? null
      : checkSources(raw.sources, true, errors, call.sessionId, userMessages, call.actor, materialText, itemSources(number, itemId), undefined, previousSources, false,
        relocatedNote(number, notes));
    let sources = inherited ? previousSources : given;
    const editsFields = isObject(raw.fields) && Object.keys(raw.fields).length > 0;
    if (call.actor !== ACTOR_USER && editsFields && (inherited || given)) {
      // 执行者修改字段：原来的来源按内容跟着走（lib/source_carry.ts），没改的内容来源一律保留，删掉的项上的去掉，
      // 改写了的内容上的照旧留着并在结果里提醒；这次给了来源就接在后面，与原来同一句摘录的合成一条。
      const carried = carrySources(previousSources, before, merged, listFieldsOf(collection));
      const { sources: joined, restated } = mergeGiven(carried.kept, given ?? []);
      sources = joined;
      const left = carried.rewritten.filter((one) => !restated.has(one.source));
      if (left.length) notes.push(rewrittenNote(itemId, left));
      if (sources.length === 0) {
        errors.push(problem(refusalText("save_revision.update_sources_missing", { item: itemId })));
      }
    } else if (call.actor !== ACTOR_USER && given && !editsFields) {
      // 只给 sources、不改字段：整体重新标注，这是执行者去掉某条来源的写法；去掉了哪几条写进结果。
      const removed = previousSources.filter((old) => !given.some((one) => sameQuote(one, old)));
      if (removed.length) notes.push(fillText("result.save_revision.sources_relabelled", { item: itemId, count: removed.length, removed: removed.map(quoteLabel).join("、") }));
    }
    if (sources) checkSupports(collection, merged, sources, inherited, errors);
    if (sources && collection.name === OVERALL_COLLECTION && call.actor !== ACTOR_USER && op !== "restore") {
      for (const one of pageProblems(merged, sources)) errors.push(problemText(one));
    }
    // 只核对这次新给的来源；沿用下来的不重新核对。
    if (given && call.actor !== ACTOR_USER && op !== "restore" && keepPendingField(collection) === null) {
      for (const one of quotedProblems(merged, given)) errors.push(problemText(one));
    }
    if (op !== "restore" && errors.length === 0 && sameJson(merged, before) && sameJson(sources, previousSources)) {
      errors.push(problem(refusalText("save_revision.update_noop", { item: itemId, revision: current.revision_no })));
    }
    if (errors.length > 0) {
      problems.push(reasonOf(label, itemId, errors));
      return;
    }
    planned.push({
      op: op === "restore" ? "restore" : "update",
      itemId,
      collection: row.collection,
      fromRevision: current.revision_no,
      fields: merged,
      sources: sources!,
      notes,
    });
    written.set(itemId, { collection: row.collection, fields: merged });
  });

  if (problems.length > 0) throw new SaveRejected(problems);

  return write(db, call, taskId, definition, planned, params);
}

/** 任务里全部条目（含已删除的），按条目编号查。 */
function itemsOf(db: DatabaseSync, taskId: string): Map<string, ItemRow> {
  const items = new Map<string, ItemRow>();
  for (const row of db
    .prepare("SELECT item_id, collection, serial, deleted_in_revision FROM item WHERE task_id = ?")
    .all(taskId) as unknown as ItemRow[]) {
    items.set(row.item_id, row);
  }
  return items;
}

/** 查条目当前所在的修订：连同产生它的那条事件的发起方一起取，修订号对不上时好告诉模型是谁改的。 */
function latestVersionOf(db: DatabaseSync, taskId: string): (itemId: string) => VersionRow {
  const statement = db.prepare(
    "SELECT v.revision_no, v.fields, e.actor FROM item_version v JOIN event e ON e.seq = v.event_seq " +
      "WHERE v.task_id = ? AND v.item_id = ? ORDER BY v.revision_no DESC LIMIT 1",
  );
  return (itemId) => statement.get(taskId, itemId) as unknown as VersionRow;
}

/**
 * 图的来源的核对（lib/save_diagram.ts 用）：与条目的来源同一套种类与逐字核对，三处不同——图没有字段，来源不写 supports；
 * 图依据条目时可以不写摘录；被依据的条目只认已经保存的（图单独保存，没有「同一批里排在前面」这回事）。
 * previous 是这张图上一次修订的来源（修改时给），知识库文档读不到时凭它沿用同一句摘录。通过返回整理好的列表，不通过返回 null、原因进 errors。
 */
export function checkDiagramSources(
  db: DatabaseSync,
  taskId: string,
  definition: TaskDefinition,
  raw: unknown,
  call: Pick<CallContext, "workspaceDir" | "sessionId" | "userMessages" | "actor" | "knowledgeRoot">,
  errors: string[],
  previous: readonly Source[] = [],
): Source[] | null {
  const lookups = itemSourceLookups(definition, itemsOf(db, taskId), latestVersionOf(db, taskId), { deletedHere: new Set(), addedAt: new Map(), written: new Map() }, 0, null,
    readDiagrams(db, taskId));
  return checkSources(raw, true, errors, call.sessionId, call.userMessages ?? [], call.actor, materialReader(call.workspaceDir, definition.materialsDir, call.knowledgeRoot ?? null),
    lookups, undefined, previous, true);
}

/** 种类为「条目」的来源要用的三个查法，与种类为「图」的来源要用的一个查法（见 itemSourceLookups）。 */
export interface ItemSourceLookups {
  /** 出处指的条目能不能引用：能就返回 null，不能返回原因（事实层是接在出处后面的半句，有的另带指引）。 */
  ref: (locator: string) => { fact: string; guidance: string } | null;
  /** 那个条目当前内容里的各段文字（文本字段与文本列表的各项），摘录要逐字出现在其中之一里。 */
  text: (locator: string) => string[];
  /** 引用这一刻那个条目的修订号；它在这一次保存里才新增或修改时是 THIS_REVISION。 */
  revision: (locator: string) => number | typeof THIS_REVISION;
  /** 出处指的图能不能引用：不能返回原因；能就返回它现在的修订号（图自己的）与 Mermaid 文本，摘录要逐字出现在这段文本里。 */
  figure: (locator: string) => { reason: string } | { revision: number; mermaid: string };
}

/**
 * 种类为「条目」的来源要用的查法。被引用的条目可以在任何集合里，必须还在：这次调用之前就有、没有删除、也没在这次调用里删；
 * 或者是这一批里排在前面、已经通过核对的新增或修改（written 里有它，摘录对着它将要保存的内容核对，修订号就是这一次的）。
 * 一个条目不能把自己当作依据。number 是正在核对的操作是这一批的第几个，self 是它修改的条目编号（新增时没有）。
 * batch 是这一批的删除、新增与已经通过核对的内容；不是一批操作（例如「回复」核对依据）时给空的。
 *
 * 种类为「图」的来源：出处是任务里一张还在的图的编号（diagrams 是任务里的全部图，删掉的也在）。图单独保存，没有「同一批里」这回事。
 */
function itemSourceLookups(
  definition: TaskDefinition,
  items: Map<string, ItemRow>,
  latestVersion: (itemId: string) => VersionRow,
  batch: { deletedHere: Set<string>; addedAt: Map<string, number>; written: Map<string, { collection: string; fields: Record<string, unknown> }> },
  number: number,
  self: string | null,
  diagrams: readonly DiagramRecord[] = [],
): ItemSourceLookups {
  const ref = (locator: string): { fact: string; guidance: string } | null => {
    const why = (fact: string) => ({ fact, guidance: "" });
    if (self !== null && locator === self) return why(fillText("part.ref_self"));
    const row = items.get(locator);
    if (!row) {
      const at = batch.addedAt.get(locator);
      if (at === undefined) return why(fillText("part.ref_missing"));
      if (at === number) return why(fillText("part.ref_self_batch"));
      if (at > number) return why(fillText("part.ref_later", { at }));
      return batch.written.has(locator) ? null : why(fillText("part.ref_failed"));
    }
    if (row.deleted_in_revision !== null) return why(fillText("part.ref_deleted", { revision: row.deleted_in_revision }));
    if (batch.deletedHere.has(locator)) return why(fillText("part.ref_deleted_here"));
    // 业务说明里已废弃的页不能再作依据：写了改看的指给助手看。这一批里刚把它改成已废弃的也算。
    if (row.collection === OVERALL_COLLECTION) {
      const fields = batch.written.get(locator)?.fields ?? (JSON.parse(latestVersion(locator).fields) as Record<string, unknown>);
      if (isDeprecated(fields)) {
        const see = seeAlsoOf(fields);
        return { fact: fillText("part.ref_deprecated", { locator }), guidance: see ? fillText("part.ref_deprecated_guide", { see }) : fillText("part.ref_deprecated_guide_none") };
      }
    }
    return null;
  };
  const text = (locator: string): string[] => {
    const written = batch.written.get(locator);
    const collectionName = written?.collection ?? items.get(locator)?.collection;
    const collection = definition.collections.find((one) => one.name === collectionName);
    const fields = written?.fields ?? (JSON.parse(latestVersion(locator).fields) as Record<string, unknown>);
    return (collection?.fields ?? []).flatMap((field) => {
      const value = fields[field.name];
      if (field.type === FIELD_TEXT && typeof value === "string") return [value];
      if (field.type === FIELD_TEXT_LIST && Array.isArray(value)) return value.filter((one): one is string => typeof one === "string");
      return [];
    });
  };
  const revision = (locator: string) => (batch.written.has(locator) ? THIS_REVISION : latestVersion(locator).revision_no);
  const figure = (locator: string) => {
    if (!DIAGRAM_ID.test(locator)) return { reason: fillText("part.figure_not_id") };
    const record = diagrams.find((one) => one.diagram_id === locator);
    const now = record ? latestDiagramVersion(record) : null;
    if (!record || !now) return { reason: fillText("part.figure_missing") };
    if (record.deleted_in_revision !== null) return { reason: fillText("part.figure_deleted", { revision: record.deleted_in_revision }) };
    return { revision: now.revision_no, mermaid: now.mermaid };
  };
  return { ref, text, revision, figure };
}

/** 一条引用核对通过之后的样子：种类、出处（「用户的话」由工具代填）、摘录，以及「用户的话」可能带的规范化写入值。 */
export interface CheckedQuote {
  kind: string;
  locator: string;
  excerpt: string;
  normalized_value?: string;
}

/**
 * 核对执行者在「保存修订」之外交来的一串引用（现在只有「回复」给建议值时的依据 act.basis）：与保存修订的来源同一套核对，
 * 同一套拒绝文字——文档原文逐字出自材料里连续的一段（.docx 按段落号核对、可跨到其后相邻几段），
 * 用户的话逐字出自当前会话分支上的某句用户消息（出处由这里代填），条目逐字出自那个还在的条目；助手补充不核对摘录，只要求写了理由。
 * 库只读打开，查完就关。通过时返回核对后的引用（用户的话的出处已代填），不通过时把原因推进 errors 并返回 null。
 * errors 里的每一条可能带两层（事实与指引），用 splitGuide 拆开。
 */
export function checkQuotes(
  workspaceDir: string,
  sessionId: string,
  userMessages: UserMessage[],
  raw: unknown,
  errors: string[],
  whereOf: (index: number) => string,
  knowledgeRoot: string | null = null,
): CheckedQuote[] | null {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) {
    errors.push(problem(refusalText("source.no_task_record_for_check")));
    return null;
  }
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
      { task_id: string; definition_text: string } | undefined;
    if (!task) {
      errors.push(problem(refusalText("source.no_task_record_for_check")));
      return null;
    }
    const definition = validateDefinition(JSON.parse(task.definition_text));
    const items = itemsOf(db, task.task_id);
    const lookups = itemSourceLookups(definition, items, latestVersionOf(db, task.task_id), { deletedHere: new Set(), addedAt: new Map(), written: new Map() }, 0, null,
      readDiagrams(db, task.task_id));
    const checked = checkSources(raw, true, errors, sessionId, userMessages, ACTOR_EXECUTOR, materialReader(workspaceDir, definition.materialsDir, knowledgeRoot),
      lookups, whereOf);
    return checked && checked.map(({ kind, locator, excerpt, normalized_value }) => ({ kind, locator, excerpt, ...(normalized_value ? { normalized_value } : {}) }));
  } finally {
    db.close();
  }
}

/** 把核对函数推进 errors 的一条拆成拒绝语键（没有时是空的）、事实与指引两层；没有指引层时指引是空文字。 */
export function splitGuide(one: string): { key: string; fact: string; guidance: string } {
  const [head, guidance] = one.split(GUIDE);
  const at = head.indexOf(KEY);
  return at < 0 ? { key: "", fact: head, guidance: guidance ?? "" } : { key: head.slice(0, at), fact: head.slice(at + 1), guidance: guidance ?? "" };
}

/** 集合里列表型字段（文本列表、条目引用）的名字：来源可以指到其中一项。 */
function listFieldsOf(collection: CollectionDef): Set<string> {
  return new Set(collection.fields.filter((one) => one.type === FIELD_TEXT_LIST || one.type === FIELD_ITEM_REF).map((one) => one.name));
}

/** 理由里用直角引号引出的各段字；空的不算。 */
const QUOTED = /「([^「」]+)」/g;

/**
 * 助手补充的来源，理由里用直角引号引出的字要逐字出现在它支持的那几处正文里（没有写支持哪几处时，在这个条目任何一个字段的文字里）：
 * 页面靠这几个字在正文里标出哪里是助手补的，引的与正文不一样就标不出来。理由里没有直角引号的不核对。
 * 问题条目不核对（那里的助手补充写的是发现了什么，不是补进正文的字），由调用方跳过。返回不对的地方，每处是原因码与两层文字。
 */
export function quotedProblems(fields: Fields, sources: readonly Source[]): RefusalText[] {
  const textsOf = (value: unknown): string[] =>
    typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
  const out: RefusalText[] = [];
  for (const source of sources) {
    if (source.kind !== SOURCE_SUPPLEMENT) continue;
    const places = source.supports.length === 0 ? Object.values(fields).flatMap(textsOf)
      : source.supports.flatMap((at) => {
        const value = fields[at.field];
        return at.index === undefined || !Array.isArray(value) ? textsOf(value) : textsOf(value[at.index]);
      });
    const where = source.supports.length === 0 ? fillText("part.where_item_text") : fillText("part.where_supported_text");
    for (const [, quoted] of source.excerpt.matchAll(QUOTED)) {
      if (places.some((text) => text.includes(quoted))) continue;
      out.push(refusalText("save_revision.supplement_quote_not_in_text", { source: quoteLabel(source), quoted, where }));
    }
  }
  return out;
}

/** 结果里说到一条来源：摘录（长的只引前 30 字）加种类。 */
function quoteLabel(source: Source): string {
  return fillText("part.quote_label", { excerpt: quoteOf(source.excerpt), kind: source.kind });
}

/** 执行者改写了的内容上还留着原来的来源时，写在保存结果末尾的一句提醒：哪几处、哪几条，以及怎样去掉。 */
/** 第 no 个操作里一条 Word 来源的出处被代改到同一行另一格时，记进保存结果末尾的那句话。 */
function relocatedNote(no: number, notes: string[]): Relocate {
  return (where, from, n, excerpt) => notes.push(fillText("result.save_revision.locator_moved", { no, where, from, n, excerpt }));
}

function rewrittenNote(itemId: string, list: RewrittenSupport[]): string {
  const where = (one: Support) => (one.index === undefined
    ? fillText("result.save_revision.field_place", { field: one.field }) : fillText("result.save_revision.field_item_place", { field: one.field, no: one.index + 1 }));
  const parts = list.map(({ source, supports }) => fillText("result.save_revision.stale_part", { places: supports.map(where).join("、"), source: quoteLabel(source) }));
  return fillText("result.save_revision.stale_sources", { item: itemId, parts: parts.join("；") });
}

/**
 * 问题条目（集合里有取值含「用户决定保留」的状态字段，见 keepPendingField）写下之后，执行者修改它时
 * 只能改状态、处理结果、落实到、是否阻断下游与何时回看（集合里有的才算）：用户的回答要写进它牵涉的条目，而不是写回问题本身。
 * 值没有变的字段不算改。
 * 新增不受这条限制（新增时状态不能直接写成已解决或用户决定保留，见 lib/problem_consent.ts 的 newProblemStatus）；用户在界面上的操作（先不管、撤销）不经这里核对。
 */
function checkProblemUpdate(collection: CollectionDef, itemId: string, before: Fields, fields: Fields, errors: string[]): void {
  const status = keepPendingField(collection);
  if (!status) return;
  const changed = Object.keys(fields).filter((name) => {
    if (name === status.name || PROBLEM_EDITABLE_FIELDS.includes(name)) return false;
    if (!collection.fields.some((one) => one.name === name)) return false;   // 没有这个字段，checkFields 已经说过
    const value = fields[name];
    return !(isEmptyValue(value) ? isEmptyValue(before[name]) : sameJson(value, before[name]));
  });
  if (changed.length === 0) return;
  const editable = [status.name, ...PROBLEM_EDITABLE_FIELDS.filter((name) => collection.fields.some((one) => one.name === name))];
  errors.push(problem(refusalText("save_revision.problem_edit_restricted", {
    item: itemId, fields: changed.map((name) => `「${name}」`).join("、"),
    editable: editable.length === 2 ? editable.join("与") : `${editable.slice(0, -1).join("、")}与${editable[editable.length - 1]}`,
  })));
}

/**
 * 问题条目内容上的两条规矩，执行者新增与修改时都查；集合里没有声明相应字段的不查（早先建的任务的定义里没有这几个字段）。
 * - 「是否阻断下游」写的是「不阻断」时，「何时回看」要写：推后的问题得说清什么时候回来看。touched 为假（这次没有动这两个字段）时不查，
 *   免得用户在界面上留下的写法挡住执行者改别的字段。
 * - 状态这一次改成「已解决」时，「落实到」要写：答案写进了哪里。
 * after 是改完之后的全部字段，beforeStatus 是改之前的状态（新增时不给）。
 */
function checkProblemContent(collection: CollectionDef, after: Fields, touched: boolean, beforeStatus: unknown, errors: string[]): void {
  const status = keepPendingField(collection);
  if (!status) return;
  const has = (name: string) => collection.fields.some((one) => one.name === name);
  if (touched && has(PROBLEM_BLOCKING_FIELD) && has(PROBLEM_REVISIT_FIELD) && after[PROBLEM_BLOCKING_FIELD] === PROBLEM_NOT_BLOCKING && isEmptyValue(after[PROBLEM_REVISIT_FIELD])) {
    errors.push(problem(refusalText("save_revision.problem_not_blocking_needs_revisit", { blocking: PROBLEM_BLOCKING_FIELD, not_blocking: PROBLEM_NOT_BLOCKING, revisit: PROBLEM_REVISIT_FIELD })));
  }
  if (has(PROBLEM_LANDED_FIELD) && after[status.name] === RESOLVED_STATUS && beforeStatus !== RESOLVED_STATUS && isEmptyValue(after[PROBLEM_LANDED_FIELD])) {
    errors.push(problem(refusalText("save_revision.problem_resolved_needs_landed", { resolved: RESOLVED_STATUS, landed: PROBLEM_LANDED_FIELD })));
  }
}

/**
 * 执行者把问题条目的状态改为「已解决」或「用户决定保留」时，核对用户点过头（规则见 lib/problem_consent.ts）。
 * 状态没有变、改成别的取值时不核对。牵涉的条目取这个问题条目改之前各个条目引用字段里写的编号。
 */
function checkProblemStatus(
  collection: CollectionDef,
  itemId: string,
  before: Fields,
  fields: Fields,
  changedHere: Set<string>,
  facts: ProblemFacts,
  errors: string[],
): void {
  const status = keepPendingField(collection);
  if (!status || !(status.name in fields)) return;
  const value = fields[status.name];
  if (typeof value !== "string" || value === before[status.name] || !Object.hasOwn(CONSENT_OPTION, value)) return;
  const linked = collection.fields
    .filter((field) => field.type === FIELD_ITEM_REF)
    .flatMap((field) => (Array.isArray(before[field.name]) ? (before[field.name] as unknown[]) : []))
    .filter((one): one is string => typeof one === "string" && one !== itemId);
  const others = new Set([...changedHere].filter((one) => one !== itemId));
  const refusal = judgeProblemStatus(itemId, value, [...new Set(linked)], others, facts);
  if (refusal) errors.push(problemText(refusal));
}

/** 条目是不是在事件序号 seq 之后被删除的。 */
function deletedAfter(db: DatabaseSync, taskId: string, itemId: string, seq: number): boolean {
  const row = db.prepare("SELECT deleted_event_seq FROM item WHERE task_id = ? AND item_id = ?").get(taskId, itemId) as { deleted_event_seq: number | null } | undefined;
  return !!row && row.deleted_event_seq !== null && Number(row.deleted_event_seq) > seq;
}

/** 核对条目引用字段时要查的两样：一个条目在哪个集合里（不存在是 null）、它现在的字段内容（这一批里改过的取改后的）。 */
interface RefLookups {
  collectionOf: (itemId: string) => string | null;
  fieldsOf: (itemId: string) => Record<string, unknown> | null;
}

/**
 * 核对一组字段：字段名都在集合的声明里，值的类型对得上；文本列表写了取值的，每一项都在取值里、不重复；
 * 条目引用字段写了「至多一个」「只许本集合」的照着核对，两样都写了的不许顺着它绕回自己。
 * self 是正在核对的条目的编号（新增时是它将要拿到的编号，拿不到时为 null）。
 */
function checkFields(
  collection: CollectionDef,
  fields: Record<string, unknown>,
  checkRef: (itemId: unknown) => string | null,
  errors: string[],
  refs: RefLookups | null = null,
  self: string | null = null,
): void {
  const declared = new Map<string, FieldDef>(collection.fields.map((one) => [one.name, one]));
  for (const [name, value] of Object.entries(fields)) {
    const field = declared.get(name);
    if (!field) {
      errors.push(problem(refusalText("save_revision.field_unknown", { collection: collection.name, field: name, fields: collection.fields.map((one) => `「${one.name}」`).join("、") })));
      continue;
    }
    if (field.type === FIELD_ITEM_REF) {
      // 条目引用的值一律是条目编号的字符串数组，可以是空数组；单个字符串也要写成数组。
      if (!Array.isArray(value)) {
        errors.push(problem(refusalText("save_revision.field_ref_not_array", { field: name, given: String(JSON.stringify(value)) })));
        continue;
      }
      if (field.single && value.length > 1) {
        errors.push(problem(refusalText("save_revision.field_ref_over_single", { field: name, count: value.length })));
      }
      value.forEach((one, index) => {
        const reason = typeof one === "string" ? checkRef(one) : problem(refusalText("save_revision.field_ref_target_missing.not_id"));
        if (reason) {
          // 原因的事实层是半句，接在「字段……第 N 个编号……」后面；原因自己的键与指引照旧带着。
          const why = splitGuide(reason);
          errors.push(problemText({ key: why.key, fact: fillText("part.field_ref", { field: name, no: index + 1, id: String(JSON.stringify(one)), why: why.fact }), guidance: why.guidance }));
          return;
        }
        if (typeof one !== "string" || !refs) return;
        if (self !== null && one === self) {
          errors.push(problem(refusalText("save_revision.field_ref_self", { field: name, no: index + 1, id: one })));
          return;
        }
        if (field.sameCollection) {
          const target = refs.collectionOf(one);
          if (target !== null && target !== collection.name) {
            errors.push(problem(refusalText("save_revision.field_ref_wrong_collection", { field: name, collection: collection.name, id: one, target })));
            return;
          }
        }
        if (field.single && field.sameCollection && self !== null) {
          // 顺着这个字段一路走下去，不许回到自己（甲的上级是乙，乙的上级又是甲）。
          const seen = new Set<string>();
          for (let at: string | null = one; at !== null && !seen.has(at); ) {
            seen.add(at);
            const next: unknown = (refs.fieldsOf(at)?.[name] as unknown[] | undefined)?.[0];
            at = typeof next === "string" ? next : null;
            if (at === self) {
              errors.push(problem(refusalText("save_revision.field_ref_cycle", { field: name, id: one, path: [...seen].join(" → "), self })));
              break;
            }
          }
        }
      });
      continue;
    }
    if (isEmptyValue(value) && (typeof value === "string" || Array.isArray(value))) continue;
    if (field.type === FIELD_TEXT && typeof value !== "string") {
      errors.push(problem(refusalText("save_revision.field_text_type", { field: name })));
    } else if (field.type === FIELD_TEXT_LIST) {
      if (!Array.isArray(value) || !value.every((one) => typeof one === "string")) {
        errors.push(problem(refusalText("save_revision.field_text_list_type", { field: name })));
      } else if (field.values) {
        const values = field.values.map((one) => `「${one}」`).join("、");
        (value as string[]).forEach((one, index) => {
          if (!field.values!.includes(one)) errors.push(problem(refusalText("save_revision.field_list_value_not_allowed", { field: name, no: index + 1, given: String(JSON.stringify(one)), values })));
          else if ((value as string[]).indexOf(one) !== index) errors.push(problem(refusalText("save_revision.field_list_value_duplicate", { field: name, value: one })));
        });
      }
    } else if (field.type === FIELD_ENUM) {
      if (typeof value !== "string" || !(field.values ?? []).includes(value)) {
        errors.push(problem(refusalText("save_revision.field_enum_invalid", { field: name, given: String(JSON.stringify(value)), values: (field.values ?? []).map((one) => `「${one}」`).join("、") })));
      }
    }
  }
}

/**
 * 按出处读文件全文；knowledgeProblem 说明一条知识库出处为什么读不到：返回一条带键的错误（where 与 locator 是拒绝语里的两个值），
 * 读得到或不是知识库出处时为 null。
 */
type MaterialReader = ((locator: string) => string | null) & {
  knowledgeProblem: (locator: string, where: string, shown: string) => string | null;
  /** 材料目录第一层里除 path 所指那份之外的材料原件（Word、PDF、文本；派生的文字版与分段清单不算），按文件名排；出处写法是「材料目录/文件名」。 */
  others?: (path: string) => { name: string; locator: string }[];
};

/** 材料目录第一层里算作材料原件的文件：Word、PDF、文本。 */
const MATERIAL_FILE = /\.(docx|pdf|md|txt)$/i;
/** 材料旁边派生的文字版（Word 的 .docx.md、旧的 .docx.txt，PDF 的 .pdf.md），不算一份材料。 */
const DERIVED_FILE = /\.(docx\.(md|txt)|pdf\.md)$/i;

/** 知识库出处读不到时「怎么办」一层常用的一句。 */
const copyKnowledgeLocator = () => fillText("part.copy_kb_locator");

/**
 * 按出处读文件的全文（换行归一为 \n），读不到返回 null。同一次保存里读过的不再读。
 *
 * 出处以 knowledge/ 开头的指向知识库文档：到知识库根目录下「知识库编号/files/文档名」读；没有知识库根目录、写法不对、
 * 那个知识库这个任务没有选用或已经不在、文件不存在，都是读不到。其余出处是材料：按任务目录下的相对路径找，找不到再到
 * 材料目录里按文件名找；解析出来的路径不在任务目录里的（任务目录之外的绝对路径、用 .. 绕出去的相对路径）按读不到处理。
 */
function materialReader(workspaceDir: string, materialsDir: string, knowledgeRoot: string | null = null): MaterialReader {
  const cache = new Map<string, string | null>();
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
    } catch {
      return null;
    }
  };
  const base = resolve(workspaceDir);
  const inside = (path: string) => {
    const rel = relative(base, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  const readMaterial = (locator: string): string | null => {
    const direct = resolve(base, locator);
    if (!inside(direct)) return null;
    return read(direct) ?? read(join(base, materialsDir, basename(locator)));
  };
  // 知识库的清单与任务的选用，用到时读一次。
  let lookup: { names: Map<string, string>; selected: Set<string> } | null = null;
  const knowledge = () => (lookup ??= { names: libraryNames(knowledgeRoot!), selected: new Set(selectedLibraryIds(workspaceDir)) });
  /** 知识库出处指向的文件路径，或者读不到的原因（一个函数：给出拒绝语里说到第几条来源与出处的写法，得到一条带键的错误）。 */
  const locate = (locator: string): { path: string } | { problem: (where: string, shown: string) => string } => {
    if (knowledgeRoot === null) return { problem: (where, shown) => problem(refusalText("source.knowledge_locator_unreadable.no_root", { where, locator: shown })) };
    const parsed = parseKnowledgeLocator(locator);
    if (!parsed) return { problem: (where, shown) => problem(refusalText("source.knowledge_locator_unreadable.bad_form", { where, locator: shown, copy: copyKnowledgeLocator() })) };
    const { names, selected } = knowledge();
    if (!names.has(parsed.library)) {
      return { problem: (where, shown) => problem(refusalText("source.knowledge_locator_unreadable.gone", { where, locator: shown, library: parsed.library, copy: copyKnowledgeLocator() })) };
    }
    if (!selected.has(parsed.library)) {
      return { problem: (where, shown) => problem(refusalText("source.knowledge_locator_unreadable.not_selected", { where, locator: shown, name: names.get(parsed.library)! })) };
    }
    return { path: join(knowledgeRoot, parsed.library, "files", parsed.name) };
  };
  const reader = ((locator: string) => {
    if (!cache.has(locator)) {
      if (isKnowledgeLocator(locator)) {
        const found = locate(locator);
        cache.set(locator, "path" in found ? read(found.path) : null);
      } else {
        cache.set(locator, readMaterial(locator));
      }
    }
    return cache.get(locator)!;
  }) as MaterialReader;
  reader.knowledgeProblem = (locator, where, shown) => {
    if (!isKnowledgeLocator(locator) || reader(locator) !== null) return null;
    const found = locate(locator);
    if ("problem" in found) return found.problem(where, shown);
    const parsed = parseKnowledgeLocator(locator)!;
    return problem(refusalText("source.knowledge_locator_unreadable", { where, locator: shown, document: parsed.name, name: knowledge().names.get(parsed.library)!, copy: copyKnowledgeLocator() }));
  };
  // 材料目录的清单，用到时读一次；各份的文字版经上面的 reader 读，同一次保存里每份只读一遍。
  const dir = materialsDir.replace(/\/+$/, "");
  let listing: string[] | null = null;
  reader.others = (path) => {
    if (listing === null) {
      try {
        listing = readdirSync(join(base, dir), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
          .filter((name) => MATERIAL_FILE.test(name) && !DERIVED_FILE.test(name)).sort();
      } catch {
        listing = [];
      }
    }
    const self = basename(path);
    return listing.filter((name) => name !== self).map((name) => ({ name, locator: `${dir}/${name}` }));
  };
  return reader;
}

/**
 * 摘录在材料里找不到时，拒绝文字「怎么办」一层的第一句（模型常自行补句号或改写，被拒后又干脆删掉引用）。
 * noun 是「材料」或「文档」：出处指向知识库时说文档。
 */
const exactExcerpt = (noun: Noun) => fillText("part.exact_excerpt", { noun });

/** 拒绝文字里怎样称呼出处所指的文件：任务的输入是「材料」，知识库里的是「文档」。 */
type Noun = "材料" | "文档";

/** 摘录里的空行（一个或多个只含空白的行）。 */
const BLANK_LINE = /\n\s*\n/;

/**
 * 逐字核对文本材料（Markdown、纯文本）的摘录之前，对摘录与原文做同一件事，而且只做这一件：把行尾统一成换行符，去掉每一行
 * 行尾的空白。行里的空白不动，空行不压：原文是「甲\n\n乙」时，摘录写成「甲\n乙」对不上。Word 材料另有规则（docx_source.ts）。
 */
export function lineEndsOnly(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[^\S\n]+$/gm, "");
}

/** 摘录不连续时，拒绝文字「怎么办」一层说明引几处写几条来源的那一句。 */
const severalPlaces = (noun: Noun) => fillText("part.several_places", { noun });

/** 摘录在材料里有好几处时，拒绝的文字里最多列出离原段落号最近的这么多处。 */
const NEARBY_LIMIT = 6;

/** 摘录超过这么多个字时，拒绝的文字里只引前这么多个字。 */
const EXCERPT_QUOTE_LIMIT = 30;

/** 拒绝文字里引摘录：换行写成空格，免得一句话断成几行；长的只引前 30 字。 */
function quoteOf(excerpt: string): string {
  const flat = excerpt.replace(/\s*\n\s*/g, " ");
  return flat.length > EXCERPT_QUOTE_LIMIT ? `${flat.slice(0, EXCERPT_QUOTE_LIMIT)}…` : flat;
}

/** 摘录在出处那一份材料里找不到、在另一份材料里找到的一处：哪份、第几段或第几页第几块（文本材料没有位置）、出处的写法。 */
interface OtherPlace {
  name: string;
  label: string;
  locator: string;
}

/** 摘录在另一份材料里找到时，拒绝文字里最多列出这么多处。 */
const OTHER_FILE_LIMIT = 3;

/**
 * 出处那一份材料里找不到摘录时，到材料目录第一层的其余材料里逐字找：Word 材料按段（与 checkDocxSource 同一个比法），
 * PDF 材料按页与块（与 checkPdfSource 同一个比法），文本材料在全文里找。知识库的出处不调用它：不跨库找。
 */
function otherFilePlaces(materialText: MaterialReader, path: string, raw: string): OtherPlace[] {
  const excerpt = raw.replace(/\r\n/g, "\n").trim();
  const places: OtherPlace[] = [];
  for (const other of materialText.others?.(path) ?? []) {
    if (/\.docx$/i.test(other.name)) {
      const suffix = PROJECTION_SUFFIXES.find((s) => materialText(`${other.locator}${s}`) !== null);
      if (!suffix) continue;
      for (const n of paragraphsWith(projectionParagraphs(materialText(`${other.locator}${suffix}`)!), excerpt)) {
        places.push({ name: other.name, label: fillText("part.docx_label", { n }), locator: `${other.locator}#p${n}` });
      }
    } else if (/\.pdf$/i.test(other.name)) {
      const projection = materialText(`${other.locator}.md`);
      if (projection === null) continue;
      for (const one of pdfUnitsWith(pdfProjectionUnits(projection), excerpt)) {
        places.push({ name: other.name, label: fillText("part.pdf_label", one), locator: `${other.locator}#p${one.page}-${one.block}` });
      }
    } else {
      const text = materialText(other.locator);
      if (text !== null && lineEndsOnly(text).includes(lineEndsOnly(excerpt).trim())) places.push({ name: other.name, label: "", locator: other.locator });
    }
  }
  return places;
}

/** 摘录在另一份材料里找到时拒绝文字要的几个值：列出前几处，指引写第一处的出处，有好几处时请执行者按上下文确认。 */
function otherFileValues(places: OtherPlace[]): { places: string; more: string; locator: string; confirm: string } {
  return {
    places: places.slice(0, OTHER_FILE_LIMIT).map((one) => fillText("part.other_file_place", { name: one.name, label: one.label })).join("、"),
    more: places.length > OTHER_FILE_LIMIT ? fillText("part.more_places", { count: places.length }) : "",
    locator: places[0].locator,
    confirm: places.length > 1 ? fillText("part.other_file_confirm") : "",
  };
}

/**
 * 核对来源列表：至少一条，每条三项齐全、种类是三者之一，supports 的形状对。通过就返回整理好的列表。
 * 种类为「用户的话」的来源，出处在这里代填（见文件开头的说明）；supports 所指的字段是否存在、
 * 序号是否在范围内，要等字段合并完才知道，另由 checkSupports 核对。
 *
 * 种类为「助手补充」的来源，出处不用写，这里一律填「助手补充」；摘录是理由，必须有。
 *
 * 种类为「条目」的来源，出处去掉首尾空白后由 itemSource.ref 核对是任务里还在的另一个条目（哪个集合都可以），摘录（去掉首尾空白）
 * 要逐字出现在那个条目当前内容的某段文字里（itemSource.text 给出这些文字），与「文档原文」同一个规矩；通过之后记下引用这一刻
 * 那个条目的修订号（itemSource.revision）。用户在界面上的操作不核对，撤销时原样交回旧来源，连同它原来记的修订号。
 *
 * 种类为「文档原文」的来源，位置由写来源的一方声明，这里只核对、不推断：一条来源的摘录是材料里连续的一段原文。
 * Word 材料按出处写的段落号核对，摘录从那一段开始、可延续到其后相邻至多 5 段（checkDocxSource）；文本材料（.md、.txt）的摘录
 * 要在整份文件里连续出现（现在是找第一处，等文本材料也有段落号之后再按位置核对）。摘录里的空行只当空白；引了材料几处不相邻的原文，
 * 就要写几条来源，工具不替它拆开、也不替它找后几处的位置。
 */
function checkSources(
  raw: unknown,
  required: boolean,
  errors: string[],
  sessionId: string,
  userMessages: UserMessage[],
  actor?: string,
  materialText?: MaterialReader,
  itemSource?: ItemSourceLookups,
  whereOf: (index: number) => string = (index) => fillText("part.source_no", { no: index + 1 }),
  previous: readonly Source[] = [],
  figure = false,
  relocate?: Relocate,
): Source[] | null {
  if (raw === undefined || raw === null) {
    if (required) errors.push(problem(refusalText("source.missing")));
    return null;
  }
  // 用户在界面上改写之后条目可以没有来源，所以发起方是用户时可以交空列表。
  if (!Array.isArray(raw) || (raw.length === 0 && actor !== ACTOR_USER)) {
    errors.push(problem(refusalText("source.not_nonempty_list")));
    return null;
  }
  const kept: Source[] = [];
  let ok = true;
  raw.forEach((given, index) => {
    const where = whereOf(index);
    if (!isObject(given)) {
      errors.push(problem(refusalText("source.item_not_object", { where })));
      ok = false;
      return;
    }
    const one: Record<string, unknown> = given;
    const missing: string[] = [];
    // 「用户直接修改」是早期版本由系统写的，执行者不能填；执行者只能填 EXECUTOR_SOURCE_KINDS 那几种。
    const allowed: readonly string[] = actor === ACTOR_USER ? SOURCE_KINDS : EXECUTOR_SOURCE_KINDS;
    const kindsGuide = fillText("part.kinds_guide", { kinds: EXECUTOR_SOURCE_KINDS.map((kind) => `「${kind}」`).join("、") });
    if (one.kind === SOURCE_USER_EDIT && actor !== ACTOR_USER) {
      errors.push(problem(refusalText("source.kind_user_edit_forbidden", { where, kind: SOURCE_USER_EDIT, kinds_guide: kindsGuide })));
      ok = false;
    } else if (one.kind === SOURCE_FIGURE && actor !== ACTOR_USER && figure) {
      errors.push(problem(refusalText("source.kind_figure_in_figure", { where, figure: SOURCE_FIGURE, item: SOURCE_ITEM })));
      ok = false;
    } else if (typeof one.kind !== "string" || !allowed.includes(one.kind)) {
      errors.push(problem(refusalText("source.kind_invalid", { where, given: String(JSON.stringify(one.kind)), kinds: allowed.map((kind) => `「${kind}」`).join("、") })));
      ok = false;
    }
    const userWords = one.kind === SOURCE_USER_WORDS;
    const supplement = one.kind === SOURCE_SUPPLEMENT;
    if (supplement && (typeof one.excerpt !== "string" || one.excerpt.trim() === "")) {
      errors.push(problem(refusalText("source.supplement_no_reason", { where, kind: SOURCE_SUPPLEMENT })));
      ok = false;
      return;
    }
    // 图依据条目、条目依据图时可以不写摘录：依据的是对方整体，要紧的是记下引用时它的修订号。写了照样逐字核对。
    const bareItem = ((figure && one.kind === SOURCE_ITEM) || one.kind === SOURCE_FIGURE) && (typeof one.excerpt !== "string" || one.excerpt.trim() === "");
    if (!userWords && !supplement && (typeof one.locator !== "string" || one.locator.trim() === "")) missing.push(fillText("part.missing_locator"));
    if (!bareItem && (typeof one.excerpt !== "string" || one.excerpt.trim() === "")) missing.push(fillText("part.missing_excerpt"));
    if (missing.length > 0) {
      errors.push(problem(refusalText("source.locator_or_excerpt_missing", { where, missing: missing.join("、") })));
      ok = false;
      return;
    }
    let normalized: string | undefined;
    if (one.normalized_value !== undefined && one.normalized_value !== null) {
      if (!userWords) {
        errors.push(problem(refusalText("source.normalized_value_misused", { where })));
        ok = false;
        return;
      }
      if (typeof one.normalized_value !== "string" || one.normalized_value.trim() === "") {
        errors.push(problem(refusalText("source.normalized_value_empty", { where })));
        ok = false;
        return;
      }
      normalized = one.normalized_value;
    }
    const supports = checkSupportShape(one.supports, where, errors);
    if (supports === null) {
      ok = false;
      return;
    }
    if (figure && supports.length > 0) {
      errors.push(problem(refusalText("source.supports_in_figure", { where })));
      ok = false;
      return;
    }
    // 助手补充的出处由这里填；用户的操作交回的旧来源照它原来的出处。
    let locator = supplement && (actor !== ACTOR_USER || typeof one.locator !== "string" || one.locator.trim() === "") ? SOURCE_SUPPLEMENT : (one.locator as string);
    // 依据条目时引用那一刻对方的修订号。用户的操作（直接修改、撤销）交回的旧来源保留它原来记的号。
    let depends: Source["depends_revision"] =
      actor === ACTOR_USER && (typeof one.depends_revision === "number" || one.depends_revision === THIS_REVISION) ? one.depends_revision : undefined;
    if (one.kind === SOURCE_ITEM && actor !== ACTOR_USER && itemSource) {
      locator = locator.trim();
      const reason = itemSource.ref(locator);
      if (reason) {
        // 原因自己带着「怎么办」的（指向已废弃的主题时写改看哪一页），用它自己的；否则用通用的那一句。
        const fact = refusalText("source.item_ref_invalid", { where, kind: SOURCE_ITEM, locator, why: reason.fact }).fact;
        errors.push(problemText({ key: "source.item_ref_invalid", fact, guidance: reason.guidance || fillText("source.item_ref_invalid.guide") }));
        ok = false;
        return;
      }
      const excerpt = bareItem ? "" : (one.excerpt as string).trim();
      if (excerpt !== "" && !itemSource.text(locator).some((text) => text.includes(excerpt))) {
        errors.push(problem(refusalText("source.item_excerpt_not_found", { where, excerpt: quoteOf(excerpt), locator })));
        ok = false;
        return;
      }
      depends = itemSource.revision(locator);
    }
    if (one.kind === SOURCE_FIGURE && actor !== ACTOR_USER && itemSource) {
      locator = locator.trim();
      const found = itemSource.figure(locator);
      if ("reason" in found) {
        errors.push(problem(refusalText("source.figure_ref_invalid", { where, kind: SOURCE_FIGURE, locator, why: found.reason })));
        ok = false;
        return;
      }
      const excerpt = bareItem ? "" : (one.excerpt as string).trim();
      if (excerpt !== "" && !found.mermaid.includes(excerpt)) {
        errors.push(problem(refusalText("source.figure_excerpt_not_found", { where, excerpt: quoteOf(excerpt), locator })));
        ok = false;
        return;
      }
      depends = found.revision;
    }
    const keepLocator =
      userWords && actor === ACTOR_USER && typeof one.locator === "string" && one.locator.includes("#");
    if (userWords && !keepLocator) {
      // 从最近往前找逐字包含这段摘录的用户消息；模型写的 locator 不用，一律由这里代填。
      // 例外：用户在界面上撤销时，扩展命令把旧修订下的来源原样交回来，出处早已是「会话编号#条目编号」，照旧保留。
      const excerpt = one.excerpt as string;
      const hit = [...userMessages].reverse().find((message) => message.text.includes(excerpt));
      if (!hit) {
        errors.push(problem(refusalText("source.user_words_not_found", { where, excerpt })));
        ok = false;
        return;
      }
      locator = userWordsLocator(sessionId, hit.entryId);
    }
    const docx = DOCX_LOCATOR.exec(locator);
    // 出处是 PDF 材料：文件名以 .pdf 结尾，后面可以有 # 开头的一截（写得对不对在 checkPdfSource 里看）。
    const pdf = docx ? null : PDF_FILE.exec(locator);
    /** 出处里指文件的那一部分（去掉段落号或页与块）。 */
    const filePart = docx ? docx[1] : pdf ? pdf[1] : locator;
    // 与这个条目当前修订里的某条来源是同一句摘录、而出处所指的知识库文档现在读不到：原样收下，不核对（见文件开头）。材料出处没有这个例外。
    if (one.kind === SOURCE_DOCUMENT && actor !== ACTOR_USER && materialText && isKnowledgeLocator(locator) && materialText(filePart) === null
      && previous.some((old) => sameQuote(old, { kind: one.kind as string, locator, excerpt: one.excerpt as string, supports }))) {
      kept.push({ kind: one.kind as string, locator, excerpt: one.excerpt as string, supports });
      return;
    }
    // 出处指向知识库里的文档：拒绝文字里说「文档」，不说「材料」。
    const inKnowledge = one.kind === SOURCE_DOCUMENT && isKnowledgeLocator(locator);
    const noun: Noun = inKnowledge ? "文档" : "材料";
    if (one.kind === SOURCE_DOCUMENT && actor !== ACTOR_USER && materialText && /\.docx\.(txt|md)$/i.test(locator)) {
      errors.push(problem(refusalText("source.docx_projection_locator", { where, locator, noun, file: locator.replace(/\.(txt|md)$/i, "") })));
      ok = false;
      return;
    }
    if (one.kind === SOURCE_DOCUMENT && actor !== ACTOR_USER && materialText && /\.pdf\.md$/i.test(locator)) {
      errors.push(problem(refusalText("source.pdf_projection_locator", { where, locator, noun, file: locator.replace(/\.md$/i, "") })));
      ok = false;
      return;
    }
    // 知识库出处读不到（没有知识库、写法不对、知识库没有选用或已经不在、文档找不到）：新写的来源拒绝，说明原因。
    const unreadable = inKnowledge && actor !== ACTOR_USER && materialText ? materialText.knowledgeProblem(filePart, where, locator) : null;
    if (unreadable) {
      errors.push(unreadable);
      ok = false;
      return;
    }
    if (one.kind === SOURCE_DOCUMENT && actor !== ACTOR_USER && materialText && docx) {
      const found = checkDocxSource(docx[1], docx[2] ? Number(docx[2]) : null, one.excerpt as string, where, materialText, errors, noun,
        relocate && ((from, n, excerpt) => relocate(where, from, n, excerpt)));
      if (found === null) {
        ok = false;
        return;
      }
      locator = found;
    } else if (one.kind === SOURCE_DOCUMENT && actor !== ACTOR_USER && materialText && pdf) {
      const found = checkPdfSource(locator, pdf[1], one.excerpt as string, where, materialText, errors, noun);
      if (found === null) {
        ok = false;
        return;
      }
      locator = found;
    } else if (one.kind === SOURCE_DOCUMENT && actor !== ACTOR_USER && materialText) {
      const excerpt = lineEndsOnly(one.excerpt as string).trim();
      const text = materialText(locator);
      if (text === null) {
        errors.push(problem(refusalText("source.material_not_found", { where, locator })));
        ok = false;
        return;
      }
      if (!lineEndsOnly(text).includes(excerpt)) {
        const how = { noun, exact: exactExcerpt(noun), several: severalPlaces(noun) };
        const others = inKnowledge ? [] : otherFilePlaces(materialText, locator, excerpt);
        errors.push(others.length > 0
          ? problem(refusalText("source.material_excerpt_in_other_file", { where, excerpt: quoteOf(excerpt), file: basename(locator), ...otherFileValues(others) }))
          : BLANK_LINE.test(excerpt)
          ? problem(refusalText("source.material_excerpt_not_contiguous", { where, file: basename(locator), ...how }))
          : problem(refusalText("source.material_excerpt_not_found", { where, excerpt: quoteOf(excerpt), file: basename(locator), ...how })));
        ok = false;
        return;
      }
    }
    kept.push({ kind: one.kind as string, locator, excerpt: bareItem ? "" : one.excerpt as string, supports, ...(normalized ? { normalized_value: normalized } : {}),
      ...(depends !== undefined && depends !== null ? { depends_revision: depends } : {}) });
  });
  return ok ? kept : null;
}

/**
 * 保存修订核对 Word 来源时，摘录不在写的那一段、只在同一表格行的另一格里（全文件只此一处）：不拒绝，把出处改到那一段，
 * 并经这个函数在保存结果末尾说一句。where 是说到第几条来源的那几个字，from 是原来的出处，n 是改到的段落号，excerpt 是引给执行者看的摘录。
 * 保存图与回复的依据不给它，照旧拒绝。
 */
type Relocate = (where: string, from: string, n: number, excerpt: string) => void;

/** 表格里一段的位置「表 t 行 r 列 c」拆成行（表与行）与列。 */
const TABLE_CELL = /^(表 \d+ 行 \d+) 列 (\d+)$/;

/**
 * 核对一条出处是 Word 材料的来源：出处要带段落号，摘录要在那一段里（或从那一段起跨到其后相邻至多 5 段），比较时去掉全部空白。
 * 不在那里就拒绝：摘录是一段连续的原文时，指出它在别处的段落号（只有一处时）或按远近列几处请执行者确认；摘录里有空行、
 * 又不是连续的一段时，说明引几处要写几条来源。通过时返回规范写法的出处（x.docx#pN），不通过时把原因记进 errors 并返回 null。
 */
function checkDocxSource(
  path: string,
  n: number | null,
  raw: string,
  where: string,
  materialText: MaterialReader,
  errors: string[],
  noun: Noun = "材料",
  relocate?: (from: string, n: number, excerpt: string) => void,
): string | null {
  const name = basename(path);
  const suffix = PROJECTION_SUFFIXES.find((s) => materialText(`${path}${s}`) !== null);
  const projection = suffix ? materialText(`${path}${suffix}`)! : null;
  const pointer = projection !== null && isLegacyProjection(projection)
    ? fillText("part.docx_pointer_legacy", { file: `${name}${suffix}` })
    : fillText("part.docx_pointer", { file: `${name}${suffix ?? ".md"}` });
  if (n === null) {
    errors.push(problem(refusalText("source.docx_no_paragraph", { where, path, noun, pointer })));
    return null;
  }
  if (projection === null) {
    errors.push(noun === "文档"
      ? problem(refusalText("source.docx_projection_missing.knowledge", { where, path, name, copy: copyKnowledgeLocator() }))
      : problem(refusalText("source.docx_projection_missing", { where, path, name })));
    return null;
  }
  const paragraphs = projectionParagraphs(projection);
  if (n < 1 || n > paragraphs.length) {
    errors.push(problem(refusalText("source.docx_paragraph_out_of_range", { where, n, name, count: paragraphs.length, pointer })));
    return null;
  }
  const excerpt = raw.replace(/\r\n/g, "\n").trim();
  if (placeExcerpt(paragraphs, n, excerpt).kind !== "miss") return `${path}#p${n}`;
  // 摘录在别处：只有一处时指给它；有好几处（短摘录、表格里的数字常这样）时不替模型挑一段，按离第 n 段的远近列出几处
  // （带表格位置），请它按上下文确认——只给一个段号时，模型会照抄，写出逐字对得上但出处指错地方的来源。
  const positions = projectionTablePositions(projection);
  const labelOf = (m: number) => `${fillText("part.docx_label", { n: m })}${positions.has(m) ? `·${positions.get(m)}` : ""}`;
  const elsewhere = paragraphsWith(paragraphs, excerpt).filter((m) => m !== n);
  const head = fillText("part.docx_head", { where, excerpt: quoteOf(excerpt), name, label: labelOf(n) });
  let others: OtherPlace[] | undefined;
  // 表格一行每格一个段落号，执行者隔几轮凭记忆回填常错到同一行的另一格：只此一处又在同一行时，替它改过来。
  const cell = (m: number) => TABLE_CELL.exec(positions.get(m) ?? "");
  const [here, there] = elsewhere.length === 1 ? [cell(n), cell(elsewhere[0])] : [null, null];
  if (relocate && here && there && here[1] === there[1] && here[2] !== there[2]) {
    relocate(`${path}#p${n}`, elsewhere[0], quoteOf(excerpt));
    return `${path}#p${elsewhere[0]}`;
  }
  if (elsewhere.length === 1) {
    errors.push(problem(refusalText("source.docx_excerpt_elsewhere_one", { head, label: labelOf(elsewhere[0]), path, n: elsewhere[0] })));
  } else if (elsewhere.length > 1) {
    const near = [...elsewhere].sort((a, b) => Math.abs(a - n) - Math.abs(b - n) || a - b).slice(0, NEARBY_LIMIT).sort((a, b) => a - b);
    const more = elsewhere.length > near.length ? fillText("part.more_places", { count: elsewhere.length }) : "";
    errors.push(problem(refusalText("source.docx_excerpt_elsewhere_many", { head, labels: near.map(labelOf).join("、"), more })));
  } else if (noun === "材料" && (others ??= otherFilePlaces(materialText, path, excerpt)).length > 0) {
    errors.push(problem(refusalText("source.docx_excerpt_in_other_file", { head, ...otherFileValues(others) })));
  } else if (BLANK_LINE.test(excerpt)) {
    // 摘录里有空行、整段在材料里哪儿都不是连续的一段：多半是把不相邻的几处写进了一条来源。
    errors.push(problem(refusalText("source.docx_excerpt_not_contiguous", { where, name, n, span: SPAN_LIMIT, several: severalPlaces(noun) })));
  } else if (inTextBox(projection, excerpt)) {
    errors.push(problem(refusalText("source.docx_excerpt_in_textbox", { head })));
  } else {
    errors.push(problem(refusalText("source.docx_excerpt_not_found", { head, exact: exactExcerpt(noun), several: severalPlaces(noun) })));
  }
  return null;
}

/** 出处的文件是 PDF：路径以 .pdf 结尾，后面可以跟 # 开头的一截。 */
const PDF_FILE = /^(.+\.pdf)(#.*)?$/i;

/**
 * 核对一条出处是 PDF 材料的来源：出处要写页与块（x.pdf#p页-块），摘录要在那一块里，或者从那一块起、在同一页之内往后接相邻的至多
 * PDF_SPAN_LIMIT 块；两边都过比较层的规范化再逐字比（lib/pdf_source.ts，页面标出摘录时用的是同一个函数）。摘录不能跨页。
 * 不在那里就拒绝，并指出摘录其实在哪几块。通过时返回规范写法的出处，不通过时把原因记进 errors 并返回 null。
 */
function checkPdfSource(
  locator: string,
  path: string,
  raw: string,
  where: string,
  materialText: MaterialReader,
  errors: string[],
  noun: Noun = "材料",
): string | null {
  const name = basename(path);
  const pointer = fillText("part.pdf_pointer", { name });
  const parsed = parsePdfLocator(locator);
  if (!parsed || parsed.page === null || parsed.block === null) {
    errors.push(locator === path
      ? problem(refusalText("source.pdf_no_page_block", { where, path, noun, pointer }))
      : problem(refusalText("source.pdf_no_page_block.bad_form", { where, locator, path, noun, pointer })));
    return null;
  }
  const projection = materialText(`${path}.md`);
  if (projection === null) {
    errors.push(noun === "文档"
      ? problem(refusalText("source.pdf_projection_missing.knowledge", { where, path, name, copy: copyKnowledgeLocator() }))
      : problem(refusalText("source.pdf_projection_missing", { where, path, name })));
    return null;
  }
  const { page, block } = parsed;
  const units = pdfProjectionUnits(projection);
  const labelOf = (one: { page: number; block: number }) => fillText("part.pdf_label", { page: one.page, block: one.block });
  if (block === 0) {
    errors.push(problem(refusalText("source.pdf_block_zero", { where, page })));
    return null;
  }
  if (pdfUnitIndex(units, page, block) < 0) {
    const onPage = units.filter((unit) => unit.page === page && unit.block >= 1).length;
    const pages = units.reduce((max, unit) => Math.max(max, unit.page), 0);
    errors.push(page > pages
      ? problem(refusalText("source.pdf_page_block_out_of_range.page", { where, page, name, pages, pointer }))
      : problem(refusalText("source.pdf_page_block_out_of_range", {
        where, label: labelOf(parsed as { page: number; block: number }), name, page, pointer,
        blocks: onPage ? fillText("part.pdf_blocks_on_page", { count: onPage }) : fillText("part.pdf_no_blocks"),
      })));
    return null;
  }
  const excerpt = raw.replace(/\r\n/g, "\n").trim();
  const place = placePdfExcerpt(units, page, block, excerpt);
  if (place.kind === "in" || place.kind === "span") return `${path}#p${page}-${block}`;
  const head = fillText("part.pdf_head", { where, excerpt: quoteOf(excerpt), name, label: labelOf({ page, block }) });
  if (place.kind === "cross_page") {
    errors.push(problem(refusalText("source.pdf_excerpt_cross_page", { where, name, label: labelOf({ page, block }) })));
    return null;
  }
  // 摘录在别处：只有一处时指给它；有好几处时不替模型挑，按离出处那一块的远近列出几处，请它按上下文确认。
  const here = pdfUnitIndex(units, page, block);
  const elsewhere = pdfUnitsWith(units, excerpt).filter((one) => !(one.page === page && one.block === block));
  let others: OtherPlace[] | undefined;
  if (elsewhere.length === 1) {
    errors.push(problem(refusalText("source.pdf_excerpt_elsewhere_one", { head, label: labelOf(elsewhere[0]), path, page: elsewhere[0].page, block: elsewhere[0].block })));
  } else if (elsewhere.length > 1) {
    const distance = (one: { page: number; block: number }) => Math.abs(pdfUnitIndex(units, one.page, one.block) - here);
    const near = [...elsewhere].sort((a, b) => distance(a) - distance(b)).slice(0, NEARBY_LIMIT)
      .sort((a, b) => pdfUnitIndex(units, a.page, a.block) - pdfUnitIndex(units, b.page, b.block));
    const more = elsewhere.length > near.length ? fillText("part.more_places", { count: elsewhere.length }) : "";
    errors.push(problem(refusalText("source.pdf_excerpt_elsewhere_many", { head, labels: near.map(labelOf).join("、"), more })));
  } else if (noun === "材料" && (others ??= otherFilePlaces(materialText, path, excerpt)).length > 0) {
    errors.push(problem(refusalText("source.pdf_excerpt_in_other_file", { head, ...otherFileValues(others) })));
  } else if (BLANK_LINE.test(excerpt)) {
    errors.push(problem(refusalText("source.pdf_excerpt_not_contiguous", { where, name, label: labelOf({ page, block }), span: PDF_SPAN_LIMIT, several: severalPlaces(noun) })));
  } else {
    errors.push(problem(refusalText("source.pdf_excerpt_not_found", { head, exact: exactExcerpt(noun), several: severalPlaces(noun) })));
  }
  return null;
}

/** 核对一条来源的 supports 的形状：省略或空列表表示支持整个条目；每一项有 field，可以有从 0 起的整数 index。 */
function checkSupportShape(raw: unknown, where: string, errors: string[]): Support[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(problem(refusalText("source.supports_not_list", { where })));
    return null;
  }
  const kept: Support[] = [];
  let ok = true;
  raw.forEach((one, index) => {
    const at = fillText("part.supports_item", { where, no: index + 1 });
    if (!isObject(one) || typeof one.field !== "string" || one.field.trim() === "") {
      errors.push(problem(refusalText("source.supports_item_shape", { at })));
      ok = false;
      return;
    }
    if (one.index !== undefined && one.index !== null) {
      if (typeof one.index !== "number" || !Number.isInteger(one.index) || one.index < 0) {
        errors.push(problem(refusalText("source.supports_index_invalid", { at, given: String(JSON.stringify(one.index)) })));
        ok = false;
        return;
      }
      kept.push({ field: one.field, index: one.index });
    } else {
      kept.push({ field: one.field });
    }
  });
  return ok ? kept : null;
}

/**
 * 核对来源所支持的字段：字段必须是这个集合声明的、在改后的内容里不是空的；index 只能用在列表型字段
 * （文本列表、条目引用）上，并且小于这个字段改后的项数。inherited 为真表示这些来源是从条目当前的来源沿用的，
 * 字段改短之后它们可能指到不存在的项，这时要求模型重新给出来源。
 */
function checkSupports(
  collection: CollectionDef,
  fields: Fields,
  sources: Source[],
  inherited: boolean,
  errors: string[],
): void {
  const declared = new Map<string, FieldDef>(collection.fields.map((one) => [one.name, one]));
  sources.forEach((source, position) => {
    const where = `${inherited ? fillText("part.inherited") : ""}${fillText("part.source_no", { no: position + 1 })}`;
    const tail = inherited ? fillText("part.support_tail") : "";
    for (const support of source.supports) {
      const field = declared.get(support.field);
      if (!field) {
        errors.push(problem(refusalText("save_revision.support_field_unknown", {
          where, field: support.field, collection: collection.name, fields: collection.fields.map((one) => `「${one.name}」`).join("、"), tail,
        })));
        continue;
      }
      const value = fields[support.field];
      if (isEmptyValue(value)) {
        errors.push(inherited
          ? problem(refusalText("save_revision.support_field_empty.inherited", { where, field: support.field }))
          : problem(refusalText("save_revision.support_field_empty", { where, field: support.field })));
        continue;
      }
      if (support.index === undefined) continue;
      if (field.type !== FIELD_TEXT_LIST && field.type !== FIELD_ITEM_REF) {
        errors.push(problem(refusalText("save_revision.support_index_on_non_list", { where, field: support.field, type: field.type, tail })));
        continue;
      }
      const length = Array.isArray(value) ? value.length : 0;
      if (support.index >= length) {
        errors.push(problem(refusalText("save_revision.support_index_out_of_range", { where, field: support.field, index: support.index, length, max: length - 1, tail })));
      }
    }
  });
}

/** 核对全部通过之后写库。这里是 revision、item、item_version、item_source 四张表的唯一写入点。 */
function write(
  db: DatabaseSync,
  call: CallContext,
  taskId: string,
  definition: TaskDefinition,
  planned: Planned[],
  params: SaveRevisionParams,
): ToolOutcome {
  const revisionNo =
    Number((db.prepare("SELECT COALESCE(MAX(revision_no), 0) AS n FROM revision WHERE task_id = ?").get(taskId) as { n: number }).n) + 1;

  // 先给新增的条目分配编号：流水号取该集合历史上的最大号加一，删过的号不复用。
  const nextSerial = new Map<string, number>();
  for (const collection of definition.collections) {
    const row = db
      .prepare("SELECT COALESCE(MAX(serial), 0) AS n FROM item WHERE task_id = ? AND collection = ?")
      .get(taskId, collection.name) as { n: number };
    nextSerial.set(collection.name, Number(row.n) + 1);
  }
  const outcomes = planned.map((one) => {
    if (one.op === "add") {
      const serial = nextSerial.get(one.collection.name)!;
      nextSerial.set(one.collection.name, serial + 1);
      return {
        op: "add" as const,
        item: `${one.collection.prefix}-${String(serial).padStart(3, "0")}`,
        serial,
        collection: one.collection.name,
        from_revision: null as number | null,
        to_revision: revisionNo as number | null,
      };
    }
    if (one.op === "update") {
      return { op: "update" as const, item: one.itemId, serial: 0, collection: one.collection, from_revision: one.fromRevision, to_revision: revisionNo as number | null };
    }
    if (one.op === "restore") {
      return { op: "restore" as const, item: one.itemId, serial: 0, collection: one.collection, from_revision: one.fromRevision, to_revision: revisionNo as number | null };
    }
    return { op: "delete" as const, item: one.itemId, serial: 0, collection: one.collection, from_revision: one.fromRevision, to_revision: null };
  });

  const at = wallClockText();
  const intentActId = call.intentEntry ? revisionIntent(db, taskId, call.sessionId, call.intentEntry, outcomes.map((one) => one.item)) : null;
  const seq = emit(db, {
    taskId,
    sessionId: call.sessionId,
    callId: call.callId,
    name: EVENT_REVISION_SAVED,
    payload: {
      revision_no: revisionNo,
      ...(typeof params.undo_of_revision === "number" ? { undo_of_revision: params.undo_of_revision } : {}),
      ...(intentActId ? { intent_act_id: intentActId } : {}),
      operations: outcomes.map(({ op, item, collection, from_revision, to_revision }) => ({
        op,
        item,
        collection,
        from_revision,
        to_revision,
      })),
    },
    actor: call.actor ?? ACTOR_EXECUTOR,
  });

  db.prepare(
    "INSERT INTO revision (task_id, revision_no, session_id, call_id, event_seq, created_at, summary, intent_act_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    taskId,
    revisionNo,
    call.sessionId,
    call.callId,
    seq,
    at,
    dump(outcomes.map(({ op, item, collection }) => ({ op, item, collection }))),
    intentActId,
  );
  const insertItem = db.prepare(
    "INSERT INTO item (task_id, item_id, collection, serial, added_in_revision, deleted_in_revision, event_seq, deleted_event_seq) " +
      "VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)",
  );
  const insertVersion = db.prepare(
    "INSERT INTO item_version (task_id, item_id, revision_no, fields, event_seq) VALUES (?, ?, ?, ?, ?)",
  );
  const insertSource = db.prepare(
    "INSERT INTO item_source (task_id, element_kind, item_id, revision_no, position, support_no, kind, locator, excerpt, field, field_index, event_seq, normalized_value, depends_revision) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const markDeleted = db.prepare(
    "UPDATE item SET deleted_in_revision = ?, deleted_event_seq = ? WHERE task_id = ? AND item_id = ?",
  );
  const markRestored = db.prepare(
    "UPDATE item SET deleted_in_revision = NULL, deleted_event_seq = NULL WHERE task_id = ? AND item_id = ?",
  );

  planned.forEach((one, index) => {
    const outcome = outcomes[index];
    if (one.op === "delete") {
      markDeleted.run(revisionNo, seq, taskId, outcome.item);
      return;
    }
    if (one.op === "add") {
      insertItem.run(taskId, outcome.item, outcome.collection, outcome.serial, revisionNo, seq);
    }
    if (one.op === "restore") markRestored.run(taskId, outcome.item);
    insertVersion.run(taskId, outcome.item, revisionNo, dump(one.fields), seq);
    // 一条来源支持几处就展开成几行；支持整个条目时只写一行，字段与序号为空。
    one.sources.forEach((source, position) => {
      const rows: Array<Support | null> = source.supports.length > 0 ? source.supports : [null];
      rows.forEach((support, supportIndex) => {
        insertSource.run(
          taskId, ELEMENT_ITEM, outcome.item, revisionNo, position + 1, supportIndex + 1,
          source.kind, source.locator, source.excerpt, support?.field ?? null, support?.index ?? null, seq, source.normalized_value ?? null,
          // 依据的条目在这一次保存里才新增或修改：它的修订号就是这一次的。
          source.depends_revision === THIS_REVISION ? revisionNo : source.depends_revision ?? null,
        );
      });
    });
  });

  const notes = planned.flatMap((one) => (one.op === "delete" ? [] : one.notes));
  return {
    text: savedText(taskId, revisionNo, outcomes) + notes.map((one) => `\n${one}`).join(""),
    details: {
      task_id: taskId,
      revision_no: revisionNo,
      event_seq: seq,
      undo_of_revision: typeof params.undo_of_revision === "number" ? params.undo_of_revision : null,
      saved: true,
      intent_act_id: intentActId,
      operations: outcomes.map(({ op, item, collection, from_revision, to_revision }) => ({ op, item, collection, from_revision, to_revision })),
    },
  };
}

/** 一次修订里的一个操作写下之后的样子，与 REVISION_SAVED 事件内容里 operations 的每一项同形。 */
interface SavedOperation {
  op: "add" | "update" | "delete" | "restore";
  item: string;
  collection: string;
  from_revision: number | null;
  to_revision: number | null;
}

/** 保存成功时交给模型的文字。 */
function savedText(taskId: string, revisionNo: number, operations: SavedOperation[]): string {
  const lines = operations.map((one, index) => {
    const no = index + 1;
    if (one.op === "add") return fillText("result.save_revision.line_add", { no, item: one.item, collection: one.collection, revision: revisionNo });
    if (one.op === "update") return fillText("result.save_revision.line_update", { no, item: one.item, from: String(one.from_revision), revision: revisionNo });
    if (one.op === "restore") return fillText("result.save_revision.line_restore", { no, item: one.item, revision: revisionNo });
    return fillText("result.save_revision.line_delete", { no, item: one.item, from: String(one.from_revision) });
  });
  return `${fillText("result.save_revision.saved", { task: taskId, revision: revisionNo, count: operations.length })}\n${lines.join("\n")}`;
}

/** 重放时补在第一次的结果文字后面的一句（保存图也用）。 */
export const REPLAYED_TEXT = fillText("result.replayed");

/**
 * 这个调用编号在这个任务里是否已经形成过修订：形成过就按那次修订与它的事件重新拼出第一次的结果（details.replayed 为真），
 * 文字末尾补一句 REPLAYED_TEXT；没有就返回 null。
 */
function savedBefore(db: DatabaseSync, callId: string): ToolOutcome | null {
  const row = db.prepare(
    "SELECT r.task_id, r.revision_no, r.event_seq, r.intent_act_id, e.payload FROM revision r JOIN event e ON e.seq = r.event_seq " +
      "WHERE r.call_id = ? AND r.task_id IN (SELECT task_id FROM task) ORDER BY r.revision_no LIMIT 1",
  ).get(callId) as { task_id: string; revision_no: number; event_seq: number; intent_act_id: string | null; payload: string } | undefined;
  if (!row) return null;
  const payload = (load(row.payload) ?? {}) as { operations?: SavedOperation[]; undo_of_revision?: number };
  const operations = Array.isArray(payload.operations) ? payload.operations : [];
  return {
    text: `${savedText(row.task_id, row.revision_no, operations)}\n${REPLAYED_TEXT}`,
    details: {
      task_id: row.task_id,
      revision_no: row.revision_no,
      event_seq: row.event_seq,
      undo_of_revision: typeof payload.undo_of_revision === "number" ? payload.undo_of_revision : null,
      saved: true,
      replayed: true,
      intent_act_id: row.intent_act_id,
      operations,
    },
  };
}
