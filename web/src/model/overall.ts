// 业务说明（任务定义里名叫「业务说明」的集合）在页面上的几样派生：一页一个主题，页面按「上级主题」把它们排成提纲，
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
import { COUNTER_EXAMPLE_PREFIX, EXCEPTION_EXAMPLE_PREFIX, OVERALL_COLLECTION, OVERALL_FIELDS, STATUS_DEPRECATED } from "../../../agent/src/lib/overall_analysis.ts";
import { RESOLVED_VALUE, SOURCE_ITEM, SOURCE_SUPPLEMENT, issueStatus, issuesOf, seenCurrent, unresolvedIssuesOf, viewTarget } from "./items";
import { QUESTION_BLOCKING, QUESTION_BLOCKING_FIELD } from "../../../agent/src/lib/stage";

export { OVERALL_COLLECTION };


/** 这一页是不是某一章的导语页：「导语所属章」写了字（编写文档阶段助手补写的；它不是节，不贴标签）。 */
export function isIntroPage(item: Item): boolean {
  const chapter = item.fields[OVERALL_FIELDS.intro];
  return typeof chapter === "string" && chapter.trim() !== "";
}

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
// mentioned_by 别处提到它的句子（只有业务说明的页有）。条目的 viewed（看过）不等于不待核实：用户亲手改过的页算看过，
// 别处助手补的仍可能待核实。早先的后端不给这几项，这时按「没有待核实、没有被提到」处理。

/** 来源的两个种类：材料里的原文，用户在对话里说的话。 */
const SOURCE_DOCUMENT = "文档原文";
const SOURCE_USER_WORDS = "用户的话";

const byId = (a: Item, b: Item) => a.item_id.localeCompare(b.item_id, undefined, { numeric: true });
const listOf = (item: Item, field: string): string[] => {
  const v = item.fields[field];
  return Array.isArray(v) ? v.map(String).filter((one) => one.trim() !== "") : [];
};
const textOf = (item: Item, field: string): string => {
  const v = item.fields[field];
  return typeof v === "string" ? v : "";
};

/** 任务定义里的业务说明集合；没有时为 null（早先的任务）。 */
export function overallDef(task: Task): CollectionDef | null {
  return task.definition.collections.find((c) => c.name === OVERALL_COLLECTION) ?? null;
}

export function isOverall(collection: string | null | undefined): boolean {
  return collection === OVERALL_COLLECTION;
}

/** 业务说明的全部页，按编号。 */
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
 * 业务说明里待核实的页不在打开时记：记了它就不再待核实，而助手补的那几处用户也许还没有看；
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

/**
 * 待核实、依据待核实、提到这几项只随整份数据来，库事件里没有。任务里有业务说明时，页面在可能改变它们的事之后
 * （交付物有了新修订、有人确认或看过了某个条目、图有了变动或者被看过）另取一次。这里给出「该不该再取」的记号：修订号、确认标记的条数、
 * 图的修订号与看没看过变了，记号就变；
 * 没有业务说明的早先任务不用取，返回 null。
 */
export function factsKey(task: Task | null, latestRevision: number): string | null {
  if (!task || !overallDef(task)) return null;
  // 图有了变动、被看过之后也要再取：以图为依据的条目待不待核实、各页被哪几张图依据都可能变了。
  const diagrams = (task.diagrams ?? []).map((one) => `${one.diagram_id}.${one.revision_no}${one.viewed ? "v" : ""}`).join(",");
  return `${latestRevision}:${task.items.reduce((n, i) => n + i.confirmations.length, 0)}:${task.items.length}:${diagrams}`;
}

/**
 * 一条例子是哪一种，以及去掉开头那几个字之后的正文：以「例外：」开头的是例外（流程走不通、要另行处理的情形，画在「异常分支」里），
 * 以「反例：」开头的是反例（这种不算），别的是平常的例子。
 */
export function exampleKind(example: string): { kind: "exception" | "counter" | "plain"; text: string } {
  const trimmed = example.trim();
  if (trimmed.startsWith(EXCEPTION_EXAMPLE_PREFIX)) return { kind: "exception", text: trimmed.slice(EXCEPTION_EXAMPLE_PREFIX.length).trim() };
  if (trimmed.startsWith(COUNTER_PREFIX)) return { kind: "counter", text: trimmed.slice(COUNTER_PREFIX.length).trim() };
  return { kind: "plain", text: example };
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
  const supplements = item.sources.filter((s) => String(s.kind) === SOURCE_SUPPLEMENT);
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

/** 一段文字切开的一截：没有记号的原样，或者是要标出来的一段原话（added 是助手补的，material 是逐字出自材料的，带着那条来源）。 */
export interface PassagePart {
  text: string;
  mark: "added" | "material" | null;
  source?: Source;
}

/**
 * 在一段文字里标出若干段原话。quotes 是要找的各段：助手补的那几个字（added）与材料里的原句（material，带来源）。
 * 找得到的切成单独的一截并带上记号，找不到的不标。两段在同一处重叠时先出现的占先，同一个起点时长的占先。
 */
export function markPassage(text: string, quotes: readonly { quote: string; mark: "added" | "material"; source?: Source }[]): PassagePart[] {
  const wanted = quotes.filter((one) => one.quote !== "" && text.includes(one.quote));
  if (wanted.length === 0) return [{ text, mark: null }];
  const parts: PassagePart[] = [];
  let rest = text;
  while (rest) {
    const hits = wanted.map((one) => ({ one, at: rest.indexOf(one.quote) })).filter((hit) => hit.at >= 0)
      .sort((a, b) => a.at - b.at || b.one.quote.length - a.one.quote.length);
    if (hits.length === 0) { parts.push({ text: rest, mark: null }); break; }
    const { one, at } = hits[0];
    if (at > 0) parts.push({ text: rest.slice(0, at), mark: null });
    parts.push({ text: one.quote, mark: one.mark, ...(one.source ? { source: one.source } : {}) });
    rest = rest.slice(at + one.quote.length);
  }
  return parts;
}

/** 助手写理由时用直角引号引出来的、它补进正文的那几个字（两个字以上的才算）。 */
export function addedQuotes(reasons: readonly string[]): string[] {
  return [...new Set(reasons.flatMap((reason) => [...reason.matchAll(/「([^」]{2,})」/g)].map((m) => m[1])))];
}

/**
 * 「说明」（它是什么）里逐字出自材料的句子：支持这个字段、或者支持整页的「文档原文」来源的摘录（去掉首尾空白）。
 * 在正文里找得到的才会被标出来（markPassage）；找不到的照旧只列在来源那一行。
 */
export function materialQuotes(item: Item): { quote: string; mark: "material"; source: Source }[] {
  return [...sourcesFor(item, TOPIC.what), ...wholeSources(item)].filter((s) => String(s.kind) === SOURCE_DOCUMENT && s.excerpt.trim() !== "")
    .map((s) => ({ quote: s.excerpt.trim(), mark: "material" as const, source: s }));
}

/** 出处的一句短话：谁说的或者哪份材料，后面跟原话（长的截短）。助手补充的写理由；用户已经确认过的写明「你确认过」。 */
export function sourceShortText(source: Pick<Source, "kind" | "locator" | "excerpt">, pending = false): string {
  const kind = String(source.kind);
  const quote = source.excerpt.length > 36 ? `${source.excerpt.slice(0, 36)}…` : source.excerpt;
  if (kind === SOURCE_SUPPLEMENT) return `${pending ? "助手补的" : "助手补的，你确认过"} · 理由：${source.excerpt}`;
  if (kind === SOURCE_USER_WORDS) return `你说的「${quote}」`;
  if (kind === SOURCE_DOCUMENT) return `材料 ${source.locator.split("/").pop() ?? source.locator}「${quote}」`;
  if (kind === "用户直接修改") return "你亲手改的";
  return `${kind} ${source.locator}`.trim();
}

/** 支持整页的来源：没有指明哪一处的来源。 */
export function wholeSources(item: Item): Source[] {
  return item.sources.filter((s) => (s.supports ?? []).length === 0);
}

/** 节标题下面那一行小字要的三样：材料几处（种类为「文档原文」的来源）、澄清几条（种类为「用户的话」的来源）、这一页现在的内容用户看没看过（它现在所在的修订上有一条接受的确认标记）。 */
export function sectionLead(item: Item): { materials: number; clarified: number; seen: boolean } {
  const kinds = item.sources.map((s) => String(s.kind));
  return {
    materials: kinds.filter((kind) => kind === SOURCE_DOCUMENT).length,
    clarified: kinds.filter((kind) => kind === SOURCE_USER_WORDS).length,
    seen: seenCurrent(item),
  };
}

/** 「已经定下的」里算数的条数：助手补的、还没有确认的那几条不算。 */
export function settledCount(item: Item): number {
  const pending = supplemented(item).settled;
  return settledOf(item).filter((_, i) => !pending.has(i)).length;
}

/** 问题条目里的三个字段：没有它下一段做不做得出、不阻断的什么时候回看、了结之后答案落实到了哪里。 */
export { QUESTION_BLOCKING, QUESTION_BLOCKING_FIELD };
export const QUESTION_NOT_BLOCKING = "不阻断";
export const QUESTION_REVISIT_FIELD = "何时回看";
export const QUESTION_LANDED_FIELD = "落实到";

/** 这个问题是不是阻断下游的：没有它下一段做不出。没有写这一项的问题（早先的任务）当作不阻断。 */
export function isBlockingQuestion(question: Item): boolean {
  return textOf(question, QUESTION_BLOCKING_FIELD).trim() === QUESTION_BLOCKING;
}

/** 问题上那枚小标签写什么：「阻断下游」或「不阻断」；任务的定义里没有这一项时不挂（null）。 */
export function questionBlockingText(task: Task, question: Item): string | null {
  const def = task.definition.collections.find((c) => c.name === question.collection);
  if (!(def?.fields ?? []).some((f) => f.name === QUESTION_BLOCKING_FIELD)) return null;
  return isBlockingQuestion(question) ? QUESTION_BLOCKING : QUESTION_NOT_BLOCKING;
}

/** 不阻断的问题什么时候回看；阻断下游的、没有写的为空。 */
export function questionRevisit(question: Item): string {
  return isBlockingQuestion(question) ? "" : textOf(question, QUESTION_REVISIT_FIELD).trim();
}

/** 了结的问题答案落实到了哪里；没有写的为空。 */
export function questionLanded(question: Item): string {
  return textOf(question, QUESTION_LANDED_FIELD).trim();
}

/** 挂在这一页上、还没有了结的问题（「还没定的」）：阻断下游的排在前面，各自按编号。 */
export function openQuestions(task: Task, item: Item): Item[] {
  const all = unresolvedIssuesOf(task, item.item_id);
  return [...all.filter(isBlockingQuestion), ...all.filter((one) => !isBlockingQuestion(one))];
}

/** 挂在这一页上、已经了结（状态是「已解决」）的问题，按编号。 */
export function settledQuestions(task: Task, item: Item): Item[] {
  return issuesOf(task, item.item_id).filter((one) => issueStatus(task, one) === RESOLVED_VALUE);
}

/** 「助手为什么问」：问题条目里除第一个字段之外、填了字的文本字段（需求规格里是「建议的处理」），取第一个；没有时为空。 */
export function questionReason(task: Task, question: Item): string {
  const def = task.definition.collections.find((c) => c.name === question.collection);
  const skip = ["处理结果", QUESTION_REVISIT_FIELD, QUESTION_LANDED_FIELD];
  const field = (def?.fields ?? []).slice(1).find((f) => f.type === "文本" && !skip.includes(f.name) && textOf(question, f.name).trim() !== "");
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
 * 一个条目依据的主题待核实或已废弃、或者依据的图用户还没有看过时，条目行上那枚小标签的字与悬停说明；没有这回事时为 null。
 * 它不是条目自己的毛病：那一页确认了（或者把依据改到别的主题），标签就消掉。
 */
export function basisNote(task: Task, item: Item): { text: string; title: string } | null {
  const basis = item.basis_pending;
  if (!basis) return null;
  const name = (id: string) => { const page = task.items.find((i) => i.item_id === id); return page ? `${id}「${titleOf(page)}」` : id; };
  // 依据的是一张图（编号在图的清单里）：图现在的内容用户还没有看过。
  const figure = (task.diagrams ?? []).find((one) => one.diagram_id === basis.item_id);
  if (figure) return { text: "依据的图还没有看过", title: `它依据的图「${figure.name}」现在的内容你还没有看过；到业务说明里把这张图看一遍，这里就消掉。` };
  if (basis.reason === "deprecated") {
    return { text: "依据的主题已废弃", title: `它依据的主题 ${name(basis.item_id)}已废弃${basis.see ? `，改看 ${name(basis.see)}` : ""}。把依据改到还在用的主题上。` };
  }
  return { text: "依据的主题待核实", title: `它依据的主题 ${name(basis.item_id)}里有助手补的内容还没有确认；到业务说明里确认那一节，这里就消掉。` };
}

/** 依据这一页写的条目（把它写成「条目」来源的别的条目），按编号。 */
export function dependents(task: Task, item: Item): Item[] {
  const ids = new Set((item.depended_by ?? []).filter((d) => d.element_kind === SOURCE_ITEM).map((d) => d.id));
  return task.items.filter((i) => ids.has(i.item_id)).sort(byId);
}

/** 「复述一遍」发给助手的那句话：给了主题就讲它与它下面的主题，没有给就讲整个业务说明。 */
export function retellText(title: string | null): string {
  return title ? `请把现在对「${title}」及其下面主题的理解讲成一段故事` : "请把现在对业务说明里各个主题的理解讲成一段故事";
}

/** 「让助手照这条改条目」预填进对话区输入框的那句话，用户可以接着写。 */
export function reviseDependentsText(item: Item): string {
  return `请照 ${item.item_id}「${titleOf(item)}」现在的内容，把依据它写的条目改过来：`;
}

/**
 * 助手复述时那张请选择卡片的三个选项的键（文字是「采纳为例子」「有误，需修改」「换一个例子重述」，由助手照它的说明写）。
 * 早先没有写死键的回复，选项还是原来的文字，按第一个选项以「这段对」开头来认。
 */
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
