// 改动块：同一次工作里助手改了哪些条目、改了什么。
//
// 两条来路，拼出同一种形状：
//   · 实时：工作进行中到达的、发起方是执行者的 deliverable_changed，按当时正在进行的工作（work_id）归到一块；
//     改前的字段取应用事件之前界面上这个条目的样子，改后的取事件里的那一版。
//   · 刷新后重建：整份数据里没有修订列表，就按每个条目的版本历史（GET …/versions）重建：
//     发起方是执行者的每一版按修订序号归成一次修订，修订时刻落在哪次工作的时间范围里就归到哪次工作；
//     对不上任何一次工作的，按修订序号单独成块。改前是这个条目的上一版，改后是这一版。
// 用户直接操作的修订已有 ui_action_noted，不进改动块。
// 只比较、不判断：变了哪些字段由前后两版逐字段比较得出。集合名、字段名都取自任务定义。

import type { AssistantReply, CollectionDef, ConversationMessage, Fields, FieldValue, ItemVersion, Task, UserMessage, WorkSummary } from "../api/types";
import { keepPendingField } from "./items";

export type ChangeOp = "add" | "update" | "delete" | "restore";

export interface ChangeEntry {
  item_id: string;
  collection: string;
  title: string;
  op: ChangeOp;
  version_before: number | null;
  version_after: number | null;
  /** 改前与改后两版的字段；新增时改前为 null，删除时改后为 null。合并同一条目的几次修订时用它们重算。 */
  before: Fields | null;
  after: Fields | null;
}

export interface ChangeBlock {
  /** 块的键：有工作编号时是 work-{work_id}，否则是 rev-{修订序号}。 */
  key: string;
  work_id: string | null;
  revisions: number[];
  /** 这一块里最后一次修订的时刻，用来在对话里排位置。 */
  at: string;
  entries: ChangeEntry[];
}

/** 一个条目在改动块里显示的几样东西：变了哪些字段、状态怎样变、其余改过的文本字段的新值。 */
export interface EntryView {
  fields: string[];
  status: { field: string; before: string; after: string } | null;
  notes: { field: string; value: string }[];
}

const same = (a: FieldValue | undefined, b: FieldValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const text = (v: FieldValue | undefined) => (v == null ? "" : Array.isArray(v) ? v.join("；") : String(v));

/** 前后两版逐字段比较。新增、删除时不列字段；状态字段（取值里有「用户决定保留」的枚举）单列改前改后；
 *  带状态字段的集合（待定事项一类），其余改过的文本字段写出新值，例如处理结果。 */
export function entryView(task: Task | null, entry: ChangeEntry): EntryView {
  const def = task?.definition.collections.find((c) => c.name === entry.collection);
  if (!def || !entry.before || !entry.after) return { fields: [], status: null, notes: [] };
  const statusField = task ? keepPendingField(task, entry.collection) : null;
  const fields = def.fields.filter((f) => !same(entry.before![f.name], entry.after![f.name])).map((f) => f.name);
  const status = statusField && fields.includes(statusField.name)
    ? { field: statusField.name, before: text(entry.before[statusField.name]), after: text(entry.after[statusField.name]) }
    : null;
  const notes = statusField
    ? def.fields.filter((f) => f.type === "文本" && f.name !== statusField.name && fields.includes(f.name) && text(entry.after![f.name]))
      .map((f) => ({ field: f.name, value: text(entry.after![f.name]) }))
    : [];
  return { fields, status, notes };
}

/** 同一块里同一个条目改了几次：合成一条，改前取最早那次的改前，改后取最后那次的改后。 */
export function mergeEntry(earlier: ChangeEntry, later: ChangeEntry): ChangeEntry {
  const op: ChangeOp = earlier.op === "add" ? (later.op === "delete" ? "delete" : "add") : later.op === "delete" ? "delete" : later.op === "restore" ? "restore" : earlier.op === "restore" ? "restore" : "update";
  return { ...later, op, version_before: earlier.version_before, before: earlier.before };
}

export function addToBlocks(blocks: ChangeBlock[], key: string, workId: string | null, revision: number | null, at: string, entries: ChangeEntry[]): ChangeBlock[] {
  const index = blocks.findIndex((b) => b.key === key);
  const base: ChangeBlock = index >= 0 ? blocks[index] : { key, work_id: workId, revisions: [], at, entries: [] };
  const merged = [...base.entries];
  for (const e of entries) {
    const i = merged.findIndex((x) => x.item_id === e.item_id);
    if (i >= 0) merged[i] = mergeEntry(merged[i], e);
    else merged.push(e);
  }
  const block: ChangeBlock = {
    ...base,
    at,
    revisions: revision != null && !base.revisions.includes(revision) ? [...base.revisions, revision] : base.revisions,
    entries: merged,
  };
  return index >= 0 ? blocks.map((b, i) => (i === index ? block : b)) : [...blocks, block];
}

// ───────────── 刷新后重建 ─────────────

/** 一次工作的时间范围。有过程摘要时是 [结束时刻 − 用时, 结束时刻]；没有时从触发它的那句话到这次工作的回复。 */
export interface WorkRange {
  work_id: string;
  start: number;
  end: number;
}

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
/** 时刻比较的宽限：后端记修订时刻与工作起止时刻的时钟不是同一处，差一两秒算同一次工作。 */
const SLACK_MS = 2000;

export function workRanges(messages: ConversationMessage[]): WorkRange[] {
  const ranges = new Map<string, WorkRange>();
  let lastUserAt = NaN;
  for (const m of messages) {
    if (m.type === "user_message") lastUserAt = ms((m as UserMessage).at);
    if (m.type === "work_summary") {
      const s = m as WorkSummary;
      const end = ms(s.at);
      if (!Number.isNaN(end)) ranges.set(s.work_id, { work_id: s.work_id, start: end - (s.seconds ?? 0) * 1000, end });
    }
    if (m.type === "assistant_reply") {
      const r = m as AssistantReply;
      if (!r.work_id || ranges.has(r.work_id)) continue;
      const end = ms(r.at);
      if (!Number.isNaN(end)) ranges.set(r.work_id, { work_id: r.work_id, start: Number.isNaN(lastUserAt) ? end : lastUserAt, end });
    }
  }
  return [...ranges.values()];
}

/** 从各条目的版本历史重建改动块。versions 是「条目编号 → 这个条目的全部版本（按版本号从小到大）」。 */
export function rebuildBlocks(task: Task, versions: Record<string, ItemVersion[]>, messages: ConversationMessage[]): ChangeBlock[] {
  const byRevision = new Map<number, { at: string; entries: ChangeEntry[] }>();
  for (const item of task.items) {
    const list = [...(versions[item.item_id] ?? [])].sort((a, b) => a.version_no - b.version_no);
    list.forEach((v, i) => {
      if (v.by === "user") return;
      const prev = i > 0 ? list[i - 1] : null;
      const slot = byRevision.get(v.revision_no) ?? { at: v.at, entries: [] };
      slot.entries.push({
        item_id: item.item_id, collection: item.collection, title: titleFrom(task, item.collection, v.fields) ?? item.title,
        op: prev ? "update" : "add", version_before: prev?.version_no ?? null, version_after: v.version_no,
        before: prev?.fields ?? null, after: v.fields,
      });
      if (ms(v.at) > ms(slot.at)) slot.at = v.at;
      byRevision.set(v.revision_no, slot);
    });
  }
  const ranges = workRanges(messages);
  let blocks: ChangeBlock[] = [];
  for (const [revision, slot] of [...byRevision].sort((a, b) => a[0] - b[0])) {
    const t = ms(slot.at);
    const work = ranges.find((r) => t >= r.start - SLACK_MS && t <= r.end + SLACK_MS);
    blocks = addToBlocks(blocks, work ? `work-${work.work_id}` : `rev-${revision}`, work?.work_id ?? null, revision, slot.at, slot.entries);
  }
  return blocks;
}

/** 条目的标题：任务定义里这个集合的第一个字段的值（与后端 title_of 同一规则）。 */
export function titleFrom(task: Task, collection: string, fields: Fields | null): string | null {
  const def: CollectionDef | undefined = task.definition.collections.find((c) => c.name === collection);
  const first = def?.fields[0]?.name;
  const v = first && fields ? fields[first] : null;
  if (!v) return null;
  return Array.isArray(v) ? v.join("、") : String(v);
}

// ───────────── 放在对话里的位置 ─────────────

/**
 * 每一块放在对话里哪条消息之前：有工作编号的放在这次工作最后一条回复之前；这次工作没有回复时放在它的过程摘要之后，
 * 也就是下一条消息之前；都找不到的（包括按修订序号单独成块的）按时刻插进去。返回「消息下标 → 放在它之前的块」，
 * 下标等于消息条数的表示放在最后。
 */
export function placeBlocks(blocks: ChangeBlock[], messages: ConversationMessage[]): Map<number, ChangeBlock[]> {
  const out = new Map<number, ChangeBlock[]>();
  const put = (i: number, b: ChangeBlock) => out.set(i, [...(out.get(i) ?? []), b]);
  for (const b of blocks) {
    if (b.work_id) {
      const reply = lastIndex(messages, (m) => m.type === "assistant_reply" && (m as AssistantReply).work_id === b.work_id);
      if (reply >= 0) { put(reply, b); continue; }
      const summary = lastIndex(messages, (m) => m.type === "work_summary" && (m as WorkSummary).work_id === b.work_id);
      if (summary >= 0) { put(summary + 1, b); continue; }
    }
    const t = ms(b.at);
    const after = messages.findIndex((m) => ms((m as { at?: string }).at) > t);
    put(after >= 0 ? after : messages.length, b);
  }
  return out;
}

function lastIndex<T>(list: T[], test: (x: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return i;
  return -1;
}

/**
 * 「刚改过」：最近一块里被修改或恢复的条目编号 → 改后的版本号。新增的条目只在到达时闪一下，不带「刚改」标签：
 * 第一次整理时条目全是新增的，个个都标「刚改」就没有意义了；删掉的条目已经不在列表里。
 */
export function justChanged(blocks: ChangeBlock[]): Record<string, number> {
  const last = [...blocks].sort((a, b) => ms(a.at) - ms(b.at)).pop();
  if (!last) return {};
  return Object.fromEntries(last.entries.filter((e) => (e.op === "update" || e.op === "restore") && e.version_after != null).map((e) => [e.item_id, e.version_after!]));
}
