/**
 * 按材料的role限定一项活动能用哪些材料（活动声明的「sources_from_roles」）。两处用它：
 * - 保存修订（lib/save_revision.ts）：新给的「文档原文」来源所指的材料，role要在清单里；
 * - 自带工具调用之前（hooks/source_roles.ts）：read 读的材料、grep 搜的文件或目录里的材料，role要在清单里。
 * 当前活动的声明里这一栏是空的（没写），两处都不限。知识库里的文档不是材料，不归这里管。
 *
 * 材料的role记在材料表里（lib/material_db.ts）；生成的文字版（.docx.md、.pdf.md、.segments.json 之类）按它的原件算，
 * 材料表里没有行的材料是「证据」。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./db.ts";
import { validateDefinition } from "./definition.ts";
import { hasOverall } from "./overall_analysis.ts";
import { BUSY_TIMEOUT_MS } from "./schema.ts";
import { type MaterialRole, materialRoles, roleOf } from "./material_db.ts";
import { openActivityRecord, sourcesFromRolesFor } from "./stage_read.ts";
import { IDLE } from "./stage.ts";
import { resolvedPath } from "./tool_limits.ts";

/** 生成的文字版与旁边的辅助文件的后缀：去掉它，剩下的是 .docx 或 .pdf 时，那就是它的原件。 */
const DERIVED_SUFFIXES = [".segments.json", ".locations.json", ".md", ".txt"];

/** 一份材料文件（相对任务目录）的原件：生成的文字版给出原件的路径，别的原样交回。 */
export function originalOf(path: string): string {
  for (const suffix of DERIVED_SUFFIXES) {
    if (!path.toLowerCase().endsWith(suffix)) continue;
    const stem = path.slice(0, -suffix.length);
    if (/\.(docx|pdf)$/i.test(stem)) return stem;
  }
  return path;
}

/**
 * 来源的出处所指的材料（相对任务目录）：去掉 # 开头的段落号或页与块，去掉开头的「./」；只写了文件名的接在材料目录后面
 * （与核对摘录时找文件的办法相同）。
 */
export function materialOfLocator(locator: string, materialsDir: string): string {
  let path = locator.split("#")[0].trim().replace(/^\.\//, "");
  if (!path.includes("/")) path = `${materialsDir}${path}`;
  return path;
}

/** 一份材料（相对任务目录）的role：生成的文字版按原件算。 */
export function materialRoleOf(roles: ReadonlyMap<string, MaterialRole>, path: string): string {
  return roleOf(roles, originalOf(path)).role;
}

/** 当前活动的这一栏与这个任务的材料 role：不限时（空闲、没有任务库、这一栏没写）是 null。 */
export interface RoleLimit {
  allowed: string[];
  roles: Map<string, MaterialRole>;
  materialsDir: string;
}

/** 按任务目录与会话取当前活动的材料 role限定。只读库。 */
export function roleLimitInWorkspace(workspaceDir: string, sessionId: string | null): RoleLimit | null {
  const path = databasePath(workspaceDir);
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; definition_text: string } | undefined;
    if (!task) return null;
    const definition = validateDefinition(JSON.parse(task.definition_text));
    if (!hasOverall(definition.collections)) return null;
    const open = openActivityRecord(db, task.task_id, sessionId);
    if (open === null || open.activity === IDLE) return null;
    const allowed = sourcesFromRolesFor(workspaceDir, definition, open.activity);
    if (allowed.length === 0) return null;
    return { allowed, roles: materialRoles(db), materialsDir: definition.materialsDir };
  } finally {
    db.close();
  }
}

/** 材料目录里的全部文件（相对任务目录，只看第一层，与材料清单相同）。 */
function materialFiles(workspaceDir: string, materialsDir: string): string[] {
  const dir = join(workspaceDir, materialsDir);
  try {
    return readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile()).map((name) => `${materialsDir}${name}`);
  } catch {
    return [];
  }
}

/**
 * 自带的 read 或 grep 这次要读的材料里，role不在清单里的那一份（相对任务目录）；都在、或者读的不是材料时是 null。
 * read 看 path 指的那一份；grep 的 path 指一份文件就看那一份，指一个目录（不写 path 是任务目录）就看目录之下的全部材料。
 */
export function refusedMaterial(workspaceDir: string, limit: RoleLimit, toolName: string, input: Record<string, unknown>): { path: string; role: string } | null {
  if (toolName !== "read" && toolName !== "grep") return null;
  const given = toolName === "grep" && (input.path === undefined || input.path === "") ? "." : input.path;
  const target = resolvedPath(workspaceDir, given);
  if (target === null) return null;
  const root = resolvedPath(workspaceDir, ".") ?? workspaceDir;
  const rel = relative(root, target).split(sep).join("/");
  if (rel.startsWith("..")) return null;
  const isDir = existsSync(target) && statSync(target).isDirectory();
  const files = materialFiles(workspaceDir, limit.materialsDir);
  const touched = !isDir ? files.filter((one) => one === rel) : rel === "" ? files : files.filter((one) => one.startsWith(`${rel}/`));
  if (toolName === "read" && isDir) return null;
  for (const one of touched) {
    const role = materialRoleOf(limit.roles, one);
    if (!limit.allowed.includes(role)) return { path: one, role };
  }
  return null;
}
