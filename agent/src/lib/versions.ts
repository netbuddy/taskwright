/**
 * 版本记录（任务库的 version_record 表，格式版本 8 加的）：读出各版、记下一次发布。
 * 发布一个版本写一行版本记录与一条 VERSION_PUBLISHED 事件，在同一个事务里；文档存档的文件由后端写在任务目录的 versions/v{N}/ 下，
 * 这里只记它们的相对路径。任务一级没有状态，发过几版、最近一版是哪次修订，都从这张表读。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import type { DatabaseSync } from "node:sqlite";
import { ACTOR_EXECUTOR, emit, wallClockText } from "./db.ts";

export const EVENT_VERSION_PUBLISHED = "VERSION_PUBLISHED";

/** 第 N 版的存档放在任务目录里的哪个目录下，与两个文件的名字。 */
export const versionDir = (versionNo: number): string => `versions/v${versionNo}`;
export const ARCHIVED_MARKDOWN = "document.md";
export const ARCHIVED_DOCX = "document.docx";

export interface VersionRecord {
  version_no: number;
  published_at: string;
  /** executor 或 user。 */
  actor: string;
  /** 发布时交付物的整体修订号。 */
  revision_no: number;
  note: string | null;
  /** 存档文件相对任务目录的路径；没有存档为 null。 */
  markdown_path: string | null;
  docx_path: string | null;
  /** 文档里有几张图、其中几张在 Word 里是图片；一张图都没有、或者没有存档时都是 null。 */
  figure_count: number | null;
  figure_pictures: number | null;
  event_seq: number;
}

/** 一版文档里的图：一共几张，其中几张在 Word 里是图片。 */
export interface FigureTally {
  count: number;
  pictures: number;
}

/** 一个任务的全部版本，按版本号从小到大。 */
export function versionRecords(db: DatabaseSync, taskId: string): VersionRecord[] {
  const rows = db.prepare(
    "SELECT version_no, published_at, actor, revision_no, note, markdown_path, docx_path, figure_count, figure_pictures, event_seq FROM version_record WHERE task_id = ? ORDER BY version_no",
  ).all(taskId) as Record<string, unknown>[];
  return rows.map((row) => ({
    version_no: Number(row.version_no), published_at: String(row.published_at), actor: String(row.actor), revision_no: Number(row.revision_no),
    note: row.note === null ? null : String(row.note), markdown_path: row.markdown_path === null ? null : String(row.markdown_path),
    docx_path: row.docx_path === null ? null : String(row.docx_path), figure_count: row.figure_count === null ? null : Number(row.figure_count),
    figure_pictures: row.figure_pictures === null ? null : Number(row.figure_pictures), event_seq: Number(row.event_seq),
  }));
}

/** 发过几版。 */
export function versionCount(db: DatabaseSync, taskId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM version_record WHERE task_id = ?").get(taskId) as { n: number }).n);
}

export interface PublishRecord {
  taskId: string;
  sessionId: string;
  callId: string;
  /** 发起方：助手调用发布工具时是执行者（缺省），页面上的直接操作是用户。 */
  actor?: string;
  /** 发布时交付物的整体修订号。 */
  revisionNo: number;
  note?: string | null;
  markdownPath?: string | null;
  docxPath?: string | null;
  /** 文档里有几张图、其中几张在 Word 里是图片；张数为 0 时两项都记为空。 */
  figures?: FigureTally | null;
  /** 版本号由调用方先定好时给（后端要先按它决定存档的目录）；不给时取下一个。 */
  versionNo?: number;
}

/** 下一个版本号：已有的最大号加 1。 */
export function nextVersionNo(db: DatabaseSync, taskId: string): number {
  return Number((db.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM version_record WHERE task_id = ?").get(taskId) as { n: number }).n);
}

/**
 * 记下一次发布：写一条 VERSION_PUBLISHED 事件（version_no、revision_no、actor、note）与一行版本记录。必须在调用方开好的事务里调用，
 * 好让条件核对、事件与记录一起提交或一起回退。给的版本号已经被占用时报错。返回版本号与事件序号。
 */
export function recordVersion(db: DatabaseSync, record: PublishRecord): { version_no: number; event_seq: number; published_at: string } {
  const versionNo = record.versionNo ?? nextVersionNo(db, record.taskId);
  if (db.prepare("SELECT 1 FROM version_record WHERE version_no = ?").get(versionNo) !== undefined) {
    throw new Error(`第 ${versionNo} 版已经发布过了。`);
  }
  const actor = record.actor ?? ACTOR_EXECUTOR;
  const note = (record.note ?? "").trim() || null;
  const seq = emit(db, {
    taskId: record.taskId, sessionId: record.sessionId, callId: record.callId, name: EVENT_VERSION_PUBLISHED, actor,
    payload: { version_no: versionNo, revision_no: record.revisionNo, actor, note },
  });
  const at = wallClockText();
  const figures = record.figures && record.figures.count > 0 ? record.figures : null;
  db.prepare(`INSERT INTO version_record (version_no, task_id, published_at, actor, revision_no, note, markdown_path, docx_path, figure_count, figure_pictures, event_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(versionNo, record.taskId, at, actor, record.revisionNo, note, record.markdownPath ?? null, record.docxPath ?? null,
    figures ? figures.count : null, figures ? figures.pictures : null, seq);
  return { version_no: versionNo, event_seq: seq, published_at: at };
}
