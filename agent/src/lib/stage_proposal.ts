/**
 * 开着的提议：助手做完一段，用一张请选择卡片提议进入下一个阶段；这张卡片发出去之后，提议就一直开着，
 * 直到任务的阶段有过一次移动（用户点了进入，或者助手把任务退回了前面的阶段）、助手又发了一张这样的卡片、或者任务不再进行中。
 * 提议开着时，页面在输入框上方留一行「待决定」，用户讨论、修订多少轮之后都能从那里进入下一段。
 *
 * 提议不另设表：助手发卡片时「回复」记的那条事件（EXECUTOR_ACTS_RECORDED）里多带一项 proposal（proposalOfAct），
 * 开着的是哪一条从事件表里推（openProposal）。卡片的选项只在那一条会话的会话文件里，任务库里原来没有记，所以要在发的时候记下：
 * 换一条会话之后也认得出它。这一项做出来之前发的卡片事件里没有 proposal，认不成提议；卡片自己照常能点。
 *
 * 只有有阶段的任务（任务定义里有「总体分析」集合）才有提议。
 */

import type { DatabaseSync } from "node:sqlite";
import { load } from "./db.ts";
import { validateDefinition } from "./definition.ts";
import { hasOverall } from "./overall_analysis.ts";
import { TASK_ACTIVE } from "./schema.ts";
import { type CardOption, STAY_OPTIONS, type Stage, stageEnteredBy } from "./stage.ts";

/** 「回复」记执行者行为的那条事件的名字（与 lib/dialogue_acts.ts 的 EVENT_EXECUTOR_ACTS_RECORDED 同一个；这里不从它导入，免得两个文件互相导入）。 */
const EVENT_ACTS = "EXECUTOR_ACTS_RECORDED";
/** 阶段移动那条事件的名字（与 lib/stage_read.ts 的 EVENT_STAGE_MOVED 同一个）。 */
const EVENT_MOVED = "STAGE_MOVED";

const STAY_KEYS: ReadonlySet<string> = new Set(Object.values(STAY_OPTIONS).map((one) => one.key));

/** 卡片上的一个选项键是不是「留在这一段」的那四个键之一。 */
export function isStayKey(key: unknown): boolean {
  return typeof key === "string" && STAY_KEYS.has(key);
}

/** 一张进入卡片记在事件里的内容：要进入哪个阶段、进入与留在本段两个选项、卡片的问句、点名请用户先看的条目。 */
export interface ProposalFact {
  stage: Exclude<Stage, "reading">;
  enter: CardOption;
  /** 留在这一段的那个选项；卡片上没有时为 null。文字是助手写的那一句，页面上一律显示成「继续本阶段」。 */
  stay: CardOption | null;
  text: string;
  items: { item_id: string; revision_no: number | null }[];
}

/** 开着的提议：事件里记的内容，加上卡片在哪条会话的哪条回复上、那条事件的序号与时刻（本地时间的文字）。 */
export interface OpenProposal extends ProposalFact {
  session_id: string;
  /** 卡片所在那条回复的会话条目编号；没有记下时为 null。 */
  reply_entry: string | null;
  event_seq: number;
  at: string;
}

const optionOf = (value: unknown): CardOption | null => {
  const one = value as { key?: unknown; text?: unknown } | null;
  return one && typeof one.key === "string" && one.key !== "" ? { key: one.key, text: typeof one.text === "string" ? one.text : one.key } : null;
};

/**
 * 一张卡片是不是提议进入下一个阶段的：请选择，选项里有一个「进入」某个阶段的键。是的话返回要记进事件的内容，不是返回 null。
 * 不读库，也不管任务有没有阶段（那一层由 proposalFor 判）。
 */
export function proposalOfAct(act: unknown): ProposalFact | null {
  const card = act as { kind?: unknown; text?: unknown; options?: unknown; items?: unknown } | null;
  if (!card || card.kind !== "choose" || !Array.isArray(card.options)) return null;
  const options = card.options.map(optionOf).filter((one): one is CardOption => one !== null);
  const enter = options.find((one) => stageEnteredBy(one.key) !== null);
  if (!enter) return null;
  const items = (Array.isArray(card.items) ? card.items : [])
    .filter((one): one is { item_id: string; revision_no?: unknown } => typeof (one as { item_id?: unknown } | null)?.item_id === "string")
    .map((one) => ({ item_id: one.item_id, revision_no: typeof one.revision_no === "number" ? one.revision_no : null }));
  return { stage: stageEnteredBy(enter.key)!, enter, stay: options.find((one) => isStayKey(one.key)) ?? null, text: typeof card.text === "string" ? card.text : "", items };
}

/** 任务有没有阶段：任务定义里有「总体分析」集合。读不出任务定义时当作没有。 */
function taskHasStages(db: DatabaseSync, taskId: string): boolean {
  const row = db.prepare("SELECT definition_text FROM task WHERE task_id = ?").get(taskId) as { definition_text: string } | undefined;
  if (!row) return false;
  try {
    return hasOverall(validateDefinition(JSON.parse(row.definition_text)).collections);
  } catch {
    return false;
  }
}

/** 「回复」记事件时调用：这张卡片是进入卡片、任务又有阶段，就返回要并进事件的 proposal；否则 null。必须在调用方已经开好的事务里调用。 */
export function proposalFor(db: DatabaseSync, taskId: string, act: unknown): ProposalFact | null {
  const fact = proposalOfAct(act);
  return fact !== null && taskHasStages(db, taskId) ? fact : null;
}

/**
 * 任务现在开着的提议；没有时为 null。只读。
 * 取最近一条带 proposal 的回复事件：它之后任务的阶段没有移动过、任务还在进行中，它就开着。
 * 更早的提议不看：助手发了新的进入卡片，早先的那一条就结束了。
 */
export function openProposal(db: DatabaseSync, taskId: string): OpenProposal | null {
  const task = db.prepare("SELECT status FROM task WHERE task_id = ?").get(taskId) as { status: string } | undefined;
  if (!task || task.status !== TASK_ACTIVE) return null;
  const rows = db.prepare(
    "SELECT seq, session_id, payload, at FROM event WHERE task_id = ? AND name = ? AND payload LIKE '%\"proposal\"%' ORDER BY seq DESC",
  ).all(taskId, EVENT_ACTS) as unknown as { seq: number; session_id: string; payload: string; at: string }[];
  for (const row of rows) {
    const payload = load(row.payload) as { proposal?: unknown; reply_entry?: unknown } | null;
    const fact = payload?.proposal as ProposalFact | undefined;
    // 回复的正文里碰巧有 "proposal" 这几个字的事件不算：要真有这一项、里面写着进入哪个阶段。
    if (!fact || typeof fact !== "object" || stageEnteredBy(fact.enter?.key) === null) continue;
    const seq = Number(row.seq);
    const moved = db.prepare("SELECT 1 AS yes FROM event WHERE task_id = ? AND name = ? AND seq > ? LIMIT 1").get(taskId, EVENT_MOVED, seq);
    if (moved) return null;
    return { ...fact, items: Array.isArray(fact.items) ? fact.items : [], stay: fact.stay ?? null, session_id: row.session_id,
      reply_entry: typeof payload?.reply_entry === "string" ? payload.reply_entry : null, event_seq: seq, at: row.at };
  }
  return null;
}
