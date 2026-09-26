/**
 * 把 pi 会话文件的条目拼成对话记录。只取当前分支：从最后一个条目沿 parentId 回溯到根。message_id 就是会话条目的编号。
 *
 * - 用户消息 → user_message。文字以「用户说：/」开头的，是后端给用户打的斜杠开头的字加的前缀，显示时去掉前缀；
 *   紧跟在 taskwright-ui-click 自定义消息后面、文字与它记的那句相同的，合成一条 origin 为 card_choice 的用户消息；
 *   文字与「确认之后通知执行者」的模板相符、并且紧跟在确认的 taskwright-user-edit 后面的，origin 为 ui_request。
 * - 「回复」工具一次成功的调用 → assistant_reply（via_reply_tool 为真，message_id 是那条助手消息的条目编号）；
 *   一段用户消息之后没有成功的回复、只有助手正文的，取这段里最后一条有正文的助手消息，via_reply_tool 为假。
 * - taskwright-user-edit → ui_action_noted；taskwright-task-status → system_note。
 *
 * 每次工作的过程摘要（work_summary）由 work_summary.ts 从同一批条目算，插在这次工作的回复之前（messages）。
 */

import * as clock from "./clock.ts";
import { readTextFile, splitLines } from "./files.ts";
import { isObject, or, truthy } from "./py.ts";
import { understandingLines, worksFromEntries } from "./work_summary.ts";

export const SLASH_PREFIX = "用户说：";
export const UI_CLICK = "taskwright-ui-click";
export const USER_EDIT = "taskwright-user-edit";
export const TASK_STATUS = "taskwright-task-status";
export const REPLY_TOOL = "reply";
/** 卡片上点「这几条都看过了」之后替用户发给执行者的那句话的开头；早期版本是「我已经在界面上确认了：」。 */
export const NOTIFY_PREFIXES = ["我已经看过了：", "我已经在界面上确认了："];
/** 会带那句话的直接操作种类：现在是 mark_viewed，早期版本是 confirm。 */
export const NOTIFY_KINDS = ["mark_viewed", "confirm"];
/** 「回复」工具的兜底扩展追加的那句固定文字（agent/src/hooks/reply_fallback.ts 的 FALLBACK_TEXT），不是用户说的。 */
export const FALLBACK_TEXT = "请用 reply 工具把要对用户说的话发出来";

export type Entry = Record<string, any>;

/** 回复里的告知一律整理成 {"text", "items"?}：旧会话里一条告知是一句纯文字，新的是带 items 的对象；认不出的丢掉。 */
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
  return withWorkSummaries(messagesOfPath(path, sessionId), path, sessionId, definition, taskDir);
}

/** 把从会话条目算出的过程摘要插进对话记录：放在这次工作第一条回复之前；这次工作没有回复时，放在下一句用户的话之前。 */
export function withWorkSummaries(out: Record<string, any>[], path: Entry[], sessionId: string, definition: Record<string, any>, taskDir: string | null = null) {
  const understandings = understandingLines(taskDir, sessionId);
  for (const work of worksFromEntries(path, definition, FALLBACK_TEXT, textOf)) {
    const replies = new Set(work.reply_ids);
    for (const m of out) if (m.type === "assistant_reply" && replies.has(m.message_id)) m.work_id = work.work_id;
    const summary = {
      type: "work_summary", session_id: sessionId, message_id: `summary-${work.user_message_id}`, work_id: work.work_id, at: work.at,
      seconds: work.seconds, step_count: work.step_count, stages: work.stages, understanding: understandings.get(work.user_message_id) ?? null,
    };
    const ids = out.map((m) => m.message_id ?? null);
    let first = out.findIndex((m) => m.type === "assistant_reply" && replies.has(m.message_id));
    if (first < 0) {
      const start = ids.includes(work.user_message_id) ? ids.indexOf(work.user_message_id) : out.length - 1;
      first = out.findIndex((m, i) => i > start && m.type === "user_message");
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
      if (ctype === UI_CLICK) pendingClick = e;
      else if (ctype === USER_EDIT) {
        const seqs = or(details.event_seqs, []) as any[];
        out.push({
          type: "ui_action_noted", session_id: sessionId, message_id: e.id, at, text: textOf(e.content ?? null),
          event_seq: seqs.length ? seqs[0] : null, undoable: truthy(details.undoable), op_id: details.op_id ?? null,
          revision_no: details.revision_no ?? null, kind: details.kind ?? null, review: details.review ?? null,
        });
        lastConfirm = NOTIFY_KINDS.includes(details.kind) ? e : null;
      } else if (ctype === TASK_STATUS) {
        out.push({ type: "system_note", session_id: sessionId, message_id: e.id, at, text: textOf(e.content ?? null) });
      }
      continue;
    }
    if (kind !== "message") continue;
    const m = or(e.message, {}) as Record<string, any>;
    const role = m.role;
    if (role === "user" && textOf(m.content ?? null) === FALLBACK_TEXT) {
      // 兜底追加的那句：不算用户的话，也不结束这一段。
      out.push({ type: "system_note", session_id: sessionId, message_id: e.id, at, text: fallbackNoteText(FALLBACK_TEXT) });
      continue;
    }
    if (role === "user") {
      closeSegment();
      segmentReplied = false;
      const raw = textOf(m.content ?? null);
      let origin = "typed";
      let annotation: Record<string, any> | null = null;
      const clickDetails = or((pendingClick || {}).details, {}) as Record<string, any>;
      if (pendingClick !== null && clickDetails.text === raw) {
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
      out.push({ type: "user_message", session_id: sessionId, message_id: e.id, at, text: displayText(raw), origin, annotation, queued: false });
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

/** 会话列表里的一行：编号、名字（会话文件里最后一条 session_info 的名字）、开始时刻、最近活动、消息条数。 */
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
  return {
    session_id: "id" in header ? header.id : "", name, started_at: clock.fromUtcIso(header.timestamp ?? null),
    last_active_at: clock.fromUtcIso(last), message_count: count, file: path,
  };
}
