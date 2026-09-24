/**
 * 完成条件：一套固定的条件名，每个条件名对应一个查库的事实核对函数。
 *
 * 任务定义的「完成条件」一节按集合写条件名；观测台的完成条件清单、执行者的查询工具、「完成任务」
 * 工具的门禁三处都读同一份定义、调用这里同一组函数。函数只查库里的事实，不评判内容好坏。
 *
 * 「评审通过」「用户确认」不单独存成条目的状态字段，每次用查询得出：评审表里有一条针对条目当前版本、
 * 结论为合规的记录，就是评审通过；判读明细表里有一条针对条目当前版本、态度为接受的记录，就是用户确认。
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

/** 核对函数的签名：给库、任务编号与集合名，返回核对结果。 */
export type ConditionCheck = (db: DatabaseSync, taskId: string, collection: string) => ConditionResult;

interface CurrentItem {
  item_id: string;
  version_no: number;
  fields: string;
}

/** 某个集合里现在还在的每个条目，连同它的当前版本（最新一版）。 */
export function currentItems(db: DatabaseSync, taskId: string, collection: string): CurrentItem[] {
  return db
    .prepare(
      "SELECT i.item_id, v.version_no, v.fields FROM item i " +
        "JOIN item_version v ON v.task_id = i.task_id AND v.item_id = i.item_id " +
        "WHERE i.task_id = ? AND i.collection = ? AND i.deleted_in_revision IS NULL " +
        "AND v.version_no = (SELECT MAX(version_no) FROM item_version w " +
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
    .map((row) => ({ item: row.item_id, reason: `条目 ${row.item_id} 第 ${row.version_no} 版的状态是「未解决」。` }));
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

function everyReviewed(db: DatabaseSync, taskId: string, collection: string): ConditionResult {
  const passed = db.prepare(
    "SELECT 1 FROM review WHERE task_id = ? AND item_id = ? AND version_no = ? AND verdict = '合规' LIMIT 1",
  );
  const unmet = currentItems(db, taskId, collection)
    .filter((row) => passed.get(taskId, row.item_id, row.version_no) === undefined)
    .map((row) => ({ item: row.item_id, reason: `条目 ${row.item_id} 的当前版本第 ${row.version_no} 版还没有评审通过的记录。` }));
  return {
    condition: "每个条目评审通过",
    collection,
    satisfied: unmet.length === 0,
    summary:
      unmet.length === 0
        ? `每个条目的当前版本都有评审通过的记录。`
        : `有 ${unmet.length} 个条目的当前版本还没有评审通过的记录。`,
    unmet,
  };
}

function everyConfirmed(db: DatabaseSync, taskId: string, collection: string): ConditionResult {
  // 看这一版最近的一条态度记录：用户确认之后又在界面上撤回确认（记一条「不接受」），就不再算确认。
  const latest = db.prepare(
    "SELECT attitude FROM judgement_item WHERE task_id = ? AND item_id = ? AND version_no = ? " +
      "ORDER BY judgement_id DESC LIMIT 1",
  );
  const unmet = currentItems(db, taskId, collection)
    .filter((row) => (latest.get(taskId, row.item_id, row.version_no) as { attitude?: string } | undefined)?.attitude !== "接受")
    .map((row) => ({ item: row.item_id, reason: `条目 ${row.item_id} 的当前版本第 ${row.version_no} 版还没有用户接受的记录。` }));
  return {
    condition: "每个条目用户确认",
    collection,
    satisfied: unmet.length === 0,
    summary:
      unmet.length === 0
        ? `每个条目的当前版本都有用户接受的记录。`
        : `有 ${unmet.length} 个条目的当前版本还没有用户接受的记录。`,
    unmet,
  };
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
): ConditionResult[] {
  const results: ConditionResult[] = [];
  for (const [collection, names] of Object.entries(completion)) {
    const empty = currentItems(db, taskId, collection).length === 0;
    for (const name of names) {
      const result = CONDITIONS[name](db, taskId, collection);
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
