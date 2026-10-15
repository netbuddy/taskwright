/**
 * 整份数据里的 stage（任务现在的工作阶段与每个阶段的几盏灯）与库事件 activity_started、activity_ended：
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

test("整份数据带 stage：现在的阶段、最近一次是谁在什么时候为什么移的、六个阶段的灯", () => {
  // 夹具一建好任务就由用户在会话 s 上启动需求分析、从写条目开始；之后助手立一页流程，用户看过它，助手依据它写一条用例。
  const ws = build(tmp, "stage", DEFINITION, [[FLOW], { view: ["OA-001"] }, [USE_CASE]]);
  const [, task] = library.taskSnapshot(ws, null, "s");
  const stage = task!.stage!;
  assert.deepEqual([stage.current, stage.moved_by, stage.reason], ["writing", "user", ""]);
  assert.match(stage.moved_at!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.deepEqual(Object.fromEntries(Object.entries(stage.lamps).map(([name, lamps]) => [name, lamps.map((one) => one.key)])), {
    reading: ["materials_cited"],
    clarifying: ["tagged_pages_no_open_questions", "decisions_have_goal"],
    modeling: ["roles_in_context_and_use_cases", "concepts_related_in_class", "flows_have_flowchart_with_branch", "stateful_concepts_have_state",
      "no_duplicate_titles", "no_untagged_pages", "rules_no_conflict"],
    writing: ["flows_backed_by_use_cases", "basis_pages_viewed", "basis_diagrams_viewed", "no_pending_items", "no_blocking_questions", "no_pending_marks"],
    reviewing: ["reviews_no_open_findings", "completion_met"],
    document: ["chapters_have_intro", "glossary_complete", "document_no_blocking_questions"],
  });
  // 几盏灯照库里的内容：材料被那一页引用了；流程页还没有流程图；用例依据的页用户看过；还没有评审过。
  assert.deepEqual([lampOf(stage, "materials_cited").ok, lampOf(stage, "basis_pages_viewed").ok, lampOf(stage, "no_pending_items").ok], [true, true, true]);
  assert.deepEqual([lampOf(stage, "flows_have_flowchart_with_branch").ok, lampOf(stage, "flows_have_flowchart_with_branch").items, lampOf(stage, "flows_have_flowchart_with_branch").summary],
    [false, ["OA-001"], "有 1 页标签为「流程」的主题还没有带判断分叉的流程图：OA-001（还没有以它为来源的流程图）。"]);
  assert.deepEqual([lampOf(stage, "reviews_no_open_findings").ok, lampOf(stage, "reviews_no_open_findings").summary], [false, "还没有评审过。"]);
  // 这份演示任务定义里没有「功能用例」这个集合：那一盏不适用。
  assert.equal(lampOf(stage, "flows_backed_by_use_cases").ok, null);
  assert.deepEqual(library.stageView(ws, "s"), stage, "另开连接再算一遍，结果相同");
  // 阶段是按会话算的：别的会话不属于这个工作项，是空闲；不给会话时也是。
  assert.deepEqual([library.stageView(ws, "sess-other")!.current, library.stageView(ws)!.current, library.taskSnapshot(ws)[1]!.stage!.current], ["idle", "idle", "idle"]);
  assert.deepEqual([stage.work_item?.record_id, stage.work_item?.kind, stage.work_item?.name, stage.flow, stage.node], [1, "flow", "需求分析", "analysis", "writing"]);
  assert.deepEqual(Object.keys(stage.work_item!).sort(), ["activity", "flow", "kind", "name", "record_id", "scope", "started_at"], "工作项没有状态与结束的时刻");
});

test("整份数据里与图有关的几盏灯：流程页画了带分叉的流程图就通过；条目依据的图用户看过之前不通过，看过之后通过", () => {
  const CHART = { said: "把预约取书画成流程图", diagram: { name: "预约取书的流程", kind: "flowchart",
    mermaid: 'flowchart TD\n  a(["OA-001 预约取书"]) --> b{"书在不在架"}\n  b -- 在 --> c["办预约"]\n  b -- 不在 --> d["登记等候"]',
    sources: [{ kind: "用户的话", excerpt: "把预约取书画成流程图" }, { kind: "条目", locator: "OA-001" }] } };
  const BY_CHART = { op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["办预约"] }, sources: [{ kind: "图", locator: "D-001", excerpt: "办预约" }] };
  const lamps = (dir: string, ...keys: string[]) => keys.map((key) => lampOf(library.taskSnapshot(dir, null, "s")[1]!.stage!, key).ok);
  // 画了图、依据图写了用例，用户还没有看过任何一张图：流程图那一盏通过，依据的图那一盏不通过。
  const drawn = build(tmp, "figure-lamps", DEFINITION, [[FLOW], { view: ["OA-001"] }, CHART, [BY_CHART]]);
  assert.deepEqual(lamps(drawn, "flows_have_flowchart_with_branch", "basis_diagrams_viewed"), [true, false]);
  assert.equal(lampOf(library.taskSnapshot(drawn, null, "s")[1]!.stage!, "basis_diagrams_viewed").summary, "有 1 个条目依据的图用户还没有看过：UC-001（没看过的图是 D-001）。");
  // 用户看过这张图：通过。
  const seen = build(tmp, "figure-lamps-seen", DEFINITION, [[FLOW], { view: ["OA-001"] }, CHART, [BY_CHART], { view: ["D-001"] }]);
  assert.deepEqual(lamps(seen, "basis_diagrams_viewed"), [true]);
  // 用户看过之后助手又改了图：要再看一次，不通过，点名那个条目。
  const redrawn = build(tmp, "figure-lamps-redrawn", DEFINITION, [[FLOW], { view: ["OA-001"] }, CHART, [BY_CHART], { view: ["D-001"] },
    { diagram: { diagram: "D-001", base_revision: 1, note: "助手改了说明。" } }]);
  const lamp = lampOf(library.taskSnapshot(redrawn, null, "s")[1]!.stage!, "basis_diagrams_viewed");
  assert.deepEqual([lamp.ok, lamp.items, lamp.summary], [false, ["UC-001"], "有 1 个条目依据的图用户还没有看过：UC-001（没看过的图是 D-001）。"]);
});

test("库事件：启动工作项转成 activity_started，流程换站转成 node_entered，删除工作项转成 work_item_deleted，都带工作项的记录号；早先的结束事件不再转发；有阶段的任务每一批最后一条事件带阶段与灯，按会话算", () => {
  const ws = build(tmp, "events", DEFINITION, [[FLOW], { stage: "评审确认" }]);
  const [events] = library.libraryEvents(ws, 0, "s");
  // 启动：夹具在会话 s 上启动需求分析、从写条目开始。从哪里来不再有意义，是 null。
  const started = events.filter(([name]) => name === "activity_started").map(([, data]) => data);
  assert.deepEqual(started.map((d) => [d.record_id, d.to, d.from, d.actor, d.reason, d.run_id, d.op_id, d.flow, d.node]),
    [[1, "writing", null, "user", "", null, "ui-fixture-1", "analysis", "writing"]]);
  // 换站：同一个工作项从写条目到评审确认，往前；不另记结束与开始。
  const entered = events.filter(([name]) => name === "node_entered").map(([, data]) => data);
  assert.deepEqual(entered.map((d) => [d.record_id, d.node, d.from, d.direction, d.actor, d.reason, d.run_id, d.op_id, d.flow]),
    [[1, "reviewing", "writing", "forward", "user", "", null, "ui-fixture-2", "analysis"]]);
  // 这几种库事件不带会话编号：它们说的是工作项（record_id），推给任务的每一个订阅者，不按会话筛。
  assert.ok([...started, ...entered].every((d) => !("session_id" in d)));
  assert.ok([...started, ...entered].every((d) => typeof d.seq === "number" && typeof d.at === "string" && typeof d.task_id === "string"));
  assert.deepEqual(events.filter(([name]) => name === "activity_ended"), [], "接口里已经没有结束的事件");
  // 序号连续：这几种事件没有被跳过。
  assert.deepEqual(events.map(([, d]) => d.seq), events.map((_, n) => events[0][1].seq + n));
  const last = events.at(-1)![1];
  assert.deepEqual(last.stage, library.taskSnapshot(ws, null, "s")[1]!.stage);
  assert.equal(last.stage.current, "reviewing");
  assert.ok(events.slice(0, -1).every(([, d]) => !("stage" in d)), "只有这一批的最后一条带");
  // 只取后面一段时，最后一条照样带。给的是别的会话（或者不给）时，带的是那条会话的：它不属于这个工作项，是空闲。
  const [tail] = library.libraryEvents(ws, last.seq - 1, "s");
  assert.deepEqual([tail.length, tail[0][0], tail[0][1].stage.current], [1, "node_entered", "reviewing"]);
  assert.deepEqual([library.libraryEvents(ws, last.seq - 1, "sess-other")[0][0][1].stage.current, library.libraryEvents(ws, last.seq - 1)[0][0][1].stage.current], ["idle", "idle"]);
  // 早先记下的结束事件（直接改库放一条）不再转发；删除工作项（直接改库放一条删除的事件）转成 work_item_deleted，带记录号与归档的会话条数。
  sqlRun(ws, [
    ["INSERT INTO event (task_id, session_id, call_id, name, actor, payload, at) SELECT task_id, 's', 'ui-op-end', 'ACTIVITY_ENDED', 'user', ?, '2026-10-12T09:00:00' FROM task",
      JSON.stringify({ activity: "reviewing", node: "reviewing", reason: "", actor: "user" })],
    ["INSERT INTO event (task_id, session_id, call_id, name, actor, payload, at) SELECT task_id, 's', 'ui-op-delete', 'WORK_ITEM_DELETED', 'user', ?, '2026-10-12T09:05:00' FROM task",
      JSON.stringify({ record_id: 1, activity: "reviewing", node: "reviewing", flow: "analysis", archived_sessions: 1, actor: "user", reason: "用户删除这个工作项" })],
  ]);
  const [deleted] = library.libraryEvents(ws, last.seq, "s");
  assert.deepEqual(deleted.map(([name, d]) => [name, d.record_id, d.activity, d.node, d.flow, d.archived_sessions, d.actor, d.reason, d.op_id]),
    [["work_item_deleted", 1, "reviewing", "reviewing", "analysis", 1, "user", "用户删除这个工作项", "ui-op-delete"]]);
});

test("库事件：升级上来的库里早先的移动事件（STAGE_MOVED）转成同一种 activity_started，移到的阶段取它的 stage", () => {
  const ws = build(tmp, "events-old", DEFINITION, [[FLOW]]);
  const max = library.libraryEvents(ws, 0)[1];
  sqlRun(ws, [["INSERT INTO event (task_id, session_id, call_id, name, actor, payload, at) SELECT task_id, 'sess-old', 'ui-op-old', 'STAGE_MOVED', 'user', ?, '2026-10-10T09:00:00' FROM task",
    JSON.stringify({ stage: "reviewing", from: "writing", actor: "user", reason: "条目都看过了。", run_id: null })]]);
  const [events] = library.libraryEvents(ws, max);
  // 早先的事件里没有工作项的记录号：record_id 是 null，所属流程补需求分析。
  assert.deepEqual(events.map(([name, d]) => [name, d.record_id, d.to, d.from, d.actor, d.reason, d.run_id, d.flow, d.node, d.op_id]),
    [["activity_started", null, "reviewing", "writing", "user", "条目都看过了。", null, "analysis", "reviewing", "ui-op-old"]]);
});

test("刚建好还没有启动过工作项的任务：会话空闲，三项为 null，没有工作项", () => {
  const ws = build(tmp, "fresh", DEFINITION, [[FLOW]]);
  // 夹具先启动了需求分析；把那个工作项去掉，回到没有启动过的样子。
  sqlRun(ws, [["DELETE FROM activity_record"], ["DELETE FROM work_item_session"]]);
  const fresh = library.taskSnapshot(ws, null, "s")[1]!.stage!;
  assert.deepEqual([fresh.current, fresh.node, fresh.flow_node, fresh.work_item, fresh.flow, fresh.moved_by, fresh.moved_at, fresh.reason], ["idle", null, null, null, null, null, null, null]);
  assert.deepEqual([fresh.launch.current, fresh.launch.flows.map((one) => [one.label, one.activity, one.enabled]), fresh.launch.activities.map((one) => [one.label, one.enabled])],
    [null, [["启动需求分析", "reading", true]], [["核读材料", true], ["澄清", true], ["整理建模", true], ["写条目", true], ["评审确认", false], ["编写文档", false]]]);
});

test("早先建的任务没有阶段：整份数据里 stage 是 null，库事件不带 stage", () => {
  const ws = makeWorkspace(tmp, "legacy", true);
  const [, task] = library.taskSnapshot(ws, null, "s");
  assert.equal(task!.stage, null);
  const [events] = library.libraryEvents(ws, 0);
  assert.ok(events.length > 0);
  assert.ok(events.every(([name, d]) => name !== "activity_started" && name !== "activity_ended" && !("stage" in d)));
});
