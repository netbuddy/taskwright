/**
 * 任务目录里的 task.json：这个任务是哪个产品版本建的、哪种任务类型的第几版说明、属主、建立时刻，以及最近一次数据升级是哪个产品版本
 * 在什么时候做的。建任务时写，数据升级时补写（上一版建的任务没有这个文件）。
 *
 * 它是给程序读的小文件，键用英文小写（与占用标记 service.lock 一样）。任务库里记的是任务的内容，这里记的是「谁写了这份数据」：
 * 旧版本的程序遇到更新的数据要拒绝并说出是哪个版本写的，就读这里；任务页比较任务类型说明的版本，也读这里。
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_JSON } from "../../agent/src/lib/schema.ts";

export interface TaskJson {
  /** 建这个任务的产品版本；上一版建的任务不知道，是 null。 */
  created_by_version: string | null;
  /** 任务类型的名字（task-types/ 下的目录名）。 */
  task_type: string | null;
  /** 建任务时复制进任务目录的任务类型说明是第几版；那时的定义没有写版本就是 null。 */
  task_type_version: number | null;
  /** 属主；现在只有单机用户，写 local。 */
  owner: string;
  created_at: string | null;
  /** 最近一次数据升级是哪个产品版本做的、什么时候做的；没有升级过是 null。 */
  upgraded_by_version: string | null;
  upgraded_at: string | null;
}

export function taskJsonPath(taskDir: string): string {
  return join(taskDir, TASK_JSON);
}

/** 读任务目录的 task.json；没有这个文件，或者读不出来、不是一个对象，都是 null。 */
export function readTaskJson(taskDir: string): TaskJson | null {
  try {
    const raw = JSON.parse(readFileSync(taskJsonPath(taskDir), "utf-8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const text = (v: unknown) => (typeof v === "string" && v ? v : null);
    return {
      created_by_version: text(raw.created_by_version), task_type: text(raw.task_type),
      task_type_version: Number.isInteger(raw.task_type_version) ? raw.task_type_version : null,
      owner: text(raw.owner) ?? "local", created_at: text(raw.created_at),
      upgraded_by_version: text(raw.upgraded_by_version), upgraded_at: text(raw.upgraded_at),
    };
  } catch {
    return null;
  }
}

/** 写任务目录的 task.json：先写临时文件再改名，读的一方不会读到写了一半的。 */
export function writeTaskJson(taskDir: string, content: TaskJson): void {
  const path = taskJsonPath(taskDir);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(content, null, 2) + "\n", "utf-8");
  renameSync(temp, path);
}
