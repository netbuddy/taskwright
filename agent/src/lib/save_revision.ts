/**
 * 「保存修订」的核心逻辑：执行者交来一批按条目的操作（新增、修改、删除），它们一起形成整份交付物的
 * 一次新修订。
 *
 * 这里的核对全部是事实与形式核对：集合与字段是否存在、值的类型是否对得上、必填字段是否为空、
 * 来源三项是否齐全、来源所支持的字段是否存在、被改被删的条目是否存在、改前版本号是否还是当前版本。
 * 代码不判断内容好坏，没有任何关键词清单；用例写得好不好、EARS 句式对不对，由评审者对照规矩文档判断。
 *
 * 种类为「用户的话」的来源，出处由本函数代填：在调用方交来的当前会话分支的用户消息里，从最近往前找
 * 逐字包含这段摘录的那一条，填「会话编号#会话条目编号」；找不到就拒绝。模型看不到会话条目编号，
 * 所以不让它填；这一步同时是一条逐字核对。
 *
 * 写库、记事件、各项核对同在一个立即事务里；任何一个操作不通过，整次调用全部不写入，
 * 拒绝的文字逐条列出哪个操作的哪一处不对。本模块不依赖 pi。
 */

import type { DatabaseSync } from "node:sqlite";
import { ACTOR_EXECUTOR, ACTOR_USER, EVENT_REVISION_SAVED, LEGACY_ACTOR_MODEL, dump, emit, load, wallClockText } from "./db.ts";
import {
  type CollectionDef,
  type FieldDef,
  FIELD_ENUM,
  FIELD_ITEM_REF,
  FIELD_TEXT,
  FIELD_TEXT_LIST,
  type TaskDefinition,
  validateDefinition,
} from "./definition.ts";
import { type CallContext, type ToolOutcome, type UserMessage, activeTasks } from "./create_task.ts";
import { EXECUTOR_SOURCE_KINDS, NoDatabaseYet, SOURCE_KINDS, SOURCE_USER_EDIT, SOURCE_USER_WORDS, withTaskDatabase } from "./schema.ts";

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
  base_version?: unknown;
}

type Fields = Record<string, unknown>;

interface ItemRow {
  item_id: string;
  collection: string;
  serial: number;
  deleted_in_revision: number | null;
}

interface VersionRow {
  version_no: number;
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
}

/** 发起方写成给模型看的中文。 */
function actorText(actor: string): string {
  if (actor === ACTOR_USER) return "用户";
  if (actor === ACTOR_EXECUTOR || actor === LEGACY_ACTOR_MODEL) return "执行者";
  return `「${actor}」`;
}

/** 核对通过之后，一个操作要写进库里的样子。 */
type Planned =
  | { op: "add"; collection: CollectionDef; fields: Fields; sources: Source[] }
  | { op: "update"; itemId: string; collection: string; fromVersion: number; fields: Fields; sources: Source[] }
  | { op: "delete"; itemId: string; collection: string; fromVersion: number }
  | { op: "restore"; itemId: string; collection: string; fromVersion: number; fields: Fields; sources: Source[] };

const OP_NAMES: Record<string, string> = { add: "新增", update: "修改", delete: "删除", restore: "恢复" };

/**
 * 「保存修订」的参数。operations 是模型或扩展命令交来的操作列表；undo_of_revision 只由用户在界面上的
 * 「撤销」经扩展命令填，写进事件内容，说明这次修订是在撤销第几次修订。
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

/** 执行一次「保存修订」。拒绝一律用抛异常的方式，抛出的文字原样交给模型。 */
export function saveRevision(call: CallContext, params: SaveRevisionParams): ToolOutcome {
  try {
    return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => save(db, call, params));
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

  const items = new Map<string, ItemRow>();
  for (const row of db
    .prepare("SELECT item_id, collection, serial, deleted_in_revision FROM item WHERE task_id = ?")
    .all(taskId) as unknown as ItemRow[]) {
    items.set(row.item_id, row);
  }
  // 当前版本连同产生它的那条事件的发起方一起取，版本号对不上时好告诉模型是谁改的。
  const latestVersion = (itemId: string): VersionRow =>
    db
      .prepare(
        "SELECT v.version_no, v.fields, e.actor FROM item_version v JOIN event e ON e.seq = v.event_seq " +
          "WHERE v.task_id = ? AND v.item_id = ? ORDER BY v.version_no DESC LIMIT 1",
      )
      .get(taskId, itemId) as unknown as VersionRow;
  const sourcesOf = (itemId: string, versionNo: number): Source[] => {
    const rows = db
      .prepare(
        "SELECT position, kind, locator, excerpt, field, field_index FROM item_source " +
          "WHERE task_id = ? AND item_id = ? AND version_no = ? ORDER BY position, support_no",
      )
      .all(taskId, itemId, versionNo) as unknown as SourceRow[];
    const byPosition = new Map<number, Source>();
    for (const row of rows) {
      let source = byPosition.get(row.position);
      if (!source) {
        source = { kind: row.kind, locator: row.locator, excerpt: row.excerpt, supports: [] };
        byPosition.set(row.position, source);
      }
      if (row.field !== null) {
        source.supports.push(row.field_index === null ? { field: row.field } : { field: row.field, index: row.field_index });
      }
    }
    return [...byPosition.values()];
  };
  const userMessages = call.userMessages ?? [];

  // 这次调用里要删掉的条目，以及被修改或删除过的条目。先扫一遍，
  // 好让「条目引用」的核对知道哪些条目在这次调用之后就不在了。
  const deletedHere = new Set<string>();
  for (const one of operations) {
    if (isObject(one) && one.op === "delete" && typeof one.item === "string") deletedHere.add(one.item);
  }
  const touched = new Map<string, number>();

  const problems: string[] = [];
  const planned: Planned[] = [];

  operations.forEach((raw, index) => {
    const number = index + 1;
    const errors: string[] = [];
    if (!isObject(raw)) {
      problems.push(`操作 ${number}：它应当是一个对象，现在不是。`);
      return;
    }
    const op = raw.op;
    if (op === "restore" && call.actor !== ACTOR_USER) {
      problems.push(`操作 ${number}：restore（恢复删掉的条目）只给用户在界面上的撤销用，这里不能用；要改条目请用 update。`);
      return;
    }
    if (op !== "add" && op !== "update" && op !== "delete" && op !== "restore") {
      problems.push(`操作 ${number}：op 写的是 ${JSON.stringify(op)}，只能是 "add"（新增）、"update"（修改）、"delete"（删除）之一。`);
      return;
    }
    const checkRef = (itemId: unknown): string | null => {
      if (typeof itemId !== "string" || itemId.trim() === "") return "应当写一个条目编号";
      const row = items.get(itemId);
      if (!row) return "指向的条目在这个任务里不存在";
      if (row.deleted_in_revision !== null) return `指向的条目已在第 ${row.deleted_in_revision} 次修订删除`;
      if (deletedHere.has(itemId)) return "指向的条目在这次调用里被删除";
      return null;
    };

    if (op === "add") {
      const collection = definition.collections.find((one) => one.name === raw.collection);
      const label = `操作 ${number}（新增，集合「${String(raw.collection)}」）`;
      if (!collection) {
        problems.push(
          `${label}：没有名叫「${String(raw.collection)}」的集合。可用的集合是：` +
            `${definition.collections.map((one) => `「${one.name}」`).join("、")}。`,
        );
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
      if (raw.base_version !== undefined) errors.push("新增时不要写 base_version，新条目还没有版本");
      const sources = checkSources(raw.sources, true, errors, call.sessionId, userMessages, call.actor);
      const fields = isObject(raw.fields) ? dropEmpty(raw.fields) : {};
      if (sources) checkSupports(collection, fields, sources, false, errors);
      if (errors.length > 0) {
        problems.push(`${label}：${errors.join("；")}。`);
        return;
      }
      planned.push({ op: "add", collection, fields, sources: sources! });
      return;
    }

    // 修改与删除：条目必须存在且没有被删除。
    const itemId = raw.item;
    const label = `操作 ${number}（${OP_NAMES[op]}，条目 ${String(itemId)}）`;
    if (typeof itemId !== "string" || itemId.trim() === "") {
      problems.push(`${label}：item 应当写要${OP_NAMES[op]}的条目编号，例如 UC-001。`);
      return;
    }
    const row = items.get(itemId);
    if (!row) {
      const alive = [...items.values()].filter((one) => one.deleted_in_revision === null).map((one) => one.item_id);
      problems.push(
        `${label}：这个任务里没有条目 ${itemId}。现有的条目是：${alive.length ? alive.join("、") : "（一个都没有）"}。`,
      );
      return;
    }
    if (op === "restore" && row.deleted_in_revision === null) {
      problems.push(`${label}：这个条目没有被删除，不需要恢复。`);
      return;
    }
    if (op !== "restore" && row.deleted_in_revision !== null) {
      problems.push(`${label}：这个条目已在第 ${row.deleted_in_revision} 次修订删除，不能再${OP_NAMES[op]}。`);
      return;
    }
    if (touched.has(itemId)) {
      problems.push(`${label}：同一次调用里操作 ${touched.get(itemId)} 已经处理了这个条目，一个条目在一次调用里只能有一个操作。`);
      return;
    }
    touched.set(itemId, number);
    const current = latestVersion(itemId);

    // 改前版本号：模型必须写出它所见的版本号，与库里的当前版本不符就拒绝，免得按旧内容盖掉别人的修改。
    const base = raw.base_version;
    if (base === undefined || base === null) {
      problems.push(
        `${label}：缺少 base_version。修改与删除时要写你所见的这个条目的版本号（整数），` +
          "它写在「保存修订」的返回与界面操作的通知里（「这是它的第 N 版」「从第 N 版变成第 M 版」）。",
      );
      return;
    }
    if (typeof base !== "number" || !Number.isInteger(base) || base < 1) {
      problems.push(`${label}：base_version 应当是一个从 1 起的整数，现在写的是 ${JSON.stringify(base)}。`);
      return;
    }
    if (base !== current.version_no) {
      problems.push(
        `${label}：条目 ${itemId} 已经被${actorText(current.actor)}改到第 ${current.version_no} 版（你看到的是第 ${base} 版），` +
          `请先读最新内容再改。它现在第 ${current.version_no} 版的内容是：${current.fields}`,
      );
      return;
    }

    if (op === "delete") {
      planned.push({ op: "delete", itemId, collection: row.collection, fromVersion: current.version_no });
      return;
    }

    const collection = definition.collections.find((one) => one.name === row.collection)!;
    const before = load(current.fields) as Fields;
    let merged: Fields = before;
    if (raw.fields !== undefined && !isObject(raw.fields)) {
      errors.push("fields 应当是一个对象，只写要改的字段");
    } else if (isObject(raw.fields)) {
      checkFields(collection, raw.fields, checkRef, errors);
      merged = dropEmpty({ ...before, ...raw.fields });
      for (const field of collection.fields) {
        if (field.required && field.name in raw.fields && isEmptyValue(raw.fields[field.name])) {
          errors.push(`必填字段「${field.name}」改完之后是空的，必填字段不能清空`);
        }
      }
    }
    const previousSources = sourcesOf(itemId, current.version_no);
    const inherited = raw.sources === undefined;
    let sources = inherited ? previousSources : checkSources(raw.sources, true, errors, call.sessionId, userMessages, call.actor);
    if (sources && !inherited && call.actor !== ACTOR_USER && isObject(raw.fields) && Object.keys(raw.fields).length > 0) {
      // 执行者修改时给了新来源：只替换这次改到的字段上的来源，其余字段的来源沿用。
      // 上一版的来源里，支持改到的字段的那几处去掉，去掉之后什么都不支持的整条去掉，支持整个条目的保留；
      // 「用户直接修改」执行者填不了，按同一条规则沿用。只给 sources、不改任何字段时，仍是整体替换（重新标注来源）。
      sources = [...carriedSources(previousSources, new Set(Object.keys(raw.fields)), sources), ...sources];
    }
    if (sources) checkSupports(collection, merged, sources, inherited, errors);
    if (op !== "restore" && errors.length === 0 && sameJson(merged, before) && sameJson(sources, previousSources)) {
      errors.push(`改完之后的内容与来源都与当前的第 ${current.version_no} 版一样，这个操作没有改动任何东西；不需要改就去掉这个操作`);
    }
    if (errors.length > 0) {
      problems.push(`${label}：${errors.join("；")}。`);
      return;
    }
    planned.push({
      op: op === "restore" ? "restore" : "update",
      itemId,
      collection: row.collection,
      fromVersion: current.version_no,
      fields: merged,
      sources: sources!,
    });
  });

  if (problems.length > 0) {
    throw new Error(
      `这次「保存修订」什么都没有写入，因为有 ${problems.length} 个操作不对：\n` +
        problems.map((one) => `- ${one}`).join("\n") +
        "\n请把这些地方改正之后，把整批操作重新提交一次。",
    );
  }

  return write(db, call, taskId, definition, planned, params);
}

/**
 * 修改时沿用上一版的哪些来源：支持 changed 里的字段的那几处去掉；去掉之后什么都不支持的整条去掉；
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
 * 核对来源列表：至少一条，每条三项齐全、种类是三者之一，supports 的形状对。通过就返回整理好的列表。
 * 种类为「用户的话」的来源，出处在这里代填（见文件开头的说明）；supports 所指的字段是否存在、
 * 序号是否在范围内，要等字段合并完才知道，另由 checkSupports 核对。
 */
function checkSources(
  raw: unknown,
  required: boolean,
  errors: string[],
  sessionId: string,
  userMessages: UserMessage[],
  actor?: string,
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
    const where = `第 ${index + 1} 条来源`;
    if (!isObject(one)) {
      errors.push(`${where}应当是一个对象，有 kind、locator、excerpt 三项`);
      ok = false;
      return;
    }
    const missing: string[] = [];
    // 「用户直接修改」只由用户在界面上的直接操作经扩展命令写，执行者只能填前三种。
    const allowed: readonly string[] = actor === ACTOR_USER ? SOURCE_KINDS : EXECUTOR_SOURCE_KINDS;
    if (one.kind === SOURCE_USER_EDIT && actor !== ACTOR_USER) {
      errors.push(`${where}的 kind 写的是「${SOURCE_USER_EDIT}」，这一种由系统在用户直接改字段时写，你不能填；只能是${EXECUTOR_SOURCE_KINDS.map((kind) => `「${kind}」`).join("、")}之一`);
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
    const supports = checkSupportShape(one.supports, where, errors);
    if (supports === null) {
      ok = false;
      return;
    }
    let locator = one.locator as string;
    const keepLocator =
      userWords && actor === ACTOR_USER && typeof one.locator === "string" && one.locator.includes("#");
    if (userWords && !keepLocator) {
      // 从最近往前找逐字包含这段摘录的用户消息；模型写的 locator 不用，一律由这里代填。
      // 例外：用户在界面上撤销时，扩展命令把旧版本的来源原样交回来，出处早已是「会话编号#条目编号」，照旧保留。
      const excerpt = one.excerpt as string;
      const hit = [...userMessages].reverse().find((message) => message.text.includes(excerpt));
      if (!hit) {
        errors.push(`${where}是「用户的话」，这句话在对话里没有找到，请逐字摘录用户说过的原话（「${excerpt}」）`);
        ok = false;
        return;
      }
      locator = userWordsLocator(sessionId, hit.entryId);
    }
    kept.push({ kind: one.kind as string, locator, excerpt: one.excerpt as string, supports });
  });
  return ok ? kept : null;
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
 * 核对来源所支持的字段：字段必须是这个集合声明的、在这一版里不是空的；index 只能用在列表型字段
 * （文本列表、条目引用）上，并且小于这个字段这一版的项数。inherited 为真表示这些来源是从上一版沿用的，
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
    const where = `${inherited ? "沿用上一版的" : ""}第 ${position + 1} 条来源`;
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
        errors.push(`${where}说它支持字段「${support.field}」，这个字段在这一版里是空的${tail}`);
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
          `${where}指到字段「${support.field}」的第 ${support.index} 项（从 0 起），这个字段这一版只有 ${length} 项，` +
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
        from_version: null as number | null,
        to_version: 1 as number | null,
      };
    }
    if (one.op === "update") {
      return { op: "update" as const, item: one.itemId, serial: 0, collection: one.collection, from_version: one.fromVersion, to_version: one.fromVersion + 1 };
    }
    if (one.op === "restore") {
      return { op: "restore" as const, item: one.itemId, serial: 0, collection: one.collection, from_version: one.fromVersion, to_version: one.fromVersion + 1 };
    }
    return { op: "delete" as const, item: one.itemId, serial: 0, collection: one.collection, from_version: one.fromVersion, to_version: null };
  });

  const at = wallClockText();
  const seq = emit(db, {
    taskId,
    sessionId: call.sessionId,
    callId: call.callId,
    name: EVENT_REVISION_SAVED,
    payload: {
      revision_no: revisionNo,
      ...(typeof params.undo_of_revision === "number" ? { undo_of_revision: params.undo_of_revision } : {}),
      operations: outcomes.map(({ op, item, collection, from_version, to_version }) => ({
        op,
        item,
        collection,
        from_version,
        to_version,
      })),
    },
    actor: call.actor ?? ACTOR_EXECUTOR,
  });

  db.prepare(
    "INSERT INTO revision (task_id, revision_no, session_id, call_id, event_seq, created_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    taskId,
    revisionNo,
    call.sessionId,
    call.callId,
    seq,
    at,
    dump(outcomes.map(({ op, item, collection }) => ({ op, item, collection }))),
  );
  const insertItem = db.prepare(
    "INSERT INTO item (task_id, item_id, collection, serial, added_in_revision, deleted_in_revision, event_seq, deleted_event_seq) " +
      "VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)",
  );
  const insertVersion = db.prepare(
    "INSERT INTO item_version (task_id, item_id, version_no, revision_no, fields, event_seq) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertSource = db.prepare(
    "INSERT INTO item_source (task_id, item_id, version_no, position, support_no, kind, locator, excerpt, field, field_index, event_seq) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    insertVersion.run(taskId, outcome.item, outcome.to_version, revisionNo, dump(one.fields), seq);
    // 一条来源支持几处就展开成几行；支持整个条目时只写一行，字段与序号为空。
    one.sources.forEach((source, position) => {
      const rows: Array<Support | null> = source.supports.length > 0 ? source.supports : [null];
      rows.forEach((support, supportIndex) => {
        insertSource.run(
          taskId, outcome.item, outcome.to_version, position + 1, supportIndex + 1,
          source.kind, source.locator, source.excerpt, support?.field ?? null, support?.index ?? null, seq,
        );
      });
    });
  });

  const lines = outcomes.map((one, index) => {
    if (one.op === "add") return `${index + 1}. 新增了条目 ${one.item}（集合「${one.collection}」），这是它的第 1 版。`;
    if (one.op === "update") return `${index + 1}. 修改了条目 ${one.item}，从第 ${one.from_version} 版变成第 ${one.to_version} 版。`;
    if (one.op === "restore") return `${index + 1}. 恢复了条目 ${one.item}，恢复成删除前的样子，这是它的第 ${one.to_version} 版。`;
    return `${index + 1}. 删除了条目 ${one.item}（删除前是第 ${one.from_version} 版）。`;
  });
  return {
    text: `已保存为任务 ${taskId} 的第 ${revisionNo} 次修订，一共 ${outcomes.length} 个操作：\n${lines.join("\n")}`,
    details: {
      task_id: taskId,
      revision_no: revisionNo,
      event_seq: seq,
      undo_of_revision: typeof params.undo_of_revision === "number" ? params.undo_of_revision : null,
      saved: true,
      operations: outcomes.map(({ op, item, collection, from_version, to_version }) => ({ op, item, collection, from_version, to_version })),
    },
  };
}
