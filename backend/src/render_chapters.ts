/**
 * 生成文档里的「业务说明」七章与追溯附录：把总体分析的页、问题条目与图排成与页面同一个结构的 Markdown。纯读取，不写库，不经模型。
 *
 * 章与节号用页面目录的同一个函数（agent/src/lib/overall_chapters.ts），图放在哪里、角色与用例对照表怎样算用页面的同一条规则
 * （agent/src/lib/overall_figures.ts），规则表、目标树、决策记录与待澄清事项用页面的同一份算法（agent/src/lib/overall_views.ts）。
 *
 * 七章各放什么：
 *   1 概述与范围：章导语；系统边界图；业务目标摘要（目标树的前两层）；范围、假设各节。
 *   2 角色：章导语；角色与用例对照表（写明依据哪一张用例图）；各角色节。
 *   3 业务流程：章导语；每个流程一节。
 *   4 业务对象：章导语；对象关系图；各对象节；章末术语表（标签含「概念」的在用页，不论它排在哪一章）。
 *   5 业务规则：章导语；规则表，相互冲突的规则标出来。
 *   6 业务目标：章导语；目标树，挂在目标下的决定带着为什么这样决定；各目标、决定节。
 *   7 决策记录与待澄清事项：章导语；决定与还没有了结的问题按时间排的一张表。
 * 一节从上到下的各块次序固定，没有内容的不写：说明、流程步骤（图）、状态图、异常分支、示例、适用规则、待澄清事项、其他图、
 * 对应的需求条目、来源。
 *
 * 文档按某一次修订生成时，页与问题条目取那次修订时的内容；图取它现在的内容（图有自己的修订，库里没有记「那次修订时图是什么样」）。
 * 已废弃的页、没有贴标签的页不进这七章。只收被选中的条目：没有选中的页不成节，没有选中的需求条目不列在「对应的需求条目」与附录里。
 * 还没有了结的待澄清事项前面写【待澄清】，带着「待定」标记的句子前面写【待定】。
 * 图写成带图编号的代码块（```mermaid 图编号），页面预览把它画出来，Word 文件里换成图片。
 */

import { diagramGraph } from "../../agent/src/lib/diagram_scan.ts";
import { OVERALL_COLLECTION, OVERALL_FIELDS, EXCEPTION_EXAMPLE_PREFIX, isDeprecated, tagsOf, type PlainItem } from "../../agent/src/lib/overall_analysis.ts";
import {
  CHAPTER_DECISIONS, CHAPTER_FLOWS, CHAPTER_GOALS, CHAPTER_OBJECTS, CHAPTER_OVERVIEW, CHAPTER_ROLES, CHAPTER_RULES, GLOSSARY_NAME, LABEL_CONCEPT,
  chapterLayout, chapterPage,
} from "../../agent/src/lib/overall_chapters.ts";
import { type FigureSlot, KIND_CLASS, KIND_CONTEXT, KIND_USE_CASE, figureSlot, useCaseMatrix } from "../../agent/src/lib/overall_figures.ts";
import type { GoalNode } from "../../agent/src/lib/overall_views.ts";
import { QUESTION_BLOCKING, QUESTION_BLOCKING_FIELD, QUESTION_KEEP_STATUS, QUESTION_OPEN_STATUS, hasPendingMark } from "../../agent/src/lib/stage.ts";
import { type Library, titleOf } from "./library.ts";

type Dict = Record<string, any>;

/** 模板里的三个占位。 */
export const TOC_SLOT = "{{目录}}", CHAPTERS_SLOT = "{{业务说明}}", TRACE_SLOT = "{{追溯附录}}";
export const TOC_TITLE = "目录", TRACE_TITLE = "附录 追溯";
/** 文档里两种记号。 */
export const OPEN_MARK = "【待澄清】", PENDING_MARK_TEXT = "【待定】";
const RESOLVED_STATUS = "已解决";
const REVISIT_FIELD = "何时回看", LANDED_FIELD = "落实到";
const SOURCE_ITEM = "条目", SOURCE_FIGURE = "图";

/** 被选中的条目：集合名 → [条目编号, 它在文档那次修订时的内容修订号]，已按编号排。 */
export type Chosen = Map<string, [string, number][]>;

export interface ChapterHelpers {
  /** 条目标题后面方括号里的那一段：「修订 N · 确认状态」。 */
  mark: (itemId: string, revisionNo: number) => string;
  /** 条目的来源写成一句话。 */
  sources: (itemId: string, revisionNo: number) => string;
}

export interface ChaptersResult {
  /** 七章的 Markdown；任务没有总体分析这个集合、或者一页都没有选中时是空文字。 */
  text: string;
  /** 各页在文档里的叫法：「3.1 自助借书」。只有编了节号的页在里面。 */
  sectionLabel: Map<string, string>;
  /** 文档里放进了哪几张图（图的编号），照出现的先后。 */
  figures: string[];
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string" && one.trim() !== "").map((one) => one.trim()) : []);
/** 表格的一格：竖线转义，换行换成空格；空的写一个短横。 */
const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim() || "—";
const table = (head: string[], rows: string[][]): string =>
  [`| ${head.map(cell).join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
/** 带着「待定」标记的句子前面加记号。 */
const marked = (sentence: string): string => (hasPendingMark(sentence) ? `${PENDING_MARK_TEXT}${sentence}` : sentence);
const paragraphs = (value: string): string => value.split(/\n\s*\n/).map((one) => one.trim().replace(/\s*\n\s*/g, " ")).filter(Boolean).map(marked).join("\n\n");

/**
 * 排出七章。chosen 是文档这一次选中的条目；lib 是任务库。
 */
export function businessDescription(lib: Library, chosen: Chosen, helpers: ChapterHelpers): ChaptersResult {
  const empty: ChaptersResult = { text: "", sectionLabel: new Map(), figures: [] };
  if (!lib.collections.has(OVERALL_COLLECTION)) return empty;
  const fieldsAt = (itemId: string, no: number): Dict => (lib.fieldsOf(itemId, no) ?? {}) as Dict;
  const pages = (chosen.get(OVERALL_COLLECTION) ?? []).map(([item_id, revision_no]) => ({ item_id, revision_no, fields: fieldsAt(item_id, revision_no) }))
    .filter((one) => !isDeprecated(one.fields));
  if (pages.length === 0) return empty;
  const pageOf = new Map(pages.map((one) => [one.item_id, one]));
  const title = (itemId: string): string => text(pageOf.get(itemId)?.fields[OVERALL_FIELDS.title]) || itemId;

  // 问题条目：状态字段的取值里有「用户决定保留」的集合。关联条目取它的条目引用字段。
  const questionCollections = new Map<string, { status: string; refs: string[] }>();
  for (const [name, collection] of lib.collections) {
    const fields = (collection["字段"] ?? []) as Dict[];
    const status = fields.find((f) => f["类型"] === "枚举" && (f["取值"] ?? []).includes(QUESTION_KEEP_STATUS));
    if (status) questionCollections.set(name, { status: status["名"], refs: fields.filter((f) => f["类型"] === "条目引用").map((f) => f["名"]) });
  }
  const questions = [...questionCollections].flatMap(([name, shape]) => (chosen.get(name) ?? []).map(([item_id, revision_no]) => {
    const fields = fieldsAt(item_id, revision_no);
    return { item_id, collection: name, revision_no, fields, subject: titleOf(fields, lib.collections.get(name)) || item_id,
      status: text(fields[shape.status]), refs: shape.refs.flatMap((field) => texts(fields[field])) };
  }));
  const questionsOn = (itemId: string) => questions.filter((one) => one.refs.includes(itemId));

  // 需求条目：总体分析与问题集合之外被选中的条目，连同它当前内容上的来源。
  const requirements = [...chosen].filter(([name]) => name !== OVERALL_COLLECTION && !questionCollections.has(name)).flatMap(([name, rows]) => rows.map(([item_id, revision_no]) => ({
    item_id, collection: name, title: titleOf(fieldsAt(item_id, revision_no), lib.collections.get(name)) || item_id, sources: lib.sourcesOf(item_id, revision_no),
  })));
  const requirementsOn = (itemId: string) => requirements.filter((one) => one.sources.some((source) => source.kind === SOURCE_ITEM && source.locator === itemId));

  // 章与节号。
  const layout = chapterLayout(pages.map((one) => chapterPage(one.item_id, one.fields)));
  const chapterOf = new Map<string, number>();
  const sectionLabel = new Map<string, string>();
  const order: string[] = [];
  for (const one of layout.chapters) {
    for (const section of one.sections) {
      chapterOf.set(section.item_id, one.chapter.no);
      order.push(section.item_id);
      if (section.no) sectionLabel.set(section.item_id, `${section.no} ${title(section.item_id)}`);
    }
  }

  // 图：还在的图现在的内容；来源页照目录从上到下排。
  const prefixes = [...lib.collections.values()].map((one) => String(one["编号前缀"]));
  const diagrams = lib.diagramsView().map((row) => {
    const view = lib.diagramView(row.diagram_id)!;
    const sources = view.sources.filter((source) => source.kind === SOURCE_ITEM && chapterOf.has(source.locator)).map((source) => source.locator)
      .filter((id, i, all) => all.indexOf(id) === i).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return { diagram_id: row.diagram_id, name: row.name, kind: row.kind, revision_at: row.revision_at ?? "", mermaid: view.mermaid as string, sources };
  }).sort((a, b) => (a.revision_at === b.revision_at ? 0 : a.revision_at < b.revision_at ? 1 : -1) || b.diagram_id.localeCompare(a.diagram_id, "en", { numeric: true }));
  type Figure = (typeof diagrams)[number];
  const figures: string[] = [];
  /** 一处的图：第一张画出来，其余的写明另有哪几张。 */
  const figureBlock = (label: string, rows: Figure[]): string[] => {
    if (rows.length === 0) return [];
    const [first, ...rest] = rows;
    figures.push(first.diagram_id);
    const out = [`**${label}**（${first.diagram_id} ${first.name}）`, `\`\`\`mermaid ${first.diagram_id}\n${first.mermaid.replace(/\s+$/, "")}\n\`\`\``];
    if (rest.length > 0) out.push(`另有 ${rest.length} 张同一处的图没有放进文档：${rest.map((one) => `${one.diagram_id} ${one.name}`).join("、")}。`);
    return out;
  };
  const figuresOfKind = (kind: string) => diagrams.filter((one) => one.kind === kind);
  const figuresIn = (itemId: string): Record<FigureSlot, Figure[]> => {
    const out: Record<FigureSlot, Figure[]> = { steps: [], state: [], relations: [], other: [] };
    for (const one of diagrams) {
      if (!one.sources.includes(itemId)) continue;
      const slot = figureSlot(one.kind, chapterOf.get(itemId) ?? null, one.sources.map((id) => chapterOf.get(id) ?? null), one.sources[0] === itemId);
      if (slot) out[slot].push(one);
    }
    return out;
  };

  // 三张派生的表。
  const plain: PlainItem[] = [...pages.map((one) => ({ item_id: one.item_id, collection: OVERALL_COLLECTION, revision_no: one.revision_no, fields: one.fields })),
    ...questions.map((one) => ({ item_id: one.item_id, collection: one.collection, revision_no: one.revision_no, fields: one.fields }))];
  const views = lib.overallViews(plain);

  /** 一节：标题一行，下面各块照固定的次序，没有内容的不写。 */
  const section = (itemId: string, no: string | null): string[] => {
    const page = pageOf.get(itemId)!;
    const fields = page.fields;
    const out = [`### ${no ? `${no} ` : ""}${title(itemId)} ［修订 ${page.revision_no} · ${helpers.mark(itemId, page.revision_no)}］`];
    const what = text(fields[OVERALL_FIELDS.what]);
    out.push(what ? paragraphs(what) : "这一节还没有写说明。");
    const figs = figuresIn(itemId);
    out.push(...figureBlock("流程步骤", figs.steps), ...figureBlock("状态图", figs.state));
    if (figs.relations.length > 0) out.push(`**与其他对象的关系**见第 ${CHAPTER_OBJECTS} 章章首的对象关系图（${figs.relations[0].diagram_id} ${figs.relations[0].name}）。`);
    const examples = texts(fields[OVERALL_FIELDS.examples]);
    const exceptions = examples.filter((one) => one.startsWith(EXCEPTION_EXAMPLE_PREFIX)).map((one) => one.slice(EXCEPTION_EXAMPLE_PREFIX.length).trim());
    const others = examples.filter((one) => !one.startsWith(EXCEPTION_EXAMPLE_PREFIX));
    if (exceptions.length > 0) out.push("**异常分支**", exceptions.map((one) => `- ${marked(one)}`).join("\n"));
    if (others.length > 0) out.push("**示例**", others.map((one) => `- ${marked(one)}`).join("\n"));
    const settled = texts(fields[OVERALL_FIELDS.settled]);
    if (settled.length > 0) out.push("**适用规则**", settled.map((one, n) => `${n + 1}. ${marked(one)}`).join("\n"));
    const asked = questionsOn(itemId);
    const open = asked.filter((one) => one.status === QUESTION_OPEN_STATUS);
    const closed = asked.filter((one) => one.status === RESOLVED_STATUS);
    if (open.length + closed.length > 0) {
      // 阻断下游的排在前面，与页面一致。
      const blocking = (one: (typeof asked)[number]) => text(one.fields[QUESTION_BLOCKING_FIELD]) === QUESTION_BLOCKING;
      const lines = [...open.filter(blocking), ...open.filter((one) => !blocking(one))].map((one) => {
        const kind = QUESTION_BLOCKING_FIELD in one.fields ? `（${blocking(one) ? QUESTION_BLOCKING : "不阻断"}${!blocking(one) && text(one.fields[REVISIT_FIELD]) ? `，${text(one.fields[REVISIT_FIELD])}回看` : ""}）` : "";
        return `- ${OPEN_MARK}${kind}${one.subject}（${one.item_id}）`;
      });
      lines.push(...closed.map((one) => `- 已了结：${one.subject}（${one.item_id}）${text(one.fields[LANDED_FIELD]) ? `　落实到：${text(one.fields[LANDED_FIELD])}` : ""}`));
      out.push("**待澄清事项**", lines.join("\n"));
    }
    out.push(...figureBlock("其他图", figs.other));
    const based = requirementsOn(itemId);
    if (based.length > 0) out.push("**对应的需求条目**", based.map((one) => `- ${one.item_id} ${one.title}`).join("\n"));
    out.push(`来源：${helpers.sources(itemId, page.revision_no)}`);
    return out;
  };

  const out: string[] = [];
  for (const one of layout.chapters) {
    const no = one.chapter.no;
    out.push(`## ${no} ${one.chapter.name}`);
    const before = out.length;
    if (one.intro) {
      const page = pageOf.get(one.intro)!;
      const words = text(page.fields[OVERALL_FIELDS.what]);
      if (words) out.push(`${paragraphs(words)} ［修订 ${page.revision_no} · ${helpers.mark(one.intro, page.revision_no)}］`);
    }
    if (no === CHAPTER_OVERVIEW) {
      out.push(...figureBlock("系统边界图", figuresOfKind(KIND_CONTEXT)));
      if (views.goals.roots.length > 0) {
        out.push("**业务目标摘要**", views.goals.roots.map((root) => [`- ${root.title}`, ...root.goals.map((goal) => `  - ${goal.title}`)].join("\n")).join("\n"));
      }
    }
    if (no === CHAPTER_ROLES) {
      const roles = one.sections.map((s) => ({ item_id: s.item_id, title: title(s.item_id) }));
      const charts = figuresOfKind(KIND_USE_CASE);
      const known = (id: string) => pageOf.has(id) || requirements.some((r) => r.item_id === id);
      const rows = useCaseMatrix(roles, charts.map((chart) => diagramGraph(chart.mermaid, prefixes)), known);
      if (rows.length > 0) {
        const flowsOf = (itemId: string | null): string => {
          if (!itemId) return "";
          if (chapterOf.get(itemId) === CHAPTER_FLOWS) return sectionLabel.get(itemId) ?? title(itemId);
          const cited = requirements.find((r) => r.item_id === itemId)?.sources.filter((s) => s.kind === SOURCE_ITEM && chapterOf.get(s.locator) === CHAPTER_FLOWS).map((s) => s.locator) ?? [];
          return cited.filter((id, i, all) => all.indexOf(id) === i).map((id) => sectionLabel.get(id) ?? title(id)).join("、");
        };
        const labelOf = (row: (typeof rows)[number]): string =>
          (row.item_id ? (pageOf.has(row.item_id) ? title(row.item_id) : `${row.item_id} ${requirements.find((r) => r.item_id === row.item_id)!.title}`) : row.text);
        out.push("**角色与用例对照**", table(["用例", ...roles.map((role) => role.title), "所属流程"], rows.map((row) => [labelOf(row), ...row.cells, flowsOf(row.item_id)])),
          `依据用例图：${charts.map((chart) => `${chart.diagram_id} ${chart.name}`).join("、")}。`);
      }
    }
    if (no === CHAPTER_OBJECTS) out.push(...figureBlock("对象关系图", figuresOfKind(KIND_CLASS)));
    if (no === CHAPTER_RULES) {
      if (views.rules.rows.length > 0) {
        const where = (row: (typeof views.rules.rows)[number]) => sectionLabel.get(row.item_id) ?? row.title;
        out.push(table(["规则", "出自", "冲突"], views.rules.rows.map((row) => [marked(row.text), where(row), row.conflicts.length > 0 ? `与别的规则冲突（${row.conflicts.join("、")}）` : ""])));
        if (views.rules.conflicts.length > 0) out.push(`${OPEN_MARK}有 ${views.rules.conflicts.length} 处规则冲突还没有了结：${views.rules.conflicts.join("、")}。`);
      }
    }
    if (no === CHAPTER_GOALS) {
      const lines: string[] = [];
      const walk = (node: GoalNode, depth: number) => {
        lines.push(`${"  ".repeat(depth)}- ${node.title}`);
        for (const decision of node.decisions) lines.push(`${"  ".repeat(depth + 1)}- 决定：${decision.title}${decision.why ? `（${decision.why}）` : ""}`);
        for (const goal of node.goals) walk(goal, depth + 1);
      };
      for (const root of views.goals.roots) walk(root, 0);
      for (const decision of views.goals.loose) lines.push(`- 决定（没有挂到目标下）：${decision.title}${decision.why ? `（${decision.why}）` : ""}`);
      if (lines.length > 0) out.push("**目标与决定**", lines.join("\n"));
    }
    if (no === CHAPTER_DECISIONS && views.decisions.length > 0) {
      out.push(table(["时间", "类别", "事项", "说明"], views.decisions.map((row) => [
        row.at ? row.at.slice(0, 16).replace("T", " ") : "", row.entry === "decision" ? "决定" : row.question_kind ?? "问题",
        row.entry === "question" ? `${OPEN_MARK}${row.title}（${row.item_id}）` : row.title, row.note,
      ])));
    }
    for (const s of one.sections) {
      // 已废弃的页前面已经去掉了；这里的节都编了号。
      out.push(...section(s.item_id, s.no));
    }
    if (one.glossaryNo) {
      const terms = pages.filter((page) => tagsOf(page.fields).includes(LABEL_CONCEPT));
      out.push(`### ${one.glossaryNo} ${GLOSSARY_NAME}`, table(["术语", "又叫", "说明"], terms.map((page) => [
        title(page.item_id), texts(page.fields[OVERALL_FIELDS.aliases]).join("、"), text(page.fields[OVERALL_FIELDS.what]).split(/\n\s*\n/)[0] ?? "",
      ])));
    }
    if (out.length === before) out.push("这一章还没有内容。");
  }
  return { text: `${out.join("\n\n")}\n`, sectionLabel, figures };
}

/**
 * 追溯附录：每个被选中的需求条目依据了哪几节、哪几张图。一个需求条目都没有选中时是空文字。
 */
export function traceAppendix(lib: Library, chosen: Chosen, sectionLabel: ReadonlyMap<string, string>): string {
  const skip = new Set<string>([OVERALL_COLLECTION]);
  for (const [name, collection] of lib.collections) {
    if (((collection["字段"] ?? []) as Dict[]).some((f) => f["类型"] === "枚举" && (f["取值"] ?? []).includes(QUESTION_KEEP_STATUS))) skip.add(name);
  }
  const names = new Map(lib.diagramsView().map((row) => [row.diagram_id, row.name]));
  const rows: string[][] = [];
  for (const [name] of lib.collections) {
    if (skip.has(name)) continue;
    for (const [itemId, no] of chosen.get(name) ?? []) {
      const sources = lib.sourcesOf(itemId, no);
      const uniq = (list: string[]) => list.filter((one, i, all) => all.indexOf(one) === i);
      const pages = uniq(sources.filter((s) => s.kind === SOURCE_ITEM).map((s) => sectionLabel.get(s.locator) ?? s.locator));
      const charts = uniq(sources.filter((s) => s.kind === SOURCE_FIGURE).map((s) => `${s.locator}${names.has(s.locator) ? ` ${names.get(s.locator)}` : ""}`));
      rows.push([`${itemId} ${titleOf((lib.fieldsOf(itemId, no) ?? {}) as Dict, lib.collections.get(name)) || ""}`.trim(), pages.join("、"), charts.join("、")]);
    }
  }
  if (rows.length === 0) return "";
  return `## ${TRACE_TITLE}\n\n每个需求条目依据了业务说明的哪几节、哪几张图。\n\n${table(["需求条目", "依据的节", "依据的图"], rows)}\n`;
}

/** 目录：文档里二级、三级标题的清单（不含目录自己）。没有标题时是空文字。 */
export function tableOfContents(document: string): string {
  const lines: string[] = [];
  let fenced = false;
  for (const line of document.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    const m = /^(##|###) (.+?)(?: ［.*］)?$/.exec(line);
    if (!m || m[2] === TOC_TITLE) continue;
    lines.push(`${m[1] === "###" ? "  " : ""}- ${m[2]}`);
  }
  return lines.length > 0 ? `## ${TOC_TITLE}\n\n${lines.join("\n")}\n` : "";
}
