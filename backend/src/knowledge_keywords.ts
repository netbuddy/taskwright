/**
 * 知识库按字面查找：把一句话切成词，按词在各片段里出现的情况给每个片段打分（BM25），分高的排在前面。它与按意思查找并行
 * （knowledge_search.ts），专管按意思查不准的东西：条号、编号、原话里的词。不用嵌入模型，没有选嵌入模型时只靠它。
 *
 * 切词：
 * - 连续的汉字切成相邻两个字一组（「逾期罚款」是「逾期」「期罚」「罚款」），单独一个汉字自成一词；
 * - 连续的字母与数字连成一个词，字母转成小写；连字符、小数点、斜杠、下划线与别的符号都是分隔
 *   （`v1.2` 是 `v1` 与 `2`，`refund/refunds` 是两个词；不还原单复数）；
 * - 不去掉数字前后的空白（「HTTP 200」是两个词）；
 * - 「第 N 条」另外整体记成一个词「第N条」，中间有没有空格都算，所以「第 8 条」与「第8条」是同一个词。
 *
 * 打分：BM25，k1 = 1.2，b = 0.75，idf = ln(1 + (N − df + 0.5) / (df + 0.5))，片段的长度按词数算。
 * 打分的对象是「标题 + 换行 + 正文」。索引每次查找现算，不存：几百个片段时是几十毫秒。
 *
 * 本模块只做计算，不读写文件。
 */

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** 把一段文字切成词（见文件开头）。 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const m of lower.matchAll(/第\s*(\d+)\s*条/g)) out.push(`第${m[1]}条`);
  for (const m of lower.matchAll(/[一-鿿]+|[a-z0-9]+/g)) {
    const run = m[0];
    if (!/[一-鿿]/.test(run) || run.length === 1) out.push(run);
    else for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** 一批片段的词的统计。 */
export interface KeywordIndex {
  /** 各片段里每个词出现了几次。 */
  counts: Map<string, number>[];
  /** 各片段的词数。 */
  lengths: number[];
  /** 每个词在几个片段里出现过。 */
  df: Map<string, number>;
  /** 片段的平均词数。 */
  average: number;
}

/** 对一批片段做词的统计。打分的对象是「标题 + 换行 + 正文」。 */
export function keywordIndex(chunks: { heading: string | null; text: string }[]): KeywordIndex {
  const df = new Map<string, number>();
  const lengths: number[] = [];
  const counts = chunks.map((chunk) => {
    const one = new Map<string, number>();
    let n = 0;
    for (const token of tokenize(`${chunk.heading ?? ""}\n${chunk.text}`)) {
      one.set(token, (one.get(token) ?? 0) + 1);
      n++;
    }
    for (const token of one.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    lengths.push(n);
    return one;
  });
  return { counts, lengths, df, average: lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length) };
}

/** 一句话对各片段的 BM25 得分：只给得分大于 0 的片段的下标与分数，分高的在前，同分的下标小的在前。 */
export function keywordRanking(index: KeywordIndex, query: string): { i: number; score: number }[] {
  const terms = [...new Set(tokenize(query))];
  const n = index.counts.length;
  const out: { i: number; score: number }[] = [];
  for (let i = 0; i < n; i++) {
    let score = 0;
    for (const term of terms) {
      const tf = index.counts[i].get(term) ?? 0;
      if (!tf) continue;
      const df = index.df.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (index.lengths[i] / (index.average || 1))));
    }
    if (score > 0) out.push({ i, score });
  }
  return out.sort((a, b) => b.score - a.score || a.i - b.i);
}
