/**
 * 交付物看板：扩展命令 /tw-board 打印的内容。
 *
 * 不带参数时打印整个任务：各集合的条目（编号、标题、当前版本、评审状态、确认状态）、已删除的条目、
 * 完成条件逐项满足情况，结尾一行是事件表的最后一个序号。带一个条目编号时打印这个条目某一版（缺省是当前版本）
 * 的全部字段与来源，来源写明种类、出处、摘录，以及它支持哪个字段的第几项。
 *
 * 完成条件用 conditions.ts 里与「完成任务」门禁同一组函数核对；评审与确认两个状态的取法也与那组函数一致：
 * 评审看当前版本有没有结论为合规的评审记录，确认看当前版本最近一条态度记录是不是「接受」。
 *
 * 执行者的两个只读工具「查看条目」与「查询任务状态」（lib/task_query.ts）用这里同一组取数与排版函数，
 * 所以它们的输出与看板一致。
 *
 * 库以只读方式打开，不写任何东西。本模块不依赖 pi，单元测试可以直接调用。
 */

import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { checkCompletion, currentItems } from "./conditions.ts";
import { REVIEW_CONDITION, reviewSwitchOn } from "./complete_task.ts";
import { databasePath, load } from "./db.ts";
import { type TaskDefinition, validateDefinition } from "./definition.ts";
import { BUSY_TIMEOUT_MS } from "./schema.ts";
import { titleOf } from "./tool_render.ts";

/** 标题在看板的一行里最多显示这么多个字，更长的截短并加省略号；条目详情里不截短。 */
export const TITLE_LIMIT = 40;

/** 没有满足的条目不多于这个数时逐个列出编号，再多就只说个数。与观测台看板一致。 */
export const LIST_UNMET_AT_MOST = 6;

export interface TaskRow {
  task_id: string;
  task_name: string | null;
  status: string;
  definition_text: string;
}

type Fields = Record<string, unknown>;

function shorten(text: string, limit: number): string {
  const flat = text.split(/\s+/).join(" ").trim();
  return [...flat].length <= limit ? flat : `${[...flat].slice(0, limit).join("")}…`;
}

/** 打开库，交给 body，最后关掉。库不在或还没有任务时返回一句说明。 */
export function withBoardDatabase(workspaceDir: string, body: (db: DatabaseSync, task: TaskRow, definition: TaskDefinition) => string[]): string[] {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) {
    return [`这个任务目录里还没有任务数据库（${path} 不存在）。任务要先用后端的 create_task 建好。`];
  }
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT task_id, task_name, status, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
      | TaskRow
      | undefined;
    if (!task) return ["库里还没有任务记录。"];
    return body(db, task, validateDefinition(JSON.parse(task.definition_text)));
  } finally {
    db.close();
  }
}

/** 某一版的评审状态：有合规记录是评审通过；只有不合规记录是评审没有通过；一条都没有就说还没有。 */
export function reviewState(db: DatabaseSync, taskId: string, itemId: string, versionNo: number): string {
  const rows = db
    .prepare("SELECT verdict FROM review WHERE task_id = ? AND item_id = ? AND version_no = ?")
    .all(taskId, itemId, versionNo) as { verdict: string }[];
  if (rows.some((row) => row.verdict === "合规")) return "评审通过";
  if (rows.length > 0) return "评审没有通过";
  return "还没有评审记录";
}

/** 某一版的确认状态：看最近一条态度记录。当前版本没有记录而更早的某一版被确认过时，说明确认已失效。 */
export function confirmState(db: DatabaseSync, taskId: string, itemId: string, versionNo: number): string {
  const latest = db
    .prepare("SELECT attitude FROM judgement_item WHERE task_id = ? AND item_id = ? AND version_no = ? ORDER BY judgement_id DESC LIMIT 1")
    .get(taskId, itemId, versionNo) as { attitude: string } | undefined;
  if (latest?.attitude === "接受") return "用户已确认";
  if (latest) return "用户撤回了确认或没有接受";
  const earlier = db
    .prepare(
      "SELECT MAX(version_no) AS v FROM judgement_item WHERE task_id = ? AND item_id = ? AND version_no < ? AND attitude = '接受'",
    )
    .get(taskId, itemId, versionNo) as { v: number | null };
  if (earlier.v !== null) return `还没有确认记录（第 ${earlier.v} 版确认过，之后改过）`;
  return "还没有确认记录";
}

/** 整个任务的看板。 */
export function boardLines(workspaceDir: string): string[] {
  return withBoardDatabase(workspaceDir, (db, task, definition) => {
    const name = task.task_name ?? definition.taskName;
    const lines = [`任务 ${task.task_id}「${name}」（类型：${definition.taskName}），状态是${task.status}。`];
    for (const collection of definition.collections) {
      const rows = currentItems(db, task.task_id, collection.name);
      lines.push("", `${collection.name}（现有 ${rows.length} 个）`);
      if (rows.length === 0) lines.push("  （没有条目）");
      for (const row of rows) {
        const title = titleOf(load(row.fields) as Fields, collection.fields[0]?.name) || "（第一个字段是空的）";
        const extra = collection.fields.some((f) => f.name === "状态") ? `　状态：${String((load(row.fields) as Fields)["状态"] ?? "")}` : "";
        lines.push(
          `  ${row.item_id}　${shorten(title, TITLE_LIMIT)}　第 ${row.version_no} 版` +
            `　评审：${reviewState(db, task.task_id, row.item_id, row.version_no)}` +
            `　确认：${confirmState(db, task.task_id, row.item_id, row.version_no)}${extra}`,
        );
      }
      const deleted = db
        .prepare("SELECT item_id, deleted_in_revision FROM item WHERE task_id = ? AND collection = ? AND deleted_in_revision IS NOT NULL ORDER BY serial")
        .all(task.task_id, collection.name) as { item_id: string; deleted_in_revision: number }[];
      if (deleted.length > 0) {
        lines.push(`  已删除：${deleted.map((d) => `${d.item_id}（第 ${d.deleted_in_revision} 次修订删除）`).join("、")}`);
      }
    }
    lines.push("", ...completionLines(db, task, definition), "", lastEventLine(db));
    return lines;
  });
}

/** 完成条件逐项情况（已满足、还差、暂无条目），用 conditions.ts 里与「完成任务」门禁同一组函数。看板与「查询任务状态」共用。 */
export function completionLines(db: DatabaseSync, task: TaskRow, definition: TaskDefinition): string[] {
  const results = checkCompletion(db, task.task_id, definition.completion);
  const unmetCount = results.filter((one) => one.state === "unmet").length;
  const lines = [unmetCount === 0 ? "完成条件都已满足，可以完成任务：" : `要完成任务，还差 ${unmetCount} 项：`];
  const mark = { met: "[已满足]", unmet: "[还差]", empty: "[暂无条目]" } as const;
  for (const one of results) {
    const unmet = one.unmet.map((u) => u.item).filter((item): item is string => item !== null);
    const list = unmet.length > 0 && unmet.length <= LIST_UNMET_AT_MOST ? `它们是：${unmet.join("、")}。` : "";
    lines.push(`  ${mark[one.state ?? (one.satisfied ? "met" : "unmet")]} ${one.collection}：${one.condition}。${one.summary}${list}`);
  }
  if (reviewSwitchOn() && results.some((one) => one.state === "unmet" && one.condition === REVIEW_CONDITION)) {
    lines.push(`  开发期开关打开了：评审工具还没有，「完成任务」会把「${REVIEW_CONDITION}」这一条暂时视为满足；其余条件都满足时就可以调用完成任务。`);
  }
  return lines;
}

/** 事件表的最后一个序号那一行。 */
export function lastEventLine(db: DatabaseSync): string {
  const last = db.prepare("SELECT seq, name, actor, at FROM event ORDER BY seq DESC LIMIT 1").get() as
    | { seq: number; name: string; actor: string; at: string }
    | undefined;
  return last ? `事件表的最后一个序号是 ${last.seq}（${last.name}，发起方 ${last.actor}，时刻 ${last.at}）。` : "事件表里还没有事件。";
}

/** 一个条目某一版（缺省是当前版本）的全部字段与来源。 */
export function itemLines(workspaceDir: string, itemId: string, versionNo?: number): string[] {
  return withBoardDatabase(workspaceDir, (db, task, definition) => itemDetailLines(db, task, definition, itemId, versionNo));
}

/** 条目详情的排版，看板与「查看条目」共用。条目或版本不存在时返回一行说明。 */
export function itemDetailLines(db: DatabaseSync, task: TaskRow, definition: TaskDefinition, itemId: string, versionNo?: number): string[] {
  const item = db
    .prepare("SELECT collection, added_in_revision, deleted_in_revision FROM item WHERE task_id = ? AND item_id = ?")
    .get(task.task_id, itemId) as { collection: string; added_in_revision: number; deleted_in_revision: number | null } | undefined;
  if (!item) return [`没有条目 ${itemId}。条目编号要写全，例如 UC-001。`];
  const versions = db
    .prepare(
      "SELECT v.version_no, v.revision_no, v.fields, e.actor FROM item_version v JOIN event e ON e.seq = v.event_seq " +
        "WHERE v.task_id = ? AND v.item_id = ? ORDER BY v.version_no",
    )
    .all(task.task_id, itemId) as { version_no: number; revision_no: number; fields: string; actor: string }[];
  const latest = versions[versions.length - 1];
  const chosen = versionNo === undefined ? latest : versions.find((v) => v.version_no === versionNo);
  if (!chosen) return [`条目 ${itemId} 没有第 ${versionNo} 版，它有第 1 到第 ${latest.version_no} 版。`];
  const declared = definition.collections.find((c) => c.name === item.collection)?.fields ?? [];
  const fields = load(chosen.fields) as Fields;
  const lines = [
    `条目 ${itemId}（集合「${item.collection}」），第 ${chosen.version_no} 版` +
      (chosen === latest ? "，是当前版本" : `，当前版本是第 ${latest.version_no} 版`) +
      (item.deleted_in_revision !== null ? `；这个条目已在第 ${item.deleted_in_revision} 次修订删除` : "") +
      "。",
    `  评审：${reviewState(db, task.task_id, itemId, chosen.version_no)}　确认：${confirmState(db, task.task_id, itemId, chosen.version_no)}`,
    `  版本历史：${versions.map((v) => `第 ${v.version_no} 版由第 ${v.revision_no} 次修订产生（发起方 ${v.actor}）`).join("；")}。`,
    "",
    "字段：",
  ];
  for (const field of declared) {
    const value = fields[field.name];
    if (Array.isArray(value)) {
      lines.push(`  ${field.name}（${field.type}）：${value.length === 0 ? "（空列表）" : ""}`);
      value.forEach((one, index) => lines.push(`    ${index + 1}. ${String(one)}`));
    } else {
      const text = value === undefined || value === null || value === "" ? "（没有填）" : String(value);
      lines.push(`  ${field.name}（${field.type}）：${text}`);
    }
  }
  const sources = db
    .prepare(
      "SELECT position, kind, locator, excerpt, field, field_index FROM item_source " +
        "WHERE task_id = ? AND item_id = ? AND version_no = ? ORDER BY position, support_no",
    )
    .all(task.task_id, itemId, chosen.version_no) as {
    position: number;
    kind: string;
    locator: string;
    excerpt: string;
    field: string | null;
    field_index: number | null;
  }[];
  const grouped = new Map<number, { kind: string; locator: string; excerpt: string; supports: string[] }>();
  for (const row of sources) {
    let one = grouped.get(row.position);
    if (!one) grouped.set(row.position, (one = { kind: row.kind, locator: row.locator, excerpt: row.excerpt, supports: [] }));
    if (row.field !== null) one.supports.push(row.field_index === null ? `「${row.field}」整个字段` : `「${row.field}」第 ${row.field_index + 1} 项`);
  }
  lines.push("", `来源（${grouped.size} 条）：`);
  if (grouped.size === 0) lines.push("  （没有来源）");
  for (const [position, one] of grouped) {
    lines.push(`  ${position}. ${one.kind}，出处 ${one.locator}`);
    lines.push(`     摘录：「${one.excerpt}」`);
    lines.push(`     支持：${one.supports.length === 0 ? "整个条目" : one.supports.join("、")}`);
  }
  return lines;
}

/** 解析 /tw-board 的参数：空是整个看板；「UC-001」或「UC-001 2」是条目详情。解析不了返回 null。 */
export function parseBoardArgs(args: string): { itemId?: string; versionNo?: number } | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length > 2) return null;
  const versionNo = parts[1] === undefined ? undefined : Number(parts[1].replace(/^第|版$/g, ""));
  if (versionNo !== undefined && !(Number.isInteger(versionNo) && versionNo >= 1)) return null;
  return { itemId: parts[0].toUpperCase(), versionNo };
}

/** 按参数给出要打印的几行。 */
export function boardCommandLines(workspaceDir: string, args: string): string[] {
  const parsed = parseBoardArgs(args);
  if (parsed === null) return ["用法：/tw-board 打印整个看板；/tw-board UC-001 打印这个条目的当前版本；/tw-board UC-001 2 打印第 2 版。"];
  return parsed.itemId === undefined ? boardLines(workspaceDir) : itemLines(workspaceDir, parsed.itemId, parsed.versionNo);
}
