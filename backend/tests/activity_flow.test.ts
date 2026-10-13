/**
 * 开展一项活动的整条链路（真的后端进程与真的 pi，模型换成进程内的假端点）：
 * 新任务空闲——系统提示是空闲的那一份、写条目被拦、助手用卡片提议开始核读材料；用户点了，首次分析从核读材料启动；
 * 用户从任务状况卡单独开展澄清，助手做够了在回复里汇报结束，任务回到空闲；
 * 用户继续首次分析，助手在流程里写 activity_done 被拒；单独开展缺前提时拒绝并写明缺什么。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { IDLE_OPENING, STANDALONE_EXIT } from "../../agent/src/lib/stage_prompt.ts";
import { captureConsole, movesSql, tempDir } from "./helpers.ts";
import { type Dict, MATERIAL, NO_PI, reply, withStack } from "./consent_stack.ts";

captureConsole();
process.env.PI_OFFLINE = "1";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const USE_CASE = { op: "add", collection: "功能用例", sources: [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: MATERIAL }],
  fields: { 用例名称: "借书", 用例功能: "读者借书。", 参与者: ["读者"], 基本流程: ["读者在自助机上刷借书证", "系统记下借阅"] } };
const READ_CARD = { kind: "choose", text: "你上传了一份材料。现在开始核读材料吗？", options: [{ key: "enter_reading", text: "开始核读材料" }, { key: "stay_idle", text: "先不开始" }] };
const done = (text: string, id: string) => ({ tool_calls: [{ id, name: "reply", arguments: { informs: [], act: null, text, activity_done: true } }] });
const SCRIPT = {
  sequence: [
    // 第一句话（任务空闲）：想直接写用例，被拦；照共用说明提议开始核读材料。
    { tool_calls: [{ id: "call-early", name: "save_revision", arguments: { operations: [USE_CASE] } }] },
    reply("材料我看到了。现在开始核读材料吗？", "call-read-card", READ_CARD),
    // 用户点了「开始核读材料」。
    reply("好，我开始读材料。", "call-reading"),
    // 用户单独开展澄清之后说了一句：做够了，汇报结束。
    done("这项活动先做到这里：要问的暂时都问到了。", "call-done"),
    // 用户继续首次分析之后说了一句：在流程里写 activity_done，被拒；去掉之后送达。
    done("核读做完了。", "call-done-in-flow"),
    reply("材料还在读。", "call-plain"),
  ],
};

/** 一个请求里的系统消息的文字。 */
function systemText(request: Dict): string {
  const system = (request["请求体"].messages as Dict[]).find((m) => m.role === "system" || m.role === "developer");
  if (!system) return "";
  return typeof system.content === "string" ? system.content : (system.content as Dict[]).map((p) => p.text ?? "").join("");
}

test("新任务空闲；助手提议开始核读、用户点了启动首次分析；单独开展一项活动由助手汇报结束；流程里不能由助手结束；缺前提的不能单独开展", { skip: NO_PI, timeout: 240000 }, () =>
  withStack(tmp, "activities", SCRIPT, async ({ call, taskId, session, send, action, entryOfCall, requests, db }) => {
    const status = async () => (await call("GET", `/api/v1/tasks/${taskId}/status`)).body.status as Dict;
    const stageNow = async () => (await call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${session}`)).body.task.stage as Dict;
    const messages = async () => (await call("GET", `/api/v1/tasks/${taskId}/conversation?session=${session}`)).body.messages as Dict[];

    // 新任务：空闲，一条活动记录都没有；状况里有「开展一项活动」一节，首次分析从核读材料启动（任务里有材料）。
    const fresh = await status();
    assert.deepEqual([fresh.activity.kind, fresh.activity.key, fresh.activity.name, fresh.activity.ordinal, fresh.missing], ["idle", "idle", "空闲", null, []]);
    assert.deepEqual([fresh.launch.current, fresh.launch.flows.map((one: Dict) => [one.label, one.activity, one.in_flow, one.enabled, one.state])],
      [null, [["启动首次分析", "reading", true, true, "从核读材料开始"]]]);
    assert.deepEqual(fresh.launch.activities.map((one: Dict) => [one.label, one.enabled, one.state]), [
      ["核读材料", true, "可以开展"], ["澄清", true, "可以开展"], ["整理建模", false, "业务说明还没有内容"],
      ["写条目", false, "业务说明还没有内容"], ["评审确认", false, "还没有需求条目"], ["编写文档", false, "还没有已确认的需求条目"]]);
    assert.deepEqual(db("SELECT COUNT(*) AS n FROM activity_record"), [{ n: 0 }]);

    // 不选，直接说话：助手这次运行拿到的是空闲的系统提示；写用例被拦，原话说任务没有在进行的活动；助手提议开始核读材料。
    await send({ text: "材料我放上去了。", client_id: "c-1" });
    const idlePrompt = systemText(requests()[0]);
    assert.ok(idlePrompt.includes(IDLE_OPENING), "空闲时的固定开头");
    assert.ok(!idlePrompt.includes("# 现在这个阶段：") && !/^## 出口$/m.test(idlePrompt), "不说任务在哪个阶段，没有出口");
    assert.deepEqual(db("SELECT tool_name, fact FROM tool_rejection ORDER BY rowid").map((r: Dict) => [r.tool_name, String(r.fact).includes("任务现在没有在进行的活动，这时不能新增「功能用例」的条目")]),
      [["save_revision", true]]);
    const proposed = await stageNow();
    assert.deepEqual([proposed.current, proposed.proposal.kind, proposed.proposal.stage, proposed.proposal.enter, proposed.proposal.stay],
      ["idle", "enter", "reading", { key: "enter_reading", text: "开始核读材料" }, { key: "stay_idle", text: "先不开始" }]);

    // 用户点了「开始核读材料」：首次分析启动，任务在核读材料（流程里）；那句话带着移动，写明是启动；这次运行的系统提示是核读材料的。
    await send({ text: "我选：开始核读材料", client_id: "c-2", origin: "card_choice", card: { reply_message_id: entryOfCall("call-read-card"), kind: "choose", choice: "enter_reading" } });
    const reading = await stageNow();
    assert.deepEqual([reading.current, reading.node, reading.flow_node, reading.flow, reading.moved_by, reading.reason, reading.proposal],
      ["reading", "reading", "reading", "initial", "user", "用户在卡片上选了「开始核读材料」", null]);
    const clicked = (await messages()).find((m) => m.type === "user_message" && m.text === "我选：开始核读材料")!;
    assert.deepEqual(clicked.stage_move, { from: "idle", to: "reading", actor: "user", how: "launch" });
    const readingPrompt = systemText(requests().at(-1)!);
    assert.ok(readingPrompt.includes("# 现在这个阶段：核读材料\n") && /^## 出口$/m.test(readingPrompt) && !readingPrompt.includes(IDLE_OPENING));

    // 缺前提的不能单独开展：还没有需求条目，评审确认被拒；业务说明还没有内容，整理建模被拒。什么都不记。
    const refused = await action({ kind: "start_activity", targets: [], fields: { activity: "reviewing", in_flow: false }, notify_executor: false });
    assert.equal(refused.status >= 400, true);
    assert.equal(refused.body.error.message, "现在还不能单独开展评审确认：还没有需求条目。");
    const noPages = await action({ kind: "start_activity", targets: [], fields: { activity: "modeling", in_flow: false }, notify_executor: false });
    assert.equal(noPages.body.error.message, "现在还不能单独开展整理建模：业务说明还没有内容。");

    // 用户从任务状况卡单独开展澄清：核读材料那条记录结束（起因是用户改做），新记录不在流程里；对话里留一行，不引出助手的运行。
    const before = requests().length;
    assert.equal((await action({ kind: "start_activity", targets: [], fields: { activity: "clarifying", in_flow: false }, notify_executor: false })).status, 200);
    const alone = await status();
    assert.deepEqual([alone.activity.kind, alone.activity.key, alone.activity.name, alone.activity.ordinal, alone.activity.flow, alone.activity.moved_by],
      ["activity", "clarifying", "澄清", null, null, "user"]);
    assert.deepEqual([alone.launch.current, alone.launch.flows[0].label, alone.launch.flows[0].enabled],
      [{ activity: "clarifying", in_flow: false, label: "继续澄清" }, "继续首次分析（从核读材料接着）", true]);
    const note = (await messages()).filter((m) => m.type === "ui_action_noted").at(-1)!;
    assert.deepEqual([note.kind, note.text], ["start_activity", "界面操作（不是用户打的字）：用户单独开展澄清。（原来在做：核读材料）"]);
    assert.equal(requests().length, before, "开展一项活动不引出助手的运行");
    assert.deepEqual(db("SELECT name, json_extract(payload, '$.reason') AS reason FROM event WHERE name LIKE 'ACTIVITY_%' ORDER BY seq").slice(-2),
      [{ name: "ACTIVITY_ENDED", reason: "用户改做澄清" }, { name: "ACTIVITY_STARTED", reason: "" }]);

    // 助手做够了：回复里写 activity_done，送达之后这项活动结束，任务空闲；那条回复带着结束的是哪一项。这次运行的系统提示里出口是固定的那一段。
    await send({ text: "还有什么要问我的？", client_id: "c-3" });
    assert.ok(systemText(requests().at(-1)!).includes(STANDALONE_EXIT));
    const ended = await stageNow();
    assert.deepEqual([ended.current, ended.node, ended.flow_node, ended.moved_by], ["idle", null, "reading", null]);
    const reported = (await messages()).filter((m) => m.type === "assistant_reply").at(-1)!;
    assert.deepEqual([reported.text, reported.activity_done], ["这项活动先做到这里：要问的暂时都问到了。", { activity: "clarifying" }]);
    assert.deepEqual(db("SELECT name, actor, json_extract(payload, '$.reason') AS reason FROM event WHERE name LIKE 'ACTIVITY_%' ORDER BY seq").at(-1),
      { name: "ACTIVITY_ENDED", actor: "executor", reason: "助手汇报这项活动结束" });

    // 用户继续首次分析（从核读材料接着）；助手在流程里写 activity_done：整次回复被拒，任务仍在核读材料；去掉之后送达。
    assert.equal((await action({ kind: "start_activity", targets: [], fields: { activity: "reading", in_flow: true }, notify_executor: false })).status, 200);
    assert.equal((await messages()).filter((m) => m.type === "ui_action_noted").at(-1)!.text, "界面操作（不是用户打的字）：用户继续首次分析，从核读材料接着。");
    await send({ text: "读得怎么样了？", client_id: "c-4" });
    assert.ok(db("SELECT tool_name, fact FROM tool_rejection ORDER BY rowid").some((r: Dict) => r.tool_name === "reply"
      && String(r.fact).includes("回复里写了 activity_done，而任务现在在首次分析流程里的核读材料阶段")));
    const last = (await messages()).filter((m) => m.type === "assistant_reply").at(-1)!;
    assert.deepEqual([last.text, "activity_done" in last, (await stageNow()).current], ["材料还在读。", false, "reading"]);

    // 全程的活动记录：启动首次分析（核读材料）、单独开展澄清、继续首次分析（核读材料）。
    assert.deepEqual(db(movesSql(["from_stage", "stage", "actor"])), [
      { from_stage: null, stage: "reading", actor: "user" }, { from_stage: "reading", stage: "clarifying", actor: "user" }, { from_stage: null, stage: "reading", actor: "user" }]);
    assert.deepEqual(db("SELECT activity, node, flow, ended_at IS NULL AS open FROM activity_record ORDER BY started_seq"), [
      { activity: "reading", node: "reading", flow: "initial", open: 0 }, { activity: "clarifying", node: null, flow: null, open: 0 }, { activity: "reading", node: "reading", flow: "initial", open: 1 }]);
  }, { seed: false, launch: false }));
