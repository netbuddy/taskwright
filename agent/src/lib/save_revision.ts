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
 * 写库、记事件、各项核对同在一个立即事务里；任何一个操作不通过，整次调用全部不写入，
 * 拒绝的文字逐条列出哪个操作的哪一处不对。本模块不依赖 pi。
 *
 * 按调用编号判重（幂等）：同一次工具调用被重放（模型重试、pi 重发）时，库里已有这个调用编号形成的修订，
 * 就不再核对也不再写入，原样交回第一次的结果并注明「之前已经保存过」（savedBefore）；修订表上另有唯一索引兜底（schema.ts）。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ACTOR_EXECUTOR, ACTOR_USER, EVENT_REVISION_SAVED, LEGACY_ACTOR_MODEL, databasePath, dump, emit, load, wallClockText } from "./db.ts";
import {
  type CollectionDef,
  type FieldDef,
  FIELD_ENUM,
  FIELD_ITEM_REF,
  FIELD_TEXT,
  FIELD_TEXT_LIST,
  PROBLEM_RESULT_FIELD,
  type TaskDefinition,
  keepPendingField,
  validateDefinition,
} from "./definition.ts";
import { type CallContext, type ToolOutcome, type UserMessage, activeTasks } from "./create_task.ts";
import {
  DOCX_LOCATOR, PROJECTION_SUFFIXES, SPAN_LIMIT, inTextBox, isLegacyProjection, paragraphsWith, placeExcerpt, projectionParagraphs, projectionTablePositions,
} from "./docx_source.ts";
import { BUSY_TIMEOUT_MS, EXECUTOR_SOURCE_KINDS, NoDatabaseYet, SOURCE_DOCUMENT, SOURCE_DOMAIN_NOTE, SOURCE_KINDS, SOURCE_USER_EDIT, SOURCE_USER_WORDS, withTaskDatabase } from "./schema.ts";
import { revisionIntent } from "./dialogue_acts.ts";

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
}

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
}

/** 发起方写成中文。拒绝原因的事实一层也给人看，所以执行者写作「助手」。 */
function actorText(actor: string): string {
  if (actor === ACTOR_USER) return "用户";
  if (actor === ACTOR_EXECUTOR || actor === LEGACY_ACTOR_MODEL) return "助手";
  return `「${actor}」`;
}

/** 核对通过之后，一个操作要写进库里的样子。 */
type Planned =
  | { op: "add"; collection: CollectionDef; fields: Fields; sources: Source[] }
  | { op: "update"; itemId: string; collection: string; fromRevision: number; fields: Fields; sources: Source[] }
  | { op: "delete"; itemId: string; collection: string; fromRevision: number }
  | { op: "restore"; itemId: string; collection: string; fromRevision: number; fields: Fields; sources: Source[] };

const OP_NAMES: Record<string, string> = { add: "新增", update: "修改", delete: "删除", restore: "恢复" };

/**
 * 拒绝原因分两层：事实（改了什么、为什么不行，一句话，面向人）与指引（接下来该怎么做，只给助手）。
 * 核对函数往 errors 里推的一条文字可以用 withGuide 把两层拼在一起，组装时再拆开。
 * 给模型的正文每个操作两行：「- 操作 N（……）：事实」与「  怎么办：指引」；后端的过程摘要只取事实（work_summary.py）。
 */
export interface RejectReason { label: string; fact: string; guidance: string }
const GUIDE = "\u0000";
export const GUIDANCE_PREFIX = "怎么办：";
function withGuide(fact: string, guidance: string): string {
  return `${fact}${GUIDE}${guidance}`;
}
/** 一个操作的若干条错误拼成一条原因：事实用「；」接起来，指引也是。subject 是事实里没点到条目时补在前面的主语。 */
function reasonOf(label: string, subject: string, errors: string[]): RejectReason {
  const facts: string[] = [];
  const guides: string[] = [];
  for (const one of errors) {
    const [fact, guide] = one.split(GUIDE);
    facts.push(fact);
    if (guide) guides.push(guide);
  }
  const fact = facts.join("；");
  return { label, fact: fact.includes(subject) ? fact : `${subject}：${fact}`, guidance: guides.join("；") };
}
/** 拒绝的正文：给模型看，两层都在。 */
export function rejectionText(reasons: RejectReason[]): string {
  return `这次「保存修订」什么都没有写入，因为有 ${reasons.length} 个操作不对：\n` +
    reasons.map((r) => `- ${r.label}：${r.fact}。${r.guidance ? `\n  ${GUIDANCE_PREFIX}${r.guidance}。` : ""}`).join("\n") +
    "\n请把这些地方改正之后，把整批操作重新提交一次。";
}
/**
 * 保存修订被拒时抛的错：正文是 rejectionText，reasons 带结构化的两层。
 * fact 与 guidance 是逐个操作的两层文字各接成一段（一个操作一行），供拒绝留痕（lib/tool_rejection.ts）分开存。
 */
export class SaveRejected extends Error {
  reasons: RejectReason[];
  fact: string;
  guidance: string;
  constructor(reasons: RejectReason[]) {
    super(rejectionText(reasons));
    this.reasons = reasons;
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
    if (error instanceof NoDatabaseYet) {
      throw new Error(
        "这个任务目录里还没有任务记录，所以没有地方保存修订，什么都没有写入。" +
          "任务由用户在界面上创建，你没有创建任务的工具；请把这个情况如实告诉用户。",
      );
    }
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
  if (running.length === 0) {
    throw new Error(
      "这个任务已经结束（已完成或已放弃），或者库里没有任务记录，所以没有地方保存修订，什么都没有写入。请把这个情况如实告诉用户。",
    );
  }
  if (running.length > 1) {
    throw new Error(
      `这个任务目录里有 ${running.length} 个进行中的任务（${running.map((one) => one.task_id).join("、")}），` +
        "同一时刻只应当有一个，库里的记录有问题，所以没有写入。请把这个情况告诉用户。",
    );
  }
  const taskId = running[0].task_id;
  const definition = validateDefinition(JSON.parse(running[0].definition_text));

  const operations = params.operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error(
      "operations 应当是一个不为空的操作列表，现在不是，所以什么都没有写入。每个操作是新增、修改、删除三种之一，" +
        "例如 { \"op\": \"add\", \"collection\": \"集合名\", \"fields\": { … }, \"sources\": [ … ] }。",
    );
  }

  const items = itemsOf(db, taskId);
  const latestVersion = latestVersionOf(db, taskId);
  const sourcesOf = (itemId: string, revisionNo: number): Source[] => {
    const rows = db
      .prepare(
        "SELECT position, kind, locator, excerpt, field, field_index, normalized_value FROM item_source " +
          "WHERE task_id = ? AND item_id = ? AND revision_no = ? ORDER BY position, support_no",
      )
      .all(taskId, itemId, revisionNo) as unknown as SourceRow[];
    const byPosition = new Map<number, Source>();
    for (const row of rows) {
      let source = byPosition.get(row.position);
      if (!source) {
        source = { kind: row.kind, locator: row.locator, excerpt: row.excerpt, supports: [] };
        if (row.normalized_value !== null) source.normalized_value = row.normalized_value;
        byPosition.set(row.position, source);
      }
      if (row.field !== null) {
        source.supports.push(row.field_index === null ? { field: row.field } : { field: row.field, index: row.field_index });
      }
    }
    return [...byPosition.values()];
  };
  const userMessages = call.userMessages ?? [];
  const materialText = materialReader(call.workspaceDir, definition.materialsDir);

  // 这次调用里要删掉的条目，以及被修改或删除过的条目。先扫一遍，
  // 好让「条目引用」的核对知道哪些条目在这次调用之后就不在了。
  const deletedHere = new Set<string>();
  for (const one of operations) {
    if (isObject(one) && one.op === "delete" && typeof one.item === "string") deletedHere.add(one.item);
  }
  const touched = new Map<string, number>();
  // 这一批里新增的条目会拿到的编号：与 write 里分配编号的规矩相同（集合历史上的最大流水号加一，按操作顺序依次取）。
  // 排在前面的新增操作产生的条目，后面的操作可以引用；引用排在后面才新增的条目仍拒绝。
  const addedAt = new Map<string, number>();
  const { noteRef, noteText } = domainNoteLookups(definition, items, latestVersion, { deletedHere, addedAt });
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
    });
  }

  const problems: RejectReason[] = [];
  const planned: Planned[] = [];

  operations.forEach((raw, index) => {
    const number = index + 1;
    const errors: string[] = [];
    if (!isObject(raw)) {
      problems.push({ label: `操作 ${number}`, fact: `操作 ${number}：它应当是一个对象，现在不是`, guidance: "" });
      return;
    }
    const op = raw.op;
    if (op === "restore" && call.actor !== ACTOR_USER) {
      problems.push({ label: `操作 ${number}`, fact: "助手用了恢复操作（restore），它只给用户在界面上的撤销用", guidance: "要改条目请用 update" });
      return;
    }
    if (op !== "add" && op !== "update" && op !== "delete" && op !== "restore") {
      problems.push({ label: `操作 ${number}`, fact: `操作 ${number} 的种类写成了 ${JSON.stringify(op)}`, guidance: `op 只能是 "add"（新增）、"update"（修改）、"delete"（删除）之一` });
      return;
    }
    const checkRef = (itemId: unknown): string | null => {
      if (typeof itemId !== "string" || itemId.trim() === "") return "应当写一个条目编号";
      const row = items.get(itemId);
      if (!row) {
        const at = addedAt.get(itemId);
        if (at === undefined) return "指向的条目在这个任务里不存在";
        if (at < number) return null;
        return at === number
          ? withGuide("指向的就是这个操作自己要新增的条目", "一个条目不能引用自己")
          : withGuide(`指向的条目 ${itemId} 在这一批里排在第 ${at} 个操作才新增，在这个操作之后`, `请把新增 ${itemId} 的操作排到前面`);
      }
      if (row.deleted_in_revision !== null) return `指向的条目已在修订 ${row.deleted_in_revision} 删除`;
      if (deletedHere.has(itemId)) return "指向的条目在这次调用里被删除";
      return null;
    };

    if (op === "add") {
      const collection = definition.collections.find((one) => one.name === raw.collection);
      const label = `操作 ${number}（新增，集合「${String(raw.collection)}」）`;
      if (!collection) {
        problems.push({ label, fact: `没有名叫「${String(raw.collection)}」的集合`,
          guidance: `可用的集合是：${definition.collections.map((one) => `「${one.name}」`).join("、")}` });
        return;
      }
      if (raw.item !== undefined) errors.push("新增时不要写 item，条目编号由工具生成");
      if (!isObject(raw.fields)) {
        errors.push("fields 应当是一个对象，键是字段名，值是字段内容");
      } else {
        checkFields(collection, raw.fields, checkRef, errors);
        for (const field of collection.fields) {
          if (field.required && isEmptyValue(raw.fields[field.name])) {
            errors.push(`必填字段「${field.name}」没有填或者是空的`);
          }
        }
      }
      if (raw.base_revision !== undefined) errors.push("新增时不要写 base_revision，新条目还没有所在的修订");
      const sources = checkSources(raw.sources, true, errors, call.sessionId, userMessages, call.actor, materialText, noteRef, noteText);
      const fields = isObject(raw.fields) ? dropEmpty(raw.fields) : {};
      if (sources) checkSupports(collection, fields, sources, false, errors);
      if (errors.length > 0) {
        problems.push(reasonOf(label, `新增到「${collection.name}」的条目`, errors));
        return;
      }
      planned.push({ op: "add", collection, fields, sources: sources! });
      return;
    }

    // 修改与删除：条目必须存在且没有被删除。
    const itemId = raw.item;
    const label = `操作 ${number}（${OP_NAMES[op]}，条目 ${String(itemId)}）`;
    if (typeof itemId !== "string" || itemId.trim() === "") {
      problems.push({ label, fact: `助手要${OP_NAMES[op]}条目，但没写是哪个条目`, guidance: `item 应当写要${OP_NAMES[op]}的条目编号，例如 UC-001` });
      return;
    }
    const row = items.get(itemId);
    if (!row) {
      const alive = [...items.values()].filter((one) => one.deleted_in_revision === null).map((one) => one.item_id);
      problems.push({ label, fact: `这个任务里没有条目 ${itemId}`, guidance: `现有的条目是：${alive.length ? alive.join("、") : "（一个都没有）"}` });
      return;
    }
    if (op === "restore" && row.deleted_in_revision === null) {
      problems.push({ label, fact: `${itemId} 没有被删除，不需要恢复`, guidance: "" });
      return;
    }
    if (op !== "restore" && row.deleted_in_revision !== null) {
      problems.push({ label, fact: `助手想${OP_NAMES[op]} ${itemId}，但它已在修订 ${row.deleted_in_revision} 删除`, guidance: "" });
      return;
    }
    if (touched.has(itemId)) {
      problems.push({ label, fact: `同一次保存里 ${itemId} 出现了两次（操作 ${touched.get(itemId)} 已经处理了它）`, guidance: "一个条目在一次调用里只能有一个操作" });
      return;
    }
    touched.set(itemId, number);
    const current = latestVersion(itemId);

    // 改前修订号：模型必须写出它所见的这个条目所在的修订号，与库里的不符就拒绝，免得按旧内容盖掉别人的修改。
    const base = raw.base_revision;
    if (base === undefined || base === null) {
      problems.push({ label, fact: `助手${OP_NAMES[op]} ${itemId} 时没写它看到的是哪次修订`,
        guidance: "修改与删除时要写 base_revision，也就是你所见的这个条目当前所在的修订号（整数），它写在「保存修订」的返回与界面操作的通知里（「UC-001 现在是修订 N」）" });
      return;
    }
    if (typeof base !== "number" || !Number.isInteger(base) || base < 1) {
      problems.push({ label, fact: `助手${OP_NAMES[op]} ${itemId} 时写的修订号 ${JSON.stringify(base)} 不对`, guidance: "base_revision 应当是一个从 1 起的整数" });
      return;
    }
    if (base !== current.revision_no) {
      problems.push({
        label,
        fact: base < current.revision_no
          ? `${itemId} 已经被${actorText(current.actor)}改到修订 ${current.revision_no}，助手看到的还是修订 ${base}`
          : `${itemId} 现在是修订 ${current.revision_no}，助手写的修订 ${base} 不是它当前所在的修订`,
        guidance: `请先读最新内容再改。它在修订 ${current.revision_no} 的内容是：${current.fields}`,
      });
      return;
    }

    if (op === "delete") {
      planned.push({ op: "delete", itemId, collection: row.collection, fromRevision: current.revision_no });
      return;
    }

    const collection = definition.collections.find((one) => one.name === row.collection)!;
    const before = load(current.fields) as Fields;
    let merged: Fields = before;
    if (raw.fields !== undefined && !isObject(raw.fields)) {
      errors.push("fields 应当是一个对象，只写要改的字段");
    } else if (isObject(raw.fields)) {
      checkFields(collection, raw.fields, checkRef, errors);
      if (call.actor !== ACTOR_USER) checkProblemUpdate(collection, itemId, before, raw.fields, errors);
      merged = dropEmpty({ ...before, ...raw.fields });
      for (const field of collection.fields) {
        if (field.required && field.name in raw.fields && isEmptyValue(raw.fields[field.name])) {
          errors.push(`必填字段「${field.name}」改完之后是空的，必填字段不能清空`);
        }
      }
    }
    const previousSources = sourcesOf(itemId, current.revision_no);
    const inherited = raw.sources === undefined;
    let sources = inherited ? previousSources : checkSources(raw.sources, true, errors, call.sessionId, userMessages, call.actor, materialText, noteRef, noteText);
    if (sources && !inherited && call.actor !== ACTOR_USER && isObject(raw.fields) && Object.keys(raw.fields).length > 0) {
      // 执行者修改时给了新来源：只替换这次改到的字段上的来源，其余字段的来源沿用。
      // 条目当前的来源里，支持改到的字段的那几处去掉，去掉之后什么都不支持的整条去掉，支持整个条目的保留；
      // 「用户直接修改」执行者填不了，按同一条规则沿用。只给 sources、不改任何字段时，仍是整体替换（重新标注来源）。
      sources = [...carriedSources(previousSources, new Set(Object.keys(raw.fields)), sources), ...sources];
    }
    if (sources) checkSupports(collection, merged, sources, inherited, errors);
    if (op !== "restore" && errors.length === 0 && sameJson(merged, before) && sameJson(sources, previousSources)) {
      errors.push(withGuide(`助手对 ${itemId} 的修改与它在修订 ${current.revision_no} 的内容和来源完全一样，没有改动任何东西`, "不需要改就去掉这个操作"));
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
    });
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
 * 种类为「领域说明」的来源要用的两个查法。noteRef：出处是不是「领域说明」集合里还在的条目（这次调用之前就有，
 * 也没在这次调用里删），是就返回 null，不是返回原因。noteText：那条领域说明当前修订的各文本字段（标题、内容之类，
 * 按任务定义的字段类型取），摘录要逐字出现在其中之一里。batch 是这一批的删除与新增；不是一批操作（例如「回复」核对依据）时给空的。
 */
function domainNoteLookups(
  definition: TaskDefinition,
  items: Map<string, ItemRow>,
  latestVersion: (itemId: string) => VersionRow,
  batch: { deletedHere: Set<string>; addedAt: Map<string, number> },
): { noteRef: (locator: string) => string | null; noteText: (locator: string) => string[] } {
  const noteRef = (locator: string): string | null => {
    if (!definition.collections.some((one) => one.name === SOURCE_DOMAIN_NOTE)) return `这个任务没有「${SOURCE_DOMAIN_NOTE}」集合`;
    const row = items.get(locator);
    // 条目引用字段可以指向同一批里排在前面新增的条目（见 save 里的 addedAt），领域说明来源不行：摘录要对着那条说明已经保存的文字逐字核对。
    if (!row && batch.addedAt.has(locator)) return "指向的领域说明在这一批里才新增，还没有保存，摘录无从核对";
    if (!row || row.collection !== SOURCE_DOMAIN_NOTE) return `不是这个任务里「${SOURCE_DOMAIN_NOTE}」集合的条目编号`;
    if (row.deleted_in_revision !== null) return `指向的领域说明已在修订 ${row.deleted_in_revision} 删除`;
    if (batch.deletedHere.has(locator)) return "指向的领域说明在这次调用里被删除";
    return null;
  };
  const noteText = (locator: string): string[] => {
    const collection = definition.collections.find((one) => one.name === SOURCE_DOMAIN_NOTE);
    const fields = JSON.parse(latestVersion(locator).fields) as Record<string, unknown>;
    return (collection?.fields ?? []).flatMap((field) => {
      const value = fields[field.name];
      if (field.type === FIELD_TEXT && typeof value === "string") return [value];
      if (field.type === FIELD_TEXT_LIST && Array.isArray(value)) return value.filter((one): one is string => typeof one === "string");
      return [];
    });
  };
  return { noteRef, noteText };
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
 * 用户的话逐字出自当前会话分支上的某句用户消息（出处由这里代填），领域说明逐字出自那条还在的领域说明；执行者补充不核对摘录。
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
): CheckedQuote[] | null {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) {
    errors.push("这个任务目录还没有任务记录，依据无从核对");
    return null;
  }
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
      { task_id: string; definition_text: string } | undefined;
    if (!task) {
      errors.push("这个任务目录还没有任务记录，依据无从核对");
      return null;
    }
    const definition = validateDefinition(JSON.parse(task.definition_text));
    const items = itemsOf(db, task.task_id);
    const { noteRef, noteText } = domainNoteLookups(definition, items, latestVersionOf(db, task.task_id), { deletedHere: new Set(), addedAt: new Map() });
    const checked = checkSources(raw, true, errors, sessionId, userMessages, ACTOR_EXECUTOR, materialReader(workspaceDir, definition.materialsDir),
      noteRef, noteText, whereOf);
    return checked && checked.map(({ kind, locator, excerpt, normalized_value }) => ({ kind, locator, excerpt, ...(normalized_value ? { normalized_value } : {}) }));
  } finally {
    db.close();
  }
}

/** 把核对函数推进 errors 的一条拆成事实与指引两层；没有指引层时指引是空文字。 */
export function splitGuide(one: string): { fact: string; guidance: string } {
  const [fact, guidance] = one.split(GUIDE);
  return { fact, guidance: guidance ?? "" };
}

/**
 * 修改时沿用条目当前的哪些来源：支持 changed 里的字段的那几处去掉；去掉之后什么都不支持的整条去掉；
 * 本来就支持整个条目的保留；与这次新给的某条来源一模一样的不重复保留。
 */
export function carriedSources(previous: Source[], changed: Set<string>, given: Source[]): Source[] {
  const kept: Source[] = [];
  for (const source of previous) {
    const supports = source.supports.filter((support) => !changed.has(support.field));
    if (source.supports.length > 0 && supports.length === 0) continue;
    const one = { ...source, supports };
    if (given.some((other) => sameJson(other, one))) continue;
    kept.push(one);
  }
  return kept;
}

/**
 * 问题条目（集合里有取值含「用户决定保留」的状态字段，见 keepPendingField）写下之后，执行者修改它时
 * 只能改状态与处理结果：用户的回答要写进它牵涉的条目，而不是写回问题本身。值没有变的字段不算改。
 * 新增不受限；用户在界面上的操作（先不管、撤销）不经这里核对。
 */
function checkProblemUpdate(collection: CollectionDef, itemId: string, before: Fields, fields: Fields, errors: string[]): void {
  const status = keepPendingField(collection);
  if (!status) return;
  const changed = Object.keys(fields).filter((name) => {
    if (name === status.name || name === PROBLEM_RESULT_FIELD) return false;
    if (!collection.fields.some((one) => one.name === name)) return false;   // 没有这个字段，checkFields 已经说过
    const value = fields[name];
    return !(isEmptyValue(value) ? isEmptyValue(before[name]) : sameJson(value, before[name]));
  });
  if (changed.length === 0) return;
  errors.push(withGuide(
    `助手想改 ${itemId} 的${changed.map((name) => `「${name}」`).join("、")}，但问题条目写下后只能改${status.name}与${PROBLEM_RESULT_FIELD}`,
    "用户的回答要写进它牵涉的条目（关联条目里列的那些），改完再问用户这个问题是否已解决",
  ));
}

/** 核对一组字段：字段名都在集合的声明里，值的类型对得上。 */
function checkFields(
  collection: CollectionDef,
  fields: Record<string, unknown>,
  checkRef: (itemId: unknown) => string | null,
  errors: string[],
): void {
  const declared = new Map<string, FieldDef>(collection.fields.map((one) => [one.name, one]));
  for (const [name, value] of Object.entries(fields)) {
    const field = declared.get(name);
    if (!field) {
      errors.push(
        `集合「${collection.name}」没有字段「${name}」，可用的字段是${collection.fields.map((one) => `「${one.name}」`).join("、")}`,
      );
      continue;
    }
    if (field.type === FIELD_ITEM_REF) {
      // 条目引用的值一律是条目编号的字符串数组，可以是空数组；单个字符串也要写成数组。
      if (!Array.isArray(value)) {
        errors.push(
          `字段「${name}」是条目引用类型，应当写成条目编号的数组，例如 ["UC-001"]；` +
            `现在写的是 ${JSON.stringify(value)}，只有一个编号也要放进数组里，不关联任何条目就写 []`,
        );
        continue;
      }
      value.forEach((one, index) => {
        const reason = typeof one === "string" ? checkRef(one) : "应当写一个条目编号";
        if (reason) errors.push(`字段「${name}」是条目引用类型，第 ${index + 1} 个编号 ${JSON.stringify(one)} ${reason}`);
      });
      continue;
    }
    if (isEmptyValue(value) && (typeof value === "string" || Array.isArray(value))) continue;
    if (field.type === FIELD_TEXT && typeof value !== "string") {
      errors.push(`字段「${name}」是文本类型，应当写一个字符串`);
    } else if (field.type === FIELD_TEXT_LIST) {
      if (!Array.isArray(value) || !value.every((one) => typeof one === "string")) {
        errors.push(`字段「${name}」是文本列表类型，应当写一个字符串数组，一步或一条一项`);
      }
    } else if (field.type === FIELD_ENUM) {
      if (typeof value !== "string" || !(field.values ?? []).includes(value)) {
        errors.push(
          `字段「${name}」是枚举类型，写的是 ${JSON.stringify(value)}，只能是${(field.values ?? []).map((one) => `「${one}」`).join("、")}之一`,
        );
      }
    }
  }
}

/**
 * 按出处读材料文件的全文（换行归一为 \n），读不到返回 null。出处按任务目录下的相对路径找，
 * 找不到再到材料目录里按文件名找；同一次保存里读过的不再读。
 */
function materialReader(workspaceDir: string, materialsDir: string): (locator: string) => string | null {
  const cache = new Map<string, string | null>();
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
    } catch {
      return null;
    }
  };
  return (locator) => {
    if (!cache.has(locator)) {
      const direct = isAbsolute(locator) ? locator : join(workspaceDir, locator);
      cache.set(locator, read(direct) ?? read(join(workspaceDir, materialsDir, basename(locator))));
    }
    return cache.get(locator)!;
  };
}

/** 摘录在材料里找不到时，拒绝文字「怎么办」一层的第一句（模型常自行补句号或改写，被拒后又干脆删掉引用）。 */
const EXACT_EXCERPT = "摘录必须与材料原文逐字一致，包括标点；不要自行补标点或改写";

/** 摘录里的空行（一个或多个只含空白的行）。 */
const BLANK_LINE = /\n\s*\n/;

/** 摘录不连续时，拒绝文字「怎么办」一层说明引几处写几条来源的那一句。 */
const SEVERAL_PLACES = "引了材料几处就写几条来源";

/** 摘录在材料里有好几处时，拒绝的文字里最多列出离原段落号最近的这么多处。 */
const NEARBY_LIMIT = 6;

/** 摘录超过这么多个字时，拒绝的文字里只引前这么多个字。 */
const EXCERPT_QUOTE_LIMIT = 30;

/** 拒绝文字里引摘录：换行写成空格，免得一句话断成几行；长的只引前 30 字。 */
function quoteOf(excerpt: string): string {
  const flat = excerpt.replace(/\s*\n\s*/g, " ");
  return flat.length > EXCERPT_QUOTE_LIMIT ? `${flat.slice(0, EXCERPT_QUOTE_LIMIT)}…` : flat;
}

/**
 * 核对来源列表：至少一条，每条三项齐全、种类是三者之一，supports 的形状对。通过就返回整理好的列表。
 * 种类为「用户的话」的来源，出处在这里代填（见文件开头的说明）；supports 所指的字段是否存在、
 * 序号是否在范围内，要等字段合并完才知道，另由 checkSupports 核对。
 *
 * 种类为「领域说明」的来源，出处去掉首尾空白后由 noteRef 核对是「领域说明」集合里还在的条目，摘录（去掉首尾空白）要逐字
 * 出现在那条领域说明当前修订的某个文本字段里（noteText 给出这些文字），与「文档原文」同一个规矩；用户在界面上的操作不核对，
 * 撤销时原样交回旧来源。
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
  materialText?: (locator: string) => string | null,
  noteRef?: (locator: string) => string | null,
  noteText?: (locator: string) => string[],
  whereOf: (index: number) => string = (index) => `第 ${index + 1} 条来源`,
): Source[] | null {
  if (raw === undefined || raw === null) {
    if (required) errors.push("缺少 sources，至少要有一条来源");
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push("sources 应当是一个不为空的列表，至少要有一条来源");
    return null;
  }
  const kept: Source[] = [];
  let ok = true;
  raw.forEach((one, index) => {
    const where = whereOf(index);
    if (!isObject(one)) {
      errors.push(`${where}应当是一个对象，有 kind、locator、excerpt 三项`);
      ok = false;
      return;
    }
    const missing: string[] = [];
    // 「用户直接修改」只由用户在界面上的直接操作经扩展命令写，执行者只能填前三种。
    const allowed: readonly string[] = actor === ACTOR_USER ? SOURCE_KINDS : EXECUTOR_SOURCE_KINDS;
    if (one.kind === SOURCE_USER_EDIT && actor !== ACTOR_USER) {
      errors.push(withGuide(`${where}的种类写成了「${SOURCE_USER_EDIT}」，这一种只由系统在用户直接改字段时写`,
        `kind 只能是${EXECUTOR_SOURCE_KINDS.map((kind) => `「${kind}」`).join("、")}之一`));
      ok = false;
    } else if (typeof one.kind !== "string" || !allowed.includes(one.kind)) {
      errors.push(
        `${where}的 kind 写的是 ${JSON.stringify(one.kind)}，只能是${allowed.map((kind) => `「${kind}」`).join("、")}之一`,
      );
      ok = false;
    }
    const userWords = one.kind === SOURCE_USER_WORDS;
    if (!userWords && (typeof one.locator !== "string" || one.locator.trim() === "")) missing.push("locator（出处）");
    if (typeof one.excerpt !== "string" || one.excerpt.trim() === "") missing.push("excerpt（摘录的原文）");
    if (missing.length > 0) {
      errors.push(`${where}缺少 ${missing.join("、")}`);
      ok = false;
      return;
    }
    let normalized: string | undefined;
    if (one.normalized_value !== undefined && one.normalized_value !== null) {
      if (!userWords) {
        errors.push(`${where}写了 normalized_value；它只用于种类为「用户的话」的来源，别的种类不写`);
        ok = false;
        return;
      }
      if (typeof one.normalized_value !== "string" || one.normalized_value.trim() === "") {
        errors.push(`${where}的 normalized_value 应当是一段不为空的文字（写进字段的值），与原话相同就不写`);
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
    let locator = one.locator as string;
    if (one.kind === SOURCE_DOMAIN_NOTE && actor !== ACTOR_USER && noteRef) {
      locator = locator.trim();
      const reason = noteRef(locator);
      if (reason) {
        errors.push(withGuide(`${where}的种类是「${SOURCE_DOMAIN_NOTE}」，出处 ${locator} ${reason}`,
          `出处写一条还在的领域说明的条目编号，例如 DN-001；要引用的说明还没有记下，先新增它，保存之后再引用`));
        ok = false;
        return;
      }
      const excerpt = (one.excerpt as string).trim();
      if (noteText && !noteText(locator).some((text) => text.includes(excerpt))) {
        errors.push(withGuide(`${where}的摘录「${quoteOf(excerpt)}」在 ${locator} 的当前修订里找不到`,
          `摘录必须逐字一致，包括标点，抄自这条领域说明的标题或内容里连续的一段`));
        ok = false;
        return;
      }
    }
    const keepLocator =
      userWords && actor === ACTOR_USER && typeof one.locator === "string" && one.locator.includes("#");
    if (userWords && !keepLocator) {
      // 从最近往前找逐字包含这段摘录的用户消息；模型写的 locator 不用，一律由这里代填。
      // 例外：用户在界面上撤销时，扩展命令把旧修订下的来源原样交回来，出处早已是「会话编号#条目编号」，照旧保留。
      const excerpt = one.excerpt as string;
      const hit = [...userMessages].reverse().find((message) => message.text.includes(excerpt));
      if (!hit) {
        errors.push(withGuide(`${where}引用的用户的话「${excerpt}」在对话里没有找到`, "请逐字摘录用户说过的原话"));
        ok = false;
        return;
      }
      locator = userWordsLocator(sessionId, hit.entryId);
    }
    const docx = DOCX_LOCATOR.exec(locator);
    if (one.kind === SOURCE_DOCUMENT && actor !== ACTOR_USER && materialText && /\.docx\.(txt|md)$/i.test(locator)) {
      errors.push(withGuide(`${where}的出处 ${locator} 是由 Word 文件生成的投影，不是材料本身`,
        `出处写 Word 文件加段落号，例如 ${locator.replace(/\.(txt|md)$/i, "")}#p12`));
      ok = false;
      return;
    }
    if (one.kind === SOURCE_DOCUMENT && actor !== ACTOR_USER && materialText && docx) {
      const found = checkDocxSource(docx[1], docx[2] ? Number(docx[2]) : null, one.excerpt as string, where, materialText, errors);
      if (found === null) {
        ok = false;
        return;
      }
      locator = found;
    } else if (one.kind === SOURCE_DOCUMENT && actor !== ACTOR_USER && materialText) {
      const excerpt = (one.excerpt as string).replace(/\r\n/g, "\n").trim();
      const text = materialText(locator);
      if (text === null) {
        errors.push(withGuide(`${where}的出处 ${locator} 不是任务目录里能读到的材料文件`, "出处要写材料文件的路径，例如 inputs/材料.md"));
        ok = false;
        return;
      }
      if (!text.includes(excerpt)) {
        errors.push(withGuide(BLANK_LINE.test(excerpt)
          ? `${where}的摘录在 ${basename(locator)} 里不是连续的一段原文`
          : `${where}的摘录「${quoteOf(excerpt)}」在 ${basename(locator)} 里找不到`,
        `${EXACT_EXCERPT}；摘录必须逐字抄自材料里连续的一段，不要跳句拼接或改字；${SEVERAL_PLACES}`));
        ok = false;
        return;
      }
    }
    kept.push({ kind: one.kind as string, locator, excerpt: one.excerpt as string, supports, ...(normalized ? { normalized_value: normalized } : {}) });
  });
  return ok ? kept : null;
}

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
  materialText: (locator: string) => string | null,
  errors: string[],
): string | null {
  const name = basename(path);
  const suffix = PROJECTION_SUFFIXES.find((s) => materialText(`${path}${s}`) !== null);
  const projection = suffix ? materialText(`${path}${suffix}`)! : null;
  const pointer = projection !== null && isLegacyProjection(projection)
    ? `段落号见 ${name}${suffix} 每行开头的「第 N 段」`
    : `段落号见 ${name}${suffix ?? ".md"} 里每段前面方括号中的 p 加数字（例如 [p12]）`;
  if (n === null) {
    errors.push(withGuide(`${where}的出处 ${path} 没有写段落号`, `Word 材料的出处要写段落号，例如 ${path}#p12；${pointer}`));
    return null;
  }
  if (projection === null) {
    errors.push(withGuide(`${where}的出处 ${path} 不是任务目录里能读到的 Word 材料（找不到由它生成的 ${name}.md）`,
      "出处要写材料目录里的 Word 文件加段落号，例如 inputs/材料.docx#p12"));
    return null;
  }
  const paragraphs = projectionParagraphs(projection);
  if (n < 1 || n > paragraphs.length) {
    errors.push(withGuide(`${where}的出处写的是第 ${n} 段，${name} 一共只有 ${paragraphs.length} 段`, pointer));
    return null;
  }
  const excerpt = raw.replace(/\r\n/g, "\n").trim();
  if (placeExcerpt(paragraphs, n, excerpt).kind !== "miss") return `${path}#p${n}`;
  // 摘录在别处：只有一处时指给它；有好几处（短摘录、表格里的数字常这样）时不替模型挑一段，按离第 n 段的远近列出几处
  // （带表格位置），请它按上下文确认——只给一个段号时，模型会照抄，写出逐字对得上但出处指错地方的来源。
  const positions = projectionTablePositions(projection);
  const labelOf = (m: number) => `第 ${m} 段${positions.has(m) ? `·${positions.get(m)}` : ""}`;
  const elsewhere = paragraphsWith(paragraphs, excerpt).filter((m) => m !== n);
  const head = `${where}的摘录「${quoteOf(excerpt)}」在 ${name} ${labelOf(n)}里找不到`;
  if (elsewhere.length === 1) {
    errors.push(withGuide(`${head}，它在${labelOf(elsewhere[0])}`, `出处改写成 ${path}#p${elsewhere[0]}`));
  } else if (elsewhere.length > 1) {
    const near = [...elsewhere].sort((a, b) => Math.abs(a - n) - Math.abs(b - n) || a - b).slice(0, NEARBY_LIMIT).sort((a, b) => a - b);
    const more = elsewhere.length > near.length ? `等 ${elsewhere.length} 处` : "";
    errors.push(withGuide(`${head}；这段文字在${near.map(labelOf).join("、")}${more}都有`,
      "请按上下文确认是哪一段，出处写那一段的段落号"));
  } else if (BLANK_LINE.test(excerpt)) {
    // 摘录里有空行、整段在材料里哪儿都不是连续的一段：多半是把不相邻的几处写进了一条来源。
    errors.push(withGuide(`${where}的摘录在 ${name} 的 p${n} 及其后 ${SPAN_LIMIT} 段里不是连续的一段原文`, `${SEVERAL_PLACES}，每条各写段落号`));
  } else if (inTextBox(projection, excerpt)) {
    errors.push(withGuide(`${head}；这段文字在文本框里，文本框里的文字不能作出处`,
      "请改引正文里说到同一件事的段落；正文里没有，就不要把这一处当作来源"));
  } else {
    errors.push(withGuide(head,
      `${EXACT_EXCERPT}；摘录必须逐字抄自那一段的正文（不带段落号、编号与 #、- 这些标记），不要跳句拼接或改字；${SEVERAL_PLACES}，每条各写段落号`));
  }
  return null;
}

/** 核对一条来源的 supports 的形状：省略或空列表表示支持整个条目；每一项有 field，可以有从 0 起的整数 index。 */
function checkSupportShape(raw: unknown, where: string, errors: string[]): Support[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${where}的 supports 应当是一个列表，每一项形如 { "field": "字段名", "index": 0 }；支持整个条目就写 [] 或者不写`);
    return null;
  }
  const kept: Support[] = [];
  let ok = true;
  raw.forEach((one, index) => {
    const at = `${where}的 supports 第 ${index + 1} 项`;
    if (!isObject(one) || typeof one.field !== "string" || one.field.trim() === "") {
      errors.push(`${at}应当是 { "field": "字段名" } 或 { "field": "字段名", "index": 从 0 起的整数 }`);
      ok = false;
      return;
    }
    if (one.index !== undefined && one.index !== null) {
      if (typeof one.index !== "number" || !Number.isInteger(one.index) || one.index < 0) {
        errors.push(`${at}的 index 应当是从 0 起的整数，现在写的是 ${JSON.stringify(one.index)}`);
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
    const where = `${inherited ? "沿用下来的" : ""}第 ${position + 1} 条来源`;
    const tail = inherited ? "；请在这个操作里重新给出 sources" : "";
    for (const support of source.supports) {
      const field = declared.get(support.field);
      if (!field) {
        errors.push(
          `${where}说它支持字段「${support.field}」，集合「${collection.name}」没有这个字段，` +
            `可用的字段是${collection.fields.map((one) => `「${one.name}」`).join("、")}${tail}`,
        );
        continue;
      }
      const value = fields[support.field];
      if (isEmptyValue(value)) {
        errors.push(withGuide(`${where}说它支持字段「${support.field}」，这个字段在改后的内容里是空的`,
          inherited ? "请在这个操作里重新给出 sources" : "不要让来源指到空字段"));
        continue;
      }
      if (support.index === undefined) continue;
      if (field.type !== FIELD_TEXT_LIST && field.type !== FIELD_ITEM_REF) {
        errors.push(`${where}给字段「${support.field}」写了 index，这个字段是${field.type}类型，只有列表型的字段才能指到其中一项${tail}`);
        continue;
      }
      const length = Array.isArray(value) ? value.length : 0;
      if (support.index >= length) {
        errors.push(
          `${where}指到字段「${support.field}」的第 ${support.index} 项（从 0 起），这个字段改后只有 ${length} 项，` +
            `index 最大是 ${length - 1}${tail}`,
        );
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
    "INSERT INTO item_source (task_id, item_id, revision_no, position, support_no, kind, locator, excerpt, field, field_index, event_seq, normalized_value) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          taskId, outcome.item, revisionNo, position + 1, supportIndex + 1,
          source.kind, source.locator, source.excerpt, support?.field ?? null, support?.index ?? null, seq, source.normalized_value ?? null,
        );
      });
    });
  });

  return {
    text: savedText(taskId, revisionNo, outcomes),
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
    if (one.op === "add") return `${index + 1}. 新增了条目 ${one.item}（集合「${one.collection}」），${one.item} 现在是修订 ${revisionNo}。`;
    if (one.op === "update") return `${index + 1}. 修改了条目 ${one.item}（改前在修订 ${one.from_revision}），${one.item} 现在是修订 ${revisionNo}。`;
    if (one.op === "restore") return `${index + 1}. 恢复了条目 ${one.item}，恢复成删除前的样子，${one.item} 现在是修订 ${revisionNo}。`;
    return `${index + 1}. 删除了条目 ${one.item}（删除前在修订 ${one.from_revision}）。`;
  });
  return `已保存为任务 ${taskId} 的修订 ${revisionNo}，一共 ${operations.length} 个操作：\n${lines.join("\n")}`;
}

/** 重放时补在第一次的结果文字后面的一句。 */
export const REPLAYED_TEXT = "这次调用之前已经保存过，没有重复写入。";

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
