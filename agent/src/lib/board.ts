/**
 * 交付物看板：扩展命令 /tw-board 打印的内容。
 *
 * 不带参数时打印整个任务：各集合的条目（编号、标题、当前所在的修订、评审状态、确认状态）、已删除的条目、
 * 完成条件逐项满足情况，结尾一行是事件表的最后一个序号。带一个条目编号时打印这个条目在某次修订时的内容
 * （缺省是最新）的全部字段与来源，来源写明种类、出处、摘录，以及它支持哪个字段的第几项。
 *
 * 完成条件用 conditions.ts 里与「完成任务」门禁同一组函数核对；评审与确认两个状态的取法也与那组函数一致：
 * 评审看条目当前所在的修订有没有结论为合规的评审记录；确认看这个条目有没有过「接受」的标记，从没有过就叫「未读」
 * （已读是条目级、单向的，看过之后再改也不翻回未读，看板上写明用户最后看过哪次修订）。
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
import { BUSY_TIMEOUT_MS, OLD_VERSION_FORMAT_TEXT, hasVersionColumns } from "./schema.ts";
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
    if (hasVersionColumns(db)) return [OLD_VERSION_FORMAT_TEXT];
    return body(db, task, validateDefinition(JSON.parse(task.definition_text)));
  } finally {
    db.close();
  }
}

/** 条目在某次修订下的评审状态：有合规记录是评审通过；只有不合规记录是评审没有通过；一条都没有就说还没有。 */
export function reviewState(db: DatabaseSync, taskId: string, itemId: string, revisionNo: number): string {
  const rows = db
    .prepare("SELECT verdict FROM review WHERE task_id = ? AND item_id = ? AND revision_no = ?")
    .all(taskId, itemId, revisionNo) as { verdict: string }[];
  if (rows.some((row) => row.verdict === "合规")) return "评审通过";
  if (rows.length > 0) return "评审没有通过";
  return "还没有评审记录";
}

/** 确认标记依据的中文名（judgement.basis 里的「依据」）在看板上的说法。早期版本的库里还有「界面点击」确认与「用户的话」。 */
const BASIS_WORDS: Record<string, string> = {
  已读: "用户打开看过（已读）",
  界面修改: "用户在界面上亲手改的",
  界面点击: "用户在界面上点了确认",
};

/**
 * 条目在某次修订下的确认状态：这次修订上最近一条标记是接受的，写明依据；否则看这个条目在别的修订上有没有
 * 接受的标记，有就仍是已读，写明用户最后看过哪次修订；从没有过接受的标记才是「未读」。
 */
export function confirmState(db: DatabaseSync, taskId: string, itemId: string, revisionNo: number): string {
  const latest = db
    .prepare(
      "SELECT j.attitude, g.basis FROM judgement_item j JOIN judgement g ON g.judgement_id = j.judgement_id " +
        "WHERE j.task_id = ? AND j.item_id = ? AND j.revision_no = ? ORDER BY j.judgement_id DESC LIMIT 1",
    )
    .get(taskId, itemId, revisionNo) as { attitude: string; basis: string } | undefined;
  if (latest?.attitude === "接受") {
    const basis = (load(latest.basis) as { 依据?: string }[] | null) ?? [];
    const said = basis.map((b) => b?.依据).find((b) => b && BASIS_WORDS[b]);
    return `已确认，${said ? BASIS_WORDS[said] : "依据是用户在对话里说的话（早期版本登记）"}`;
  }
  const last = db
    .prepare("SELECT MAX(revision_no) AS v FROM judgement_item WHERE task_id = ? AND item_id = ? AND attitude = '接受'")
    .get(taskId, itemId) as { v: number | null };
  if (last.v === null) return "未读（用户从没看过）";
  if (last.v === revisionNo) return "已读（用户看过这次修订，之后撤回过确认）";
  return last.v < revisionNo ? `已读（用户最后看过修订 ${last.v}，之后又改过）` : `已读（用户看过修订 ${last.v}）`;
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
          `  ${row.item_id}　${shorten(title, TITLE_LIMIT)}　修订 ${row.revision_no}` +
            `　评审：${reviewState(db, task.task_id, row.item_id, row.revision_no)}` +
            `　确认：${confirmState(db, task.task_id, row.item_id, row.revision_no)}${extra}`,
        );
      }
      const deleted = db
        .prepare("SELECT item_id, deleted_in_revision FROM item WHERE task_id = ? AND collection = ? AND deleted_in_revision IS NOT NULL ORDER BY serial")
        .all(task.task_id, collection.name) as { item_id: string; deleted_in_revision: number }[];
      if (deleted.length > 0) {
        lines.push(`  已删除：${deleted.map((d) => `${d.item_id}（修订 ${d.deleted_in_revision} 删除）`).join("、")}`);
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

/** 一个条目在某次修订时（缺省是最新）的全部字段与来源。 */
export function itemLines(workspaceDir: string, itemId: string, revisionNo?: number): string[] {
  return withBoardDatabase(workspaceDir, (db, task, definition) => itemDetailLines(db, task, definition, itemId, revisionNo));
}

/** 任务最新的修订号；还没有修订时是 0。 */
export function latestRevision(db: DatabaseSync, taskId: string): number {
  return Number((db.prepare("SELECT COALESCE(MAX(revision_no), 0) AS n FROM revision WHERE task_id = ?").get(taskId) as { n: number }).n);
}

/** 条目改动过的修订号，从早到晚。 */
export function itemRevisions(db: DatabaseSync, taskId: string, itemId: string): number[] {
  return (db.prepare("SELECT revision_no FROM item_version WHERE task_id = ? AND item_id = ? ORDER BY revision_no").all(taskId, itemId) as { revision_no: number }[])
    .map((row) => row.revision_no);
}

/**
 * 条目详情的排版，看板与「查看条目」共用。给了修订号 N 时，显示条目截至修订 N 的内容：条目在修订号不大于 N 的
 * 最近一次改动（如同看某个提交时的文件）。条目不存在、或修订 N 时还没有这个条目，返回一行说明。
 */
export function itemDetailLines(db: DatabaseSync, task: TaskRow, definition: TaskDefinition, itemId: string, revisionNo?: number): string[] {
  const item = db
    .prepare("SELECT collection, added_in_revision, deleted_in_revision FROM item WHERE task_id = ? AND item_id = ?")
    .get(task.task_id, itemId) as { collection: string; added_in_revision: number; deleted_in_revision: number | null } | undefined;
  if (!item) return [`没有条目 ${itemId}。条目编号要写全，例如 UC-001。`];
  const versions = db
    .prepare(
      "SELECT v.revision_no, v.fields, e.actor FROM item_version v JOIN event e ON e.seq = v.event_seq " +
        "WHERE v.task_id = ? AND v.item_id = ? ORDER BY v.revision_no",
    )
    .all(task.task_id, itemId) as { revision_no: number; fields: string; actor: string }[];
  const latest = versions[versions.length - 1];
  const newest = latestRevision(db, task.task_id);
  if (revisionNo !== undefined && revisionNo > newest) return [`这个任务还没有修订 ${revisionNo}，最新是修订 ${newest}。`];
  const chosen = revisionNo === undefined ? latest : [...versions].reverse().find((v) => v.revision_no <= revisionNo);
  const list = versions.map((v) => `修订 ${v.revision_no}`).join("、");
  if (!chosen) return [`修订 ${revisionNo} 时还没有条目 ${itemId}；它在这些修订里改动过：${list}。`];
  const declared = definition.collections.find((c) => c.name === item.collection)?.fields ?? [];
  const fields = load(chosen.fields) as Fields;
  const lines = [
    `条目 ${itemId}（集合「${item.collection}」），` +
      (revisionNo !== undefined && revisionNo !== chosen.revision_no ? `修订 ${revisionNo} 时的内容来自修订 ${chosen.revision_no}` : `修订 ${chosen.revision_no}`) +
      (chosen === latest ? "，是最新内容" : `，最新内容在修订 ${latest.revision_no}`) +
      (item.deleted_in_revision !== null ? `；这个条目已在修订 ${item.deleted_in_revision} 删除` : "") +
      "。",
    `  评审：${reviewState(db, task.task_id, itemId, chosen.revision_no)}　确认：${confirmState(db, task.task_id, itemId, chosen.revision_no)}`,
    `  改动过的修订：${versions.map((v) => `修订 ${v.revision_no}（发起方 ${v.actor}）`).join("、")}。`,
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
        "WHERE task_id = ? AND item_id = ? AND revision_no = ? ORDER BY position, support_no",
    )
    .all(task.task_id, itemId, chosen.revision_no) as {
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

/** 解析 /tw-board 的参数：空是整个看板；「UC-001」或「UC-001 4」是条目详情（4 是修订号，也可以写「修订4」）。解析不了返回 null。 */
export function parseBoardArgs(args: string): { itemId?: string; revisionNo?: number } | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length > 2) return null;
  const revisionNo = parts[1] === undefined ? undefined : Number(parts[1].replace(/^修订/, ""));
  if (revisionNo !== undefined && !(Number.isInteger(revisionNo) && revisionNo >= 1)) return null;
  return { itemId: parts[0].toUpperCase(), revisionNo };
}

/** 按参数给出要打印的几行。 */
export function boardCommandLines(workspaceDir: string, args: string): string[] {
  const parsed = parseBoardArgs(args);
  if (parsed === null) return ["用法：/tw-board 打印整个看板；/tw-board UC-001 打印这个条目的最新内容；/tw-board UC-001 4 打印它在修订 4 时的内容。"];
  return parsed.itemId === undefined ? boardLines(workspaceDir) : itemLines(workspaceDir, parsed.itemId, parsed.revisionNo);
}
