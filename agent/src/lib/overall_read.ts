/**
 * 从任务库里读出总体分析那几样计算要的事实，再交给 lib/overall_analysis.ts 去算：每个条目待不待核实、它是不是因为依据的那一页
 * 而待核实、每一页被哪些地方提到、最低门要看的各页。助手一侧的查看条目、查询任务状态、保存修订的最低门都经这里；
 * 后端的快照从它自己读出的数据里取同样的事实，调的是同一组计算函数，所以两侧口径相同。只读，不写库。
 */

import type { DatabaseSync } from "node:sqlite";
import type { TaskDefinition } from "./definition.ts";
import {
  type BasisPending, type Mention, OVERALL_COLLECTION, type PageFacts, type PlainItem, basisPending, isSupplement, mentionsOf, pageFacts, pendingVerification,
} from "./overall_analysis.ts";
import { ELEMENT_ITEM, SOURCE_ITEM, elementClause } from "./schema.ts";
import { jsonOrText } from "./task_read.ts";

/** 一个条目算出来的两样：待不待核实（与还待核实的来源条数）、是不是因为依据的那一页而待核实。 */
export interface ItemVerification {
  pending_verification: boolean;
  pending_sources: number;
  basis_pending: BasisPending | null;
}

export interface OverallState {
  /** 还在的每个条目，按集合里的先后。 */
  items: PlainItem[];
  /** 条目编号 → 它的两样。 */
  verification: Map<string, ItemVerification>;
  /** 被提到的页的编号 → 提到它的各处。任务没有总体分析集合时是空的。 */
  mentions: Map<string, Mention[]>;
  /** 总体分析的各页在最低门里要看的几样。 */
  pages: PageFacts[];
}

/** 读出一个任务现在的全部条目并算出上面几样。 */
export function overallState(db: DatabaseSync, taskId: string, definition: TaskDefinition): OverallState {
  const rows = db.prepare(
    "SELECT i.item_id, i.collection, v.revision_no, v.fields FROM item i JOIN item_version v ON v.task_id = i.task_id AND v.item_id = i.item_id " +
      "WHERE i.task_id = ? AND i.deleted_in_revision IS NULL AND v.revision_no = (SELECT MAX(revision_no) FROM item_version w " +
      "WHERE w.task_id = i.task_id AND w.item_id = i.item_id) ORDER BY i.rowid",
  ).all(taskId) as { item_id: string; collection: string; revision_no: number; fields: string }[];
  const items: PlainItem[] = rows.map((row) => ({
    item_id: row.item_id, collection: row.collection, revision_no: Number(row.revision_no), fields: (jsonOrText(row.fields) ?? {}) as Record<string, unknown>,
  }));
  // 每个条目当前修订上的来源：一条来源在库里可以占几行（每个支持的地方一行），按位置号去重。
  const sourceRows = db.prepare(
    `SELECT DISTINCT s.item_id, s.position, s.kind, s.locator FROM item_source s WHERE s.task_id = ?${elementClause(db, ELEMENT_ITEM, "s.")} ` +
      "AND s.revision_no = (SELECT MAX(revision_no) FROM item_version w WHERE w.task_id = s.task_id AND w.item_id = s.item_id) ORDER BY s.item_id, s.position",
  ).all(taskId) as { item_id: string; position: number; kind: string; locator: string }[];
  const sources = new Map<string, { kind: string; locator: string }[]>();
  for (const one of sourceRows) sources.set(one.item_id, [...(sources.get(one.item_id) ?? []), { kind: one.kind, locator: one.locator }]);
  // 用户有没有在条目当前所在的修订上确认过：这个修订上最近一条确认标记的态度是接受。
  const lastAttitude = db.prepare("SELECT attitude FROM judgement_item WHERE task_id = ? AND item_id = ? AND revision_no = ? ORDER BY event_seq DESC, judgement_id DESC LIMIT 1");
  const own = new Map<string, { pending_verification: boolean; pending_sources: number }>();
  for (const item of items) {
    const supplements = (sources.get(item.item_id) ?? []).filter((one) => isSupplement(one.kind)).length;
    const confirmed = (lastAttitude.get(taskId, item.item_id, item.revision_no) as { attitude: string } | undefined)?.attitude === "接受";
    own.set(item.item_id, pendingVerification(supplements, confirmed));
  }
  const byId = new Map(items.map((one) => [one.item_id, one]));
  const cited = (itemId: string) => {
    const page = byId.get(itemId);
    return page ? { collection: page.collection, fields: page.fields, pending: own.get(itemId)!.pending_verification } : null;
  };
  const verification = new Map<string, ItemVerification>();
  for (const item of items) {
    // 早期版本的库里依据另一个条目的来源种类叫「领域说明」，那时没有总体分析，不会指到它的页，所以只看现在的种类名。
    const basis = basisPending((sources.get(item.item_id) ?? []).filter((one) => one.kind === SOURCE_ITEM), cited);
    verification.set(item.item_id, { ...own.get(item.item_id)!, basis_pending: basis });
  }
  const shapes = definition.collections.map((one) => ({ name: one.name, fields: one.fields.map((f) => ({ name: f.name, type: f.type })) }));
  const pages = items.filter((one) => one.collection === OVERALL_COLLECTION).map((one) => pageFacts(one.item_id, one.fields, own.get(one.item_id)!.pending_verification));
  return { items, verification, mentions: mentionsOf(shapes, items), pages };
}

/** 一个条目待核实时给助手看的几行；不待核实、也不是因依据而待核实时是空的。 */
export function verificationLines(itemId: string, state: ItemVerification): string[] {
  const lines: string[] = [];
  if (state.pending_verification) {
    lines.push(`待核实：${itemId} 有 ${state.pending_sources} 处是助手补充的，用户还没有确认。请用户看一下这几处对不对；用户确认或者改过之后就不再待核实。`);
  }
  const basis = state.basis_pending;
  if (basis?.reason === "pending") lines.push(`待核实：它依据的主题 ${basis.item_id} 还待核实（那一页有助手补充而用户没有确认的内容）。`);
  if (basis?.reason === "deprecated") lines.push(`待核实：它依据的主题 ${basis.item_id} 已废弃${basis.see ? `，改看 ${basis.see}` : ""}；请改成依据现在在用的主题。`);
  return lines;
}

/** 任务里待核实的条目合成的一句；一个都没有时是 null。 */
export function pendingSummary(state: OverallState): string | null {
  const own = state.items.filter((one) => state.verification.get(one.item_id)!.pending_verification).map((one) => one.item_id);
  const byBasis = state.items.filter((one) => !own.includes(one.item_id) && state.verification.get(one.item_id)!.basis_pending).map((one) => one.item_id);
  if (own.length === 0 && byBasis.length === 0) return null;
  const parts = [
    ...(own.length ? [`有助手补充而用户还没有确认的 ${own.length} 个：${own.join("、")}`] : []),
    ...(byBasis.length ? [`依据的主题待核实或已废弃的 ${byBasis.length} 个：${byBasis.join("、")}`] : []),
  ];
  return `待核实的条目：${parts.join("；")}。`;
}

/** 一页主题被提到的地方给助手看的几行；没有时是空的。 */
export function mentionLines(itemId: string, mentions: readonly Mention[]): string[] {
  if (mentions.length === 0) return [];
  return [`提到它的地方（${mentions.length} 处）：`,
    ...mentions.map((one) => `  ${one.item_id} 的「${one.field}」${one.index !== null ? `第 ${one.index + 1} 项` : ""}：「${one.sentence}」`)];
}
