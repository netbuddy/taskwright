/**
 * 用户在界面上的直接操作：改字段、删条目、标为已读、撤回确认、把问题条目标为先不管、撤销一次修订。
 *
 * 这些操作不经模型：后端经 RPC 发扩展命令 /tw-user，命令的处理函数（hooks/user_commands.ts）调用这里。
 * 写库一律走与工具相同的核心函数：改字段、删条目、标为先不管、撤销都经 saveRevision（发起方 user）。
 *
 * 确认标记记在 judgement（一次标记）与 judgement_item（每个条目在哪次修订上、接受与否）两张表里，
 * judgement.basis 写这次标记的依据。依据有三种，都由这里写：
 * - 已读（viewed）：用户打开条目详情，或在卡片上点「这几条都看过了」（mark_viewed），记一条 ITEM_VIEWED 事件。
 *   幂等：条目在这次修订上最近一条标记已经是接受时不再写。
 * - 界面修改（ui_edit）：改字段与「标为先不管」成功时，用户亲手改出来的内容就是用户认可的内容，在保存修订的同一个事务里
 *   为每个被改的条目在这次修订上自动写一条接受的标记，记一条 CONFIRMATION_RECORDED 事件。删除与撤销修订不自动写。
 * - 界面点击（ui_click）：撤回（unconfirm）写一条不接受的标记，记一条 CONFIRMATION_RECORDED 事件。已读是条目级、单向的，
 *   看过的条目撤回之后仍算看过（见 conditions.ts）。
 * 旧库里还可能有依据为「用户的话」的标记，那是早期版本由执行者登记的，读取一侧照旧认。
 *
 * 改字段与「标为先不管」改到的字段，来源换成一条「用户直接修改」（出处是操作编号，摘录是新值的前 200 字），
 * 没改的字段来源沿用条目上一次修订时的来源；加入第四种来源之前建的库不认这一种，那样的库沿用旧做法。
 * 追加进会话的通知正文带上改后的字段值，执行者不必另去查（同节第 4 条）。
 *
 * 评审（request_review）也是一种界面操作，但它不写修订、要调模型、要跑很久：这里只做 checkReviewRequest 那一步核对，
 * 评审本身由 hooks/user_commands.ts 经 lib/review_ui.ts 在后台跑。
 *
 * 评审的另外三种界面操作只有用户能做，执行者没有对应的工具：
 * - 保留写法（waive_review）：条目当前所在的修订在当前规则下评审不合规，用户保留现在的写法（理由可空），写 review_waiver 一行，
 *   记 REVIEW_WAIVED；完成条件把它算作通过。条目改出新修订之后，旧修订上的保留不再作数。
 * - 撤销保留（unwaive_review）：给那一行填上撤销时刻，记 REVIEW_UNWAIVED。
 * - 改评审规则（set_review_rules）：改一个集合「评审规矩」里的「关闭」「升为必选」两项，同时改任务目录里的任务定义副本与库里的快照，
 *   记 REVIEW_RULES_CHANGED。必选规则不能关（与任务定义校验同一套核对）。规则指纹随之变化，这个集合的条目都回到待评审；已有评审记录不动。
 *
 * 拒绝一律抛 UserOpError，带一个与接口错误码（docs/api.md 的「错误」一节）一致的错误码（stale_revision、undo_conflict、
 * task_closed、no_task、rejected、bad_request）和给人看的一句中文，data 里放细节。本模块不依赖 pi。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ACTOR_EXECUTOR, ACTOR_USER, LEGACY_ACTOR_MODEL, dump, emit, load, wallClockText } from "./db.ts";
import { DefinitionError, KEEP_PENDING_STATUS, validateDefinition } from "./definition.ts";
import { activeWaiver, currentRulesHash, currentReviews, reviewSpecOf } from "./review_state.ts";
import { SaveRejected, type Source, isEmptyValue, saveRevision } from "./save_revision.ts";
import { NoDatabaseYet, SOURCE_USER_EDIT, TASK_ACTIVE, acceptsUserEditSource, withTaskDatabase } from "./schema.ts";

/** 「用户直接修改」来源的摘录最多取新值的前这么多个字。 */
export const USER_EDIT_EXCERPT_LIMIT = 200;

export const EVENT_CONFIRMATION_RECORDED = "CONFIRMATION_RECORDED";
export const EVENT_ITEM_VIEWED = "ITEM_VIEWED";
export const EVENT_REVIEW_WAIVED = "REVIEW_WAIVED";
export const EVENT_REVIEW_UNWAIVED = "REVIEW_UNWAIVED";
export const EVENT_REVIEW_RULES_CHANGED = "REVIEW_RULES_CHANGED";
export const USER_OP_KINDS = ["edit_fields", "delete_item", "mark_viewed", "unconfirm", "keep_pending", "undo", "waive_review", "unwaive_review", "set_review_rules"] as const;
export type UserOpKind = (typeof USER_OP_KINDS)[number];

export { KEEP_PENDING_STATUS };

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
  results: { item_id: string; revision_no: number | null }[];
  revision_no: number | null;
  /** 追加进会话的自定义消息的正文；为空文字时不追加（打开详情写已读不告诉执行者）。 */
  note: string;
  /** notify_executor 为真的标为已读之后发给执行者的那句话（固定模板），其余为 null。 */
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
  /** 用户打开这个条目时它所在的修订号。 */
  base_revision: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actorWord(actor: string): string {
  return actor === ACTOR_USER ? "user" : actor === ACTOR_EXECUTOR || actor === LEGACY_ACTOR_MODEL ? "executor" : actor;
}

/** 用户在界面上发起评审的操作种类。它不在 USER_OP_KINDS 里：不写修订、不经 runUserOperation。 */
export const REVIEW_OP_KIND = "request_review";

/**
 * request_review 的核对：操作编号、任务在不在、是不是进行中、targets 的形状。targets 为空列表时返回 null（评全部待评审的条目），
 * 否则返回点名的条目与各自的修订号（base_revision）。条目在不在、所在集合要不要评审、修订号对不对，由 prepareReviews 核对。
 */
export function checkReviewRequest(ctx: Ctx, request: UserOpRequest): { item_id: string; revision_no: number }[] | null {
  const opId = typeof request.op_id === "string" ? request.op_id : "";
  if (!opId.startsWith("ui-")) throw new UserOpError("bad_request", "操作编号 op_id 应当由后端生成，以 ui- 开头。");
  const raw = request.targets ?? [];
  if (!Array.isArray(raw)) throw new UserOpError("bad_request", "request_review 的 targets 应当是一个列表；空列表表示评审全部待评审的条目。");
  const targets = raw.map((one) => {
    const base = isObject(one) ? one.base_revision : undefined;
    if (!isObject(one) || typeof one.item_id !== "string" || !Number.isInteger(base)) {
      throw new UserOpError("bad_request", "targets 的每一项要写 { \"item_id\": 条目编号, \"base_revision\": 整数 }。");
    }
    return { item_id: one.item_id, revision_no: base as number };
  });
  if (new Set(targets.map((t) => t.item_id)).size !== targets.length) throw new UserOpError("bad_request", "targets 里有重复的条目。");
  try {
    withTaskDatabase(ctx.workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id, status FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; status: string } | undefined;
      if (!task) throw new UserOpError("no_task", "这个任务目录里还没有任务记录。");
      if (typeof request.task_id === "string" && request.task_id !== "" && request.task_id !== task.task_id) {
        throw new UserOpError("bad_request", `task_id 写的是 ${request.task_id}，这个库里的任务是 ${task.task_id}。`);
      }
      if (task.status !== TASK_ACTIVE) throw new UserOpError("task_closed", `任务已经${task.status}，不能再评审。`, { status: task.status });
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) throw new UserOpError("no_task", "这个任务目录里还没有任务记录。");
    throw error;
  }
  return targets.length ? targets : null;
}

/** 执行一次直接操作。成功返回结果，拒绝抛 UserOpError。 */
export function runUserOperation(ctx: Ctx, request: UserOpRequest): UserOpResult {
  const opId = typeof request.op_id === "string" ? request.op_id : "";
  if (!opId.startsWith("ui-")) throw new UserOpError("bad_request", "操作编号 op_id 应当由后端生成，以 ui- 开头。");
  const kind = request.kind as UserOpKind;
  if (!(USER_OP_KINDS as readonly string[]).includes(String(request.kind))) {
    throw new UserOpError("bad_request", `操作种类 kind 写的是 ${JSON.stringify(request.kind)}，只能是 ${USER_OP_KINDS.join("、")} 之一。`);
  }
  if (kind === "set_review_rules") return setReviewRules(ctx, opId, request);
  if (!Array.isArray(request.targets) || request.targets.length === 0) {
    throw new UserOpError("bad_request", "targets 应当是一个不为空的列表。");
  }

  // 先在一个事务里读出任务与条目的现状，做任务状态与修订号的核对；标为已读与撤回确认在同一个事务里直接写。
  const state = inspect(ctx, request, kind);
  if (kind === "mark_viewed") return markViewed(ctx, opId, state.targets!, request.notify_executor === true);
  if (kind === "unconfirm") return unconfirm(ctx, opId, state.targets!);
  if (kind === "undo") return undo(ctx, opId, state.revisionNo!);
  if (kind === "waive_review") return waiveReview(ctx, opId, state.targets!, request.fields);
  if (kind === "unwaive_review") return unwaiveReview(ctx, opId, state.targets!);

  const targets = state.targets!;
  let operations: Record<string, unknown>[];
  let note: (details: { revision_no: number; operations: RevisionOp[] }) => string;
  if (kind === "edit_fields") {
    if (targets.length !== 1) throw new UserOpError("bad_request", "edit_fields 一次只改一个条目，targets 里只能有一项。");
    if (!isObject(request.fields) || Object.keys(request.fields).length === 0) {
      throw new UserOpError("bad_request", "edit_fields 要带 fields：要改的字段的完整新值。");
    }
    const names = Object.keys(request.fields);
    const fields = request.fields;
    operations = [withUserEditSources(
      { op: "update", item: targets[0].item_id, base_revision: targets[0].base_revision, fields },
      state, opId, fields,
    )];
    note = (d) =>
      `界面操作（不是用户打的字）：用户改了 ${targets[0].item_id} 的${names.map((n) => `「${n}」`).join("、")}，产生修订 ${d.revision_no}，${targets[0].item_id} 现在是修订 ${d.revision_no}。` +
      `${confirmedText(d.operations)}改后的内容是：\n${describeFields(fields)}`;
  } else if (kind === "delete_item") {
    operations = targets.map((t) => ({ op: "delete", item: t.item_id, base_revision: t.base_revision }));
    note = (d) =>
      `界面操作（不是用户打的字）：用户删除了 ${d.operations.map((o) => `${o.item}（删除前在修订 ${o.from_revision}）`).join("、")}，产生修订 ${d.revision_no}。` +
      "这些条目已删除，不再算在交付物里。";
  } else {
    operations = targets.map((t) =>
      withUserEditSources({ op: "update", item: t.item_id, base_revision: t.base_revision, fields: { 状态: KEEP_PENDING_STATUS } }, state, opId, {
        状态: KEEP_PENDING_STATUS,
      }),
    );
    note = (d) =>
      `界面操作（不是用户打的字）：用户把 ${d.operations.map((o) => `${o.item}`).join("、")} 标为先不管（状态改为「${KEEP_PENDING_STATUS}」），` +
      `产生修订 ${d.revision_no}，${d.operations.map((o) => o.item).join("、")} 现在是修订 ${d.revision_no}。` + confirmedText(d.operations);
  }
  // 改字段与标为先不管：随修订在同一个事务里把改出来的内容登记为用户已确认；删除不登记。
  const confirmation: { seq: number | null } = { seq: null };
  const autoConfirm = kind === "delete_item" ? undefined : (db: DatabaseSync, written: { details: Record<string, unknown> }) => {
    const d = written.details as { revision_no: number; operations: RevisionOp[] };
    const items = d.operations.filter((o) => o.to_revision !== null).map((o) => ({ item_id: o.item, revision_no: o.to_revision as number }));
    confirmation.seq = recordMark(db, ctx, opId, items, true, "ui_edit");
  };
  const outcome = save(ctx, opId, { operations }, autoConfirm);
  const details = outcome.details as { revision_no: number; event_seq: number; operations: RevisionOp[] };
  return {
    op_id: opId,
    kind,
    event_seqs: confirmation.seq === null ? [details.event_seq] : [details.event_seq, confirmation.seq],
    results: details.operations.map((o) => ({ item_id: o.item, revision_no: o.to_revision })),
    revision_no: details.revision_no,
    note: note(details),
    notify_text: null,
    undoable: true,
  };
}

/** 改字段与标为先不管的通知里那句：用户亲手改出来的内容，同时算作用户看过并认可了。 */
function confirmedText(operations: RevisionOp[]): string {
  return `这次修改同时算作用户看过并认可了 ${operations.map((o) => `${o.item}（修订 ${o.to_revision}）`).join("、")}。`;
}

/** 调 saveRevision，把它的拒绝翻成 UserOpError。修订号核对已经在 inspect 里做过，这里再遇到就是同一时刻被改了。 */
function save(
  ctx: Ctx,
  opId: string,
  params: { operations: unknown; undo_of_revision?: number },
  afterWrite?: (db: DatabaseSync, outcome: { details: Record<string, unknown> }) => void,
) {
  try {
    return saveRevision({ workspaceDir: ctx.workspaceDir, sessionId: ctx.sessionId, callId: opId, actor: ACTOR_USER }, params, afterWrite);
  } catch (error) {
    const text = (error as Error).message;
    if (text.includes("已经被") && text.includes("改到修订")) throw new UserOpError("stale_revision", "条目刚被改过，请看最新内容后再改。", { detail: text });
    // 保存修订被拒时带着分层的原因：给用户看的只取事实，指引是给助手的。
    const reasons = error instanceof SaveRejected ? error.reasons.map((r) => r.fact)
      : text.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
    // message 直接写出第一条原因，前端只显示 message 时用户也知道哪里不对；全部原因在 data.reasons。
    const message = reasons.length ? `这次修改没有通过核对：${reasons[0]}${reasons.length > 1 ? `（另有 ${reasons.length - 1} 处）` : ""}` : text;
    throw new UserOpError("rejected", message, { reasons: reasons.length ? reasons : [text] });
  }
}

interface Inspected {
  targets?: Target[];
  revisionNo?: number;
  /** 改字段与标为先不管时：每个目标条目在当前所在修订下的来源。 */
  sources?: Map<string, Source[]>;
  /** 这个库的来源表认不认「用户直接修改」。 */
  userEditOk?: boolean;
}

/** 从库里读某个条目在某次修订下的来源，按条目来源的形状整理（一条来源支持的几处合回一条）。 */
function readSources(db: DatabaseSync, taskId: string, itemId: string, revisionNo: number): Source[] {
  const rows = db
    .prepare("SELECT position, kind, locator, excerpt, field, field_index, normalized_value FROM item_source WHERE task_id = ? AND item_id = ? AND revision_no = ? ORDER BY position, support_no")
    .all(taskId, itemId, revisionNo) as { position: number; kind: string; locator: string; excerpt: string; field: string | null; field_index: number | null; normalized_value: string | null }[];
  const byPosition = new Map<number, Source>();
  for (const row of rows) {
    let source = byPosition.get(row.position);
    if (!source) {
      byPosition.set(row.position, (source = { kind: row.kind, locator: row.locator, excerpt: row.excerpt, supports: [] }));
      // 撤销时把旧来源原样交回，「用户的话」写入的规范化值也跟着回去。
      if (row.normalized_value !== null) source.normalized_value = row.normalized_value;
    }
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
 * 给一个直接改字段的操作配上来源：条目上一次修订时的来源里，支持改到的字段的那几处去掉（去掉之后什么都不支持的来源整条去掉，
 * 本来就支持整个条目的来源保留）；每个改到、而且新值不为空的字段各加一条「用户直接修改」。
 * 库不认这一种时不写 sources，沿用上一次修订时的来源（旧做法）。
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

/** 核对任务状态、目标形状与修订号，返回整理好的目标。 */
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
        const base = isObject(one) ? one.base_revision : undefined;
        if (!isObject(one) || typeof one.item_id !== "string" || !Number.isInteger(base)) {
          throw new UserOpError("bad_request", "targets 的每一项要写 { \"item_id\": 条目编号, \"base_revision\": 整数 }。");
        }
        targets.push({ item_id: one.item_id, base_revision: base as number });
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
            "SELECT v.revision_no, e.actor FROM item_version v JOIN event e ON e.seq = v.event_seq " +
              "WHERE v.task_id = ? AND v.item_id = ? ORDER BY v.revision_no DESC LIMIT 1",
          )
          .get(task.task_id, target.item_id) as { revision_no: number; actor: string };
        if (current.revision_no !== target.base_revision) {
          stale.push({ item_id: target.item_id, base_revision: target.base_revision, current_revision: current.revision_no,
            changed_by: actorWord(current.actor) });
        }
      }
      if (missing.length > 0) {
        throw new UserOpError("rejected", `条目 ${missing.join("、")} 不存在或已经删除。`, { reasons: missing.map((id) => `条目 ${id} 不存在或已经删除`) });
      }
      if (stale.length > 0) {
        throw new UserOpError("stale_revision", "这个条目刚被改过（可能是助手，也可能是另一个页面），请看最新内容后再改。", { items: stale });
      }
      if (kind === "edit_fields" || kind === "keep_pending") {
        const sources = new Map(targets.map((t) => [t.item_id, readSources(db, task.task_id, t.item_id, t.base_revision)]));
        return { targets, sources, userEditOk: acceptsUserEditSource(db) };
      }
      return { targets };
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) throw new UserOpError("no_task", "这个任务目录里还没有任务记录。");
    throw error;
  }
}

/** 确认标记的依据：写进 judgement.basis 的中文名，与事件 payload 里的英文名一一对应。 */
export const CONFIRMATION_BASIS = { viewed: "已读", ui_edit: "界面修改", ui_click: "界面点击" } as const;
export type ConfirmationBasis = keyof typeof CONFIRMATION_BASIS;

/**
 * 在调用方的事务里写一次确认标记：judgement 一行、每个条目在给定修订上的态度各一行，记一条事件
 * （已读记 ITEM_VIEWED，其余记 CONFIRMATION_RECORDED）。返回事件序号。
 */
function recordMark(
  db: DatabaseSync,
  ctx: Ctx,
  opId: string,
  items: { item_id: string; revision_no: number }[],
  accepted: boolean,
  basis: ConfirmationBasis,
): number {
  const task = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string };
  const at = wallClockText();
  const eventSeq = emit(db, {
    taskId: task.task_id,
    sessionId: ctx.sessionId,
    callId: opId,
    name: basis === "viewed" ? EVENT_ITEM_VIEWED : EVENT_CONFIRMATION_RECORDED,
    payload: basis === "viewed"
      ? { items: items.map((t) => ({ item_id: t.item_id, revision_no: t.revision_no })), basis }
      : { items: items.map((t) => ({ item_id: t.item_id, revision_no: t.revision_no, accepted })), basis },
    actor: ACTOR_USER,
  });
  const judgement = db
    .prepare("INSERT INTO judgement (task_id, basis, call_id, event_seq, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(task.task_id, dump([{ 依据: CONFIRMATION_BASIS[basis], 操作编号: opId }]), opId, eventSeq, at);
  const judgementId = Number(judgement.lastInsertRowid);
  const insert = db.prepare(
    "INSERT INTO judgement_item (judgement_id, task_id, item_id, revision_no, attitude, event_seq) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const t of items) insert.run(judgementId, task.task_id, t.item_id, t.revision_no, accepted ? "接受" : "不接受", eventSeq);
  return eventSeq;
}

/** 条目在这次修订上最近一条标记是不是接受（任一依据）。 */
function acceptedAt(db: DatabaseSync, itemId: string, revisionNo: number): boolean {
  const row = db
    .prepare("SELECT attitude FROM judgement_item WHERE item_id = ? AND revision_no = ? ORDER BY judgement_id DESC LIMIT 1")
    .get(itemId, revisionNo) as { attitude?: string } | undefined;
  return row?.attitude === "接受";
}

/**
 * 标为已读：条目在给定修订上最近一条标记已经是接受的跳过（幂等），其余写一次已读标记。都跳过时什么都不写、不记事件。
 * notify_executor 为真（卡片上点「这几条都看过了」）时追加一条界面操作说明，并按固定模板告诉执行者；
 * 为假（打开详情）时不往会话里追加任何东西。
 */
function markViewed(ctx: Ctx, opId: string, targets: Target[], notify: boolean): UserOpResult {
  const items = targets.map((t) => ({ item_id: t.item_id, revision_no: t.base_revision }));
  const seq = withTaskDatabase(ctx.workspaceDir, { createIfMissing: false }, (db: DatabaseSync) => {
    const fresh = items.filter((t) => !acceptedAt(db, t.item_id, t.revision_no));
    return fresh.length === 0 ? null : recordMark(db, ctx, opId, fresh, true, "viewed");
  });
  const list = items.map((t) => `${t.item_id}（修订 ${t.revision_no}）`);
  return {
    op_id: opId,
    kind: "mark_viewed",
    event_seqs: seq === null ? [] : [seq],
    results: items,
    revision_no: null,
    note: notify ? `界面操作（不是用户打的字）：用户在卡片上表示看过了 ${list.join("、")}，已记为已读。` : "",
    notify_text: notify ? `${VIEWED_NOTICE_PREFIX}${list.join("，")}。请接着往下做。` : null,
    undoable: false,
  };
}

/** 卡片上点「这几条都看过了」之后发给执行者的那句话的开头。后端（service/conversation.py）按它认出这句不是用户打的字。 */
export const VIEWED_NOTICE_PREFIX = "我已经看过了：";

/** 撤回确认：写一条不接受的标记（依据是界面点击），记一条事件。 */
function unconfirm(ctx: Ctx, opId: string, targets: Target[]): UserOpResult {
  const items = targets.map((t) => ({ item_id: t.item_id, revision_no: t.base_revision }));
  const seq = withTaskDatabase(ctx.workspaceDir, { createIfMissing: false }, (db: DatabaseSync) => recordMark(db, ctx, opId, items, false, "ui_click"));
  return {
    op_id: opId,
    kind: "unconfirm",
    event_seqs: [seq],
    results: items,
    revision_no: null,
    note: `界面操作（不是用户打的字）：用户在界面上撤回了对 ${items.map((t) => `${t.item_id}（修订 ${t.revision_no}）`).join("、")}的确认。`,
    notify_text: null,
    undoable: false,
  };
}

interface RevisionOp {
  op: string;
  item: string;
  /** 改前条目所在的修订；新增时为空。 */
  from_revision: number | null;
  /** 改后条目所在的修订，即这次修订；删除时为空。 */
  to_revision: number | null;
}

/** 撤销一次修订：产生一次新的修订，把它涉及的每个条目改回那次改动之前的样子（如同 git revert）。之后又被改过就拒绝。 */
function undo(ctx: Ctx, opId: string, revisionNo: number): UserOpResult {
  const backTo: (number | null)[] = [];
  const plan = withTaskDatabase(ctx.workspaceDir, { createIfMissing: false }, (db: DatabaseSync) => {
    const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; definition_text: string };
    const definition = validateDefinition(JSON.parse(task.definition_text));
    const revision = db.prepare("SELECT event_seq FROM revision WHERE task_id = ? AND revision_no = ?").get(task.task_id, revisionNo) as
      | { event_seq: number }
      | undefined;
    if (!revision) throw new UserOpError("bad_request", `没有修订 ${revisionNo}。`);
    const payload = load((db.prepare("SELECT payload FROM event WHERE seq = ?").get(revision.event_seq) as { payload: string }).payload) as {
      operations: RevisionOp[];
    };
    const conflicts: Record<string, unknown>[] = [];
    const operations: Record<string, unknown>[] = [];
    const contentAt = (item: string, no: number) =>
      db.prepare("SELECT fields FROM item_version WHERE task_id = ? AND item_id = ? AND revision_no = ?").get(task.task_id, item, no) as
        | { fields: string }
        | undefined;
    const sourcesOf = (item: string, no: number) => readSources(db, task.task_id, item, no);
    for (const op of payload.operations) {
      const item = db.prepare("SELECT collection, deleted_in_revision FROM item WHERE task_id = ? AND item_id = ?").get(task.task_id, op.item) as {
        collection: string;
        deleted_in_revision: number | null;
      };
      const latest = (db.prepare("SELECT MAX(revision_no) AS v FROM item_version WHERE task_id = ? AND item_id = ?").get(task.task_id, op.item) as { v: number }).v;
      const declared = definition.collections.find((c) => c.name === item.collection)?.fields ?? [];
      const fullFields = (no: number) => {
        const old = load(contentAt(op.item, no)!.fields) as Record<string, unknown>;
        return Object.fromEntries(declared.map((f) => [f.name, f.name in old ? old[f.name] : f.type === "文本" || f.type === "枚举" ? "" : []]));
      };
      if (op.op === "add" || op.op === "restore") {
        if (item.deleted_in_revision !== null || latest !== op.to_revision) {
          conflicts.push({ item_id: op.item, reason: `${op.item} 在这次修订之后又被改过或删除了` });
          continue;
        }
        operations.push({ op: "delete", item: op.item, base_revision: latest });
        backTo.push(null);
      } else if (op.op === "update") {
        if (item.deleted_in_revision !== null || latest !== op.to_revision) {
          conflicts.push({ item_id: op.item, reason: `${op.item} 在这次修订之后又被改过或删除了（现在是修订 ${latest}）` });
          continue;
        }
        operations.push({ op: "update", item: op.item, base_revision: latest, fields: fullFields(op.from_revision!), sources: sourcesOf(op.item, op.from_revision!) });
        backTo.push(op.from_revision);
      } else if (op.op === "delete") {
        if (item.deleted_in_revision !== revisionNo || latest !== op.from_revision) {
          conflicts.push({ item_id: op.item, reason: `${op.item} 在这次修订之后又有了变化` });
          continue;
        }
        operations.push({ op: "restore", item: op.item, base_revision: latest, fields: fullFields(op.from_revision!), sources: sourcesOf(op.item, op.from_revision!) });
        backTo.push(op.from_revision);
      }
    }
    if (conflicts.length > 0) {
      throw new UserOpError("undo_conflict", `修订 ${revisionNo} 之后，同一个条目又被改过，不能撤销。`, { revision_no: revisionNo, items: conflicts });
    }
    return operations;
  });
  const outcome = save(ctx, opId, { operations: plan, undo_of_revision: revisionNo });
  const details = outcome.details as { revision_no: number; event_seq: number; operations: RevisionOp[] };
  // 每个条目退回了哪次修订的内容：撤销前在库里读好的改前修订号（update 与 restore 的 fields 取自它）。
  const undone = new Map((plan as { item: string; op: string }[]).map((one, i) => [one.item, backTo[i]]));
  const words: Record<string, string> = { delete: "删除", update: "改回", restore: "恢复" };
  return {
    op_id: opId,
    kind: "undo",
    event_seqs: [details.event_seq],
    results: details.operations.map((o) => ({ item_id: o.item, revision_no: o.to_revision })),
    revision_no: details.revision_no,
    note:
      `界面操作（不是用户打的字）：用户撤销了修订 ${revisionNo}，产生修订 ${details.revision_no}：` +
      details.operations.map((o) => o.op === "delete" ? `删除 ${o.item}（这是修订 ${revisionNo} 新增的）`
        : `${words[o.op] ?? o.op} ${o.item}（${o.item} 退回修订 ${undone.get(o.item)} 的内容，现在是修订 ${o.to_revision}）`).join("、") + "。" +
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

// ───────────── 评审：保留写法、撤销保留、改评审规则 ─────────────

function taskRow(db: DatabaseSync): { task_id: string; definition_path: string; definition_text: string } {
  return db.prepare("SELECT task_id, definition_path, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
    { task_id: string; definition_path: string; definition_text: string };
}

function itemsPhrase(items: { item_id: string; revision_no: number }[]): string {
  return items.map((t) => `${t.item_id}（修订 ${t.revision_no}）`).join("、");
}

/** 保留写法：每个目标在 base_revision 上、当前规则下评审不合规，而且还没有生效的保留，才写。 */
function waiveReview(ctx: Ctx, opId: string, targets: Target[], rawFields: unknown): UserOpResult {
  const fields = isObject(rawFields) ? rawFields : {};
  const reason = typeof fields.reason === "string" && fields.reason.trim() ? fields.reason.trim() : null;
  const source = fields.source === "panel" ? "panel" : "detail";
  const items = targets.map((t) => ({ item_id: t.item_id, revision_no: t.base_revision }));
  const seq = withTaskDatabase(ctx.workspaceDir, { createIfMissing: false }, (db) => {
    const task = taskRow(db);
    const problems: string[] = [];
    for (const one of items) {
      const collection = (db.prepare("SELECT collection FROM item WHERE task_id = ? AND item_id = ?").get(task.task_id, one.item_id) as { collection: string }).collection;
      const verdicts = currentReviews(db, task.task_id, one.item_id, one.revision_no, currentRulesHash(db, ctx.workspaceDir, collection)).map((r) => r.verdict);
      if (!verdicts.length || verdicts.includes("合规")) problems.push(`${one.item_id} 在修订 ${one.revision_no} 上没有评审不合规的记录，不用保留`);
      else if (activeWaiver(db, task.task_id, one.item_id, one.revision_no)) problems.push(`${one.item_id} 在修订 ${one.revision_no} 上已经保留过了`);
    }
    if (problems.length) throw new UserOpError("rejected", `没有保留，因为：${problems.join("；")}。`, { reasons: problems });
    const at = wallClockText();
    const eventSeq = emit(db, { taskId: task.task_id, sessionId: ctx.sessionId, callId: opId, name: EVENT_REVIEW_WAIVED, actor: ACTOR_USER,
      payload: { items, reason, source } });
    const insert = db.prepare("INSERT INTO review_waiver (task_id, item_id, revision_no, reason, source, op_id, event_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const one of items) insert.run(task.task_id, one.item_id, one.revision_no, reason, source, opId, eventSeq, at);
    return eventSeq;
  });
  return {
    op_id: opId, kind: "waive_review", event_seqs: [seq], results: items, revision_no: null,
    note: `界面操作（不是用户打的字）：用户保留了 ${itemsPhrase(items)}现在的写法${reason ? `，理由：「${reason}」` : "，没有写理由"}。` +
      "这条按用户的决定算通过；条目再改动，评审要重做。",
    notify_text: null, undoable: false,
  };
}

/** 撤销保留：每个目标在 base_revision 上要有一条生效的保留。 */
function unwaiveReview(ctx: Ctx, opId: string, targets: Target[]): UserOpResult {
  const items = targets.map((t) => ({ item_id: t.item_id, revision_no: t.base_revision }));
  const seq = withTaskDatabase(ctx.workspaceDir, { createIfMissing: false }, (db) => {
    const task = taskRow(db);
    const found = items.map((one) => ({ one, waiver: activeWaiver(db, task.task_id, one.item_id, one.revision_no) }));
    const missing = found.filter((f) => !f.waiver).map((f) => `${f.one.item_id} 在修订 ${f.one.revision_no} 上没有生效的保留`);
    if (missing.length) throw new UserOpError("rejected", `没有撤销，因为：${missing.join("；")}。`, { reasons: missing });
    const eventSeq = emit(db, { taskId: task.task_id, sessionId: ctx.sessionId, callId: opId, name: EVENT_REVIEW_UNWAIVED, actor: ACTOR_USER, payload: { items } });
    const update = db.prepare("UPDATE review_waiver SET revoked_at = ?, revoked_op_id = ? WHERE waiver_id = ?");
    for (const f of found) update.run(wallClockText(), opId, f.waiver!.waiver_id);
    return eventSeq;
  });
  return {
    op_id: opId, kind: "unwaive_review", event_seqs: [seq], results: items, revision_no: null,
    note: `界面操作（不是用户打的字）：用户撤销了对 ${itemsPhrase(items)} 的保留，这些条目重新算作评审不通过。`,
    notify_text: null, undoable: false,
  };
}

/** 改一个集合的评审规则开关：fields 写 { collection, off, promote }，off 与 promote 是可选规则编号的列表。 */
function setReviewRules(ctx: Ctx, opId: string, request: UserOpRequest): UserOpResult {
  const fields = isObject(request.fields) ? request.fields : {};
  const collection = typeof fields.collection === "string" ? fields.collection : "";
  const list = (value: unknown) => (Array.isArray(value) && value.every((v) => typeof v === "string") ? [...new Set(value as string[])] : null);
  const off = list(fields.off ?? []);
  const promote = list(fields.promote ?? []);
  if (!collection || off === null || promote === null) {
    throw new UserOpError("bad_request", "set_review_rules 要带 fields：{ \"collection\": 集合名, \"off\": [规则编号…], \"promote\": [规则编号…] }。");
  }
  try {
    const outcome = withTaskDatabase(ctx.workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id, status, definition_path, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
        { task_id: string; status: string; definition_path: string; definition_text: string } | undefined;
      if (!task) throw new UserOpError("no_task", "这个任务目录里还没有任务记录。");
      if (task.status !== TASK_ACTIVE) throw new UserOpError("task_closed", `任务已经${task.status}，不能再改评审规则。`, { status: task.status });
      const before = reviewSpecOf(task.definition_text, collection);
      if (!before) throw new UserOpError("rejected", `集合「${collection}」没有评审规则，没有可以开关的规则。`, { reasons: [`集合「${collection}」没有评审规则`] });
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
      if (same(before.off, off) && same(before.promote, promote)) throw new UserOpError("rejected", "规则开关和现在一样，没有改动。");
      const raw = JSON.parse(task.definition_text) as Record<string, any>;
      const entry = (raw["交付物"]["条目集合"] as Record<string, any>[]).find((one) => one["名称"] === collection)!;
      entry["评审规矩"] = { ...entry["评审规矩"], 关闭: off, 升为必选: promote };
      try {
        validateDefinition(raw, task.definition_path, { baseDir: ctx.workspaceDir });
      } catch (error) {
        if (error instanceof DefinitionError) throw new UserOpError("rejected", `没有改，因为：${error.reasons.join("；")}`, { reasons: error.reasons });
        throw error;
      }
      const text = JSON.stringify(raw, null, 2) + "\n";
      db.prepare("UPDATE task SET definition_text = ? WHERE task_id = ?").run(text, task.task_id);
      const seq = emit(db, { taskId: task.task_id, sessionId: ctx.sessionId, callId: opId, name: EVENT_REVIEW_RULES_CHANGED, actor: ACTOR_USER,
        payload: { collection, off, promote, before: { off: before.off, promote: before.promote }, rules_hash: currentRulesHash(db, ctx.workspaceDir, collection) } });
      // 任务目录里的任务定义副本与库里的快照保持一致；写文件放在事务的最后，写不成整个操作回退。
      writeFileSync(join(ctx.workspaceDir, task.definition_path), text, "utf-8");
      return { seq, before };
    });
    const words = [off.length ? `关闭 ${off.join("、")}` : "", promote.length ? `升为必选 ${promote.join("、")}` : ""].filter(Boolean).join("；");
    return {
      op_id: opId, kind: "set_review_rules", event_seqs: [outcome.seq], results: [], revision_no: null,
      note: `界面操作（不是用户打的字）：用户改了集合「${collection}」的评审规则，现在${words || "没有关闭或升为必选的规则"}。` +
        "之后的评审按新规则；规则改了，这个集合的条目都要重新评审，已有的评审记录不变。",
      notify_text: null, undoable: false,
    };
  } catch (error) {
    if (error instanceof NoDatabaseYet) throw new UserOpError("no_task", "这个任务目录里还没有任务记录。");
    throw error;
  }
}
