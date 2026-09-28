// 评审结论（lib/review_verdict.ts）：以最新一次为准。一个修订上评过几次、保留在哪一次之后、规则改过、条目改到新修订，各一例。
// 同一修订、同一套规则下有好几条记录，只出现在「只评审一次」这条限制之前写下的旧数据里；这里照样核对读它们的规则。

import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewVerdict, underCurrentRules, type VerdictReview, type VerdictWaiver } from "../src/lib/review_verdict.ts";

const H = "rules-a";
let seq = 0;
const review = (verdict: string, extra: Partial<VerdictReview> = {}): VerdictReview =>
  ({ revision_no: 3, verdict, rules_hash: H, seq: ++seq, ...extra });
const waiver = (extra: Partial<VerdictWaiver> = {}): VerdictWaiver => ({ revision_no: 3, seq: ++seq, revoked: false, ...extra });
const verdict = (reviews: VerdictReview[], waivers: VerdictWaiver[] = [], hash: string | null = H, revision = 3) =>
  reviewVerdict(revision, reviews, waivers, hash);

test("没有记录：待评审", () => {
  const v = verdict([]);
  assert.deepEqual(v, { state: "pending", basis: null, waiver: null, current: [] });
});

test("只有一条合规：通过，依据就是它", () => {
  const ok = review("合规");
  assert.deepEqual(verdict([ok]), { state: "passed", basis: ok, waiver: null, current: [ok] });
});

test("只有一条不合规：不通过", () => {
  const bad = review("不合规");
  assert.deepEqual(verdict([bad]), { state: "failed", basis: bad, waiver: null, current: [bad] });
});

test("先合规后不合规（旧数据，例如强制重评）：以后一条为准，不通过；强制重评的记录与普通记录一样", () => {
  const ok = review("合规");
  const bad = { ...review("不合规"), forced: 1 };
  const v = verdict([ok, bad]);
  assert.equal(v.state, "failed");
  assert.equal(v.basis, bad);
  assert.deepEqual(v.current, [ok, bad]);
  // 此时保留点得成：保留在不合规那一条之后
  const w = waiver();
  assert.deepEqual(verdict([ok, bad], [w]), { state: "waived", basis: bad, waiver: w, current: [ok, bad] });
});

test("先不合规后合规：以后一条为准，通过；此前的不合规不再算", () => {
  const bad = review("不合规");
  const ok = review("合规");
  const v = verdict([bad, ok]);
  assert.equal(v.state, "passed");
  assert.equal(v.basis, ok);
});

test("按事件序号认先后，不按传进来的顺序", () => {
  const bad = review("不合规");
  const ok = review("合规");
  assert.equal(verdict([ok, bad]).basis, ok);
  assert.deepEqual(verdict([ok, bad]).current, [bad, ok]);
});

test("不合规之后保留：已保留，给出生效的保留；撤销之后回到不通过", () => {
  const bad = review("不合规");
  const w = waiver();
  assert.deepEqual(verdict([bad], [w]), { state: "waived", basis: bad, waiver: w, current: [bad] });
  assert.equal(verdict([bad], [{ ...w, revoked: true }]).state, "failed");
  // 撤销后又保留：取没撤销的那一条
  const again = waiver();
  assert.equal(verdict([bad], [{ ...w, revoked: true }, again]).waiver, again);
});

test("保留之后又重评成合规（旧数据）：通过，保留不再列出", () => {
  const bad = review("不合规");
  const w = waiver();
  const ok = review("合规");
  assert.deepEqual(verdict([bad, ok], [w]), { state: "passed", basis: ok, waiver: null, current: [bad, ok] });
});

test("保留之后又重评成不合规（旧数据）：原来的保留针对的是前一条，不算，结论是不通过", () => {
  const first = review("不合规");
  const w = waiver();
  const second = review("不合规");
  const v = verdict([first, second], [w]);
  assert.equal(v.state, "failed");
  assert.equal(v.basis, second);
  assert.equal(v.waiver, null);
  // 对后一条再保留一次才算
  const w2 = waiver();
  assert.equal(verdict([first, second], [w, w2]).waiver, w2);
});

test("保留在别的修订上：不算", () => {
  const bad = review("不合规");
  assert.equal(verdict([bad], [waiver({ revision_no: 2 })]).state, "failed");
});

test("规则改过之后：旧规则下的记录不算，回到待评审，旧的保留也不看", () => {
  const bad = review("不合规");
  const w = waiver();
  const ok = review("合规");
  assert.deepEqual(verdict([bad, ok], [w], "rules-b"), { state: "pending", basis: null, waiver: null, current: [] });
  // 新规则下评过一次不合规：旧的保留在它之前，也不算
  const fresh = review("不合规", { rules_hash: "rules-b" });
  const v = verdict([bad, ok, fresh], [w], "rules-b");
  assert.equal(v.state, "failed");
  assert.deepEqual(v.current, [fresh]);
});

test("条目改到新修订之后：旧修订上的记录与保留都不算", () => {
  const bad = review("不合规", { revision_no: 2 });
  const w = waiver({ revision_no: 2 });
  const ok = review("合规", { revision_no: 2 });
  assert.equal(verdict([bad, ok], [w], H, 3).state, "pending");
  const now = review("不合规", { revision_no: 3 });
  const v = verdict([bad, ok, now], [w], H, 3);
  assert.equal(v.state, "failed");
  assert.deepEqual(v.current, [now]);
});

test("指纹有一边为空时算数：早期的库没有记指纹；集合没有规则文件时现在的指纹为空", () => {
  assert.equal(underCurrentRules(null, H), true);
  assert.equal(underCurrentRules(undefined, H), true);
  assert.equal(underCurrentRules("rules-b", null), true);
  assert.equal(underCurrentRules("rules-b", H), false);
  assert.equal(underCurrentRules(H, H), true);
  // 早期没有指纹的合规记录，现在有指纹：仍算通过
  const old = review("合规", { rules_hash: null });
  assert.equal(verdict([old]).state, "passed");
  // 现在的指纹为空：记着别的指纹的记录也算
  const other = review("不合规", { rules_hash: "rules-b" });
  assert.equal(verdict([other], [], null).state, "failed");
});
