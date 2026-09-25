/**
 * 「请求评审」的核心逻辑：用户在界面上点「评审」（扩展命令 /tw-user 的 request_review），或用户在对话里要求、执行者调用
 * 请求评审工具时用它。每个条目装配一次评审者调用（一次不带工具的模型调用，干净上下文），发现与结论由这里的代码写进库。
 * 执行者自己写不了评审记录。分三步，模型调用夹在中间、不在事务里（事务里不能 await）：
 *   1. prepareReviews：只读核对并装配每个条目的提示——该集合实际要评的规则清单（编号、级别、条文、反例、正例）、
 *      字段声明、条目当前所在修订下的全部字段与来源；
 *   2. 调用方调模型，parseReview 解析与核对输出：每条发现必须引用清单里的规则编号、指到声明过的字段与存在的项，
 *      必选规则的发现必须给建议；不合格就重来一次。模型不输出结论；
 *   3. writeReview：在立即事务里再核对一次修订号，按发现的规则级别算出结论（有任一必选规则的发现即不合规，
 *      否则合规；可选规则的发现只是建议，不影响结论），写评审、评审发现、模型调用、事件。
 * 评审没有完成（超时、调用失败、两次输出都不合格、评审期间条目被改）时 writeUnfinished 只记模型调用与一条
 * REVIEW_UNFINISHED 事件，不写合规与否。
 *
 * 规则指纹与重评：每条评审记录带规则指纹（lib/review_state.ts）、评审者提示词的哈希与所属批次（发起它的调用编号）。
 * 「待评审」是条目当前所在的修订在当前规则下还没有评审记录；不点名时只评这些。点名的条目在当前规则下已经评过、
 * 内容与规则都没变时，只有带 force（用户在界面上点了「仍要重评」）才再评，这一次记 forced；否则整批拒绝并说明是第几次评审评过的。
 * 每一批评审结束时记一条 REVIEW_BATCH 摘要事件（review_run.ts）。
 *
 * 材料：任务材料总长（全部材料文件的字符数）不超过 MATERIAL_FULL_LIMIT 时，评审者拿到材料全文；超过时只拿到这个条目的
 * 文档原文来源所在的自然段，并写明看到的不是材料全文。
 *
 * 规则从哪里来：任务定义里每个集合可以写一项「评审规矩」，指向一份规则文件（相对任务目录），可以关闭某些可选规则、
 * 把某些可选规则升为必选（definition.ts 的 effectiveRules）。没写的集合（旧任务目录）只按字段声明评，
 * 这时清单里只有一条内置规则 FIELD_RULE。不评哪些：不点名时，只评完成条件里要求「每个条目评审通过」的那些集合里、
 * 当前所在的修订还没有任何评审记录的条目；点名的条目也必须在这样的集合里。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ACTOR_EXECUTOR, databasePath, emit, wallClockText } from "./db.ts";
import { withTaskDatabase } from "./schema.ts";
import { extractJson, type ModelCallRecord } from "./model_call.ts";
import { RULE_REQUIRED, type ReviewRule, effectiveRules, validateDefinition } from "./definition.ts";
import { batchNumber, currentReviews, rulesHash } from "./review_state.ts";
import { listMaterials } from "./task_status.ts";

/** 材料全文给评审者的上限：全部材料文件的字符数不超过它时给全文。 */
export const MATERIAL_FULL_LIMIT = 20000;

export const REVIEW_PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "review.md");
export const EVENT_REVIEW_RECORDED = "REVIEW_RECORDED";
export const EVENT_REVIEW_UNFINISHED = "REVIEW_UNFINISHED";
/** 完成条件里要求评审的那个条件名：不点名时按它挑集合，点名的条目也要在这样的集合里。 */
export const REVIEW_CONDITION = "每个条目评审通过";
/** 集合没有写「评审规矩」时（旧任务目录）清单里唯一的一条规则：只按字段声明评。 */
export const FIELD_RULE: ReviewRule = {
  编号: "字段声明",
  级别: RULE_REQUIRED,
  条文: "必填字段必须有内容；枚举字段只能取字段声明里列出的值之一。",
  反例: "必填的字段是空的。",
  正例: "每个必填字段都有内容。",
};

export class ReviewError extends Error {}

export interface RequestedItem { item_id: string; revision_no: number }
export interface FieldDecl { 名: string; 类型: string; 必填?: boolean; 取值?: string[] }
/** 一条发现：依据的规则编号与这次的级别（必选的发现叫问题，可选的叫建议）、字段、列表型字段的第几项（从 0 起）、问题、建议。 */
export interface Finding { rule_id: string | null; level: string | null; field: string; index: number | null; problem: string; suggestion: string | null }

export interface PreparedReview extends RequestedItem {
  collection: string;
  fields: Record<string, unknown>;
  decls: FieldDecl[];
  /** 这个集合实际要评的规则（关闭与升为必选之后）。 */
  rules: ReviewRule[];
  rulesPath: string | null;
  rulesDigest: string;
  /** 这个集合现在的规则指纹；没写评审规矩的集合为空。 */
  rulesHash: string | null;
  /** 在当前规则下已经评过、内容没变，用户仍要求重评。 */
  forced: boolean;
  /** 评审者提示词文件的哈希。 */
  reviewerVersion: string;
  system: string;
  user: string;
}

export interface PreparedReviews {
  taskId: string;
  items: PreparedReview[];
  /** 这批评审的范围：pending 是全部待评审的条目，named 是点名的条目。 */
  scope: "pending" | "named";
  /** 评审者提示词文件的哈希，记进每条评审。 */
  reviewerVersion: string;
}

export interface ReviewResult { verdict: "合规" | "不合规"; reason: string; findings: Finding[] }

/**
 * 一次评审的上下文。callId 是发起这次评审的那次调用：执行者调用工具时是 pi 的调用编号，用户在界面上发起时是操作编号（ui- 开头）。
 * actor 是事件的发起方：执行者调用工具时是执行者（缺省），用户在界面上发起时是用户。
 */
export interface CallContext { workspaceDir: string; sessionId: string; callId: string; actor?: string }

/** 核对参数：items 可以不写（评全部待评审的条目）；写了就是不为空的列表，每项有编号与从 1 起的整数修订号。 */
export function checkReviewParams(params: unknown): RequestedItem[] | null {
  const items = (params as { items?: unknown })?.items;
  if (items === undefined || items === null) return null;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ReviewError("items 要么不写（评全部待评审的条目），要么写一个不为空的列表，每项是 { item_id, revision_no }。什么都没有评。");
  }
  const seen = new Set<string>();
  return items.map((raw, index) => {
    const one = raw as { item_id?: unknown; revision_no?: unknown };
    if (typeof one?.item_id !== "string" || !one.item_id.trim()) {
      throw new ReviewError(`items 的第 ${index + 1} 项要写 item_id（条目编号，例如 UC-001）。什么都没有评。`);
    }
    if (!Number.isInteger(one.revision_no) || (one.revision_no as number) < 1) {
      throw new ReviewError(`items 的第 ${index + 1} 项（${one.item_id}）要写 revision_no，一个从 1 起的整数。什么都没有评。`);
    }
    if (seen.has(one.item_id)) throw new ReviewError(`items 里 ${one.item_id} 写了两次。什么都没有评。`);
    seen.add(one.item_id);
    return { item_id: one.item_id, revision_no: one.revision_no as number };
  });
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * 第 1 步：只读核对并装配提示。拒绝：库或任务不存在、任务不是进行中；点名的条目不存在、已删除、所在集合不要求评审、
 * 修订号不是条目当前所在的修订；点名的条目在当前规则下已经评过而没有带 force；集合的规则文件读不出来；一个要评的也没有。
 */
export function prepareReviews(workspaceDir: string, requested: RequestedItem[] | null, options: { force?: boolean } = {}): PreparedReviews {
  const path = databasePath(workspaceDir);
  if (!existsSync(path)) throw new ReviewError("这个任务目录还没有任务数据库，没有条目可以评审。");
  const system = readFileSync(REVIEW_PROMPT_PATH, "utf-8");
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const task = db.prepare("SELECT task_id, status, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
      { task_id: string; status: string; definition_text: string } | undefined;
    if (!task) throw new ReviewError("库里还没有任务，没有条目可以评审。");
    if (task.status !== "进行中") throw new ReviewError(`这个任务的状态是「${task.status}」，不能再评审。`);
    const definition = validateDefinition(JSON.parse(task.definition_text));
    const reviewed = new Set(Object.entries(definition.completion).filter(([, list]) => list.includes(REVIEW_CONDITION)).map(([name]) => name));
    const current = (itemId: string) => db.prepare(
      "SELECT v.revision_no, v.fields, i.collection, i.deleted_in_revision FROM item i JOIN item_version v ON v.task_id = i.task_id AND v.item_id = i.item_id " +
        "WHERE i.task_id = ? AND i.item_id = ? ORDER BY v.revision_no DESC LIMIT 1",
    ).get(task.task_id, itemId) as { revision_no: number; fields: string; collection: string; deleted_in_revision: number | null } | undefined;

    const hashOf = new Map<string, string | null>();
    const hash = (collection: string) => {
      if (!hashOf.has(collection)) {
        const spec = definition.collections.find((c) => c.name === collection)?.reviewRules;
        hashOf.set(collection, spec ? rulesHash(workspaceDir, spec) : null);
      }
      return hashOf.get(collection)!;
    };
    const forced = new Set<string>();
    let wanted: RequestedItem[];
    const problems: string[] = [];
    if (requested) {
      wanted = [];
      for (const want of requested) {
        const row = current(want.item_id);
        if (!row) { problems.push(`库里没有条目 ${want.item_id}`); continue; }
        if (row.deleted_in_revision !== null) { problems.push(`条目 ${want.item_id} 已经删除了`); continue; }
        if (!reviewed.has(row.collection)) { problems.push(`条目 ${want.item_id} 所在的集合「${row.collection}」不要求评审`); continue; }
        if (row.revision_no !== want.revision_no) { problems.push(`条目 ${want.item_id} 现在是修订 ${row.revision_no}，你写的是修订 ${want.revision_no}；只能评条目当前所在的修订`); continue; }
        const done = currentReviews(db, task.task_id, want.item_id, want.revision_no, hash(row.collection));
        if (done.length && !options.force) {
          const no = batchNumber(db, task.task_id, done[done.length - 1].batch_id);
          problems.push(`${want.item_id} 在当前修订上已经评过${no ? `（第 ${no} 次评审）` : ""}，内容和规则都没变`);
          continue;
        }
        if (done.length) forced.add(want.item_id);
        wanted.push(want);
      }
      if (problems.length) throw new ReviewError(`什么都没有评，因为：${problems.join("；")}。`);
    } else {
      wanted = pendingItems(db, task.task_id, [...reviewed], hash);
    }
    const materials = materialsFor(workspaceDir, definition.materialsDir);

    const items: PreparedReview[] = [];
    const rulesOf = new Map<string, ReviewRule[]>();
    for (const want of wanted) {
      const row = current(want.item_id)!;
      const decl = definition.collections.find((c) => c.name === row.collection);
      const decls: FieldDecl[] = (decl?.fields ?? []).map((f) => ({ 名: f.name, 类型: f.type, 必填: f.required, ...(f.values ? { 取值: f.values } : {}) }));
      if (!rulesOf.has(row.collection)) {
        try {
          rulesOf.set(row.collection, decl?.reviewRules ? effectiveRules(workspaceDir, decl.reviewRules) : [FIELD_RULE]);
        } catch (error) {
          problems.push(`集合「${row.collection}」的评审规矩读不出来：${(error as Error).message}`);
          rulesOf.set(row.collection, []);
        }
      }
      const rules = rulesOf.get(row.collection)!;
      if (!rules.length) continue;
      const fields = (JSON.parse(row.fields) as Record<string, unknown>) ?? {};
      const sources = db.prepare("SELECT position, kind, locator, excerpt, field, field_index FROM item_source WHERE task_id = ? AND item_id = ? AND revision_no = ? ORDER BY position, support_no")
        .all(task.task_id, want.item_id, want.revision_no) as { position: number; kind: string; locator: string; excerpt: string; field: string | null; field_index: number | null }[];
      items.push({
        ...want, collection: row.collection, fields, decls, rules, rulesPath: decl?.reviewRules?.file ?? null,
        rulesDigest: digest(JSON.stringify(rules) + "\n" + JSON.stringify(decls)),
        rulesHash: hash(row.collection), forced: forced.has(want.item_id), reviewerVersion: digest(system),
        system, user: assembleUser(want, row.collection, fields, decls, rules, sources, materials),
      });
    }
    if (problems.length) throw new ReviewError(`什么都没有评，因为：${problems.join("；")}。`);
    if (!items.length) throw new ReviewError("没有需要评审的条目：要评审的集合里，每个条目在当前所在的修订、当前规则下都已经有评审记录了。");
    return { taskId: task.task_id, items, scope: requested ? "named" : "pending", reviewerVersion: digest(system) };
  } finally {
    db.close();
  }
}

/**
 * 待评审的条目：给定集合里还在的条目中，当前所在的修订在当前规则下还没有评审记录的，按集合与流水号排。
 * 界面上「评审 N 条待评审的条目」的 N、不点名的评审都按它。hashOf 给出每个集合现在的规则指纹（为空时不按指纹区分）。
 */
export function pendingItems(db: DatabaseSync, taskId: string, collections: string[], hashOf: (collection: string) => string | null = () => null): RequestedItem[] {
  return (db.prepare(
    "SELECT i.item_id, i.collection, MAX(v.revision_no) AS revision_no FROM item i JOIN item_version v ON v.task_id = i.task_id AND v.item_id = i.item_id " +
      "WHERE i.task_id = ? AND i.deleted_in_revision IS NULL AND i.collection IN (SELECT value FROM json_each(?)) GROUP BY i.item_id ORDER BY i.collection, i.serial",
  ).all(taskId, JSON.stringify(collections)) as unknown as (RequestedItem & { collection: string })[])
    .filter((w) => currentReviews(db, taskId, w.item_id, Number(w.revision_no), hashOf(w.collection)).length === 0)
    .map((w) => ({ item_id: w.item_id, revision_no: Number(w.revision_no) }));
}

/** 给评审者的材料：全文（总长不超过上限时），或只按条目取段落（超过时，由 assembleUser 按来源去取）。 */
interface Materials { full: boolean; files: { path: string; text: string }[] }

function materialsFor(workspaceDir: string, materialsDir: string): Materials {
  const files = listMaterials(workspaceDir, materialsDir).files
    .filter((f) => /\.(md|txt)$/i.test(f.path))
    .map((f) => ({ path: f.path, text: readFileSync(join(workspaceDir, f.path), "utf-8") }));
  const total = files.reduce((sum, f) => sum + [...f.text].length, 0);
  return { full: total <= MATERIAL_FULL_LIMIT, files };
}

/** 材料按空行分成自然段；含有摘录（摘录里用空行隔开的每一段都算）的自然段。 */
export function paragraphsWith(text: string, excerpt: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const pieces = excerpt.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.filter((p) => pieces.some((piece) => p.includes(piece)));
}

function valueLines(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.map((v, i) => `    ${i + 1}. ${String(v)}`).join("\n") : "    （空）";
  const text = value == null ? "" : String(value);
  return `    ${text.trim() ? text : "（空）"}`;
}

/** 规则清单里的一条：编号、级别、条文，下面两行反例与正例。 */
export function ruleText(rule: ReviewRule): string {
  return `- ${rule.编号}（${rule.级别}）${rule.条文}\n  反例：${rule.反例}\n  正例：${rule.正例}`;
}

/** 装配评审者的用户消息：规则清单、字段声明、条目在这次修订下的字段与来源。 */
function assembleUser(want: RequestedItem, collection: string, fields: Record<string, unknown>, decls: FieldDecl[], rules: ReviewRule[],
  sources: { position: number; kind: string; locator: string; excerpt: string; field: string | null; field_index: number | null }[],
  materials: Materials = { full: true, files: [] }): string {
  const byPosition = new Map<number, { kind: string; locator: string; excerpt: string; supports: string[] }>();
  for (const s of sources) {
    const one = byPosition.get(s.position) ?? { kind: s.kind, locator: s.locator, excerpt: s.excerpt, supports: [] };
    if (s.field) one.supports.push(s.field_index == null ? s.field : `${s.field}第 ${s.field_index + 1} 项`);
    byPosition.set(s.position, one);
  }
  return [
    `【规则清单】集合「${collection}」要逐条核对的 ${rules.length} 条规则：`,
    ...rules.map(ruleText),
    "",
    `【字段声明】集合「${collection}」的字段：`,
    ...decls.map((d) => `- ${d.名}：${d.类型}${d.必填 ? "，必填" : "，可以不填"}${d.取值 ? `，取值只能是${d.取值.map((v) => `「${v}」`).join("、")}之一` : ""}${d.类型 === "文本列表" || d.类型 === "条目引用" ? "（列表型字段）" : ""}`),
    "",
    `【要评审的条目】${want.item_id}，修订 ${want.revision_no}，各字段：`,
    ...decls.map((d) => `- ${d.名}：\n${valueLines(fields[d.名])}`),
    "",
    "【来源】",
    ...([...byPosition.values()].map((s, i) => `${i + 1}. ${s.kind}${s.kind === "文档原文" || s.kind === "领域说明" ? `（${s.locator}）` : ""}：「${s.excerpt}」` +
      `，支持${s.supports.length ? s.supports.join("、") : "整个条目"}`)),
    ...(byPosition.size ? [] : ["（这份内容没有来源）"]),
    "",
    ...materialLines(materials, sources),
  ].join("\n");
}

/** 【材料全文】一节，或材料太长时【材料摘段】一节。 */
function materialLines(materials: Materials, sources: { kind: string; locator: string; excerpt: string }[]): string[] {
  if (!materials.files.length) return ["【材料】这个任务的材料目录里没有材料文件。"];
  if (materials.full) {
    return ["【材料全文】这个任务的全部材料：", ...materials.files.flatMap((f) => [`--- ${f.path} ---`, f.text.trimEnd()])];
  }
  const picked = new Map<string, string[]>();
  for (const s of sources) {
    if (s.kind !== "文档原文") continue;
    const file = materials.files.find((f) => f.path === s.locator);
    if (!file) continue;
    const list = picked.get(file.path) ?? [];
    for (const p of paragraphsWith(file.text, s.excerpt)) if (!list.includes(p)) list.push(p);
    picked.set(file.path, list);
  }
  const lines = ["【材料摘段】材料太长，你看到的不是材料全文，只是这个条目的来源所引的段落："];
  for (const [path, list] of picked) lines.push(`--- ${path} ---`, ...list);
  if (!picked.size) lines.push("（这个条目没有引用材料原文。）");
  return lines;
}

/** 由发现算出结论：有任一必选规则的发现即不合规，否则合规。 */
export function verdictOf(findings: Finding[]): ReviewResult["verdict"] {
  return findings.some((f) => f.level === RULE_REQUIRED) ? "不合规" : "合规";
}

/** 结论与发现写成一句理由，存进评审表的理由一列。 */
export function reasonOf(findings: Finding[], ruleCount: number): string {
  const problems = findings.filter((f) => f.level === RULE_REQUIRED).length;
  const advice = findings.length - problems;
  if (!findings.length) return `按 ${ruleCount} 条规则逐条核对，没有发现问题。`;
  return `按 ${ruleCount} 条规则逐条核对：问题 ${problems} 处，建议 ${advice} 条。`;
}

/** 第 2 步：解析并核对评审者的输出，按发现的规则级别算出结论。不合格时抛 ReviewError（调用方据此重试一次）。 */
export function parseReview(text: string, item: PreparedReview): ReviewResult {
  let raw: Record<string, unknown>;
  try {
    raw = extractJson(text) as Record<string, unknown>;
  } catch (error) {
    throw new ReviewError(String((error as Error).message).replace("模型", "评审者"));
  }
  const problems: string[] = [];
  const list = raw?.发现;
  if (!Array.isArray(list)) problems.push("没有「发现」列表");
  const findings: Finding[] = [];
  (Array.isArray(list) ? list : []).forEach((f: any, n) => {
    const ruleId = String(f?.规则 ?? "").trim();
    const rule = item.rules.find((r) => r.编号 === ruleId);
    if (!rule) { problems.push(`第 ${n + 1} 条发现引用的规则「${ruleId}」不在规则清单里`); return; }
    const field = String(f?.字段 ?? "");
    const decl = item.decls.find((d) => d.名 === field);
    if (!decl) { problems.push(`第 ${n + 1} 条发现的字段「${field}」不在字段声明里`); return; }
    let index: number | null = null;
    if (f?.序号 !== null && f?.序号 !== undefined && f?.序号 !== "") {
      const no = Number(f.序号);
      const value = item.fields[field];
      if (!(decl.类型 === "文本列表" || decl.类型 === "条目引用")) problems.push(`第 ${n + 1} 条发现给「${field}」写了序号，它不是列表型字段`);
      else if (!Number.isInteger(no) || no < 1 || no > (Array.isArray(value) ? value.length : 0)) problems.push(`第 ${n + 1} 条发现的序号 ${String(f.序号)} 超出了「${field}」现有的项数`);
      else index = no - 1;
    }
    const problem = String(f?.问题 ?? "").trim();
    if (!problem) { problems.push(`第 ${n + 1} 条发现没有写问题`); return; }
    const suggestion = String(f?.建议 ?? "").trim();
    if (rule.级别 === RULE_REQUIRED && !suggestion) { problems.push(`第 ${n + 1} 条发现依据必选规则 ${rule.编号}，没有写建议`); return; }
    findings.push({ rule_id: rule.编号, level: rule.级别, field, index, problem, suggestion: suggestion || null });
  });
  if (problems.length) throw new ReviewError(`评审者的输出不合格：${problems.join("；")}`);
  return { verdict: verdictOf(findings), reason: reasonOf(findings, item.rules.length), findings };
}

function insertModelCalls(db: DatabaseSync, taskId: string, toolCallId: string, calls: ModelCallRecord[], reviewId: number | null): void {
  const insert = db.prepare(
    "INSERT INTO model_call (task_id, role, judgement_id, review_id, tool_call_id, prompt, output, outcome, model, duration_ms, " +
      "input_tokens, output_tokens, created_at) VALUES (?, '评审者', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const c of calls) {
    insert.run(taskId, c.outcome === "采用" ? reviewId : null, toolCallId, c.prompt, c.output, c.outcome, c.model, c.durationMs,
      c.inputTokens, c.outputTokens, wallClockText());
  }
}

export interface WrittenReview { review_id: number; event_seq: number }

/**
 * 第 3 步：写一条评审。评审期间条目可能被改，事务里再核对一次修订号；不是条目当前所在的修订就改记「评审未完成」。
 * 事件 REVIEW_RECORDED 带结论、理由与发现（每条带规则编号与级别），发起方见 CallContext.actor。
 */
export function writeReview(call: CallContext, taskId: string, item: PreparedReview, result: ReviewResult, calls: ModelCallRecord[]): WrittenReview | { changed: number } {
  return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => {
    const now = (db.prepare("SELECT MAX(revision_no) AS n FROM item_version WHERE task_id = ? AND item_id = ?").get(taskId, item.item_id) as { n: number }).n;
    if (now !== item.revision_no) {
      unfinishedIn(db, call, taskId, item, calls.map((c) => ({ ...c, outcome: c.outcome === "采用" ? "输出不合格" : c.outcome })),
        `评审期间条目被改到了修订 ${now}`);
      return { changed: now };
    }
    const seq = emit(db, {
      taskId, sessionId: call.sessionId, callId: call.callId, name: EVENT_REVIEW_RECORDED, actor: call.actor ?? ACTOR_EXECUTOR,
      payload: { item_id: item.item_id, revision_no: item.revision_no, verdict: result.verdict, reason: result.reason, findings: result.findings,
        batch_id: call.callId, rules_hash: item.rulesHash, forced: item.forced },
    });
    const reviewId = Number(db.prepare(
      "INSERT INTO review (task_id, item_id, revision_no, verdict, reason, rules_digest, reviewer_session_id, call_id, event_seq, created_at, " +
        "batch_id, rules_hash, reviewer_version, forced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(taskId, item.item_id, item.revision_no, result.verdict, result.reason, item.rulesDigest, `review-${call.callId}-${item.item_id}`,
      call.callId, seq, wallClockText(), call.callId, item.rulesHash, item.reviewerVersion, item.forced ? 1 : 0).lastInsertRowid);
    const insert = db.prepare(
      "INSERT INTO review_finding (review_id, task_id, ordinal, field, item_index, problem, suggestion, rule_id, level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    result.findings.forEach((f, i) => insert.run(reviewId, taskId, i + 1, f.field, f.index, f.problem, f.suggestion, f.rule_id, f.level));
    insertModelCalls(db, taskId, call.callId, calls, reviewId);
    return { review_id: reviewId, event_seq: seq };
  });
}

function unfinishedIn(db: DatabaseSync, call: CallContext, taskId: string, item: PreparedReview, calls: ModelCallRecord[], reason: string): number {
  const seq = emit(db, {
    taskId, sessionId: call.sessionId, callId: call.callId, name: EVENT_REVIEW_UNFINISHED, actor: call.actor ?? ACTOR_EXECUTOR,
    payload: { item_id: item.item_id, revision_no: item.revision_no, reason },
  });
  insertModelCalls(db, taskId, call.callId, calls, null);
  return seq;
}

/** 评审没有完成：只记模型调用与一条 REVIEW_UNFINISHED 事件，不写合规与否。 */
export function writeUnfinished(call: CallContext, taskId: string, item: PreparedReview, calls: ModelCallRecord[], reason: string): number {
  return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => unfinishedIn(db, call, taskId, item, calls, reason));
}

/** 发现的两类说法：必选规则的发现叫问题，可选规则的叫建议。 */
export function findingKind(f: Finding): "问题" | "建议" {
  return f.level === RULE_REQUIRED ? "问题" : "建议";
}

/** 一条发现写成一句话：类别与规则编号、字段、第几项、问题、改法。 */
export function findingText(f: Finding): string {
  return `【${findingKind(f)}${f.rule_id ? ` ${f.rule_id}` : ""}】${f.field}${f.index != null ? `第 ${f.index + 1} 项` : ""}：${f.problem}` +
    `${f.suggestion ? `（改法：${f.suggestion}）` : ""}`;
}
