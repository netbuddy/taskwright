/**
 * 执行者的两个只读工具的核心逻辑：「查看条目」（get_item）与「查询任务状态」（get_task_status）。
 *
 * 取数与排版用 board.ts 里与交付物看板（/tw-board）同一组函数，所以工具的输出与看板一致；完成条件用
 * conditions.ts 里与「完成任务」门禁同一组函数。库以只读方式打开，不写任何东西，也不记事件。
 * 查不到时抛异常，异常文字用中文写明原因，由 pi 交还模型。本模块不依赖 pi，单元测试可以直接调用。
 */

import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { completionLines, confirmState, itemDetailLines, lastEventLine, reviewState, type TaskRow } from "./board.ts";
import { checkCompletion, currentItems } from "./conditions.ts";
import { databasePath, load } from "./db.ts";
import { type TaskDefinition, validateDefinition } from "./definition.ts";
import { BUSY_TIMEOUT_MS } from "./schema.ts";
import { titleOf } from "./tool_render.ts";

/** 工具的返回：给模型的一段文字，给读取一侧的结构化内容。 */
export interface QueryOutcome {
  text: string;
  details: Record<string, unknown>;
}

function withTask<T>(workspaceDir: string, body: (db: DatabaseSync, task: TaskRow, definition: TaskDefinition) => T): T {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error("这个任务目录里还没有任务记录，没有东西可以查。任务由用户在界面上创建，请把这个情况如实告诉用户。");
  }
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT task_id, task_name, status, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
      | TaskRow
      | undefined;
    if (!task) throw new Error("库里还没有任务记录，没有东西可以查。");
    return body(db, task, validateDefinition(JSON.parse(task.definition_text)));
  } finally {
    db.close();
  }
}

/** 「查看条目」：某个条目某一版（缺省是当前版本）的全部字段、来源、评审与确认状态。 */
export function getItem(workspaceDir: string, params: { item_id?: unknown; version_no?: unknown }): QueryOutcome {
  const itemId = typeof params.item_id === "string" ? params.item_id.trim().toUpperCase() : "";
  if (!itemId) throw new Error("item_id 要写条目编号，例如 UC-001。");
  const wanted = params.version_no;
  if (wanted !== undefined && wanted !== null && !(typeof wanted === "number" && Number.isInteger(wanted) && wanted >= 1)) {
    throw new Error(`version_no 应当是从 1 起的整数，或者不写（看当前版本），现在写的是 ${JSON.stringify(wanted)}。`);
  }
  return withTask(workspaceDir, (db, task, definition) => {
    const item = db
      .prepare("SELECT collection, deleted_in_revision FROM item WHERE task_id = ? AND item_id = ?")
      .get(task.task_id, itemId) as { collection: string; deleted_in_revision: number | null } | undefined;
    if (!item) {
      const alive = (db.prepare("SELECT item_id FROM item WHERE task_id = ? AND deleted_in_revision IS NULL ORDER BY rowid").all(task.task_id) as {
        item_id: string;
      }[]).map((row) => row.item_id);
      throw new Error(`这个任务里没有条目 ${itemId}。现有的条目是：${alive.length ? alive.join("、") : "（一个都没有）"}。`);
    }
    if (item.deleted_in_revision !== null) throw new Error(`条目 ${itemId} 已在第 ${item.deleted_in_revision} 次修订删除，不在交付物里了。`);
    const current = (db.prepare("SELECT MAX(version_no) AS v FROM item_version WHERE task_id = ? AND item_id = ?").get(task.task_id, itemId) as { v: number }).v;
    const versionNo = typeof wanted === "number" ? wanted : current;
    const row = db
      .prepare("SELECT fields FROM item_version WHERE task_id = ? AND item_id = ? AND version_no = ?")
      .get(task.task_id, itemId, versionNo) as { fields: string } | undefined;
    if (!row) throw new Error(`条目 ${itemId} 没有第 ${versionNo} 版，它有第 1 到第 ${current} 版。`);
    const fields = load(row.fields) as Record<string, unknown>;
    const sources = (db
      .prepare(
        "SELECT position, kind, locator, excerpt, field, field_index FROM item_source WHERE task_id = ? AND item_id = ? AND version_no = ? ORDER BY position, support_no",
      )
      .all(task.task_id, itemId, versionNo) as { position: number; kind: string; locator: string; excerpt: string; field: string | null; field_index: number | null }[])
      .reduce<{ kind: string; locator: string; excerpt: string; supports: { field: string; index?: number }[] }[]>((list, one) => {
        let source = list[one.position - 1];
        if (!source) list[one.position - 1] = source = { kind: one.kind, locator: one.locator, excerpt: one.excerpt, supports: [] };
        if (one.field !== null) source.supports.push(one.field_index === null ? { field: one.field } : { field: one.field, index: one.field_index });
        return list;
      }, []);
    const lines = itemDetailLines(db, task, definition, itemId, versionNo);
    lines.push(
      "",
      versionNo === current
        ? `要修改或删除这个条目时，base_version 写 ${current}。修改时 fields 只写要改的字段，列表型字段要写改后的完整列表。`
        : `这是旧版本；当前版本是第 ${current} 版，要修改时先看当前版本，base_version 写 ${current}。`,
      `这一版各字段的原值（JSON）：${JSON.stringify(fields)}`,
    );
    return {
      text: lines.join("\n"),
      details: {
        task_id: task.task_id,
        item_id: itemId,
        collection: item.collection,
        version_no: versionNo,
        current_version: current,
        fields,
        sources,
        review: reviewState(db, task.task_id, itemId, versionNo),
        confirm: confirmState(db, task.task_id, itemId, versionNo),
      },
    };
  });
}

/** 「查询任务状态」：各集合的条目、完成条件逐项、未解决的待定事项、最近一次修订与事件序号。 */
export function getTaskStatus(workspaceDir: string): QueryOutcome {
  return withTask(workspaceDir, (db, task, definition) => {
    const name = task.task_name ?? definition.taskName;
    const lines = [`任务 ${task.task_id}「${name}」（类型：${definition.taskName}），状态是${task.status}。`, ""];
    const counts: Record<string, string[]> = {};
    const unresolved: { item_id: string; version_no: number; title: string }[] = [];
    for (const collection of definition.collections) {
      const rows = currentItems(db, task.task_id, collection.name);
      counts[collection.name] = rows.map((row) => row.item_id);
      lines.push(`${collection.name} ${rows.length} 个${rows.length ? `：${rows.map((row) => `${row.item_id}（第 ${row.version_no} 版）`).join("、")}` : ""}。`);
      const status = collection.fields.find((field) => field.name === "状态");
      if (!status || !(status.values ?? []).includes("未解决")) continue;
      for (const row of rows) {
        const fields = load(row.fields) as Record<string, unknown>;
        if (fields["状态"] === "未解决") unresolved.push({ item_id: row.item_id, version_no: row.version_no, title: titleOf(fields, collection.fields[0]?.name) });
      }
    }
    lines.push("", ...completionLines(db, task, definition), "");
    lines.push(
      unresolved.length === 0
        ? "未解决的待定事项：没有。"
        : `未解决的待定事项 ${unresolved.length} 条：\n${unresolved.map((one) => `  ${one.item_id}（第 ${one.version_no} 版）：${one.title}`).join("\n")}`,
    );
    const revision = db.prepare("SELECT revision_no, event_seq FROM revision WHERE task_id = ? ORDER BY revision_no DESC LIMIT 1").get(task.task_id) as
      | { revision_no: number; event_seq: number }
      | undefined;
    lines.push(
      revision ? `最近一次修订是第 ${revision.revision_no} 次（事件序号 ${revision.event_seq}）。` : "交付物还没有任何修订。",
      lastEventLine(db),
    );
    const last = db.prepare("SELECT MAX(seq) AS seq FROM event").get() as { seq: number | null };
    return {
      text: lines.join("\n"),
      details: {
        task_id: task.task_id,
        status: task.status,
        items: counts,
        conditions: checkCompletion(db, task.task_id, definition.completion),
        unresolved,
        last_revision_no: revision?.revision_no ?? null,
        last_event_seq: last.seq,
      },
    };
  });
}
