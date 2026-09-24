/**
 * 「创建任务」的核心逻辑：读取并校验任务定义，核对这个任务目录的库里还没有任务，写一行任务并记一条事件。
 *
 * 2026-09-21 起一库一任务，任务由用户在界面上创建：后端建好任务目录、放好起始文件之后，经不走 pi 的
 * 命令行入口 cli/create_task.mts 调用这里，发起方记「用户」，编号是后端生成的操作编号。执行者不再有
 * 「创建任务」工具。库里已经有任务时一律拒绝，不论那个任务是什么状态。
 *
 * 写库、记事件、各项核对同在一个立即事务里；任何一项不通过就整体回退并抛出拒绝，抛出的文字会原样
 * 交给模型，写明缺什么、可以怎样改。本模块不依赖 pi，工具文件只负责把 pi 的参数交进来。
 */

import type { DatabaseSync } from "node:sqlite";
import { ACTOR_EXECUTOR, type Actor, EVENT_TASK_CREATED, emit, wallClockText } from "./db.ts";
import { type TaskDefinition, loadDefinition } from "./definition.ts";
import { TASK_ACTIVE, withTaskDatabase } from "./schema.ts";

/** 当前会话分支上的一条用户消息：pi 会话条目的编号与原文。 */
export interface UserMessage {
  entryId: string;
  text: string;
}

export interface CallContext {
  /** 任务目录，也就是 pi 的当前工作目录。 */
  workspaceDir: string;
  /** pi 的会话编号。 */
  sessionId: string;
  /**
   * 这次写入的编号：执行者调用工具时是 pi 给这次工具调用的编号；用户在界面上的直接操作经扩展命令写入时，
   * 是后端生成的操作编号（例如 ui-op-13）。原样存进事件表与修订表的 call_id 一列。
   */
  callId: string;
  /** 发起方，缺省是执行者（executor）。扩展命令代用户写入时填 user。 */
  actor?: Actor;
  /**
   * 当前会话分支上的全部用户消息，按先后排。只收 pi 的用户消息角色，扩展追加的自定义消息不算。
   * 「保存修订」据此给种类为「用户的话」的来源代填出处；不给就当作一条都没有。
   * 由工具的登记处在调用核心函数之前从会话管理器读好（读会话是同步的），核心函数里不读会话。
   */
  userMessages?: UserMessage[];
}

export interface ToolOutcome {
  /** 交给模型的文字。 */
  text: string;
  /** 给观测台等读取一侧用的结构化结果，模型看不到。 */
  details: Record<string, unknown>;
}

interface ActiveTask {
  task_id: string;
  definition_text: string;
}

/**
 * 库里状态为进行中的任务，按创建先后排。一库一任务之后，这里至多一行，语义就是「这个库的那个任务」
 * （它还在进行中时）；保留列表的形状，是为了让库里记录出错时调用方能说清楚是什么错。
 */
export function activeTasks(db: DatabaseSync): ActiveTask[] {
  return db
    .prepare("SELECT task_id, definition_text FROM task WHERE status = ? ORDER BY started_at, task_id")
    .all(TASK_ACTIVE) as unknown as ActiveTask[];
}

/** 从任务定义原文快照里取出任务名。快照是创建时校验过的，所以一定读得出来。 */
export function taskNameOf(definitionText: string): string {
  try {
    const raw = JSON.parse(definitionText) as Record<string, unknown>;
    return typeof raw["任务名"] === "string" ? raw["任务名"] : "（任务定义里没有任务名）";
  } catch {
    return "（任务定义原文读不出来）";
  }
}

/** 下一个任务编号：TASK- 加三位流水号，取库里现有最大号加一。 */
function nextTaskId(db: DatabaseSync): string {
  const rows = db.prepare("SELECT task_id FROM task").all() as { task_id: string }[];
  let max = 0;
  for (const row of rows) {
    const match = /^TASK-(\d+)$/.exec(row.task_id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `TASK-${String(max + 1).padStart(3, "0")}`;
}

/** 把交付物结构写成给模型看的说明，让它不必再猜「保存修订」怎样用。 */
export function describeDeliverable(definition: TaskDefinition): string {
  const lines: string[] = [];
  lines.push(`交付物是「${definition.deliverableName}」，由 ${definition.collections.length} 个条目集合组成：`);
  definition.collections.forEach((collection, index) => {
    lines.push(`${index + 1}. 集合「${collection.name}」，条目编号的前缀是 ${collection.prefix}，字段如下：`);
    for (const field of collection.fields) {
      let typeText = `类型是${field.type}`;
      if (field.values) typeText += `，取值只能是${field.values.map((one) => `「${one}」`).join("、")}之一`;
      if (field.type === "文本列表") typeText += "，写成字符串数组，一步或一条一项";
      if (field.type === "条目引用") typeText += "，写成条目编号的数组，例如 [\"UC-001\", \"CON-002\"]，只关联一个条目也要写成数组，不关联任何条目就写 []";
      lines.push(`   - 「${field.name}」：${typeText}，${field.required ? "必填" : "可以不填"}。`);
    }
  });
  lines.push(
    "条目编号由「保存修订」工具生成，新增条目时不要自己写编号；删过的编号不会再用。",
    "每个新增的条目至少要带一条来源。每条来源有：kind 是种类，只能是「文档原文」「用户的话」「执行者补充」之一；" +
      "locator 是出处，文档原文写文件路径，执行者补充写「执行者补充」，用户的话不写、由工具在对话里找到那句话代填；" +
      "excerpt 是摘录的原文，用户的话要逐字照抄；supports 写这条来源支持哪几个字段，" +
      "例如 [{\"field\": \"基本流程\", \"index\": 0}] 指基本流程的第一步（index 从 0 起，只用于列表型字段），支持整个条目就写 [] 或者不写。" +
      "执行者按常识补充的内容，种类写「执行者补充」。",
    "修改或删除条目时要写 base_version，也就是你所见的这个条目的版本号；它与库里的当前版本不符时整批拒绝。",
    "修改条目时只写要改的字段；省略 sources 就沿用上一版的来源，给了就整体替换上一版的来源。",
    "一次「保存修订」可以带多个操作（新增、修改、删除），整次调用只产生一次修订。",
  );
  return lines.join("\n");
}

/** 执行一次「创建任务」。拒绝一律用抛异常的方式，抛出的文字原样交给模型。 */
export interface CreateTaskParams {
  /** 任务定义文件相对任务目录的路径。 */
  definition_path: string;
  /** 用户给任务起的名字，可以不给。 */
  task_name?: string | null;
  /** 领域标签，可以不给；不给就取任务定义里的「领域标签」。 */
  domain_tag?: string | null;
  /**
   * 任务编号，可以不给；不给就按「TASK- 加三位流水号」生成（一库一任务之后总是 TASK-001）。
   * 后端的任务服务同时管很多个任务目录，要求任务编号在所有任务之间不重复，所以由它生成并交进来，
   * 形如 TASK-20260921-7F3A；只允许大写字母、数字与短横线，并且以 TASK- 开头。
   */
  task_id?: string | null;
}

/** 交进来的任务编号的写法。 */
const TASK_ID_PATTERN = /^TASK-[A-Z0-9-]{1,40}$/;

export function createTask(call: CallContext, params: CreateTaskParams): ToolOutcome {
  return withTaskDatabase(call.workspaceDir, { createIfMissing: true }, (db) => {
    const { definition, text, relativePath } = loadDefinition(call.workspaceDir, params.definition_path);
    const existing = db
      .prepare("SELECT task_id, task_name, status, definition_text FROM task ORDER BY started_at, task_id")
      .all() as { task_id: string; task_name: string | null; status: string; definition_text: string }[];
    if (existing.length > 0) {
      const task = existing[0];
      throw new Error(
        `这个任务目录的库里已经有任务了：任务编号是 ${task.task_id}，任务名是「${task.task_name ?? taskNameOf(task.definition_text)}」，状态是${task.status}。` +
          "一个库只放一个任务，所以没有创建新任务。要做新的任务，请新建一个任务目录。",
      );
    }
    const taskName = typeof params.task_name === "string" && params.task_name.trim() !== "" ? params.task_name.trim() : null;
    const domainTag =
      typeof params.domain_tag === "string" && params.domain_tag.trim() !== "" ? params.domain_tag.trim() : definition.domainTag;
    let taskId = nextTaskId(db);
    if (typeof params.task_id === "string" && params.task_id !== "") {
      if (!TASK_ID_PATTERN.test(params.task_id)) {
        throw new Error(`任务编号「${params.task_id}」的写法不对：要以 TASK- 开头，后面只用大写字母、数字与短横线。`);
      }
      taskId = params.task_id;
    }
    const at = wallClockText();
    const seq = emit(db, {
      taskId,
      sessionId: call.sessionId,
      callId: call.callId,
      name: EVENT_TASK_CREATED,
      payload: {
        task_id: taskId,
        task_name: taskName ?? definition.taskName,
        task_type: definition.taskName,
        domain_tag: domainTag,
        definition_path: relativePath,
        collections: definition.collections.map((one) => one.name),
      },
      actor: call.actor ?? ACTOR_EXECUTOR,
    });
    // task 表的唯一写入点。
    db.prepare(
      "INSERT INTO task (task_id, task_name, domain_tag, definition_path, definition_text, status, session_id, call_id, event_seq, started_at, ended_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    ).run(taskId, taskName, domainTag, relativePath, text, TASK_ACTIVE, call.sessionId, call.callId, seq, at);
    const textForModel =
      `已创建任务：任务编号是 ${taskId}，任务名是「${definition.taskName}」，状态是进行中。\n` +
      describeDeliverable(definition) +
      `\n执行方法写在 ${definition.skillPath}，领域规矩文档是 ${definition.rulePaths.join("、")}。`;
    return {
      text: textForModel,
      details: {
        task_id: taskId,
        task_name: taskName ?? definition.taskName,
        task_type: definition.taskName,
        domain_tag: domainTag,
        definition_path: relativePath,
        event_seq: seq,
        saved: true,
      },
    };
  });
}
