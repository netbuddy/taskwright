// 任务页完成条件横条里的句子与分数。已经满足的与还差的完成条件各写成一行：前半句说要求（带集合名），后半句说现状。
// 现有的四种条件各有一套写法；认不出的条件名退回「集合名：条件名，接口给的说明」。
// 集合还没有条目、暂时不用核对的条件不逐条列，合成末尾的一行，只写是哪几个集合。
// 分数的分母只数用得上的条件（集合有条目，或者条件本身要求有条目），分子数其中已经满足的；暂时不用核对的不算进分数。

import type { Completion, CompletionCondition, Item, Task } from "../api/types";
import { REVIEW_CONDITION, conditionState, reviewState } from "./items";

/** 一行里的一段：普通文字，或者一个条目编号（页面上用等宽字写）。 */
export type LinePart = string | { id: string };

export interface CompletionLine {
  key: string;
  state: "met" | "unmet" | "empty";
  parts: LinePart[];
}

/** 逐个列出编号最多几个，多了只写个数。 */
const LIST_AT_MOST = 6;

/**
 * 一组条目怎么了：不多于 6 个时逐个写编号（两个写「甲 和 乙」，三个以上写「甲、乙 和 丙」）再接 what，
 * 多于 6 个只写「有 N 个条目」再接 what。what 例如「还在等评审」。
 */
function idsThat(ids: string[], what: string): LinePart[] {
  if (ids.length > LIST_AT_MOST) return [`有 ${ids.length} 个条目${what}`];
  const out: LinePart[] = [];
  ids.forEach((id, i) => {
    if (i > 0) out.push(i === ids.length - 1 ? " 和 " : "、");
    out.push({ id });
  });
  return [...out, ` ${what}`];
}

/** 各种条件的要求怎么说（前半句）。 */
const REQUIREMENT: Record<string, (collection: string) => string> = {
  至少一个条目: (c) => `${c}至少要有一个条目`,
  [REVIEW_CONDITION]: (c) => `${c}的每个条目都要评审通过`,
  每个条目用户确认: (c) => `${c}的每个条目都要经你确认`,
  没有状态为未解决的条目: (c) => `${c}里不能有状态为未解决的条目`,
};

/** 评审一条：还差的条目按现在的评审状态分成还在等评审与评审不通过两组；保留了写法的另列（按用户的决定算通过）。 */
function reviewGroups(c: CompletionCondition, items: Item[], task: Task) {
  const mine = items.filter((i) => i.collection === c.collection);
  const missing = mine.filter((i) => c.missing.includes(i.item_id));
  const stateOf = (i: Item) => reviewState(i, task);
  return {
    pending: missing.filter((i) => stateOf(i).state === "pending").map((i) => i.item_id),
    failed: missing.filter((i) => stateOf(i).state === "failed").map((i) => i.item_id),
    kept: mine.filter((i) => { const s = stateOf(i); return s.state === "failed" && !!s.kept; }).map((i) => i.item_id),
  };
}

function lineOf(c: CompletionCondition, task: Task): LinePart[] {
  const state = conditionState(c);
  const requirement = REQUIREMENT[c.name];
  if (!requirement) return [`${c.collection}：${c.name}，${c.note}`];
  if (c.name === "至少一个条目") {
    return [state === "met" ? `${c.collection}至少有一个条目，这一条已经满足。` : `${requirement(c.collection)}，现在一个也没有。`];
  }
  const head = `${requirement(c.collection)}，`;
  if (c.name === REVIEW_CONDITION) {
    const { pending, failed, kept } = reviewGroups(c, task.items, task);
    const keptTail: LinePart[] = kept.length ? ["；", ...idsThat(kept, "评审不通过，但你保留了写法")] : [];
    if (state === "met") return [head, "这一条已经满足", ...keptTail, "。"];
    const groups: LinePart[][] = [];
    if (pending.length) groups.push(idsThat(pending, "还在等评审"));
    if (failed.length) groups.push(idsThat(failed, "评审不通过"));
    // 条目清单与还差的编号对不上时（数据正在更新），只按还差的编号说。
    if (groups.length === 0) groups.push(idsThat(c.missing, "还没有评审通过"));
    return [head, ...groups.flatMap((g, i) => (i > 0 ? ["，", ...g] : g)), ...keptTail, "。"];
  }
  if (state === "met") return [head, "这一条已经满足。"];
  if (c.missing.length === 0) return [`${c.collection}：${c.name}，${c.note}`];
  return [head, ...idsThat(c.missing, c.name === "每个条目用户确认" ? "你还没有读过" : "还没有解决"), "。"];
}

/** 暂时不用核对的条件合成的那一行：只写是哪几个集合还没有条目，集合按接口给的先后、不重复。 */
export function emptyLineText(collections: string[]): string {
  return collections.length === 1
    ? `${collections[0]}现在还没有条目，它的完成条件暂时不用核对。`
    : `${collections.join("、")}现在还没有条目，它们的完成条件暂时不用核对。`;
}

/**
 * 完成条件横条的各行：已经满足的与还差的逐条一行，保持接口给的先后（按集合，再按条件）；
 * 暂时不用核对的（集合还没有条目）不逐条列，合成末尾的一行。
 */
export function completionLines(completion: Completion, task: Task): CompletionLine[] {
  const lines: CompletionLine[] = completion.conditions.filter((c) => conditionState(c) !== "empty")
    .map((c) => ({ key: `${c.collection}/${c.name}`, state: conditionState(c), parts: lineOf(c, task) }));
  const emptyCollections = [...new Set(completion.conditions.filter((c) => conditionState(c) === "empty").map((c) => c.collection))];
  if (emptyCollections.length) lines.push({ key: "暂时不用核对", state: "empty", parts: [emptyLineText(emptyCollections)] });
  return lines;
}

/** 分数「已满足几条／用得上的一共几条」：集合还没有条目、暂时不用核对的条件不算在内。 */
export function completionScore(completion: Completion): { met: number; total: number } {
  const states = completion.conditions.map(conditionState);
  return { met: states.filter((s) => s === "met").length, total: states.filter((s) => s !== "empty").length };
}
