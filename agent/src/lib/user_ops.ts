/**
 * 用户在界面上的直接操作：改字段、删条目、确认、撤回确认、把待定事项标为先不管、撤销一次修订。
 *
 * 这些操作不经模型：后端经 RPC 发扩展命令 /tw-user，命令的处理函数（hooks/user_commands.ts）调用这里。
 * 写库一律走与工具相同的核心函数：改字段、删条目、标为先不管、撤销都经 saveRevision（发起方 user）；
 * 确认与撤回确认现在还没有「登记用户确认」工具时的做法，这里直接写 judgement 与 judgement_item，
 * 判读依据记「界面点击」、没有判读者，同时记一条 CONFIRMATION_RECORDED 事件。
 *
 * 改字段与「标为先不管」改到的字段，来源换成一条「用户直接修改」（出处是操作编号，摘录是新值的前 200 字），
 * 没改的字段来源沿用上一版；加入第四种来源之前建的库不认这一种，那样的库沿用旧做法。
 * 追加进会话的通知正文带上改后的字段值，执行者不必另去查（同节第 4 条）。
 *
 * 拒绝一律抛 UserOpError，带一个与接口错误码（docs/api.md 的「错误」一节）一致的错误码（stale_version、undo_conflict、
 * task_closed、no_task、rejected、bad_request）和给人看的一句中文，data 里放细节。本模块不依赖 pi。
 */

import type { DatabaseSync } from "node:sqlite";
import { ACTOR_EXECUTOR, ACTOR_USER, LEGACY_ACTOR_MODEL, dump, emit, load, wallClockText } from "./db.ts";
import { validateDefinition } from "./definition.ts";
import { type Source, isEmptyValue, saveRevision } from "./save_revision.ts";
import { NoDatabaseYet, SOURCE_USER_EDIT, TASK_ACTIVE, acceptsUserEditSource, withTaskDatabase } from "./schema.ts";

/** 「用户直接修改」来源的摘录最多取新值的前这么多个字。 */
export const USER_EDIT_EXCERPT_LIMIT = 200;

export const EVENT_CONFIRMATION_RECORDED = "CONFIRMATION_RECORDED";
export const USER_OP_KINDS = ["edit_fields", "delete_item", "confirm", "unconfirm", "keep_pending", "undo"] as const;
export type UserOpKind = (typeof USER_OP_KINDS)[number];

/** 「把待定事项标为先不管」写进状态字段的取值。 */
export const KEEP_PENDING_STATUS = "用户决定保留";

export interface UserOpRequest {
  op_id?: unknown;
  kind?: unknown;
  task_id?: unknown;
  targets?: unknown;
  fields?: unknown;
  notify_executor?: unknown;
}

export interface UserOpResult {
  op_id: string;
  kind: UserOpKind;
  event_seqs: number[];
  results: { item_id: string; version_no: number | null }[];
  revision_no: number | null;
  /** 追加进会话的自定义消息的正文。 */
  note: string;
  /** notify_executor 为真的确认操作之后发给执行者的那句话（固定模板），其余为 null。 */
  notify_text: string | null;
  undoable: boolean;
}

export class UserOpError extends Error {
  code: string;
  data: Record<string, unknown>;
  constructor(code: string, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

interface Ctx {
  workspaceDir: string;
  sessionId: string;
}

interface Target {
  item_id: string;
  base_version: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actorWord(actor: string): string {
  return actor === ACTOR_USER ? "user" : actor === ACTOR_EXECUTOR || actor === LEGACY_ACTOR_MODEL ? "executor" : actor;
}

/** 执行一次直接操作。成功返回结果，拒绝抛 UserOpError。 */
export function runUserOperation(ctx: Ctx, request: UserOpRequest): UserOpResult {
  const opId = typeof request.op_id === "string" ? request.op_id : "";
  if (!opId.startsWith("ui-")) throw new UserOpError("bad_request", "操作编号 op_id 应当由后端生成，以 ui- 开头。");
  const kind = request.kind as UserOpKind;
  if (!(USER_OP_KINDS as readonly string[]).includes(String(request.kind))) {
    throw new UserOpError("bad_request", `操作种类 kind 写的是 ${JSON.stringify(request.kind)}，只能是 ${USER_OP_KINDS.join("、")} 之一。`);
  }
  if (!Array.isArray(request.targets) || request.targets.length === 0) {
    throw new UserOpError("bad_request", "targets 应当是一个不为空的列表。");
  }

  // 先在一个事务里读出任务与条目的现状，做任务状态与版本的核对；确认与撤回确认在同一个事务里直接写。
  const state = inspect(ctx, request, kind);
  if (kind === "confirm" || kind === "unconfirm") return confirm(ctx, opId, kind, state.targets!, request.notify_executor === true);
  if (kind === "undo") return undo(ctx, opId, state.revisionNo!);

  const targets = state.targets!;
  let operations: Record<string, unknown>[];
  let note: (details: { revision_no: number; operations: { item: string; from_version: number | null; to_version: number | null }[] }) => string;
  if (kind === "edit_fields") {
    if (targets.length !== 1) throw new UserOpError("bad_request", "edit_fields 一次只改一个条目，targets 里只能有一项。");
    if (!isObject(request.fields) || Object.keys(request.fields).length === 0) {
      throw new UserOpError("bad_request", "edit_fields 要带 fields：要改的字段的完整新值。");
    }
    const names = Object.keys(request.fields);
    const fields = request.fields;
    operations = [withUserEditSources(
      { op: "update", item: targets[0].item_id, base_version: targets[0].base_version, fields },
      state, opId, fields,
    )];
    note = (d) =>
      `界面操作（不是用户打的字）：用户把 ${targets[0].item_id} 的${names.map((n) => `「${n}」`).join("、")}改成了第 ${d.operations[0].to_version} 版。` +
      `改后的内容是：\n${describeFields(fields)}`;
  } else if (kind === "delete_item") {
    operations = targets.map((t) => ({ op: "delete", item: t.item_id, base_version: t.base_version }));
    note = (d) =>
      `界面操作（不是用户打的字）：用户删除了 ${d.operations.map((o) => `${o.item}（删除前是第 ${o.from_version} 版）`).join("、")}。` +
      "这些条目已删除，不再算在交付物里。";
  } else {
    operations = targets.map((t) =>
      withUserEditSources({ op: "update", item: t.item_id, base_version: t.base_version, fields: { 状态: KEEP_PENDING_STATUS } }, state, opId, {
        状态: KEEP_PENDING_STATUS,
      }),
    );
    note = (d) =>
      `界面操作（不是用户打的字）：用户把 ${d.operations.map((o) => `${o.item}`).join("、")} 标为先不管（状态改为「${KEEP_PENDING_STATUS}」），` +
      `现在是${d.operations.map((o) => `${o.item} 第 ${o.to_version} 版`).join("、")}。`;
  }
  const outcome = save(ctx, opId, { operations });
  const details = outcome.details as { revision_no: number; event_seq: number; operations: { item: string; from_version: number | null; to_version: number | null }[] };
  return {
    op_id: opId,
    kind,
    event_seqs: [details.event_seq],
    results: details.operations.map((o) => ({ item_id: o.item, version_no: o.to_version })),
    revision_no: details.revision_no,
    note: note(details),
    notify_text: null,
    undoable: true,
  };
}

/** 调 saveRevision，把它的拒绝翻成 UserOpError。版本核对已经在 inspect 里做过，这里再遇到就是同一时刻被改了。 */
function save(ctx: Ctx, opId: string, params: { operations: unknown; undo_of_revision?: number }) {
  try {
    return saveRevision({ workspaceDir: ctx.workspaceDir, sessionId: ctx.sessionId, callId: opId, actor: ACTOR_USER }, params);
  } catch (error) {
    const text = (error as Error).message;
    if (text.includes("已经被") && text.includes("改到第")) throw new UserOpError("stale_version", "条目刚被改过，请看最新内容后再改。", { detail: text });
    const reasons = text.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
    // message 直接写出第一条原因，前端只显示 message 时用户也知道哪里不对；全部原因在 data.reasons。
    const message = reasons.length ? `这次修改没有通过核对：${reasons[0]}${reasons.length > 1 ? `（另有 ${reasons.length - 1} 处）` : ""}` : text;
    throw new UserOpError("rejected", message, { reasons: reasons.length ? reasons : [text] });
  }
}

interface Inspected {
  targets?: Target[];
  revisionNo?: number;
  /** 改字段与标为先不管时：每个目标条目当前版本的来源。 */
  sources?: Map<string, Source[]>;
  /** 这个库的来源表认不认「用户直接修改」。 */
  userEditOk?: boolean;
}

/** 从库里读某个条目某一版的来源，按条目来源的形状整理（一条来源支持的几处合回一条）。 */
function readSources(db: DatabaseSync, taskId: string, itemId: string, versionNo: number): Source[] {
  const rows = db
    .prepare("SELECT position, kind, locator, excerpt, field, field_index FROM item_source WHERE task_id = ? AND item_id = ? AND version_no = ? ORDER BY position, support_no")
    .all(taskId, itemId, versionNo) as { position: number; kind: string; locator: string; excerpt: string; field: string | null; field_index: number | null }[];
  const byPosition = new Map<number, Source>();
  for (const row of rows) {
    let source = byPosition.get(row.position);
    if (!source) byPosition.set(row.position, (source = { kind: row.kind, locator: row.locator, excerpt: row.excerpt, supports: [] }));
    if (row.field !== null) source.supports.push(row.field_index === null ? { field: row.field } : { field: row.field, index: row.field_index });
  }
  return [...byPosition.values()];
}

/** 一个字段值在摘录与通知里的写法：文本照原文，列表用分号接起来。 */
function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.map((one) => String(one)).join("；");
  return value === undefined || value === null ? "" : String(value);
}

/**
 * 给一个直接改字段的操作配上来源：上一版的来源里，支持改到的字段的那几处去掉（去掉之后什么都不支持的来源整条去掉，
 * 本来就支持整个条目的来源保留）；每个改到、而且新值不为空的字段各加一条「用户直接修改」。
 * 库不认这一种时不写 sources，沿用上一版的来源（旧做法）。
 */
function withUserEditSources(operation: Record<string, unknown>, state: Inspected, opId: string, changed: Record<string, unknown>) {
  if (!state.userEditOk) return operation;
  const previous = state.sources?.get(operation.item as string) ?? [];
  const names = new Set(Object.keys(changed));
  const kept: Source[] = [];
  for (const source of previous) {
    if (source.supports.length === 0) {
      kept.push(source);
      continue;
    }
    const supports = source.supports.filter((support) => !names.has(support.field));
    if (supports.length > 0) kept.push({ ...source, supports });
  }
  for (const [field, value] of Object.entries(changed)) {
    if (isEmptyValue(value)) continue;
    kept.push({ kind: SOURCE_USER_EDIT, locator: opId, excerpt: [...valueText(value)].slice(0, USER_EDIT_EXCERPT_LIMIT).join(""), supports: [{ field }] });
  }
  if (kept.length === 0) {
    kept.push({ kind: SOURCE_USER_EDIT, locator: opId, excerpt: `用户清空了${[...names].map((n) => `「${n}」`).join("、")}`, supports: [] });
  }
  return { ...operation, sources: kept };
}

/** 通知正文里的改后内容：每个字段一段，文本写全文，列表逐条列出，清空的写明清空了。 */
export function describeFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([name, value]) => {
      if (isEmptyValue(value)) return `「${name}」：（清空了）`;
      if (Array.isArray(value)) return `「${name}」：\n${value.map((one, index) => `  ${index + 1}. ${String(one)}`).join("\n")}`;
      return `「${name}」：${String(value)}`;
    })
    .join("\n");
}

/** 核对任务状态、目标形状与版本，返回整理好的目标。 */
function inspect(ctx: Ctx, request: UserOpRequest, kind: UserOpKind): Inspected {
  try {
    return withTaskDatabase(ctx.workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id, status, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
        | { task_id: string; status: string; definition_text: string }
        | undefined;
      if (!task) throw new UserOpError("no_task", "这个任务目录里还没有任务记录。");
      if (typeof request.task_id === "string" && request.task_id !== "" && request.task_id !== task.task_id) {
        throw new UserOpError("bad_request", `task_id 写的是 ${request.task_id}，这个库里的任务是 ${task.task_id}。`);
      }
      if (task.status !== TASK_ACTIVE) throw new UserOpError("task_closed", `任务已经${task.status}，不能再改。`, { status: task.status });
      const raw = request.targets as unknown[];
      if (kind === "undo") {
        const target = raw[0];
        if (raw.length !== 1 || !isObject(target) || !Number.isInteger(target.revision_no)) {
          throw new UserOpError("bad_request", "undo 的 targets 只能有一项，写 { \"revision_no\": 整数 }。");
        }
        return { revisionNo: target.revision_no as number };
      }
      const targets: Target[] = [];
      for (const one of raw) {
        if (!isObject(one) || typeof one.item_id !== "string" || !Number.isInteger(one.base_version)) {
          throw new UserOpError("bad_request", "targets 的每一项要写 { \"item_id\": 条目编号, \"base_version\": 整数 }。");
        }
        targets.push({ item_id: one.item_id, base_version: one.base_version as number });
      }
      if (new Set(targets.map((t) => t.item_id)).size !== targets.length) {
        throw new UserOpError("bad_request", "targets 里有重复的条目。");
      }
      const definition = validateDefinition(JSON.parse(task.definition_text));
      const stale: Record<string, unknown>[] = [];
      const missing: string[] = [];
      for (const target of targets) {
        const item = db.prepare("SELECT collection, deleted_in_revision FROM item WHERE task_id = ? AND item_id = ?").get(task.task_id, target.item_id) as
          | { collection: string; deleted_in_revision: number | null }
          | undefined;
        if (!item || item.deleted_in_revision !== null) {
          missing.push(target.item_id);
          continue;
        }
        if (kind === "keep_pending") {
          const collection = definition.collections.find((c) => c.name === item.collection);
          const status = collection?.fields.find((f) => f.name === "状态");
          if (!status || !(status.values ?? []).includes(KEEP_PENDING_STATUS)) {
            throw new UserOpError("rejected", `${target.item_id} 所在的集合「${item.collection}」没有可以标为「${KEEP_PENDING_STATUS}」的状态字段。`,
              { reasons: [`集合「${item.collection}」没有取值里含「${KEEP_PENDING_STATUS}」的状态字段`] });
          }
        }
        const current = db
          .prepare(
            "SELECT v.version_no, e.actor FROM item_version v JOIN event e ON e.seq = v.event_seq " +
              "WHERE v.task_id = ? AND v.item_id = ? ORDER BY v.version_no DESC LIMIT 1",
          )
          .get(task.task_id, target.item_id) as { version_no: number; actor: string };
        if (current.version_no !== target.base_version) {
          // version_no 与 by 是 current_version 与 changed_by 的另一种写法，照前端骨架读的键名一并给出。
          const by = actorWord(current.actor);
          stale.push({ item_id: target.item_id, base_version: target.base_version, current_version: current.version_no, changed_by: by,
            version_no: current.version_no, by });
        }
      }
      if (missing.length > 0) {
        throw new UserOpError("rejected", `条目 ${missing.join("、")} 不存在或已经删除。`, { reasons: missing.map((id) => `条目 ${id} 不存在或已经删除`) });
      }
      if (stale.length > 0) {
        throw new UserOpError("stale_version", "这个条目刚被改过（可能是助手，也可能是另一个页面），请看最新内容后再改。", { items: stale });
      }
      if (kind === "edit_fields" || kind === "keep_pending") {
        const sources = new Map(targets.map((t) => [t.item_id, readSources(db, task.task_id, t.item_id, t.base_version)]));
        return { targets, sources, userEditOk: acceptsUserEditSource(db) };
      }
      return { targets };
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) throw new UserOpError("no_task", "这个任务目录里还没有任务记录。");
    throw error;
  }
}

/** 确认与撤回确认：写一次判读（依据是界面点击）与每个条目的态度，记一条事件。 */
function confirm(ctx: Ctx, opId: string, kind: "confirm" | "unconfirm", targets: Target[], notify: boolean): UserOpResult {
  const accepted = kind === "confirm";
  const seq = withTaskDatabase(ctx.workspaceDir, { createIfMissing: false }, (db: DatabaseSync) => {
    const task = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string };
    const at = wallClockText();
    const eventSeq = emit(db, {
      taskId: task.task_id,
      sessionId: ctx.sessionId,
      callId: opId,
      name: EVENT_CONFIRMATION_RECORDED,
      payload: { items: targets.map((t) => ({ item_id: t.item_id, version_no: t.base_version, accepted })), basis: "ui_click" },
      actor: ACTOR_USER,
    });
    const judgement = db
      .prepare("INSERT INTO judgement (task_id, basis, call_id, event_seq, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(task.task_id, dump([{ 依据: "界面点击", 操作编号: opId, 判读者: null }]), opId, eventSeq, at);
    const judgementId = Number(judgement.lastInsertRowid);
    const insert = db.prepare(
      "INSERT INTO judgement_item (judgement_id, task_id, item_id, version_no, attitude, event_seq) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const t of targets) insert.run(judgementId, task.task_id, t.item_id, t.base_version, accepted ? "接受" : "不接受", eventSeq);
    return eventSeq;
  });
  const list = targets.map((t) => `${t.item_id} 第 ${t.base_version} 版`).join("、");
  return {
    op_id: opId,
    kind,
    event_seqs: [seq],
    results: targets.map((t) => ({ item_id: t.item_id, version_no: t.base_version })),
    revision_no: null,
    note: accepted
      ? `界面操作（不是用户打的字）：用户在界面上确认了 ${list}。`
      : `界面操作（不是用户打的字）：用户在界面上撤回了对 ${list}的确认。`,
    notify_text: accepted && notify ? `我已经在界面上确认了：${targets.map((t) => `${t.item_id} 第 ${t.base_version} 版`).join("，")}。请接着往下做。` : null,
    undoable: false,
  };
}

interface RevisionOp {
  op: string;
  item: string;
  from_version: number | null;
  to_version: number | null;
}

/** 撤销一次修订：对它涉及的每个条目再存一版，内容改回那次改动之前的样子。之后又被改过就拒绝。 */
function undo(ctx: Ctx, opId: string, revisionNo: number): UserOpResult {
  const plan = withTaskDatabase(ctx.workspaceDir, { createIfMissing: false }, (db: DatabaseSync) => {
    const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; definition_text: string };
    const definition = validateDefinition(JSON.parse(task.definition_text));
    const revision = db.prepare("SELECT event_seq FROM revision WHERE task_id = ? AND revision_no = ?").get(task.task_id, revisionNo) as
      | { event_seq: number }
      | undefined;
    if (!revision) throw new UserOpError("bad_request", `没有第 ${revisionNo} 次修订。`);
    const payload = load((db.prepare("SELECT payload FROM event WHERE seq = ?").get(revision.event_seq) as { payload: string }).payload) as {
      operations: RevisionOp[];
    };
    const conflicts: Record<string, unknown>[] = [];
    const operations: Record<string, unknown>[] = [];
    const versionOf = (item: string, no: number) =>
      db.prepare("SELECT fields FROM item_version WHERE task_id = ? AND item_id = ? AND version_no = ?").get(task.task_id, item, no) as
        | { fields: string }
        | undefined;
    const sourcesOf = (item: string, no: number) => readSources(db, task.task_id, item, no);
    for (const op of payload.operations) {
      const item = db.prepare("SELECT collection, deleted_in_revision FROM item WHERE task_id = ? AND item_id = ?").get(task.task_id, op.item) as {
        collection: string;
        deleted_in_revision: number | null;
      };
      const latest = (db.prepare("SELECT MAX(version_no) AS v FROM item_version WHERE task_id = ? AND item_id = ?").get(task.task_id, op.item) as { v: number }).v;
      const declared = definition.collections.find((c) => c.name === item.collection)?.fields ?? [];
      const fullFields = (no: number) => {
        const old = load(versionOf(op.item, no)!.fields) as Record<string, unknown>;
        return Object.fromEntries(declared.map((f) => [f.name, f.name in old ? old[f.name] : f.type === "文本" || f.type === "枚举" ? "" : []]));
      };
      if (op.op === "add" || op.op === "restore") {
        if (item.deleted_in_revision !== null || latest !== op.to_version) {
          conflicts.push({ item_id: op.item, reason: `${op.item} 在这次修订之后又被改过或删除了` });
          continue;
        }
        operations.push({ op: "delete", item: op.item, base_version: latest });
      } else if (op.op === "update") {
        if (item.deleted_in_revision !== null || latest !== op.to_version) {
          conflicts.push({ item_id: op.item, reason: `${op.item} 在这次修订之后又被改过或删除了（现在是第 ${latest} 版）` });
          continue;
        }
        operations.push({ op: "update", item: op.item, base_version: latest, fields: fullFields(op.from_version!), sources: sourcesOf(op.item, op.from_version!) });
      } else if (op.op === "delete") {
        if (item.deleted_in_revision !== revisionNo || latest !== op.from_version) {
          conflicts.push({ item_id: op.item, reason: `${op.item} 在这次修订之后又有了变化` });
          continue;
        }
        operations.push({ op: "restore", item: op.item, base_version: latest, fields: fullFields(op.from_version!), sources: sourcesOf(op.item, op.from_version!) });
      }
    }
    if (conflicts.length > 0) {
      throw new UserOpError("undo_conflict", `第 ${revisionNo} 次修订之后，同一个条目又被改过，不能撤销。`, { revision_no: revisionNo, items: conflicts });
    }
    return operations;
  });
  const outcome = save(ctx, opId, { operations: plan, undo_of_revision: revisionNo });
  const details = outcome.details as { revision_no: number; event_seq: number; operations: RevisionOp[] };
  const words: Record<string, string> = { delete: "删除", update: "改回", restore: "恢复" };
  return {
    op_id: opId,
    kind: "undo",
    event_seqs: [details.event_seq],
    results: details.operations.map((o) => ({ item_id: o.item, version_no: o.to_version })),
    revision_no: details.revision_no,
    note:
      `界面操作（不是用户打的字）：用户撤销了第 ${revisionNo} 次修订：` +
      details.operations.map((o) => `${words[o.op] ?? o.op} ${o.item}${o.to_version ? `（现在是第 ${o.to_version} 版）` : "（已删除）"}`).join("、") + "。" +
      plan
        .filter((one) => one.fields !== undefined)
        .map((one) => `\n${one.item} 现在的内容是：\n${describeFields(dropEmptyFields(one.fields as Record<string, unknown>))}`)
        .join(""),
    notify_text: null,
    undoable: true,
  };
}

/** 通知里不列空字段。 */
function dropEmptyFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => !isEmptyValue(value)));
}
