/**
 * 执行者的两个只读工具的核心逻辑：「查看条目」（get_item）与「查询任务状态」（get_task_status）。
 *
 * 取数与排版用 board.ts 里与交付物看板（/tw-board）同一组函数，所以工具的输出与看板一致；完成条件用
 * conditions.ts 里与「发布版本」门禁同一组函数。库以只读方式打开，不写任何东西，也不记事件。
 * 查不到时抛异常，异常文字用中文写明原因，由 pi 交还模型。本模块不依赖 pi，单元测试可以直接调用。
 *
 * 「查询任务状态」另列每份材料的分段与引用情况（lib/segments.ts 的 materialFacts）：Word 材料逐块写标题、起止段落号与行号、
 * 有文字的段数、引用到这一块的条目个数；文本材料写被引用过几次。
 *
 * 对话理解：调用方给了会话编号时，两个工具的返回末尾另加三个派生事实（还在等回应的执行者行为、连续追问、改口，
 * 见 lib/dialogue_acts.ts 的 dialogueFacts），查看条目只算这个条目的；details.dialogue 是同一份结构化内容。
 * 任务有阶段时，「查询任务状态」的最后两行是开着的提议与这一段还开着的提问与请选择（lib/stage_proposal.ts；后一行只在给了会话编号时写）。
 */

import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { completionLines, confirmState, itemDetailLines, itemRevisions, lastEventLine, latestRevision, reviewState, type TaskRow } from "./board.ts";
import { checkCompletion, completionHints, currentItems, unreadItems, unreadList } from "./conditions.ts";
import { REVIEW_CONDITION, findingText } from "./review.ts";
import { batchNumber, currentRulesHash, verdictAt } from "./review_state.ts";
import { databasePath, load } from "./db.ts";
import { type TaskDefinition, keepPendingField, validateDefinition } from "./definition.ts";
import { mentionLines, overallState, pendingSummary, verificationLines } from "./overall_read.ts";
import { stageLines, stageSummary } from "./stage_read.ts";
import { cardsOpenInStage, openCardsLine, openProposal, proposalLine } from "./stage_proposal.ts";
import { BUSY_TIMEOUT_MS, SOURCE_USER_EDIT, ELEMENT_FIGURE, SOURCE_ITEM, elementClause, supportOf } from "./schema.ts";
import { titleOf } from "./tool_render.ts";
import { dialogueFactLines, dialogueFacts, unansweredActs } from "./dialogue_acts.ts";
import { DIAGRAM_ID, type DiagramRecord, drawnItemIds, kindName, latestVersion, liveDiagrams, readDiagrams } from "./diagram.ts";
import { type MaterialFacts, envSegmentParams, materialFacts } from "./segments.ts";
import { knowledgeDetails, knowledgeSection, listMaterials } from "./task_status.ts";
import { envKnowledgeRoot, selectedKnowledge } from "./knowledge.ts";
import { fillText } from "./texts.ts";
import { ToolRejection, notInputProblem } from "./tool_rejection.ts";

/** 工具的返回：给模型的一段文字，给读取一侧的结构化内容。 */
export interface QueryOutcome {
  text: string;
  details: Record<string, unknown>;
}

/** 查看条目的一次拒绝：一段文字（只有事实层）与它的原因码。 */
const refused = (code: string, text: string): ToolRejection => new ToolRejection(text, text, "", [code]);

function withTask<T>(workspaceDir: string, body: (db: DatabaseSync, task: TaskRow, definition: TaskDefinition) => T): T {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) {
    throw notInputProblem(new Error(fillText("get_item.no_database")));
  }
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT task_id, task_name, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
      | TaskRow
      | undefined;
    if (!task) throw notInputProblem(new Error(fillText("get_item.no_task")));
    return body(db, task, validateDefinition(JSON.parse(task.definition_text)));
  } finally {
    db.close();
  }
}

/** 任务状态里说图的那一行：有几张，各是哪一张（图名、种类、它自己现在的修订号）。 */
export function diagramsLine(diagrams: DiagramRecord[]): string {
  const each = diagrams.map((one) => {
    const now = latestVersion(one)!;
    return fillText("query.diagram_brief", { diagram: one.diagram_id, name: now.name, kind: kindName(now.kind), revision: now.revision_no });
  });
  return fillText("query.diagrams", { count: diagrams.length, list: each.join("、") });
}

/**
 * 「查看条目」看一张图时给的内容：图名、种类、说明、Mermaid 文本、来源、图里画了哪些条目，以及改它时 base_revision 写几。
 * 修订号是图自己的；wanted 给了就看它在那一次修订下的内容，那张图没有那一次修订时说明它有哪几次。
 */
function diagramOutcome(db: DatabaseSync, taskId: string, definition: TaskDefinition, id: string, wanted: number | null): QueryOutcome {
  const records = readDiagrams(db, taskId);
  const record = records.find((one) => one.diagram_id === id);
  const alive = liveDiagrams(records).map((one) => one.diagram_id);
  const aliveText = alive.length ? alive.join("、") : fillText("part.no_diagrams");
  if (!record || record.versions.length === 0) throw refused("get_item.diagram_not_found", fillText("get_item.diagram_not_found", { diagram: id, alive: aliveText }));
  if (record.deleted_in_revision !== null) {
    throw refused("get_item.diagram_deleted", fillText("get_item.diagram_deleted", { diagram: id, revision: record.deleted_in_revision, alive: aliveText }));
  }
  const current = latestVersion(record)!;
  const shown = wanted === null ? current : record.versions.find((one) => one.revision_no === wanted);
  if (!shown) {
    throw refused("get_item.diagram_revision_missing", fillText("get_item.diagram_revision_missing", {
      diagram: id, wanted: String(wanted), list: record.versions.map((one) => fillText("part.revision_no", { revision: one.revision_no })).join("、"),
    }));
  }
  const sources = (db.prepare(
    `SELECT kind, locator, excerpt, depends_revision FROM item_source WHERE task_id = ? AND item_id = ? AND revision_no = ?${elementClause(ELEMENT_FIGURE)} ORDER BY position`,
  ).all(taskId, id, shown.revision_no) as { kind: string; locator: string; excerpt: string; depends_revision: number | null }[]);
  const itemNow = db.prepare(
    "SELECT i.deleted_in_revision AS deleted, (SELECT MAX(revision_no) FROM item_version v WHERE v.task_id = i.task_id AND v.item_id = i.item_id) AS no " +
      "FROM item i WHERE i.task_id = ? AND i.item_id = ?",
  );
  const sourceLines = sources.map((one, index) => {
    const quote = one.excerpt ? fillText("query.source_quote", { excerpt: one.excerpt }) : "";
    if (one.kind !== SOURCE_ITEM) {
      return `  ${index + 1}. ${one.kind === "文档原文"
        ? fillText("query.source_line_document", { kind: one.kind, locator: one.locator, quote })
        : fillText("query.source_line", { kind: one.kind, quote })}`;
    }
    const now = itemNow.get(taskId, one.locator) as { deleted: number | null; no: number | null } | undefined;
    const state = !now || now.deleted !== null ? fillText("query.source_item_deleted", { locator: one.locator })
      : one.depends_revision !== null && now.no !== null && now.no > one.depends_revision
        ? fillText("query.source_item_changed", { locator: one.locator, then: one.depends_revision, now: now.no })
        : fillText("query.source_item_same", { locator: one.locator, then: one.depends_revision ?? "？" });
    return `  ${index + 1}. ${fillText("query.source_line_item", { locator: one.locator, quote, state })}`;
  });
  const drawn = drawnItemIds(shown.mermaid, definition.collections.map((one) => one.prefix));
  const lines = [
    shown === current
      ? fillText("query.diagram_head_latest", { diagram: id, name: shown.name, kind: kindName(shown.kind), revision: shown.revision_no })
      : fillText("query.diagram_head_old", { diagram: id, name: shown.name, kind: kindName(shown.kind), revision: shown.revision_no }),
    `  ${fillText("query.diagram_revisions", { list: record.versions.map((one) => fillText("query.diagram_revision", { revision: one.revision_no, actor: one.actor })).join("、") })}`,
    "",
    shown.note ? fillText("query.diagram_note", { note: shown.note }) : fillText("query.diagram_note_none"),
    fillText("query.diagram_mermaid_label"),
    "<<<",
    shown.mermaid,
    ">>>",
    "",
    fillText("query.sources_count", { count: sources.length }),
    ...(sourceLines.length ? sourceLines : [`  ${fillText("query.sources_none")}`]),
    drawn.length ? fillText("query.diagram_drawn", { count: drawn.length, items: drawn.join("、") }) : fillText("query.diagram_drawn_none"),
    "",
    shown === current
      ? fillText("query.diagram_edit_latest", { diagram: id, revision: current.revision_no })
      : fillText("query.diagram_edit_old", { diagram: id, revision: current.revision_no }),
  ];
  return {
    text: lines.join("\n"),
    details: {
      task_id: taskId, diagram_id: id, revision_no: shown.revision_no, current_revision: current.revision_no,
      revisions: record.versions.map((one) => one.revision_no), name: shown.name, kind: shown.kind, mermaid: shown.mermaid, note: shown.note,
      sources: sources.map((one) => ({ kind: one.kind, locator: one.locator, excerpt: one.excerpt, ...(one.depends_revision !== null ? { depends_revision: one.depends_revision } : {}) })),
      drawn,
    },
  };
}

/**
 * 「查看条目」：某个条目的全部字段、来源、评审与确认状态，以及它改动过的修订号列表。编号是图的编号时看的是那张图（diagramOutcome）。
 * 缺省看最新内容；给了 revision_no 时看条目截至那次修订的内容（修订号不大于它的最近一次改动）。
 */
export function getItem(workspaceDir: string, params: { item_id?: unknown; revision_no?: unknown }, sessionId?: string): QueryOutcome {
  const itemId = typeof params.item_id === "string" ? params.item_id.trim().toUpperCase() : "";
  if (!itemId) throw refused("get_item.item_id_missing", fillText("get_item.item_id_missing"));
  const wanted = params.revision_no;
  if (wanted !== undefined && wanted !== null && !(typeof wanted === "number" && Number.isInteger(wanted) && wanted >= 1)) {
    throw refused("get_item.revision_no_invalid", fillText("get_item.revision_no_invalid", { given: String(JSON.stringify(wanted)) }));
  }
  return withTask(workspaceDir, (db, task, definition) => {
    const item = db
      .prepare("SELECT collection, deleted_in_revision FROM item WHERE task_id = ? AND item_id = ?")
      .get(task.task_id, itemId) as { collection: string; deleted_in_revision: number | null } | undefined;
    // 编号是图的编号（D-001 这样）而任务里没有同名的条目：看的是一张图。
    if (!item && DIAGRAM_ID.test(itemId)) return diagramOutcome(db, task.task_id, definition, itemId, typeof wanted === "number" ? wanted : null);
    if (!item) {
      const alive = (db.prepare("SELECT item_id FROM item WHERE task_id = ? AND deleted_in_revision IS NULL ORDER BY rowid").all(task.task_id) as {
        item_id: string;
      }[]).map((row) => row.item_id);
      throw refused("get_item.item_not_found", fillText("get_item.item_not_found", { item: itemId, alive: alive.length ? alive.join("、") : fillText("part.no_items") }));
    }
    if (item.deleted_in_revision !== null) {
      throw refused("get_item.item_deleted", fillText("get_item.item_deleted", { item: itemId, revision: item.deleted_in_revision }));
    }
    const revisions = itemRevisions(db, task.task_id, itemId);
    const current = revisions[revisions.length - 1];
    const newest = latestRevision(db, task.task_id);
    if (typeof wanted === "number" && wanted > newest) {
      throw refused("get_item.revision_beyond_latest", fillText("get_item.revision_beyond_latest", { wanted, newest }));
    }
    const shown = typeof wanted === "number" ? [...revisions].reverse().find((n) => n <= wanted) : current;
    if (shown === undefined) {
      throw refused("get_item.item_absent_at_revision", fillText("get_item.item_absent_at_revision", {
        wanted: String(wanted), item: itemId, list: revisions.map((n) => fillText("part.revision_no", { revision: n })).join("、"),
      }));
    }
    const row = db
      .prepare("SELECT fields FROM item_version WHERE task_id = ? AND item_id = ? AND revision_no = ?")
      .get(task.task_id, itemId, shown) as { fields: string };
    const fields = load(row.fields) as Record<string, unknown>;
    const sources = (db
      .prepare(
        "SELECT position, kind, locator, excerpt, field, field_index, normalized_value, inserted " +
          `FROM item_source WHERE task_id = ? AND item_id = ? AND revision_no = ? AND kind <> ?${elementClause()} ORDER BY position, support_no`,
      )
      .all(task.task_id, itemId, shown, SOURCE_USER_EDIT) as { position: number; kind: string; locator: string; excerpt: string; field: string | null; field_index: number | null; normalized_value: string | null; inserted: string | null }[])
      .reduce<{ kind: string; locator: string; excerpt: string; supports: ReturnType<typeof supportOf>[]; normalized_value?: string }[]>((list, one) => {
        let source = list[one.position - 1];
        if (!source) {
          list[one.position - 1] = source = { kind: one.kind, locator: one.locator, excerpt: one.excerpt, supports: [] };
          if (one.normalized_value !== null) source.normalized_value = one.normalized_value;
        }
        if (one.field !== null) source.supports.push(supportOf(one.field, one.field_index, one.inserted));
        return list;
      }, [])
      // 早期版本写下的「用户直接修改」不读出，它的位置号留下的空位去掉。
      .filter(Boolean);
    const lines = itemDetailLines(db, task, definition, itemId, typeof wanted === "number" ? wanted : undefined, workspaceDir);
    // 待核实与（业务说明的页）被提到的地方：都按条目现在的内容算，看旧内容时不写。
    const overall = shown === current ? overallState(db, task.task_id, definition) : null;
    const verification = overall?.verification.get(itemId) ?? null;
    const mentioned = overall?.mentions.get(itemId) ?? [];
    if (verification) lines.push(...verificationLines(itemId, verification));
    lines.push(...mentionLines(itemId, mentioned));
    lines.push(
      "",
      shown === current
        ? fillText("query.item_edit_latest", { item: itemId, revision: current })
        : fillText("query.item_edit_old", { item: itemId, revision: current }),
      fillText("query.item_raw_fields", { json: JSON.stringify(fields) }),
    );
    const dialogue = sessionId ? dialogueFacts(db, task.task_id, sessionId, itemId) : null;
    const factLines = dialogue ? dialogueFactLines(dialogue) : [];
    if (factLines.length > 0) lines.push("", ...factLines);
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
        review: reviewState(db, task.task_id, itemId, shown, workspaceDir),
        confirm: confirmState(db, task.task_id, itemId, shown),
        dialogue,
        ...(verification ? { pending_verification: verification.pending_verification, pending_sources: verification.pending_sources,
          pending_places: verification.pending_places, basis_pending: verification.basis_pending } : {}),
        ...(mentioned.length ? { mentioned_by: mentioned } : {}),
      },
    };
  });
}

/** 「查询任务状态」：各集合的条目、完成条件逐项、未解决的问题条目、未读清单、最近一次修订与事件序号。 */
export function getTaskStatus(workspaceDir: string, sessionId?: string, knowledgeRoot: string | null = envKnowledgeRoot()): QueryOutcome {
  return withTask(workspaceDir, (db, task, definition) => {
    const name = task.task_name ?? definition.taskName;
    const lines = [fillText("query.task_line", { id: task.task_id, name, type: definition.taskName }), ""];
    const counts: Record<string, string[]> = {};
    const unresolved: { item_id: string; revision_no: number; title: string }[] = [];
    for (const collection of definition.collections) {
      const rows = currentItems(db, task.task_id, collection.name);
      counts[collection.name] = rows.map((row) => row.item_id);
      lines.push(rows.length
        ? fillText("query.collection_items", {
          collection: collection.name, count: rows.length,
          items: rows.map((row) => fillText("query.item_at_revision", { item: row.item_id, revision: row.revision_no })).join("、"),
        })
        : fillText("query.collection_empty", { collection: collection.name, count: rows.length }));
      const status = collection.fields.find((field) => field.name === "状态");
      if (!status || !(status.values ?? []).includes("未解决")) continue;
      for (const row of rows) {
        const fields = load(row.fields) as Record<string, unknown>;
        if (fields["状态"] === "未解决") unresolved.push({ item_id: row.item_id, revision_no: row.revision_no, title: titleOf(fields, collection.fields[0]?.name) });
      }
    }
    // 任务里的图（不是条目，不评审，不算进完成条件）：有几张、各是什么；一张都没有时不写这一行。
    const diagrams = liveDiagrams(readDiagrams(db, task.task_id));
    if (diagrams.length) lines.push(diagramsLine(diagrams));
    lines.push("", ...completionLines(db, task, definition, workspaceDir), "");
    lines.push(...reviewFindingLines(db, task.task_id, definition, workspaceDir), "");
    lines.push(
      unresolved.length === 0
        ? fillText("query.unresolved_none")
        : fillText("query.unresolved", {
          count: unresolved.length,
          list: unresolved.map((one) => `  ${fillText("query.unresolved_item", { item: one.item_id, revision: one.revision_no, title: one.title })}`).join("\n"),
        }),
    );
    const unread = unreadItems(db, task.task_id, definition.completion,
      (name) => definition.collections.find((c) => c.name === name)?.fields[0]?.name);
    lines.push(
      unread.length === 0
        ? fillText("query.unread_none")
        : fillText("query.unread", { count: unread.length, list: unreadList(unread) }),
    );
    // 待核实的条目：有助手补充而用户还没有确认的，或者依据的主题待核实、已废弃的；问题条目不列。一个都没有时不写。
    const questions = new Set(definition.collections.filter((one) => keepPendingField(one) !== null).map((one) => one.name));
    const pending = pendingSummary(overallState(db, task.task_id, definition), questions);
    if (pending) lines.push(pending);
    // 完成条件之外的提示，不挡发布版本，例如还没有贴标签的主题。
    const hints = completionHints(db, task.task_id, definition.completion);
    for (const hint of hints) lines.push(fillText("query.hint", { summary: hint.summary }));
    // 材料的分段与引用情况写在修订与事件序号之前，末行仍与看板相同。
    const materials = materialFacts(db, task.task_id, workspaceDir,
      listMaterials(workspaceDir, definition.materialsDir).files.map((f) => f.path), envSegmentParams());
    if (materials.length) lines.push(...materialLines(materials));
    // 任务选用的知识库与文档：与任务现状消息里的那一段相同；选用的知识库里没有文档时不写。
    const libraries = selectedKnowledge(workspaceDir, knowledgeRoot);
    const knowledge = knowledgeSection(libraries);
    if (knowledge) lines.push(knowledge);
    const revision = db.prepare("SELECT revision_no, event_seq FROM revision WHERE task_id = ? ORDER BY revision_no DESC LIMIT 1").get(task.task_id) as
      | { revision_no: number; event_seq: number }
      | undefined;
    lines.push(
      revision ? fillText("query.last_revision", { revision: revision.revision_no, seq: revision.event_seq }) : fillText("query.no_revision"),
      lastEventLine(db),
    );
    const last = db.prepare("SELECT MAX(seq) AS seq FROM event").get() as { seq: number | null };
    const dialogue = sessionId ? dialogueFacts(db, task.task_id, sessionId) : null;
    const factLines = dialogue ? dialogueFactLines(dialogue) : [];
    if (factLines.length > 0) lines.push("", ...factLines);
    // 工作的阶段（任务定义里有业务说明集合时才有）：现在在哪个阶段、这一段还差什么，写在最后。
    const stage = stageSummary(db, workspaceDir, task.task_id, definition, sessionId ?? null);
    // 开着的提议接在后面一行：用户要求进入、退回或者说看过了时，助手据此知道该请他点「待决定」一行，而不是重发卡片。
    if (stage) lines.push("", ...stageLines(stage), proposalLine(openProposal(db, task.task_id, sessionId ?? null), sessionId ?? null));
    // 再后面一行是这一段还开着的提问与请选择（这条会话里的）：助手提议进入下一段之前据此一次一张重发。
    if (stage && sessionId) lines.push(openCardsLine(cardsOpenInStage(db, task.task_id, unansweredActs(db, task.task_id, sessionId), sessionId)));
    return {
      text: lines.join("\n"),
      details: {
        task_id: task.task_id,
        status: task.status,
        ...(stage ? { stage } : {}),
        items: counts,
        diagrams: diagrams.map((one) => ({ diagram_id: one.diagram_id, revision_no: latestVersion(one)!.revision_no })),
        conditions: checkCompletion(db, task.task_id, definition.completion, { workspaceDir }),
        unresolved,
        unread: unread.map((one) => ({ item_id: one.item_id, title: one.title, revision_no: one.revision_no })),
        hints,
        last_revision_no: revision?.revision_no ?? null,
        last_event_seq: last.seq,
        materials,
        ...(knowledge ? { knowledge: knowledgeDetails(libraries) } : {}),
        dialogue,
      },
    };
  });
}

/** 材料的分段与引用情况，给「查询任务状态」的文字用。 */
export function materialLines(materials: MaterialFacts[]): string[] {
  const lines = [fillText("query.materials_lead")];
  for (const f of materials) {
    if (f.kind === "text") {
      lines.push(`  ${fillText("query.material_text", { path: f.path, count: f.cited })}`);
      continue;
    }
    if (f.kind === "pdf") {
      lines.push(`  ${fillText("query.material_pdf", {
        path: f.path, projection: f.projection, pages: f.pages, units: f.units,
        no_text: f.no_text_pages.length ? fillText("query.material_pdf_no_text", { pages: f.no_text_pages.join("、") }) : "",
        cited: f.uncited === 0 ? fillText("query.material_pdf_all") : fillText("query.material_pdf_some", { count: f.uncited }),
      })}`);
      for (const b of f.blocks) {
        lines.push(`    ${fillText("query.material_pdf_block", {
          index: b.index, first_page: b.first_page, last_page: b.last_page, first_line: b.first_line, last_line: b.last_line,
          heading: b.heading ? `「${b.heading}」` : "", units: b.units, items: b.items,
          uncited: b.uncited ? fillText("query.material_pdf_block_uncited", { count: b.uncited }) : "",
        })}`);
      }
      continue;
    }
    lines.push(`  ${fillText("query.material_word", {
      path: f.path, projection: f.projection, text_paragraphs: f.text_paragraphs, blocks: f.blocks.length,
      cited: f.uncited === 0 ? fillText("query.material_word_all") : fillText("query.material_word_some", { count: f.uncited }),
    })}`);
    for (const b of f.blocks) {
      lines.push(`    ${fillText("query.material_word_block", {
        index: b.index, first: b.first_paragraph, last: b.last_paragraph, first_line: b.first_line, last_line: b.last_line,
        heading: b.heading ? `「${b.heading}」` : fillText("query.material_word_before_heading"), paragraphs: b.paragraphs, items: b.items,
        uncited: b.uncited ? fillText("query.material_word_block_uncited", { count: b.uncited }) : "",
      })}`);
    }
  }
  return lines;
}

/**
 * 评审发现：要评审的集合里，条目当前所在的修订上的评审结论（lib/review_verdict.ts）是不通过的，逐条列出依据的那条记录的发现
 * （带规则编号，写明是第几次评审）；结论是已保留的只列一行。界面上评审结束时会话里只追加一句结论，执行者要照发现改时从这里取。
 */
export function reviewFindingLines(db: DatabaseSync, taskId: string, definition: TaskDefinition, workspaceDir: string): string[] {
  const out: string[] = [];
  const kept: string[] = [];
  for (const [collection, names] of Object.entries(definition.completion)) {
    if (!names.includes(REVIEW_CONDITION)) continue;
    const hash = currentRulesHash(db, workspaceDir, collection);
    for (const row of currentItems(db, taskId, collection)) {
      const { state, basis: last, waiver } = verdictAt(db, taskId, row.item_id, row.revision_no, hash);
      if (state === "waived") {
        kept.push(waiver!.reason
          ? fillText("query.kept_item_reason", { item: row.item_id, revision: row.revision_no, reason: waiver!.reason })
          : fillText("query.kept_item", { item: row.item_id, revision: row.revision_no }));
        continue;
      }
      if (state !== "failed" || !last) continue;
      const no = batchNumber(db, taskId, last.batch_id);
      const findings = (db.prepare("SELECT field, item_index, problem, suggestion, rule_id, level FROM review_finding WHERE review_id = ? ORDER BY ordinal").all(last.review_id) as
        { field: string; item_index: number | null; problem: string; suggestion: string | null; rule_id: string | null; level: string | null }[])
        .map((f) => ({ field: f.field, index: f.item_index, problem: f.problem, suggestion: f.suggestion, rule_id: f.rule_id, level: f.level }));
      out.push(`  ${no
        ? fillText("query.failed_item_batch", { item: row.item_id, revision: row.revision_no, no })
        : fillText("query.failed_item", { item: row.item_id, revision: row.revision_no })}`, ...findings.map((f, i) => `    ${i + 1}. ${findingText(f)}`));
    }
  }
  const lines = out.length ? [fillText("query.findings_lead"), ...out] : [fillText("query.findings_none")];
  if (kept.length) lines.push(fillText("query.kept", { items: kept.join("、") }));
  return lines;
}
