/**
 * 评审状态的几样共用查询：规则指纹、一条评审记录算不算在当前规则下、条目在某次修订上有没有生效的保留（豁免）、
 * 一个批次是第几次评审。完成条件、评审的挑选与核对、查询任务状态都用这里，后端（Python）按同样的算法另写一份。
 *
 * 规则指纹：一个集合的规则文件原文，加任务定义里这个集合的「关闭」「升为必选」两项，按固定写法拼成一段文字取 sha256 的前 16 位
 * （rulesHashText）。任务级开关写在库里的任务定义快照（task.definition_text）里，规则文件在任务目录里，所以算当前指纹要给任务目录；
 * 没给任务目录、集合没写评审规矩、规则文件读不到时，当前指纹为空，不按指纹区分评审记录。
 * 早期版本的评审记录没有指纹，也不按指纹区分（算作当前规则下的记录）。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { load } from "./db.ts";

/** 事件名：一次评审（一个批次）结束时记的摘要。 */
export const EVENT_REVIEW_BATCH = "REVIEW_BATCH";

export interface RulesSpec { file: string; off: string[]; promote: string[] }

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : []);

/** 任务定义原文里某个集合的「评审规矩」；没写或形状不对为 null。 */
export function reviewSpecOf(definitionText: string, collection: string): RulesSpec | null {
  const raw = load(definitionText) as Record<string, any> | null;
  const entry = ((raw?.["交付物"]?.["条目集合"] ?? []) as Record<string, any>[]).find((one) => one?.["名称"] === collection);
  const spec = entry?.["评审规矩"];
  if (!spec || typeof spec !== "object" || typeof spec["规则文件"] !== "string") return null;
  return { file: spec["规则文件"], off: strings(spec["关闭"]), promote: strings(spec["升为必选"]) };
}

/** 规则指纹的算法。后端 service/library.py 的 rules_hash_text 与它逐字一致。 */
export function rulesHashText(fileText: string, spec: Pick<RulesSpec, "off" | "promote">): string {
  const text = `${fileText}\n--\n关闭:${spec.off.join(",")}\n升为必选:${spec.promote.join(",")}`;
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** 按任务目录里的规则文件算指纹；文件读不到时为 null。 */
export function rulesHash(workspaceDir: string, spec: RulesSpec): string | null {
  const full = resolve(workspaceDir, spec.file);
  if (!existsSync(full)) return null;
  return rulesHashText(readFileSync(full, "utf-8"), spec);
}

/** 某个集合现在的规则指纹（见文件头）。 */
export function currentRulesHash(db: DatabaseSync, workspaceDir: string | undefined, collection: string): string | null {
  if (!workspaceDir) return null;
  const task = db.prepare("SELECT definition_text FROM task ORDER BY started_at LIMIT 1").get() as { definition_text: string } | undefined;
  const spec = task ? reviewSpecOf(task.definition_text, collection) : null;
  return spec ? rulesHash(workspaceDir, spec) : null;
}

/** 一条评审记录算不算在当前规则下：记录或当前指纹有一边为空时算，否则要相等。 */
export function underCurrentRules(recordHash: string | null | undefined, current: string | null): boolean {
  return !recordHash || !current || recordHash === current;
}

export function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((row) => row.name === column);
}

export interface ReviewRow { review_id: number; verdict: string; batch_id: string | null; rules_hash: string | null; forced: number; call_id: string }

/** 条目在某次修订上的全部评审记录，按先后；只读的旧库缺新列时照样能读（新列读作空）。 */
export function reviewsAt(db: DatabaseSync, taskId: string, itemId: string, revisionNo: number): ReviewRow[] {
  const extra = hasColumn(db, "review", "rules_hash") ? "batch_id, rules_hash, forced" : "NULL AS batch_id, NULL AS rules_hash, 0 AS forced";
  return db.prepare(`SELECT review_id, verdict, call_id, ${extra} FROM review WHERE task_id = ? AND item_id = ? AND revision_no = ? ORDER BY review_id`)
    .all(taskId, itemId, revisionNo) as unknown as ReviewRow[];
}

/** 条目在某次修订、当前规则下的评审记录，按先后。 */
export function currentReviews(db: DatabaseSync, taskId: string, itemId: string, revisionNo: number, current: string | null): ReviewRow[] {
  return reviewsAt(db, taskId, itemId, revisionNo).filter((row) => underCurrentRules(row.rules_hash, current));
}

export interface WaiverRow { waiver_id: number; reason: string | null; source: string; op_id: string; created_at: string }

/** 条目在某次修订上生效的保留（没撤销的最近一条）；没有时为 undefined。 */
export function activeWaiver(db: DatabaseSync, taskId: string, itemId: string, revisionNo: number): WaiverRow | undefined {
  if (!hasTable(db, "review_waiver")) return undefined;
  return db.prepare(
    "SELECT waiver_id, reason, source, op_id, created_at FROM review_waiver WHERE task_id = ? AND item_id = ? AND revision_no = ? AND revoked_at IS NULL ORDER BY waiver_id DESC LIMIT 1",
  ).get(taskId, itemId, revisionNo) as WaiverRow | undefined;
}

/** 一个批次是第几次评审：按 REVIEW_BATCH 事件的先后从 1 数；这个批次还没记摘要时为 null。 */
export function batchNumber(db: DatabaseSync, taskId: string, batchId: string | null): number | null {
  if (!batchId) return null;
  const rows = db.prepare("SELECT call_id FROM event WHERE task_id = ? AND name = ? ORDER BY seq").all(taskId, EVENT_REVIEW_BATCH) as { call_id: string }[];
  const index = rows.findIndex((row) => row.call_id === batchId);
  return index < 0 ? null : index + 1;
}
