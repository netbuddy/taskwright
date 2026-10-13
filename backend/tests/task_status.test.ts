/**
 * 任务状况（src/task_status.ts）：现在的阶段与最近一次移动、总体分析的页按章归类的节数、待澄清数、图按种类的张数、
 * 各集合的条目数与用户看过的条数、这一段没有通过的灯、开着的提议。任务库经子进程里助手一侧真实的函数建，这里只读。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import * as library from "../src/library.ts";
import { CHAPTER_NAMES, taskStatus } from "../src/task_status.ts";
import { DEMO_DEFINITION, sqlRun, tempDir } from "./helpers.ts";
import { DEFINITION, SOURCE, build, page } from "./overall_stack.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 带总体分析的演示任务定义，再加一个问题集合（状态的取值里有「用户决定保留」，有「种类」字段），照产品的任务类型。 */
const WITH_QUESTIONS = { ...DEFINITION, 交付物: { ...DEFINITION.交付物, 条目集合: [...DEFINITION.交付物.条目集合, {
  名称: "问题", 编号前缀: "Q", 字段: [
    { 名: "事项", 类型: "文本", 必填: true }, { 名: "种类", 类型: "枚举", 必填: true, 取值: ["待澄清", "待定"] },
    { 名: "状态", 类型: "枚举", 必填: true, 取值: ["未解决", "已解决", "用户决定保留"] }],
}] } };
const question = (subject: string, kind: string, status: string) => ({ op: "add", collection: "问题", fields: { 事项: subject, 种类: kind, 状态: status }, sources: [SOURCE] });
const PAGES = [
  page({ 标题: "预约取书", 标签: ["流程"], 例子: ["小王周六预约了一本书。"] }),              // OA-001
  page({ 标题: "还书", 标签: ["流程", "场景"] }),                                            // OA-002：两个标签都归业务流程，只算一节
  page({ 标题: "读者", 标签: ["角色"] }),                                                    // OA-003
  page({ 标题: "借书证", 标签: ["概念", "角色"] }),                                          // OA-004：照章的先后归第 2 章角色
  page({ 标题: "预约架", 标签: ["概念"] }),                                                  // OA-005
  page({ 标题: "减少排队", 标签: ["目标"] }),                                                // OA-006
  page({ 标题: "还没想好归哪里的一页" }),                                                    // OA-007：没有贴标签，未归类
  page({ 标题: "旧的借书流程", 标签: ["流程"], 状态: "已废弃" }),                            // OA-008：已废弃，不数
  page({ 标题: "废弃的一页杂记", 状态: "已废弃" }),                                          // OA-009：未归类里已废弃的，也不数
];
const USE_CASE = { op: "add", collection: "用例", fields: { 名称: "预约图书", 步骤: ["选书"] }, sources: [{ kind: "条目", locator: "OA-001", excerpt: "读者对在架的书办预约。" }] };
// 第二条用例依据的是用户还没有看过的一页：写条目这一段因此有一盏灯不通过。
const USE_CASE_2 = { op: "add", collection: "用例", fields: { 名称: "取消预约", 步骤: ["点取消"] }, sources: [{ kind: "条目", locator: "OA-002", excerpt: "读者对在架的书办预约。" }] };
const chart = (name: string, kind: string, mermaid: string) => ({ said: `把${name}画出来`, diagram: { name, kind, mermaid,
  sources: [{ kind: "用户的话", excerpt: `把${name}画出来` }, { kind: "条目", locator: "OA-001" }] } });
const CARD = { kind: "choose", text: "条目写完了，进入评审确认吗？", items: [{ item_id: "UC-001", revision_no: 10 }],
  options: [{ key: "enter_review", text: "进入评审确认" }, { key: "continue_writing", text: "继续本阶段" }] };

test("任务状况：阶段、各章的节数、待澄清、图、条目、还差什么、开着的提议都照任务记录算", () => {
  // 夹具一建好任务就由用户移到写条目。
  const ws = build(tmp, "status", WITH_QUESTIONS, [
    PAGES, { view: ["OA-001"] }, [USE_CASE, USE_CASE_2],
    [question("寒暑假借期怎么算", "待澄清", "未解决"), question("智能推荐做不做", "待定", "未解决")],
    chart("预约取书的流程", "flowchart", 'flowchart TD\n  a(["OA-001 预约取书"]) --> b{"书在不在架"}\n  b -- 在 --> c["办预约"]\n  b -- 不在 --> d["登记等候"]'),
    chart("还书的流程", "flowchart", 'flowchart TD\n  a(["还书"]) --> b{"有没有逾期"}\n  b -- 有 --> c["交罚款"]\n  b -- 没有 --> d["上架"]'),
    chart("读者能做的事", "use_case", 'flowchart LR\n  r(["读者"]) --> u1(["预约图书"])'),
    { view: ["UC-001"] }, { reply: CARD, session: "sess-first" },
  ]);
  const status = taskStatus(ws)!;
  const stage = library.taskSnapshot(ws)[1]!.stage!;
  assert.match(status.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  // 当前活动：现在是写条目这个阶段，所属流程是首次分析；最近一次是用户移过来的。
  assert.deepEqual(status.activity, { kind: "stage", key: "writing", name: "写条目", ordinal: 4, flow: "initial",
    moved_by: "user", moved_at: stage.moved_at, reason: "" });
  // 业务说明：七页在用。角色 2（借书证贴了概念与角色，归靠前的角色）、业务流程 2、业务对象 1、业务目标 1，未归类 1；已废弃的两页不数。
  assert.deepEqual(status.description, {
    sections: 7,
    chapters: [{ no: 2, name: "角色", sections: 2 }, { no: 3, name: "业务流程", sections: 2 }, { no: 4, name: "业务对象", sections: 1 }, { no: 6, name: "业务目标", sections: 1 }],
    unsorted: 1,
    // 两条没有了结的问题里，待澄清的只有一条：种类是「待定」的那条不算。
    open_questions: 1,
  });
  // 模型：流程图两张、用例图一张，种类照第一次出现的先后。
  assert.deepEqual(status.models, [{ kind: "flowchart", name: "流程图", count: 2 }, { kind: "use_case", name: "用例图", count: 1 }]);
  // 需求条目：总体分析与问题之外的集合各一行；用例两条，用户看过一条。
  assert.deepEqual(status.items, [{ collection: "用例", total: 2, viewed: 1 }, { collection: "待定事项", total: 0, viewed: 0 }]);
  // 这一段还差什么：现在这个阶段没有通过的灯，一盏一句，与整份数据里的相同。
  const failing = stage.lamps.writing.filter((lamp) => lamp.ok === false);
  // 第二条用例依据的页用户没有看过：依据的页那一盏不通过，这条用例因此待核实，那一盏也不通过。
  assert.deepEqual(failing.map((lamp) => lamp.key), ["basis_pages_viewed", "no_pending_items"]);
  assert.deepEqual(status.missing, failing.map((lamp) => ({ key: lamp.key, summary: lamp.summary })));
  // 开着的提议与整份数据里的是同一条；已发布的版本现在没有记录。
  assert.deepEqual(status.proposal, stage.proposal);
  assert.deepEqual([status.proposal!.stage, status.proposal!.enter.text, status.proposal!.session_id], ["reviewing", "进入评审确认", "sess-first"]);
  assert.deepEqual(status.versions, []);
});

test("刚建的任务：没有页、没有图、没有提议，各项都是空的；早先建的任务没有阶段，没有状况", () => {
  const fresh = taskStatus(build(tmp, "fresh", WITH_QUESTIONS, []))!;
  assert.deepEqual([fresh.activity.key, fresh.description, fresh.models, fresh.proposal],
    ["writing", { sections: 0, chapters: [], unsorted: 0, open_questions: 0 }, [], null]);
  assert.deepEqual(fresh.items.map((one) => [one.collection, one.total]), [["用例", 0], ["待定事项", 0]]);
  assert.equal(taskStatus(build(tmp, "old", DEMO_DEFINITION, [])), null);
  assert.equal(taskStatus(`${tmp}/没有这个目录`), null);
});

test("开展一项活动一节：正在进行的一行、首次分析能不能点、六项活动各自的前提；任务已经完成时没有这一节", () => {
  // 夹具一建好任务就由用户移到写条目（在流程里）；有一页主题，没有需求条目。
  const ws = build(tmp, "launch", WITH_QUESTIONS, [[PAGES[0]]]);
  const flowed = taskStatus(ws)!;
  assert.deepEqual(flowed.launch!.current, { activity: "writing", in_flow: true, label: "继续首次分析：写条目" });
  assert.deepEqual(flowed.launch!.flows, [{ activity: "writing", in_flow: true, label: "继续首次分析（从写条目接着）", enabled: false, state: "正在进行" }]);
  assert.deepEqual(flowed.launch!.activities.map((one) => [one.label, one.in_flow, one.enabled, one.state]), [
    ["核读材料", false, true, "可以开展"], ["澄清", false, true, "可以开展"], ["整理建模", false, true, "可以开展"],
    ["写条目", false, false, "正在流程里进行"], ["评审确认", false, false, "还没有需求条目"], ["编写文档", false, false, "还没有已确认的需求条目"]]);
  assert.deepEqual(flowed.launch!.later, [{ label: "发布", state: "0.6 后续" }]);
  assert.deepEqual(flowed.launch, library.taskSnapshot(ws)[1]!.stage!.launch, "与整份数据里的是同一份");
  // 用户改做单独的澄清（直接改库：把在进行的那条记录记成不在流程里的澄清，流程的位置另留一条已结束的写条目）。
  sqlRun(ws, [
    ["UPDATE activity_record SET ended_at = started_at, ended_seq = started_seq"],
    ["INSERT INTO activity_record (task_id, session_id, call_id, actor, activity, node, flow, reason, started_at, started_seq) SELECT task_id, 's', 'ui-op-alone', 'user', 'clarifying', NULL, NULL, '', '2026-10-12T10:00:00', 9000 FROM task"],
  ]);
  const alone = taskStatus(ws)!;
  assert.deepEqual(alone.activity, { kind: "activity", key: "clarifying", name: "澄清", ordinal: null, flow: null, moved_by: "user", moved_at: alone.activity.moved_at, reason: "" });
  assert.match(String(alone.activity.moved_at), /^2026-10-12T10:00:00/);
  assert.deepEqual([alone.launch!.current, alone.launch!.flows[0]], [{ activity: "clarifying", in_flow: false, label: "继续澄清" },
    { activity: "writing", in_flow: true, label: "继续首次分析（从写条目接着）", enabled: true, state: "可以开展" }]);
  assert.deepEqual(alone.launch!.activities.map((one) => one.state), ["可以开展", "正在进行", "可以开展", "可以开展", "还没有需求条目", "还没有已确认的需求条目"]);
  // 这一段还差什么照那项活动（澄清）的灯；整份数据里所属流程是 null，节点是 null，流程走到写条目。
  const stage = library.taskSnapshot(ws)[1]!.stage!;
  assert.deepEqual([stage.current, stage.node, stage.flow_node, stage.flow], ["clarifying", null, "writing", null]);
  assert.deepEqual(alone.missing, stage.lamps.clarifying.filter((lamp) => lamp.ok === false).map((lamp) => ({ key: lamp.key, summary: lamp.summary })));
  assert.deepEqual(library.stageDebugView(ws).records.map((one) => [one.to, one.flow]), [["writing", "initial"], ["clarifying", null]]);
  // 任务已经完成：没有这一节。
  sqlRun(ws, [["UPDATE task SET status = '已完成'"]]);
  assert.equal(taskStatus(ws)!.launch, null);
});

test("七章的章号与章名", () => {
  assert.deepEqual(CHAPTER_NAMES.map((one) => `${one.no} ${one.name}`),
    ["1 概述与范围", "2 角色", "3 业务流程", "4 业务对象", "5 业务规则", "6 业务目标", "7 决策记录与待澄清事项"]);
});
