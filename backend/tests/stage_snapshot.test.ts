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
    modeling: ["flows_have_exception", "roles_mentioned_by_flows", "no_duplicate_titles", "no_untagged_pages"],
    writing: ["flows_backed_by_use_cases", "basis_pages_viewed", "no_pending_items"],
    reviewing: ["reviews_no_open_findings", "completion_met"],
  });
  // 几盏灯照库里的内容：材料被那一页引用了；流程页没有例外的例子；用例依据的页用户看过；还没有评审过。
  assert.deepEqual([lampOf(stage, "materials_cited").ok, lampOf(stage, "basis_pages_viewed").ok, lampOf(stage, "no_pending_items").ok], [true, true, true]);
  assert.deepEqual([lampOf(stage, "flows_have_exception").ok, lampOf(stage, "flows_have_exception").items, lampOf(stage, "flows_have_exception").summary],
    [false, ["OA-001"], "有 1 页标签为「流程」的主题还没有以「例外：」开头的例子：OA-001。"]);
  assert.deepEqual([lampOf(stage, "reviews_no_open_findings").ok, lampOf(stage, "reviews_no_open_findings").summary], [false, "还没有评审过。"]);
  // 这份演示任务定义里没有「功能用例」这个集合：那一盏不适用。
  assert.equal(lampOf(stage, "flows_backed_by_use_cases").ok, null);
  assert.deepEqual(library.stageView(ws), stage, "另开连接再算一遍，结果相同");
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
