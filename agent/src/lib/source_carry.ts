/**
 * 条目被修改时，原来的来源怎样跟着内容走。宁可多留：来源指向材料原文是产品最核心的承诺，丢来源比多留来源更伤信任。
 *
 * 来源指到字段，列表型字段（文本列表、条目引用）还可以指到其中一项，库里只记序号。列表插入、删除别的项、调换先后之后，
 * 同一个序号就指到了别的项上，所以按每一项的内容认它现在排在第几（alignList），来源跟着那一项走：
 * - 字段没改、列表里内容没变的项：来源保留，序号改成它现在的位置；
 * - 列表里删掉的项：它的内容已经不在条目里，指到它的那一处去掉；一条来源去掉这些之后什么都不支持了，整条去掉；
 * - 改写了的内容（列表里原地改了文字的项，或者整个改了的普通字段）：来源照旧留着，指到改写之后的那一处，记进 rewritten，
 *   由调用方提醒改的一方检查。支持整个列表的来源，列表里原有的项有改写或删掉的才记进 rewritten，只加项、调换先后不算。程序看不出改写之后的话是否仍然出自那段原文，这是内容判断，程序不做。
 * 字段被清空时，指到它的那一处去掉（内容已经不在）。
 *
 * 只做这一件事，不读库、不核对摘录：保留下来的旧来源在给出时已经核对过。「保存修订」（执行者修改时）用它；
 * 用户在界面上直接改字段时也用它（lib/user_ops.ts 的 withUserEditSources），再去掉用户改写处的来源。
 */

import type { Source, Support } from "./save_revision.ts";

type Fields = Record<string, unknown>;

/** 旧列表里的一项在新列表里的去向：to 是新的序号，删掉时为 null；rewritten 为真表示它原地改写成了 to 那一项。 */
export interface ItemFate {
  to: number | null;
  rewritten: boolean;
}

const keyOf = (value: unknown): string => JSON.stringify(value);

/**
 * 按内容认列表项：旧列表每一项在新列表里排在第几。
 * 1. 内容完全相同的项一一对应；同样的内容出现几次，按先后一一对应。这一步覆盖插入、删除别的项、调换先后。
 * 2. 剩下没对上的旧项，按它前后最近的、对上了的两项划出一段；新列表里落在这两项新位置之间、也没对上的项，与这段里的旧项按先后配对，
 *    算作原地改写。前后两项在新列表里的先后颠倒了（调换过先后），这一段不配对。配不上的旧项算删掉。
 */
export function alignList(before: readonly unknown[], after: readonly unknown[]): ItemFate[] {
  const fates: ItemFate[] = before.map(() => ({ to: null, rewritten: false }));
  const takenNew = new Set<number>();
  const newByKey = new Map<string, number[]>();
  after.forEach((value, index) => {
    const key = keyOf(value);
    newByKey.set(key, [...(newByKey.get(key) ?? []), index]);
  });
  before.forEach((value, index) => {
    const queue = newByKey.get(keyOf(value));
    if (queue?.length) {
      const to = queue.shift()!;
      fates[index] = { to, rewritten: false };
      takenNew.add(to);
    }
  });
  let i = 0;
  while (i < before.length) {
    if (fates[i].to !== null) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < before.length && fates[j].to === null) j += 1;
    // 旧列表 [i, j) 这一段都没对上；它前后对上了的两项在新列表里的位置划出配对的范围。
    const low = i > 0 ? fates[i - 1].to! : -1;
    const high = j < before.length ? fates[j].to! : after.length;
    // 前后两项调换过先后时 low 不小于 high，这个范围是空的，这一段不配对。
    const candidates: number[] = [];
    for (let k = low + 1; k < high; k++) if (!takenNew.has(k)) candidates.push(k);
    for (let k = i; k < j && candidates.length; k++) {
      const to = candidates.shift()!;
      fates[k] = { to, rewritten: true };
      takenNew.add(to);
    }
    i = j;
  }
  return fates;
}

/** 一条保留下来、但它支持的内容被改写了的来源，以及它支持的那几处（改写之后的位置）。 */
export interface RewrittenSupport {
  source: Source;
  supports: Support[];
}

export interface CarryResult {
  /** 保留下来的来源，序号已改成改后的位置。 */
  kept: Source[];
  /** kept 里支持的内容被改写了的那些（同一个对象），以及是哪几处。 */
  rewritten: RewrittenSupport[];
}

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  || (Array.isArray(value) && value.every((one) => typeof one === "string" && one.trim() === ""));

/**
 * 修改之后原来的来源怎样沿用。before 与 after 是改前、改后的全部字段；listFields 是列表型字段的名字。
 * 支持整个条目的来源（supports 为空）原样保留。
 */
export function carrySources(previous: readonly Source[], before: Fields, after: Fields, listFields: ReadonlySet<string>): CarryResult {
  const fates = new Map<string, ItemFate[]>();
  const fateOf = (field: string): ItemFate[] => {
    if (!fates.has(field)) {
      const old = Array.isArray(before[field]) ? (before[field] as unknown[]) : [];
      const now = Array.isArray(after[field]) ? (after[field] as unknown[]) : [];
      fates.set(field, alignList(old, now));
    }
    return fates.get(field)!;
  };
  const kept: Source[] = [];
  const rewritten: RewrittenSupport[] = [];
  for (const source of previous) {
    if (source.supports.length === 0) {
      kept.push(source);
      continue;
    }
    const supports: Support[] = [];
    const changedHere: Support[] = [];
    for (const support of source.supports) {
      const changed = keyOf(before[support.field]) !== keyOf(after[support.field]);
      if (!changed) {
        supports.push(support);
        continue;
      }
      if (isEmpty(after[support.field])) continue;
      if (!listFields.has(support.field)) {
        supports.push(support);
        changedHere.push(support);
        continue;
      }
      if (support.index === undefined) {
        // 支持整个列表：只加项、调换先后不算改写；原有的项有改写或删掉的才算。
        supports.push(support);
        if (fateOf(support.field).some((fate) => fate.to === null || fate.rewritten)) changedHere.push(support);
        continue;
      }
      const fate = fateOf(support.field)[support.index];
      if (!fate || fate.to === null) continue;
      const moved = { field: support.field, index: fate.to };
      supports.push(moved);
      if (fate.rewritten) changedHere.push(moved);
    }
    if (supports.length === 0) continue;
    const one = { ...source, supports };
    kept.push(one);
    if (changedHere.length) rewritten.push({ source: one, supports: changedHere });
  }
  return { kept, rewritten };
}

/** 两条来源是不是同一句摘录：种类、出处、摘录、写入值都相同（支持哪几处不比）。 */
export function sameQuote(a: Source, b: Source): boolean {
  return a.kind === b.kind && a.locator === b.locator && a.excerpt === b.excerpt && (a.normalized_value ?? null) === (b.normalized_value ?? null);
}

/**
 * 把这次新给的来源接到保留下来的来源后面。与某条保留下来的是同一句摘录时合成一条：支持的几处取并集；
 * 有一边支持整个条目（supports 为空），合成之后也支持整个条目。返回合成之后的列表，以及被新给的来源重新写上过的那些旧来源。
 */
export function mergeGiven(kept: readonly Source[], given: readonly Source[]): { sources: Source[]; restated: Set<Source> } {
  const sources = kept.map((one) => ({ ...one, supports: [...one.supports] }));
  const restated = new Set<Source>();
  for (const add of given) {
    const at = sources.findIndex((one) => sameQuote(one, add));
    if (at < 0) {
      sources.push(add);
      continue;
    }
    restated.add(kept[at]);
    const one = sources[at];
    if (one.supports.length === 0 || add.supports.length === 0) {
      one.supports = [];
      continue;
    }
    for (const support of add.supports) {
      if (!one.supports.some((have) => have.field === support.field && have.index === support.index)) one.supports.push(support);
    }
  }
  return { sources, restated };
}
