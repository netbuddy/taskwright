// 修订：一次保存（执行者的一次「保存修订」或用户的一次直接操作）产生一次修订，序号在任务内连续递增。
// 修订日志（GET …/revisions）是这里所有计算的来源；本文件只比较与归拢，不判断内容对不对。
//
//   · 字段修订标识：条目自「上次确认的修订」以来助手改过的字段。
//     上次确认的修订＝最近一条接受记录所在的修订，撤回确认不改变它；从没确认过的条目以它新增的那次修订为基准。
//     多次修订累计、不按次区分；一个字段最后一次是用户在界面上改的，就不算（用户自己改的不标）。
//     用户确认了当前修订，基准移到这次修订，标识消失。
//   · 「刚改」标签：只标执行者最近一次运行改过（修改或恢复）的条目；新增的不标，之后又被用户改过的不标，
//     用户确认了条目当前所在的修订也不再标，撤回确认不让它回来。它不随边框累计：下一次运行开始改别的条目，上一次的「刚改」就不再显示。
//   · 回复的修订标签：一条回复所在的那次工作（work_id）里执行者保存的修订。
//   · 某次修订时交付物里有哪些条目：按日志里的新增、恢复、删除从早到晚推出来，生成文档时用。
//   · 能不能撤销某次修订：它碰到的条目之后都没再被碰过（与后端撤销时的核对同一口径），修订页签据此预先灰化按钮。

import type { AssistantReply, ConversationMessage, Item, RevisionLogEntry, UserMessage } from "../api/types";

/** 上次确认的修订：最近一条接受记录所在的修订；没有接受过时为 null。撤回确认不改变它。 */
export function confirmedRevision(item: Item): number | null {
  const accepted = [...item.confirmations].reverse().find((c) => c.accepted);
  return accepted ? accepted.revision_no : null;
}

/** 字段修订标识的基准：上次确认的修订；从没确认过时是条目新增的那次修订。 */
export function baselineRevision(item: Item): number {
  return confirmedRevision(item) ?? item.revisions[0] ?? item.revision_no;
}

/**
 * 这次修订撤销不了：它碰到的任一条目在之后的修订里又被碰过（日志里出现在更晚的修订、或当前所在的修订号更大），
 * 或者它新增、修改、恢复的条目现在已经删掉了。删除操作撤销时是恢复，条目本来就不在，只看之后有没有再碰过。
 * 后端撤销时照样核对（undo_conflict），这里只是预先告诉用户。
 */
export function undoBlocked(entry: RevisionLogEntry, log: RevisionLogEntry[], liveItems: Item[]): boolean {
  const alive = new Map(liveItems.map((i) => [i.item_id, i.revision_no]));
  const lastTouch = new Map<string, number>();
  for (const r of log) for (const op of r.operations) lastTouch.set(op.item_id, Math.max(lastTouch.get(op.item_id) ?? 0, r.revision_no));
  return entry.operations.some((op) => {
    if ((lastTouch.get(op.item_id) ?? 0) > entry.revision_no) return true;
    if (op.op === "delete") return alive.has(op.item_id);
    const current = alive.get(op.item_id);
    return current == null || current > entry.revision_no;
  });
}

/** 撤销按钮灰化时的说明。 */
export const UNDO_BLOCKED_TEXT = "这次修订碰到的条目之后又改过，不能撤销；要改请直接改条目";

/** 从早到晚排好的日志（接口给的是最新在前）。 */
export function ascending(log: RevisionLogEntry[]): RevisionLogEntry[] {
  return [...log].sort((a, b) => a.revision_no - b.revision_no);
}

/**
 * 条目自基准以来助手改过的字段名，按任务定义里的字段顺序由调用方再排。
 * 逐次看基准之后碰到这个条目的修订，记下每个字段最后一次是谁改的；最后是执行者改的字段才算。
 */
export function markedFields(item: Item, log: RevisionLogEntry[]): string[] {
  const base = baselineRevision(item);
  const lastBy = new Map<string, string>();
  for (const r of ascending(log)) {
    if (r.revision_no <= base || r.revision_no > item.revision_no) continue;
    for (const op of r.operations) {
      if (op.item_id !== item.item_id) continue;
      for (const f of op.fields_changed) lastBy.set(f, r.by);
    }
  }
  return [...lastBy].filter(([, by]) => by === "executor").map(([f]) => f);
}

/** 每个条目的字段修订标识：条目编号 → 标了框的字段（只列有标识的条目）。 */
export function marksByItem(items: Item[], log: RevisionLogEntry[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const item of items) {
    const fields = markedFields(item, log);
    if (fields.length) out[item.item_id] = fields;
  }
  return out;
}

/** 「刚改」的条目：执行者最近一次运行（修订日志里最新那次执行者修订所在的工作）改过、之后没再被改过、也还没确认的条目。 */
export function justChangedItems(items: Item[], log: RevisionLogEntry[]): Set<string> {
  const latest = log.filter((r) => r.by === "executor").sort((a, b) => b.revision_no - a.revision_no)[0];
  if (!latest) return new Set();
  const run = log.filter((r) => r.by === "executor" && (latest.work_id ? r.work_id === latest.work_id : r.revision_no === latest.revision_no));
  const touched = new Map<string, number>();
  for (const r of run) for (const op of r.operations) if (op.op === "update" || op.op === "restore") touched.set(op.item_id, Math.max(touched.get(op.item_id) ?? 0, r.revision_no));
  const out = new Set<string>();
  for (const item of items) {
    const at = touched.get(item.item_id);
    if (at == null || item.revision_no !== at) continue;          // 这次运行之后又被改过（例如用户在界面上改的）
    // 用户确认过这次改出来的内容就不再标；撤回确认也不让它回来（与边框一样）。
    if (item.confirmations.some((c) => c.accepted && c.revision_no === item.revision_no)) continue;
    out.add(item.item_id);
  }
  return out;
}

/** 一条执行者回复带出的修订：同一次工作（work_id）里执行者保存的修订，从小到大。 */
export function revisionsOfReply(reply: AssistantReply, log: RevisionLogEntry[]): number[] {
  if (!reply.work_id) return [];
  return log.filter((r) => r.by === "executor" && r.work_id === reply.work_id).map((r) => r.revision_no).sort((a, b) => a - b);
}

/** 一次修订碰到的条目编号。 */
export function touchedItems(entry: RevisionLogEntry | null | undefined): string[] {
  return entry ? entry.operations.map((op) => op.item_id) : [];
}

/** 修订 revision 时交付物里有哪些条目：条目编号 → {标题, 所属集合}，按新增的先后排。 */
export function aliveAt(log: RevisionLogEntry[], revision: number): Map<string, { title: string; collection: string }> {
  const alive = new Map<string, { title: string; collection: string }>();
  for (const r of ascending(log)) {
    if (r.revision_no > revision) break;
    for (const op of r.operations) {
      if (op.op === "delete") alive.delete(op.item_id);
      else alive.set(op.item_id, { title: op.title, collection: op.collection });
    }
  }
  return alive;
}

/**
 * 修订卡片的副标题：触发这次修订的事。执行者的修订写它回应的那句话（能在当前会话里数出是第几句时写「你的第 k 句话」），
 * 点卡片发出的、界面操作之后发给助手的各有说法；用户的修订写操作名（后端给的「你把 TBD-003 标为先不管」之类）。
 * 执行者的修订对得上触发它的那项用户行为（修订日志的 intent）时，改写「因为你说：<功能的中文名>：<摘要>」。
 */
export function triggerText(entry: RevisionLogEntry, messages: ConversationMessage[]): string {
  const t = entry.trigger;
  if (entry.by === "user") return t.text || "你在界面上直接修改";
  if (entry.intent) return `因为你说：${entry.intent.function_name}：${entry.intent.summary}`;
  if (t.kind === "card_choice") return `回应你点的卡片：${t.text}`;
  if (t.kind === "ui_request") return `回应你在界面上的操作：${t.text}`;
  if (t.kind === "typed" || t.text) {
    const typed = messages.filter((m) => m.type === "user_message" && (m as UserMessage).origin === "typed");
    const k = typed.findIndex((m) => (m as UserMessage).message_id === t.message_id);
    return k >= 0 ? `回应你的第 ${k + 1} 句话：${t.text}` : `回应你说的话：${t.text}`;
  }
  return "助手自己开始的工作";
}

/** 时刻只写到分钟：「21:40」。 */
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
