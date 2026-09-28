/**
 * 一个条目在某个修订上的评审结论：完成条件、保留操作、生成文档、查询任务状态、看板与页面都用这一份规则，
 * 各处只负责把自己手里的评审记录与保留记录交给它。不依赖任何模块，页面也直接引用。
 *
 * 规则（以最新一次为准）：
 * 1. 只看这个修订上、按现在的规则评出的记录：记录上的规则指纹与现在的相同。记录或现在的指纹有一边为空时也算——
 *    早期的库没有记指纹，那时的记录读出来指纹为空；集合没有规则文件时现在的指纹为空。两种都没法按指纹区分，照旧算数。
 * 2. 这样的记录一条也没有时是待评审（pending），保留不看：规则改过或条目改到新修订之后，旧的保留不再算数。
 * 3. 其中按事件序号最后一条的结论就是结论：合规是通过（passed）。
 * 4. 最后一条不合规时，有一条没撤销、在这个修订上、事件序号大于最后一条的保留，是已保留（waived，按通过算）；
 *    否则是不通过（failed）。保留针对的是它之前的最后一条记录，在它之后又评出的记录不受它管。
 *
 * 同一条目在同一修订、同一套规则下只评审一次（lib/review.ts），所以一个修订上有好几条当前规则下的记录，
 * 只会出现在这条限制之前写下的旧数据里；第 3 条保证这时仍有确定的结论。
 */

/** 一条评审记录里判断要用的几项；seq 是写下它的那条事件的序号。 */
export interface VerdictReview { revision_no: number; verdict: string; rules_hash?: string | null; seq: number }
/** 一条保留记录里判断要用的几项；seq 是写下它的那条事件的序号。 */
export interface VerdictWaiver { revision_no: number; seq: number; revoked: boolean }

export type VerdictState = "pending" | "passed" | "failed" | "waived";

export interface ReviewVerdict<R extends VerdictReview, W extends VerdictWaiver> {
  state: VerdictState;
  /** 结论依据的那条：这个修订上、当前规则下事件序号最大的记录；待评审时为 null。 */
  basis: R | null;
  /** 生效的保留：只在 waived 时有。 */
  waiver: W | null;
  /** 这个修订上、当前规则下的全部记录，按事件序号从小到大。 */
  current: R[];
}

/** 一条记录算不算按现在的规则评出的：两边的指纹相同，或者有一边为空（见文件头第 1 条）。 */
export function underCurrentRules(recordHash: string | null | undefined, currentHash: string | null | undefined): boolean {
  return !recordHash || !currentHash || recordHash === currentHash;
}

/** 条目在 revision 这个修订上的评审结论。reviews 与 waivers 可以含别的修订、别的规则下的记录，顺序不限。 */
export function reviewVerdict<R extends VerdictReview, W extends VerdictWaiver>(
  revision: number, reviews: readonly R[], waivers: readonly W[], currentHash: string | null | undefined,
): ReviewVerdict<R, W> {
  const current = reviews.filter((r) => r.revision_no === revision && underCurrentRules(r.rules_hash, currentHash))
    .sort((a, b) => a.seq - b.seq);
  const basis = current.length ? current[current.length - 1] : null;
  if (!basis) return { state: "pending", basis: null, waiver: null, current };
  if (basis.verdict === "合规") return { state: "passed", basis, waiver: null, current };
  const waiver = waivers.filter((w) => w.revision_no === revision && !w.revoked && w.seq > basis.seq)
    .sort((a, b) => a.seq - b.seq).pop() ?? null;
  return { state: waiver ? "waived" : "failed", basis, waiver, current };
}
