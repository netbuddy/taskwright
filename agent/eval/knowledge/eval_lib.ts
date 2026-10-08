/**
 * 知识库查找的轨迹评估：从助手的一条会话记录里量出它是怎样用知识库的，并对着一份期望（哪几处规定该被查到并引用）逐处分五级记账。
 * 只做计算与读文件，不调模型；命令行入口在 measure.ts，判分逻辑的测试在 backend/tests/knowledge_eval.test.ts。
 *
 * 量什么：
 * - 整份读大文档：read 读知识库里超过 bigBytes 的文件，而助手没有写 limit 或者写的 limit 超过 maxLines。
 * - 查找：search_knowledge 调了几次，每次的要找的话是不是一句完整的话（粗判），这一次是怎样找的、列了几个、多少字节。
 * - grep：对知识库目录调了几次；全部 grep 里有几次的返回被截短了。
 * - 知识库来源：每一条出处指向知识库的来源，摘录是不是逐字出自那份文档（照保存修订的规则算一次，去掉全部空白再算一次），
 *   所在的那次保存有没有成功。
 * - 每处期望的规定分五级：①进了候选（按意思的前几名或按字面的前两名）②被列给了助手（没有被字节上限去掉）③助手采用了
 *   （有一条知识库来源的摘录与这条规定重合）④引用得对（摘录逐字、supports 指到期望的字段）⑤保存成功。
 *   「查到了却没有用」记在③，与「没有查到」（①②）分开；期望之外的知识库来源另外逐条列出。
 * - 总量：工具调用次数、模型请求次数、单次请求的上下文最大值、用时、任务现状消息的字节数。
 *
 * 期望文件的格式：{ expectations: [{ id, title, document, sentence, library?, field? }] }。document 是知识库里的文档名，sentence 是
 * 这条规定里逐字的一句（用它认出规定在哪个片段、助手的摘录是不是引的这一条），field 是期望 supports 指到的字段名（不写就不查）。
 *
 * 这是评估工具，不是产品运行时的代码：它导入 backend/src 里与产品相同的实现（切分、关键词打分、候选规则），好让评估与产品算的是同一件事。
 * 安装包不带这个目录（release/build.mjs 只复制 agent/src 与 agent/prompts）；agent/src 与 backend/src 都不导入这里的任何东西。
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { chunkDocument, documentKind } from "../../../backend/src/knowledge_chunks.ts";
import { passageOf } from "../../../backend/src/knowledge_passage.ts";
import { placeExcerpt, projectionParagraphs } from "../../src/lib/docx_source.ts";
import { parseKnowledgeLocator } from "../../src/lib/knowledge_locator.ts";
import { lineEndsOnly } from "../../src/lib/save_revision.ts";
import { SEGMENT_DEFAULTS, type SegmentParams } from "../../src/lib/segments.ts";

type Dict = Record<string, any>;

export interface Expectation {
  id: string;
  title: string;
  document: string;
  sentence: string;
  library?: string;
  field?: string;
}

export interface MeasureOptions {
  knowledgeRoot: string;
  expectations: Expectation[];
  /** 助手的工作目录（任务目录）：相对路径按它解析。不给时相对路径不算知识库里的。 */
  cwd?: string;
  bigBytes?: number;
  maxLines?: number;
  params?: SegmentParams;
}

/** 一次工具调用连同它的结果。 */
export interface Call {
  id: string;
  tool: string;
  args: Dict;
  text: string;
  details: Dict | null;
  error: boolean;
}

const squeeze = (text: string) => text.replace(/\s+/g, "");
const bytesOf = (text: string) => Buffer.byteLength(text, "utf-8");
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && typeof (part as Dict).text === "string" ? (part as Dict).text : "")).join("") : "";

/** 会话文件的全文拆成条目：每行一条 JSON，读不出的行跳过。 */
export function sessionEntries(text: string): Dict[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as Dict];
    } catch {
      return [];
    }
  });
}

/** 会话里的全部工具调用，照先后；结果按调用编号配上。 */
export function toolCalls(entries: Dict[]): Call[] {
  const results = new Map<string, Dict>();
  for (const e of entries) if (e.type === "message" && e.message?.role === "toolResult") results.set(String(e.message.toolCallId ?? ""), e.message);
  const out: Call[] = [];
  for (const e of entries) {
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    for (const part of Array.isArray(e.message.content) ? e.message.content : []) {
      if (!part || part.type !== "toolCall") continue;
      const result = results.get(String(part.id ?? ""));
      out.push({ id: String(part.id ?? ""), tool: String(part.name ?? ""), args: part.arguments && typeof part.arguments === "object" ? part.arguments : {},
        text: textOf(result?.content), details: result?.details && typeof result.details === "object" ? result.details : null, error: result?.isError === true });
    }
  }
  return out;
}

/** 要找的话是不是一句完整的话（粗判）：不少于 10 个字，不含竖线，不是只由空格隔开的几个短词。 */
export function completeSentence(query: string): boolean {
  const text = query.trim();
  if (Array.from(text).length < 10 || text.includes("|")) return false;
  const words = text.split(/\s+/);
  return !(words.length >= 3 && words.every((word) => Array.from(word).length <= 4));
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** 知识库里的一份文档：在哪个知识库、文件在哪里、源文字（Word 文档是由它生成的那份文字）、切出来的片段。 */
interface KnowledgeDoc {
  library: string;
  name: string;
  path: string;
  bytes: number;
  source: string;
  chunks: ReturnType<typeof chunkDocument>;
}

const DERIVED = /\.(embeddings\.json|embeddings\.bin|docx\.md|docx\.txt|segments\.json)$|^\./;

/** 读出知识库根目录下各知识库 files/ 里的文档（派生文件不算），并照产品的切法切成片段。 */
export function knowledgeDocuments(root: string, params: SegmentParams = SEGMENT_DEFAULTS): KnowledgeDoc[] {
  const out: KnowledgeDoc[] = [];
  if (!existsSync(root)) return out;
  for (const library of readdirSync(root).sort()) {
    const files = join(root, library, "files");
    if (!existsSync(files) || !statSync(files).isDirectory()) continue;
    for (const name of readdirSync(files).sort()) {
      const path = join(files, name);
      if (DERIVED.test(name) || !statSync(path).isFile()) continue;
      const word = documentKind(name) === "word";
      const sourcePath = word ? `${path}.md` : path;
      if (!existsSync(sourcePath)) continue;
      const source = readFileSync(sourcePath, "utf-8").replace(/\r\n?/g, "\n");
      out.push({ library, name, path, bytes: statSync(path).size, source, chunks: chunkDocument(name, source, params) });
    }
  }
  return out;
}

/** 一句话在这份文档的第几个片段里（从 1 起）；找不到是 null。比较时去掉全部空白。 */
export function chunkIndexOf(doc: KnowledgeDoc, sentence: string): number | null {
  const want = squeeze(sentence);
  for (const chunk of doc.chunks) {
    const passage = passageOf(doc.name, chunk, doc.source);
    const text = passage.body ?? (passage.paragraphs ?? []).map((one) => one.text).join("");
    if (squeeze(text).includes(want)) return chunk.index;
  }
  return null;
}

/** 一条知识库来源的摘录是不是逐字出自那份文档：strict 照保存修订的规则，loose 去掉全部空白再比。 */
export function verbatim(doc: KnowledgeDoc, locator: string, excerpt: string): { strict: boolean; loose: boolean } {
  const loose = squeeze(excerpt) !== "" && squeeze(doc.source).includes(squeeze(excerpt));
  if (documentKind(doc.name) !== "word") return { strict: lineEndsOnly(doc.source).includes(lineEndsOnly(excerpt).trim()) && excerpt.trim() !== "", loose };
  const n = Number(/#p(\d+)$/.exec(locator)?.[1] ?? NaN);
  const paragraphs = projectionParagraphs(doc.source);
  return { strict: Number.isInteger(n) && placeExcerpt(paragraphs, n, excerpt).kind !== "miss", loose };
}

/** 一条知识库来源：出自哪次保存、那次保存成没成、出处、摘录、supports 指到的字段。 */
interface KnowledgeSource {
  call: string;
  saved: boolean;
  locator: string;
  document: string;
  library: string;
  excerpt: string;
  fields: string[];
}

function knowledgeSources(calls: Call[]): KnowledgeSource[] {
  const out: KnowledgeSource[] = [];
  for (const call of calls) {
    if (call.tool !== "save_revision") continue;
    for (const op of Array.isArray(call.args.operations) ? call.args.operations : []) {
      for (const source of Array.isArray(op?.sources) ? op.sources : []) {
        const locator = typeof source?.locator === "string" ? source.locator : "";
        const parsed = parseKnowledgeLocator(locator.replace(/#p\d+$/, ""));
        if (!parsed) continue;
        out.push({ call: call.id, saved: !call.error, locator, document: parsed.name, library: parsed.library, excerpt: String(source.excerpt ?? ""),
          fields: (Array.isArray(source.supports) ? source.supports : []).map((one: Dict) => String(one?.field ?? "")).filter(Boolean) });
      }
    }
  }
  return out;
}

export interface LevelRow {
  id: string;
  title: string;
  /** 这条规定在文档的第几个片段；文档不在知识库里、或者那句话在文档里找不到时是 null（五级都记假）。 */
  chunk: number | null;
  candidate: boolean;
  returned: boolean;
  adopted: boolean;
  cited_correctly: boolean;
  saved: boolean;
}

export interface Measures {
  large_reads: { whole: number; calls: { path: string; offset: number | null; limit: number | null; whole: boolean }[] };
  searches: { count: number; complete_sentences: number; calls: { query: string; limit: number | null; complete_sentence: boolean; mode: string | null; shown: number | null; bytes: number }[] };
  grep: { on_knowledge: number; capped: number; total: number };
  sources: { total: number; strict: number; loose: number; saved: number; rows: { locator: string; excerpt: string; strict: boolean; loose: boolean; saved: boolean; expected: string | null }[] };
  levels: LevelRow[];
  level_totals: { expected: number; candidate: number; returned: number; adopted: number; cited_correctly: number; saved: number };
  totals: { tool_calls: number; model_requests: number; max_context: number; seconds: number | null; status_message_bytes: number };
}

/** 从一条会话的条目里量出全部度量。 */
export function measure(entries: Dict[], options: MeasureOptions): Measures {
  const bigBytes = options.bigBytes ?? 4096;
  const maxLines = options.maxLines ?? 120;
  const root = real(resolve(options.knowledgeRoot));
  const docs = knowledgeDocuments(root, options.params);
  const calls = toolCalls(entries);
  const absolute = (path: unknown): string | null => {
    if (typeof path !== "string" || !path) return options.cwd ? real(resolve(options.cwd)) : null;
    if (isAbsolute(path)) return real(resolve(path));
    return options.cwd ? real(resolve(options.cwd, path)) : null;
  };
  const inside = (path: string) => path === root || path.startsWith(root + sep);

  // 整份读大文档。
  const reads = calls.filter((call) => call.tool === "read").flatMap((call) => {
    const path = absolute(call.args.path);
    const doc = path && inside(path) ? docs.find((one) => one.path === path || `${one.path}.md` === path) : undefined;
    if (!path || !doc || statSync(path).size <= bigBytes) return [];
    const limit = typeof call.args.limit === "number" ? call.args.limit : null;
    return [{ path: `${doc.library}/${doc.name}`, offset: typeof call.args.offset === "number" ? call.args.offset : null, limit, whole: limit === null || limit > maxLines }];
  });

  // 查找。
  const searches = calls.filter((call) => call.tool === "search_knowledge");
  const searchRows = searches.map((call) => ({
    query: String(call.args.query ?? ""), limit: typeof call.args.limit === "number" ? call.args.limit : null, complete_sentence: completeSentence(String(call.args.query ?? "")),
    mode: typeof call.details?.mode === "string" ? call.details.mode : null, shown: typeof call.details?.shown === "number" ? call.details.shown : null, bytes: bytesOf(call.text),
  }));

  // grep。
  const greps = calls.filter((call) => call.tool === "grep");
  const grepOnKnowledge = greps.filter((call) => {
    const scope = absolute(call.args.path);
    return scope !== null && (inside(scope) || root.startsWith(scope === sep ? sep : scope + sep));
  }).length;

  // 知识库来源。
  const sources = knowledgeSources(calls);
  const docOf = (library: string, name: string) => docs.find((one) => one.library === library && one.name === name);
  const checked = sources.map((source) => {
    const doc = docOf(source.library, source.document);
    return { source, doc, ...(doc ? verbatim(doc, source.locator, source.excerpt) : { strict: false, loose: false }) };
  });

  // 五级。
  const refs = (list: unknown): Dict[] => (Array.isArray(list) ? list : []);
  const levels: LevelRow[] = options.expectations.map((expected) => {
    const doc = docs.find((one) => one.name === expected.document && (!expected.library || one.library === expected.library));
    const chunk = doc ? chunkIndexOf(doc, expected.sentence) : null;
    const is = (ref: Dict) => doc !== undefined && chunk !== null && ref.library === doc.library && ref.name === doc.name && ref.index === chunk;
    const candidate = searches.some((call) => [...refs(call.details?.candidates?.semantic), ...refs(call.details?.candidates?.keyword), ...refs(call.details?.hits)].some(is));
    const returned = searches.some((call) => refs(call.details?.hits).slice(0, typeof call.details?.shown === "number" ? call.details.shown : undefined).some(is));
    const want = squeeze(expected.sentence);
    const mine = checked.filter(({ source }) => {
      const got = squeeze(source.excerpt);
      return doc !== undefined && source.document === doc.name && source.library === doc.library && got !== "" && (got.includes(want) || want.includes(got));
    });
    const correct = mine.filter((one) => one.strict && (!expected.field || one.source.fields.includes(expected.field)));
    return { id: expected.id, title: expected.title, chunk, candidate, returned, adopted: mine.length > 0, cited_correctly: correct.length > 0, saved: correct.some((one) => one.source.saved) };
  });
  const expectedOf = (one: (typeof checked)[number]): string | null => {
    const got = squeeze(one.source.excerpt);
    return options.expectations.find((expected) => expected.document === one.source.document && got !== "" && (got.includes(squeeze(expected.sentence)) || squeeze(expected.sentence).includes(got)))?.id ?? null;
  };

  // 总量。
  const assistants = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
  const context = assistants.map((e) => {
    const usage = e.message.usage ?? {};
    return (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0);
  });
  const stamps = entries.map((e) => Date.parse(String(e.timestamp ?? ""))).filter((ms) => Number.isFinite(ms));
  const status = entries.find((e) => e.type === "custom_message" && e.customType === "taskwright-task-status");
  const count = (key: keyof LevelRow) => levels.filter((row) => row[key] === true).length;
  return {
    large_reads: { whole: reads.filter((one) => one.whole).length, calls: reads },
    searches: { count: searches.length, complete_sentences: searchRows.filter((one) => one.complete_sentence).length, calls: searchRows },
    grep: { on_knowledge: grepOnKnowledge, capped: greps.filter((call) => call.details?.capped).length, total: greps.length },
    sources: {
      total: checked.length, strict: checked.filter((one) => one.strict).length, loose: checked.filter((one) => one.loose).length, saved: checked.filter((one) => one.source.saved).length,
      rows: checked.map((one) => ({ locator: one.source.locator, excerpt: one.source.excerpt, strict: one.strict, loose: one.loose, saved: one.source.saved, expected: expectedOf(one) })),
    },
    levels,
    level_totals: { expected: levels.length, candidate: count("candidate"), returned: count("returned"), adopted: count("adopted"), cited_correctly: count("cited_correctly"), saved: count("saved") },
    totals: {
      tool_calls: calls.length, model_requests: assistants.length, max_context: Math.max(0, ...context),
      seconds: stamps.length >= 2 ? Math.round((Math.max(...stamps) - Math.min(...stamps)) / 100) / 10 : null,
      status_message_bytes: status ? bytesOf(textOf(status.content)) : 0,
    },
  };
}

/** 度量写成给人看的几行。 */
export function summaryLines(m: Measures): string[] {
  const t = m.level_totals;
  return [
    `期望的规定 ${t.expected} 处：进了候选 ${t.candidate}，列给了助手 ${t.returned}，助手采用了 ${t.adopted}，引用得对 ${t.cited_correctly}，保存成功 ${t.saved}。`,
    ...m.levels.filter((row) => !row.saved).map((row) => `  ${row.id} ${row.title}：${row.chunk === null ? "期望里的那句话在知识库里找不到" : !row.candidate ? "没有进候选" : !row.returned ? "进了候选，没有列给助手" : !row.adopted ? "列给了助手，没有采用" : !row.cited_correctly ? "采用了，引用得不对" : "引用得对，没有保存成功"}。`),
    `查找 ${m.searches.count} 次，其中要找的话是一句完整的话 ${m.searches.complete_sentences} 次；整份读大文档 ${m.large_reads.whole} 次；grep 知识库 ${m.grep.on_knowledge} 次，grep 的返回被截短 ${m.grep.capped} 次（一共 ${m.grep.total} 次）。`,
    `知识库来源 ${m.sources.total} 条：照保存修订的规则逐字 ${m.sources.strict} 条，去掉空白后逐字 ${m.sources.loose} 条，所在的保存成功 ${m.sources.saved} 条；期望之外的 ${m.sources.rows.filter((row) => row.expected === null).length} 条。`,
    `工具调用 ${m.totals.tool_calls} 次，模型请求 ${m.totals.model_requests} 次，单次请求的上下文最大 ${m.totals.max_context}，用时 ${m.totals.seconds ?? "不详"} 秒，任务现状消息 ${m.totals.status_message_bytes} 字节。`,
  ];
}
