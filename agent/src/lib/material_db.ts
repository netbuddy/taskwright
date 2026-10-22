/**
 * 材料表（任务库的 material 表，格式 11 加的）：每份材料放进了哪个槽位、role 是什么。材料本身是任务目录里的文件，清单仍扫目录得出；
 * 这里只查、只记文件上看不出的槽位与 role。没有行的材料（升级前就有的、或者表还没建的旧库）当作不经槽位上传的：槽位空，role「证据」。
 *
 * 写入（insertMaterial、retireMaterial）由后端在上传、替换、删除材料时调用：这是用户直接对任务目录的操作，不经 pi，
 * 所以与建任务一样是后端不写库的例外（backend/tests/no_writes.test.ts 的白名单）。删除或被替换不删行，只写上那一刻。
 */

import type { DatabaseSync } from "node:sqlite";
import { definitionsFor } from "./activity_def_read.ts";
import type { FlowSlot } from "./activity_def.ts";
import { wallClockText } from "./db.ts";
import { withTaskDatabase } from "./schema.ts";

/** 不经槽位上传的材料、与没有记录的材料的 role。 */
export const DEFAULT_MATERIAL_ROLE = "证据";

/** 一份材料的槽位与 role。 */
export interface MaterialRole {
  slot: string | null;
  role: string;
}

/** 还在的材料各自的槽位与 role，键是相对任务目录的路径。库里还没有材料表时是空的。 */
export function materialRoles(db: DatabaseSync): Map<string, MaterialRole> {
  const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'material'").get();
  if (found === undefined) return new Map();
  const rows = db.prepare("SELECT path, slot, role FROM material WHERE removed_at IS NULL ORDER BY material_id").all() as { path: string; slot: string | null; role: string }[];
  return new Map(rows.map((row) => [row.path, { slot: row.slot, role: row.role }]));
}

/** 一份材料的槽位与 role：查不到时是不经槽位的「证据」。 */
export function roleOf(roles: ReadonlyMap<string, MaterialRole>, path: string): MaterialRole {
  return roles.get(path) ?? { slot: null, role: DEFAULT_MATERIAL_ROLE };
}

/**
 * 任务的工作流的声明里叫 key 的、收材料的槽位；skillPath 是任务定义里的执行方法（相对任务目录）。几条工作流写了同一个键时取第一条的。
 * 没有这个键、或者它收的是文字，都是 null。只读声明文件。
 */
export function materialSlot(workspaceDir: string, skillPath: string, key: string): FlowSlot | null {
  for (const flow of definitionsFor(workspaceDir, skillPath).flows) {
    const found = flow.slots.find((one) => one.key === key);
    if (found) return found.accepts === "materials" ? found : null;
  }
  return null;
}

/** 库里还没有材料行时取任务编号用：一个库只放一个任务。 */
function taskIdOf(db: DatabaseSync): string {
  const row = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string } | undefined;
  if (!row) throw new Error("任务库里还没有任务记录。");
  return row.task_id;
}

/** 把还在的那一行（路径是 path）写上删除的时刻，返回它原来的槽位与 role；没有还在的行时是 null。 */
function retire(db: DatabaseSync, path: string, at: string): MaterialRole | null {
  const row = db.prepare("SELECT material_id, slot, role FROM material WHERE path = ? AND removed_at IS NULL ORDER BY material_id DESC LIMIT 1").get(path) as
    { material_id: number; slot: string | null; role: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE material SET removed_at = ? WHERE material_id = ?").run(at, row.material_id);
  return { slot: row.slot, role: row.role };
}

/**
 * 记下一份刚存好的材料，返回记下的槽位与 role。placement 是它放进的槽位与 role；replaces 给了时（替换材料）不看 placement，
 * 被换掉的那份的行写上删除的时刻，新的这份沿用它的槽位与 role（它没有行时按「证据」、槽位空）。两件事在一个事务里。
 */
export function insertMaterial(workspaceDir: string, path: string, placement: MaterialRole, replaces: string | null = null): MaterialRole {
  return withTaskDatabase(workspaceDir, { createIfMissing: false }, (db) => {
    const at = wallClockText();
    const kept = replaces === null ? placement : retire(db, replaces, at) ?? { slot: null, role: DEFAULT_MATERIAL_ROLE };
    db.prepare("INSERT INTO material (task_id, path, slot, role, added_at) VALUES (?, ?, ?, ?, ?)").run(taskIdOf(db), path, kept.slot, kept.role, at);
    return kept;
  });
}

/** 一份材料删掉了：它还在的那一行写上删除的时刻。没有行（升级前就有的材料）时什么都不写。 */
export function retireMaterial(workspaceDir: string, path: string): void {
  withTaskDatabase(workspaceDir, { createIfMissing: false }, (db) => {
    retire(db, path, wallClockText());
  });
}
