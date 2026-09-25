/**
 * 对话理解评测：提示怎样拼、模型的输出怎样认、怎样判分。跑分入口是同目录的 run.ts；本模块不调模型、不读写文件以外的东西，
 * 单元测试直接调用（agent/tests/understanding_eval.test.ts）。
 *
 * 标注口径见同目录的 labeling.md。一例（cases.jsonl 的一行）：用户这句话，当时的上下文（任务里有哪些条目、助手上一次回复记下的等回应行为、上一轮对话），
 * 人工标注的期望理解。期望理解按 agent/prompts/schemas/user_intent.schema.json 的结构写（function、targets、responds_to、summary），
 * 每项另写 keywords（摘要里应当出现的对象关键词，一个关键词可以用「|」写几种说法），纠正另写 change（改为、追加、删去）。
 *
 * 提示：平台 skill 第八节「先写理解」整节（从 SKILL.md 按标题截取，含由 schema 生成的格式说明），加上下文与用户的话。
 * 认输出：用 lib/structured_outputs.ts 的 extractFragments 取片段，用登记表（lib/registered_outputs.ts）按 schema 匹配，
 * 第一份匹配上理解的就是这一例的理解；没有匹配上的算格式不合格。
 *
 * 判分，每例四项：
 * - 功能：各项 function 与期望逐项一致（按先后），项数一致；
 * - 目标：全部 targets 的条目编号集合与期望一致；期望里写了字段的，实际对那个条目也要写同一个字段；
 * - 回应：全部 responds_to 的集合与期望一致（都不写也算一致）；
 * - 摘要：期望的每一项，它的每个关键词都出现在对应那一项的摘要里（项数一致时按位置对应，不一致时在全部摘要里找）。
 * 另记一项「变更方式」：期望为纠正且写了 change 的，对应摘要里要出现那种变更方式的说法。
 * 格式不合格的例子四项都算错。
 */

import { extractFragments, matchFragment } from "../../src/lib/structured_outputs.ts";
import { REGISTERED_OUTPUTS } from "../../src/lib/registered_outputs.ts";
import { FUNCTION_NAMES } from "../../src/lib/intent_schema.ts";

export interface Target { item_id: string; field?: string; index?: number }
export interface Act { function: string; targets?: Target[]; responds_to?: string; summary: string; confidence?: string }
export interface ExpectedAct extends Act { keywords: string[]; change?: "改为" | "追加" | "删去" }
export interface EvalCase {
  id: string;
  source: string;
  context: {
    items: { item_id: string; collection: string; title: string }[];
    pending: { id: string; kind: string; text: string; items?: string[] }[];
    previous_user?: string;
    previous_reply?: string;
  };
  text: string;
  expected: { acts: ExpectedAct[] };
  note: string;
}

/** SKILL.md 里第八节「先写理解」整节：从「## 八、」那一行到下一个二级标题之前。找不到时抛异常。 */
export function understandingSection(skill: string): string {
  const lines = skill.split("\n");
  const start = lines.findIndex((line) => /^## 八、/.test(line));
  if (start < 0) throw new Error("SKILL.md 里找不到第八节「先写理解」");
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  const section = lines.slice(start, end < 0 ? lines.length : end).join("\n").trim();
  if (!section.includes("理解格式说明开始") || !section.includes("理解格式说明结束")) throw new Error("第八节里没有由 schema 生成的格式说明");
  return section;
}

/** 一例的提示：说明这次只写理解，接着是第八节原文、上下文与用户的话。 */
export function buildPrompt(section: string, c: EvalCase): string {
  const items = c.context.items.length
    ? c.context.items.map((i) => `- ${i.item_id} · ${i.collection} · ${i.title}`).join("\n")
    : "（还没有条目）";
  const pending = c.context.pending.length
    ? c.context.pending.map((p) => `- ${p.id}（${FUNCTION_NAMES[p.kind] ?? p.kind}）：${p.text}${p.items?.length ? `（涉及 ${p.items.join("、")}）` : ""}`).join("\n")
    : "（没有）";
  const parts = [
    "你是 Taskwright 里为用户整理需求的助手。下面是你的平台 skill 里「先写理解」这一节。",
    "这次只做一件事：按这一节为用户的这句话写一份理解。只输出那个 JSON 对象，不调用工具，不写别的文字。",
    "",
    section,
    "",
    "任务里现在的条目（编号 · 集合 · 标题）：",
    items,
    "",
    "你上一次回复记下的、还在等用户回应的对话行为：",
    pending,
  ];
  if (c.context.previous_user) parts.push("", `用户上一句话：「${c.context.previous_user}」`);
  if (c.context.previous_reply) parts.push("", `你上一次回复的正文：「${c.context.previous_reply}」`);
  parts.push("", `用户这句话：「${c.text}」`);
  return parts.join("\n");
}

/** 从模型输出里认出理解：第一份按登记表匹配上理解（user_intent）的片段。认不出返回 null 与原因。 */
export function parseUnderstanding(output: string): { acts: Act[] } | { error: string } {
  const problems: string[] = [];
  for (const fragment of extractFragments(output)) {
    if (fragment.parseError) { problems.push(fragment.parseError); continue; }
    const matched = matchFragment(fragment.value, REGISTERED_OUTPUTS);
    if ("output" in matched && matched.output.name === "user_intent") return fragment.value as { acts: Act[] };
    if ("errors" in matched) problems.push(...(matched.errors.user_intent ?? []));
  }
  return { error: problems.length ? problems.slice(0, 3).join("；") : "输出里没有 JSON 片段" };
}

/** 变更方式的几种说法。 */
export const CHANGE_WORDS: Record<string, RegExp> = {
  改为: /改为|改成|改作|换成|更正为|应为|应该是/,
  追加: /追加|加上|增加|补上|补充|添加|新增|增补/,
  删去: /删去|删掉|删除|去掉|移除|去除|不写/,
};

export interface CaseScore {
  format: boolean;
  functions: boolean;
  targets: boolean;
  responds: boolean;
  summary: boolean;
  /** 每一项期望的功能对不对（按位置），给按功能分组用。 */
  perAct: { function: string; ok: boolean }[];
  /** 期望里写了变更方式的纠正：摘要写没写明。 */
  changes: { change: string; ok: boolean }[];
  /** 差在哪（给失败例清单用），一样都没差时为空。 */
  diff: string[];
}

const keyOf = (t: Target) => t.item_id;

/** 按四项给一例判分。actual 为 null 表示格式不合格。 */
export function scoreCase(expected: ExpectedAct[], actual: Act[] | null): CaseScore {
  const perActWrong = expected.map((e) => ({ function: e.function, ok: false }));
  const changesWrong = expected.filter((e) => e.change).map((e) => ({ change: e.change!, ok: false }));
  if (!actual) return { format: false, functions: false, targets: false, responds: false, summary: false, perAct: perActWrong, changes: changesWrong, diff: ["格式不合格"] };
  const diff: string[] = [];
  const sameCount = actual.length === expected.length;
  const functions = sameCount && expected.every((e, i) => e.function === actual[i].function);
  if (!functions) diff.push(`功能：期望 ${expected.map((e) => e.function).join("+")}，实际 ${actual.map((a) => a.function).join("+")}`);

  const want = new Set(expected.flatMap((e) => (e.targets ?? []).map(keyOf)));
  const got = new Set(actual.flatMap((a) => (a.targets ?? []).map(keyOf)));
  const fieldsOk = expected.flatMap((e) => e.targets ?? []).filter((t) => t.field)
    .every((t) => actual.some((a) => (a.targets ?? []).some((x) => x.item_id === t.item_id && x.field === t.field)));
  const targets = want.size === got.size && [...want].every((k) => got.has(k)) && fieldsOk;
  if (!targets) diff.push(`目标：期望 ${[...want].join("、") || "（无）"}${fieldsOk ? "" : "（含字段）"}，实际 ${[...got].join("、") || "（无）"}`);

  const wantR = new Set(expected.map((e) => e.responds_to).filter(Boolean));
  const gotR = new Set(actual.map((a) => a.responds_to).filter(Boolean));
  const responds = wantR.size === gotR.size && [...wantR].every((r) => gotR.has(r));
  if (!responds) diff.push(`回应：期望 ${[...wantR].join("、") || "（无）"}，实际 ${[...gotR].join("、") || "（无）"}`);

  const summaryOf = (i: number) => (sameCount ? actual[i].summary : actual.map((a) => a.summary).join(" | ")) ?? "";
  const hit = (text: string, keyword: string) => keyword.split("|").some((k) => text.includes(k));
  const summary = expected.every((e, i) => e.keywords.every((k) => hit(summaryOf(i), k)));
  if (!summary) diff.push(`摘要：期望含 ${expected.map((e) => e.keywords.join("、")).join(" / ")}，实际「${actual.map((a) => a.summary).join(" / ")}」`);

  const perAct = expected.map((e, i) => ({ function: e.function, ok: sameCount ? actual[i].function === e.function : false }));
  const changes = expected.map((e, i) => (e.change ? { change: e.change, ok: CHANGE_WORDS[e.change].test(summaryOf(i)) } : null))
    .filter((x): x is { change: string; ok: boolean } => x !== null);
  return { format: true, functions, targets, responds, summary, perAct, changes, diff };
}

/** 多次运行取多数：每一项判分在多数运行里为真才算真（N 为偶数时要过半）。diff 取第一次不全对的那次。 */
export function majority(runs: CaseScore[]): CaseScore {
  const n = runs.length;
  const vote = (pick: (s: CaseScore) => boolean) => runs.filter(pick).length * 2 > n;
  const first = runs[0];
  return {
    format: vote((s) => s.format),
    functions: vote((s) => s.functions),
    targets: vote((s) => s.targets),
    responds: vote((s) => s.responds),
    summary: vote((s) => s.summary),
    perAct: first.perAct.map((p, i) => ({ function: p.function, ok: vote((s) => s.perAct[i]?.ok ?? false) })),
    changes: first.changes.map((c, i) => ({ change: c.change, ok: vote((s) => s.changes[i]?.ok ?? false) })),
    diff: (runs.find((s) => s.diff.length) ?? first).diff,
  };
}

const pct = (ok: number, all: number) => (all ? `${ok}/${all}（${Math.round((ok * 1000) / all) / 10}%）` : "—");

/** 总分、按功能分组与变更方式三张表的数据。 */
export function tally(scores: CaseScore[]) {
  const count = (pick: (s: CaseScore) => boolean) => scores.filter(pick).length;
  const byFunction = new Map<string, { ok: number; all: number }>();
  for (const s of scores) for (const p of s.perAct) {
    const row = byFunction.get(p.function) ?? { ok: 0, all: 0 };
    row.all++; if (p.ok) row.ok++;
    byFunction.set(p.function, row);
  }
  const changes = scores.flatMap((s) => s.changes);
  return {
    cases: scores.length,
    formatFailures: count((s) => !s.format),
    functions: pct(count((s) => s.functions), scores.length),
    targets: pct(count((s) => s.targets), scores.length),
    responds: pct(count((s) => s.responds), scores.length),
    summary: pct(count((s) => s.summary), scores.length),
    allFour: pct(count((s) => s.functions && s.targets && s.responds && s.summary), scores.length),
    byFunction: [...byFunction].map(([f, r]) => ({ function: f, name: FUNCTION_NAMES[f] ?? f, accuracy: pct(r.ok, r.all) })),
    changes: pct(changes.filter((c) => c.ok).length, changes.length),
  };
}
