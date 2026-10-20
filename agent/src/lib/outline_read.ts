/**
 * 任务类型的分析提纲（skill 目录里的 outline.md）里平台要用的两样：维度名（二级小节的名字）与开头元数据里登记的几页固定页的名字。
 * 平台不读维度与提纲条目的文字含义，只拿这些名字判断一页是不是维度页或固定页。没有分析提纲的任务类型返回 null。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { definitionsFor } from "./activity_def_read.ts";

/** 分析提纲的文件名，放在 skill 目录里。 */
export const OUTLINE_FILE = "outline.md";

/** 元数据里登记固定页名字的键：正文是综合的那几页。 */
export const SYNTHESIS_PAGE_KEYS = ["judgement", "ideas", "unsorted"] as const;

export interface OutlineTitles {
  /** 维度名，即二级小节的名字。 */
  dimensions: string[];
  /** 元数据里 SYNTHESIS_PAGE_KEYS 登记的固定页的名字。 */
  synthesisPages: string[];
  /** 写了 `examples: optional` 的维度：这些维度的页不要求举例。 */
  examplesOptional: string[];
  /** 每个维度下的提纲条目名（「- 条目名 —— ……」一行的开头）。 */
  entries: Record<string, string[]>;
}

/** 从分析提纲的文字里取维度名与固定页的名字。 */
export function outlineTitles(text: string): OutlineTitles {
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const meta = new Map(head.split("\n").map((line) => /^(\w+):\s*(.+)$/.exec(line.trim())).filter((m): m is RegExpExecArray => m !== null).map((m) => [m[1], m[2].trim()]));
  const synthesisPages = SYNTHESIS_PAGE_KEYS.map((key) => meta.get(key)).filter((one): one is string => !!one);
  const sections = text.split(/^## /m).slice(1).map((part) => {
    const [name, ...rest] = part.split("\n");
    const body = rest.join("\n");
    return { name: name.trim(), optional: /^examples:\s*optional\s*$/m.test(body), entries: [...body.matchAll(/^- (.+?) ——/gm)].map((m) => m[1].trim()) };
  });
  return {
    dimensions: sections.map((one) => one.name),
    synthesisPages,
    examplesOptional: sections.filter((one) => one.optional).map((one) => one.name),
    entries: Object.fromEntries(sections.map((one) => [one.name, one.entries])),
  };
}

/**
 * 一页属于举例可选的维度吗：它的名字是这种维度的维度名或提纲条目名，或者是「维度名 · 子系统名」「条目名 · 子系统名」。
 * 子主题页、候选页的名字对不上这几种，照常要求举例。
 */
export function examplesOptionalFor(outline: OutlineTitles, name: string): boolean {
  const head = name.split(" · ")[0].trim();
  return outline.examplesOptional.some((dimension) => head === dimension || (outline.entries[dimension] ?? []).includes(head));
}

/**
 * 一个任务的分析提纲里的这些名字。skillPath 是任务定义里的「执行方法」。任务目录里的 skill 没有分析提纲时返回 null；
 * 回退读产品自带的声明的早先任务（lib/activity_def_read.ts）也返回 null：它们建任务时还没有分析提纲，不按它办。
 */
export function outlineTitlesFor(workspaceDir: string, skillPath: string): OutlineTitles | null {
  const where = definitionsFor(workspaceDir, skillPath);
  if (where.fallback) return null;
  const file = join(where.dir, OUTLINE_FILE);
  return existsSync(file) ? outlineTitles(readFileSync(file, "utf-8")) : null;
}
