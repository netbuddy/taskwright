// 对话理解评测的判分逻辑、从平台 skill 截取第八节、提示拼装，以及评测集本身的形式（agent/eval/understanding/）。
// 跑分要调真模型，不在这里；这里只测不调模型的部分。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildPrompt, majority, parseUnderstanding, scoreCase, tally, understandingSection, type EvalCase, type ExpectedAct } from "../eval/understanding/eval_lib.ts";
import { INTENT_SCHEMA, schemaErrors, USER_FUNCTIONS } from "../src/lib/intent_schema.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SKILL = readFileSync(join(ROOT, "agent/prompts/skills/taskwright-executor/SKILL.md"), "utf-8");
const CASES: EvalCase[] = readFileSync(join(ROOT, "agent/eval/understanding/cases.jsonl"), "utf-8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const exp = (function_: string, keywords: string[], extra: Partial<ExpectedAct> = {}): ExpectedAct =>
  ({ function: function_, summary: "", keywords, ...extra });

test("从 SKILL.md 截取第八节：从「## 八、」到下一个二级标题之前，含由 schema 生成的格式说明", () => {
  const section = understandingSection(SKILL);
  assert.match(section, /^## 八、先写理解/);
  assert.match(section, /（理解格式说明开始/);
  assert.match(section, /（理解格式说明结束）$/);
  assert.doesNotMatch(section, /## 九、/);
  assert.throws(() => understandingSection("## 一、别的\n内容"), /找不到第八节/);
});

test("提示拼装：第八节原文、条目清单、等回应的行为（写中文名与涉及的条目）、上一轮对话与用户的话都在里面", () => {
  const c: EvalCase = {
    id: "T-1", source: "补写", text: "前两条可以",
    context: { items: [{ item_id: "UC-001", collection: "功能用例", title: "借阅图书" }],
      pending: [{ id: "r3-2", kind: "confirm", text: "请确认 UC-001。", items: ["UC-001"] }], previous_user: "看看", previous_reply: "请确认。" },
    expected: { acts: [] }, note: "",
  };
  const prompt = buildPrompt("## 八、先写理解\n（第八节原文）", c);
  assert.match(prompt, /## 八、先写理解\n（第八节原文）/);
  assert.match(prompt, /- UC-001 · 功能用例 · 借阅图书/);
  assert.match(prompt, /- r3-2（请确认）：请确认 UC-001。（涉及 UC-001）/);
  assert.match(prompt, /用户上一句话：「看看」/);
  assert.match(prompt, /你上一次回复的正文：「请确认。」/);
  assert.match(prompt, /用户这句话：「前两条可以」$/);
  const empty = buildPrompt("§", { ...c, context: { items: [], pending: [] } });
  assert.match(empty, /（还没有条目）/);
  assert.match(empty, /还在等用户回应的对话行为：\n（没有）/);
  assert.doesNotMatch(empty, /用户上一句话/);
});

test("认输出：围栏里或裸写的理解都认得；不合 schema 的与没有 JSON 的算格式不合格，带原因", () => {
  const good = '先写理解：\n```json\n{"acts":[{"function":"affirm","confidence":"high","summary":"UC-001 的当前修订"}]}\n```';
  assert.deepEqual(parseUnderstanding(good), { acts: [{ function: "affirm", confidence: "high", summary: "UC-001 的当前修订" }] });
  assert.equal("acts" in parseUnderstanding('{"acts":[{"function":"inform","confidence":"low","summary":"x"}]}'), true);
  const bad = parseUnderstanding('{"acts":[{"function":"agree","confidence":"high","summary":"x"}]}');
  assert.ok("error" in bad && /function/.test(bad.error));
  assert.deepEqual(parseUnderstanding("我理解了。"), { error: "输出里没有 JSON 片段" });
});

test("判分：四项各自独立；字段写了就要一致；关键词可以写几种说法；纠正另记变更方式", () => {
  const expected = [
    exp("affirm", ["UC-001"], { targets: [{ item_id: "UC-001" }], responds_to: "r3-2" }),
    exp("correct", ["三十天|30"], { targets: [{ item_id: "UC-003", field: "借阅期限" }], responds_to: "r3-2", change: "改为" }),
  ];
  const right = [
    { function: "affirm", targets: [{ item_id: "UC-001" }], responds_to: "r3-2", summary: "UC-001 的当前修订" },
    { function: "correct", targets: [{ item_id: "UC-003", field: "借阅期限" }], responds_to: "r3-2", summary: "UC-003 的借阅期限改为 30 天" },
  ];
  const s = scoreCase(expected, right);
  assert.deepEqual([s.format, s.functions, s.targets, s.responds, s.summary], [true, true, true, true, true]);
  assert.deepEqual(s.changes, [{ change: "改为", ok: true }]);
  assert.deepEqual(s.diff, []);

  // 少了一项：功能错，摘要按全部摘要找；字段没写：目标错；没写回应：回应错
  const wrong = scoreCase(expected, [{ function: "correct", targets: [{ item_id: "UC-001" }, { item_id: "UC-003" }], summary: "UC-003 借阅期限 30 天，UC-001 可以" }]);
  assert.deepEqual([wrong.functions, wrong.targets, wrong.responds, wrong.summary], [false, false, false, true]);
  assert.deepEqual(wrong.changes, [{ change: "改为", ok: false }]);
  assert.deepEqual(wrong.perAct, [{ function: "affirm", ok: false }, { function: "correct", ok: false }]);
  assert.equal(wrong.diff.length, 3);

  // 格式不合格：四项都错
  const none = scoreCase(expected, null);
  assert.deepEqual([none.format, none.functions, none.targets, none.responds, none.summary], [false, false, false, false, false]);
  // 都不写 targets 与 responds_to 也算一致
  const q = scoreCase([exp("question", ["完成"])], [{ function: "question", summary: "现在能不能完成" }]);
  assert.deepEqual([q.targets, q.responds, q.summary], [true, true, true]);
});

test("多次运行取多数，汇总出四项、按功能与变更方式的准确率", () => {
  const e = [exp("inform", ["60"])];
  const ok = scoreCase(e, [{ function: "inform", summary: "借期 60 天" }]);
  const bad = scoreCase(e, [{ function: "request", summary: "借期" }]);
  assert.equal(majority([ok, ok, bad]).functions, true);
  assert.equal(majority([ok, bad, bad]).functions, false);
  assert.equal(majority([ok, bad]).functions, false);
  const t = tally([ok, bad]);
  assert.equal(t.functions, "1/2（50%）");
  assert.deepEqual(t.byFunction, [{ function: "inform", name: "告知", accuracy: "1/2（50%）" }]);
  assert.equal(t.changes, "—");
});

test("评测集：每例期望符合理解 schema，targets 是上下文里有的条目，responds_to 是上下文里等回应的行为；覆盖面够", () => {
  assert.ok(CASES.length >= 50 && CASES.length <= 75, `例数 ${CASES.length}`);
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  assert.ok(CASES.filter((c) => c.source === "补写").length * 3 <= CASES.length, "补写不超过三分之一");
  for (const c of CASES) {
    const acts = c.expected.acts.map(({ keywords, change, ...a }) => ({ ...a, confidence: "high" }));
    assert.deepEqual(schemaErrors({ acts }, INTENT_SCHEMA), [], c.id);
    const items = new Set(c.context.items.map((i) => i.item_id));
    const pending = new Set(c.context.pending.map((p) => p.id));
    for (const a of c.expected.acts) {
      assert.ok(a.keywords.length > 0, `${c.id} 没写关键词`);
      for (const t of a.targets ?? []) assert.ok(items.has(t.item_id), `${c.id} 的 ${t.item_id} 不在条目清单里`);
      if (a.responds_to) assert.ok(pending.has(a.responds_to), `${c.id} 的 ${a.responds_to} 不在等回应的行为里`);
      if (a.function === "correct") assert.ok(a.change, `${c.id} 的纠正没写变更方式`);
    }
    assert.ok(c.note.trim(), `${c.id} 没写标注说明`);
  }
  const acts = CASES.flatMap((c) => c.expected.acts);
  for (const f of USER_FUNCTIONS) assert.ok(acts.filter((a) => a.function === f).length >= 3, `${f} 不到 3 例`);
  assert.ok(CASES.filter((c) => c.expected.acts.length > 1).length >= 8, "复合回答不到 8 例");
  assert.ok(CASES.filter((c) => c.expected.acts.some((a) => a.responds_to)).length >= 8, "带回应的不到 8 例");
  for (const mode of ["改为", "追加", "删去"]) assert.ok(acts.filter((a) => a.change === mode).length >= 2, `${mode} 不到 2 例`);
});
