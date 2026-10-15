// 「文档与版本」页签的两张表：发布前检查（完成条件逐条与非阻断提示）与按章覆盖。只算，不画（components/work/DocsTab.tsx）。
// 数据全部来自任务详情里现成的东西：完成条件的判定（task.completion）、章节目录（model/chapters.ts 的 toc）、图放在哪里、
// 条目的来源与追溯（model/docsPage.ts）。每一行给一个「去补」的入口，说明要去哪个页签、看哪一处；入口怎样走由条目区做。

import type { CompletionCondition, Task } from "../api/types";
import { CHAPTERS, type Toc } from "./chapters";
import { basisOf, traceFacts } from "./docsPage";
import { CONFIRM_CONDITION, REVIEW_CONDITION, conditionState } from "./items";
import { collectionLabel, isOverall } from "./overall";
import { emptyLineText } from "./completionLines";
import { figureHome } from "./sectionDiagrams";

/** 「去补」的入口：去哪个页签、停在哪个集合与筛选、打开哪个条目、哪一章的章首、哪一张图。 */
export type GoTarget =
  | { kind: "items"; collection: string; filter?: "unread" | "all" }
  | { kind: "review" }
  | { kind: "item"; itemId: string }
  | { kind: "chapter"; no: number }
  | { kind: "diagram"; diagramId: string };

export interface CheckRow {
  key: string;
  /** 「功能用例：每个条目评审通过」。 */
  label: string;
  state: "met" | "unmet" | "empty";
  /** 差什么；满足时与暂不核对时是一句短话。 */
  gap: string;
  go: GoTarget | null;
  /** 入口按钮上写的字。 */
  goText: string;
}

/** 一处待处理里最多点名几个，多的写「等 N 个」。 */
const NAMED = 3;
const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
function named(ids: string[]): string {
  const list = [...ids].sort(byNumber);
  return list.length <= NAMED ? list.join("、") : `${list.slice(0, NAMED).join("、")} 等 ${list.length} 个`;
}

/** 一条完成条件差什么、去哪里补。 */
function checkRow(task: Task, c: CompletionCondition): CheckRow {
  const state = conditionState(c);
  const label = `${collectionLabel(c.collection)}：${c.name}`;
  const key = `${c.collection}/${c.name}`;
  if (state === "met") return { key, label, state, gap: "已满足", go: null, goText: "" };
  const overall = isOverall(c.collection);
  const at = (ids: string[], what: string) => (ids.length ? `${named(ids)} ${what}` : c.note || "还没有满足");
  if (c.name === "至少一个条目") {
    return { key, label, state, gap: "一个也没有", go: overall ? { kind: "chapter", no: 1 } : { kind: "items", collection: c.collection }, goText: overall ? "去业务说明" : "去需求条目" };
  }
  if (c.name === REVIEW_CONDITION) return { key, label, state, gap: at(c.missing, "还没有评审通过"), go: { kind: "review" }, goText: "去评审与确认" };
  if (c.name === CONFIRM_CONDITION) {
    const first = [...c.missing].sort(byNumber)[0];
    return {
      key, label, state, gap: at(c.missing, "你还没有看过"),
      go: overall ? (first ? { kind: "item", itemId: first } : null) : { kind: "items", collection: c.collection, filter: "unread" },
      goText: overall ? "打开那一节" : "筛出未读",
    };
  }
  if (c.name === "没有状态为未解决的条目") return { key, label, state, gap: at(c.missing, "还没有解决"), go: { kind: "items", collection: c.collection, filter: "all" }, goText: "去处理问题" };
  return { key, label, state, gap: c.note || "还没有满足", go: null, goText: "" };
}

/**
 * 发布前检查：完成条件逐条，照接口给的先后；集合还没有条目、暂时不用核对的不逐条列，合成末尾一行（与汇总行点开的完成条件同一写法）。
 */
export function checkRows(task: Task): CheckRow[] {
  const conditions = task.completion?.conditions ?? [];
  const rows = conditions.filter((one) => conditionState(one) !== "empty").map((one) => checkRow(task, one));
  const empty = [...new Set(conditions.filter((one) => conditionState(one) === "empty").map((one) => collectionLabel(one.collection)))];
  if (empty.length) rows.push({ key: "暂不核对", label: "暂不核对", state: "empty", gap: emptyLineText(empty), go: null, goText: "" });
  return rows;
}

/** 一条非阻断提示：一句话与入口。 */
export interface Hint {
  key: string;
  text: string;
  go: GoTarget | null;
  goText: string;
}

/**
 * 非阻断提示：不挡发布，但发布之前值得看一眼。空章（这一章靠自己的节写成，现在一节也没有）、没有依据的需求条目、
 * 用户还没有看过现在内容的图、依据的节上挂着未解决的待澄清问题的条目，再加完成条件判定里带出来的提示（例如还没有贴标签的主题）。
 */
export function hints(task: Task, contents: Toc): Hint[] {
  const out: Hint[] = [];
  for (const one of contents.chapters) {
    if (one.chapter.labels.length > 0 && one.sections.length === 0) {
      out.push({ key: `empty-${one.chapter.no}`, text: `第 ${one.chapter.no} 章「${one.chapter.name}」一节也没有。`, go: { kind: "chapter", no: one.chapter.no }, goText: "打开这一章" });
    }
  }
  const { missing, shaky } = traceFacts(task);
  for (const id of missing) out.push({ key: `basis-${id}`, text: `${id} 没有依据业务说明的哪一节或哪一张图。`, go: { kind: "item", itemId: id }, goText: "打开条目" });
  for (const row of task.diagrams ?? []) {
    if (row.viewed !== true) out.push({ key: `unseen-${row.diagram_id}`, text: `${row.diagram_id}「${row.name}」现在的内容你还没有看过。`, go: { kind: "diagram", diagramId: row.diagram_id }, goText: "打开所在章节" });
  }
  for (const id of shaky) out.push({ key: `shaky-${id}`, text: `${id} 依据的节上有还没解决的待澄清问题。`, go: { kind: "item", itemId: id }, goText: "打开条目" });
  for (const hint of task.completion?.hints ?? []) {
    const first = [...hint.items].sort(byNumber)[0];
    out.push({ key: `hint-${hint.kind}`, text: hint.summary, go: first ? { kind: "item", itemId: first } : null, goText: "打开" });
  }
  return out;
}

/** 按章覆盖的一行。 */
export interface CoverageRow {
  /** 「3 业务流程」。 */
  name: string;
  /** 节数；不靠自己的节写成的章（业务规则、决策记录与待澄清事项）与条目各章是 null。 */
  sections: number | null;
  items: number | null;
  diagrams: number | null;
  /** 有没有导语；条目各章是 null。 */
  intro: boolean | null;
  /** 备注：空章，或这一章的内容从哪里来。 */
  note: string;
  empty: boolean;
}

/** 不靠自己的节写成的两章，内容由别处汇成。 */
const GATHERED: Record<number, string> = { 5: "由各节「已经定下的」汇成规则表", 7: "由决定页与未解决的问题汇成" };

/**
 * 按章覆盖：前七章照页面目录（节数不算已废弃的页、图数是放在这一章章首或各节里的图、条目数是依据这一章某一节的需求条目），
 * 其后每个集合一章（只数条目），章号接着往下编。
 */
export function coverageRows(task: Task, contents: Toc): CoverageRow[] {
  const homes = (task.diagrams ?? []).map((one) => figureHome(task, contents, one.diagram_id));
  const sectionChapter = new Map(contents.chapters.flatMap((one) => one.sections.map((section) => [section.item.item_id, one.chapter.no] as [string, number])));
  const { items } = traceFacts(task);
  const rows: CoverageRow[] = contents.chapters.map((one) => {
    const no = one.chapter.no;
    const gathered = GATHERED[no];
    const sections = one.sections.filter((section) => section.no !== null).length;
    const diagrams = homes.filter((home) => (home?.where === "chapter" && home.chapter === no) || (home?.where === "section" && sectionChapter.get(home.itemId) === no)).length;
    const cited = items.filter((item) => basisOf(task, item).pages.some((page) => sectionChapter.get(page) === no)).length;
    const empty = !gathered && sections === 0;
    return {
      name: `${no} ${one.chapter.name}`, sections: gathered ? null : sections, items: gathered ? null : cited, diagrams: gathered ? null : diagrams, intro: !!one.intro,
      note: empty ? "空章" : gathered ?? (one.glossaryNo ? `含术语表（${one.glossaryNo}）` : ""), empty,
    };
  });
  const collections = task.definition.collections.filter((one) => !isOverall(one.name));
  collections.forEach((one, i) => {
    const count = task.items.filter((item) => item.collection === one.name).length;
    rows.push({ name: `${CHAPTERS.length + i + 1} ${one.name}`, sections: null, items: count, diagrams: null, intro: null, note: count === 0 ? "空章" : "", empty: count === 0 });
  });
  return rows;
}
