/**
 * 整份数据里的 stage（任务现在的工作阶段与每个阶段的几盏灯）与库事件 stage_changed：
 * 任务库经子进程里助手一侧真实的保存、界面操作建，这里只读。早先建的任务没有阶段；还没有阶段记录表的库当作没有移过。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import * as library from "../src/library.ts";
import { makeWorkspace, sqlRun, tempDir } from "./helpers.ts";
import { DEFINITION, build, page } from "./overall_stack.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const FLOW = page({ 标题: "预约取书", 标签: ["流程"], 例子: ["小王周六预约了一本书。"] });
const USE_CASE = { op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["选书"] }, sources: [{ kind: "条目", locator: "OA-001", excerpt: "读者对在架的书办预约。" }] };
const lampOf = (stage: NonNullable<ReturnType<typeof library.stageView>>, key: string) => Object.values(stage.lamps).flat().find((one) => one.key === key)!;

test("整份数据带 stage：现在的阶段、最近一次是谁在什么时候为什么移的、五个阶段的灯", () => {
  // 夹具一建好任务就由用户移到写条目；之后助手立一页流程，用户看过它，助手依据它写一条用例；最后用户移到评审确认并写了理由。
  const ws = build(tmp, "stage", DEFINITION, [[FLOW], { view: ["OA-001"] }, [USE_CASE]]);
  const [, task] = library.taskSnapshot(ws);
  const stage = task!.stage!;
  assert.deepEqual([stage.current, stage.moved_by, stage.reason], ["writing", "user", ""]);
  assert.match(stage.moved_at!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.deepEqual(Object.fromEntries(Object.entries(stage.lamps).map(([name, lamps]) => [name, lamps.map((one) => one.key)])), {
    reading: ["materials_cited"],
    clarifying: ["tagged_pages_no_open_questions", "decisions_have_goal"],
    modeling: ["roles_in_context_and_use_cases", "concepts_related_in_class", "flows_have_flowchart_with_branch", "stateful_concepts_have_state",
      "no_duplicate_titles", "no_untagged_pages", "rules_no_conflict"],
    writing: ["flows_backed_by_use_cases", "basis_pages_viewed", "basis_diagrams_viewed", "no_pending_items"],
    reviewing: ["reviews_no_open_findings", "completion_met"],
  });
  // 几盏灯照库里的内容：材料被那一页引用了；流程页还没有流程图；用例依据的页用户看过；还没有评审过。
  assert.deepEqual([lampOf(stage, "materials_cited").ok, lampOf(stage, "basis_pages_viewed").ok, lampOf(stage, "no_pending_items").ok], [true, true, true]);
  assert.deepEqual([lampOf(stage, "flows_have_flowchart_with_branch").ok, lampOf(stage, "flows_have_flowchart_with_branch").items, lampOf(stage, "flows_have_flowchart_with_branch").summary],
    [false, ["OA-001"], "有 1 页标签为「流程」的主题还没有带判断分叉的流程图：OA-001（还没有以它为来源的流程图）。"]);
  assert.deepEqual([lampOf(stage, "reviews_no_open_findings").ok, lampOf(stage, "reviews_no_open_findings").summary], [false, "还没有评审过。"]);
  // 这份演示任务定义里没有「功能用例」这个集合：那一盏不适用。
  assert.equal(lampOf(stage, "flows_backed_by_use_cases").ok, null);
  assert.deepEqual(library.stageView(ws), stage, "另开连接再算一遍，结果相同");
});

test("整份数据里与图有关的几盏灯：流程页画了带分叉的流程图就通过；条目依据的图用户看过之前不适用或不通过，看过之后通过", () => {
  const CHART = { said: "把预约取书画成流程图", diagram: { name: "预约取书的流程", kind: "flowchart",
    mermaid: 'flowchart TD\n  a(["OA-001 预约取书"]) --> b{"书在不在架"}\n  b -- 在 --> c["办预约"]\n  b -- 不在 --> d["登记等候"]',
    sources: [{ kind: "用户的话", excerpt: "把预约取书画成流程图" }, { kind: "条目", locator: "OA-001" }] } };
  const BY_CHART = { op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["办预约"] }, sources: [{ kind: "图", locator: "D-001", excerpt: "办预约" }] };
  const lamps = (dir: string, ...keys: string[]) => keys.map((key) => lampOf(library.taskSnapshot(dir)[1]!.stage!, key).ok);
  // 画了图、依据图写了用例，用户还没有看过任何一张图：流程图那一盏通过，依据的图那一盏不适用。
  const drawn = build(tmp, "figure-lamps", DEFINITION, [[FLOW], { view: ["OA-001"] }, CHART, [BY_CHART]]);
  assert.deepEqual(lamps(drawn, "flows_have_flowchart_with_branch", "basis_diagrams_viewed"), [true, null]);
  assert.equal(lampOf(library.taskSnapshot(drawn)[1]!.stage!, "basis_diagrams_viewed").summary, "还没有记下用户看过哪些图，这一项暂时算不出来。");
  // 用户看过这张图：通过。
  const seen = build(tmp, "figure-lamps-seen", DEFINITION, [[FLOW], { view: ["OA-001"] }, CHART, [BY_CHART], { view: ["D-001"] }]);
  assert.deepEqual(lamps(seen, "basis_diagrams_viewed"), [true]);
  // 用户看过之后助手又改了图：要再看一次，不通过，点名那个条目。
  const redrawn = build(tmp, "figure-lamps-redrawn", DEFINITION, [[FLOW], { view: ["OA-001"] }, CHART, [BY_CHART], { view: ["D-001"] },
    { diagram: { diagram: "D-001", base_revision: 1, note: "助手改了说明。" } }]);
  const lamp = lampOf(library.taskSnapshot(redrawn)[1]!.stage!, "basis_diagrams_viewed");
  assert.deepEqual([lamp.ok, lamp.items, lamp.summary], [false, ["UC-001"], "有 1 个条目依据的图用户还没有看过：UC-001（没看过的图是 D-001）。"]);
});

test("库事件：移动阶段转成 stage_changed；有阶段的任务每一批最后一条事件带现在的阶段与灯", () => {
  const ws = build(tmp, "events", DEFINITION, [[FLOW], { stage: "评审确认" }]);
  const [events] = library.libraryEvents(ws, 0);
  const moves = events.filter(([name]) => name === "stage_changed").map(([, data]) => data);
  assert.deepEqual(moves.map((d) => [d.to, d.from, d.actor, d.reason, d.run_id, d.op_id]),
    [["writing", "reading", "user", "", null, "ui-fixture-1"], ["reviewing", "writing", "user", "", null, "ui-fixture-2"]]);
  assert.ok(moves.every((d) => typeof d.seq === "number" && typeof d.at === "string" && typeof d.task_id === "string"));
  // 序号连续：移动阶段的事件没有被跳过。
  assert.deepEqual(events.map(([, d]) => d.seq), events.map((_, n) => events[0][1].seq + n));
  const last = events.at(-1)![1];
  assert.deepEqual(last.stage, library.taskSnapshot(ws)[1]!.stage);
  assert.equal(last.stage.current, "reviewing");
  assert.ok(events.slice(0, -1).every(([, d]) => !("stage" in d)), "只有这一批的最后一条带");
  // 只取后面一段时，最后一条照样带。
  const [tail] = library.libraryEvents(ws, last.seq - 1);
  assert.deepEqual([tail.length, tail[0][0], tail[0][1].stage.current], [1, "stage_changed", "reviewing"]);
});

test("刚建好还没有人移过的任务：有材料在核读材料，三项为 null；库里还没有阶段记录表时也一样", () => {
  const ws = build(tmp, "fresh", DEFINITION, [[FLOW]]);
  // 夹具先移到了写条目；把那条记录去掉，回到没有移过的样子。
  sqlRun(ws, [["DELETE FROM stage_record"]]);
  const fresh = library.taskSnapshot(ws)[1]!.stage!;
  assert.deepEqual([fresh.current, fresh.moved_by, fresh.moved_at, fresh.reason], ["reading", null, null, null]);
  sqlRun(ws, [["DROP TABLE stage_record"]]);
  assert.deepEqual(library.taskSnapshot(ws)[1]!.stage, fresh);
});

test("早先建的任务没有阶段：整份数据里 stage 是 null，库事件不带 stage", () => {
  const ws = makeWorkspace(tmp, "legacy", true);
  const [, task] = library.taskSnapshot(ws);
  assert.equal(task!.stage, null);
  const [events] = library.libraryEvents(ws, 0);
  assert.ok(events.length > 0);
  assert.ok(events.every(([name, d]) => name !== "stage_changed" && !("stage" in d)));
});
