/**
 * 任务状况（src/task_status.ts）：现在的阶段与最近一次移动、业务说明的页按章归类的节数、待澄清数、图按种类的张数、
 * 各集合的条目数与用户看过的条数、这一段没有通过的灯、开着的提议；需求资产六类的现状与活动目录。任务库经子进程里助手一侧真实的函数建，这里只读。
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

/** 带业务说明的演示任务定义，再加一个问题集合（状态的取值里有「用户决定保留」，有「种类」字段），照产品的任务类型。 */
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
    { view: ["UC-001"] }, { reply: CARD },
  ]);
  // 夹具在会话 s 上启动了需求分析：当前活动、还差什么、提议三项说的是这条会话。
  const sessions = [{ session_id: "s", name: "需求分析 · 写条目", last_active_at: "2026-10-12T09:00:00+08:00" }];
  const status = taskStatus(ws, "s", sessions)!;
  const stage = library.taskSnapshot(ws, null, "s")[1]!.stage!;
  assert.match(status.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  // 当前活动：这条会话的工作项是需求分析，现在在写条目这一站；是用户启动的。
  assert.deepEqual(status.activity, { kind: "stage", key: "writing", name: "写条目", ordinal: 4, flow: "analysis",
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
  // 需求条目：业务说明与问题之外的集合各一行；用例两条，用户看过一条。
  assert.deepEqual(status.items, [{ collection: "用例", total: 2, viewed: 1 }, { collection: "待定事项", total: 0, viewed: 0 }]);
  // 这一段还差什么：现在这个阶段没有通过的灯，一盏一句，与整份数据里的相同。
  const failing = stage.lamps.writing.filter((lamp) => lamp.ok === false);
  // 第二条用例依据的页用户没有看过：依据的页那一盏不通过，这条用例因此待核实，那一盏也不通过。
  assert.deepEqual(failing.map((lamp) => lamp.key), ["basis_pages_viewed", "no_pending_items"]);
  assert.deepEqual(status.missing, failing.map((lamp) => ({ key: lamp.key, summary: lamp.summary })));
  // 开着的提议与整份数据里的是同一条；已发布的版本现在没有记录。
  assert.deepEqual(status.proposal, stage.proposal);
  assert.deepEqual([status.proposal!.stage, status.proposal!.enter.text, status.proposal!.session_id], ["reviewing", "进入评审确认", "s"]);
  // 工作项：就是夹具启动的那一个，带属于它的会话与最近有动静的那一条；没有状态、没有结束的时刻，也没有最近结束的一列。
  assert.deepEqual(status.work_items.map(({ started_at: _at, ...one }) => one), [{
    record_id: 1, kind: "flow", name: "需求分析", activity: "writing", activity_name: "写条目", node: "writing", ordinal: 4, flow: "analysis", scope: null,
    session_ids: ["s"], session_count: 1, latest_session: sessions[0], last_active_at: "2026-10-12T09:00:00+08:00", session_name: "需求分析 · 写条目" }]);
  assert.match(String(status.work_items[0].started_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal("recent_done" in status, false);
  // 不给会话时按自由讨论的会话算：当前活动是空闲、没有提议；工作项照样列出来，只是不知道哪些会话还在，全部算上，没有名字与动静。
  const bare = taskStatus(ws)!;
  assert.deepEqual([bare.activity.kind, bare.missing, bare.proposal, bare.work_items.length, bare.work_items[0].latest_session], ["idle", [], null, 1, { session_id: "s", name: null, last_active_at: null }]);
  assert.deepEqual(status.versions, []);
  // 需求资产六类的现状：材料一份、已被引用；业务说明的节数与待澄清数同上面 description 的；三张图用户都没有打开过；
  // 两条用例里一条没有看过、一条因依据的页没看过而待核实；没有评审过、没有发布过。
  assert.deepEqual(status.assets.map((one) => [one.key, one.name, one.count, one.unit, one.text, one.note]), [
    ["materials", "材料与证据", 1, "份", "1 份", "均已核读"], ["description", "业务说明", 7, "节", "7 节", "1 处待澄清"], ["models", "分析模型", 3, "张", "3 张", "3 未查看"],
    ["items", "需求条目", 2, "条", "2 条", "1 未读 · 1 待核实"], ["review", "评审与确认", 0, "轮", "未评审", ""], ["versions", "文档与版本", 0, "版", "未发布", ""]]);
  // 每格写由哪些活动产出（取自各项活动的定义里「写」那一栏）；材料来自上传，没有产出它的活动。
  assert.deepEqual(status.assets.map((one) => one.produced_by), [[], ["核读材料", "澄清", "整理建模", "编写文档"], ["整理建模"], ["写条目", "评审确认"], ["评审确认"], ["编写文档", "发布"]]);
  assert.deepEqual(status.assets, stage.assets, "与整份数据里的是同一份");
  // 活动目录：七项活动都只按数据判（三张图还没有看过，所以单项的写条目现在不能启动；这与需求分析正在写条目无关），
  // 需求分析已经有一个工作项：两条流程都不能启动，带着现有的那一个；发布写缺什么。
  assert.deepEqual(status.catalog!.activities.map((one) => [one.key, one.name, one.mode_name, one.enabled, one.state, one.active_count]), [
    ["reading", "核读材料", "批处理", true, "可以启动", 0], ["clarifying", "澄清", "逐项对话", true, "可以启动", 0], ["modeling", "整理建模", "批处理", true, "可以启动", 0],
    ["writing", "写条目", "批处理", false, "有 3 张分析模型还没有查看", 0], ["reviewing", "评审确认", "逐项对话", true, "可以启动", 0], ["document", "编写文档", "批处理", true, "可以启动", 0],
    ["publish", "发布", "仅限用户发起", false, "还没有评审过；还有待确认的内容", 0]]);
  assert.deepEqual(status.catalog!.flows.map((one) => [one.key, one.name, one.enabled, one.state, one.recommended, one.at, one.start, one.active_count]), [
    ["analysis", "需求分析", false, "已有流程工作项「需求分析」，位于「写条目」", true, null, "reading", 1], ["change", "需求变更", false, "还没有已发布的版本", false, null, null, 0]]);
  assert.deepEqual(status.catalog!.flows.map((one) => one.work_item), [{ record_id: 1, name: "需求分析", node: "writing" }, { record_id: 1, name: "需求分析", node: "writing" }]);
  const reading = status.catalog!.activities[0];
  assert.deepEqual([reading.reads, reading.writes, reading.prerequisite_text], [[{ key: "materials", name: "材料与证据" }, { key: "knowledge", name: "知识库" }],
    [{ key: "description", name: "业务说明" }], "前置条件：至少一份项目材料。"]);
  assert.ok(reading.purpose.length > 0 && reading.example.length > 0);
  assert.deepEqual(status.catalog, stage.catalog, "与整份数据里的是同一份");
  // 起点页上的几段文字：定位的话里带任务名，主按钮下面一句，三种常见起点各有标题与做法。
  const name = library.taskSnapshot(ws)[1]!.task_name;
  assert.equal(status.start_page.lead, `本任务用于编制并持续维护「${name}」的需求规格说明。所有工作围绕同一套需求资产进行；每启动一个工作项，资产即得到补充或修正。`);
  assert.equal(status.start_page.guide_note, "预计首轮产出：业务说明初稿与待澄清问题清单");
  assert.deepEqual(status.start_page.cases.map((one) => one.title), ["有调研材料", "只有口头想法", "已有旧版规格说明"]);
  assert.ok(status.start_page.cases.every((one) => one.text.endsWith("。")));
  // 每种起点写明进输入页时先看哪一块；输入页上的几段：一段话、四类文件、目标系统描述的说明与三句示例、启动后两种情形各一句。
  assert.deepEqual(status.start_page.cases.map((one) => one.focus), ["materials", "description", "materials"]);
  const intake = status.start_page.intake;
  assert.match(intake.lead, /^项目材料与目标系统描述至少提供一项。/);
  assert.deepEqual([intake.material_kinds.length, intake.describe_examples.length, intake.after.length], [4, 3, 2]);
  assert.ok(intake.describe_note.startsWith("说明三点：") && intake.describe_placeholder.endsWith("……"));
  assert.deepEqual(intake.after.map((one) => one.slice(0, 4)), ["有材料：", "无材料："]);
});

test("刚建的任务：没有页、没有图、没有提议，各项都是空的；早先建的任务没有阶段，没有状况", () => {
  const fresh = taskStatus(build(tmp, "fresh", WITH_QUESTIONS, []), "s")!;
  assert.deepEqual([fresh.activity.key, fresh.description, fresh.models, fresh.proposal],
    ["writing", { sections: 0, chapters: [], unsorted: 0, open_questions: 0 }, [], null]);
  assert.deepEqual(fresh.items.map((one) => [one.collection, one.total]), [["用例", 0], ["待定事项", 0]]);
  // 资产现状：只有一份还没有被引用的材料，别的各格都是零，零的格下面没有那一句。
  assert.deepEqual(fresh.assets.map((one) => [one.text, one.note]), [["1 份", "1 份未核读"], ["0 节", ""], ["0 张", ""], ["0 条", ""], ["未评审", ""], ["未发布", ""]]);
  assert.equal(taskStatus(build(tmp, "old", DEMO_DEFINITION, [])), null);
  assert.equal(taskStatus(`${tmp}/没有这个目录`), null);
});

test("工作项的清单：全部工作项按最近有动静的倒序，各带属于它的会话与最近有动静的那一条，会话文件不在的与归档的不算；当前活动按会话算；删掉的不再列出；库里状态一列写着早先的「已完成」时照常给活动目录", () => {
  // 夹具一建好任务就在会话 s 上启动需求分析、从写条目开始；有一页主题，没有需求条目。
  const ws = build(tmp, "launch", WITH_QUESTIONS, [[PAGES[0]]]);
  const flowed = taskStatus(ws, "s")!;
  // 早先那一节（留给还读它的页面）说的是这条会话：它正在流程里做写条目。
  assert.deepEqual(flowed.launch!.current, { activity: "writing", in_flow: true, label: "继续需求分析：写条目" });
  assert.deepEqual(flowed.launch, library.taskSnapshot(ws, null, "s")[1]!.stage!.launch, "与整份数据里的是同一份");
  // 活动目录按数据判：有一节业务说明、没有图，整理建模与写条目的前提够了；没有需求条目，评审确认与编写文档不能启动。
  assert.deepEqual(flowed.catalog!.activities.map((one) => [one.key, one.enabled, one.state]), [
    ["reading", true, "可以启动"], ["clarifying", true, "可以启动"], ["modeling", true, "可以启动"], ["writing", true, "可以启动"],
    ["reviewing", false, "还没有需求条目"], ["document", false, "还没有已确认的需求条目"], ["publish", false, "还没有评审过"]]);
  // 用户另在会话 s2 上启动了一个单项的澄清（写了范围说明），又换了一条会话 s3 接着做需求分析（直接改库）。
  sqlRun(ws, [
    ["INSERT INTO activity_record (task_id, session_id, call_id, actor, activity, node, flow, reason, started_at, started_seq, scope) " +
      "SELECT task_id, 's2', 'ui-op-alone', 'user', 'clarifying', NULL, NULL, '', '2026-10-11T10:00:00', 9000, '只问续借' FROM task"],
    ["INSERT INTO work_item_session (session_id, record_id, task_id, attached_at) SELECT 's2', 2, task_id, '2026-10-12T10:00:00' FROM task"],
    ["INSERT INTO work_item_session (session_id, record_id, task_id, attached_at) SELECT 's3', 1, task_id, '2099-01-01T00:00:00' FROM task"],
  ]);
  const sessions = [
    { session_id: "s", name: "需求分析 · 写条目", last_active_at: "2026-10-12T09:00:00+08:00" },
    { session_id: "s3", name: "需求分析 · 写条目", last_active_at: "2026-10-12T12:00:00+08:00" },
    { session_id: "s2", name: "澄清 · 只问续借", last_active_at: null },
  ];
  const alone = taskStatus(ws, "s2", sessions)!;
  // 会话 s2 的当前活动是它的工作项（单项的澄清），不是任务一级的什么；这一段还差什么照澄清的灯。
  assert.deepEqual(alone.activity, { kind: "activity", key: "clarifying", name: "澄清", ordinal: null, flow: null, moved_by: "user", moved_at: alone.activity.moved_at, reason: "" });
  assert.match(String(alone.activity.moved_at), /^2026-10-11T10:00:00/);
  const stage = library.taskSnapshot(ws, null, "s2")[1]!.stage!;
  assert.deepEqual([stage.current, stage.node, stage.flow_node, stage.flow, stage.scope, stage.work_item?.record_id], ["clarifying", null, null, null, "只问续借", 2]);
  assert.deepEqual(alone.missing, stage.lamps.clarifying.filter((lamp) => lamp.ok === false).map((lamp) => ({ key: lamp.key, summary: lamp.summary })));
  // 同一时刻会话 s 与 s3 仍在需求分析的写条目，别的会话空闲。
  assert.deepEqual(["s", "s3", "s-free"].map((one) => taskStatus(ws, one)!.activity.key), ["writing", "writing", "idle"]);
  // 两个工作项，按最近有动静的倒序：需求分析有两条会话，最近有动静的是 s3；澄清的那条会话还没有说过话，取它自己，按启动的时刻（更早）排在后面。
  assert.deepEqual(alone.work_items.map((one) => [one.record_id, one.kind, one.name, one.node, one.ordinal, one.scope, one.session_ids, one.session_count,
    one.latest_session, one.last_active_at, one.session_name]), [
    [1, "flow", "需求分析", "writing", 4, null, ["s", "s3"], 2, sessions[1], "2026-10-12T12:00:00+08:00", "需求分析 · 写条目"],
    [2, "activity", "澄清", null, null, "只问续借", ["s2"], 1, sessions[2], null, "澄清 · 只问续借"]]);
  // 活动目录里澄清与需求分析各带一个工作项：澄清照样可以再启动，流程都不能启动，带着现有的那一个。
  assert.deepEqual([alone.catalog!.activities[1].active_count, alone.catalog!.activities[1].enabled, alone.catalog!.flows[0].active_count, alone.catalog!.flows[0].enabled,
    alone.catalog!.flows[0].work_item, alone.catalog!.flows[1].work_item], [1, true, 1, false, { record_id: 1, name: "需求分析", node: "writing" }, { record_id: 1, name: "需求分析", node: "writing" }]);
  // 会话文件不在的会话（清单里没有 s3：新建之后一句话都没有说就换走了）不计入。
  const without = taskStatus(ws, "s2", sessions.filter((one) => one.session_id !== "s3"))!;
  assert.deepEqual(without.work_items.map((one) => [one.record_id, one.session_ids, one.session_count, one.latest_session?.session_id, one.last_active_at]),
    [[1, ["s"], 1, "s", "2026-10-12T09:00:00+08:00"], [2, ["s2"], 1, "s2", null]]);
  // 启动与换站的流水从事件里读：直接改库放进去的那一个没有事件，只有夹具启动的那一条。
  assert.deepEqual(library.stageDebugView(ws).records.map((one) => [one.to, one.flow, one.kind, one.record_id]), [["writing", "analysis", "launch", 1]]);
  // 澄清的工作项删掉了（直接改库，与删除工作项的直接操作改的是同样两处）：它不再列出，它的会话归档、此后空闲。
  sqlRun(ws, [["UPDATE work_item_session SET archived_at = '2026-10-12T13:00:00' WHERE record_id = 2"], ["DELETE FROM activity_record WHERE record_id = 2"]]);
  const deleted = taskStatus(ws, "s2", sessions)!;
  assert.deepEqual([deleted.activity.kind, deleted.work_items.map((one) => [one.record_id, one.session_ids])], ["idle", [[1, ["s", "s3"]]]]);
  assert.equal(deleted.catalog!.activities[1].active_count, 0);
  assert.deepEqual([...library.archivedSessionInfo(ws)].map(([id, one]) => [id, one.record_id]), [["s2", 2]], "归档的会话保留它曾属于的记录号");
  // 库里状态一列写着早先的「已完成」（0.5.0 完成的任务升级后就是这样）：这一列不再读，活动目录照常给。
  sqlRun(ws, [["UPDATE task SET status = '已完成'"]]);
  const closed = taskStatus(ws, "s")!;
  assert.deepEqual([closed.catalog !== null, closed.assets.length], [true, 6]);
});

test("七章的章号与章名", () => {
  assert.deepEqual(CHAPTER_NAMES.map((one) => `${one.no} ${one.name}`),
    ["1 概述与范围", "2 角色", "3 业务流程", "4 业务对象", "5 业务规则", "6 业务目标", "7 决策记录与待澄清事项"]);
});
