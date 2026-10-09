/**
 * 给一个任务换编号：把任务库里每张表的 task_id 从原来的编号改成新的。只给数据包的导入用（backend/src/data_pack.ts）：
 * 导入的任务与目标数据目录里已有的任务编号相同、用户又选了「改编号导入」时，在它进到任务根目录之前先换成一个新编号。
 *
 * 任务库的十六张表每一张都有 task_id 一列，表与表之间没有外键约束，一个库里只有一个任务，所以逐张表改就是全部。
 * 整个改动在一个立即事务里：有一张表没有改成，全部回退，库原样不动。
 *
 * 不改的地方：事件表里各条事件的内容（payload）。建任务的那条事件的内容里记着当时的编号，那是当时的记录，读的一方
 * 也不从那里取编号（都取 task_id 这一列）。
 */

import type { DatabaseSync } from "node:sqlite";
import { TASK_ID_PATTERN } from "./create_task.ts";
import { TABLE_NAMES, withTaskDatabase } from "./schema.ts";

/**
 * 把 workspaceDir 这个任务目录的库里的任务编号改成 newId，返回原来的编号、新编号与改了多少行。
 * 新编号的写法不对、库里没有任务、库里的任务不止一个时抛错；库文件不存在抛 NoDatabaseYet，比这个程序新抛 NewerTaskDatabase，
 * 都不改任何东西。原来的编号与新编号相同时什么都不改，rows 是 0。
 */
export function renumberTask(workspaceDir: string, newId: string): { from: string; to: string; rows: number } {
  if (!TASK_ID_PATTERN.test(newId)) throw new Error(`任务编号「${newId}」的写法不对：要以 TASK- 开头，后面只用大写字母、数字与短横线。`);
  return withTaskDatabase(workspaceDir, { createIfMissing: false }, (db: DatabaseSync) => {
    const tasks = db.prepare("SELECT task_id FROM task").all() as { task_id: string }[];
    if (tasks.length !== 1) throw new Error(tasks.length === 0 ? "这个任务目录的库里没有任务。" : "这个任务目录的库里不止一个任务，不能换编号。");
    const from = tasks[0].task_id;
    if (from === newId) return { from, to: newId, rows: 0 };
    let rows = 0;
    for (const table of TABLE_NAMES) {
      rows += Number(db.prepare(`UPDATE ${table} SET task_id = ? WHERE task_id = ?`).run(newId, from).changes);
    }
    return { from, to: newId, rows };
  });
}
