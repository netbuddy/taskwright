// 「确认已失效」的差异：列表型字段按步骤对齐比对（最长公共子序列），相邻的一删一增合成「这一步改了」。
// 文本字段整体比较。只比较，不判断改得对不对。

import type { CollectionDef, FieldValue, Fields } from "../api/types";

export type StepRow =
  | { kind: "same"; index: number; text: string }
  | { kind: "changed"; index: number; before: string; after: string }
  | { kind: "added"; index: number; text: string }
  | { kind: "removed"; before: string };

/** 两个字符串列表按步骤对齐。index 是这一步在改后列表里的序号（从 0 起），删掉的步骤没有序号。 */
export function alignSteps(before: string[], after: string[]): StepRow[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const raw: StepRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      raw.push({ kind: "same", index: j, text: after[j] });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      raw.push({ kind: "added", index: j, text: after[j] });
      j++;
    } else {
      raw.push({ kind: "removed", before: before[i] });
      i++;
    }
  }
  // 紧挨着的「删一步、加一步」合成「这一步改了」。
  const rows: StepRow[] = [];
  for (let k = 0; k < raw.length; k++) {
    const a = raw[k];
    const b = raw[k + 1];
    if (a.kind === "removed" && b?.kind === "added") {
      rows.push({ kind: "changed", index: b.index, before: a.before, after: b.text });
      k++;
    } else if (a.kind === "added" && b?.kind === "removed") {
      rows.push({ kind: "changed", index: a.index, before: b.before, after: a.text });
      k++;
    } else {
      rows.push(a);
    }
  }
  return rows;
}

export interface FieldDiff {
  field: string;
  list: boolean;
  before: FieldValue;
  after: FieldValue;
  steps?: StepRow[];
}

const asList = (v: FieldValue | undefined): string[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [String(v)]);

/** 两版字段之间有改动的那几个字段，按集合声明的字段顺序。 */
export function diffFields(def: CollectionDef, before: Fields, after: Fields): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const f of def.fields) {
    const b = before[f.name] ?? null;
    const a = after[f.name] ?? null;
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    const list = f.type === "文本列表" || f.type === "条目引用";
    out.push({ field: f.name, list, before: b, after: a, steps: list ? alignSteps(asList(b), asList(a)) : undefined });
  }
  return out;
}
