/**
 * 从任务库里读出总体分析那几样计算要的事实，再交给 lib/overall_analysis.ts 去算：每个条目待不待核实、它是不是因为依据的那一页
 * 而待核实、每一页被哪些地方提到、最低门要看的各页。助手一侧的查看条目、查询任务状态、保存修订的最低门都经这里；
 * 后端的快照从它自己读出的数据里取同样的事实，调的是同一组计算函数，所以两侧口径相同。只读，不写库。
 */

import type { DatabaseSync } from "node:sqlite";
import type { TaskDefinition } from "./definition.ts";
import { ACTOR_USER } from "./db.ts";
import { DIAGRAM_ID, diagramViewed, liveDiagrams, readDiagrams, viewedDiagramRevisions } from "./diagram.ts";
import {
  type BasisPending, type Mention, OVERALL_COLLECTION, type PageFacts, type PlainItem, type RevisionFacts, type SupportPlaces, type Verification,
  basisPending, isSupplement, mentionsOf, pageFacts, verificationOf, viewedIn,
} from "./overall_analysis.ts";
import { ELEMENT_ITEM, SOURCE_FIGURE, SOURCE_ITEM, elementClause } from "./schema.ts";
import { jsonOrText } from "./task_read.ts";

/** 一个条目算出来的两样：待不待核实（还待核实的来源条数与各处）、是不是因为依据的那一页而待核实。 */
export interface ItemVerification extends Verification {
  basis_pending: BasisPending | null;
}

/** 确认标记的依据里表示「用户亲手改」的那个词（judgement.basis 里的「依据」）。 */
const BASIS_EDIT = "界面修改";

export interface OverallState {
  /** 还在的每个条目，按集合里的先后。 */
  items: PlainItem[];
  /** 条目编号 → 它的两样。 */
  verification: Map<string, ItemVerification>;
  /** 被提到的页的编号 → 提到它的各处。任务没有总体分析集合时是空的。 */
  mentions: Map<string, Mention[]>;
  /** 总体分析的各页在最低门里要看的几样。 */
  pages: PageFacts[];
  /** 条目编号 → 用户看没看过它现在的内容（lib/overall_analysis.ts 的 viewedIn）。 */
  viewed: Map<string, boolean>;
  /** 条目编号 → 它当前修订上的各条来源的种类、出处、摘录与它支持哪几处（空列表是支持整个条目），按位置的先后。 */
  sources: Map<string, { kind: string; locator: string; excerpt: string; supports: { field: string; index: number | null }[] }[]>;
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
  // 每个条目当前修订上的来源：一条来源在库里可以占几行（每个支持的地方一行），按位置号归成一条。
  const sourceRows = db.prepare(
    `SELECT s.item_id, s.position, s.kind, s.locator, s.excerpt, s.field, s.field_index FROM item_source s WHERE s.task_id = ?${elementClause(ELEMENT_ITEM, "s.")} ` +
      "AND s.revision_no = (SELECT MAX(revision_no) FROM item_version w WHERE w.task_id = s.task_id AND w.item_id = s.item_id) ORDER BY s.item_id, s.position, s.support_no",
  ).all(taskId) as { item_id: string; position: number; kind: string; locator: string; excerpt: string; field: string | null; field_index: number | null }[];
  const sources = new Map<string, { position: number; kind: string; locator: string; excerpt: string; supports: { field: string; index: number | null }[] }[]>();
  for (const one of sourceRows) {
    const list = sources.get(one.item_id) ?? [];
    let source = list.find((have) => have.position === one.position);
    if (!source) list.push((source = { position: one.position, kind: one.kind, locator: one.locator, excerpt: one.excerpt, supports: [] }));
    if (one.field !== null) source.supports.push({ field: one.field, index: one.field_index });
    sources.set(one.item_id, list);
  }
  // 每个条目的各次修订是不是用户亲手改出来的（记下那次修订的事件的发起方是用户）。
  const versionRows = db.prepare(
    "SELECT v.item_id, v.revision_no, e.actor FROM item_version v LEFT JOIN event e ON e.seq = v.event_seq WHERE v.task_id = ? ORDER BY v.item_id, v.revision_no",
  ).all(taskId) as { item_id: string; revision_no: number; actor: string | null }[];
  // 用户在哪些修订上看过或点过确认：那次修订上依据不是「界面修改」的确认标记里，最近一条的态度是接受。
  const marks = db.prepare(
    "SELECT ji.item_id, ji.revision_no, ji.attitude, j.basis FROM judgement_item ji JOIN judgement j ON j.judgement_id = ji.judgement_id " +
      "WHERE ji.task_id = ? ORDER BY ji.event_seq, ji.judgement_id",
  ).all(taskId) as { item_id: string; revision_no: number; attitude: string; basis: string }[];
  const viewedAt = new Map<string, boolean>();
  for (const mark of marks) {
    const basis = jsonOrText(mark.basis);
    if (Array.isArray(basis) && basis.some((one) => (one as Record<string, unknown> | null)?.["依据"] === BASIS_EDIT)) continue;
    viewedAt.set(`${mark.item_id}\u0000${mark.revision_no}`, mark.attitude === "接受");
  }
  const history = new Map<string, RevisionFacts[]>();
  for (const row of versionRows) {
    const list = history.get(row.item_id) ?? [];
    list.push({ byUser: row.actor === ACTOR_USER, viewed: viewedAt.get(`${row.item_id}\u0000${row.revision_no}`) === true });
    history.set(row.item_id, list);
  }
  const own = new Map<string, Verification>();
  const viewed = new Map<string, boolean>();
  for (const item of items) {
    const supplements: SupportPlaces[] = (sources.get(item.item_id) ?? []).filter((one) => isSupplement(one.kind)).map((one) => one.supports);
    const chain = chainOf(history.get(item.item_id) ?? []);
    own.set(item.item_id, verificationOf(supplements, chain));
    viewed.set(item.item_id, viewedIn(chain));
  }
  const byId = new Map(items.map((one) => [one.item_id, one]));
  const cited = (itemId: string) => {
    const page = byId.get(itemId);
    return page ? { collection: page.collection, fields: page.fields, pending: own.get(itemId)!.pending_verification, viewed: viewed.get(itemId) === true } : null;
  };
  // 条目依据的图用户看没看过：还在的图各自算一次（lib/diagram.ts 的 diagramViewed）；已经删除的图不在里面。
  const seen = viewedDiagramRevisions(db, taskId);
  const figureViewed = new Map(liveDiagrams(readDiagrams(db, taskId)).map((record) => [record.diagram_id, diagramViewed(record, seen)]));
  const citedFigure = (diagramId: string) => (figureViewed.has(diagramId) ? { viewed: figureViewed.get(diagramId)! } : null);
  const verification = new Map<string, ItemVerification>();
  for (const item of items) {
    const basis = basisPending((sources.get(item.item_id) ?? []).filter((one) => one.kind === SOURCE_ITEM || one.kind === SOURCE_FIGURE), cited, citedFigure);
    verification.set(item.item_id, { ...own.get(item.item_id)!, basis_pending: basis });
  }
  const shapes = definition.collections.map((one) => ({ name: one.name, fields: one.fields.map((f) => ({ name: f.name, type: f.type })) }));
  const pages = items.filter((one) => one.collection === OVERALL_COLLECTION)
    .map((one) => pageFacts(one.item_id, one.fields, own.get(one.item_id)!.pending_verification, viewed.get(one.item_id) === true));
  return { items, verification, mentions: mentionsOf(shapes, items), pages, viewed, sources };
}

/** 算待核实要看的那一段修订：从最近一次不是用户亲手改出来的修订起，到当前修订为止。 */
export function chainOf(history: readonly RevisionFacts[]): RevisionFacts[] {
  let from = 0;
  history.forEach((one, n) => {
    if (!one.byUser) from = n;
  });
  return history.slice(from);
}

/** 一个条目待核实时给助手看的几行；不待核实、也不是因依据而待核实时是空的。 */
export function verificationLines(itemId: string, state: ItemVerification): string[] {
  const lines: string[] = [];
  if (state.pending_verification) {
    const where = state.pending_places.map((at) => (at.field === null ? "整个条目" : `「${at.field}」${at.index !== null ? `第 ${at.index + 1} 项` : ""}`)).join("、");
    lines.push(`待核实：${itemId} 有 ${state.pending_sources} 处是助手补充的，用户还没有确认（${where}）。请用户看一下这几处对不对；用户看过确认、或者亲手改过那一处之后，就不再待核实。`);
  }
  const basis = state.basis_pending;
  // 依据的是一张图（编号是 D- 开头的那种）：图只有「用户还没有看过」这一种。
  if (basis && DIAGRAM_ID.test(basis.item_id)) {
    lines.push(`待核实：它依据的图 ${basis.item_id} 用户还没有看过它现在的内容。请用户把这张图看一遍（看过就算确认）。`);
    return lines;
  }
  if (basis?.reason === "pending") lines.push(`待核实：它依据的主题 ${basis.item_id} 还待核实（那一页有助手补充而用户没有确认的内容）。`);
  if (basis?.reason === "unviewed") lines.push(`待核实：它依据的主题 ${basis.item_id} 用户还没有看过。请用户打开那一页看一眼（看过就算确认）。`);
  if (basis?.reason === "deprecated") lines.push(`待核实：它依据的主题 ${basis.item_id} 已废弃${basis.see ? `，改看 ${basis.see}` : ""}；请改成依据现在在用的主题。`);
  return lines;
}

/**
 * 任务里待核实的条目合成的一句；一个都没有时是 null。questions 是问题条目所在的集合：问题条目不列（与写条目阶段
 * 「没有待核实的条目」那盏灯同一条规则，问题条目记的是没定的事，助手补写的来源不让它成为待核实的需求）。
 */
export function pendingSummary(state: OverallState, questions: ReadonlySet<string> = new Set()): string | null {
  const listed = state.items.filter((one) => !questions.has(one.collection));
  const own = listed.filter((one) => state.verification.get(one.item_id)!.pending_verification).map((one) => one.item_id);
  const basisOf = (itemId: string) => state.verification.get(itemId)!.basis_pending;
  const waiting = listed.filter((one) => !own.includes(one.item_id) && basisOf(one.item_id)).map((one) => one.item_id);
  // 因依据而待核实的分两种说：依据的是一页主题，依据的是一张图。
  const byFigure = waiting.filter((id) => DIAGRAM_ID.test(basisOf(id)!.item_id));
  const byBasis = waiting.filter((id) => !byFigure.includes(id));
  if (own.length === 0 && waiting.length === 0) return null;
  const parts = [
    ...(own.length ? [`有助手补充而用户还没有确认的 ${own.length} 个：${own.join("、")}`] : []),
    ...(byBasis.length ? [`依据的主题待核实、用户还没有看过或已废弃的 ${byBasis.length} 个：${byBasis.join("、")}`] : []),
    ...(byFigure.length ? [`依据的图用户还没有看过的 ${byFigure.length} 个：${byFigure.join("、")}`] : []),
  ];
  return `待核实的条目：${parts.join("；")}。`;
}

/** 一页主题被提到的地方给助手看的几行；没有时是空的。 */
export function mentionLines(itemId: string, mentions: readonly Mention[]): string[] {
  if (mentions.length === 0) return [];
  return [`提到它的地方（${mentions.length} 处）：`,
    ...mentions.map((one) => `  ${one.item_id} 的「${one.field}」${one.index !== null ? `第 ${one.index + 1} 项` : ""}：「${one.sentence}」`)];
}
