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
 * 对话理解：这条会话里还有在等回应的执行者行为（你问过、用户还没回应的，见 lib/dialogue_acts.ts）时，消息末尾另列一行，
 * details.open_acts 是同一份清单。新会话里还没有对话行为，这一行只在续接时出现。
 *
 * 数字全部由库算出：条目数查条目表，完成条件用 conditions.ts 里与「完成任务」门禁同一组函数。
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
import { type MaterialFacts, envSegmentParams, materialFacts } from "./segments.ts";

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
}

export interface TaskStatusMessage {
  kind: "现状" | "变化";
  text: string;
  details: Record<string, unknown>;
}

interface TaskRow {
  task_id: string;
  task_name: string | null;
  status: string;
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

/** 按会话的样子决定写哪一种：新会话写现状，续接写变化。库不存在或没有任务时返回 null。 */
export function taskStatusMessage(workspaceDir: string, facts: SessionFacts, sessionId: string): TaskStatusMessage | null {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT task_id, task_name, status, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
      | TaskRow
      | undefined;
    if (!task) return null;
    const definition = validateDefinition(JSON.parse(task.definition_text));
    const materials: Materials = listMaterials(workspaceDir, definition.materialsDir);
    materials.facts = materialFacts(db, task.task_id, workspaceDir, materials.files.map((f) => f.path), envSegmentParams());
    const fresh = !facts.hasUserMessage && !facts.hasStatusMessage;
    const message = fresh || facts.lastMessageAt === null
      ? statusNow(db, task, definition, materials, workspaceDir)
      : changesSince(db, task, facts.lastMessageAt, sessionId, materials);
    return withOpenActs(db, task.task_id, sessionId, message);
  } finally {
    db.close();
  }
}

/** 在消息末尾列出这条会话里还在等回应的执行者行为；没有就原样返回。 */
function withOpenActs(db: DatabaseSync, taskId: string, sessionId: string, message: TaskStatusMessage | null): TaskStatusMessage | null {
  if (!message) return message;
  const open = unansweredActs(db, taskId, sessionId);
  if (open.length === 0) return message;
  const list = open.map((one) => `${one.act_id} ${FUNCTION_NAMES[one.function] ?? one.function}「${one.summary}」`).join("；");
  return {
    ...message,
    text: `${message.text}
还在等回应的执行者行为 ${open.length} 条（你问过、用户还没有回应的）：${list}。`,
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
}

/** 材料目录第一层的文件，按文件名排序；目录不存在时为空。隐藏文件不列。 */
export function listMaterials(workspaceDir: string, materialsDir: string): { dir: string; files: MaterialFile[] } {
  const full = join(workspaceDir, materialsDir);
  if (!existsSync(full)) return { dir: materialsDir, files: [] };
  const files: MaterialFile[] = [];
  for (const name of readdirSync(full).sort()) {
    if (name.startsWith(".")) continue;
    const stat = statSync(join(full, name));
    if (stat.isFile()) files.push({ path: `${materialsDir}${name}`, bytes: stat.size, modifiedAt: stat.mtimeMs });
  }
  return { dir: materialsDir, files };
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 材料清单那一句。Word 材料（.docx）旁边有上传时生成的 Markdown 投影（同名加 .md；0.2 的任务里是同名加 .txt 的纯文本投影），
 * 清单里照样列出，另加一句：Word 材料读投影，引用时出处写 Word 文件加段落号。带了分段情况时，每份 Word 材料再写一句段数、块数与分段清单。
 */
export function materialsSentence(materials: Materials): string {
  if (materials.files.length === 0) return `材料目录 ${materials.dir} 里现在没有文件。`;
  const paths = new Set(materials.files.map((f) => f.path));
  const words = materials.files.filter((f) => /\.docx$/i.test(f.path) && (paths.has(`${f.path}.md`) || paths.has(`${f.path}.txt`))).map((f) => f.path);
  const projections = words.map((w) => (paths.has(`${w}.md`) ? `${w}.md` : `${w}.txt`));
  const note = words.length
    ? `其中 ${words.join("、")} 是 Word 文件，请读由它生成的投影 ${projections.join("、")}（每段一行，段落号写在方括号里）；引用它作来源时，出处写 Word 文件加段落号，例如 ${words[0]}#p12。`
    : "";
  const segments = (materials.facts ?? []).flatMap((f) => (f.kind === "word"
    ? [`${f.path} 共 ${f.text_paragraphs} 段有文字（段落号 1 到 ${f.paragraphs}）、${f.blocks.length} 块${f.segments_file ? `，分段清单见 ${f.segments_file}` : ""}。`]
    : []));
  return `材料目录 ${materials.dir} 里有 ${materials.files.length} 个文件：${materials.files.map((f) => `${f.path}（${sizeText(f.bytes)}）`).join("、")}。${note}${segments.join("")}`;
}

/** 续接时的引用情况那一句：Word 材料还有几段没有被任何条目引用，文本材料被引用过几次；没有这两种材料时是空文字。 */
export function citationSentence(facts: MaterialFacts[] | undefined): string {
  const parts = (facts ?? []).map((f) => (f.kind === "word"
    ? (f.uncited === 0 ? `${f.path} 每段都有条目引用` : `${f.path} 还有 ${f.uncited} 段没有被任何条目引用`)
    : `${f.path} 被引用过 ${f.cited} 次`));
  return parts.length ? `材料的引用情况：${parts.join("；")}。` : "";
}

const materialsDetails = (materials: Materials) => ({
  dir: materials.dir,
  files: materials.files.map((f) => ({ path: f.path, bytes: f.bytes })),
  citations: (materials.facts ?? []).map((f) => (f.kind === "word"
    ? { path: f.path, text_paragraphs: f.text_paragraphs, blocks: f.blocks.length, uncited: f.uncited }
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
    `任务「${name}」（类型：${definition.taskName}），任务编号 ${task.task_id}，状态是${task.status}。`,
    total === 0
      ? "交付物还没有任何条目。"
      : `交付物现有 ${total} 个条目：${counts.map((one) => `${one.collection} ${one.count} 个`).join("、")}。`,
    completionBrief(results),
    `未解决的问题条目有 ${unresolved} 条。`,
    materialsSentence(materials),
  ];
  return {
    kind: "现状",
    text: `【执行者开始这条会话时（${clock()}）的任务状况：由扩展写入，不是用户打的字】${parts.join("")}`,
    details: {
      kind: "现状",
      task_id: task.task_id,
      task_name: name,
      task_type: definition.taskName,
      status: task.status,
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

/** 上次这条会话结束之后的变化；没有变化返回 null。 */
function changesSince(
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
  if (added.size > 0) pieces.push(`新增 ${added.size} 个条目（${[...added.keys()].join("、")}）`);
  if (updated.size > 0) {
    pieces.push(
      `修改 ${updated.size} 个（${[...updated.entries()].map(([item, v]) => `${item} 修订 ${v.from} → 修订 ${v.to}`).join("、")}）`,
    );
  }
  if (deleted.size > 0) pieces.push(`删除 ${deleted.size} 个（${[...deleted.keys()].join("、")}）`);
  if (pieces.length === 0) return newMaterials.length ? materialsOnly(task, cutoff, sessionId, materials, newMaterials) : null;
  const sources: string[] = [];
  if (byUser > 0) sources.push(`用户在界面上直接做的 ${byUser} 次`);
  if (byExecutorElsewhere > 0) sources.push(`执行者在别的会话里做的 ${byExecutorElsewhere} 次`);
  const text =
    `【执行者续接这条会话时（${clock()}）看到的、上次之后交付物的变化：由扩展写入，不是用户打的字】` +
    `${pieces.join("；")}。这些改动来自 ${byUser + byExecutorElsewhere} 次修订：${sources.join("，")}。` +
    materialsSentence(materials) +
    (newMaterials.length ? `其中上次之后新放进来的是：${newMaterials.join("、")}。` : "") +
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
      `【执行者续接这条会话时（${clock()}）看到的、上次之后交付物的变化：由扩展写入，不是用户打的字】交付物没有变化。` +
      materialsSentence(materials) +
      `其中上次之后新放进来的是：${newMaterials.join("、")}。` +
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
