/**
 * 开展一项活动（src/lib/stage_read.ts 的 startActivity、endStandaloneActivity，src/lib/user_ops.ts 的 start_activity）：
 * 在首次分析流程里开始（启动、继续）、单独开展、中途改做、单独开展的前提、助手汇报结束；
 * 以及单独开展时卡片上的进入与退回不算数、状况摘要里的三组选项。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { validateDefinition } from "../src/lib/definition.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { withTaskDatabase } from "../src/lib/schema.ts";
import { BACK_OPTIONS, ENTER_OPTIONS, IDLE, STAY_HERE_OPTION, STAY_OPTIONS } from "../src/lib/stage.ts";
import { activityDoneGate, activityRecords, endStandaloneActivity, flowNode, recordStageCardClick, reportActivityDone, stageLines, stageOf, stageSummary, startActivity } from "../src/lib/stage_read.ts";
import { UserOpError, runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, READY_PAGE, SOURCE, callIn, count, demoDefinition, endActivities, enterStage, makeWorkspace, overallDefinition, query } from "./helpers.ts";

const DEFINITION = validateDefinition(overallDefinition());

function workspace(definition: unknown = overallDefinition(), material = true): { dir: string; taskId: string } {
  const dir = makeWorkspace(definition, { material });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return { dir, taskId: query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id };
}
const inDb = <T>(dir: string, body: (db: Parameters<Parameters<typeof withTaskDatabase>[2]>[0]) => T) => withTaskDatabase(dir, { createIfMissing: false }, body);
let ops = 0;
const userOp = (dir: string, body: Record<string, unknown>) => runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: `ui-op-start-${++ops}`, ...body });
const start = (dir: string, activity: string, inFlow: boolean) => userOp(dir, { kind: "start_activity", fields: { activity, in_flow: inFlow } });
const records = (dir: string, taskId: string) => inDb(dir, (db) => activityRecords(db, taskId)).map((r) => [r.activity, r.node, r.flow, r.from, r.ended_at === null]);
const events = (dir: string, after: number) => query<{ name: string; payload: string }>(dir, "SELECT name, payload FROM event WHERE seq > ? ORDER BY seq", after)
  .map((e) => [e.name, JSON.parse(e.payload)]);
/** 一个空闲的任务：先在流程里走到某个阶段，再把记录记成已结束。 */
function idleAfter(stage: "clarifying" | "writing"): { dir: string; taskId: string } {
  const made = workspace();
  enterStage(made.dir, stage);
  endActivities(made.dir);
  return made;
}

test("单独开展一项活动：记录的节点与流程为空，事件里也是；对话里说「用户单独开展」；任务就在那项活动里，守门照它的", () => {
  const { dir, taskId } = idleAfter("clarifying");
  const before = count(dir, "event");
  const out = start(dir, "澄清", false);
  assert.deepEqual([out.kind, out.note, out.undoable, out.notify_text], ["start_activity", "界面操作（不是用户打的字）：用户单独开展澄清。", false, null]);
  assert.deepEqual(events(dir, before), [["ACTIVITY_STARTED", { activity: "clarifying", node: null, flow: null, from: null, actor: "user", reason: "", run_id: null }]]);
  assert.deepEqual(out.event_seqs, [before + 1]);
  assert.deepEqual(records(dir, taskId).at(-1), ["clarifying", null, null, null, true]);
  assert.equal(inDb(dir, (db) => stageOf(db, dir, taskId, DEFINITION)), "clarifying");
  // 首次分析走到的节点不因单独开展而变。
  assert.equal(inDb(dir, (db) => flowNode(db, taskId)), "clarifying");
  // 摘要：现在在澄清，不在流程里；给助手看的一句写明是单独开展、做够了怎样汇报。
  const summary = inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION))!;
  assert.deepEqual([summary.current, summary.node, summary.flow_node, summary.moved_by], ["clarifying", null, "clarifying", "user"]);
  assert.match(stageLines(summary)[0], /^任务现在在单独开展澄清这项活动，不在首次分析流程里（用户在 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 开始的）。这项活动做够了就在回复里汇报结束（回复里写 activity_done: true），不提议进入别的活动。$/);
  assert.match(stageLines(summary)[1], /^澄清这一段/);
  // 同一项活动、同一种开展方式再点一次：什么都不记，也不追加说明。
  const again = start(dir, "clarifying", false);
  assert.deepEqual([again.note, again.event_seqs, count(dir, "event")], ["", [], before + 1]);
});

test("启动与继续首次分析：没有走过是启动，走过是继续；从单独开展的活动回到流程，原来那条记录结束，起因写用户改做", () => {
  // 空闲、没有走过流程的任务（一条记录都没有时位置还是缺省的，所以先单独开展一次再结束，得到一个没有流程记录的空闲任务）。
  const { dir, taskId } = workspace();
  enterStage(dir, "clarifying");
  inDb(dir, (db) => db.exec("UPDATE activity_record SET node = NULL, flow = NULL"));
  endActivities(dir);
  assert.deepEqual(inDb(dir, (db) => [stageOf(db, dir, taskId, DEFINITION), flowNode(db, taskId)]), [IDLE, null]);
  assert.equal(start(dir, "核读材料", true).note, "界面操作（不是用户打的字）：用户启动首次分析，从核读材料开始。");
  assert.deepEqual(records(dir, taskId).at(-1), ["reading", "reading", "initial", null, true]);
  // 在流程里时用卡片与移动照旧：移到写条目。
  enterStage(dir, "writing");
  // 中途改做单独的澄清：写条目那条记录结束，起因写「用户改做澄清」；对话里注明原来在做什么。
  const before = count(dir, "event");
  assert.equal(start(dir, "澄清", false).note, "界面操作（不是用户打的字）：用户单独开展澄清。（原来在做：写条目）");
  assert.deepEqual(events(dir, before), [
    ["ACTIVITY_ENDED", { activity: "writing", node: "writing", reason: "用户改做澄清", actor: "user" }],
    ["ACTIVITY_STARTED", { activity: "clarifying", node: null, flow: null, from: "writing", actor: "user", reason: "", run_id: null }],
  ]);
  // 流程的位置由最近一条带节点的记录推出：继续首次分析从写条目接着，不丢进度。
  assert.equal(inDb(dir, (db) => flowNode(db, taskId)), "writing");
  const launch = inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION))!.launch;
  assert.deepEqual([launch.current, launch.flows[0]], [{ activity: "clarifying", in_flow: false, label: "继续澄清" },
    { activity: "writing", in_flow: true, label: "继续首次分析（从写条目接着）", enabled: true, state: "可以开展" }]);
  const resumed = count(dir, "event");
  assert.equal(start(dir, "writing", true).note, "界面操作（不是用户打的字）：用户继续首次分析，从写条目接着。（原来在做：澄清）");
  assert.deepEqual(events(dir, resumed).map(([name, payload]) => [name, payload.activity, payload.node, payload.reason]),
    [["ACTIVITY_ENDED", "clarifying", null, "用户改做写条目"], ["ACTIVITY_STARTED", "writing", "writing", ""]]);
  assert.deepEqual(records(dir, taskId).map((r) => [r[0], r[1], r[4]]),
    [["clarifying", null, false], ["reading", "reading", false], ["writing", "writing", false], ["clarifying", null, false], ["writing", "writing", true]]);
  // 任务正在流程里做写条目：不能把它再单独开展一遍（前提够了也不行），什么都不记；状况卡上那一项写「正在流程里进行」。
  saveRevision(callIn(dir), { operations: [READY_PAGE] });
  const records_before = count(dir, "activity_record");
  assert.throws(() => start(dir, "写条目", false), (error: unknown) => error instanceof UserOpError && error.code === "rejected"
    && error.message === "现在还不能单独开展写条目：正在流程里进行。");
  assert.equal(count(dir, "activity_record"), records_before);
  assert.deepEqual(inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION))!.launch.activities.filter((one) => one.activity === "writing").map((one) => [one.enabled, one.state]),
    [[false, "正在流程里进行"]]);
});

test("单独开展的前提：核读材料要有材料，整理建模与写条目要业务说明有页，评审确认与编写文档要有需求条目；缺的拒绝并写明缺什么，在流程里开始不查", () => {
  const { dir, taskId } = workspace(overallDefinition(), false);
  const refused = (activity: string) => {
    try {
      start(dir, activity, false);
    } catch (error) {
      assert.ok(error instanceof UserOpError, String(error));
      return [error.code, error.message];
    }
    return null;
  };
  assert.deepEqual(refused("核读材料"), ["rejected", "现在还不能单独开展核读材料：还没有材料，先上传。"]);
  assert.deepEqual(refused("写条目"), ["rejected", "现在还不能单独开展写条目：业务说明还没有页。"]);
  assert.deepEqual(refused("评审确认"), ["rejected", "现在还不能单独开展评审确认：还没有需求条目。"]);
  assert.deepEqual(refused("编写文档"), ["rejected", "现在还不能单独开展编写文档：还没有需求条目。"]);
  assert.deepEqual(refused("整理建模"), ["rejected", "现在还不能单独开展整理建模：业务说明还没有页。"]);
  assert.equal(count(dir, "activity_record"), 0, "被拒的一次都没有记");
  assert.equal(refused("澄清"), null);
  // 在流程里开始不查前提：没有页也能把任务移到写条目（与 0.5 的直接移动相同）。
  assert.equal(start(dir, "写条目", true).note, "界面操作（不是用户打的字）：用户启动首次分析，从写条目开始。（原来在做：澄清）");
  assert.deepEqual(inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION))!.launch.activities.map((one) => [one.label, one.enabled, one.state]), [
    ["核读材料", false, "还没有材料，先上传"], ["澄清", true, "可以开展"], ["整理建模", false, "业务说明还没有页"],
    ["写条目", false, "正在流程里进行"], ["评审确认", false, "还没有需求条目"], ["编写文档", false, "还没有需求条目"]]);
  // 另一个有材料的任务：在写条目阶段立一页主题、写一条用例之后，前提都够了（已废弃的页、问题条目不算数）；只有流程里正在做的写条目不能单独开展。
  const full = workspace();
  enterStage(full.dir, "writing");
  saveRevision(callIn(full.dir), { operations: [READY_PAGE] });
  assert.deepEqual(inDb(full.dir, (db) => stageSummary(db, full.dir, full.taskId, DEFINITION))!.launch.activities.map((one) => one.state),
    ["可以开展", "可以开展", "可以开展", "正在流程里进行", "还没有需求条目", "还没有需求条目"]);
  userOp(full.dir, { kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 1 }] });
  saveRevision(callIn(full.dir), { operations: [{ op: "add", collection: "用例", fields: { 名称: "借书", 步骤: ["选书"] }, sources: [SOURCE] }] });
  assert.deepEqual(inDb(full.dir, (db) => stageSummary(db, full.dir, full.taskId, DEFINITION))!.launch.activities.map((one) => one.state),
    ["可以开展", "可以开展", "可以开展", "正在流程里进行", "可以开展", "可以开展"]);
  assert.equal(start(full.dir, "评审确认", false).note, "界面操作（不是用户打的字）：用户单独开展评审确认。（原来在做：写条目）");
});

test("拒绝：没有写活动或 in_flow；任务已经完成；早先建的任务没有阶段；助手不能开展活动", () => {
  const { dir, taskId } = idleAfter("clarifying");
  for (const fields of [{}, { activity: "澄清" }, { activity: "发布", in_flow: false }, { activity: "澄清", in_flow: "是" }]) {
    assert.throws(() => userOp(dir, { kind: "start_activity", fields }), (error: unknown) => error instanceof UserOpError && error.code === "bad_request"
      && /^start_activity 要在 fields 里写 activity（「核读材料」「澄清」「整理建模」「写条目」「评审确认」「编写文档」之一）与 in_flow/.test(error.message));
  }
  // 助手一侧没有开展活动的路：核心函数对助手一律不记。
  const byExecutor = inDb(dir, (db) => startActivity(db, dir, { taskId, sessionId: "s", runId: "r1", callId: "call-x", actor: "executor" }, "writing", false, ""));
  assert.deepEqual([byExecutor.moved, byExecutor.why], [false, "user_only"]);
  inDb(dir, (db) => db.exec("UPDATE task SET status = '已完成'"));
  assert.throws(() => start(dir, "澄清", false), (error: unknown) => error instanceof UserOpError && error.code === "task_closed" && error.message === "任务已经已完成，不能再开展活动。");
  const old = workspace(demoDefinition());
  assert.throws(() => start(old.dir, "澄清", false), (error: unknown) => error instanceof UserOpError && error.message === "这个任务没有阶段。");
});

test("助手汇报单独开展的活动结束：那条记录结束，任务空闲；在流程里、空闲时什么都不记", () => {
  const { dir, taskId } = idleAfter("clarifying");
  const who = { taskId, sessionId: "sess-a", callId: "call-reply-9", actor: "executor" as const };
  assert.equal(inDb(dir, (db) => endStandaloneActivity(db, who)), null, "空闲时没有可结束的");
  start(dir, "澄清", false);
  const before = count(dir, "event");
  const ended = inDb(dir, (db) => endStandaloneActivity(db, who))!;
  assert.deepEqual([ended.activity, ended.event_seq], ["clarifying", before + 1]);
  assert.deepEqual(events(dir, before), [["ACTIVITY_ENDED", { activity: "clarifying", node: null, reason: "助手汇报这项活动结束", actor: "executor" }]]);
  assert.equal(inDb(dir, (db) => stageOf(db, dir, taskId, DEFINITION)), IDLE);
  // 在流程里的阶段：不由助手结束。
  start(dir, "澄清", true);
  assert.equal(inDb(dir, (db) => endStandaloneActivity(db, who)), null);
  assert.equal(inDb(dir, (db) => stageOf(db, dir, taskId, DEFINITION)), "clarifying");
});

test("正在单独开展一项活动时，卡片上的进入与退回都不算数：原因是任务不在流程里，什么都不记", () => {
  const card = (option: { key: string; text: string }, other: { key: string; text: string }) => ({
    id: "reply-card", type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id: "call-card", name: "reply", arguments: { informs: [], act: { kind: "choose", text: "这样可以吗？", options: [option, other] } } }] },
  });
  const tried: [{ key: string; text: string }, { key: string; text: string }][] = [
    [ENTER_OPTIONS.modeling, STAY_OPTIONS.clarifying], [ENTER_OPTIONS.writing, STAY_OPTIONS.modeling], [ENTER_OPTIONS.reading, STAY_OPTIONS.reading], [BACK_OPTIONS.reading, STAY_HERE_OPTION]];
  for (const [option, other] of tried) {
    const { dir } = idleAfter("clarifying");
    start(dir, "澄清", false);
    const rows = count(dir, "activity_record");
    const out = recordStageCardClick(dir, "sess-a", [card(option, other)] as never, { opId: `ui-op-${option.key}`, replyEntry: "reply-card", optionKey: option.key });
    assert.deepEqual([out?.from, out?.moved, out?.why], ["clarifying", false, "not_in_flow"], option.key);
    assert.equal(count(dir, "activity_record"), rows, option.key);
  }
});

test("回复里的 activity_done 怎样核对与落库：单独开展时放行并结束那条记录、发起方是助手；在流程里、空闲、没有阶段的任务都拒绝，什么都不记", () => {
  const { dir, taskId } = idleAfter("clarifying");
  // 空闲：拒绝。
  assert.equal(activityDoneGate(dir)![0], "回复里写了 activity_done，而任务现在空闲，没有在进行的活动可以结束");
  assert.equal(reportActivityDone(dir, "sess-a", "call-reply-1"), null);
  // 在流程里：拒绝。
  start(dir, "核读材料", true);
  assert.match(activityDoneGate(dir)![0], /^回复里写了 activity_done，而任务现在在首次分析流程里的核读材料阶段/);
  assert.equal(reportActivityDone(dir, "sess-a", "call-reply-2"), null);
  // 单独开展：放行，结束。
  start(dir, "澄清", false);
  assert.equal(activityDoneGate(dir), null);
  const before = count(dir, "event");
  assert.deepEqual(reportActivityDone(dir, "sess-a", "call-reply-3"), { activity: "clarifying", event_seq: before + 1 });
  assert.deepEqual(query(dir, "SELECT name, actor, session_id, call_id FROM event WHERE seq = ?", before + 1).map((r) => ({ ...r })),
    [{ name: "ACTIVITY_ENDED", actor: "executor", session_id: "sess-a", call_id: "call-reply-3" }]);
  assert.equal(inDb(dir, (db) => stageOf(db, dir, taskId, DEFINITION)), IDLE);
  // 没有阶段的任务、还没有库的目录：拒绝。
  const old = workspace(demoDefinition());
  assert.deepEqual(activityDoneGate(old.dir), ["回复里写了 activity_done，而这个任务没有活动可以结束", "去掉 activity_done 这一项再回复"]);
  assert.deepEqual(activityDoneGate(makeWorkspace(overallDefinition()))?.[0], "回复里写了 activity_done，而这个任务没有活动可以结束");
});
