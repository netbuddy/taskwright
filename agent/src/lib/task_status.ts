/**
 * 任务现状消息：pi 打开一条会话时，扩展往会话里追加的那条自定义消息的内容。
 *
 * 一库一任务之后，用户从不选任务；执行者打开会话时靠这条消息知道任务现在的样子：
 *
 * - 新会话（会话里还没有任何用户消息，也还没有写过现状消息）：写任务现状——任务名与类型、交付物
 *   按集合各有几个条目、完成条件满足几项未满足几项、未解决的问题条目几条。
 * - 续接旧会话：写「上次这条会话结束之后」交付物发生的变化，没有变化返回 null（不追加）。
 *   「上次结束」取这条会话当前分支上最后一条消息（消息或自定义消息，不算模型切换之类的设置条目）的时刻，
 *   换算成本机时间之后与事件表的时刻文字比较；事件表记的是同一台机器的本地时间，写法相同，可以直接比大小。
 *   不用「这条会话最后一条事件」，因为会话里只聊天、没写过库时它不存在，而且用户在界面上的直接操作
 *   已经经自定义消息告诉过这条会话，按时刻切更完整。
 *
 * 两种都列出材料目录（任务定义的「材料目录」，缺省 inputs/）里的文件名与大小：材料是建任务时在界面上传的，
 * 执行者不看这张清单就不知道有材料可读。续接时交付物没有变化、但材料目录里有
 * 上次之后新放进来的文件，也写一条，只列材料。Word 材料另写它有几段、分成几块、分段清单在哪（lib/segments.ts）；
 * 续接时再写每份材料的引用情况：Word 材料还有几段没有被任何条目引用，文本材料被引用过几次。
 *
 * 知识库：任务选用的知识库（lib/knowledge.ts）里有文档时，现状消息另列一段：每个知识库的名字与文档个数，每份文档的名字、种类、
 * 大小与引用它时出处的写法。这一段不写文档的路径，也不写文档的正文，文档不分大小都是一行：助手查知识库用查找知识库的工具
 * （search_knowledge），原文由查找的结果逐字给出。选用的知识库里一份文档都没有、或者没有知识库时不写这一段。续接时，只在上次之后任务的选用或选用的知识库的文档清单变过时写这一段（按这两种文件的修改时刻判断，
 * 整段重写；与任务无关的知识库新建、改名、删除不算）。
 *
 * 被停止的运行：这条会话里上一次运行是被用户停止的、此后用户还没有再说话时，续接的那一条另写一句「上一次运行被用户停止，没有做完。」，
 * details.last_run_stopped 为真；交付物、材料、知识库都没有变化时也为这一句写一条。用户停止之后不关会话接着说话时不经过这里，
 * 那时助手靠停止时留在会话里的界面操作通知知道（lib/user_ops.ts 的 STOP_RUN_NOTE）。
 *
 * 对话理解：这条会话里还有在等回应的执行者行为（你问过、用户还没回应的，见 lib/dialogue_acts.ts）时，消息末尾另列一行，
 * details.open_acts 是同一份清单。新会话里还没有对话行为，这一行只在续接时出现。
 *
 * 数字全部由库算出：条目数查条目表，完成条件用 conditions.ts 里与「发布版本」门禁同一组函数。
 * 本模块只读库（只读方式打开），不写任何东西，不依赖 pi，单元测试可以直接调用。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkCompletion, completionBrief, currentItems } from "./conditions.ts";
import { ACTOR_USER, databasePath, load, wallClockText } from "./db.ts";
import { type TaskDefinition, validateDefinition } from "./definition.ts";
import { BUSY_TIMEOUT_MS } from "./schema.ts";
import { FUNCTION_NAMES } from "./intent_schema.ts";
import { unansweredActs } from "./dialogue_acts.ts";
import { isLocationTable } from "./docx_locations.ts";
import { isPdfLocationTable } from "./pdf_locations.ts";
import { type SelectedLibrary, envKnowledgeRoot, knowledgeChangedAt, selectedKnowledge } from "./knowledge.ts";
import { type MaterialFacts, envSegmentParams, materialFacts } from "./segments.ts";
import { missingMaterialPaths } from "./material_db.ts";
import { hasOverall } from "./overall_analysis.ts";
import { openProposal, proposalLine } from "./stage_proposal.ts";
import { fillText } from "./texts.ts";

/** 这条自定义消息的类型名。后端、观测台与会话文件里都认这个名字。 */
export const TASK_STATUS_CUSTOM_TYPE = "taskwright-task-status";

/** 会话里与本模块有关的几样事实，由扩展从会话管理器读好交进来。 */
export interface SessionFacts {
  /** 当前分支上有没有 pi 的用户消息。 */
  hasUserMessage: boolean;
  /** 当前分支上有没有写过任务现状消息。 */
  hasStatusMessage: boolean;
  /** 当前分支上最后一条消息（消息或自定义消息）的时刻，毫秒；一条都没有为 null。 */
  lastMessageAt: number | null;
  /** 上一次运行被用户停止，此后用户没有再说话，也还没有写过现状消息。不给当作假。 */
  lastRunStopped?: boolean;
}

/** 续接时上一次运行是被用户停止的，现状消息里加的那一句。页面照原样显示这一句（backend/src/conversation.ts 不改它）。 */
export const LAST_RUN_STOPPED_SENTENCE = fillText("status.last_run_stopped");

export interface TaskStatusMessage {
  kind: "现状" | "变化";
  text: string;
  details: Record<string, unknown>;
}

interface TaskRow {
  task_id: string;
  task_name: string | null;
  definition_text: string;
}

interface EventRow {
  seq: number;
  name: string;
  actor: string;
  session_id: string;
  payload: string;
  at: string;
}

/**
 * 按会话的样子决定写哪一种：新会话写现状，续接写变化。库不存在或没有任务时返回 null。
 * knowledgeRoot 是知识库根目录，缺省取环境变量；为 null 时当作没有知识库。
 */
export function taskStatusMessage(workspaceDir: string, facts: SessionFacts, sessionId: string,
  knowledgeRoot: string | null = envKnowledgeRoot()): TaskStatusMessage | null {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT task_id, task_name, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
      | TaskRow
      | undefined;
    if (!task) return null;
    const definition = validateDefinition(JSON.parse(task.definition_text));
    const materials: Materials = listMaterials(workspaceDir, definition.materialsDir);
    materials.facts = materialFacts(db, task.task_id, workspaceDir, materials.files.map((f) => f.path), envSegmentParams());
    materials.missing = missingMaterialPaths(db, workspaceDir);
    const libraries = selectedKnowledge(workspaceDir, knowledgeRoot);
    const fresh = !facts.hasUserMessage && !facts.hasStatusMessage;
    const message = fresh || facts.lastMessageAt === null
      ? withKnowledge(statusNow(db, task, definition, materials, workspaceDir), libraries, "")
      // 续接：上次之后任务的选用或知识库的文档清单变过，才把知识库一段再写一遍。
      : changesSince(db, task, facts.lastMessageAt, sessionId, materials,
        knowledgeChangedAt(workspaceDir, knowledgeRoot) > facts.lastMessageAt ? libraries : null, facts.lastRunStopped === true);
    return withOpenActs(db, task.task_id, sessionId, withProposal(db, task, definition, sessionId, fresh ? null : facts.lastMessageAt, materials, message));
  } finally {
    db.close();
  }
}

/**
 * 「这个任务选用的知识库」一段：每个知识库一行写名字与文档个数，下面每份文档一行（名字、种类、大小、出处的写法；
 * 不给路径，不给正文）。所有选用的知识库都没有文档（或者没有知识库）时是空文字。任务现状、续接时的变化与「查询任务状态」都用它。
 * 开头那句里的规矩与平台说明「知识库怎样用」、查找知识库工具的说明（agent/prompts/tools/search_knowledge.md）是同一条，改一处要三处一起改。
 */
export function knowledgeSection(libraries: SelectedLibrary[]): string {
  if (!libraries.some((one) => one.documents.length > 0)) return "";
  const lines = [fillText("status.knowledge_lead")];
  for (const library of libraries) {
    if (library.documents.length === 0) {
      lines.push(fillText("status.knowledge_library_empty", { name: library.name }));
      continue;
    }
    lines.push(fillText("status.knowledge_library", { name: library.name, count: library.documents.length }));
    for (const doc of library.documents) {
      lines.push(doc.word
        ? fillText("status.knowledge_document_word", { name: doc.name, kind: doc.kindName, size: sizeText(doc.bytes), locator: doc.locator })
        : fillText("status.knowledge_document", { name: doc.name, kind: doc.kindName, size: sizeText(doc.bytes), locator: doc.locator }));
    }
  }
  return lines.join("\n");
}

/** 知识库一段对应的 details：每个选用的知识库的编号、名字与文档（名字、种类、大小、出处的写法）。 */
export const knowledgeDetails = (libraries: SelectedLibrary[]) => libraries.map((one) => ({
  id: one.id, name: one.name,
  documents: one.documents.map((doc) => ({ name: doc.name, kind: doc.kindName, bytes: doc.bytes, locator: doc.locator })),
}));

/** 在消息后面另起一行写知识库一段（前面可以加一句引子）；这一段是空的就原样返回。 */
function withKnowledge(message: TaskStatusMessage, libraries: SelectedLibrary[], lead: string): TaskStatusMessage {
  const section = knowledgeSection(libraries);
  if (!section) return message;
  return { ...message, text: `${message.text}\n${lead}${section}`, details: { ...message.details, knowledge: knowledgeDetails(libraries) } };
}

/** 续接时知识库变过：把知识库一段再写一遍；现在选用的知识库里一份文档都没有时只说一句。 */
function withKnowledgeChange(message: TaskStatusMessage, libraries: SelectedLibrary[]): TaskStatusMessage {
  if (knowledgeSection(libraries)) return withKnowledge(message, libraries, fillText("status.knowledge_changed"));
  return {
    ...message,
    text: `${message.text}\n${fillText("status.knowledge_changed_empty")}`,
    details: { ...message.details, knowledge: knowledgeDetails(libraries) },
  };
}

/**
 * 在消息末尾写一行开着的提议（lib/stage_proposal.ts 的 proposalLine）；任务没有阶段时原样返回。
 * - 新会话：有没有都写（没有时写「没有开着的提议。」），助手从干净的上下文开始，靠这一行知道。
 * - 续接旧会话（since 是上次这条会话最后一条消息的时刻）：只在有一条开着的、而且是上次之后才发出的提议时写；
 *   上次之前发的，这条会话的上下文里已经有过交代，不重复。这时别的都没有变也为它写一条。
 */
function withProposal(db: DatabaseSync, task: TaskRow, definition: TaskDefinition, sessionId: string, since: number | null, materials: Materials,
  message: TaskStatusMessage | null): TaskStatusMessage | null {
  if (!hasOverall(definition.collections)) return message;
  const open = openProposal(db, task.task_id, sessionId);
  const line = proposalLine(open, sessionId);
  if (since === null) return message ? { ...message, text: `${message.text}\n${line}`, details: { ...message.details, proposal: open } } : message;
  if (open === null || open.at <= wallClockText(new Date(since))) return message;
  const base: TaskStatusMessage = message ?? {
    kind: "变化",
    text: `${fillText("status.head_changes", { clock: clock() })}${fillText("status.no_changes")}`,
    details: { kind: "变化", task_id: task.task_id, since: wallClockText(new Date(since)), session_id: sessionId, added: [], updated: [], deleted: [], event_seqs: [],
      materials: materialsDetails(materials), new_materials: [] },
  };
  return { ...base, text: `${base.text}\n${line}`, details: { ...base.details, proposal: open } };
}

/** 在消息末尾列出这条会话里还在等回应的执行者行为；没有就原样返回。 */
function withOpenActs(db: DatabaseSync, taskId: string, sessionId: string, message: TaskStatusMessage | null): TaskStatusMessage | null {
  if (!message) return message;
  const open = unansweredActs(db, taskId, sessionId);
  if (open.length === 0) return message;
  const list = open.map((one) => fillText("status.open_act", { act: one.act_id, function: FUNCTION_NAMES[one.function] ?? one.function, summary: one.summary })).join("；");
  return {
    ...message,
    text: `${message.text}\n${fillText("status.open_acts", { count: open.length, list })}`,
    details: { ...message.details, open_acts: open.map((one) => ({ act_id: one.act_id, function: one.function, summary: one.summary })) },
  };
}

export interface MaterialFile {
  /** 相对任务目录的路径，例如 inputs/需求.md。 */
  path: string;
  bytes: number;
  /** 最后修改时刻，毫秒。 */
  modifiedAt: number;
}

/** 材料清单，另可带每份材料的分段与引用情况（lib/segments.ts 的 materialFacts）。 */
export interface Materials {
  dir: string;
  files: MaterialFile[];
  facts?: MaterialFacts[];
  /** 材料表里有而文件不在的材料（lib/material_db.ts 的 missingMaterialPaths）：只记进 details（有才写），页面数材料份数时连它们一起数。 */
  missing?: string[];
}

/**
 * 材料目录第一层的文件，按文件名排序；目录不存在时为空。隐藏文件不列；Word 材料与 PDF 材料的位置表（lib/docx_locations.ts、lib/pdf_locations.ts）也不列：
 * 它给页面的来源标签用，助手不读它（任务现状、get_task_status 与评审取材料都经这里）。
 */
export function listMaterials(workspaceDir: string, materialsDir: string): { dir: string; files: MaterialFile[] } {
  const full = join(workspaceDir, materialsDir);
  if (!existsSync(full)) return { dir: materialsDir, files: [] };
  const files: MaterialFile[] = [];
  for (const name of readdirSync(full).sort()) {
    if (name.startsWith(".") || isLocationTable(name) || isPdfLocationTable(name)) continue;
    const stat = statSync(join(full, name));
    if (stat.isFile()) files.push({ path: `${materialsDir}${name}`, bytes: stat.size, modifiedAt: stat.mtimeMs });
  }
  return { dir: materialsDir, files };
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return fillText("status.size_bytes", { size: bytes });
  if (bytes < 1024 * 1024) return fillText("status.size_kb", { size: (bytes / 1024).toFixed(1) });
  return fillText("status.size_mb", { size: (bytes / 1024 / 1024).toFixed(1) });
}

/**
 * 材料清单那一句。Word 材料（.docx）旁边有上传时生成的 Markdown 投影（同名加 .md；0.2 的任务里是同名加 .txt 的纯文本投影），
 * 清单里照样列出，另加一句：Word 材料读投影，引用时出处写 Word 文件加段落号。带了分段情况时，每份 Word 材料再写一句段数、块数与分段清单。
 * PDF 材料（.pdf）同样：读由它生成的投影，出处写 PDF 文件加页与块；带了分段情况时写页数、块数、哪几页没有文字与分段清单。
 */
export function materialsSentence(materials: Materials): string {
  if (materials.files.length === 0) return fillText("status.materials_none", { dir: materials.dir });
  const paths = new Set(materials.files.map((f) => f.path));
  const words = materials.files.filter((f) => /\.docx$/i.test(f.path) && (paths.has(`${f.path}.md`) || paths.has(`${f.path}.txt`))).map((f) => f.path);
  const projections = words.map((w) => (paths.has(`${w}.md`) ? `${w}.md` : `${w}.txt`));
  const note = words.length ? fillText("status.materials_word", { words: words.join("、"), projections: projections.join("、"), first: words[0] }) : "";
  const pdfs = materials.files.filter((f) => /\.pdf$/i.test(f.path) && paths.has(`${f.path}.md`)).map((f) => f.path);
  const pdfValues = { pdfs: pdfs.join("、"), projections: pdfs.map((p) => `${p}.md`).join("、"), first: pdfs[0] };
  const pdfNote = !pdfs.length ? "" : words.length ? fillText("status.materials_pdf_also", pdfValues) : fillText("status.materials_pdf", pdfValues);
  const segments = (materials.facts ?? []).flatMap((f) => (f.kind === "word"
    ? [fillText("status.segments_word", {
      path: f.path, text_paragraphs: f.text_paragraphs, paragraphs: f.paragraphs, blocks: f.blocks.length,
      list: f.segments_file ? fillText("status.segments_word_list", { file: f.segments_file }) : "",
    })]
    : f.kind === "pdf"
      ? [fillText("status.segments_pdf", {
        path: f.path, pages: f.pages, units: f.units,
        no_text: f.no_text_pages.length ? fillText("status.segments_pdf_no_text", { pages: f.no_text_pages.join("、") }) : "",
        list: f.segments_file ? fillText("status.segments_pdf_list", { file: f.segments_file }) : "",
      })]
      : []));
  return fillText("status.materials", {
    dir: materials.dir, count: materials.files.length,
    files: materials.files.map((f) => fillText("status.material_file", { path: f.path, size: sizeText(f.bytes) })).join("、"),
    word: note, pdf: pdfNote, segments: segments.join(""),
  });
}

/** 续接时的引用情况那一句：Word 材料还有几段、PDF 材料还有几块没有被任何条目引用，文本材料被引用过几次；没有这几种材料时是空文字。 */
export function citationSentence(facts: MaterialFacts[] | undefined): string {
  const parts = (facts ?? []).map((f) => (f.kind === "word"
    ? (f.uncited === 0 ? fillText("status.cited_word_all", { path: f.path }) : fillText("status.cited_word_some", { path: f.path, count: f.uncited }))
    : f.kind === "pdf"
      ? (f.uncited === 0 ? fillText("status.cited_pdf_all", { path: f.path }) : fillText("status.cited_pdf_some", { path: f.path, count: f.uncited }))
      : fillText("status.cited_text", { path: f.path, count: f.cited })));
  return parts.length ? fillText("status.citations", { parts: parts.join("；") }) : "";
}

const materialsDetails = (materials: Materials) => ({
  dir: materials.dir,
  files: materials.files.map((f) => ({ path: f.path, bytes: f.bytes })),
  // 只在有缺失的材料时写这一项，平常的消息与原来一样。
  ...(materials.missing?.length ? { missing: materials.missing } : {}),
  citations: (materials.facts ?? []).map((f) => (f.kind === "word"
    ? { path: f.path, text_paragraphs: f.text_paragraphs, blocks: f.blocks.length, uncited: f.uncited }
    : f.kind === "pdf"
      ? { path: f.path, pages: f.pages, units: f.units, no_text_pages: f.no_text_pages, uncited: f.uncited }
      : { path: f.path, cited: f.cited })),
});

/** 写入这条消息的本机时刻（时:分:秒），写在消息开头，读的人知道这是哪一刻的状况。 */
function clock(): string {
  return wallClockText().slice(11, 19);
}

/** 任务现状。 */
function statusNow(db: DatabaseSync, task: TaskRow, definition: TaskDefinition, materials: Materials, workspaceDir: string): TaskStatusMessage {
  const name = task.task_name ?? definition.taskName;
  const counts = definition.collections.map((collection) => ({
    collection: collection.name,
    count: currentItems(db, task.task_id, collection.name).length,
  }));
  const total = counts.reduce((sum, one) => sum + one.count, 0);
  const results = checkCompletion(db, task.task_id, definition.completion, { workspaceDir });
  const met = results.filter((one) => one.state === "met").length;
  const unmetCount = results.filter((one) => one.state === "unmet").length;
  // 未解决的问题条目：带「状态」枚举、取值里有「未解决」的集合里，当前内容状态为未解决的条目。
  let unresolved = 0;
  for (const collection of definition.collections) {
    const status = collection.fields.find((field) => field.name === "状态");
    if (!status || !(status.values ?? []).includes("未解决")) continue;
    unresolved += currentItems(db, task.task_id, collection.name).filter(
      (row) => (load(row.fields) as Record<string, unknown>)["状态"] === "未解决",
    ).length;
  }
  const parts = [
    fillText("status.task_line", { name, type: definition.taskName, id: task.task_id }),
    total === 0
      ? fillText("status.items_none")
      : fillText("status.items", { total, counts: counts.map((one) => fillText("status.items_count", { collection: one.collection, count: one.count })).join("、") }),
    completionBrief(results),
    fillText("status.unresolved", { count: unresolved }),
    materialsSentence(materials),
  ];
  return {
    kind: "现状",
    text: `${fillText("status.head_now", { clock: clock() })}${parts.join("")}`,
    details: {
      kind: "现状",
      task_id: task.task_id,
      task_name: name,
      task_type: definition.taskName,
      items: Object.fromEntries(counts.map((one) => [one.collection, one.count])),
      conditions_total: results.length,
      conditions_met: met,
      conditions_unmet: unmetCount,
      conditions_empty: results.length - met - unmetCount,
      unresolved,
      materials: materialsDetails(materials),
    },
  };
}

/** 上次这条会话结束之后的变化（交付物、材料、知识库），以及上一次运行是不是被用户停止的；都没有返回 null。 */
function changesSince(
  db: DatabaseSync,
  task: TaskRow,
  lastMessageAt: number,
  sessionId: string,
  materials: Materials,
  /** 上次之后知识库变过时，是现在选用的知识库；没变过为 null。 */
  knowledge: SelectedLibrary[] | null,
  lastRunStopped: boolean,
): TaskStatusMessage | null {
  const changed = changesInItems(db, task, lastMessageAt, sessionId, materials);
  if (knowledge === null && !lastRunStopped) return changed;
  const cutoff = wallClockText(new Date(lastMessageAt));
  // 交付物与材料都没有变、只有知识库变了或者只有上一次运行被停止这件事：照「只有新材料」的样子写一条，材料清单不重复。
  const base: TaskStatusMessage = changed ?? {
    kind: "变化",
    text: `${fillText("status.head_changes", { clock: clock() })}${fillText("status.no_changes")}`,
    details: { kind: "变化", task_id: task.task_id, since: cutoff, session_id: sessionId, added: [], updated: [], deleted: [], event_seqs: [],
      materials: materialsDetails(materials), new_materials: [] },
  };
  const told = lastRunStopped
    ? { ...base, text: `${base.text}${LAST_RUN_STOPPED_SENTENCE}`, details: { ...base.details, last_run_stopped: true } }
    : base;
  return knowledge === null ? told : withKnowledgeChange(told, knowledge);
}

/** 上次之后交付物与材料的变化；都没有变返回 null。 */
function changesInItems(
  db: DatabaseSync,
  task: TaskRow,
  lastMessageAt: number,
  sessionId: string,
  materials: Materials,
): TaskStatusMessage | null {
  const cutoff = wallClockText(new Date(lastMessageAt));
  const newMaterials = materials.files.filter((f) => f.modifiedAt > lastMessageAt).map((f) => f.path);
  const events = db
    .prepare("SELECT seq, name, actor, session_id, payload, at FROM event WHERE task_id = ? AND at > ? ORDER BY seq")
    .all(task.task_id, cutoff) as unknown as EventRow[];
  if (events.length === 0) return newMaterials.length ? materialsOnly(task, cutoff, sessionId, materials, newMaterials) : null;

  // 按条目合并这段时间里的全部操作：先新增的算新增；只改过的记最早的改前修订号与最后的改后修订号；
  // 新增之后又删掉的不提；原有条目被删的算删除。
  const added = new Map<string, string>();
  const updated = new Map<string, { from: number; to: number }>();
  const deleted = new Map<string, number>();
  let byUser = 0;
  let byExecutorElsewhere = 0;
  for (const event of events) {
    if (event.name !== "REVISION_SAVED") continue;
    if (event.actor === ACTOR_USER) byUser += 1;
    else byExecutorElsewhere += 1;
    const payload = load(event.payload) as { operations?: { op: string; item: string; from_revision: number | null; to_revision: number | null }[] };
    for (const op of payload.operations ?? []) {
      if (op.op === "add") {
        added.set(op.item, op.item);
      } else if (op.op === "update") {
        if (added.has(op.item)) continue;
        const seen = updated.get(op.item);
        updated.set(op.item, { from: seen ? seen.from : op.from_revision ?? 0, to: op.to_revision ?? 0 });
      } else if (op.op === "delete") {
        if (added.has(op.item)) {
          added.delete(op.item);
          continue;
        }
        const seen = updated.get(op.item);
        updated.delete(op.item);
        deleted.set(op.item, seen ? seen.from : op.from_revision ?? 0);
      }
    }
  }
  const pieces: string[] = [];
  if (added.size > 0) pieces.push(fillText("status.change_added", { count: added.size, items: [...added.keys()].join("、") }));
  if (updated.size > 0) {
    pieces.push(fillText("status.change_updated", {
      count: updated.size, items: [...updated.entries()].map(([item, v]) => fillText("status.change_updated_item", { item, from: v.from, to: v.to })).join("、"),
    }));
  }
  if (deleted.size > 0) pieces.push(fillText("status.change_deleted", { count: deleted.size, items: [...deleted.keys()].join("、") }));
  if (pieces.length === 0) return newMaterials.length ? materialsOnly(task, cutoff, sessionId, materials, newMaterials) : null;
  const sources: string[] = [];
  if (byUser > 0) sources.push(fillText("status.change_by_user", { count: byUser }));
  if (byExecutorElsewhere > 0) sources.push(fillText("status.change_by_executor", { count: byExecutorElsewhere }));
  const text =
    fillText("status.head_changes", { clock: clock() }) +
    fillText("status.changes", { pieces: pieces.join("；"), count: byUser + byExecutorElsewhere, sources: sources.join("，") }) +
    materialsSentence(materials) +
    (newMaterials.length ? fillText("status.new_materials", { files: newMaterials.join("、") }) : "") +
    citationSentence(materials.facts);
  return {
    kind: "变化",
    text,
    details: {
      kind: "变化",
      task_id: task.task_id,
      since: cutoff,
      session_id: sessionId,
      added: [...added.keys()],
      updated: [...updated.entries()].map(([item, v]) => ({ item, from_revision: v.from, to_revision: v.to })),
      deleted: [...deleted.keys()],
      event_seqs: events.map((one) => one.seq),
      materials: materialsDetails(materials),
      new_materials: newMaterials,
    },
  };
}

/** 续接时交付物没有变化、只有新放进来的材料。 */
function materialsOnly(
  task: TaskRow,
  cutoff: string,
  sessionId: string,
  materials: Materials,
  newMaterials: string[],
): TaskStatusMessage {
  return {
    kind: "变化",
    text:
      fillText("status.head_changes", { clock: clock() }) + fillText("status.no_changes") +
      materialsSentence(materials) +
      fillText("status.new_materials", { files: newMaterials.join("、") }) +
      citationSentence(materials.facts),
    details: {
      kind: "变化",
      task_id: task.task_id,
      since: cutoff,
      session_id: sessionId,
      added: [],
      updated: [],
      deleted: [],
      event_seqs: [],
      materials: materialsDetails(materials),
      new_materials: newMaterials,
    },
  };
}
