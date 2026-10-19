// 工作台中栏的页签，按需求资产六类分：材料与证据、业务说明、分析模型、需求条目、评审与确认、文档与版本；任务定义里有问题条目
// 一类的集合时，「需求条目」后面另有一个与它们并列的页签，名字是那个集合的名字，页签上的数是未解决的有几条。
// 业务说明、需求条目与问题三个页签里是集合（业务说明是那一个集合，问题是问题条目一类的集合，需求条目是其余的集合，排成子页签）；
// 另外四个页签不是集合，各有自己的一页。这里只算：页签的次序与名字、页签上的数、「材料与证据」页上每份材料与每个知识库被引用了几处。

import type { Item, KnowledgeLibrary, Material, Task } from "../api/types";
import { ownMaterials } from "./docx";
import { isKnowledgeLocator, knowledgePlace } from "./knowledge";
import { isDeprecated, isOverall } from "./overall";
import { keepPendingField } from "./items";

/** 页签的键：六类资产，加上问题。 */
export type AssetPane = "materials" | "description" | "models" | "items" | "issues" | "review" | "docs";

export const ASSET_PANES: { key: AssetPane; label: string }[] = [
  { key: "materials", label: "材料与证据" },
  { key: "description", label: "业务说明" },
  { key: "models", label: "分析模型" },
  { key: "items", label: "需求条目" },
  { key: "review", label: "评审与确认" },
  { key: "docs", label: "文档与版本" },
];

/** 问题条目一类的集合（有取值「用户决定保留」的枚举字段，见 items.ts 的 keepPendingField），照任务定义的先后。 */
export const issueCollections = (task: Task) => task.definition.collections.filter((one) => !isOverall(one.name) && keepPendingField(task, one.name) !== null);

/**
 * 这个任务顶上一排的页签：六类资产；有问题条目一类的集合时，「需求条目」后面多一个「问题」页签，名字取自任务定义里那个集合
 * （有几个时取第一个的名字，几个集合排成这个页签里的子页签）。
 */
export function assetPanes(task: Task): { key: AssetPane; label: string }[] {
  const issues = issueCollections(task);
  return ASSET_PANES.flatMap((one) => (one.key === "items" && issues.length > 0 ? [one, { key: "issues" as const, label: issues[0].name }] : [one]));
}

/** 不是集合的四个页签记在浏览器里时存的值（集合页签存集合名）。 */
export const paneKey = (pane: AssetPane): string => `@${pane}`;
export function paneOfKey(value: string | null): AssetPane | null {
  const hit = ASSET_PANES.find((one) => paneKey(one.key) === value);
  return hit && hit.key !== "description" && hit.key !== "items" ? hit.key : null;
}

/** 一个集合的条目在哪个页签里：业务说明那一个集合在「业务说明」，问题条目一类的集合在「问题」，其余在「需求条目」。 */
export const paneOfCollection = (task: Task, collection: string): AssetPane =>
  isOverall(collection) ? "description" : keepPendingField(task, collection) !== null ? "issues" : "items";

/** 需求条目页签里的集合：业务说明与问题条目一类之外的集合，照任务定义的先后。 */
export const itemCollections = (task: Task) => task.definition.collections.filter((one) => !isOverall(one.name) && keepPendingField(task, one.name) === null);

/** 未解决的问题条目：状态字段（keepPendingField）是它的第一个取值。 */
export function unresolvedIssues(task: Task): Item[] {
  return task.items.filter((one) => {
    const field = keepPendingField(task, one.collection);
    return field !== null && one.fields[field.name] === (field.values ?? [])[0];
  });
}

/** 需求条目（问题条目不算）：业务说明与问题集合之外的条目。 */
export function requirementItems(task: Task): Item[] {
  return task.items.filter((one) => !isOverall(one.collection) && keepPendingField(task, one.collection) === null);
}

/**
 * 页签上的数：材料几份、业务说明几节（不算已废弃的页）、分析模型几张、需求条目几条（问题条目不算）、问题有几条未解决、
 * 文档与版本发布过几版；评审与确认不写数。「第 N 版」写在文档与版本页的页头里。
 */
export function paneCount(pane: AssetPane, task: Task, materials: Material[]): string | null {
  switch (pane) {
    case "materials": return String(ownMaterials(materials).length);
    case "description": return String(task.items.filter((one) => isOverall(one.collection) && !isDeprecated(one)).length);
    case "models": return String((task.diagrams ?? []).length);
    case "items": return String(requirementItems(task).length);
    case "issues": return String(unresolvedIssues(task).length);
    case "review": return null;
    case "docs": return String((task.versions ?? []).length);
  }
}

/** 材料的类型给人看的写法，按扩展名。 */
export function materialKind(path: string): string {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  return ({ md: "Markdown", markdown: "Markdown", txt: "纯文本", docx: "Word", pdf: "PDF" } as Record<string, string>)[ext] ?? (ext ? ext.toUpperCase() : "文件");
}

/**
 * 一份材料被引用了几处：条目当前修订上种类为「文档原文」、出处指到这份材料（或由它生成的文字版）的来源。
 * pages 是有这种来源的业务说明的页数（「几节」），places 是来源的条数（「几处」，所有条目都算）。
 */
export function materialCitations(task: Task, materials: Material[], path: string): { pages: number; places: number } {
  const own = new Set([path, ...materials.filter((one) => one.derived_from === path).map((one) => one.path)]);
  let pages = 0;
  let places = 0;
  for (const item of task.items) {
    const hits = item.sources.filter((one) => one.kind === "文档原文" && own.has(one.locator.split("#")[0])).length;
    if (hits === 0) continue;
    places += hits;
    if (isOverall(item.collection) && !isDeprecated(item)) pages += 1;
  }
  return { pages, places };
}

/** 「被引用」一格的写法：「5 节 · 7 处」；没有被引用写「还没有被引用」。 */
export function citationText(cited: { pages: number; places: number }): string {
  if (cited.places === 0) return "还没有被引用";
  return cited.pages > 0 ? `${cited.pages} 节 · ${cited.places} 处` : `${cited.places} 处`;
}

/** 一个知识库被本任务的条目引用了几处：条目当前修订上出处是这个知识库里文档的来源条数。 */
export function libraryCitations(task: Task, libraries: KnowledgeLibrary[] | null, libraryId: string): number {
  return task.items.reduce((sum, item) => sum + item.sources.filter((one) =>
    isKnowledgeLocator(one.locator) && knowledgePlace(one.locator, libraries).library === libraryId).length, 0);
}
