/**
 * 把 pi 会话文件的条目拼成对话记录。只取当前分支：从最后一个条目沿 parentId 回溯到根。message_id 就是会话条目的编号。
 *
 * - 用户消息 → user_message。文字以「用户说：/」开头的，是后端给用户打的斜杠开头的字加的前缀，显示时去掉前缀；
 *   紧跟在 taskwright-ui-click 自定义消息后面、文字与它记的那句相同的，合成一条 origin 为 card_choice 的用户消息；
 *   紧跟在 taskwright-card-typed 自定义消息后面的，是用户在卡片的文本框里打的字，origin 仍是 typed，标注里写是哪条回复的卡片；
 *   文字与「确认之后通知执行者」的模板相符、并且紧跟在确认的 taskwright-user-edit 后面的，origin 为 ui_request。
 * - 「回复」工具一次成功的调用 → assistant_reply（via_reply_tool 为真，message_id 是那条助手消息的条目编号）；
 *   用户在它之前的那句话回答了哪几张卡片（answers_card）、它的卡片重发的是哪一张（resends_card）另从任务库现算（withCardLinks）；
 *   一段用户消息之后没有成功的回复、只有助手正文的，取这段里最后一条有正文的助手消息，via_reply_tool 为假。
 * - taskwright-user-edit → ui_action_noted；taskwright-task-status → system_note（kind 为 task_status；文字换成页面上的说法，
 *   见 taskStatusDisplayText；另带这条消息的 details，见 taskStatusDisplayDetails）。兜底追加的那句也是 system_note，kind 为 reply_fallback。
 *
 * 每次工作的过程摘要（work_summary）由 work_summary.ts 从同一批条目算，插在这次工作的回复之前（messages）。
 */

import * as clock from "./clock.ts";
import { readTextFile, splitLines } from "./files.ts";
import { isObject, or, truthy } from "./py.ts";
import { isPosition, isStage } from "../../agent/src/lib/stage.ts";
import { textPattern, textPrefix } from "../../agent/src/lib/texts.ts";
import { callFacts, derivedSourceName } from "./library.ts";
import { cardLinks, understandingLines, worksFromEntries } from "./work_summary.ts";

export const SLASH_PREFIX = "用户说：";
export const UI_CLICK = "taskwright-ui-click";
/** 用户在卡片的文本框里打了一句话时，扩展先追加的那条自定义消息的类型（agent/src/lib/dialogue_acts.ts 的 CARD_TYPED_TYPE）。 */
export const CARD_TYPED = "taskwright-card-typed";
/** 页面在卡片的文本框里发话时，卡片标识里 choice 写的固定值；会话记录里这句话的标注的 option_key 也是它。 */
export const CARD_TYPED_KEY = "typed";

/**
 * 用户在卡片的文本框里打的那句话的标注：是哪条回复的卡片。这句话是用户打的字（origin 仍是 typed），不是点了哪个选项，
 * 所以 option_text 为空；页面据 reply_message_id 把那张卡片标成答过。
 */
export function typedAnnotation(details: Record<string, any>, noteId: unknown): Record<string, any> {
  return { reply_message_id: details.reply_entry ?? null, option_key: CARD_TYPED_KEY, option_text: null, click_message_id: noteId ?? null };
}
export const USER_EDIT = "taskwright-user-edit";
export const TASK_STATUS = "taskwright-task-status";
export const REPLY_TOOL = "reply";
/** 卡片上点「这几条都看过了」之后替用户发给执行者的那句话的开头；早期版本是「我已经在界面上确认了：」。 */
export const NOTIFY_PREFIXES = [textPrefix("ui_ops.viewed_notice"), "我已经在界面上确认了："];
/** 会带那句话的直接操作种类：现在是 mark_viewed，早期版本是 confirm。 */
export const NOTIFY_KINDS = ["mark_viewed", "confirm"];
/** 用户在界面上停止了助手一次运行之后留在会话里的那条界面操作通知的种类（agent/src/lib/user_ops.ts 的 STOP_RUN_KIND）。 */
export const STOP_RUN = "stop_run";
/** 用户在提议进入下一个阶段的卡片上选了「继续本阶段」之后留在会话里的那条界面操作通知的种类（agent/src/lib/user_stage.ts 的 CONTINUE_STAGE_KIND）。 */
export const CONTINUE_STAGE = "continue_stage";
/** 「回复」工具的兜底扩展追加的那句固定文字（agent/src/hooks/reply_fallback.ts 的 FALLBACK_TEXT），不是用户说的。 */
export const FALLBACK_TEXT = "请用 reply 工具把要对用户说的话发出来";

export type Entry = Record<string, any>;

/** 回复里的告知一律整理成 {"text", "items"?}：旧会话里一条告知是一句纯文字，新的是带 items 的对象；认不出的丢掉。 */
const isStageKey = (value: unknown): value is string => isStage(value);

/**
 * 「继续本阶段」的那条界面操作通知另带的两项：卡片在哪条回复上（reply_message_id）、卡片提议进入哪个阶段（stage）。
 * details 是那条通知的 details。别的界面操作通知不带，返回空对象。
 */
export function continueStageFields(details: Record<string, any>): { reply_message_id?: string; stage?: string; option_key?: string } {
  if (details.kind !== CONTINUE_STAGE || typeof details.reply_entry !== "string") return {};
  return { reply_message_id: details.reply_entry, ...(isStageKey(details.stage) ? { stage: details.stage } : {}),
    ...(typeof details.option_key === "string" && details.option_key ? { option_key: details.option_key } : {}) };
}

/**
 * 用户在卡片上点了「进入」某个阶段、系统替用户记了移动时，那句「我选：……」带的一项：从哪个阶段、到哪个阶段。
 * details 是那条界面点击标注的 details（助手一侧在记下移动时写进 stage_move）。没有记移动时为 null。
 */
export function clickStageMove(details: Record<string, any>): { from: string; to: string; actor: "user"; how?: string } | null {
  const move = details.stage_move;
  // from 可以是空闲：任务空闲时用户在卡片上点了「开始核读材料」。how 写这次是流程里的移动、启动还是继续首次分析（早先的点击没有这一项）。
  if (!isObject(move) || !isPosition(move.from) || !isStageKey(move.to)) return null;
  return { from: move.from, to: move.to, actor: "user", ...(typeof move.how === "string" && move.how ? { how: move.how } : {}) };
}

/**
 * 用户点了一张「进入」某个阶段的卡片而阶段没有移动时（次序不对，或者任务本来就在那个阶段），那句「我选：……」带的一项：
 * 任务当时在哪个阶段。details 是那条界面点击标注的 details（助手一侧写进 stage_unmoved）。没有这一项时为 null：
 * 记了移动的点击、不是进入阶段的点击、没有阶段的任务、早先版本留下的点击都没有。
 */
export function clickStageUnmoved(details: Record<string, any>): { at: string; why?: string } | null {
  const stay = details.stage_unmoved;
  // at 可以是空闲；why 为 not_in_flow 是这条会话不在做流程的工作项（空闲，或者它的工作项是单项活动），进入与退回不算数。
  if (!isObject(stay) || !isPosition(stay.at)) return null;
  return { at: stay.at, ...(stay.why === "not_in_flow" ? { why: stay.why } : {}) };
}

/**
 * 助手在一条回复里汇报这条会话的工作项（单项活动）做完了时，那条回复带的一项：做完的是哪一项活动。
 * details 是「回复」工具结果的 details（助手一侧核对过这条会话在做单项活动时写进 activity_done）。没有时返回空对象，消息里不带这一项。
 * 汇报做完只是一句话，不改任何记录。
 */
export function replyActivityDone(details: Record<string, any>): { activity_done?: { activity: string } } {
  const done = details.activity_done;
  return isObject(done) && isStageKey(done.activity) ? { activity_done: { activity: done.activity } } : {};
}

export function normalizeInforms(informs: unknown): Record<string, any>[] {
  const out = [];
  for (const one of (or(informs, []) as unknown[])) {
    if (typeof one === "string") out.push({ text: one });
    else if (isObject(one) && typeof one.text === "string") {
      const items = (or(one.items, []) as unknown[]).filter((i) => isObject(i) && truthy(i.item_id));
      out.push({ text: one.text, ...(items.length ? { items } : {}) });
    }
  }
  return out;
}

export function fallbackNoteText(raw: string): string {
  return `助手这次没有用回复工具说话，系统自动提醒了它一句：「${raw}」。这句不是你说的。`;
}

/**
 * 任务现状消息（taskwright-task-status）在页面上的写法。助手看到的原文不动（改它要重跑评测），只在转给页面时换掉写给助手的
 * 说法：开头两种（agent/src/lib/task_status.ts 里开始会话一处、续接两处）换成页面上的开头；「执行者在别的会话里做的」
 * 换成「助手在别的会话里做的」；末尾那一行「还在等回应的执行者行为」是对助手说的，页面上整行不显示。
 * 实时推送（executor.ts）与刷新之后从会话记录读回（baseMessages）都经过这里。认的几处由助手一侧的模板（agent/prompts/runtime/status.md）
 * 转成正则，那边改了说法这里跟着认；页面上换成的说法写在这里，backend/tests/task_status_display.test.ts 核对。
 */
const TASK_STATUS_WORDING: [RegExp, string][] = [
  [new RegExp(`^${textPattern("status.head_now")}`), "这条会话开始时（$1）的任务状况："],
  [new RegExp(`^${textPattern("status.head_changes")}`), "接着这条会话继续时（$1），上次之后交付物的变化："],
  [new RegExp(textPattern("status.change_by_executor"), "g"), "助手在别的会话里做的 $1 次"],
  [new RegExp(`\\n${RegExp.escape(textPrefix("status.open_acts"))}[\\s\\S]*$`), ""],
];

export function taskStatusDisplayText(text: string): string {
  return TASK_STATUS_WORDING.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/** system_note 的两种：任务现状消息，与「回复」工具的兜底扩展追加的那句固定文字。 */
export const NOTE_TASK_STATUS = "task_status";
export const NOTE_REPLY_FALLBACK = "reply_fallback";

/**
 * 任务现状消息的 details 给页面的样子（页面拿它写折叠起来的那一行要点）；不是对象时是 null。照原样给，只动两处：
 * · 去掉 open_acts：那是只写给助手看的「还在等回应的行为」，文字里对应的那一行页面上也不显示；
 * · materials.files 的每一项加 derived_from：由同一清单里哪个文件生成（判法与材料清单相同，见 library.ts 的 derivedSourceName），
 *   不是生成的文件为 null。页面数「几份材料」时只数为 null 的。
 */
export function taskStatusDisplayDetails(details: unknown): Record<string, any> | null {
  if (!isObject(details)) return null;
  const { open_acts: _, ...rest } = details as Record<string, any>;
  const materials = rest.materials;
  if (!isObject(materials) || !Array.isArray(materials.files)) return rest;
  const cut = (path: string) => path.lastIndexOf("/") + 1;
  const paths = materials.files.map((file: unknown) => (isObject(file) && typeof file.path === "string" ? file.path : ""));
  const present = new Set<string>(paths.map((path: string) => path.slice(cut(path))));
  const files = materials.files.map((file: unknown, i: number) => {
    const path = paths[i];
    const source = derivedSourceName(path.slice(cut(path)), present);
    return { ...(isObject(file) ? file : {}), derived_from: source === null ? null : path.slice(0, cut(path)) + source };
  });
  return { ...rest, materials: { ...materials, files } };
}

/** 读会话文件：每行一条 JSON，读不出的行跳过。 */
export function readSessionFile(path: string): Entry[] {
  const out: Entry[] = [];
  for (const line of splitLines(readTextFile(path))) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return out;
}

/** 当前分支上的条目，从根到最后一个条目。 */
export function branch(entries: Entry[]): Entry[] {
  const body = entries.filter((e) => isObject(e) && e.type !== "session" && truthy(e.id));
  if (!body.length) return [];
  const byId = new Map(body.map((e) => [e.id, e]));
  const out: Entry[] = [];
  let cur: Entry | undefined = body[body.length - 1];
  while (cur) {
    out.push(cur);
    cur = byId.get(cur.parentId ?? null);
  }
  return out.reverse();
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (or(content, []) as unknown[]).filter((p) => isObject(p) && p.type === "text").map((p: any) => p.text ?? "").join("");
}

/** 用户打的以斜杠开头的字，后端发给 pi 时前面加了「用户说：」；界面上仍显示原来打的字。 */
export function displayText(raw: string): string {
  return raw.startsWith(SLASH_PREFIX + "/") ? raw.slice(SLASH_PREFIX.length) : raw;
}

/**
 * 当前分支上的对话记录，按先后排。每次工作的过程摘要插在这次工作的回复之前，回复的 work_id 补上。
 * 给了任务目录时，摘要另带 understanding（「理解为」那一行，从任务库读）。
 */
export function messages(entries: Entry[], sessionId: string, definition: Record<string, any> = {}, taskDir: string | null = null): Record<string, any>[] {
  const path = branch(entries);
  return withWorkSummaries(withCardLinks(messagesOfPath(path, sessionId), taskDir, sessionId), path, sessionId, definition, taskDir);
}

/**
 * 给回复补上两项：answers_card（用户在它之前的那句话回答了哪几张卡片）与 resends_card（它的卡片重发的是哪一张），值都是卡片所在回复的编号。
 * 从任务库的对话行为表现算（work_summary.ts 的 cardLinks）；库里查不到时留着从「回复」的结果里取到的值。没有的不带这两项。
 */
export function withCardLinks(out: Record<string, any>[], taskDir: string | null, sessionId: string): Record<string, any>[] {
  const links = cardLinks(taskDir, sessionId);
  if (links.answers.size === 0 && links.resends.size === 0) return out;
  let said: string | null = null;
  for (const m of out) {
    if (m.type === "user_message") said = m.message_id ?? null;
    if (m.type !== "assistant_reply" || !m.via_reply_tool) continue;
    const answered = said !== null ? links.answers.get(said) : undefined;
    if (answered) m.answers_card = answered;
    const resent = links.resends.get(m.message_id);
    if (resent) m.resends_card = resent;
  }
  return out;
}

/** 「回复」的结果里带的两项，写成回复消息上的样子：没有的不带。实时推送与读历史（库里查不到时）都用它。 */
export function replyCardFields(details: Record<string, any>): { answers_card?: string[]; resends_card?: string } {
  const answers = (Array.isArray(details.answers_card) ? details.answers_card : []).filter((one: unknown) => typeof one === "string" && one);
  return { ...(answers.length ? { answers_card: answers } : {}),
    ...(typeof details.resends_card === "string" && details.resends_card ? { resends_card: details.resends_card } : {}) };
}

/**
 * 把从会话条目算出的过程摘要插进对话记录：放在这次工作第一条回复之前；这次工作没有回复时，放在下一句用户的话之前，
 * 被用户停止的那一次放在停止通知之前（实时推送时摘要先到、通知后到，刷新之后次序相同）。
 */
export function withWorkSummaries(out: Record<string, any>[], path: Entry[], sessionId: string, definition: Record<string, any>, taskDir: string | null = null) {
  const understandings = understandingLines(taskDir, sessionId);
  // 给了任务目录时按任务库补上没有结果的调用的事实（保存修订、完成任务是否真的写进了库）。
  for (const work of worksFromEntries(path, definition, FALLBACK_TEXT, textOf, taskDir !== null ? callFacts(taskDir) : null)) {
    const replies = new Set(work.reply_ids);
    for (const m of out) if (m.type === "assistant_reply" && replies.has(m.message_id)) m.work_id = work.work_id;
    const summary = {
      type: "work_summary", session_id: sessionId, message_id: `summary-${work.user_message_id}`, work_id: work.work_id, at: work.at,
      seconds: work.seconds, step_count: work.step_count, stages: work.stages, understanding: understandings.get(work.user_message_id) ?? null,
      outcome: work.outcome, ...(work.saved !== undefined ? { saved: work.saved } : {}),
    };
    const ids = out.map((m) => m.message_id ?? null);
    let first = out.findIndex((m) => m.type === "assistant_reply" && replies.has(m.message_id));
    if (first < 0) {
      const start = ids.includes(work.user_message_id) ? ids.indexOf(work.user_message_id) : out.length - 1;
      first = out.findIndex((m, i) => i > start && (m.type === "user_message" || (m.type === "ui_action_noted" && m.kind === STOP_RUN)));
      if (first < 0) first = out.length;
    }
    out.splice(first, 0, summary);
  }
  return out;
}

/** 当前分支上的对话记录（不带过程摘要），按先后排。 */
export function baseMessages(entries: Entry[], sessionId: string): Record<string, any>[] {
  return messagesOfPath(branch(entries), sessionId);
}

export function messagesOfPath(path: Entry[], sessionId: string): Record<string, any>[] {
  const results = new Map<string, Entry>();
  for (const e of path) {
    if (e.type === "message" && (e.message || {}).role === "toolResult") results.set(e.message.toolCallId ?? "", e.message);
  }
  const out: Record<string, any>[] = [];
  let pendingClick: Entry | null = null;
  let lastConfirm: Entry | null = null;
  let segmentReplied = true;
  let segmentLastText: Record<string, any> | null = null;

  const closeSegment = () => {
    // 一段用户消息之后没有成功的回复：取这段最后一条有正文的助手消息作兜底回复，放回它在分支上的位置。
    if (!segmentReplied && segmentLastText !== null) {
      const { _pos, ...reply } = segmentLastText;
      out.splice(_pos, 0, reply);
    }
    segmentLastText = null;
  };

  for (const e of path) {
    const kind = e.type;
    const at = clock.fromUtcIso(e.timestamp ?? null);
    if (kind === "custom_message") {
      const ctype = e.customType;
      const details = or(e.details, {}) as Record<string, any>;
      if (ctype === UI_CLICK || ctype === CARD_TYPED) pendingClick = e;
      else if (ctype === USER_EDIT) {
        const seqs = or(details.event_seqs, []) as any[];
        out.push({
          type: "ui_action_noted", session_id: sessionId, message_id: e.id, at, text: textOf(e.content ?? null),
          event_seq: seqs.length ? seqs[0] : null, undoable: truthy(details.undoable), op_id: details.op_id ?? null,
          revision_no: details.revision_no ?? null, kind: details.kind ?? null, review: details.review ?? null,
          ...continueStageFields(details),
        });
        lastConfirm = NOTIFY_KINDS.includes(details.kind) ? e : null;
      } else if (ctype === TASK_STATUS) {
        out.push({
          type: "system_note", session_id: sessionId, message_id: e.id, at, kind: NOTE_TASK_STATUS,
          text: taskStatusDisplayText(textOf(e.content ?? null)), details: taskStatusDisplayDetails(e.details ?? null),
        });
      }
      continue;
    }
    if (kind !== "message") continue;
    const m = or(e.message, {}) as Record<string, any>;
    const role = m.role;
    if (role === "user" && textOf(m.content ?? null) === FALLBACK_TEXT) {
      // 兜底追加的那句：不算用户的话，也不结束这一段。
      out.push({ type: "system_note", session_id: sessionId, message_id: e.id, at, kind: NOTE_REPLY_FALLBACK, text: fallbackNoteText(FALLBACK_TEXT) });
      continue;
    }
    if (role === "user") {
      closeSegment();
      segmentReplied = false;
      const raw = textOf(m.content ?? null);
      let origin = "typed";
      let annotation: Record<string, any> | null = null;
      const clickDetails = or((pendingClick || {}).details, {}) as Record<string, any>;
      if (pendingClick !== null && clickDetails.text === raw && pendingClick.customType === CARD_TYPED) {
        // 用户在卡片的文本框里打的字：仍是打的字，只标明写在哪张卡片里。
        annotation = typedAnnotation(clickDetails, pendingClick.id);
      } else if (pendingClick !== null && clickDetails.text === raw) {
        origin = "card_choice";
        annotation = {
          reply_message_id: clickDetails.reply_entry ?? null, option_key: clickDetails.option_key ?? null,
          option_text: clickDetails.option_text ?? null, click_message_id: pendingClick.id,
        };
      } else if (lastConfirm !== null && NOTIFY_PREFIXES.some((p) => raw.startsWith(p))) {
        origin = "ui_request";
      }
      pendingClick = null;
      lastConfirm = null;
      const clickMove = origin === "card_choice" ? clickStageMove(clickDetails) : null;
      const clickUnmoved = origin === "card_choice" ? clickStageUnmoved(clickDetails) : null;
      out.push({ type: "user_message", session_id: sessionId, message_id: e.id, at, text: displayText(raw), origin, annotation, queued: false,
        ...(clickMove ? { stage_move: clickMove } : {}), ...(clickUnmoved ? { stage_unmoved: clickUnmoved } : {}) });
    } else if (role === "assistant") {
      const calls = (or(m.content, []) as unknown[]).filter((p) => isObject(p) && p.type === "toolCall") as Record<string, any>[];
      for (const call of calls) {
        if (call.name !== REPLY_TOOL) continue;
        const result = results.get(call.id ?? null);
        if (result === undefined || truthy(result.isError)) continue;
        let args = or(call.arguments, {}) as Record<string, any>;
        const details = or(result.details, {}) as Record<string, any>;
        if (truthy(details.degraded)) {
          // 连续被拒到上限之后放行的纯文字回复：只取成文正文，不画卡片。
          const reply = or(details.reply, {}) as Record<string, any>;
          args = { informs: [], act: null, text: or(or(reply.text, args.text), "") };
        }
        out.push({
          type: "assistant_reply", session_id: sessionId, message_id: e.id, at, work_id: null, via_reply_tool: true,
          informs: normalizeInforms(args.informs ?? null), act: args.act ?? null, text: or(args.text, ""), degraded: truthy(details.degraded),
          ...replyCardFields(details), ...replyActivityDone(details),
        });
        segmentReplied = true;
      }
      const body = textOf(m.content ?? null).trim();
      if (body && !calls.length) {
        segmentLastText = {
          type: "assistant_reply", session_id: sessionId, message_id: e.id, at, work_id: null, via_reply_tool: false,
          informs: [], act: null, text: body, _pos: out.length,
        };
      }
    }
  }
  closeSegment();
  return out;
}

/** 取一段对话：before 给了就取它之前的 limit 条，否则取最近的 limit 条。 */
export function page(allMessages: Record<string, any>[], before: string | null = null, limit = 100) {
  let items = allMessages;
  if (before) {
    const index = items.findIndex((m) => m.message_id === before);
    if (index >= 0) items = items.slice(0, index);
  }
  const chosen = limit > 0 ? items.slice(-limit) : [];
  return { messages: chosen, has_earlier: items.length > chosen.length, earliest_id: chosen.length ? chosen[0].message_id : null };
}

/**
 * 会话列表里的一行：编号、名字（会话文件里最后一条 session_info 的名字）、开始时刻、最近活动、消息条数。
 * last_active_ms 是最近活动的毫秒数（接口里的 last_active_at 只到秒），判断材料有没有进入对话时用，不给接口。
 */
export function sessionInfo(path: string) {
  const entries = readSessionFile(path);
  const header = entries.find((e) => isObject(e) && e.type === "session") ?? {};
  let name: any = null;
  let last = header.timestamp ?? null;
  let count = 0;
  for (const e of entries) {
    if (!isObject(e)) continue;
    if (e.type === "session_info" && truthy(e.name)) name = e.name;
    if (e.type === "message" || e.type === "custom_message") {
      last = or(e.timestamp, null) ?? last;
      if (e.type === "message" && ["user", "assistant"].includes((or(e.message, {}) as any).role)) count += 1;
    }
  }
  const seconds = clock.parseUtcIso(last);
  return {
    session_id: "id" in header ? header.id : "", name, started_at: clock.fromUtcIso(header.timestamp ?? null),
    last_active_at: clock.fromUtcIso(last), message_count: count, file: path,
    last_active_ms: seconds === null ? null : Math.round(seconds * 1000),
  };
}
