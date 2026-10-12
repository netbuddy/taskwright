/**
 * 从总体分析的页与问题条目算出来的三张表（src/lib/overall_views.ts）：规则表、业务目标、决策记录与待澄清事项。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ViewPage, type ViewQuestion, type ViewSource, decisionsAndOpenQuestions, goalTree, isOpenRuleConflict, rulesTable, whyOf } from "../src/lib/overall_views.ts";

const page = (id: string, fields: Record<string, unknown>, sources: ViewSource[] = [], at: string | null = null): ViewPage =>
  ({ item_id: id, fields: { 状态: "在用", ...fields }, sources, created_at: at });
const question = (id: string, subject: string, over: Partial<ViewQuestion> = {}): ViewQuestion =>
  ({ item_id: id, subject, open: true, kind: "待澄清", suggestion: "", sources: [], created_at: null, ...over });
const cite = (locator: string, excerpt: string): ViewSource => ({ kind: "条目", locator, excerpt, supports: [] });
const said = (excerpt: string, index: number | null): ViewSource =>
  ({ kind: "用户的话", locator: "s#1", excerpt, supports: [index === null ? { field: "已经定下的" } : { field: "已经定下的", index }] });

test("规则表：在用的各页「已经定下的」逐条列出，带页的编号与标题、第几条、出处；已废弃的页与空的项不列", () => {
  const table = rulesTable([
    page("OA-001", { 标题: "借阅期限", 已经定下的: ["一次最多借 30 天。", "  ", "逾期每天罚 1 角。"] },
      [said("最多借三十天", 0), said("逾期一天一角", 2), { kind: "文档原文", locator: "inputs/规定.md", excerpt: "借阅期限为 30 天", supports: [{ field: "它是什么" }] }]),
    page("OA-002", { 标题: "旧规定", 状态: "已废弃", 已经定下的: ["一次最多借 15 天。"] }),
    page("OA-003", { 标题: "续借", 已经定下的: ["每本书可以续借一次。"] }, [{ kind: "用户的话", locator: "s#2", excerpt: "可以续一次", supports: [] }]),
    page("OA-004", { 标题: "读者" }),
  ], []);
  assert.deepEqual(table.rows, [
    { item_id: "OA-001", title: "借阅期限", index: 0, text: "一次最多借 30 天。", sources: [{ kind: "用户的话", locator: "s#1", excerpt: "最多借三十天" }], conflicts: [] },
    { item_id: "OA-001", title: "借阅期限", index: 2, text: "逾期每天罚 1 角。", sources: [{ kind: "用户的话", locator: "s#1", excerpt: "逾期一天一角" }], conflicts: [] },
    // 没有写支持哪几处的来源支持整个条目，每一条规则的出处里都有它。
    { item_id: "OA-003", title: "续借", index: 0, text: "每本书可以续借一次。", sources: [{ kind: "用户的话", locator: "s#2", excerpt: "可以续一次" }], conflicts: [] },
  ]);
  assert.deepEqual([table.conflicts, table.unmatched], [[], []]);
  // 指到整个字段（不写第几项）的来源，这个字段的每一条规则都算。
  const whole = rulesTable([page("OA-001", { 标题: "借阅期限", 已经定下的: ["甲。", "乙。"] }, [said("甲乙都是用户定的", null)])], []);
  assert.deepEqual(whole.rows.map((row) => row.sources.length), [1, 1]);
});

test("规则表：还没有了结的规则冲突问题，把它的来源指到的两条规则标为冲突；了结之后不再标；对不上规则的单独列出", () => {
  const pages = [
    page("OA-001", { 标题: "借阅期限", 已经定下的: ["一次最多借 30 天。", "逾期每天罚 1 角。"] }),
    page("OA-002", { 标题: "教师借阅", 已经定下的: ["教师一次最多借 60 天。"] }),
  ];
  const conflict = question("TBD-001", "规则冲突：借阅期限是 30 天还是 60 天", { sources: [cite("OA-001", "一次最多借 30 天。"), cite("OA-002", "最多借 60 天")] });
  const open = rulesTable(pages, [conflict, question("TBD-002", "逾期罚款有没有上限")]);
  assert.deepEqual(open.rows.map((row) => [row.item_id, row.index, row.conflicts]), [["OA-001", 0, ["TBD-001"]], ["OA-001", 1, []], ["OA-002", 0, ["TBD-001"]]]);
  assert.deepEqual([open.conflicts, open.unmatched], [["TBD-001"], []]);
  // 了结了（状态不再是未解决）：不标。
  const closed = rulesTable(pages, [{ ...conflict, open: false }]);
  assert.deepEqual([closed.rows.flatMap((row) => row.conflicts), closed.conflicts, closed.unmatched], [[], [], []]);
  // 来源没有指到任何一条规则（只写了用户的话，或者摘录对不上）：算冲突，另列在 unmatched 里。
  const loose = rulesTable(pages, [
    question("TBD-003", "规则冲突：罚款两处说法不一", { sources: [{ kind: "用户的话", locator: "s#3", excerpt: "两处说法不一", supports: [] }] }),
    question("TBD-004", "规则冲突：续借", { sources: [cite("OA-001", "每本书可以续借一次。"), cite("OA-009", "一次最多借 30 天。")] }),
  ]);
  assert.deepEqual([loose.rows.flatMap((row) => row.conflicts), loose.conflicts, loose.unmatched], [[], ["TBD-003", "TBD-004"], ["TBD-003", "TBD-004"]]);
  // 两条冲突问题指到同一条规则：两个编号都在。
  const twice = rulesTable(pages, [conflict, question("TBD-005", "规则冲突：期限与假期", { sources: [cite("OA-001", "一次最多借 30 天。")] })]);
  assert.deepEqual(twice.rows[0].conflicts, ["TBD-001", "TBD-005"]);
  assert.equal(isOpenRuleConflict({ subject: "  规则冲突：前面有空白也认", open: true }), true);
  assert.equal(isOpenRuleConflict({ subject: "关于规则冲突：不在开头的不认", open: true }), false);
});

test("业务目标：目标按上级主题排成树，决定挂在它上级的目标下并带为什么；挂不上的决定单独列出；已废弃的不列", () => {
  const tree = goalTree([
    page("OA-001", { 标题: "少排队", 标签: ["目标"] }),
    page("OA-002", { 标题: "自助借还", 标签: ["目标"], 上级主题: ["OA-001"] }),
    page("OA-003", { 标题: "买自助机", 标签: ["决定"], 上级主题: ["OA-002"], 已经定下的: ["每层放两台自助机。", "年内到位。"], 它是什么: "馆里决定采购自助借还机。" }),
    page("OA-004", { 标题: "不做预约", 标签: ["决定"], 上级主题: ["OA-009"], 它是什么: "本期不做预约。\n\n以后再看。" }),
    page("OA-005", { 标题: "读者", 标签: ["角色"], 上级主题: ["OA-001"] }),
    page("OA-006", { 标题: "旧目标", 标签: ["目标"], 状态: "已废弃" }),
    page("OA-007", { 标题: "跟着旧目标的决定", 标签: ["决定"], 上级主题: ["OA-006"] }),
    page("OA-008", { 标题: "省人力", 标签: ["目标", "决定"], 上级主题: "OA-001" }),
  ]);
  assert.deepEqual(tree.roots, [{
    item_id: "OA-001", title: "少排队", decisions: [],
    goals: [
      { item_id: "OA-002", title: "自助借还", goals: [], decisions: [{ item_id: "OA-003", title: "买自助机", why: "每层放两台自助机。" }] },
      // 同时贴了目标与决定的页算目标；上级主题写成一个编号（不是列表）也认。
      { item_id: "OA-008", title: "省人力", goals: [], decisions: [] },
    ],
  }]);
  assert.deepEqual(tree.loose, [
    { item_id: "OA-004", title: "不做预约", why: "本期不做预约。" },
    { item_id: "OA-007", title: "跟着旧目标的决定", why: "" },
  ]);
  assert.equal(whyOf({}), "");
});

test("业务目标：上级主题写成了环，环上的目标都排到最上层；自己是自己的上级时当作没有上级", () => {
  const tree = goalTree([
    page("OA-001", { 标题: "甲", 标签: ["目标"], 上级主题: ["OA-002"] }),
    page("OA-002", { 标题: "乙", 标签: ["目标"], 上级主题: ["OA-001"] }),
    page("OA-003", { 标题: "丙", 标签: ["目标"], 上级主题: ["OA-003"] }),
    page("OA-004", { 标题: "丁", 标签: ["目标"], 上级主题: ["OA-003"] }),
  ]);
  assert.deepEqual(tree.roots.map((one) => [one.item_id, one.goals.map((sub) => sub.item_id)]), [["OA-001", []], ["OA-002", []], ["OA-003", ["OA-004"]]]);
});

test("决策记录与待澄清事项：决定与还没有了结的问题按第一次保存的时刻合成一张表；了结的问题、不是决定的页、已废弃的页不列", () => {
  const rows = decisionsAndOpenQuestions([
    page("OA-001", { 标题: "买自助机", 标签: ["决定"], 已经定下的: ["每层放两台。"] }, [], "2026-03-02T10:00:00"),
    page("OA-002", { 标题: "读者", 标签: ["角色"] }, [], "2026-03-01T09:00:00"),
    page("OA-003", { 标题: "不做预约", 标签: ["决定"], 它是什么: "本期不做预约。" }, [], "2026-03-04T08:00:00"),
    page("OA-004", { 标题: "作废的决定", 标签: ["决定"], 状态: "已废弃" }, [], "2026-03-01T08:00:00"),
    page("OA-005", { 标题: "没有时刻的决定", 标签: ["决定"] }),
  ], [
    question("TBD-001", "逾期罚款有没有上限", { created_at: "2026-03-03T12:00:00", suggestion: "建议封顶为书价。" }),
    question("TBD-002", "已经答复的问题", { open: false, created_at: "2026-03-01T12:00:00" }),
    question("TBD-003", "规则冲突：期限", { created_at: "2026-03-02T10:00:00", kind: null }),
  ]);
  assert.deepEqual(rows, [
    { entry: "decision", item_id: "OA-001", title: "买自助机", at: "2026-03-02T10:00:00", note: "每层放两台。", question_kind: null },
    // 时刻相同：页在前、问题在后。
    { entry: "question", item_id: "TBD-003", title: "规则冲突：期限", at: "2026-03-02T10:00:00", note: "", question_kind: null },
    { entry: "question", item_id: "TBD-001", title: "逾期罚款有没有上限", at: "2026-03-03T12:00:00", note: "建议封顶为书价。", question_kind: "待澄清" },
    { entry: "decision", item_id: "OA-003", title: "不做预约", at: "2026-03-04T08:00:00", note: "本期不做预约。", question_kind: null },
    // 取不到时刻的排在最后。
    { entry: "decision", item_id: "OA-005", title: "没有时刻的决定", at: null, note: "", question_kind: null },
  ]);
  assert.deepEqual(decisionsAndOpenQuestions([], []), []);
});
