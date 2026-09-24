/**
 * 任务目录数据库：任务数据与事件流都放在任务目录下的 task.sqlite 里，一个任务目录一个库。
 *
 * 本模块做几件小事：给出库文件的位置、把一段读写包进一个立即事务（immediate transaction，开事务时
 * 就抢下写锁，避免两个写入者同时改同一行）、往 event 表写一条事件，以及几样时间与 JSON 的写法。
 * 建表不在这里，在 schema.ts。全部代码里只有本模块的 emit 函数往 event 表写，别处一律不写这张表。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** 任务目录里数据库文件的固定名字。 */
export const DB_NAME = "task.sqlite";

/**
 * 发起方：谁让这次写入发生。执行者经工具的写入记 executor；用户在界面上的直接操作经扩展命令写入，记 user。
 * 取值用英文，与接口里库事件的 actor 字段一致，后端转发时不必翻译。
 * 最早格式的库里发起方写的是「模型」，读取一侧把它当作 executor 的旧写法。
 */
export const ACTOR_EXECUTOR = "executor";
export const ACTOR_USER = "user";
export type Actor = typeof ACTOR_EXECUTOR | typeof ACTOR_USER;
/** 最早格式的库里执行者写入记的发起方。新代码不再写它，只在读取与核对时认它。 */
export const LEGACY_ACTOR_MODEL = "模型";

/** 事件名。每个写入工具各记一种，名字用英文大写，与表名列名一样不用中文。 */
export const EVENT_TASK_CREATED = "TASK_CREATED";
export const EVENT_REVISION_SAVED = "REVISION_SAVED";

/** 一条事件在库里的样子，键名与 event 表的列名一一对应。 */
export interface EventRow {
  taskId: string;
  /** pi 的会话编号，取自 ctx.sessionManager.getSessionId()。 */
  sessionId: string;
  /** pi 给这次工具调用的编号，原样存下；用户的直接操作填后端生成的操作编号（例如 ui-op-13）。 */
  callId: string;
  name: string;
  payload: unknown;
  /** 发起方：谁让这次写入发生。 */
  actor: string;
}

/** 任务目录里库文件的完整路径。库只放在任务目录根目录，不往上级目录找，免得写到别的任务目录的库里。 */
export function databasePath(workspaceDir: string): string {
  return resolve(workspaceDir, DB_NAME);
}

/**
 * 把一段读写放进一个立即事务里：里面全成才提交，中途抛错就整体回退，库里什么也不留。
 * 回调必须是同步的，因为 node:sqlite 的读写接口本身是同步的。
 */
export function inImmediateTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  let result: T;
  try {
    result = body();
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.exec("COMMIT");
  return result;
}

/** 把值编码成库里存的 JSON 文字：中文原样保留，不转成 \\u 转义。 */
export function dump(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

/** 把库里存的 JSON 文字还原成值。列为空时还原成 null。 */
export function load(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}

/** 挂钟时刻（wall clock，人看的当地时间），写成「年-月-日T时:分:秒.毫秒」。 */
export function wallClockText(at: Date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`
  );
}

/**
 * 写一条事件，返回它的全局序号。这是全部代码里唯一往 event 表写的地方。
 * 必须在调用方已经开好的事务里调用，好让事件与它记录的那次数据改动一起提交。
 * 序号取当前最大号加一：事务回退时这一号也跟着作废，所以序号总是连续的。
 */
export function emit(db: DatabaseSync, event: EventRow): number {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM event").get() as { next: number };
  const seq = Number(row.next);
  db.prepare(
    "INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(seq, event.taskId, event.sessionId, event.callId, event.name, dump(event.payload), event.actor, wallClockText());
  return seq;
}
