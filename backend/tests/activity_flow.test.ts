/**
 * 工作项的整条链路（真的后端进程与真的 pi，模型换成进程内的假端点）：
 * 新任务里的会话是自由讨论——系统提示是空闲的那一份、写条目被拦、早先「开始核读材料」的卡片点了不算数；
 * 用户启动需求分析：后端新建一个工作项与一条属于它的会话，会话按工作项起名，原来那条会话照旧是自由讨论；
 * 启动单项活动缺前提时拒绝、不建会话；已有流程工作项时再以流程方式启动被拒、不建会话；启动单项的澄清（带范围说明），
 * 助手做够了在回复里汇报做完——只是一句话，工作项照旧留着；流程的工作项里助手写 activity_done 被拒；换一条会话接着做同一个工作项；
 * 用户删除工作项之后，它的会话归档：会话清单缺省不列、带 archived=1 才列，打开后按自由讨论办；没说过话就换走的会话不计入工作项。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { IDLE_OPENING, STANDALONE_EXIT } from "../../agent/src/lib/stage_prompt.ts";
import { captureConsole, movesSql, sendAndWaitTurn, tempDir } from "./helpers.ts";
import { type Dict, MATERIAL, NO_PI, reply, withStack } from "./consent_stack.ts";

captureConsole();
process.env.PI_OFFLINE = "1";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const USE_CASE = { op: "add", collection: "功能用例", sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: MATERIAL }],
  fields: { 用例名称: "借书", 用例功能: "读者借书。", 参与者: ["读者"], 基本流程: ["读者在自助机上刷借书证", "系统记下借阅"] } };
/** 早先任务空闲时助手提议开始核读材料的那张卡片：现在的说明不再教助手发它，这里由假模型照发，核对点了不算数。 */
const READ_CARD = { kind: "choose", text: "你上传了一份材料。现在开始核读材料吗？", options: [{ key: "enter_reading", text: "开始核读材料" }, { key: "stay_idle", text: "先不开始" }] };
const done = (text: string, id: string) => ({ tool_calls: [{ id, name: "reply", arguments: { informs: [], act: null, text, activity_done: true } }] });
const SCRIPT = {
  sequence: [
    // 自由讨论的会话里的第一句话：想直接写用例，被拦；发了一张早先那样的卡片。
    { tool_calls: [{ id: "call-early", name: "save_revision", arguments: { operations: [USE_CASE] } }] },
    reply("材料我看到了。现在开始核读材料吗？", "call-read-card", READ_CARD),
    // 用户在自由讨论的会话里点了「开始核读材料」：不算数。
    reply("要开始核读材料，请从任务起点页启动。", "call-not-started"),
    // 需求分析的工作项的会话里：写 activity_done，被拒；去掉之后送达。
    done("核读做完了。", "call-done-in-flow"),
    reply("材料还在读。", "call-plain"),
    // 单项澄清的工作项的会话里：做够了，汇报做完。
    done("这项活动先做到这里：要问的暂时都问到了。", "call-done"),
    // 换了一条会话接着做需求分析之后说的第一句话。
    reply("好，接着读材料。", "call-continued"),
    // 澄清的工作项删除之后，在它归档的会话里再说一句。
    reply("有什么想讨论的可以直接说。", "call-after-delete"),
  ],
};

/** 一个请求里的系统消息的文字。 */
function systemText(request: Dict): string {
  const system = (request["请求体"].messages as Dict[]).find((m) => m.role === "system" || m.role === "developer");
  if (!system) return "";
  return typeof system.content === "string" ? system.content : (system.content as Dict[]).map((p) => p.text ?? "").join("");
}

test("自由讨论的会话按空闲办；启动需求分析与单项活动各得一个工作项与一条按它起名的会话；流程互斥；助手汇报做完、换一条会话接着做、用户删除工作项与会话归档；缺前提与停用的写法被拒，不建会话", { skip: NO_PI, timeout: 240000 }, () =>
  withStack(tmp, "activities", SCRIPT, async ({ call, taskId, session, port, send, action, entryOfCall, requests, db }) => {
    const status = async (of: string | null = session) => (await call("GET", `/api/v1/tasks/${taskId}/status${of ? `?session=${of}` : ""}`)).body.status as Dict;
    const stageOf = async (of: string) => (await call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${of}`)).body.task.stage as Dict;
    const messagesOf = async (of: string) => (await call("GET", `/api/v1/tasks/${taskId}/conversation?session=${of}`)).body.messages as Dict[];
    const sessions = async () => (await call("GET", `/api/v1/tasks/${taskId}/sessions`)).body.sessions as Dict[];
    const sayIn = (of: string, text: string, clientId: string) => sendAndWaitTurn(port, taskId, of, async () => {
      assert.equal((await call("POST", `/api/v1/tasks/${taskId}/messages?session=${of}`, { text, client_id: clientId })).status, 200);
    });
    const act = (of: string | null, body: Dict) => call("POST", `/api/v1/tasks/${taskId}/actions${of ? `?session=${of}` : ""}`,
      { client_id: `a-${body.kind}-${Math.random()}`, task_id: taskId, targets: [], notify_executor: false, ...body });

    // 新任务：一个工作项都没有，这条会话是自由讨论；活动目录里需求分析可以启动、从核读材料开始（任务里有材料）。
    const fresh = await status();
    assert.deepEqual([fresh.activity.kind, fresh.activity.key, fresh.activity.name, fresh.activity.ordinal, fresh.missing, fresh.work_items, "recent_done" in fresh],
      ["idle", "idle", "空闲", null, [], [], false]);
    assert.deepEqual(fresh.catalog.flows.map((one: Dict) => [one.key, one.enabled, one.state, one.start, one.active_count]),
      [["analysis", true, "可以启动", "reading", 0], ["change", false, "还没有已发布的版本", null, 0]]);
    assert.deepEqual(fresh.catalog.activities.map((one: Dict) => [one.name, one.enabled, one.state]), [
      ["核读材料", true, "可以启动"], ["澄清", true, "可以启动"], ["整理建模", false, "业务说明还没有内容"], ["写条目", false, "业务说明还没有内容"],
      ["评审确认", false, "还没有需求条目"], ["编写文档", false, "还没有已确认的需求条目"], ["发布", false, "还没有评审过"]]);
    assert.deepEqual(db("SELECT COUNT(*) AS n FROM activity_record"), [{ n: 0 }]);

    // 在自由讨论的会话里说话：助手这次运行拿到的是空闲的系统提示；写用例被拦，原话说本会话不属于任何工作项。
    await send({ text: "材料我放上去了。", client_id: "c-1" });
    const idlePrompt = systemText(requests()[0]);
    assert.ok(idlePrompt.includes(IDLE_OPENING), "空闲时的固定开头");
    assert.ok(!idlePrompt.includes("# 现在这个阶段：") && !/^## 出口$/m.test(idlePrompt), "不说在哪个阶段，没有出口");
    assert.deepEqual(db("SELECT tool_name, fact FROM tool_rejection ORDER BY rowid").map((r: Dict) => [r.tool_name, String(r.fact).includes("本会话不属于任何工作项，这时不能新增「功能用例」的条目")]),
      [["save_revision", true]]);
    // 假模型发了一张早先那样的「开始核读材料」卡片：自由讨论的会话里没有提议；点了它不算数，对话里那句话写明没有开始。
    assert.deepEqual([(await stageOf(session)).current, (await stageOf(session)).proposal], ["idle", null]);
    await send({ text: "我选：开始核读材料", client_id: "c-2", origin: "card_choice", card: { reply_message_id: entryOfCall("call-read-card"), kind: "choose", choice: "enter_reading" } });
    const clicked = (await messagesOf(session)).find((m) => m.type === "user_message" && m.text === "我选：开始核读材料")!;
    assert.deepEqual([clicked.stage_unmoved, "stage_move" in clicked], [{ at: "idle", why: "not_in_flow" }, false]);
    assert.deepEqual([(await stageOf(session)).current, db("SELECT COUNT(*) AS n FROM activity_record")], ["idle", [{ n: 0 }]]);

    // 启动单项活动缺前提：拒绝并写明缺什么，一条会话都不多建。早先的 session 一项已经停用、范围说明写法不对：照常转交、由助手一侧拒绝，也不建会话。
    const sessionsBefore = (await sessions()).length;
    const refused = await act(null, { kind: "start_activity", fields: { activity: "reviewing", in_flow: false } });
    assert.deepEqual([refused.status >= 400, refused.body.error.code, refused.body.error.message], [true, "rejected", "现在还不能启动「评审确认」：还没有需求条目。"]);
    assert.equal((await act(null, { kind: "start_activity", fields: { activity: "modeling", in_flow: false } })).body.error.message, "现在还不能启动「整理建模」：业务说明还没有内容。");
    const retired = await act(session, { kind: "start_activity", fields: { activity: "clarifying", in_flow: false, session: "new" } });
    assert.deepEqual([retired.body.error.code, retired.body.error.message], ["bad_request", "start_activity 的 session 已经停用：启动一律新建一个工作项与一条属于它的会话，不用写这一项。"]);
    assert.equal((await act(session, { kind: "start_activity", fields: { activity: "clarifying", in_flow: false, scope: 7 } })).body.error.code, "bad_request");
    assert.deepEqual([(await sessions()).length, db("SELECT COUNT(*) AS n FROM activity_record")], [sessionsBefore, [{ n: 0 }]]);

    // 用户启动需求分析、从核读材料开始：后端新建一个工作项与一条属于它的会话，回应里带两样的编号；不引出助手的运行。
    const before = requests().length;
    const launched = await act(null, { kind: "start_activity", fields: { activity: "reading", in_flow: true } });
    const flowSession = launched.body.session_id as string;
    assert.ok(launched.status === 200 && typeof flowSession === "string" && flowSession !== "" && flowSession !== session, JSON.stringify(launched.body));
    assert.equal(launched.body.activity_record_id, 1);
    assert.equal(requests().length, before, "启动不引出助手的运行");
    const rowOf = async (id: string) => (await sessions()).find((one) => one.session_id === id)!;
    // 那条新会话在建立时就按工作项起了名；任务状况里它的当前活动是需求分析的核读材料。
    assert.deepEqual([(await rowOf(flowSession)).name, (await rowOf(flowSession)).work_item],
      ["需求分析", { record_id: 1, kind: "flow", name: "需求分析", activity: "reading", flow: "analysis" }]);
    const inFlow = await status(flowSession);
    assert.deepEqual([inFlow.activity.kind, inFlow.activity.key, inFlow.activity.ordinal, inFlow.activity.flow, inFlow.activity.moved_by], ["stage", "reading", 1, "analysis", "user"]);

    // 在需求分析的会话里说话：系统提示是核读材料的；助手写 activity_done，整次回复被拒，工作项仍在核读材料；去掉之后送达。
    await sayIn(flowSession, "读得怎么样了？", "c-3");
    const readingPrompt = systemText(requests().at(-1)!);
    assert.ok(readingPrompt.includes("# 现在这个阶段：核读材料\n") && /^## 出口$/m.test(readingPrompt) && !readingPrompt.includes(IDLE_OPENING));
    assert.ok(db("SELECT tool_name, fact FROM tool_rejection ORDER BY rowid").some((r: Dict) => r.tool_name === "reply"
      && String(r.fact).includes("回复里写了 activity_done，而本会话的工作项是工作流程，现在在核读材料阶段")));
    const inFlowMessages = await messagesOf(flowSession);
    assert.deepEqual(inFlowMessages.filter((m) => m.type === "ui_action_noted").map((m) => [m.kind, m.text]),
      [["start_activity", "界面操作（不是用户打的字）：用户启动工作流程「需求分析」，从「核读材料」开始。"]]);
    const last = inFlowMessages.filter((m) => m.type === "assistant_reply").at(-1)!;
    assert.deepEqual([last.text, "activity_done" in last], ["材料还在读。", false]);
    const reading = await stageOf(flowSession);
    assert.deepEqual([reading.current, reading.node, reading.flow, reading.moved_by, reading.reason, reading.work_item.record_id, reading.work_item.kind, reading.work_item.name, "status" in reading.work_item],
      ["reading", "reading", "analysis", "user", "", 1, "flow", "需求分析", false]);
    // 说过话、会话文件写出来之后，名字仍是按工作项起的那一个，没有被第一句话顶掉。
    assert.equal((await rowOf(flowSession)).name, "需求分析");
    // 原来那条会话照旧是自由讨论，不属于任何工作项。
    assert.deepEqual([(await stageOf(session)).current, (await rowOf(session)).work_item], ["idle", null]);

    // 已有需求分析的工作项：再以流程方式启动（从哪一站都一样）被拒，写明现有的那一个，一条会话都不多建。
    const flowCount = (await sessions()).length;
    const second = await act(null, { kind: "start_activity", fields: { activity: "clarifying", in_flow: true } });
    assert.deepEqual([second.body.error.code, second.body.error.message, second.body.error.data.existing], ["rejected",
      "任务里已有流程工作项「需求分析」（记录号 1，位于「核读材料」），一个任务同一时刻只能有一个流程工作项；要接着做，请打开它的会话，或者换一条干净的会话接着。",
      { record_id: 1, name: "需求分析", node: "reading" }]);
    assert.deepEqual([(await sessions()).length, db("SELECT COUNT(*) AS n FROM activity_record")], [flowCount, [{ n: 1 }]]);

    // 用户另启动一个单项的澄清，写了范围说明：又一个工作项、又一条会话，名字带范围说明的前几个字；需求分析那个工作项原样留着。
    const mark = requests().length;
    const alone = await act(null, { kind: "start_activity", fields: { activity: "clarifying", in_flow: false, scope: "只问续借的规则" } });
    const aloneSession = alone.body.session_id as string;
    assert.deepEqual([alone.status, alone.body.activity_record_id, aloneSession !== flowSession && aloneSession !== session], [200, 2, true]);
    assert.equal(requests().length, mark, "启动不引出助手的运行");
    assert.deepEqual(db("SELECT record_id, activity, flow, scope, session_id FROM activity_record ORDER BY record_id"), [
      { record_id: 1, activity: "reading", flow: "analysis", scope: null, session_id: flowSession },
      { record_id: 2, activity: "clarifying", flow: null, scope: "只问续借的规则", session_id: aloneSession }]);
    assert.equal((await rowOf(aloneSession)).name, "澄清 · 只问续借的规则");
    const inAlone = await status(aloneSession);
    assert.deepEqual([inAlone.activity.kind, inAlone.activity.key, inAlone.activity.name, inAlone.activity.ordinal, inAlone.activity.flow, inAlone.activity.moved_by],
      ["activity", "clarifying", "澄清", null, null, "user"]);
    // 任务状况里列着两个工作项，各带属于它的会话（按最近有动静的倒序：澄清的会话还没有说过话，按启动的时刻排在前面）；
    // 活动目录里各带个数；单项活动照样可以再启动，流程都不能启动、带着现有的那一个。
    assert.deepEqual(inAlone.work_items.map((one: Dict) => [one.record_id, one.kind, one.name, one.node, one.scope]).sort(), [
      [1, "flow", "需求分析", "reading", null], [2, "activity", "澄清", null, "只问续借的规则"]]);
    assert.deepEqual(inAlone.work_items.find((one: Dict) => one.record_id === 1).session_ids, [flowSession]);
    assert.deepEqual([inAlone.catalog.flows[0].active_count, inAlone.catalog.flows[0].enabled, inAlone.catalog.flows[0].work_item, inAlone.catalog.activities[1].active_count, inAlone.catalog.activities[1].enabled],
      [1, false, { record_id: 1, name: "需求分析", node: "reading" }, 1, true]);

    // 在澄清的会话里说话：系统提示里出口是单项活动的那一段，后面接范围说明。助手做够了，回复里写 activity_done：回复下面一行，工作项照旧留着。
    await sayIn(aloneSession, "还有什么要问我的？", "c-4");
    const scopedPrompt = systemText(requests().at(-1)!);
    assert.ok(scopedPrompt.includes(STANDALONE_EXIT) && scopedPrompt.includes("## 本次范围说明\n") && scopedPrompt.includes("本次范围说明：只问续借的规则"));
    assert.ok(scopedPrompt.indexOf(STANDALONE_EXIT) < scopedPrompt.indexOf("## 本次范围说明"));
    const reportedStage = await stageOf(aloneSession);
    assert.deepEqual([reportedStage.current, reportedStage.node, reportedStage.moved_by, reportedStage.work_item.record_id], ["clarifying", null, "user", 2]);
    const inAloneMessages = await messagesOf(aloneSession);
    assert.deepEqual(inAloneMessages.filter((m) => m.type === "ui_action_noted").map((m) => m.text), ["界面操作（不是用户打的字）：用户启动活动「澄清」。范围说明：只问续借的规则。"]);
    const reported = inAloneMessages.filter((m) => m.type === "assistant_reply").at(-1)!;
    assert.deepEqual([reported.text, reported.activity_done], ["这项活动先做到这里：要问的暂时都问到了。", { activity: "clarifying" }]);
    assert.deepEqual(db("SELECT COUNT(*) AS n FROM event WHERE name IN ('ACTIVITY_ENDED', 'WORK_ITEM_DELETED')"), [{ n: 0 }], "汇报做完不记事件");
    // 需求分析那个工作项不受影响。
    assert.equal((await stageOf(flowSession)).current, "reading");

    // 换一条干净的会话接着做需求分析：新会话挂在同一个工作项上，位置不变，名字照工作项起；原来那条会话原样留着。
    const made = (await call("POST", `/api/v1/tasks/${taskId}/sessions`, { activity_record_id: 1 })).body as Dict;
    const nextSession = made.session_id as string;
    assert.deepEqual([made.activity_record_id, [flowSession, aloneSession, session].includes(nextSession)], [1, false]);
    assert.deepEqual([(await rowOf(nextSession)).name, (await rowOf(nextSession)).work_item.record_id, (await status(nextSession)).activity.key], ["需求分析", 1, "reading"]);
    await sayIn(nextSession, "接着读。", "c-5");
    assert.ok(systemText(requests().at(-1)!).includes("# 现在这个阶段：核读材料\n"));
    const inNext = await messagesOf(nextSession);
    assert.deepEqual(inNext.filter((m) => m.type === "ui_action_noted").map((m) => [m.kind, m.text]),
      [["continue_activity", "界面操作（不是用户打的字）：用户新建这条会话，接着做工作项「需求分析」，现在在「核读材料」这一站。"]]);
    assert.equal(inNext.filter((m) => m.type === "assistant_reply").at(-1)!.text, "好，接着读材料。");
    assert.deepEqual([(await stageOf(nextSession)).current, (await stageOf(flowSession)).current], ["reading", "reading"]);
    // 没有的记录号、写法不对的记录号不能接着做；都不建会话。
    const count = (await sessions()).length;
    assert.equal((await call("POST", `/api/v1/tasks/${taskId}/sessions`, { activity_record_id: 9 })).body.error.code, "not_found");
    assert.equal((await call("POST", `/api/v1/tasks/${taskId}/sessions`, { activity_record_id: "一" })).body.error.code, "bad_request");
    assert.equal((await sessions()).length, count);

    // 用户从任务起点页删除澄清这个工作项（请求里不带会话）：说明留在它最近的那条会话里，那条会话随即归档；
    // 会话清单缺省不列它，带 archived=1 时列出并标明；打开它说话按自由讨论办。
    const removed = await act(null, { kind: "delete_work_item", fields: { activity_record_id: 2 } });
    assert.deepEqual([removed.status, removed.body.activity_record_id, removed.body.archived_sessions], [200, 2, 1]);
    assert.deepEqual(db("SELECT record_id FROM activity_record ORDER BY record_id"), [{ record_id: 1 }]);
    assert.deepEqual(db("SELECT name, json_extract(payload, '$.record_id') AS record_id, json_extract(payload, '$.archived_sessions') AS archived FROM event WHERE name = 'WORK_ITEM_DELETED'"),
      [{ name: "WORK_ITEM_DELETED", record_id: 2, archived: 1 }]);
    assert.equal((await sessions()).some((one) => one.session_id === aloneSession), false, "缺省不列归档的会话");
    const withArchived = (await call("GET", `/api/v1/tasks/${taskId}/sessions?archived=1`)).body.sessions as Dict[];
    const archivedRow = withArchived.find((one) => one.session_id === aloneSession)!;
    assert.deepEqual([archivedRow.archived, typeof archivedRow.archived_at, archivedRow.archived_record_id, archivedRow.work_item], [true, "string", 2, null]);
    assert.deepEqual(withArchived.filter((one) => one.session_id !== aloneSession).map((one) => one.archived), withArchived.filter((one) => one.session_id !== aloneSession).map(() => false));
    assert.equal((await messagesOf(aloneSession)).filter((m) => m.type === "ui_action_noted").at(-1)!.text, "界面操作（不是用户打的字）：用户删除工作项「澄清」，它的 1 条会话已归档。");
    assert.equal((await call("POST", `/api/v1/tasks/${taskId}/sessions`, { activity_record_id: 2 })).body.error.code, "not_found", "删掉的工作项不能接着做");

    // 给需求分析新建一条会话而一句话都不说就换走：助手运行时不保留这种会话，任务状况里这个工作项不计入它。
    const empty = (await call("POST", `/api/v1/tasks/${taskId}/sessions`, { activity_record_id: 1 })).body.session_id as string;
    await sayIn(aloneSession, "还能接着问吗？", "c-6");
    assert.ok(systemText(requests().at(-1)!).includes(IDLE_OPENING) && !systemText(requests().at(-1)!).includes("# 现在这个阶段："), "归档的会话按自由讨论办");
    assert.equal((await sessions()).some((one) => one.session_id === empty), false, "会话文件没有写出来");
    const after = await status(aloneSession);
    assert.deepEqual([after.activity.kind, after.work_items.map((one: Dict) => [one.record_id, one.session_ids, one.session_count, one.latest_session.session_id])],
      ["idle", [[1, [flowSession, nextSession], 2, nextSession]]]);

    // 全程：两次启动，没有换站；剩下需求分析一行；会话子表里澄清的那条会话归档、记录号照旧留着（是那个已经删除的工作项的），那条空会话的挂接留着但不计入。
    assert.deepEqual(db(movesSql(["from_stage", "stage", "actor"])), [{ from_stage: null, stage: "reading", actor: "user" }, { from_stage: null, stage: "clarifying", actor: "user" }]);
    assert.deepEqual(db("SELECT record_id, activity, node, flow FROM activity_record ORDER BY record_id"), [{ record_id: 1, activity: "reading", node: "reading", flow: "analysis" }]);
    assert.deepEqual(db("SELECT session_id, record_id, archived_at IS NOT NULL AS archived FROM work_item_session ORDER BY rowid").map((r: Dict) => [r.session_id, r.record_id, r.archived]),
      [[flowSession, 1, 0], [aloneSession, 2, 1], [nextSession, 1, 0], [empty, 1, 0]]);
  }, { seed: false, launch: false }));
