// 总体分析（任务定义里名叫「总体分析」的集合）在页面上的几样派生：一页一个主题，页面按「上级主题」把它们排成提纲，
// 每页分四块（它是什么、例子、已经定下的、还没定的），底下列出提到它的地方。这里只算不画，也不改任何数据：
//   · 提纲：成树、每页的状态点与「N 定 · N 问」、底部的总计；
//   · 一页里哪几处是助手补的、还没有确认（待核实）；
//   · 术语表：标签含「概念」、不待核实的页；
//   · 提到它的地方：别处的文字里出现它的标题或别名的那些句子，加上依据它写的条目；
//   · 「复述一遍」发给助手的那句话。
// 「还没定的」不另存：就是问题集合里挂在这一页、还没有了结的条目（model/items.ts 的 unresolvedIssuesOf）。
// 集合名叫「领域说明」的早先任务不走这里，照旧用 model/domainNotes.ts。

import type { CollectionDef, Item, Mention, Source, Task } from "../api/types";
// 集合名、字段名、状态的取值与「反例：」这几个字，助手一侧与后端也用，只在那边的一个文件里写一遍（它不碰 Node 模块，页面可以直接导入）。
import { COUNTER_EXAMPLE_PREFIX, OVERALL_COLLECTION, OVERALL_FIELDS, STATUS_DEPRECATED } from "../../../agent/src/lib/overall_analysis.ts";
import { SOURCE_ITEM, SOURCE_SUPPLEMENT, sourceKindNow, unresolvedIssuesOf, viewTarget } from "./items";

export { OVERALL_COLLECTION };

/** 一页主题的各个字段的名字（任务定义里的写法）。 */
export const TOPIC = {
  title: OVERALL_FIELDS.title, alias: OVERALL_FIELDS.aliases, what: OVERALL_FIELDS.what, examples: OVERALL_FIELDS.examples, settled: OVERALL_FIELDS.settled,
  labels: OVERALL_FIELDS.tags, parent: OVERALL_FIELDS.parent, status: OVERALL_FIELDS.status, see: OVERALL_FIELDS.seeAlso,
} as const;
export const DEPRECATED = STATUS_DEPRECATED;
/** 「例子」里以这几个字开头的一项是反例。 */
export const COUNTER_PREFIX = COUNTER_EXAMPLE_PREFIX;
/** 进术语表的标签。 */
export const CONCEPT_LABEL = "概念";

// 任务快照里条目另带的几项（api/types.ts 的 Item）：pending_verification 待核实，pending_sources 还待核实的助手补充来源有几条，
// pending_places 这些来源支持的各处（用户亲手改过的那一处已经不在里面），basis_pending 它依据的主题待核实或已废弃，
// mentioned_by 别处提到它的句子（只有总体分析的页有）。条目的 viewed（看过）不等于不待核实：用户亲手改过的页算看过，
// 别处助手补的仍可能待核实。早先的后端不给这几项，这时按「没有待核实、没有被提到」处理。

const byId = (a: Item, b: Item) => a.item_id.localeCompare(b.item_id, undefined, { numeric: true });
const listOf = (item: Item, field: string): string[] => {
  const v = item.fields[field];
  return Array.isArray(v) ? v.map(String).filter((one) => one.trim() !== "") : [];
};
const textOf = (item: Item, field: string): string => {
  const v = item.fields[field];
  return typeof v === "string" ? v : "";
};

/** 任务定义里的总体分析集合；没有时为 null（早先的任务）。 */
export function overallDef(task: Task): CollectionDef | null {
  return task.definition.collections.find((c) => c.name === OVERALL_COLLECTION) ?? null;
}

export function isOverall(collection: string | null | undefined): boolean {
  return collection === OVERALL_COLLECTION;
}

/** 总体分析的全部页，按编号。 */
export function pagesOf(task: Task): Item[] {
  return task.items.filter((i) => isOverall(i.collection)).sort(byId);
}

export const titleOf = (item: Item): string => textOf(item, TOPIC.title) || item.title;
export const aliasesOf = (item: Item): string[] => listOf(item, TOPIC.alias);
export const whatOf = (item: Item): string => textOf(item, TOPIC.what);
export const examplesOf = (item: Item): string[] => listOf(item, TOPIC.examples);
export const settledOf = (item: Item): string[] => listOf(item, TOPIC.settled);
export const labelsOf = (item: Item): string[] => listOf(item, TOPIC.labels);
export const parentOf = (item: Item): string | null => listOf(item, TOPIC.parent)[0] ?? null;
export const seeInstead = (item: Item): string | null => listOf(item, TOPIC.see)[0] ?? null;
export const isDeprecated = (item: Item): boolean => item.fields[TOPIC.status] === DEPRECATED;
export const isPending = (item: Item): boolean => item.pending_verification === true;

/** 这一页有几处待核实；不待核实时是 0。 */
export function pendingCount(item: Item): number {
  return isPending(item) ? Math.max(1, item.pending_sources ?? 1) : 0;
}

/**
 * 用户打开一个条目时要不要顺手记为已读（返回要记的目标，不记时为 null）。别的条目照旧：打开就记（model/items.ts 的 viewTarget）。
 * 总体分析里待核实的页不在打开时记：记了它就不再待核实，而助手补的那几处用户也许还没有看；
 * 这种页由主题页上的「确认待核实的 N 处」来记。
 */
export function viewOnOpen(task: Task | null, itemId: string | null): { item_id: string; base_revision: number } | null {
  const item = task?.items.find((i) => i.item_id === itemId) as Item | undefined;
  if (item && isOverall(item.collection) && isPending(item)) return null;
  return viewTarget(task, itemId);
}

/** 「确认待核实的 N 处」：在这一页现在所在的修订上记一条已读，助手补的那几处就算用户确认过了。 */
export function confirmAction(item: Item): { kind: "mark_viewed"; targets: { item_id: string; base_revision: number }[]; notify_executor: false } {
  return { kind: "mark_viewed", targets: [{ item_id: item.item_id, base_revision: item.revision_no }], notify_executor: false };
}

/** 一条例子是不是反例，以及去掉「反例：」之后的正文。 */
export function exampleParts(example: string): { counter: boolean; text: string } {
  const counter = example.startsWith(COUNTER_PREFIX);
  return { counter, text: counter ? example.slice(COUNTER_PREFIX.length).trim() : example };
}

/** 一段文字的首段：到第一个空行为止。 */
export function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/)[0].trim();
}

/** 支持某一处的来源：指到这个字段（列表字段还要指到这一项）的来源；一条来源什么都没有指时算支持整页，不列在某一处下面。 */
export function sourcesFor(item: Item, field: string, index: number | null = null): Source[] {
  return item.sources.filter((s) => (s.supports ?? []).some((p) => p.field === field && (index === null || p.index == null || p.index === index)));
}

/**
 * 这一页里哪几处是助手补的、还没有确认：只在这一页待核实时才有。
 * whole 是有助手补充的来源没有指明哪一处（整页都要看）；fields 是被指到的文本字段；
 * settled、examples 是「已经定下的」「例子」里被指到的那几项；reasons 是助手写的理由。
 */
export function supplemented(item: Item): { whole: boolean; fields: Set<string>; settled: Set<number>; examples: Set<number>; reasons: string[] } {
  const out = { whole: false, fields: new Set<string>(), settled: new Set<number>(), examples: new Set<number>(), reasons: [] as string[] };
  if (!isPending(item)) return out;
  const supplements = item.sources.filter((s) => sourceKindNow(String(s.kind)) === SOURCE_SUPPLEMENT);
  out.reasons = supplements.map((s) => s.excerpt.trim()).filter(Boolean);
  // 哪几处：后端给了 pending_places 就照它（它已经去掉了用户亲手改过的地方）；没有给时从助手补充的来源自己看。
  type Place = { field: string | null; index?: number | null };
  const places: Place[] = item.pending_places
    ?? supplements.flatMap((s): Place[] => ((s.supports ?? []).length === 0 ? [{ field: null, index: null }] : s.supports!));
  for (const p of places) {
    if (p.field === null) out.whole = true;
    else if (p.field === TOPIC.settled && p.index != null) out.settled.add(p.index);
    else if (p.field === TOPIC.examples && p.index != null) out.examples.add(p.index);
    else out.fields.add(p.field);
  }
  return out;
}

/**
 * 「它是什么」里要标出的字句：助手写理由时用直角引号引了原文里的几个字（「保留期是 3 天」是我按常见做法补的），
 * 这几个字在正文里找得到就标出来。返回切开的片段；一处也找不到时整段不标（页面改为在这一块旁边说明）。
 */
export function markSupplemented(text: string, reasons: string[]): { text: string; marked: boolean }[] {
  const quoted = [...new Set(reasons.flatMap((r) => [...r.matchAll(/「([^」]{2,})」/g)].map((m) => m[1])))]
    .filter((q) => text.includes(q)).sort((a, b) => b.length - a.length);
  if (quoted.length === 0) return [{ text, marked: false }];
  const parts: { text: string; marked: boolean }[] = [];
  let rest = text;
  while (rest) {
    const hits = quoted.map((q) => ({ q, at: rest.indexOf(q) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at || b.q.length - a.q.length);
    if (hits.length === 0) { parts.push({ text: rest, marked: false }); break; }
    const { q, at } = hits[0];
    if (at > 0) parts.push({ text: rest.slice(0, at), marked: false });
    parts.push({ text: q, marked: true });
    rest = rest.slice(at + q.length);
  }
  return parts;
}

/** 「已经定下的」里算数的条数：助手补的、还没有确认的那几条不算。 */
export function settledCount(item: Item): number {
  const pending = supplemented(item).settled;
  return settledOf(item).filter((_, i) => !pending.has(i)).length;
}

/** 挂在这一页上、还没有了结的问题（「还没定的」）。 */
export function openQuestions(task: Task, item: Item): Item[] {
  return unresolvedIssuesOf(task, item.item_id);
}

/** 「助手为什么问」：问题条目里除第一个字段之外、填了字的文本字段（需求规格里是「建议的处理」），取第一个；没有时为空。 */
export function questionReason(task: Task, question: Item): string {
  const def = task.definition.collections.find((c) => c.name === question.collection);
  const field = (def?.fields ?? []).slice(1).find((f) => f.type === "文本" && f.name !== "处理结果" && textOf(question, f.name).trim() !== "");
  return field ? textOf(question, field.name).trim() : "";
}

/**
 * 提纲里一页的状态，同时满足几种时按这个先后取一种：
 * deprecated 已废弃；pending 有助手补的、待核实；open 还有没定的；unsorted 记下了、还没有贴标签；settled 说清了。
 */
export type TopicState = "deprecated" | "pending" | "open" | "unsorted" | "settled";

export function topicState(task: Task, item: Item): TopicState {
  if (isDeprecated(item)) return "deprecated";
  if (isPending(item)) return "pending";
  if (openQuestions(task, item).length > 0) return "open";
  if (labelsOf(item).length === 0) return "unsorted";
  return "settled";
}

export const STATE_TEXT: Record<TopicState, string> = {
  deprecated: "已废弃", pending: "有助手补的，待核实", open: "还有没定的", unsorted: "记下了，还没归类", settled: "说清了",
};

/** 提纲一行末尾的计数：「3 定 · 1 问」，没有的那一半不写；两样都没有时写状态（待核实、未归类、已废弃），说清了的不写。 */
export function countsText(task: Task, item: Item): string {
  const settled = settledCount(item);
  const open = openQuestions(task, item).length;
  const parts = [settled > 0 ? `${settled} 定` : "", open > 0 ? `${open} 问` : ""].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  const state = topicState(task, item);
  return state === "pending" ? "待核实" : state === "unsorted" ? "未归类" : state === "deprecated" ? "已废弃" : "";
}

export interface OutlineNode {
  item: Item;
  children: OutlineNode[];
}

/**
 * 提纲：按「上级主题」成树，同级按编号。上级不在总体分析里、或者顺着上级会绕回自己的页，当作顶层的一页，
 * 所以每一页都正好出现一次。
 */
export function outline(task: Task): OutlineNode[] {
  const pages = pagesOf(task);
  const known = new Map(pages.map((p) => [p.item_id, p]));
  const up = (page: Item): string | null => {
    const id = parentOf(page);
    return id && id !== page.item_id && known.has(id) ? id : null;
  };
  // 顺着上级一路往上走又回到这一页，就是绕圈：当它没有上级。上面的页自己绕圈不关它的事。
  const parent = (page: Item): string | null => {
    const seen = new Set<string>();
    for (let at = up(page); at && !seen.has(at); at = up(known.get(at)!)) {
      if (at === page.item_id) return null;
      seen.add(at);
    }
    return up(page);
  };
  const nodes = new Map(pages.map((p) => [p.item_id, { item: p, children: [] } as OutlineNode]));
  const roots: OutlineNode[] = [];
  for (const page of pages) {
    const up = parent(page);
    if (up) nodes.get(up)!.children.push(nodes.get(page.item_id)!);
    else roots.push(nodes.get(page.item_id)!);
  }
  return roots;
}

/** 提纲从上到下的次序（先自己、再下面的各页）；「上一条」「下一条」照它走。 */
export function outlineOrder(nodes: OutlineNode[]): Item[] {
  return nodes.flatMap((n) => [n.item, ...outlineOrder(n.children)]);
}

/** 面包屑：这一页上面的各级主题，从最上面一级到它的上级；它自己不在里面。 */
export function trail(task: Task, item: Item): Item[] {
  const path = (nodes: OutlineNode[], above: Item[]): Item[] | null => {
    for (const n of nodes) {
      if (n.item.item_id === item.item_id) return above;
      const found = path(n.children, [...above, n.item]);
      if (found) return found;
    }
    return null;
  };
  return path(outline(task), []) ?? [];
}

/** 这一页与它下面各级的页（复述时讲的范围）。 */
export function withBelow(task: Task, itemId: string): Item[] {
  const find = (nodes: OutlineNode[]): OutlineNode | null => {
    for (const n of nodes) {
      if (n.item.item_id === itemId) return n;
      const found = find(n.children);
      if (found) return found;
    }
    return null;
  };
  const node = find(outline(task));
  return node ? outlineOrder([node]) : [];
}

/** 提纲底部的总计：在用的主题几个、已定几条、待问几条、待核实几处。已废弃的页不算。 */
export function totals(task: Task): { pages: number; settled: number; open: number; pending: number } {
  const pages = pagesOf(task).filter((p) => !isDeprecated(p));
  return {
    pages: pages.length,
    settled: pages.reduce((n, p) => n + settledCount(p), 0),
    open: pages.reduce((n, p) => n + openQuestions(task, p).length, 0),
    pending: pages.reduce((n, p) => n + pendingCount(p), 0),
  };
}

/** 术语表：标签含「概念」、在用、不待核实的页，按编号；每行是标题、别名与「它是什么」的首段。waiting 是标签含概念但还待核实的页。 */
export function glossary(task: Task): { rows: { item: Item; aliases: string[]; first: string }[]; waiting: Item[] } {
  const concepts = pagesOf(task).filter((p) => !isDeprecated(p) && labelsOf(p).includes(CONCEPT_LABEL));
  return {
    rows: concepts.filter((p) => !isPending(p)).map((p) => ({ item: p, aliases: aliasesOf(p), first: firstParagraph(whatOf(p)) })),
    waiting: concepts.filter(isPending),
  };
}

/**
 * 一个条目依据的主题待核实或已废弃时，条目行上那枚小标签的字与悬停说明；没有这回事时为 null。
 * 它不是条目自己的毛病：那一页确认了（或者把依据改到别的主题），标签就消掉。
 */
export function basisNote(task: Task, item: Item): { text: string; title: string } | null {
  const basis = item.basis_pending;
  if (!basis) return null;
  const name = (id: string) => { const page = task.items.find((i) => i.item_id === id); return page ? `${id}「${titleOf(page)}」` : id; };
  if (basis.reason === "deprecated") {
    return { text: "依据的主题已废弃", title: `它依据的主题 ${name(basis.item_id)}已废弃${basis.see ? `，改看 ${name(basis.see)}` : ""}。把依据改到还在用的主题上。` };
  }
  return { text: "依据的主题待核实", title: `它依据的主题 ${name(basis.item_id)}里有助手补的内容还没有确认；到总体分析里确认那一页，这里就消掉。` };
}

/** 右侧栏窄提纲里一页下面那行小字：「3 定 · 1 问」，待核实的后面加「待核实」；什么都没有时写「说清了」。 */
export function sideLine(task: Task, item: Item): string {
  const counts = countsText(task, item);
  const pending = isPending(item) && counts !== "待核实" ? "待核实" : "";
  return [counts, pending].filter(Boolean).join(" · ") || STATE_TEXT.settled;
}

/** 依据这一页写的条目（把它写成「条目」来源的别的条目），按编号。 */
export function dependents(task: Task, item: Item): Item[] {
  const ids = new Set((item.depended_by ?? []).filter((d) => d.element_kind === SOURCE_ITEM).map((d) => d.id));
  return task.items.filter((i) => ids.has(i.item_id)).sort(byId);
}

/**
 * 「提到它的地方」的一行。mention：别处的一句话里出现了它的标题或别名，word 是命中的词；
 * basis：一个条目依据它写，sentence 是那个条目引的原话，stale 为真是它在那之后改过（依据已变）。
 * from 是起点条目（已经不在任务里时为 null），place 说明在哪里（「主题 · 已经定下的第 2 条」「功能用例 · 依据它」）。
 */
export interface MentionRow {
  kind: "mention" | "basis";
  id: string;
  from: Item | null;
  place: string;
  sentence: string;
  word: string | null;
  stale: boolean;
}

export function mentionRows(task: Task, item: Item): MentionRow[] {
  const find = (id: string) => task.items.find((i) => i.item_id === id) ?? null;
  const where = (m: Mention) => {
    const part = m.index == null ? m.field : `${m.field}第 ${m.index + 1} 条`;
    return `${isOverall(m.collection) ? "主题" : m.collection} · ${part}`;
  };
  const mentions: MentionRow[] = (item.mentioned_by ?? []).map((m) => (
    { kind: "mention", id: m.item_id, from: find(m.item_id), place: where(m), sentence: m.sentence, word: m.word, stale: false }
  ));
  const basis: MentionRow[] = dependents(task, item).map((from) => {
    const source = from.sources.find((s) => sourceKindNow(String(s.kind)) === SOURCE_ITEM && s.locator === item.item_id);
    return { kind: "basis", id: from.item_id, from, place: `${from.collection} · 依据它`, sentence: source?.excerpt ?? "", word: null, stale: source?.stale === "changed" };
  });
  return [...mentions, ...basis];
}

/** 把一句话按命中的词切开，画的时候给那个词上色；词不在句子里时整句不切。 */
export function splitByWord(sentence: string, word: string | null): { text: string; hit: boolean }[] {
  const at = word ? sentence.indexOf(word) : -1;
  if (!word || at < 0) return [{ text: sentence, hit: false }];
  return [{ text: sentence.slice(0, at), hit: false }, { text: word, hit: true }, { text: sentence.slice(at + word.length), hit: false }].filter((p) => p.text !== "");
}

/** 「复述一遍」发给助手的那句话：给了主题就讲它与它下面的主题，没有给就讲整个总体分析。 */
export function retellText(title: string | null): string {
  return title ? `请把现在对「${title}」及其下面主题的理解讲成一段故事` : "请把现在对总体分析里各个主题的理解讲成一段故事";
}

/** 「让助手照这条改条目」预填进对话区输入框的那句话，用户可以接着写。 */
export function reviseDependentsText(item: Item): string {
  return `请照 ${item.item_id}「${titleOf(item)}」现在的内容，把依据它写的条目改过来：`;
}

/** 助手复述时那张请选择卡片的三个选项的键；早先没有写死键的回复，按第一个选项的文字以「这段对」开头来认。 */
export const STORY_KEYS = ["story_ok", "story_fix", "story_again"] as const;

/**
 * 助手复述的那张卡片，故事写在哪里：卡片的正文与这条回复的正文，哪个长哪个就是故事（另一个是一句引子或问话）。
 * card 是写在卡片的正文里，reply 是写在回复的正文里；不是复述卡片时为 null。
 */
export function storyPlace(act: { kind: string; text: string; options?: { key: string; text: string }[] }, replyText = ""): "card" | "reply" | null {
  if (act.kind !== "choose" || !isStoryOptions(act.options)) return null;
  return act.text.trim().length >= replyText.trim().length ? "card" : "reply";
}

export function isStoryOptions(options: { key: string; text: string }[] | undefined): boolean {
  if (!options || options.length === 0) return false;
  if (options.some((o) => (STORY_KEYS as readonly string[]).includes(o.key))) return true;
  return options[0].text.trim().startsWith("这段对");
}
