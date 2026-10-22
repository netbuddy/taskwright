/**
 * 读任务的分析提纲：任务目录里 skill 的 outline.md。解析在 outline_parse.ts（页面也用它），这里只管找到并读出文件。
 * 没有分析提纲的任务类型、回退读产品自带声明的早先任务都当作没有。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { definitionsDir } from "./activity_def_read.ts";
import { type OutlineTitles, outlineTitles } from "./outline_parse.ts";

export { type OutlineTitles, SYNTHESIS_PAGE_KEYS, examplesRequiredFor, outlineTitles, tableHeaderFor } from "./outline_parse.ts";

/** 分析提纲的文件名，放在 skill 目录里。 */
export const OUTLINE_FILE = "outline.md";

/**
 * 一个任务的分析提纲的原文。skillPath 是任务定义里的「执行方法」。任务目录里的 skill 没有分析提纲时返回 null；
 * 回退读产品自带的声明的早先任务（lib/activity_def_read.ts）也返回 null：它们建任务时还没有分析提纲，不按它办。
 */
export function outlineTextFor(workspaceDir: string, skillPath: string): string | null {
  // 与读活动声明同一个找法（lib/activity_def_read.ts 的 definitionsDir），只看目录在不在，不读声明。
  const skillDir = dirname(resolve(workspaceDir, skillPath));
  const where = definitionsDir(skillDir, relative(resolve(workspaceDir), skillDir));
  if (where === null || where.fallback) return null;
  const file = join(where.dir, OUTLINE_FILE);
  return existsSync(file) ? readFileSync(file, "utf-8") : null;
}

/** 一个任务的分析提纲里的名字；没有分析提纲时为 null（见 outlineTextFor）。 */
export function outlineTitlesFor(workspaceDir: string, skillPath: string): OutlineTitles | null {
  const text = outlineTextFor(workspaceDir, skillPath);
  return text === null ? null : outlineTitles(text);
}
