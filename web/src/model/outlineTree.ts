// 业务说明按分析提纲排的目录（任务类型有分析提纲时，见 components/work/overall/OutlineContents.tsx）：树顶「目前的判断」，
// 八个维度照提纲的先后，维度下是提纲条目，条目下是挂在它下面的页；树底「解决方案创意」「未归类的发现」，最后是没有排进树的页。
// 页与提纲的对应只看页名：维度页的名字是维度名；提纲条目的页名字是条目名，或者「条目名 · 子系统名」（乘子系统的维度）。
// 状态由挂在页上、还没了结的问题条目推出：种类是缺失的算缺失，别的种类算还开着的缺口。只算，不画。

import type { Item, Task } from "../api/types";
import { type OutlineTitles, outlineTitles } from "../../../agent/src/lib/outline_parse.ts";
import { QUESTION_KIND_FIELD, QUESTION_KIND_MISSING } from "../../../agent/src/lib/stage";
import { unresolvedIssuesOf } from "./items";
import { TOPIC, isDeprecated, pagesOf, parentOf, titleOf } from "./overall";

/** 正文里写明「与本系统无关」的提纲条目页算确认无关（核读的说明要求用一句话写明无关与理由）。 */
export const IRRELEVANT_PHRASE = "与本系统无关";

/** 一个提纲条目（或一个维度）的状态。 */
export type EntryState =
  | { kind: "none" }
  | { kind: "draft"; gaps: number }
  | { kind: "partial"; missing: number }
  | { kind: "full" }
  | { kind: "irrelevant" };

/** 状态小标上写的字。 */
export function stateText(state: EntryState): string {
  switch (state.kind) {
    case "none": return "未起";
    case "draft": return `草稿 · 缺口 ${state.gaps}`;
    case "partial": return `部分 · 缺失 ${state.missing}`;
    case "full": return "满";
    case "irrelevant": return "确认无关";
  }
}

/** 树里的一页与挂在它下面的页。 */
export interface PageNode {
  item: Item;
  children: PageNode[];
}

/** 一个提纲条目：名字、对应的页（乘子系统的维度可能有几页）、状态、挂在这些页下面的页。 */
export interface EntryNode {
  name: string;
  pages: Item[];
  state: EntryState;
  children: PageNode[];
}

export interface DimensionNode {
  name: string;
  /** 维度页；还没有立时为 null（目录里这一行灰着，不能点）。 */
  page: Item | null;
  entries: EntryNode[];
  /** 维度页下面不是提纲条目页的页（子系统页、候选页之类），连同它们下面的页；提纲条目页不在这里重复。 */
  others: PageNode[];
  /** 已做的提纲条目数（满、部分、确认无关）与提纲条目总数。 */
  done: number;
  total: number;
  state: EntryState;
}

export interface FixedNode {
  name: string;
  page: Item | null;
}

export interface OutlineTree {
  outline: OutlineTitles;
  judgement: FixedNode | null;
  dimensions: DimensionNode[];
  ideas: FixedNode | null;
  unsorted: FixedNode | null;
  /** 没有排进树里的页（名字与提纲对不上、上级也不在树里）。 */
  loose: Item[];
}

/** 任务有分析提纲时的目录；没有分析提纲时为 null（目录照旧按章画）。 */
export function outlineTree(task: Task): OutlineTree | null {
  const text = task.definition?.outline;
  if (typeof text !== "string" || !text.trim()) return null;
  const outline = outlineTitles(text);
  if (outline.dimensions.length === 0) return null;
  const pages = pagesOf(task).filter((page) => !isDeprecated(page));
  const children = new Map<string, Item[]>();
  for (const page of pages) {
    const parent = parentOf(page);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), page]);
  }
  const placed = new Set<string>();
  const byName = (name: string): Item | null => pages.find((page) => titleOf(page) === name && !parentOf(page)) ?? pages.find((page) => titleOf(page) === name) ?? null;
  const fixed = (name: string | undefined): FixedNode | null => {
    if (!name) return null;
    const page = byName(name);
    if (page) placed.add(page.item_id);
    return { name, page };
  };
  const head = (page: Item) => titleOf(page).split(" · ")[0].trim();

  /** 一页下面的页，跳过 skip 里的（提纲条目页另列）。 */
  const subtree = (page: Item, skip: Set<string>): PageNode[] =>
    (children.get(page.item_id) ?? []).filter((one) => !skip.has(one.item_id)).map((one) => {
      placed.add(one.item_id);
      return { item: one, children: subtree(one, skip) };
    });
  /** 一页与它下面所有的页。 */
  const descendants = (page: Item): Item[] => (children.get(page.item_id) ?? []).flatMap((one) => [one, ...descendants(one)]);

  const judgement = fixed(outline.fixedPages.judgement);
  const ideas = fixed(outline.fixedPages.ideas);
  const unsorted = fixed(outline.fixedPages.unsorted);

  const dimensions = outline.dimensions.map((name): DimensionNode => {
    const page = byName(name);
    if (page) placed.add(page.item_id);
    const names = outline.entries[name] ?? [];
    // 提纲条目页：维度页下面名字对得上的页；还没有维度页时，在全部页里找名字对得上的。
    const pool = page ? descendants(page) : pages;
    const entryPages = new Map(names.map((entry) => [entry, pool.filter((one) => head(one) === entry && !(one.item_id === page?.item_id))]));
    const entryIds = new Set([...entryPages.values()].flat().map((one) => one.item_id));
    const entries = names.map((entry): EntryNode => {
      const found = entryPages.get(entry) ?? [];
      found.forEach((one) => placed.add(one.item_id));
      return { name: entry, pages: found, state: entryState(task, found), children: found.flatMap((one) => subtree(one, entryIds)) };
    });
    const others = page ? subtree(page, entryIds) : [];
    const done = entries.filter((one) => one.state.kind === "full" || one.state.kind === "partial" || one.state.kind === "irrelevant").length;
    return { name, page, entries, others, done, total: entries.length, state: dimensionState(page, entries) };
  });
  const loose = pages.filter((page) => !placed.has(page.item_id));
  return { outline, judgement, dimensions, ideas, unsorted, loose };
}

/** 一个提纲条目的状态：没有页是未起；页上开着缺口是草稿；只剩缺失是部分；正文写明无关是确认无关；都没有是满。 */
export function entryState(task: Task, pages: Item[]): EntryState {
  if (pages.length === 0) return { kind: "none" };
  const open = pages.flatMap((page) => unresolvedIssuesOf(task, page.item_id));
  const unique = [...new Map(open.map((one) => [one.item_id, one])).values()];
  const missing = unique.filter((one) => one.fields[QUESTION_KIND_FIELD] === QUESTION_KIND_MISSING).length;
  const gaps = unique.length - missing;
  if (gaps > 0) return { kind: "draft", gaps };
  if (missing > 0) return { kind: "partial", missing };
  if (pages.some((page) => String(page.fields[TOPIC.what] ?? "").includes(IRRELEVANT_PHRASE))) return { kind: "irrelevant" };
  return { kind: "full" };
}

/** 维度的状态：一页都没有是未起；有开着的缺口是草稿（缺口数相加）；只剩缺失是部分；提纲条目都做了是满，否则也算草稿（缺口 0）。 */
function dimensionState(page: Item | null, entries: EntryNode[]): EntryState {
  if (!page && entries.every((one) => one.state.kind === "none")) return { kind: "none" };
  const gaps = entries.reduce((n, one) => n + (one.state.kind === "draft" ? one.state.gaps : 0), 0);
  const missing = entries.reduce((n, one) => n + (one.state.kind === "partial" ? one.state.missing : 0), 0);
  if (gaps > 0) return { kind: "draft", gaps };
  if (entries.some((one) => one.state.kind === "none")) return { kind: "draft", gaps: 0 };
  if (missing > 0) return { kind: "partial", missing };
  return { kind: "full" };
}

/**
 * 现在正在做的那一页：最近记下、还开着的缺口（种类不是缺失、还没了结的问题条目）挂在哪一页，就是那一页。
 * 核读时卡片问的就是这个缺口，卡片的 items 点名它与它所在的页。没有开着的缺口时是 null。
 */
export function currentEntryPage(task: Task, tree: OutlineTree): string | null {
  const ids = new Set(tree.dimensions.flatMap((one) => one.entries.flatMap((entry) => entry.pages.map((page) => page.item_id))));
  let best: { serial: number; page: string } | null = null;
  for (const id of ids) {
    for (const issue of unresolvedIssuesOf(task, id)) {
      if (issue.fields[QUESTION_KIND_FIELD] === QUESTION_KIND_MISSING) continue;
      const serial = Number(issue.item_id.replace(/\D+/g, "")) || 0;
      if (!best || serial > best.serial) best = { serial, page: id };
    }
  }
  return best?.page ?? null;
}

/** 一页在提纲树里的位置：哪个维度、哪个提纲条目（维度页本身、维度下别的页没有提纲条目）。不在树里时为 null。 */
export function outlinePlace(tree: OutlineTree, itemId: string): { dimension: string; entry: string | null } | null {
  const within = (nodes: PageNode[]): boolean => nodes.some((one) => one.item.item_id === itemId || within(one.children));
  for (const dimension of tree.dimensions) {
    if (dimension.page?.item_id === itemId) return { dimension: dimension.name, entry: null };
    for (const entry of dimension.entries) {
      if (entry.pages.some((page) => page.item_id === itemId) || within(entry.children)) return { dimension: dimension.name, entry: entry.name };
    }
    if (within(dimension.others)) return { dimension: dimension.name, entry: null };
  }
  return null;
}
