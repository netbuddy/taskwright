/**
 * 工作项（src/lib/stage_read.ts 的 startActivity、moveStage、deleteWorkItem、activityDoneOf，src/lib/user_ops.ts 的 start_activity、
 * continue_activity、delete_work_item）：启动一项单项活动或一条流程就是在一条新会话上记一个工作项；流程换站只更新这一行；
 * 一条会话只属于一个工作项，守门看这条会话的工作项；工作项没有终点，可以换一条会话接着做，不要了由用户删除（它的会话归档）；
 * 一个任务同一时刻至多一个流程工作项；单项活动的工作项可以由助手汇报做完，汇报只是一句话。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { validateDefinition } from "../src/lib/definition.ts";
import { prepareReviews } from "../src/lib/review.ts";
import { SaveRejected, saveRevision } from "../src/lib/save_revision.ts";
import { withTaskDatabase } from "../src/lib/schema.ts";
import { IDLE, SCOPE_MAX_LENGTH } from "../src/lib/stage.ts";
import { BACK_OPTIONS, ENTER_OPTIONS, STAY_HERE_OPTION, STAY_OPTIONS } from "./old_cards.ts";
import { whereInWorkspace } from "../src/lib/context_assemble.ts";
import {
  activeCounts, activityDoneGate, activityDoneOf, activityRecords, archivedSessions, recordStageCardClick, sessionWorkItem, stageLines, stageOf, stageSummary, startActivity,
  workItemSessionName, workItemSessions,
} from "../src/lib/stage_read.ts";
import { ToolRejection } from "../src/lib/tool_rejection.ts";
import { NOT_IN_FLOW_TEXT, START_SESSION_RETIRED, UserOpError, runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, READY_PAGE, SOURCE, callIn, count, demoDefinition, makeWorkspace, nodeMoves, overallDefinition, query } from "./helpers.ts";
import { assetNamesOf } from "../src/lib/asset_names.ts";

/** 产品自带的需求工程任务定义里的资产显示名。 */
const NAMES = assetNamesOf(null);

/** 拒绝的两层文字，照「[事实, 指引]」比；原因码另比。 */
const pair = (r: { fact: string; guidance: string } | null | undefined) => (r ? [r.fact, r.guidance] : r);

const DEFINITION = validateDefinition(overallDefinition());

function workspace(definition: unknown = overallDefinition(), material = true): { dir: string; taskId: string } {
  const dir = makeWorkspace(definition, { material });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return { dir, taskId: query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id };
}
const inDb = <T>(dir: string, body: (db: Parameters<Parameters<typeof withTaskDatabase>[2]>[0]) => T) => withTaskDatabase(dir, { createIfMissing: false }, body);
let ops = 0;
/** 在一条会话上做一次界面操作。启动工作项时，这条会话就是后端先建好的那条新会话。 */
const userOp = (dir: string, session: string, body: Record<string, unknown>) => runUserOperation({ workspaceDir: dir, sessionId: session }, { op_id: `ui-op-start-${++ops}`, ...body });
const start = (dir: string, session: string, activity: string, inFlow: boolean, more: Record<string, unknown> = {}) =>
  userOp(dir, session, { kind: "start_activity", fields: { activity, in_flow: inFlow, ...more } });
const refusedOp = (run: () => unknown): [string, string] | null => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof UserOpError, String(error));
    return [error.code, error.message];
  }
  return null;
};
const items = (dir: string, taskId: string) => inDb(dir, (db) => activityRecords(db, taskId)).map((r) => [r.record_id, r.activity, r.node, r.flow]);
const events = (dir: string, after: number) => query<{ name: string; payload: string }>(dir, "SELECT name, payload FROM event WHERE seq > ? ORDER BY seq", after)
  .map((e) => [e.name, JSON.parse(e.payload)]);
const stageIn = (dir: string, taskId: string, session: string | null) => inDb(dir, (db) => stageOf(db, dir, taskId, DEFINITION, session));

test("启动一项单项活动：在这条新会话上记一个工作项，会话挂上去，事件里带记录号；守门只对这条会话变，别的会话照旧空闲", () => {
  const { dir, taskId } = workspace();
  const before = count(dir, "event");
  const out = start(dir, "s-clarify", "澄清", false);
  assert.deepEqual([out.kind, out.note, out.undoable, out.notify_text, out.record_id], ["start_activity", "界面操作（不是用户打的字）：用户启动活动「澄清」。", false, null, 1]);
  assert.deepEqual(events(dir, before), [["ACTIVITY_STARTED", { record_id: 1, activity: "clarifying", node: null, flow: null, from: null, actor: "user", reason: "", run_id: null }]]);
  assert.deepEqual(out.event_seqs, [before + 1]);
  assert.deepEqual(items(dir, taskId), [[1, "clarifying", null, null]]);
  assert.deepEqual(inDb(dir, (db) => workItemSessions(db, taskId)).map((one) => [one.session_id, one.record_id]), [["s-clarify", 1]]);
  // 这条会话在澄清；别的会话、没有给会话编号时都是空闲。
  assert.deepEqual([stageIn(dir, taskId, "s-clarify"), stageIn(dir, taskId, "s-other"), stageIn(dir, taskId, null)], ["clarifying", IDLE, IDLE]);
  // 摘要：这条会话的工作项是单项活动，不在流程里；给助手看的一句写明做够了怎样汇报。
  const summary = inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION, "s-clarify"))!;
  assert.deepEqual([summary.current, summary.node, summary.flow_node, summary.moved_by, summary.work_item?.kind, summary.work_item?.name, summary.work_item?.record_id],
    ["clarifying", null, null, "user", "activity", "澄清", 1]);
  assert.match(stageLines(summary)[0], /^本会话的工作项是单项活动「澄清」，不在工作流程里（用户在 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 启动的）。这项活动做够了就在回复里汇报做完（回复里写 activity_done: true），不提议进入别的活动。$/);
  assert.match(stageLines(summary)[1], /^澄清这一段/);
  // 自由讨论的会话：摘要里没有工作项，给助手看的只有一句。
  const free = inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION, "s-other"))!;
  assert.deepEqual([free.current, free.work_item, free.moved_by, free.moved_at, free.reason], [IDLE, null, null, null, null]);
  assert.deepEqual(stageLines(free), ["本会话是自由讨论，不属于任何工作项：你可以立主题页、改主题页、记问题条目，不写需求条目，也不提议进入哪一项活动。启动哪一项活动由用户从任务起点页决定。"]);
});

test("启动一条流程：一个工作项记着流程与所在的一站；换站只更新这一行、记一条换站的事件，不另开一行；往前与退回各写方向", () => {
  const { dir, taskId } = workspace();
  const before = count(dir, "event");
  const out = start(dir, "s-flow", "核读材料", true);
  assert.equal(out.note, "界面操作（不是用户打的字）：用户启动工作流程「需求分析」，从「核读材料」开始。");
  assert.deepEqual(events(dir, before), [["ACTIVITY_STARTED", { record_id: 1, activity: "reading", node: "reading", flow: "analysis", from: null, actor: "user", reason: "", run_id: null }]]);
  assert.deepEqual(items(dir, taskId), [[1, "reading", "reading", "analysis"]]);
  // 换站：移到写条目，再退回澄清。
  const forward = userOp(dir, "s-flow", { kind: "move_stage", fields: { stage: "写条目", reason: "材料都读过了" } });
  assert.deepEqual([forward.note, forward.record_id], ["界面操作（不是用户打的字）：用户把工作项从核读材料移到写条目。理由：材料都读过了", 1]);
  const back = userOp(dir, "s-flow", { kind: "move_stage", fields: { stage: "澄清" } });
  assert.equal(back.note, "界面操作（不是用户打的字）：用户把工作项从写条目移到澄清。");
  assert.deepEqual(nodeMoves(dir).map((one) => [one.record_id, one.from, one.node, one.direction, one.actor, one.reason]),
    [[1, "reading", "writing", "forward", "user", "材料都读过了"], [1, "writing", "clarifying", "back", "user", ""]]);
  assert.deepEqual(items(dir, taskId), [[1, "clarifying", "clarifying", "analysis"]], "还是那一行，没有另开");
  assert.equal(count(dir, "activity_record"), 1);
  // 已经在那一站：什么都不记，也不追加说明。
  const mark = count(dir, "event");
  const same = userOp(dir, "s-flow", { kind: "move_stage", fields: { stage: "澄清" } });
  assert.deepEqual([same.note, same.event_seqs, count(dir, "event")], ["", [], mark]);
  // 摘要里的谁、什么时候、为什么说的是最近一次换站。
  const summary = inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION, "s-flow"))!;
  assert.deepEqual([summary.current, summary.node, summary.work_item?.kind, summary.work_item?.name, summary.moved_by, summary.reason], ["clarifying", "clarifying", "flow", "需求分析", "user", ""]);
  assert.match(stageLines(summary)[0], /^本会话的工作项是工作流程「需求分析」，现在在澄清阶段（用户在 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 到这一站的）。$/);
  // 自由讨论的会话、单项活动的会话里不能移动阶段。
  assert.deepEqual(refusedOp(() => userOp(dir, "s-free", { kind: "move_stage", fields: { stage: "写条目" } })), ["rejected", NOT_IN_FLOW_TEXT]);
  start(dir, "s-alone", "澄清", false);
  assert.deepEqual(refusedOp(() => userOp(dir, "s-alone", { kind: "move_stage", fields: { stage: "写条目" } })), ["rejected", NOT_IN_FLOW_TEXT]);
});

test("范围说明记进工作项与事件，接在对话那一句后面；早先的 session 一项已经停用；这条会话已经属于一个工作项时不能再启动", () => {
  const { dir, taskId } = workspace();
  const before = count(dir, "event");
  const scoped = start(dir, "s-1", "澄清", false, { scope: "  只问续借的规则  " });
  assert.equal(scoped.note, "界面操作（不是用户打的字）：用户启动活动「澄清」。范围说明：只问续借的规则。");
  assert.deepEqual(events(dir, before), [["ACTIVITY_STARTED", { record_id: 1, activity: "clarifying", node: null, flow: null, from: null, actor: "user", reason: "", run_id: null, scope: "只问续借的规则" }]]);
  assert.deepEqual(query<{ scope: string | null; session_id: string }>(dir, "SELECT scope, session_id FROM activity_record").map((row) => ({ ...row })),
    [{ scope: "只问续借的规则", session_id: "s-1" }]);
  assert.equal(inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION, "s-1"))!.scope, "只问续借的规则");
  // 末尾已经有句号的不再补；只有空白的当作没有写，事件里没有这一项。
  assert.equal(start(dir, "s-2", "写条目", true, { scope: "先写续借那几条。" }).note, "界面操作（不是用户打的字）：用户启动工作流程「需求分析」，从「写条目」开始。范围说明：先写续借那几条。");
  const mark = count(dir, "event");
  start(dir, "s-3", "澄清", false, { scope: "   " });
  assert.equal("scope" in (events(dir, mark).at(-1)![1] as Record<string, unknown>), false);
  assert.equal(inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION, "s-3"))!.scope, null);
  // 会话的名字：单项活动是活动名，流程是流程名（不带所在的一站），写了范围说明的接前 12 个字。
  assert.deepEqual(inDb(dir, (db) => activityRecords(db, taskId)).map((one) => workItemSessionName(one)), ["澄清 · 只问续借的规则", "需求分析 · 先写续借那几条。", "澄清"]);
  assert.equal(workItemSessionName({ activity: "modeling", flow: "analysis", scope: null }), "需求分析");
  assert.equal(workItemSessionName({ activity: "modeling", flow: null, scope: "只重画对象关系图，图书与副本分开建模；流程图与状态图不动。" }), "整理建模 · 只重画对象关系图，图书与");
  // 写法不对的拒绝，什么都不记：范围说明不是文字、太长；session 一项已经停用。
  const rows = count(dir, "activity_record");
  const bad = (fields: Record<string, unknown>) => refusedOp(() => start(dir, `s-bad-${++ops}`, "整理建模", true, fields));
  assert.deepEqual(bad({ scope: 3 }), ["bad_request", "start_activity 的 scope 是范围说明，应当是一段文字；不写范围说明就不要带这一项。"]);
  assert.deepEqual(bad({ scope: "字".repeat(SCOPE_MAX_LENGTH + 1) }), ["bad_request", `范围说明有 ${SCOPE_MAX_LENGTH + 1} 个字，最多 ${SCOPE_MAX_LENGTH} 个字。`]);
  assert.deepEqual(bad({ session: "new" }), ["bad_request", START_SESSION_RETIRED]);
  assert.deepEqual(bad({ session: "current" }), ["bad_request", START_SESSION_RETIRED]);
  // 一条会话只属于一个工作项：在已经属于工作项的会话上再启动被拒。
  assert.deepEqual(refusedOp(() => start(dir, "s-1", "澄清", false)), ["rejected", "这条会话已经属于一个工作项，不能再在它上面启动另一个；启动一律在一条新会话里做。"]);
  assert.equal(count(dir, "activity_record"), rows, "被拒的一次都没有记");
  assert.equal(refusedOp(() => start(dir, "s-max", "澄清", false, { scope: "字".repeat(SCOPE_MAX_LENGTH) })), null);
});

test("一个任务可以同时有几个工作项，同一项单项活动可以并存；流程工作项至多一个，再以流程方式启动被拒并写明现有的那一个；各有各的会话，换站与守门互不影响", () => {
  const { dir, taskId } = workspace();
  start(dir, "s-flow-a", "核读材料", true);
  start(dir, "s-clarify-a", "澄清", false);
  start(dir, "s-clarify-b", "澄清", false, { scope: "第二遍" });
  assert.deepEqual(items(dir, taskId), [[1, "reading", "reading", "analysis"], [2, "clarifying", null, null], [3, "clarifying", null, null]]);
  assert.deepEqual(inDb(dir, (db) => activeCounts(db, taskId)), { analysis: 1, clarifying: 2 });
  // 再以流程方式启动（不论从哪一站）：拒绝，写明现有的那一个；什么都不记。
  const rows = count(dir, "activity_record");
  let refused: unknown = null;
  try {
    start(dir, "s-flow-b", "澄清", true, { scope: "第二遍" });
  } catch (error) {
    refused = error;
  }
  assert.ok(refused instanceof UserOpError);
  assert.deepEqual([refused.code, refused.message, refused.data.existing], ["rejected",
    "任务里已有流程工作项「需求分析」（记录号 1，位于「核读材料」），一个任务同一时刻只能有一个流程工作项；要接着做，请打开它的会话，或者换一条干净的会话接着。",
    { record_id: 1, name: "需求分析", node: "reading" }]);
  assert.deepEqual([count(dir, "activity_record"), inDb(dir, (db) => sessionWorkItem(db, taskId, "s-flow-b"))], [rows, null]);
  // 活动目录里各带个数；单项活动照样可以再启动，流程都不能启动，带着现有的那一个。
  const catalog = inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION, null))!.catalog!;
  assert.deepEqual([catalog.flows[0].active_count, catalog.flows[0].enabled, catalog.flows[0].state, catalog.flows[0].work_item, catalog.activities[1].active_count, catalog.activities[1].enabled],
    [1, false, "已有流程工作项「需求分析」，位于「核读材料」", { record_id: 1, name: "需求分析", node: "reading" }, 2, true]);
  // 一个工作项换站，别的不动；现有的那一个跟着写新的一站。
  userOp(dir, "s-flow-a", { kind: "move_stage", fields: { stage: "写条目" } });
  assert.deepEqual(["s-flow-a", "s-clarify-a", "s-clarify-b", "s-free"].map((one) => stageIn(dir, taskId, one)), ["writing", "clarifying", "clarifying", IDLE]);
  assert.equal(inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION, null))!.catalog!.flows[0].state, "已有流程工作项「需求分析」，位于「写条目」");
  // 删掉其中一个单项活动，个数随之减少；删掉流程的工作项之后，可以重新启动流程（原来所在的一站不保留）。
  userOp(dir, "s-clarify-a", { kind: "delete_work_item", fields: {} });
  userOp(dir, "s-flow-a", { kind: "delete_work_item", fields: {} });
  assert.deepEqual(inDb(dir, (db) => activeCounts(db, taskId)), { clarifying: 1 });
  assert.equal(start(dir, "s-flow-c", "澄清", true).record_id, 4);
  assert.equal(stageIn(dir, taskId, "s-flow-c"), "clarifying");
});

test("守门按会话：助手能写什么、系统提示拼哪一段、能不能请求评审，都看这条会话的工作项；自由讨论的会话与归档的会话按空闲", () => {
  const { dir, taskId } = workspace();
  start(dir, "s-write", "写条目", true);
  start(dir, "s-clarify", "澄清", false, { scope: "只问续借" });
  saveRevision(callIn(dir, "s-write"), { operations: [READY_PAGE] });
  userOp(dir, "s-write", { kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 1 }] });
  const useCase = (name: string) => ({ operations: [{ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["选书"] }, sources: [SOURCE] }] });
  const refusal = (session: string) => {
    try {
      saveRevision(callIn(dir, session), useCase(`借书-${session}`));
    } catch (error) {
      assert.ok(error instanceof SaveRejected, String(error));
      return error.message;
    }
    return null;
  };
  // 一、写条目的工作项的会话：可以写用例。
  assert.equal(refusal("s-write"), null);
  // 二、澄清的工作项的会话：同一个任务、同一时刻，照澄清的规矩拦。
  assert.match(refusal("s-clarify")!, /任务现在在澄清阶段，这个阶段不能新增「用例」的条目/);
  // 三、自由讨论的会话：按空闲拦，原话请用户从任务起点页启动一个工作项。
  assert.match(refusal("s-free")!, /本会话不属于任何工作项，这时不能新增「用例」的条目/);
  assert.match(refusal("s-free")!, /请用户从任务起点页启动一个工作项/);
  // 四、系统提示拼哪一段也按会话：流程的、单项活动的（带范围说明）、自由讨论的。
  assert.deepEqual([whereInWorkspace(dir, "s-write"), whereInWorkspace(dir, "s-clarify"), whereInWorkspace(dir, "s-free"), whereInWorkspace(dir, null)],
    [{ stage: "writing", inFlow: true, flow: "analysis", scope: null, activity: "writing", assetNames: NAMES }, { stage: "clarifying", inFlow: false, flow: null, scope: "只问续借", activity: "clarifying", assetNames: NAMES },
      { stage: IDLE, inFlow: false, flow: null, scope: null }, { stage: IDLE, inFlow: false, flow: null, scope: null }]);
  // 五、助手请求评审：写条目的会话过得了阶段这一关，澄清与自由讨论的会话被拦。
  const reviewGate = (session: string) => {
    try {
      prepareReviews(dir, null, "executor", session);
    } catch (error) {
      return error instanceof ToolRejection ? error.fact : null;
    }
    return null;
  };
  assert.equal(reviewGate("s-write"), null);
  assert.match(reviewGate("s-clarify")!, /^任务现在在澄清阶段/);
  assert.match(reviewGate("s-free")!, /^本会话不属于任何工作项/);
  // 六、工作项删除之后，它的会话归档、按空闲：刚才能写用例的那条会话现在被拦，系统提示是自由讨论的。
  userOp(dir, "s-write", { kind: "delete_work_item", fields: {} });
  assert.equal(stageIn(dir, taskId, "s-write"), IDLE);
  assert.match(refusal("s-write")!, /本会话不属于任何工作项，这时不能新增「用例」的条目/);
  const archived = inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION, "s-write"))!;
  assert.deepEqual([archived.current, archived.work_item, stageLines(archived)], [IDLE, null,
    ["本会话是自由讨论，不属于任何工作项：你可以立主题页、改主题页、记问题条目，不写需求条目，也不提议进入哪一项活动。启动哪一项活动由用户从任务起点页决定。"]]);
  assert.deepEqual(whereInWorkspace(dir, "s-write"), { stage: IDLE, inFlow: false, flow: null, scope: null });
  assert.equal(stageIn(dir, taskId, "s-clarify"), "clarifying", "别的工作项不受影响");
});

test("启动单项活动的前提只看数据：核读材料要有材料，整理建模与写条目要业务说明有内容，评审确认要有需求条目，编写文档要有已确认的需求条目；缺的拒绝并写明缺什么，启动流程不查", () => {
  const { dir, taskId } = workspace(overallDefinition(), false);
  let n = 0;
  const refused = (activity: string) => refusedOp(() => start(dir, `s-try-${++n}`, activity, false));
  assert.deepEqual(refused("核读材料"), ["rejected", "现在还不能启动「核读材料」：还没有项目材料。"]);
  assert.deepEqual(refused("写条目"), ["rejected", "现在还不能启动「写条目」：业务说明还没有内容。"]);
  assert.deepEqual(refused("评审确认"), ["rejected", "现在还不能启动「评审确认」：还没有需求条目。"]);
  assert.deepEqual(refused("编写文档"), ["rejected", "现在还不能启动「编写文档」：还没有已确认的需求条目。"]);
  assert.deepEqual(refused("整理建模"), ["rejected", "现在还不能启动「整理建模」：业务说明还没有内容。"]);
  assert.equal(count(dir, "activity_record"), 0, "被拒的一次都没有记");
  assert.equal(count(dir, "work_item_session"), 0, "被拒的会话也没有挂上");
  assert.equal(refused("澄清"), null);
  // 启动流程不查前提：没有页也能从写条目这一站启动。
  assert.equal(start(dir, "s-flow", "写条目", true).note, "界面操作（不是用户打的字）：用户启动工作流程「需求分析」，从「写条目」开始。");
  const states = () => inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION, null))!.catalog!.activities.map((one) => one.state);
  assert.deepEqual(states(), ["还没有项目材料", "可以启动", "业务说明还没有内容", "业务说明还没有内容", "还没有需求条目", "还没有已确认的需求条目", "还没有评审过", "还没有项目材料"]);
  // 另一个有材料的任务：立一页主题、写一条用例、用户看过这条用例之后，前提都够了（已废弃的页、问题条目不算数）。
  const full = workspace();
  const fullStates = () => inDb(full.dir, (db) => stageSummary(db, full.dir, full.taskId, DEFINITION, null))!.catalog!.activities.slice(0, 6).map((one) => one.state);
  start(full.dir, "s-w", "写条目", true);
  saveRevision(callIn(full.dir, "s-w"), { operations: [READY_PAGE] });
  assert.deepEqual(fullStates(), ["可以启动", "可以启动", "可以启动", "可以启动", "还没有需求条目", "还没有已确认的需求条目"]);
  userOp(full.dir, "s-w", { kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 1 }] });
  saveRevision(callIn(full.dir, "s-w"), { operations: [{ op: "add", collection: "用例", fields: { 名称: "借书", 步骤: ["选书"] }, sources: [SOURCE] }] });
  // 有了一条用例而用户还没有看过：评审确认可以启动，编写文档还差一条已确认的。
  assert.deepEqual(fullStates(), ["可以启动", "可以启动", "可以启动", "可以启动", "可以启动", "还没有已确认的需求条目"]);
  const [added] = query<{ item_id: string; revision_no: number }>(full.dir, "SELECT i.item_id, v.revision_no FROM item i JOIN item_version v ON v.item_id = i.item_id WHERE i.collection = '用例'");
  userOp(full.dir, "s-w", { kind: "mark_viewed", targets: [{ item_id: added.item_id, base_revision: added.revision_no }] });
  assert.deepEqual(fullStates(), ["可以启动", "可以启动", "可以启动", "可以启动", "可以启动", "可以启动"]);
  // 已有写条目的流程工作项，照样可以另启动一个单项的写条目与一个评审确认。
  assert.equal(start(full.dir, "s-w2", "写条目", false).note, "界面操作（不是用户打的字）：用户启动活动「写条目」。");
  assert.equal(start(full.dir, "s-r", "评审确认", false).note, "界面操作（不是用户打的字）：用户启动活动「评审确认」。");
  assert.equal(stageIn(full.dir, full.taskId, "s-w"), "writing", "原来那个工作项原样留着");
});

test("拒绝：没有写活动或 in_flow；任务已经完成；早先建的任务没有阶段；助手不能启动", () => {
  const { dir, taskId } = workspace();
  // 写法不对时列出声明里可以启动的活动（只能由用户发起的发布不在里面）。
  for (const fields of [{}, { activity: "澄清" }, { activity: "澄清", in_flow: "是" }]) {
    assert.throws(() => userOp(dir, "s-x", { kind: "start_activity", fields }), (error: unknown) => error instanceof UserOpError && error.code === "bad_request"
      && /^start_activity 要在 fields 里写 activity（「核读材料」「澄清」「整理建模」「写条目」「评审确认」「编写文档」「逆向解析」之一）与 in_flow/.test(error.message));
  }
  // 发布是声明里的活动，但只能由用户发起：不是写法不对，是这个版本还不能这样启动。
  assert.deepEqual(refusedOp(() => userOp(dir, "s-x", { kind: "start_activity", fields: { activity: "发布", in_flow: false } })), ["rejected", "「发布」此版本尚未提供。"]);
  // 助手一侧没有启动的路：核心函数对助手一律不记。
  const byExecutor = inDb(dir, (db) => startActivity(db, dir, { taskId, sessionId: "s", runId: "r1", callId: "call-x", actor: "executor" }, "clarifying", null, ""));
  assert.deepEqual([byExecutor.moved, byExecutor.why], [false, "user_only"]);
  const old = workspace(demoDefinition());
  assert.deepEqual(refusedOp(() => start(old.dir, "s-z", "澄清", false)), ["rejected", "这个任务没有阶段。"]);
});

test("用户删除一个工作项：删掉活动记录那一行，它的会话全部归档（按自由讨论办），记一条删除的事件；可以写记录号删别的工作项；修订不动", () => {
  const { dir, taskId } = workspace();
  start(dir, "s-a", "澄清", false, { scope: "只问续借" });
  start(dir, "s-b", "核读材料", true);
  userOp(dir, "s-b2", { kind: "continue_activity", fields: { activity_record_id: 2 } });
  saveRevision(callIn(dir, "s-a"), { operations: [READY_PAGE] });
  const revisions = count(dir, "revision");
  const before = count(dir, "event");
  const out = userOp(dir, "s-a", { kind: "delete_work_item", fields: {} });
  assert.deepEqual([out.kind, out.note, out.record_id, out.archived_sessions, out.event_seqs, out.undoable], ["delete_work_item",
    "界面操作（不是用户打的字）：用户删除工作项「澄清」，它的 1 条会话已归档。", 1, 1, [before + 1], false]);
  assert.deepEqual(events(dir, before), [["WORK_ITEM_DELETED",
    { record_id: 1, activity: "clarifying", node: null, flow: null, scope: "只问续借", archived_sessions: 1, actor: "user", reason: "用户删除这个工作项" }]]);
  assert.deepEqual(items(dir, taskId), [[2, "reading", "reading", "analysis"]]);
  assert.deepEqual([stageIn(dir, taskId, "s-a"), stageIn(dir, taskId, "s-b"), stageIn(dir, taskId, "s-b2")], [IDLE, "reading", "reading"]);
  assert.equal(count(dir, "revision"), revisions, "修订不动");
  // 在别的会话里写记录号删流程的工作项：它的两条会话都归档，那句话留在发起的这条会话里。
  const flow = userOp(dir, "s-a", { kind: "delete_work_item", fields: { activity_record_id: 2 } });
  assert.deepEqual([flow.note, flow.archived_sessions], ["界面操作（不是用户打的字）：用户删除工作项「需求分析」，它的 2 条会话已归档。", 2]);
  assert.deepEqual([items(dir, taskId), stageIn(dir, taskId, "s-b"), stageIn(dir, taskId, "s-b2")], [[], IDLE, IDLE]);
  assert.deepEqual(inDb(dir, (db) => [...archivedSessions(db, taskId).keys()].sort()), ["s-a", "s-b", "s-b2"]);
  assert.deepEqual(inDb(dir, (db) => workItemSessions(db, taskId)), []);
  // 拒绝：没有这个记录号（含已经删掉的）；自由讨论的会话没有可删的；记录号写得不对。
  assert.deepEqual(refusedOp(() => userOp(dir, "s-a", { kind: "delete_work_item", fields: { activity_record_id: 1 } })), ["not_found", "没有记录号是 1 的工作项（可能已经删除）。"]);
  assert.deepEqual(refusedOp(() => userOp(dir, "s-free", { kind: "delete_work_item", fields: {} })), ["rejected", "这条会话不属于任何工作项，没有可以删除的。"]);
  assert.deepEqual(refusedOp(() => userOp(dir, "s-a", { kind: "delete_work_item", fields: { activity_record_id: "1" } })),
    ["bad_request", "delete_work_item 的 activity_record_id 是工作项的记录号，一个从 1 起的整数。"]);
});

test("换一条会话接着做：新会话挂到同一个工作项上，位置与范围说明都不变，原来的会话原样留着；删掉的不能接，已经属于工作项的会话不能接", () => {
  const { dir, taskId } = workspace();
  start(dir, "s-1", "核读材料", true, { scope: "只做借阅" });
  userOp(dir, "s-1", { kind: "move_stage", fields: { stage: "写条目" } });
  const before = count(dir, "event");
  const out = userOp(dir, "s-2", { kind: "continue_activity", fields: { activity_record_id: 1 } });
  assert.deepEqual([out.kind, out.note, out.record_id, out.event_seqs], ["continue_activity",
    "界面操作（不是用户打的字）：用户新建这条会话，接着做工作项「需求分析」，现在在「写条目」这一站。范围说明：只做借阅。", 1, []]);
  assert.equal(count(dir, "event"), before, "挂会话不记事件");
  assert.deepEqual(inDb(dir, (db) => workItemSessions(db, taskId)).map((one) => [one.session_id, one.record_id]), [["s-1", 1], ["s-2", 1]]);
  assert.deepEqual([stageIn(dir, taskId, "s-1"), stageIn(dir, taskId, "s-2")], ["writing", "writing"]);
  assert.deepEqual(whereInWorkspace(dir, "s-2"), { stage: "writing", inFlow: true, flow: "analysis", scope: "只做借阅", activity: "writing", assetNames: NAMES });
  // 在新会话里换站，两条会话看到的是同一个位置。
  userOp(dir, "s-2", { kind: "move_stage", fields: { stage: "评审确认" } });
  assert.deepEqual([stageIn(dir, taskId, "s-1"), stageIn(dir, taskId, "s-2")], ["reviewing", "reviewing"]);
  assert.equal(count(dir, "activity_record"), 1);
  // 拒绝：没有写记录号；没有这个工作项；这条会话已经属于一个工作项；工作项已经删掉。
  assert.deepEqual(refusedOp(() => userOp(dir, "s-3", { kind: "continue_activity", fields: {} })), ["bad_request", "continue_activity 要在 fields 里写 activity_record_id：工作项的记录号。"]);
  assert.deepEqual(refusedOp(() => userOp(dir, "s-3", { kind: "continue_activity", fields: { activity_record_id: 7 } })), ["not_found", "没有记录号是 7 的工作项（可能已经删除）。"]);
  assert.deepEqual(refusedOp(() => userOp(dir, "s-2", { kind: "continue_activity", fields: { activity_record_id: 1 } })), ["rejected", "这条会话已经属于一个工作项；接着做一个工作项要在一条新会话里。"]);
  userOp(dir, "s-1", { kind: "delete_work_item", fields: {} });
  assert.deepEqual(refusedOp(() => userOp(dir, "s-3", { kind: "continue_activity", fields: { activity_record_id: 1 } })),
    ["not_found", "没有记录号是 1 的工作项（可能已经删除）。"]);
  assert.equal(inDb(dir, (db) => sessionWorkItem(db, taskId, "s-3")), null);
});

test("助手汇报做完：只是一句话，什么都不记——单项活动的工作项读出是哪一项，工作项照旧留着、会话照旧在做它；流程的工作项、自由讨论的会话读出 null", () => {
  const { dir, taskId } = workspace();
  assert.equal(activityDoneOf(dir, "s-free"), null, "自由讨论的会话没有可汇报的");
  start(dir, "s-alone", "澄清", false);
  start(dir, "s-flow", "澄清", true);
  assert.equal(activityDoneOf(dir, "s-flow"), null, "流程的工作项不由助手汇报做完");
  const before = count(dir, "event");
  assert.deepEqual(activityDoneOf(dir, "s-alone"), { activity: "clarifying", record_id: 1 });
  assert.equal(count(dir, "event"), before, "不记事件");
  assert.deepEqual([stageIn(dir, taskId, "s-alone"), stageIn(dir, taskId, "s-flow"), items(dir, taskId).length], ["clarifying", "clarifying", 2]);
  assert.deepEqual(activityDoneOf(dir, "s-alone"), { activity: "clarifying", record_id: 1 }, "可以再汇报一次");
});

test("这条会话不在做流程的工作项时，卡片上的进入与退回都不算数（早先空闲时能启动需求分析的「开始核读材料」也不算），什么都不记", () => {
  const card = (option: { key: string; text: string }, other: { key: string; text: string }) => ({
    id: "reply-card", type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id: "call-card", name: "reply", arguments: { informs: [], act: { kind: "choose", text: "这样可以吗？", options: [option, other] } } }] },
  });
  const tried: [{ key: string; text: string }, { key: string; text: string }][] = [
    [ENTER_OPTIONS.modeling, STAY_OPTIONS.clarifying], [ENTER_OPTIONS.writing, STAY_OPTIONS.modeling], [ENTER_OPTIONS.reading, STAY_OPTIONS.reading], [BACK_OPTIONS.reading, STAY_HERE_OPTION]];
  const { dir } = workspace();
  start(dir, "s-alone", "澄清", false);
  const marks = [count(dir, "activity_record"), count(dir, "event")];
  for (const [option, other] of tried) {
    for (const [session, from] of [["s-alone", "clarifying"], ["s-free", IDLE]] as const) {
      const out = recordStageCardClick(dir, session, [card(option, other)] as never, { opId: `ui-op-${option.key}-${session}`, replyEntry: "reply-card", optionKey: option.key });
      assert.deepEqual([out?.from, out?.moved, out?.why], [from, false, "not_in_flow"], `${option.key} ${session}`);
    }
  }
  assert.deepEqual([count(dir, "activity_record"), count(dir, "event")], marks);
});

test("回复里的 activity_done 怎样核对：单项活动的工作项放行；流程的工作项、自由讨论的会话、没有阶段的任务都拒绝；放行了也不改任何记录", () => {
  const { dir, taskId } = workspace();
  // 自由讨论的会话：拒绝。
  assert.deepEqual(pair(activityDoneGate(dir, "s-free")), ["回复里写了 activity_done，而本会话不属于任何工作项，没有活动可以汇报做完", "去掉 activity_done 这一项再回复。启动哪一项活动由用户从任务起点页决定"]);
  // 流程的工作项：拒绝。
  start(dir, "s-flow", "核读材料", true);
  assert.match(activityDoneGate(dir, "s-flow")!.fact, /^回复里写了 activity_done，而本会话的工作项是工作流程，现在在核读材料阶段/);
  // 单项活动的工作项：放行，不记任何东西，会话照旧在做它。
  start(dir, "s-alone", "澄清", false);
  const before = count(dir, "event");
  assert.equal(activityDoneGate(dir, "s-alone"), null);
  assert.equal(count(dir, "event"), before);
  assert.deepEqual([stageIn(dir, taskId, "s-alone"), stageIn(dir, taskId, "s-flow")], ["clarifying", "reading"]);
  // 没有阶段的任务、还没有库的目录：拒绝。
  const old = workspace(demoDefinition());
  assert.deepEqual(pair(activityDoneGate(old.dir, "s")), ["回复里写了 activity_done，而这个任务没有活动可以汇报做完", "去掉 activity_done 这一项再回复"]);
  assert.deepEqual(pair(activityDoneGate(makeWorkspace(overallDefinition()), "s"))?.[0], "回复里写了 activity_done，而这个任务没有活动可以汇报做完");
});

test("启动认声明里的活动与工作流：逆向解析可以单独启动，也可以作为改写既有规格说明的第一站启动；不写 flow 按需求分析；不是那条工作流的一站、没有的工作流、只能由用户发起的活动都拒绝；工作流互斥跨工作流照旧", () => {
  // 单项启动逆向解析：没有材料时缺前提，写的是 has_materials 那一句。
  const bare = workspace(overallDefinition(), false);
  assert.deepEqual(refusedOp(() => start(bare.dir, "s-p", "parse_spec", false)), ["rejected", "现在还不能启动「逆向解析」：还没有项目材料。"]);
  const why = inDb(bare.dir, (db) => startActivity(db, bare.dir, { taskId: bare.taskId, sessionId: "s-p2", runId: null, callId: "ui-op-x", actor: "user" }, "parse_spec", null, ""));
  assert.deepEqual([why.moved, why.why, why.blocked], [false, "not_ready", "还没有项目材料"]);

  // 有材料：记录的活动是 parse_spec，所在一站与所属工作流为空；事件里的活动也是 parse_spec；位置算作核读。
  const { dir, taskId } = workspace();
  let before = count(dir, "event");
  const alone = start(dir, "s-alone", "parse_spec", false);
  assert.equal(alone.note, "界面操作（不是用户打的字）：用户启动活动「逆向解析」。");
  assert.deepEqual(events(dir, before), [["ACTIVITY_STARTED", { record_id: 1, activity: "parse_spec", node: null, flow: null, from: null, actor: "user", reason: "", run_id: null }]]);
  assert.deepEqual(items(dir, taskId), [[1, "parse_spec", null, null]]);
  assert.equal(stageIn(dir, taskId, "s-alone"), "reading");
  assert.equal(inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION, "s-alone"))!.work_item?.name, "逆向解析");

  // 在改写既有规格说明里从逆向解析启动：记录的所属工作流是 rewrite、所在一站是 parse_spec；按名字写活动也认。
  before = count(dir, "event");
  const flow = start(dir, "s-rewrite", "逆向解析", true, { flow: "rewrite" });
  assert.equal(flow.note, "界面操作（不是用户打的字）：用户启动工作流程「改写既有规格说明」，从「逆向解析」开始。");
  assert.deepEqual(events(dir, before), [["ACTIVITY_STARTED", { record_id: 2, activity: "parse_spec", node: "parse_spec", flow: "rewrite", from: null, actor: "user", reason: "", run_id: null }]]);
  const summary = inDb(dir, (db) => stageSummary(db, dir, taskId, DEFINITION, "s-rewrite"))!;
  assert.deepEqual([summary.current, summary.node, summary.work_item?.kind, summary.work_item?.name], ["reading", "parse_spec", "flow", "改写既有规格说明"]);

  // 已有改写既有规格说明的工作项：再启动需求分析被拒，写明现有的那一个（互斥不论哪条工作流）；别的两条也一样。
  assert.deepEqual(refusedOp(() => start(dir, "s-analysis", "核读材料", true)), ["rejected",
    "任务里已有流程工作项「改写既有规格说明」（记录号 2，位于「逆向解析」），一个任务同一时刻只能有一个流程工作项；要接着做，请打开它的会话，或者换一条干净的会话接着。"]);
  assert.equal(refusedOp(() => start(dir, "s-change", "核读材料", true, { flow: "change" }))?.[0], "rejected");
  assert.equal(refusedOp(() => start(dir, "s-rewrite-2", "parse_spec", true, { flow: "rewrite" }))?.[0], "rejected");

  // 换一条会话接着做、删除：那句通知里的工作项名与站名取自声明，不写键名。
  const continued = userOp(dir, "s-rewrite-next", { kind: "continue_activity", fields: { activity_record_id: 2 } });
  assert.ok(continued.note.includes("「改写既有规格说明」") && continued.note.includes("「逆向解析」") && !continued.note.includes("rewrite"), continued.note);
  const deleted = userOp(dir, "s-rewrite", { kind: "delete_work_item", fields: { activity_record_id: 2 } });
  assert.ok(deleted.note.includes("「改写既有规格说明」") && !deleted.note.includes("rewrite"), deleted.note);

  // 写法上的拒绝：逆向解析不是需求分析的一站、没有这条工作流、没有这项活动、单项活动写了 flow。
  const other = workspace();
  assert.deepEqual(refusedOp(() => start(other.dir, "s-1", "parse_spec", true, { flow: "analysis" })), ["bad_request", "「逆向解析」不是工作流「需求分析」的一站。"]);
  assert.deepEqual(refusedOp(() => start(other.dir, "s-2", "核读材料", true, { flow: "nothing" })), ["bad_request", "任务类型里没有叫「nothing」的工作流。"]);
  assert.deepEqual(refusedOp(() => start(other.dir, "s-3", "没有这项", false)), ["bad_request", "任务类型里没有叫「没有这项」的活动。"]);
  assert.deepEqual(refusedOp(() => start(other.dir, "s-4", "澄清", false, { flow: "analysis" })), ["bad_request", "单项活动不写 flow。"]);
  // 核心函数给的原因：只能由用户发起的发布、没有的工作流、不是一站。
  const who = { taskId: other.taskId, sessionId: "s-5", runId: null, callId: "ui-op-y", actor: "user" as const };
  assert.deepEqual(inDb(other.dir, (db) => [startActivity(db, other.dir, who, "publish", null, "").why, startActivity(db, other.dir, who, "publish", "analysis", "").why,
    startActivity(db, other.dir, who, "reading", "nothing", "").why, startActivity(db, other.dir, who, "parse_spec", "analysis", "").why]),
  ["not_startable", "not_startable", "unknown_flow", "not_a_step"]);
  assert.equal(count(other.dir, "activity_record"), 0, "拒绝的都没有记");

  // in_flow 为真、不写 flow：与早先一样记成需求分析，事件内容逐字段相同。
  before = count(other.dir, "event");
  start(other.dir, "s-6", "核读材料", true);
  assert.deepEqual(events(other.dir, before), [["ACTIVITY_STARTED", { record_id: 1, activity: "reading", node: "reading", flow: "analysis", from: null, actor: "user", reason: "", run_id: null }]]);
});
