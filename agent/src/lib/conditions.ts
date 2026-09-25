/**
 * 完成条件：一套固定的条件名，每个条件名对应一个查库的事实核对函数。
 *
 * 任务定义的「完成条件」一节按集合写条件名；观测台的完成条件清单、执行者的查询工具、「完成任务」
 * 工具的门禁三处都读同一份定义、调用这里同一组函数。函数只查库里的事实，不评判内容好坏。
 *
 * 「评审通过」「用户确认」不单独存成条目的状态字段，每次用查询得出：评审表里有一条针对条目当前所在修订、
 * 结论为合规的记录，就是评审通过；确认标记表（judgement_item）里这个条目在任何一次修订上有过一条接受的标记，
 * 就是用户确认——依据可以是已读（用户打开过详情）、界面修改（用户亲手改的）或早期版本的其他依据，任一种都算。
 * 从来没有这样一条标记的条目叫「未读」：用户从没看过这个条目。已读是条目级、单向的：看过一次就一直是已读，
 * 执行者后来又改出新修订也不翻回未读（「改过、用户还没看」只在界面上提示，不挡完成）。
 * 评审是挂在「条目加修订」上的标记，条目在后来的修订里又被改过，旧的评审就不再作数；确认标记在库里同样
 * 挂在「条目加修订」上（导出文档时据此如实写用户最后看过哪次修订），但门禁只问有没有看过。
 *
 * 每项结果有三种状态：已满足（met）、还差（unmet）、暂无条目（empty）。集合里一个条目都没有时，
 * 「每个条目……」「没有……的条目」这类条件无从谈起，记为暂无条目；它在门禁上仍算满足（satisfied 为真），
 * 允许为空的集合照旧可以为空，但对人和执行者报告时不算作「已满足」，免得空交付物显得接近完成。
 * 「至少一个条目」在集合为空时是还差，不是暂无条目。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import type { DatabaseSync } from "node:sqlite";
import { load } from "./db.ts";
import { titleOf } from "./tool_render.ts";
import { activeWaiver, currentRulesHash, currentReviews } from "./review_state.ts";
import { SOURCE_DOMAIN_NOTE } from "./schema.ts";

/** 一项条件的三种状态：已满足、还差、暂无条目（集合为空，这一条无从谈起）。 */
export type ConditionState = "met" | "unmet" | "empty";

/** 一个条件核对下来的结果。unmet 列出不满足的条目编号与原因，满足时为空列表。 */
export interface ConditionResult {
  condition: string;
  collection: string;
  /** 门禁用：暂无条目也算满足。 */
  satisfied: boolean;
  /** 报告用：见文件头的说明。由 checkCompletion 填写。 */
  state?: ConditionState;
  /** 一句完整的中文，说明现状。 */
  summary: string;
  unmet: { item: string | null; reason: string }[];
}

/**
 * 核对时可以多给的上下文。workspaceDir（任务目录）用来算规则指纹：给了，评审一条只认当前规则下的评审记录；
 * 没给（例如只拿到库的调用方），不按指纹区分。
 */
export interface CheckContext { workspaceDir?: string }

/** 核对函数的签名：给库、任务编号与集合名，返回核对结果。 */
export type ConditionCheck = (db: DatabaseSync, taskId: string, collection: string, ctx?: CheckContext) => ConditionResult;

interface CurrentItem {
  item_id: string;
  /** 条目当前所在的修订：它最近一次被新增、修改或恢复的那次修订。 */
  revision_no: number;
  fields: string;
}

/** 某个集合里现在还在的每个条目，连同它在当前所在修订下的内容。 */
export function currentItems(db: DatabaseSync, taskId: string, collection: string): CurrentItem[] {
  return db
    .prepare(
      "SELECT i.item_id, v.revision_no, v.fields FROM item i " +
        "JOIN item_version v ON v.task_id = i.task_id AND v.item_id = i.item_id " +
        "WHERE i.task_id = ? AND i.collection = ? AND i.deleted_in_revision IS NULL " +
        "AND v.revision_no = (SELECT MAX(revision_no) FROM item_version w " +
        "WHERE w.task_id = i.task_id AND w.item_id = i.item_id) ORDER BY i.serial",
    )
    .all(taskId, collection) as unknown as CurrentItem[];
}

function atLeastOne(db: DatabaseSync, taskId: string, collection: string): ConditionResult {
  const count = currentItems(db, taskId, collection).length;
  return {
    condition: "至少一个条目",
    collection,
    satisfied: count >= 1,
    summary: count >= 1 ? `现在有 ${count} 个条目。` : `现在一个条目也没有。`,
    unmet: count >= 1 ? [] : [{ item: null, reason: `至少要有一个条目。` }],
  };
}

function noUnresolved(db: DatabaseSync, taskId: string, collection: string): ConditionResult {
  const unmet = currentItems(db, taskId, collection)
    .filter((row) => (load(row.fields) as Record<string, unknown>)["状态"] === "未解决")
    .map((row) => ({ item: row.item_id, reason: `条目 ${row.item_id}（修订 ${row.revision_no}）的状态是「未解决」。` }));
  return {
    condition: "没有状态为未解决的条目",
    collection,
    satisfied: unmet.length === 0,
    summary:
      unmet.length === 0
        ? `没有状态为未解决的条目。`
        : `还有 ${unmet.length} 个状态为未解决的条目。`,
    unmet,
  };
}

/** 一组条目编号的说法：不多于 listAtMost 个时逐个列出，多了只写个数。 */
function idsPhrase(ids: string[], listAtMost = 6): string {
  return ids.length <= listAtMost ? ids.join("、") : `${ids.length} 个条目`;
}

/**
 * 每个条目评审通过：条目当前所在的修订上，有一条当前规则下的合规记录，或者有一条生效的保留（用户保留了评审不合规的写法）。
 * 说明句分三类写：还没评审（当前修订在当前规则下没有评审记录）、评审不合规、评审不合规但你保留了（第三类计入满足，只是提示），
 * 例如「UC-004、UC-005 还没评审；UC-006 评审不合规；UC-003 评审不合规但你保留了。」条目改出新修订之后，旧修订上的保留不再作数。
 */
function everyReviewed(db: DatabaseSync, taskId: string, collection: string, ctx: CheckContext = {}): ConditionResult {
  const current = currentRulesHash(db, ctx.workspaceDir, collection);
  const pending: string[] = [];
  const failed: string[] = [];
  const kept: string[] = [];
  const unmet: ConditionResult["unmet"] = [];
  for (const row of currentItems(db, taskId, collection)) {
    const verdicts = currentReviews(db, taskId, row.item_id, row.revision_no, current).map((r) => r.verdict);
    if (verdicts.includes("合规")) continue;
    if (activeWaiver(db, taskId, row.item_id, row.revision_no)) {
      kept.push(row.item_id);
      continue;
    }
    if (verdicts.length === 0) {
      pending.push(row.item_id);
      unmet.push({ item: row.item_id, reason: `条目 ${row.item_id} 在当前所在的修订 ${row.revision_no} 还没评审。` });
    } else {
      failed.push(row.item_id);
      unmet.push({ item: row.item_id, reason: `条目 ${row.item_id} 在当前所在的修订 ${row.revision_no} 评审不合规。` });
    }
  }
  const parts = [
    ...(pending.length ? [`${idsPhrase(pending)} 还没评审`] : []),
    ...(failed.length ? [`${idsPhrase(failed)} 评审不合规`] : []),
    ...(kept.length ? [`${idsPhrase(kept)} 评审不合规但你保留了`] : []),
  ];
  return {
    condition: "每个条目评审通过",
    collection,
    satisfied: unmet.length === 0,
    summary: unmet.length === 0
      ? (kept.length ? `每个条目都评审通过，或由你保留了写法（${idsPhrase(kept)} 评审不合规但你保留了，按你的决定算通过）。` : `每个条目在当前所在的修订都有评审通过的记录。`)
      : `${parts.join("；")}。`,
    unmet,
  };
}

/** 条目有没有被用户看过：在任何一次修订上有过一条接受的确认标记。 */
export function everViewedStatement(db: DatabaseSync) {
  return db.prepare("SELECT 1 FROM judgement_item WHERE task_id = ? AND item_id = ? AND attitude = '接受' LIMIT 1");
}

function everyConfirmed(db: DatabaseSync, taskId: string, collection: string): ConditionResult {
  // 条目级、单向：在任何一次修订上有过接受的标记就算看过，之后再改也不翻回未读。
  const viewed = everViewedStatement(db);
  const unmet = currentItems(db, taskId, collection)
    .filter((row) => viewed.get(taskId, row.item_id) === undefined)
    .map((row) => ({ item: row.item_id, reason: `条目 ${row.item_id} 用户还没看过这个条目（未读）。` }));
  return {
    condition: "每个条目用户确认",
    collection,
    satisfied: unmet.length === 0,
    summary:
      unmet.length === 0
        ? `每个条目用户都看过，没有未读的条目。`
        : `有 ${unmet.length} 个条目用户还没看过这个条目（未读）。`,
    unmet,
  };
}

/** 「每个条目用户确认」这个条件名。未读清单只看完成条件里要求它的那些集合。 */
export const CONFIRM_CONDITION = "每个条目用户确认";

/** 一个未读条目：用户从没看过这个条目。 */
export interface UnreadItem {
  item_id: string;
  collection: string;
  revision_no: number;
  title: string;
}

/**
 * 未读清单：完成条件里要求「每个条目用户确认」的集合里，从来没有过接受标记的条目，按集合与流水号排。
 * 查询任务状态、完成任务的拒绝文字与后端的整份数据都用它（后端按同一规则在 Python 里算）。
 */
export function unreadItems(db: DatabaseSync, taskId: string, completion: Record<string, string[]>, titleField: (collection: string) => string | undefined): UnreadItem[] {
  const out: UnreadItem[] = [];
  for (const [collection, names] of Object.entries(completion)) {
    if (!names.includes(CONFIRM_CONDITION)) continue;
    const unmet = new Set(everyConfirmed(db, taskId, collection).unmet.map((u) => u.item));
    for (const row of currentItems(db, taskId, collection)) {
      if (!unmet.has(row.item_id)) continue;
      out.push({ item_id: row.item_id, collection, revision_no: row.revision_no, title: titleOf(load(row.fields) as Record<string, unknown>, titleField(collection)) });
    }
  }
  return out;
}

/** 未读清单的一句话写法：「UC-001「借阅图书」、UC-002「归还图书」」。 */
export function unreadList(items: UnreadItem[]): string {
  return items.map((one) => `${one.item_id}${one.title ? `「${one.title}」` : ""}`).join("、");
}

/** 条件名到核对函数的登记表。任务定义里只能用这里登记过的条件名。 */
export const CONDITIONS: Record<string, ConditionCheck> = {
  至少一个条目: atLeastOne,
  没有状态为未解决的条目: noUnresolved,
  每个条目评审通过: everyReviewed,
  每个条目用户确认: everyConfirmed,
};

export const CONDITION_NAMES: string[] = Object.keys(CONDITIONS);

/** 集合为空时说明句的写法。 */
export const EMPTY_SUMMARY = "这个集合现在没有条目，这一条暂不需要核对。";

/** 按任务定义的「完成条件」逐项核对，返回每一项的结果（带三种状态之一）。 */
export function checkCompletion(
  db: DatabaseSync,
  taskId: string,
  completion: Record<string, string[]>,
  ctx: CheckContext = {},
): ConditionResult[] {
  const results: ConditionResult[] = [];
  for (const [collection, names] of Object.entries(completion)) {
    const empty = currentItems(db, taskId, collection).length === 0;
    for (const name of names) {
      const result = CONDITIONS[name](db, taskId, collection, ctx);
      if (empty && name !== "至少一个条目") {
        results.push({ ...result, satisfied: true, state: "empty", summary: EMPTY_SUMMARY, unmet: [] });
      } else {
        results.push({ ...result, state: result.satisfied ? "met" : "unmet" });
      }
    }
  }
  return results;
}

/** 还差的几项里每项的名字，例如「功能用例每个条目用户确认（还差 UC-001、UC-002）」；条目多于 listAtMost 个时不逐个列出。 */
function unmetPhrase(r: ConditionResult, listAtMost: number): string {
  const items = r.unmet.map((u) => u.item).filter((item): item is string => item !== null);
  if (r.condition === "至少一个条目") return `${r.collection}至少要有一个条目`;
  const list = items.length === 0 ? "" : items.length <= listAtMost ? `（还差 ${items.join("、")}）` : `（还差 ${items.length} 个）`;
  return `${r.collection}${r.condition}${list}`;
}

/**
 * 完成条件的一句话概括，任务现状消息、查询任务状态、看板共用这一种说法：
 * 还差时写「要完成任务，还差 N 项：……。」；都满足时写「完成条件都已满足，可以完成任务。」；
 * 有暂无条目的集合时再补一句「……现在没有条目，这几个集合的条件暂不需要核对。」（这句只在有条目的交付物里写，
 * 空交付物已经说过「还没有任何条目」）。
 */
export function completionBrief(results: ConditionResult[], listAtMost = 6): string {
  const unmet = results.filter((r) => r.state === "unmet");
  const head = unmet.length === 0
    ? "完成条件都已满足，可以完成任务。"
    : `要完成任务，还差 ${unmet.length} 项：${unmet.map((r) => unmetPhrase(r, listAtMost)).join("；")}。`;
  const emptyCollections = [...new Set(results.filter((r) => r.state === "empty").map((r) => r.collection))];
  const anyItems = results.some((r) => r.state !== "empty" && !(r.condition === "至少一个条目" && r.state === "unmet"));
  const tail = emptyCollections.length > 0 && anyItems
    ? `${emptyCollections.join("、")}现在没有条目，这几个集合的条件暂不需要核对。`
    : "";
  return head + tail;
}

// ───────────── 提示（不是门禁） ─────────────

/**
 * 完成条件之外的提示：由事实算出来给人看，不挡完成任务。现在只有一种 unlinked_domain_notes：
 * 「领域说明」集合里还没有和任何条目关联的说明。
 */
export interface CompletionHint {
  kind: "unlinked_domain_notes";
  collection: string;
  /** 涉及的条目编号，按流水号排。 */
  items: string[];
  /** 一句完整的中文，例如「有 2 条领域说明还没有和任何条目关联：DN-003、DN-004。」 */
  summary: string;
}

/** 任务定义快照里每个集合的条目引用字段名；读不出来时为空。 */
function itemRefFields(db: DatabaseSync, taskId: string): Map<string, string[]> {
  const row = db.prepare("SELECT definition_text FROM task WHERE task_id = ?").get(taskId) as { definition_text: string } | undefined;
  const out = new Map<string, string[]>();
  try {
    const raw = JSON.parse(row?.definition_text ?? "{}");
    for (const one of raw?.交付物?.条目集合 ?? []) {
      out.set(String(one.名称), (one.字段 ?? []).filter((f: any) => f?.类型 === "条目引用").map((f: any) => String(f.名)));
    }
  } catch {
    // 快照读不出来：只按来源表算。
  }
  return out;
}

/**
 * 还没有和任何条目关联的领域说明。一条领域说明只要有下面任一种联系就算关联了，只看还没删除的条目、只看它们的当前修订：
 * （a）别的条目的来源里有种类为「领域说明」、出处是它的；（b）别的条目的条目引用字段（例如问题的「关联条目」）写了它；
 * （c）它自己的条目引用字段指向了一个还没删除的别的条目。联系是哪一边写的只是哪一边有字段的产物，所以三种都算。
 * 任务没有「领域说明」集合、或者这个集合没有条目时返回空列表。
 */
export function unlinkedDomainNotes(db: DatabaseSync, taskId: string): string[] {
  const notes = currentItems(db, taskId, SOURCE_DOMAIN_NOTE);
  if (notes.length === 0) return [];
  const refFields = itemRefFields(db, taskId);
  const alive = db.prepare(
    "SELECT i.item_id, i.collection, v.revision_no, v.fields FROM item i JOIN item_version v ON v.task_id = i.task_id AND v.item_id = i.item_id " +
      "WHERE i.task_id = ? AND i.deleted_in_revision IS NULL AND v.revision_no = (SELECT MAX(revision_no) FROM item_version w " +
      "WHERE w.task_id = i.task_id AND w.item_id = i.item_id)",
  ).all(taskId) as { item_id: string; collection: string; revision_no: number; fields: string }[];
  const aliveIds = new Set(alive.map((row) => row.item_id));
  const refsOf = (row: { collection: string; fields: string }): string[] => {
    const fields = load(row.fields) as Record<string, unknown>;
    return (refFields.get(row.collection) ?? []).flatMap((name) => (Array.isArray(fields[name]) ? fields[name] as unknown[] : [])).map(String);
  };
  const cited = db.prepare(
    "SELECT DISTINCT s.item_id, s.locator FROM item_source s WHERE s.task_id = ? AND s.kind = ? AND s.revision_no = (SELECT MAX(revision_no) " +
      "FROM item_version w WHERE w.task_id = s.task_id AND w.item_id = s.item_id)",
  ).all(taskId, SOURCE_DOMAIN_NOTE) as { item_id: string; locator: string }[];
  const linked = new Set<string>();
  for (const one of cited) if (aliveIds.has(one.item_id) && one.item_id !== one.locator) linked.add(one.locator);
  for (const row of alive) {
    const refs = refsOf(row).filter((id) => id !== row.item_id);
    for (const id of refs) linked.add(id);
    if (row.collection === SOURCE_DOMAIN_NOTE && refs.some((id) => aliveIds.has(id))) linked.add(row.item_id);
  }
  return notes.map((row) => row.item_id).filter((id) => !linked.has(id));
}

/** 完成条件面板另列的提示。完成条件里有「领域说明」集合时才算未关联的领域说明。 */
export function completionHints(db: DatabaseSync, taskId: string, completion: Record<string, string[]>): CompletionHint[] {
  if (!(SOURCE_DOMAIN_NOTE in completion)) return [];
  const items = unlinkedDomainNotes(db, taskId);
  if (items.length === 0) return [];
  return [{
    kind: "unlinked_domain_notes",
    collection: SOURCE_DOMAIN_NOTE,
    items,
    summary: `有 ${items.length} 条领域说明还没有和任何条目关联：${idsPhrase(items)}。`,
  }];
}
