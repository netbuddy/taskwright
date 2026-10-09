/**
 * 总体分析：任务类型定义里名叫「总体分析」的集合。一条就是一页主题，用这件事自己的话写：标题、别名、它是什么、例子、
 * 已经定下的、标签、上级主题、状态（在用或已废弃）、改看。条目依据它写。
 *
 * 本文件是由事实算出来的几样东西，都只算、不读库：
 * - 待核实：一个条目当前所在的修订上有助手补充的来源，而用户还没有在这个修订上确认过（打开看过、亲手改过都算确认）。
 *   用户确认之后不再待核实；助手之后又改出新的修订、上面仍有助手补充的来源，就又待核实。任何集合的条目都这样算。
 * - 因依据而待核实：一个条目把总体分析里的一页写成了来源（种类「条目」），而那一页待核实或已废弃。只看一层。
 * - 提到：贴了标签、在用的页的标题与别名是词表；别的页与别的条目的文字里出现了词表里的词，就是提到了那一页。
 *   读的时候现算，不存库。
 * - 最低门要看的事实：任务里有没有一页贴了标签、有例子、又不待核实的主题。
 *
 * 0.4 建的任务没有这个集合（它们的集合叫「领域说明」，照旧）：没有词表，没有提到，也没有最低门；待核实照样算。
 *
 * 本文件不导入任何模块：后端的快照、助手的读取、评审提示都调它，页面也可以直接导入（agent/tests/web_imports.test.ts 守着）。
 */

/** 集合的名字。 */
export const OVERALL_COLLECTION = "总体分析";

/** 这个集合的字段名。 */
export const OVERALL_FIELDS = {
  title: "标题", aliases: "别名", what: "它是什么", examples: "例子", settled: "已经定下的",
  tags: "标签", parent: "上级主题", status: "状态", seeAlso: "改看",
} as const;

/** 状态的两个取值。 */
export const STATUS_IN_USE = "在用";
export const STATUS_DEPRECATED = "已废弃";

/** 「例子」里一项以它开头的是反例（这种不算）。 */
export const COUNTER_EXAMPLE_PREFIX = "反例：";

/** 来源种类里的「助手补充」与它在早期版本里的名字，以及依据另一个条目的种类「条目」。本文件不导入别的模块，所以写在这里。 */
const SUPPLEMENT_KINDS: readonly string[] = ["助手补充", "执行者补充"];
const ITEM_KIND = "条目";

type Fields = Record<string, unknown>;

/** 任务定义里有没有总体分析这个集合（0.4 建的任务没有）。 */
export function hasOverall(collections: readonly { name: string }[]): boolean {
  return collections.some((one) => one.name === OVERALL_COLLECTION);
}

const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string" && one.trim() !== "") : []);

/** 一页贴了哪些标签。 */
export function tagsOf(fields: Fields): string[] {
  return texts(fields[OVERALL_FIELDS.tags]);
}

/** 一页是不是已废弃。 */
export function isDeprecated(fields: Fields): boolean {
  return fields[OVERALL_FIELDS.status] === STATUS_DEPRECATED;
}

/** 一页写了「改看」时指向的那一页；没有写是 null。 */
export function seeAlsoOf(fields: Fields): string | null {
  return texts(fields[OVERALL_FIELDS.seeAlso])[0] ?? null;
}

/** 程序只认贴了标签、在用的页：它们的词才进词表，才进文档，才算数。 */
export function isUsable(fields: Fields): boolean {
  return tagsOf(fields).length > 0 && !isDeprecated(fields);
}

// ───────────── 待核实 ─────────────

/** 一条来源是不是助手补充的（早期版本叫执行者补充）。 */
export function isSupplement(kind: unknown): boolean {
  return typeof kind === "string" && SUPPLEMENT_KINDS.includes(kind);
}

/**
 * 一个条目待不待核实。supplements 是它当前所在修订上助手补充的来源有几条；confirmed 是用户有没有在这个修订上确认过
 * （这个修订上最近一条确认标记的态度是接受：打开看过、亲手改过都算）。pending_sources 是还待核实的来源条数。
 */
export function pendingVerification(supplements: number, confirmed: boolean): { pending_verification: boolean; pending_sources: number } {
  const pending = supplements > 0 && !confirmed;
  return { pending_verification: pending, pending_sources: pending ? supplements : 0 };
}

/** 被一个条目写成来源的那一页现在的样子：在哪个集合、字段内容、待不待核实。 */
export interface CitedPage {
  collection: string;
  fields: Fields;
  pending: boolean;
}

/** 因依据而待核实：依据的是哪一页，是因为它待核实（pending）还是已废弃（deprecated）；已废弃而写了改看时 see 是改看的那一页。 */
export interface BasisPending {
  item_id: string;
  reason: "pending" | "deprecated";
  see: string | null;
}

/**
 * 一个条目当前修订上的来源里，种类为「条目」、指向总体分析里一页的：那一页已废弃或待核实时，返回头一处；都没有是 null。
 * 只看一层：被指的那一页自己依据了谁不往下追。page 按编号给出那一页现在的样子，不存在或已经删除时给 null。
 */
export function basisPending(sources: readonly { kind: unknown; locator: unknown }[], page: (itemId: string) => CitedPage | null): BasisPending | null {
  for (const one of sources) {
    if (one.kind !== ITEM_KIND || typeof one.locator !== "string") continue;
    const cited = page(one.locator);
    if (!cited || cited.collection !== OVERALL_COLLECTION) continue;
    if (isDeprecated(cited.fields)) return { item_id: one.locator, reason: "deprecated", see: seeAlsoOf(cited.fields) };
    if (cited.pending) return { item_id: one.locator, reason: "pending", see: null };
  }
  return null;
}

// ───────────── 提到 ─────────────

/** 算提到时要的一个条目：编号、所在的集合、现在的修订号、现在的字段内容。 */
export interface PlainItem {
  item_id: string;
  collection: string;
  revision_no: number;
  fields: Fields;
}

/** 集合的字段声明里算提到时要的两项。 */
export interface CollectionShape {
  name: string;
  fields: readonly { name: string; type: string }[];
}

/** 词表里的一个词：贴了标签、在用的一页的标题或一个别名。 */
export interface TopicWord {
  word: string;
  item_id: string;
}

/** 词表：贴了标签、在用的页的标题与每个别名（去掉首尾空白，空的不要）。两页写了同一个词时两条都在。 */
export function topicWords(items: readonly PlainItem[]): TopicWord[] {
  const out: TopicWord[] = [];
  for (const item of items) {
    if (item.collection !== OVERALL_COLLECTION || !isUsable(item.fields)) continue;
    const title = item.fields[OVERALL_FIELDS.title];
    const words = [...(typeof title === "string" ? [title] : []), ...texts(item.fields[OVERALL_FIELDS.aliases])].map((one) => one.trim()).filter(Boolean);
    for (const word of new Set(words)) out.push({ word, item_id: item.item_id });
  }
  return out;
}

/** 把一段文字按句切开：句号、问号、叹号、分号与换行各算一句的结尾（标点留在句子里）。空的不要。 */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[。！？!?；;\n])/).map((one) => one.trim()).filter(Boolean);
}

const WORD_CHAR = /[A-Za-z0-9]/;

/**
 * 一句话里提到了词表里的哪些页：从左到右扫，每个位置上取词表里对得上的最长的词，对上就整个跳过去，
 * 所以「预约取书」被整个认走之后，里面的「预约」不会再被另一页认一次。英文字母与数字开头或结尾的词，要求前后不是字母或数字。
 * 一句里同一页只记一次；self 这一页自己不记（它的词照样占位）。返回 [被提到的页, 命中的词]，按出现的先后。
 */
export function mentionedIn(sentence: string, words: readonly TopicWord[], self: string | null = null): [string, string][] {
  // 同一个词可以属于几页；按词长从长到短排。
  const byWord = new Map<string, string[]>();
  for (const one of words) byWord.set(one.word, [...(byWord.get(one.word) ?? []), one.item_id]);
  const ordered = [...byWord.keys()].sort((a, b) => b.length - a.length);
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (let at = 0; at < sentence.length; ) {
    const hit = ordered.find((word) => sentence.startsWith(word, at)
      && !(WORD_CHAR.test(word[0]) && at > 0 && WORD_CHAR.test(sentence[at - 1]))
      && !(WORD_CHAR.test(word[word.length - 1]) && at + word.length < sentence.length && WORD_CHAR.test(sentence[at + word.length])));
    if (!hit) {
      at += 1;
      continue;
    }
    for (const page of byWord.get(hit)!) {
      if (page === self || seen.has(page)) continue;
      seen.add(page);
      out.push([page, hit]);
    }
    at += hit.length;
  }
  return out;
}

/** 一条提到：谁（哪个条目的哪个字段的第几项）在哪句话里用哪个词提到了一页；revision_no 是被提到的那一页现在的修订号。 */
export interface Mention {
  item_id: string;
  collection: string;
  field: string;
  /** 列表字段的第几项，从 0 起；文本字段是 null。 */
  index: number | null;
  word: string;
  sentence: string;
  revision_no: number;
}

/** 总体分析的页里要扫的三块；别的集合的条目扫全部文本字段与文本列表字段。 */
const PAGE_FIELDS: readonly string[] = [OVERALL_FIELDS.what, OVERALL_FIELDS.examples, OVERALL_FIELDS.settled];

/**
 * 整个任务里的提到，按被提到的页归好：页的编号 → 提到它的各处，按条目给出的先后、字段声明的先后、项的先后。
 * 任务定义里没有总体分析集合、或者没有一页贴了标签而在用时是空的。
 */
export function mentionsOf(collections: readonly CollectionShape[], items: readonly PlainItem[]): Map<string, Mention[]> {
  const out = new Map<string, Mention[]>();
  if (!hasOverall(collections)) return out;
  const words = topicWords(items);
  if (words.length === 0) return out;
  const revisionOf = new Map(items.map((one) => [one.item_id, one.revision_no]));
  for (const item of items) {
    const shape = collections.find((one) => one.name === item.collection);
    if (!shape) continue;
    for (const field of shape.fields) {
      if (field.type !== "文本" && field.type !== "文本列表") continue;
      if (item.collection === OVERALL_COLLECTION && !PAGE_FIELDS.includes(field.name)) continue;
      const value = item.fields[field.name];
      const parts: [number | null, string][] = typeof value === "string" ? [[null, value]]
        : Array.isArray(value) ? value.flatMap((one, n): [number, string][] => (typeof one === "string" ? [[n, one]] : [])) : [];
      for (const [index, text] of parts) {
        for (const sentence of sentencesOf(text)) {
          for (const [page, word] of mentionedIn(sentence, words, item.item_id)) {
            const list = out.get(page) ?? [];
            list.push({ item_id: item.item_id, collection: item.collection, field: field.name, index, word, sentence, revision_no: revisionOf.get(page)! });
            out.set(page, list);
          }
        }
      }
    }
  }
  return out;
}

/** 给评审看的主题清单最长多少个字符（按 UTF-16 码元计）；超过时从末尾省去，并写明还有几页没有列出。 */
export const TOPICS_LIMIT = 3000;

/**
 * 给评审者的【总体分析的主题】一节：贴了标签、在用的页，一行一页，写编号、标题与别名。评审拿它判断「条目里的专门名词有没有主题页」。
 * 任务定义里没有总体分析集合时不给这一节（返回空列表）。
 */
export function topicLines(collections: readonly { name: string }[], items: readonly PlainItem[], limit = TOPICS_LIMIT): string[] {
  if (!hasOverall(collections)) return [];
  const head = "【总体分析的主题】贴了标签、在用的主题，一行一页（标题，括号里是别名）：";
  const rows = items.filter((one) => one.collection === OVERALL_COLLECTION && isUsable(one.fields)).map((one) => {
    const title = typeof one.fields[OVERALL_FIELDS.title] === "string" ? (one.fields[OVERALL_FIELDS.title] as string).trim() : "";
    const aliases = texts(one.fields[OVERALL_FIELDS.aliases]).map((alias) => alias.trim());
    return `- ${one.item_id} ${title}${aliases.length ? `（又叫：${aliases.join("、")}）` : ""}`;
  });
  if (rows.length === 0) return [head, "（还没有贴了标签的主题。）"];
  const kept: string[] = [];
  let used = 0;
  for (const row of rows) {
    if (used + row.length + 1 > limit) break;
    kept.push(row);
    used += row.length + 1;
  }
  return [head, ...kept, ...(kept.length < rows.length ? [`（还有 ${rows.length - kept.length} 页没有列出。）`] : [])];
}

// ───────────── 保存一页时的两条核对 ─────────────

/** 一条来源支持哪几处：一处写字段名，指到列表字段的某一项时另写第几项（从 0 起）。空列表是支持整个条目。 */
type Supports = readonly { field: string; index?: number }[];

/**
 * 保存总体分析的一页时另外核对的两条，对的是改完之后的字段内容与来源。返回不对的地方，每处是 [事实, 怎么办]：
 * - 「改看」只在这一页已废弃时写：它指向取代这一页的那一页。
 * - 「已经定下的」每一条都要有出处：至少一条来源指到它（来源的 supports 里写这个字段与第几条；指到整个字段、
 *   或者不写 supports 表示整个条目都出自这条来源的，也算）。
 */
export function pageProblems(fields: Fields, sources: readonly { supports: Supports }[]): [string, string][] {
  const out: [string, string][] = [];
  const see = seeAlsoOf(fields);
  if (see !== null && !isDeprecated(fields)) {
    out.push([`「${OVERALL_FIELDS.seeAlso}」写了 ${see}，但这一页的${OVERALL_FIELDS.status}不是${STATUS_DEPRECATED}`,
      `「${OVERALL_FIELDS.seeAlso}」只在这一页不再用、由另一页取代时写：把${OVERALL_FIELDS.status}改成${STATUS_DEPRECATED}，或者去掉「${OVERALL_FIELDS.seeAlso}」`]);
  }
  const settled = texts(fields[OVERALL_FIELDS.settled]);
  const whole = sources.some((one) => one.supports.length === 0);
  settled.forEach((text, n) => {
    if (whole || sources.some((one) => one.supports.some((at) => at.field === OVERALL_FIELDS.settled && (at.index === undefined || at.index === n)))) return;
    const quoted = text.length > 20 ? `${text.slice(0, 20)}…` : text;
    out.push([`「${OVERALL_FIELDS.settled}」的第 ${n + 1} 条「${quoted}」没有出处`,
      `每一条已经定下的都要有出处：在它出自的那条来源的 supports 里写 {"field": "${OVERALL_FIELDS.settled}", "index": ${n}}；是你补的就加一条助手补充的来源并写理由`]);
  });
  return out;
}

// ───────────── 最低门 ─────────────

/** 最低门看一页的这几样：编号、贴没贴标签、在不在用、有几条例子、待不待核实。 */
export interface PageFacts {
  item_id: string;
  tagged: boolean;
  deprecated: boolean;
  examples: number;
  pending: boolean;
}

/** 从一页的字段内容与它待不待核实，取出最低门要看的几样。 */
export function pageFacts(itemId: string, fields: Fields, pending: boolean): PageFacts {
  return { item_id: itemId, tagged: tagsOf(fields).length > 0, deprecated: isDeprecated(fields), examples: texts(fields[OVERALL_FIELDS.examples]).length, pending };
}

/**
 * 最低门：任务里至少要有一页在用的主题贴了标签、有例子、又不待核实，才能往别的集合里新增条目。
 * 过得去返回 null；过不去返回一句事实，写明现在差的是什么（一页都没有，或者最接近的那一页差哪几样）。
 */
export function gateFact(pages: readonly PageFacts[]): string | null {
  const live = pages.filter((one) => !one.deprecated);
  if (live.some((one) => one.tagged && one.examples > 0 && !one.pending)) return null;
  const head = "还没有想清楚的主题";
  if (live.length === 0) return `${head}：总体分析里还没有一页主题`;
  // 最接近的一页：差得最少的，一样少时取编号在前的。
  const missing = (one: PageFacts) => [...(one.tagged ? [] : ["还没有贴标签"]), ...(one.examples > 0 ? [] : ["还没有例子"]), ...(one.pending ? ["还待核实"] : [])];
  const closest = [...live].sort((a, b) => missing(a).length - missing(b).length)[0];
  return `${head}：总体分析里还没有一页贴了标签、写了例子、又不待核实的主题（最接近的是 ${closest.item_id}，它${missing(closest).join("、")}）`;
}

/** 最低门过不去时「怎么办」那一句。 */
export const GATE_GUIDANCE = "先在总体分析里立一页主题，写一个例子并确认，再写条目";
