/**
 * 开着的提议：助手用一张请选择卡片请用户做一个决定，这张卡片发出去之后，提议就一直开着，页面在输入框上方留一行「待决定」，
 * 用户讨论、修订多少轮之后都能从那里点。提议有三种（kind）：
 * - enter：做完一段，提议进入下一个阶段；
 * - back：这一段的输入大面积不能用了，提议退回前面的某个阶段；
 * - review：编写文档阶段补写完了，请用户过目补写的那几页（点了不移动阶段）。
 * 结束的情形：任务的阶段有过一次移动、助手又发了一张提议的卡片、任务不再进行中；review 另有一种，卡片点名的页用户都看过了。
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
import { overallState } from "./overall_read.ts";
import { TASK_ACTIVE } from "./schema.ts";
import {
  type CardOption, DOCUMENT_REVIEWED_OPTION, DOCUMENT_REVISE_OPTION, STAGE_NAMES, STAY_HERE_OPTION, STAY_OPTIONS, type Stage, isStage, stageBackedBy, stageEnteredBy,
} from "./stage.ts";

/** 「回复」记执行者行为的那条事件的名字（与 lib/dialogue_acts.ts 的 EVENT_EXECUTOR_ACTS_RECORDED 同一个；这里不从它导入，免得两个文件互相导入）。 */
const EVENT_ACTS = "EXECUTOR_ACTS_RECORDED";
/** 阶段移动那条事件的名字（与 lib/stage_read.ts 的 EVENT_STAGE_MOVED 同一个）。 */
const EVENT_MOVED = "STAGE_MOVED";

/** 三种卡片上不生效的那一项：进入卡片的「继续本阶段」、回退卡片的「留在本段」、请过目卡片的「需要修改」。点它只把卡片标为已选。 */
const ENTER_STAY_KEYS: ReadonlySet<string> = new Set(Object.values(STAY_OPTIONS).map((one) => one.key));
const STAY_KEYS: ReadonlySet<string> = new Set([...ENTER_STAY_KEYS, STAY_HERE_OPTION.key, DOCUMENT_REVISE_OPTION.key]);

/** 卡片上的一个选项键是不是不生效的那一项（见 STAY_KEYS）。 */
export function isStayKey(key: unknown): boolean {
  return typeof key === "string" && STAY_KEYS.has(key);
}

export type ProposalKind = "enter" | "back" | "review";

/**
 * 一张提议的卡片记在事件里的内容：哪一种、关于哪个阶段、生效与不生效的两个选项、卡片的问句、点名请用户先看的条目。
 * stage：enter 是要进入的阶段，back 是要退回的阶段，review 是编写文档。enter 是点了就生效的那一项（进入、退回、看过了），
 * 名字沿用早先只有进入卡片时的叫法。早先记下的事件里没有 kind，读出来当作 enter。
 */
export interface ProposalFact {
  kind: ProposalKind;
  stage: Stage;
  enter: CardOption;
  /** 不生效的那个选项；卡片上没有时为 null。进入卡片上的文字是助手写的那一句，页面上一律显示成「继续本阶段」。 */
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
 * 一张卡片是不是提议的卡片：请选择，选项里有一个「进入」某个阶段的键、「退回」某个阶段的键，或者「看过了，生成文档」的键
 * （照这个先后认第一种对得上的）。是的话返回要记进事件的内容，不是返回 null。
 * 不读库，也不管任务有没有阶段（那一层由 proposalFor 判）。
 */
export function proposalOfAct(act: unknown): ProposalFact | null {
  const card = act as { kind?: unknown; text?: unknown; options?: unknown; items?: unknown } | null;
  if (!card || card.kind !== "choose" || !Array.isArray(card.options)) return null;
  const options = card.options.map(optionOf).filter((one): one is CardOption => one !== null);
  const items = (Array.isArray(card.items) ? card.items : [])
    .filter((one): one is { item_id: string; revision_no?: unknown } => typeof (one as { item_id?: unknown } | null)?.item_id === "string")
    .map((one) => ({ item_id: one.item_id, revision_no: typeof one.revision_no === "number" ? one.revision_no : null }));
  const rest = { text: typeof card.text === "string" ? card.text : "", items };
  const enter = options.find((one) => stageEnteredBy(one.key) !== null);
  if (enter) return { kind: "enter", stage: stageEnteredBy(enter.key)!, enter, stay: options.find((one) => ENTER_STAY_KEYS.has(one.key)) ?? null, ...rest };
  const back = options.find((one) => stageBackedBy(one.key) !== null);
  if (back) return { kind: "back", stage: stageBackedBy(back.key)!, enter: back, stay: options.find((one) => one.key === STAY_HERE_OPTION.key) ?? null, ...rest };
  const reviewed = options.find((one) => one.key === DOCUMENT_REVIEWED_OPTION.key);
  if (reviewed) return { kind: "review", stage: "document", enter: reviewed, stay: options.find((one) => one.key === DOCUMENT_REVISE_OPTION.key) ?? null, ...rest };
  return null;
}

/** 事件里记的一项是不是一条认得出的提议：有生效的那一项，种类与它的键对得上。早先没有记 kind 的当作 enter。返回它的种类，认不出是 null。 */
export function proposalKindOf(fact: unknown): ProposalKind | null {
  const one = fact as { kind?: unknown; stage?: unknown; enter?: { key?: unknown } } | null;
  if (!one || typeof one !== "object" || !isStage(one.stage)) return null;
  const kind = one.kind ?? "enter";
  if (kind === "enter") return stageEnteredBy(one.enter?.key) !== null ? "enter" : null;
  if (kind === "back") return stageBackedBy(one.enter?.key) !== null ? "back" : null;
  if (kind === "review") return one.enter?.key === DOCUMENT_REVIEWED_OPTION.key ? "review" : null;
  return null;
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

/** 「回复」记事件时调用：这张卡片是提议的卡片、任务又有阶段，就返回要并进事件的 proposal；否则 null。必须在调用方已经开好的事务里调用。 */
export function proposalFor(db: DatabaseSync, taskId: string, act: unknown): ProposalFact | null {
  const fact = proposalOfAct(act);
  return fact !== null && taskHasStages(db, taskId) ? fact : null;
}

/** 请过目的那张卡片点名的页是不是用户都看过了（现在还在的页里，每一页现在的内容都看过）。一页都没有点名时算没看完。 */
function allViewed(db: DatabaseSync, taskId: string, items: readonly { item_id: string }[]): boolean {
  if (items.length === 0) return false;
  const row = db.prepare("SELECT definition_text FROM task WHERE task_id = ?").get(taskId) as { definition_text: string } | undefined;
  if (!row) return false;
  const viewed = overallState(db, taskId, validateDefinition(JSON.parse(row.definition_text))).viewed;
  const live = items.filter((one) => viewed.has(one.item_id));
  return live.length > 0 && live.every((one) => viewed.get(one.item_id) === true);
}

/**
 * 任务现在开着的提议；没有时为 null。只读。
 * 取最近一条带 proposal 的回复事件：它之后任务的阶段没有移动过、任务还在进行中，它就开着；请过目的那一种另要卡片点名的页还没有都看过。
 * 更早的提议不看：助手发了新的提议卡片，早先的那一条就结束了。
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
    // 回复的正文里碰巧有 "proposal" 这几个字的事件不算：要真有这一项、认得出是哪一种。
    const kind = proposalKindOf(fact);
    if (!fact || kind === null) continue;
    const seq = Number(row.seq);
    const moved = db.prepare("SELECT 1 AS yes FROM event WHERE task_id = ? AND name = ? AND seq > ? LIMIT 1").get(taskId, EVENT_MOVED, seq);
    if (moved) return null;
    const items = Array.isArray(fact.items) ? fact.items : [];
    if (kind === "review" && allViewed(db, taskId, items)) return null;
    return { ...fact, kind, items, stay: fact.stay ?? null, session_id: row.session_id,
      reply_entry: typeof payload?.reply_entry === "string" ? payload.reply_entry : null, event_seq: seq, at: row.at };
  }
  return null;
}

/** 任务没有开着的提议时给助手看的那一句。 */
export const NO_PROPOSAL_LINE = "没有开着的提议。";

/**
 * 给助手看的一行：任务现在有没有开着的提议、是哪一种、卡片在哪条会话里，以及用户要求做这件事时该怎么办。
 * 会话打开时的任务现状说明与查询任务状态的返回都用它：助手换一条会话之后上下文里没有那张卡片，靠这一行知道提议还开着。
 * sessionId 是读的这一侧所在的会话，用来说卡片是不是就在这条会话里。
 */
export function proposalLine(open: OpenProposal | null, sessionId: string | null): string {
  if (open === null) return NO_PROPOSAL_LINE;
  const where = sessionId !== null && open.session_id === sessionId ? "卡片在这条会话里" : "卡片在另一条会话里";
  const pressed = "不要重发同一张卡片，请他点输入框上方「待决定」一行里的按钮";
  if (open.kind === "back") {
    return `开着的提议：退回${STAGE_NAMES[open.stage]}（${where}）。用户还没有决定；他要退回时${pressed}。`;
  }
  if (open.kind === "review") {
    const pages = open.items.map((one) => one.item_id);
    return `开着的提议：请用户过目补写的 ${pages.length} 页${pages.length ? `（${pages.join("、")}）` : ""}（${where}）。用户还没有都看过；他说看过了、要生成文档时${pressed}。`;
  }
  return `开着的提议：进入${STAGE_NAMES[open.stage]}（${where}）。用户还没有进入；他要进入时${pressed}。`;
}
