/**
 * 缺失的材料：材料表里还有这份材料（lib/material_db.ts），任务目录里却没有它的文件——从不带材料的数据包导入、用户还没补齐时就是这样。
 * 自带的 read 读这样的材料（或者由它生成的文字版、分段清单、位置表）时，hooks/missing_material.ts 拦下这次调用，
 * 让助手请用户补齐，而不是由 read 报「文件不存在」再去猜。只看材料目录之下的路径，别的路径不管。
 */

import { existsSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./db.ts";
import { validateDefinition } from "./definition.ts";
import { materialRecords } from "./material_db.ts";
import { BUSY_TIMEOUT_MS } from "./schema.ts";
import { originalOf } from "./source_roles.ts";
import { resolvedPath } from "./tool_limits.ts";

/**
 * read 这次要读的路径（input.path）若是一份缺失的材料或者它的派生文件，给出那份材料的路径（相对任务目录）；文件在、不在材料目录之下、
 * 材料表里没有这一行、没有任务库时都是 null。
 */
export function missingMaterialOf(workspaceDir: string, input: Record<string, unknown>): string | null {
  const target = resolvedPath(workspaceDir, input.path);
  if (target === null || existsSync(target)) return null;
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT definition_text FROM task ORDER BY started_at LIMIT 1").get() as { definition_text: string } | undefined;
    if (!task) return null;
    const materialsDir = validateDefinition(JSON.parse(task.definition_text)).materialsDir;
    // 文件不在时 resolvedPath 换不成真实路径：任务目录经过符号链接时，按任务目录的真实路径与字面路径各比一次。
    const root = resolvedPath(workspaceDir, ".") ?? workspaceDir;
    const under = [root, resolve(workspaceDir)].map((base) => relative(base, target).split(sep).join("/")).find((one) => !one.startsWith(".."));
    if (under === undefined || !under.startsWith(materialsDir)) return null;
    const rel = under;
    const original = originalOf(rel);
    const listed = materialRecords(db).some((row) => row.path === original);
    return listed && !existsSync(join(root, original)) ? original : null;
  } finally {
    db.close();
  }
}
