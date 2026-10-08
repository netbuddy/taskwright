/**
 * 几种取结果的办法离线比较：给一批片段与一批查询（各带期望命中的规定），算每种办法在各个 limit 下有几处期望的规定进了候选、
 * 进了结果。用来在改候选与保底的规则之前先看数。只做计算；读语料、调嵌入模型在 fusion_compare.ts。
 *
 * 办法：
 * - 只按意思：按意思一路的前 limit 名。
 * - 只按字面：按字面一路的前 limit 名。
 * - 候选与保底：产品现在的规则（backend/src/knowledge_search.ts 的 combine），按字面保底的名次可以给几个值各比一遍。
 * - 倒数排名融合：两路各取前几名，按 1 / (k + 名次) 相加排序。产品没有用它，留作对照。
 * 片段没有数字串（没有选嵌入模型，或者离线时没有调模型）时，按意思一路是空的，各办法都退到只按字面。
 *
 * 一「处」＝一句查询问到的一条期望的规定。进候选＝这条规定所在的片段在这种办法取结果之前考虑的片段里；进结果＝在最终的前 limit 名里。
 *
 * 这是评估工具，不是产品运行时的代码：它导入 backend/src 里与产品相同的实现（切分、关键词打分、候选规则），好让评估与产品算的是同一件事。
 * 安装包不带这个目录（release/build.mjs 只复制 agent/src 与 agent/prompts）；agent/src 与 backend/src 都不导入这里的任何东西。
 */

import { keywordIndex, keywordRanking } from "../../../backend/src/knowledge_keywords.ts";
import { combine } from "../../../backend/src/knowledge_search.ts";

/** 参加比较的一个片段。vector 是长度为 1 的数字串；没有是 null。 */
export interface CompareEntry {
  document: string;
  index: number;
  heading: string | null;
  text: string;
  vector: Float32Array | null;
}

export interface CompareQuery {
  query: string;
  /** 这句查询期望命中的规定：在哪份文档、规定里逐字的一句。 */
  expect: { document: string; sentence: string }[];
  /** 这句话换算成的长度为 1 的数字串；没有是 null。 */
  vector: Float32Array | null;
}

export interface Method {
  name: string;
  /** 两路各自排好的片段下标 → 取中的与考虑过的。 */
  pick: (semantic: number[], keyword: number[], limit: number) => { picked: number[]; candidates: number[] };
}

const union = (...lists: number[][]) => [...new Set(lists.flat())];

/** 倒数排名融合：两路各取前 top 名，按 1 / (k + 名次) 相加，分高的在前。 */
export function reciprocalRankFusion(semantic: number[], keyword: number[], k: number, top: number): number[] {
  const score = new Map<number, number>();
  for (const ranking of [semantic.slice(0, top), keyword.slice(0, top)]) ranking.forEach((i, rank) => score.set(i, (score.get(i) ?? 0) + 1 / (k + rank + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([i]) => i);
}

/** 要比的几种办法。keeps 是按字面保底的名次（各比一遍）；rrf 不给就不比倒数排名融合。 */
export function methods(keeps: number[] = [2], rrf: { k: number; top: number } | null = { k: 60, top: 5 }): Method[] {
  return [
    { name: "只按意思", pick: (s, _k, limit) => ({ picked: s.slice(0, limit), candidates: s.slice(0, limit) }) },
    { name: "只按字面", pick: (_s, k, limit) => ({ picked: k.slice(0, limit), candidates: k.slice(0, limit) }) },
    ...keeps.map((keep): Method => ({
      name: `候选与保底（按字面前 ${keep} 名）`,
      pick: (s, k, limit) => ({ picked: combine(s, k, limit, keep), candidates: s.length ? union(s.slice(0, limit), k.slice(0, keep)) : k.slice(0, limit) }),
    })),
    ...(rrf ? [{
      name: `倒数排名融合（k=${rrf.k}，每路前 ${rrf.top} 名）`,
      pick: (s: number[], k: number[], limit: number) => ({ picked: reciprocalRankFusion(s, k, rrf.k, rrf.top).slice(0, limit), candidates: union(s.slice(0, rrf.top), k.slice(0, rrf.top)) }),
    }] : []),
  ];
}

const squeeze = (text: string) => text.replace(/\s+/g, "");

/** 按意思一路的先后：与每个有数字串的片段算点积，近的在前；查询或片段没有数字串时是空的。 */
export function semanticOrder(entries: CompareEntry[], vector: Float32Array | null): number[] {
  if (!vector) return [];
  const scored: { i: number; score: number }[] = [];
  entries.forEach((entry, i) => {
    if (!entry.vector || entry.vector.length !== vector.length) return;
    let sum = 0;
    for (let k = 0; k < vector.length; k++) sum += entry.vector[k] * vector[k];
    scored.push({ i, score: sum });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((one) => one.i);
}

export interface CompareRow {
  method: string;
  limit: number;
  /** 期望的规定一共几处（在语料里找得到所在片段的才算）。 */
  places: number;
  candidate: number;
  returned: number;
}

/** 比较。返回每种办法、每个 limit 一行；另给在语料里找不到所在片段的期望（写错了文档名或那句话）。 */
export function compare(entries: CompareEntry[], queries: CompareQuery[], limits: number[], list: Method[] = methods()):
  { rows: CompareRow[]; missing: { query: string; document: string; sentence: string }[] } {
  const index = keywordIndex(entries);
  const missing: { query: string; document: string; sentence: string }[] = [];
  const prepared = queries.map((query) => {
    const places = query.expect.flatMap((want) => {
      const at = entries.findIndex((entry) => entry.document === want.document && squeeze(entry.text).includes(squeeze(want.sentence)));
      if (at < 0) missing.push({ query: query.query, ...want });
      return at < 0 ? [] : [at];
    });
    return { places, semantic: semanticOrder(entries, query.vector), keyword: keywordRanking(index, query.query).map((one) => one.i) };
  });
  const rows: CompareRow[] = [];
  for (const method of list) {
    for (const limit of limits) {
      let candidate = 0;
      let returned = 0;
      let places = 0;
      for (const one of prepared) {
        const { picked, candidates } = method.pick(one.semantic, one.keyword, limit);
        places += one.places.length;
        candidate += one.places.filter((i) => candidates.includes(i) || picked.includes(i)).length;
        returned += one.places.filter((i) => picked.includes(i)).length;
      }
      rows.push({ method: method.name, limit, places, candidate, returned });
    }
  }
  return { rows, missing };
}

/** 比较的结果写成一张表（Markdown）。 */
export function compareTable(rows: CompareRow[], limits: number[]): string {
  const names = [...new Set(rows.map((row) => row.method))];
  const cell = (method: string, limit: number) => {
    const row = rows.find((one) => one.method === method && one.limit === limit)!;
    return `${row.returned}（${row.candidate}）`;
  };
  return [
    `| 办法 | ${limits.map((limit) => `limit ${limit}`).join(" | ")} |`,
    `|---|${limits.map(() => "---").join("|")}|`,
    ...names.map((name) => `| ${name} | ${limits.map((limit) => cell(name, limit)).join(" | ")} |`),
  ].join("\n");
}
