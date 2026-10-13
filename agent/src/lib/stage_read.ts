/**
 * 工作的阶段里读写任务库的那一半（不读库的在 lib/stage.ts）：任务现在在哪个阶段、记一次移动。
 *
 * 承载是活动记录表：任务里开展过的每一项活动一行，现在的六个阶段就是六项活动，都在首次分析这条流程里。
 * 任务现在在哪个阶段看还没有结束的那条活动记录；一行都没有时按任务有没有材料定，这个缺省不落库，每次现算：
 * 任务建好还没有上传材料时是澄清，随后上传了材料而还没有任何移动，就是核读材料；有了第一条记录之后只看记录。
 * 移动阶段就是结束现在这项活动、开始另一项：前一条记录填上结束的时刻，再插一条新的。
 * 早先建的任务（任务定义里没有「总体分析」集合）没有阶段：stageOf 返回 null，调用方据此什么都不做。
 *
 * 记移动的函数只管写，这次移动行不行由调用方先用 lib/stage.ts 的 judgeMove 判过。
 */

import type { DatabaseSync } from "node:sqlite";
import { type Entry, chooseActOf } from "./completion_consent.ts";
import { checkCompletion } from "./conditions.ts";
import { emit, wallClockText } from "./db.ts";
import { type TaskDefinition, keepPendingField, validateDefinition } from "./definition.ts";
import { diagramViewed, latestVersion, liveDiagrams, readDiagrams, viewedDiagramRevisions } from "./diagram.ts";
import { classLinked, drawnItemIds, hasBranch } from "./diagram_scan.ts";
import { OVERALL_COLLECTION, OVERALL_FIELDS, hasOverall } from "./overall_analysis.ts";
import { overallState } from "./overall_read.ts";
import { rulesTable } from "./overall_views.ts";
import { currentRulesHash, verdictAt } from "./review_state.ts";
import { ELEMENT_FIGURE, NoDatabaseYet, SOURCE_DOCUMENT, SOURCE_FIGURE, SOURCE_ITEM, TASK_ACTIVE, elementClause, withTaskDatabase } from "./schema.ts";
import { openProposal } from "./stage_proposal.ts";
import {
  BACK_OPTIONS, ENTER_OPTIONS, FLOW_INITIAL, STAGES, KIND_CLASS, KIND_FLOWCHART, type Lamp, type LampDiagram, type LampInput, QUESTION_OPEN_STATUS, STAGE_NAMES, type Stage, type StageActor,
  defaultStage, isStage, judgeMove, lampLines, QUESTION_BLOCKING_FIELD, hasPendingMark, lampPage, lampQuestion, nextStage, stageBackedBy, stageEnteredBy, stageLamps,
} from "./stage.ts";
import { listMaterials } from "./task_status.ts";

/** 记下一次移动的事件名。 */
export const EVENT_STAGE_MOVED = "STAGE_MOVED";

const TABLE = "activity_record";

/** 活动记录表里的一行。 */
export interface ActivityRecord {
  record_id: number;
  /** 哪一项活动：现在就是六个阶段之一。 */
  activity: Stage;
  /** 所属节点：在流程里开展时与活动同一个写法；单独开展时为 null（现在没有这种记录）。 */
  node: string | null;
  /** 所属流程（lib/stage.ts 的 FLOW_INITIAL 等）；单独开展时为 null（现在没有这种记录）。 */
  flow: string | null;
  /**
   * 开始这项活动之前任务在哪个阶段：取自记下开始的那条事件的内容；事件里没有写、或者那条事件已经不在时，取前一条记录的活动；
   * 两样都没有是 null。
   */
  from: Stage | null;
  actor: StageActor;
  reason: string;
  run_id: string | null;
  session_id: string;
  call_id: string;
  started_at: string;
  /** 结束的时刻；还在进行为 null。 */
  ended_at: string | null;
  started_seq: number;
  ended_seq: number | null;
}

/** 读活动记录的列：表里的各列，加上从记下开始的那条事件的内容里取的「从哪个阶段来」（取不到时是前一条记录的活动）。 */
const RECORD_COLUMNS = "r.record_id, r.activity, r.node, r.flow, r.actor, r.reason, r.run_id, r.session_id, r.call_id, r.started_at, r.ended_at, r.started_seq, r.ended_seq, " +
  "COALESCE(CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.from') END, " +
  `(SELECT p.activity FROM ${TABLE} p WHERE p.task_id = r.task_id AND p.started_seq < r.started_seq ORDER BY p.started_seq DESC LIMIT 1)) AS "from"`;
const RECORD_FROM = `${TABLE} r LEFT JOIN event e ON e.seq = r.started_seq`;

type RecordRow = Omit<ActivityRecord, "from"> & { from: unknown };
const recordOf = (row: RecordRow): ActivityRecord => ({
  ...row, record_id: Number(row.record_id), started_seq: Number(row.started_seq), ended_seq: row.ended_seq === null ? null : Number(row.ended_seq),
  from: isStage(row.from) ? row.from : null,
});

/** 库里有没有活动记录表：只读的一侧会遇到还没有升级过的库。 */
export function hasActivityTable(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE) !== undefined;
}

/** 全部活动记录，按开始的先后排。 */
export function activityRecords(db: DatabaseSync, taskId: string): ActivityRecord[] {
  if (!hasActivityTable(db)) return [];
  const rows = db.prepare(`SELECT ${RECORD_COLUMNS} FROM ${RECORD_FROM} WHERE r.task_id = ? ORDER BY r.started_seq`).all(taskId) as unknown as RecordRow[];
  return rows.map(recordOf);
}

/**
 * 任务现在在进行的那项活动的记录：还没有结束的记录里开始得最晚的一条。一条都没有（或者库还没有这张表）时是 null。
 * 活动的写法不是六个阶段之一的记录不认。
 */
export function openActivityRecord(db: DatabaseSync, taskId: string): ActivityRecord | null {
  if (!hasActivityTable(db)) return null;
  const row = db.prepare(`SELECT ${RECORD_COLUMNS} FROM ${RECORD_FROM} WHERE r.task_id = ? AND r.ended_at IS NULL ORDER BY r.started_seq DESC LIMIT 1`).get(taskId) as RecordRow | undefined;
  return row && isStage(row.activity) ? recordOf(row) : null;
}

/** 任务目录里有没有材料：材料目录第一层至少有一个文件（与任务现状消息列材料用的是同一个清单）。 */
export function taskHasMaterials(workspaceDir: string, materialsDir: string): boolean {
  return listMaterials(workspaceDir, materialsDir).files.length > 0;
}

/** 任务现在在哪个阶段：有还没有结束的活动记录就看它，没有按有没有材料定。不管任务有没有阶段，调用方先用 hasOverall 判。 */
export function currentStage(db: DatabaseSync, taskId: string, hasMaterials: boolean): Stage {
  return openActivityRecord(db, taskId)?.activity ?? defaultStage(hasMaterials);
}

/** 任务现在在哪个阶段；早先建的任务（没有「总体分析」集合）没有阶段，返回 null。 */
export function stageOf(db: DatabaseSync, workspaceDir: string, taskId: string, definition: Pick<TaskDefinition, "collections" | "materialsDir">): Stage | null {
  if (!hasOverall(definition.collections)) return null;
  return currentStage(db, taskId, taskHasMaterials(workspaceDir, definition.materialsDir));
}

/** 一次移动要记下的几样。 */
export interface StageMove {
  taskId: string;
  sessionId: string;
  /** 助手移动时的运行号；用户移动时为 null。 */
  runId: string | null;
  callId: string;
  actor: StageActor;
  from: Stage;
  to: Stage;
  reason: string;
}

/**
 * 记一次移动：先记一条事件 STAGE_MOVED，把还在进行的那条活动记录结束（填上这一刻与这条事件的序号），再插一条新的活动记录，
 * 返回事件序号。新记录的节点与活动同一个写法，所属流程现在恒为首次分析；事件的内容里也写所属流程。
 * 必须在调用方已经开好的写事务里调用（withTaskDatabase），好让事件、两处记录与同一次调用里别的写入一起提交。
 */
export function recordStageMove(db: DatabaseSync, move: StageMove): number {
  // 库不检查活动的取值（lib/schema.ts），所以写之前在这里判：不是阶段表里的写法就不记。
  if (!isStage(move.to) || !isStage(move.from)) throw new Error(`阶段记录里的阶段写法不对：从「${String(move.from)}」到「${String(move.to)}」。`);
  const seq = emit(db, {
    taskId: move.taskId, sessionId: move.sessionId, callId: move.callId, name: EVENT_STAGE_MOVED, actor: move.actor,
    payload: { stage: move.to, from: move.from, actor: move.actor, reason: move.reason, run_id: move.runId, flow: FLOW_INITIAL },
  });
  const at = wallClockText();
  db.prepare(`UPDATE ${TABLE} SET ended_at = ?, ended_seq = ? WHERE task_id = ? AND ended_at IS NULL`).run(at, seq, move.taskId);
  db.prepare(
    `INSERT INTO ${TABLE} (task_id, session_id, run_id, call_id, actor, activity, node, flow, reason, started_at, started_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(move.taskId, move.sessionId, move.runId, move.callId, move.actor, move.to, move.to, FLOW_INITIAL, move.reason, at, seq);
  return seq;
}

/**
 * 一次移动的结果。moved 为真是记下了；为假时 why 写原因：same 原地不动，user_only 往前移动要由用户在卡片上点，
 * no_stages 这个任务没有阶段（早先建的任务）。from 是移动之前所在的阶段，任务没有阶段时为 null。
 */
export interface StageMoveOutcome {
  requested: Stage;
  from: Stage | null;
  moved: boolean;
  /** 没有移成的原因；not_next 只出现在卡片点击上：点的那个阶段不是紧挨着的下一段。 */
  why: "same" | "user_only" | "no_stages" | "not_next" | "not_back" | null;
  event_seq: number | null;
}

/**
 * 想把任务移到某个阶段：先看任务有没有阶段、这次移动行不行（lib/stage.ts 的 judgeMove），行就记下。不行不抛错，原因写在结果里，
 * 由调用方决定怎样告诉助手或用户。必须在调用方已经开好的写事务里调用。
 */
export function moveStage(db: DatabaseSync, workspaceDir: string, who: Omit<StageMove, "from" | "to" | "reason">, to: Stage, reason: string): StageMoveOutcome {
  const task = db.prepare("SELECT definition_text FROM task WHERE task_id = ?").get(who.taskId) as { definition_text: string } | undefined;
  const from = task ? stageOf(db, workspaceDir, who.taskId, validateDefinition(JSON.parse(task.definition_text))) : null;
  if (from === null) return { requested: to, from: null, moved: false, why: "no_stages", event_seq: null };
  const verdict = judgeMove(from, to, who.actor);
  if (!verdict.ok) return { requested: to, from, moved: false, why: verdict.why, event_seq: null };
  return { requested: to, from, moved: true, why: null, event_seq: recordStageMove(db, { ...who, from, to, reason }) };
}

/** 用户在卡片上点了「进入某个阶段」时，那条阶段记录里写的理由。 */
export function enterReason(to: Exclude<Stage, "reading">): string {
  return `用户在卡片上选了「${ENTER_OPTIONS[to].text}」`;
}
/**
 * 用户在卡片上点了「退回某个阶段」时，那条阶段记录里写的理由：点的是哪一项，后面接卡片的问句（助手在那里写为什么要退回）。
 * 问句是空的时只写点的是哪一项。
 */
export function backReason(to: Exclude<Stage, "document">, question: string): string {
  const said = question.trim();
  return `用户在卡片上选了「${BACK_OPTIONS[to].text}」${said ? `：${said}` : ""}`;
}
/** 点的是「开始写条目」时的理由。 */
export const START_ITEMS_REASON = enterReason("writing");

/**
 * 用户点了一张卡片上的选项：点的是助手提议往前走的那张请选择卡片上「进入」某个阶段的选项时，替用户记一次移动。
 * 四个键各进入一个阶段（lib/stage.ts 的 ENTER_OPTIONS）：进入澄清、进入整理建模、开始写条目、进入评审确认。
 * 先在会话当前分支上找到点的那条回复，确认它确实是助手发的请选择、选项里有这个键。这条分支上找不到那条回复时（卡片是在另一条会话里发的，
 * 用户从输入框上方的「待决定」一行或者任务状况卡上点了进入），改为核对任务库里开着的提议（lib/stage_proposal.ts）：点的键是它的进入键、
 * 给了回复编号时又正是它那一条，才算。两样都认不出就不记（返回 null），点击照常往下走。
 * 次序不对的点击也不记（结果里 moved 为假、why 为 not_next、from 是任务现在的阶段）：进入澄清、进入整理建模、进入评审确认只在任务正处在紧挨着的前一段时才算；
 * 开始写条目在写条目之前的哪一段点都算（用户可以跳过中间的阶段），任务已经过了写条目时点它是退回写条目。
 * 任务没有阶段、任务不在进行中、任务本来就在那个阶段时也不记，结果里写明原因。自己开事务，在卡片点击的处理函数里、
 * 发那句固定的话之前调用，这样助手回应这次点击的那一次运行从头就在新的阶段。
 */
export function recordStageCardClick(workspaceDir: string, sessionId: string, branch: readonly Entry[],
  click: { opId: string; replyEntry: unknown; optionKey: unknown }): StageMoveOutcome | null {
  const to = stageEnteredBy(click.optionKey);
  const back = to === null ? stageBackedBy(click.optionKey) : null;
  if (to === null && back === null) return null;
  // 回复编号没有给、或者给的是空文字（开着的提议没有记下它在哪条回复上时，页面只能这样发）：都当作没有给。
  const replyEntry = typeof click.replyEntry === "string" && click.replyEntry !== "" ? click.replyEntry : null;
  const card = replyEntry !== null ? branch.find((entry) => entry.id === replyEntry) : undefined;
  // 那条回复在这条分支上：照它自己判，是别的东西（用户的话、别的卡片、卡片上没有这个键）就不认，不再去看开着的提议。
  const act = card ? chooseActOf(card) : null;
  if (card && (!act || !act.options.some((option: { key?: unknown } | null) => option?.key === click.optionKey))) return null;
  try {
    return withTaskDatabase(workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id, status, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
        { task_id: string; status: string; definition_text: string } | undefined;
      if (!task || task.status !== TASK_ACTIVE) return null;
      let cardQuestion = typeof act?.text === "string" ? act.text : "";
      if (!card) {
        const open = openProposal(db, task.task_id);
        if (open === null || open.kind === "review" || open.enter.key !== click.optionKey) return null;
        if (replyEntry !== null && replyEntry !== open.reply_entry) return null;
        cardQuestion = open.text;
      }
      const from = stageOf(db, workspaceDir, task.task_id, validateDefinition(JSON.parse(task.definition_text)));
      const who = { taskId: task.task_id, sessionId, runId: null, callId: click.opId, actor: "user" as const };
      if (back !== null) {
        // 退回：目标要在现在这个阶段之前；卡片的问句（助手写的原因）记进理由。
        if (from !== null && STAGES.indexOf(back) >= STAGES.indexOf(from)) return { requested: back, from, moved: false, why: "not_back" as const, event_seq: null };
        return moveStage(db, workspaceDir, who, back, backReason(back, cardQuestion));
      }
      if (to !== "writing" && from !== null && nextStage(from) !== to) return { requested: to!, from, moved: false, why: "not_next" as const, event_seq: null };
      return moveStage(db, workspaceDir, who, to!, enterReason(to!));
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) return null;
    throw error;
  }
}

// ───────────── 现在在哪个阶段、每个阶段还差什么 ─────────────

/** 完成条件里要求评审的那一条的名字（与 lib/review.ts 的 REVIEW_CONDITION 同一个；这里不从它导入，免得两个文件互相导入）。 */
const REVIEWED_CONDITION = "每个条目评审通过";

/**
 * 材料清单里不是由别的文件生成的那几个。由 Word 或 PDF 材料生成的文字版（x.docx.md、早先的 x.docx.txt、x.pdf.md）与分段清单
 * （x.docx.segments.json、x.pdf.segments.json）旁边有那份原件时是生成出来的，不算一份材料。paths 是 listMaterials 列出的路径。
 */
export function sourceMaterials(paths: readonly string[]): string[] {
  const present = new Set(paths);
  const derived = (path: string): boolean => [".segments.json", ".md", ".txt"].some((suffix) => {
    if (!path.toLowerCase().endsWith(suffix)) return false;
    const stem = path.slice(0, -suffix.length);
    return /\.(docx|pdf)$/i.test(stem) && present.has(stem);
  });
  return paths.filter((one) => !derived(one));
}

/** 任务现在的阶段、最近一次是谁在什么时候为什么移的（一次都没有移过时三项为 null），以及六个阶段各自的几盏灯。 */
export interface StageSummary {
  current: Stage;
  moved_by: StageActor | null;
  /** 最近一次移动的时刻（库里的本地时间写法）。 */
  moved_at: string | null;
  reason: string | null;
  lamps: Record<Stage, Lamp[]>;
}

/** 任务里还在的图各自算灯要的几样（lib/stage.ts 的 LampDiagram）。只读。 */
export function lampDiagrams(db: DatabaseSync, taskId: string, definition: TaskDefinition): LampDiagram[] {
  const records = liveDiagrams(readDiagrams(db, taskId));
  const seen = viewedDiagramRevisions(db, taskId);
  if (records.length === 0) return [];
  const prefixes = definition.collections.map((one) => one.prefix);
  const cited = db.prepare(
    `SELECT locator FROM item_source WHERE task_id = ? AND item_id = ? AND revision_no = ? AND kind = ?${elementClause(db, ELEMENT_FIGURE)} ORDER BY position`,
  );
  return records.map((record) => {
    const now = latestVersion(record)!;
    return {
      diagram_id: record.diagram_id, kind: now.kind,
      sources: [...new Set((cited.all(taskId, record.diagram_id, now.revision_no, SOURCE_ITEM) as { locator: string }[]).map((row) => row.locator.trim()))],
      drawn: drawnItemIds(now.mermaid, prefixes),
      linked: now.kind === KIND_CLASS ? classLinked(now.mermaid, prefixes) : [],
      branches: now.kind === KIND_FLOWCHART && hasBranch(now.mermaid),
      viewed: diagramViewed(record, seen),
      marked: hasPendingMark(now.mermaid),
    };
  });
}

/**
 * 算灯要的事实里只从任务库就读得出的那一部分：页、条目、问题、集合名、被引用的文档、图、规则冲突。只读。
 * 另外三样要看任务目录（材料清单、评审规则文件、完成条件的核对），由 lampInput 补上；模拟器的评测只有库的副本，只用这一部分
 * （cli/overall_state.mts）。
 */
export function lampFacts(db: DatabaseSync, taskId: string, definition: TaskDefinition): Omit<LampInput, "materials" | "review" | "completion"> {
  const state = overallState(db, taskId, definition);
  const statusFieldOf = new Map(definition.collections.flatMap((one) => {
    const field = keepPendingField(one);
    return field ? [[one.name, field.name] as [string, string]] : [];
  }));
  // 问题条目里说事情的那句话：它所在集合的第一个字段（需求规格这一类任务里是「事项」）。
  const subjectFieldOf = new Map(definition.collections.map((one) => [one.name, one.fields[0]?.name ?? ""]));
  const sourcesOf = (itemId: string) => state.sources.get(itemId) ?? [];
  const pages = state.items.filter((one) => one.collection === OVERALL_COLLECTION);
  const others = state.items.filter((one) => one.collection !== OVERALL_COLLECTION);
  const questions = others.filter((one) => statusFieldOf.has(one.collection));
  const diagrams = lampDiagrams(db, taskId, definition);
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const rules = rulesTable(
    pages.map((one) => ({ item_id: one.item_id, fields: one.fields, sources: sourcesOf(one.item_id), created_at: null })),
    questions.map((one) => ({
      item_id: one.item_id, subject: text(one.fields[subjectFieldOf.get(one.collection)!]), open: one.fields[statusFieldOf.get(one.collection)!] === QUESTION_OPEN_STATUS,
      kind: null, suggestion: "", sources: sourcesOf(one.item_id), created_at: null,
    })),
  );
  return {
    pages: pages.map((one) => lampPage(one.item_id, one.fields, state.viewed.get(one.item_id) === true, state.verification.get(one.item_id)?.pending_verification === true)),
    items: others.map((one) => {
      const verification = state.verification.get(one.item_id)!;
      return {
        item_id: one.item_id, collection: one.collection,
        cites: sourcesOf(one.item_id).filter((s) => s.kind === SOURCE_ITEM).map((s) => s.locator),
        citesDiagrams: [...new Set(sourcesOf(one.item_id).filter((s) => s.kind === SOURCE_FIGURE).map((s) => s.locator))],
        pending: verification.pending_verification || verification.basis_pending !== null,
        // 问题条目自己不算标着待定的地方：它就是用来记没定的事的。
        marked: !statusFieldOf.has(one.collection) && hasPendingMark(one.fields),
      };
    }),
    questions: questions.map((one) => lampQuestion(one.item_id, one.fields, statusFieldOf.get(one.collection)!)),
    collections: definition.collections.map((one) => one.name),
    citedDocuments: [...pages, ...questions].flatMap((one) => sourcesOf(one.item_id).filter((s) => s.kind === SOURCE_DOCUMENT).map((s) => s.locator)),
    diagrams,
    ruleConflicts: rules.conflicts,
    declared: {
      intro: definition.collections.some((one) => one.name === OVERALL_COLLECTION && one.fields.some((field) => field.name === OVERALL_FIELDS.intro)),
      blocking: definition.collections.some((one) => keepPendingField(one) !== null && one.fields.some((field) => field.name === QUESTION_BLOCKING_FIELD)),
    },
  };
}

/** 从任务库与任务目录里读出算灯要的全部事实（lib/stage.ts 的 LampInput）。只读。 */
export function lampInput(db: DatabaseSync, workspaceDir: string, taskId: string, definition: TaskDefinition): LampInput {
  const facts = lampFacts(db, taskId, definition);
  const reviewed = new Set(Object.entries(definition.completion).filter(([, names]) => names.includes(REVIEWED_CONDITION)).map(([name]) => name));
  const revisionOf = new Map((db.prepare(
    "SELECT i.item_id, (SELECT MAX(revision_no) FROM item_version w WHERE w.task_id = i.task_id AND w.item_id = i.item_id) AS no FROM item i WHERE i.task_id = ? AND i.deleted_in_revision IS NULL",
  ).all(taskId) as { item_id: string; no: number }[]).map((row) => [row.item_id, Number(row.no)]));
  const hashOf = new Map<string, string | null>();
  const failing = facts.items.filter((one) => {
    if (!reviewed.has(one.collection)) return false;
    if (!hashOf.has(one.collection)) hashOf.set(one.collection, currentRulesHash(db, workspaceDir, one.collection));
    return verdictAt(db, taskId, one.item_id, revisionOf.get(one.item_id)!, hashOf.get(one.collection)!).state === "failed";
  }).map((one) => one.item_id);
  const completion = checkCompletion(db, taskId, definition.completion, { workspaceDir });
  return {
    ...facts,
    materials: sourceMaterials(listMaterials(workspaceDir, definition.materialsDir).files.map((one) => one.path)),
    review: { failing, any: db.prepare("SELECT 1 FROM review WHERE task_id = ? LIMIT 1").get(taskId) !== undefined },
    completion: {
      satisfied: completion.every((one) => one.satisfied),
      unmet: completion.filter((one) => !one.satisfied).map((one) => `「${one.collection}」${one.condition}：${one.summary}`),
    },
  };
}

/**
 * 任务现在的阶段与每个阶段的几盏灯。早先建的任务（没有「总体分析」集合）没有阶段，返回 null。只读：
 * 助手的查询任务状态与后端的整份数据都经这里，所以两侧说的是同一回事。
 */
export function stageSummary(db: DatabaseSync, workspaceDir: string, taskId: string, definition: TaskDefinition): StageSummary | null {
  if (!hasOverall(definition.collections)) return null;
  const open = openActivityRecord(db, taskId);
  return {
    current: open?.activity ?? defaultStage(taskHasMaterials(workspaceDir, definition.materialsDir)),
    moved_by: open?.actor ?? null,
    moved_at: open?.started_at ?? null,
    reason: open ? open.reason : null,
    lamps: stageLamps(lampInput(db, workspaceDir, taskId, definition)),
  };
}

/**
 * 同上，但任务与它的定义由这里自己从库里取（库里的第一个任务）：给手里只有库连接与任务目录的调用方用（后端的整份数据）。
 * 库里还没有任务时返回 null。
 */
export function stageSummaryOf(db: DatabaseSync, workspaceDir: string): StageSummary | null {
  const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; definition_text: string } | undefined;
  return task ? stageSummary(db, workspaceDir, task.task_id, validateDefinition(JSON.parse(task.definition_text))) : null;
}

/**
 * 给助手看的一段：任务现在在哪个阶段、最近一次是谁在什么时候为什么移的，以及这一段还差什么（只说现在这个阶段的几盏灯）。
 * 查询任务状态的返回末尾用它。
 */
export function stageLines(summary: StageSummary): string[] {
  const name = STAGE_NAMES[summary.current];
  const reason = (summary.reason ?? "").replace(/[。.\s]+$/, "");
  const head = summary.moved_by === null
    ? `任务现在在${name}阶段（任务建好之后还没有人移动过）。`
    : `任务现在在${name}阶段（${summary.moved_by === "user" ? "用户" : "助手"}在 ${(summary.moved_at ?? "").slice(0, 16).replace("T", " ")} 移过来的${reason ? `，理由：${reason}` : ""}）。`;
  return [head, ...lampLines(summary.current, summary.lamps[summary.current])];
}
