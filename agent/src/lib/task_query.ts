/**
 * 执行者的两个只读工具的核心逻辑：「查看条目」（get_item）与「查询任务状态」（get_task_status）。
 *
 * 取数与排版用 board.ts 里与交付物看板（/tw-board）同一组函数，所以工具的输出与看板一致；完成条件用
 * conditions.ts 里与「完成任务」门禁同一组函数。库以只读方式打开，不写任何东西，也不记事件。
 * 查不到时抛异常，异常文字用中文写明原因，由 pi 交还模型。本模块不依赖 pi，单元测试可以直接调用。
 */

import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { completionLines, confirmState, itemDetailLines, itemRevisions, lastEventLine, latestRevision, reviewState, type TaskRow } from "./board.ts";
import { checkCompletion, currentItems, unreadItems, unreadList } from "./conditions.ts";
import { REVIEW_CONDITION, findingText } from "./review.ts";
import { activeWaiver, batchNumber, currentRulesHash, currentReviews } from "./review_state.ts";
import { databasePath, load } from "./db.ts";
import { type TaskDefinition, validateDefinition } from "./definition.ts";
import { BUSY_TIMEOUT_MS, OLD_VERSION_FORMAT_TEXT, hasVersionColumns } from "./schema.ts";
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
    if (hasVersionColumns(db)) throw new Error(OLD_VERSION_FORMAT_TEXT);
    return body(db, task, validateDefinition(JSON.parse(task.definition_text)));
  } finally {
    db.close();
  }
}

/**
 * 「查看条目」：某个条目的全部字段、来源、评审与确认状态，以及它改动过的修订号列表。
 * 缺省看最新内容；给了 revision_no 时看条目截至那次修订的内容（修订号不大于它的最近一次改动）。
 */
export function getItem(workspaceDir: string, params: { item_id?: unknown; revision_no?: unknown }): QueryOutcome {
  const itemId = typeof params.item_id === "string" ? params.item_id.trim().toUpperCase() : "";
  if (!itemId) throw new Error("item_id 要写条目编号，例如 UC-001。");
  const wanted = params.revision_no;
  if (wanted !== undefined && wanted !== null && !(typeof wanted === "number" && Number.isInteger(wanted) && wanted >= 1)) {
    throw new Error(`revision_no 应当是从 1 起的整数，或者不写（看最新内容），现在写的是 ${JSON.stringify(wanted)}。`);
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
    if (item.deleted_in_revision !== null) throw new Error(`条目 ${itemId} 已在修订 ${item.deleted_in_revision} 删除，不在交付物里了。`);
    const revisions = itemRevisions(db, task.task_id, itemId);
    const current = revisions[revisions.length - 1];
    const newest = latestRevision(db, task.task_id);
    if (typeof wanted === "number" && wanted > newest) throw new Error(`这个任务还没有修订 ${wanted}，最新是修订 ${newest}。`);
    const shown = typeof wanted === "number" ? [...revisions].reverse().find((n) => n <= wanted) : current;
    if (shown === undefined) throw new Error(`修订 ${wanted} 时还没有条目 ${itemId}；它在这些修订里改动过：${revisions.map((n) => `修订 ${n}`).join("、")}。`);
    const row = db
      .prepare("SELECT fields FROM item_version WHERE task_id = ? AND item_id = ? AND revision_no = ?")
      .get(task.task_id, itemId, shown) as { fields: string };
    const fields = load(row.fields) as Record<string, unknown>;
    const sources = (db
      .prepare(
        "SELECT position, kind, locator, excerpt, field, field_index FROM item_source WHERE task_id = ? AND item_id = ? AND revision_no = ? ORDER BY position, support_no",
      )
      .all(task.task_id, itemId, shown) as { position: number; kind: string; locator: string; excerpt: string; field: string | null; field_index: number | null }[])
      .reduce<{ kind: string; locator: string; excerpt: string; supports: { field: string; index?: number }[] }[]>((list, one) => {
        let source = list[one.position - 1];
        if (!source) list[one.position - 1] = source = { kind: one.kind, locator: one.locator, excerpt: one.excerpt, supports: [] };
        if (one.field !== null) source.supports.push(one.field_index === null ? { field: one.field } : { field: one.field, index: one.field_index });
        return list;
      }, []);
    const lines = itemDetailLines(db, task, definition, itemId, typeof wanted === "number" ? wanted : undefined);
    lines.push(
      "",
      shown === current
        ? `${itemId} 现在是修订 ${current}。要修改或删除这个条目时，base_revision 写 ${current}。修改时 fields 只写要改的字段，列表型字段要写改后的完整列表。`
        : `这是旧内容；${itemId} 现在是修订 ${current}，要修改时先看最新内容，base_revision 写 ${current}。`,
      `这份内容各字段的原值（JSON）：${JSON.stringify(fields)}`,
    );
    return {
      text: lines.join("\n"),
      details: {
        task_id: task.task_id,
        item_id: itemId,
        collection: item.collection,
        revision_no: shown,
        current_revision: current,
        revisions,
        fields,
        sources,
        review: reviewState(db, task.task_id, itemId, shown),
        confirm: confirmState(db, task.task_id, itemId, shown),
      },
    };
  });
}

/** 「查询任务状态」：各集合的条目、完成条件逐项、未解决的问题条目、未读清单、最近一次修订与事件序号。 */
export function getTaskStatus(workspaceDir: string): QueryOutcome {
  return withTask(workspaceDir, (db, task, definition) => {
    const name = task.task_name ?? definition.taskName;
    const lines = [`任务 ${task.task_id}「${name}」（类型：${definition.taskName}），状态是${task.status}。`, ""];
    const counts: Record<string, string[]> = {};
    const unresolved: { item_id: string; revision_no: number; title: string }[] = [];
    for (const collection of definition.collections) {
      const rows = currentItems(db, task.task_id, collection.name);
      counts[collection.name] = rows.map((row) => row.item_id);
      lines.push(`${collection.name} ${rows.length} 个${rows.length ? `：${rows.map((row) => `${row.item_id}（修订 ${row.revision_no}）`).join("、")}` : ""}。`);
      const status = collection.fields.find((field) => field.name === "状态");
      if (!status || !(status.values ?? []).includes("未解决")) continue;
      for (const row of rows) {
        const fields = load(row.fields) as Record<string, unknown>;
        if (fields["状态"] === "未解决") unresolved.push({ item_id: row.item_id, revision_no: row.revision_no, title: titleOf(fields, collection.fields[0]?.name) });
      }
    }
    lines.push("", ...completionLines(db, task, definition, workspaceDir), "");
    lines.push(...reviewFindingLines(db, task.task_id, definition, workspaceDir), "");
    lines.push(
      unresolved.length === 0
        ? "未解决的问题条目：没有。"
        : `未解决的问题条目 ${unresolved.length} 条：\n${unresolved.map((one) => `  ${one.item_id}（修订 ${one.revision_no}）：${one.title}`).join("\n")}`,
    );
    const unread = unreadItems(db, task.task_id, definition.completion,
      (name) => definition.collections.find((c) => c.name === name)?.fields[0]?.name);
    lines.push(
      unread.length === 0
        ? "未读的条目：没有，每个条目用户都看过。"
        : `未读的条目 ${unread.length} 条（用户从没打开看过它们；问用户要不要完成任务之前，先告诉用户还有几条没看）：${unreadList(unread)}。`,
    );
    const revision = db.prepare("SELECT revision_no, event_seq FROM revision WHERE task_id = ? ORDER BY revision_no DESC LIMIT 1").get(task.task_id) as
      | { revision_no: number; event_seq: number }
      | undefined;
    lines.push(
      revision ? `最近一次修订是修订 ${revision.revision_no}（事件序号 ${revision.event_seq}）。` : "交付物还没有任何修订。",
      lastEventLine(db),
    );
    const last = db.prepare("SELECT MAX(seq) AS seq FROM event").get() as { seq: number | null };
    return {
      text: lines.join("\n"),
      details: {
        task_id: task.task_id,
        status: task.status,
        items: counts,
        conditions: checkCompletion(db, task.task_id, definition.completion, { workspaceDir }),
        unresolved,
        unread: unread.map((one) => ({ item_id: one.item_id, title: one.title, revision_no: one.revision_no })),
        last_revision_no: revision?.revision_no ?? null,
        last_event_seq: last.seq,
      },
    };
  });
}

/**
 * 评审发现：要评审的集合里，条目当前所在的修订上、当前规则下最近一次评审不合规的，逐条列出发现（带规则编号，写明是第几次评审）；
 * 用户保留了写法的只列一行。界面上评审结束时会话里只追加一句结论，执行者要照发现改时从这里取。
 */
export function reviewFindingLines(db: DatabaseSync, taskId: string, definition: TaskDefinition, workspaceDir: string): string[] {
  const out: string[] = [];
  const kept: string[] = [];
  for (const [collection, names] of Object.entries(definition.completion)) {
    if (!names.includes(REVIEW_CONDITION)) continue;
    const hash = currentRulesHash(db, workspaceDir, collection);
    for (const row of currentItems(db, taskId, collection)) {
      const reviews = currentReviews(db, taskId, row.item_id, row.revision_no, hash);
      const last = reviews[reviews.length - 1];
      if (!last || last.verdict !== "不合规" || reviews.some((r) => r.verdict === "合规")) continue;
      const waiver = activeWaiver(db, taskId, row.item_id, row.revision_no);
      if (waiver) {
        kept.push(`${row.item_id}（修订 ${row.revision_no}${waiver.reason ? `，理由：${waiver.reason}` : ""}）`);
        continue;
      }
      const no = batchNumber(db, taskId, last.batch_id);
      const findings = (db.prepare("SELECT field, item_index, problem, suggestion, rule_id, level FROM review_finding WHERE review_id = ? ORDER BY ordinal").all(last.review_id) as
        { field: string; item_index: number | null; problem: string; suggestion: string | null; rule_id: string | null; level: string | null }[])
        .map((f) => ({ field: f.field, index: f.item_index, problem: f.problem, suggestion: f.suggestion, rule_id: f.rule_id, level: f.level }));
      out.push(`  ${row.item_id}（修订 ${row.revision_no}${no ? `，第 ${no} 次评审` : ""}）：`, ...findings.map((f, i) => `    ${i + 1}. ${findingText(f)}`));
    }
  }
  const lines = out.length ? ["评审不通过、还没处理的条目与发现（问题要改；建议告诉用户，由用户定）：", ...out] : ["评审不通过、还没处理的条目：没有。"];
  if (kept.length) lines.push(`评审不通过、用户保留了写法的条目（这些按用户的决定算通过，不用改；条目再改动，评审要重做）：${kept.join("、")}。`);
  return lines;
}
