/**
 * 空闲：任务有过活动记录而每一条都已经结束，没有在进行的活动（lib/stage.ts 的 IDLE）。
 * 现在没有哪条路会把任务置为空闲，这里用夹具直接把记录记成已结束，看各处怎样读、怎样拦：
 * 读出来是 idle 而不是 null；助手能写的与澄清相同；被拦时的原话；从空闲移到一个阶段只记开始；卡片上的点击按澄清判。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { completeTask } from "../src/lib/complete_task.ts";
import { createTask } from "../src/lib/create_task.ts";
import { validateDefinition } from "../src/lib/definition.ts";
import { prepareReviews } from "../src/lib/review.ts";
import { type SaveDiagramParams, saveDiagram } from "../src/lib/save_diagram.ts";
import { SaveRejected, saveRevision } from "../src/lib/save_revision.ts";
import { withTaskDatabase } from "../src/lib/schema.ts";
import { BACK_OPTIONS, ENTER_OPTIONS, IDLE, STAGES, STAY_HERE_OPTION, STAY_OPTIONS } from "../src/lib/stage.ts";
import { IDLE_LINE, activityRecords, currentStage, openActivityRecord, recordStageCardClick, stageLines, stageOf, stageSummary } from "../src/lib/stage_read.ts";
import { getTaskStatus } from "../src/lib/task_query.ts";
import { rejectionOf } from "../src/lib/tool_rejection.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, READY_PAGE, SOURCE, callIn, count, demoDefinition, endActivities, enterStage, makeWorkspace, moveRows, overallDefinition, query } from "./helpers.ts";

const DEFINITION = validateDefinition(overallDefinition());
const HOW = "开展哪一项活动由用户决定：请用户从任务状况卡开展一项活动。任务空闲时你可以立主题页、改主题页、记问题条目";

function workspace(definition: unknown = overallDefinition(), material = true): { dir: string; taskId: string } {
  const dir = makeWorkspace(definition, { material });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return { dir, taskId: query<{ task_id: string }>(dir, "SELECT task_id FROM task")[0].task_id };
}
/**
 * 一个空闲的任务：先移到某个阶段（好有活动记录），再把记录记成已结束。刚建好、有材料的任务缺省就在核读材料，移到核读材料不算移动，
 * 所以要停在核读材料时先绕到澄清再移回来。
 */
function idle(from: (typeof STAGES)[number] = "clarifying"): { dir: string; taskId: string } {
  const made = workspace();
  if (from === "reading") enterStage(made.dir, "clarifying");
  enterStage(made.dir, from);
  endActivities(made.dir);
  return made;
}
const read = <T>(dir: string, body: (db: Parameters<Parameters<typeof withTaskDatabase>[2]>[0]) => T) => withTaskDatabase(dir, { createIfMissing: false }, body);
const page = (title: string) => ({ op: "add", collection: "总体分析", fields: { 标题: title, 它是什么: `${title}是馆里的一件事。`, 状态: "在用" }, sources: [SOURCE] });
const useCase = (name: string) => ({ op: "add", collection: "用例", fields: { 名称: name, 步骤: ["选书", "办手续"] }, sources: [SOURCE] });
const problem = (text: string) => ({ op: "add", collection: "问题", fields: { 事项: text, 状态: "未解决" }, sources: [SOURCE] });
function saveRefusal(dir: string, operations: unknown[]): string | null {
  try {
    saveRevision(callIn(dir), { operations });
    return null;
  } catch (error) {
    assert.ok(error instanceof SaveRejected, String(error));
    return error.message;
  }
}

test("有活动记录而每一条都已结束：任务空闲，读出来是 idle，不看有没有材料；一条记录都没有时仍是按材料定的缺省；早先建的任务仍是 null", () => {
  const { dir, taskId } = idle("modeling");
  assert.equal(read(dir, (db) => openActivityRecord(db, taskId)), null);
  assert.deepEqual(read(dir, (db) => activityRecords(db, taskId)).map((r) => [r.activity, r.ended_at !== null]), [["modeling", true]]);
  assert.deepEqual(read(dir, (db) => [stageOf(db, dir, taskId, DEFINITION), currentStage(db, taskId, true), currentStage(db, taskId, false)]), [IDLE, IDLE, IDLE]);
  // 一条记录都没有：不是空闲，是缺省的位置，这个缺省不落库。
  const fresh = workspace();
  assert.equal(read(fresh.dir, (db) => stageOf(db, fresh.dir, fresh.taskId, DEFINITION)), "reading");
  endActivities(fresh.dir);
  assert.equal(read(fresh.dir, (db) => stageOf(db, fresh.dir, fresh.taskId, DEFINITION)), "reading", "没有记录可结束，位置不变");
  const bare = workspace(overallDefinition(), false);
  assert.equal(read(bare.dir, (db) => stageOf(db, bare.dir, bare.taskId, DEFINITION)), "clarifying");
  // 早先建的任务没有阶段：null，与空闲不是一回事。
  const old = workspace(demoDefinition());
  assert.equal(read(old.dir, (db) => stageOf(db, old.dir, old.taskId, validateDefinition(demoDefinition()))), null);
});

test("空闲时的摘要：现在的位置是 idle，谁移的、什么时候、为什么三项为 null，六个阶段的灯照算；给助手看的只有一句，不说灯", () => {
  const { dir, taskId } = idle();
  const summary = read(dir, (db) => stageSummary(db, dir, taskId, DEFINITION))!;
  assert.deepEqual([summary.current, summary.moved_by, summary.moved_at, summary.reason], [IDLE, null, null, null]);
  assert.deepEqual(Object.keys(summary.lamps), [...STAGES], "灯还是六个阶段的，空闲没有自己的灯");
  assert.equal(IDLE_LINE, "任务现在空闲：没有在进行的活动。开展哪一项活动由用户决定。");
  assert.deepEqual(stageLines(summary), [IDLE_LINE]);
  // 查询任务状态的末尾：那一句，后面照常接提议与卡片两行。
  const lines = getTaskStatus(dir, "sess-a").text.split("\n");
  assert.deepEqual(lines.slice(-3), [IDLE_LINE, "没有开着的提议。", "这一段没有还开着的提问与请选择。"]);
  assert.equal(lines.some((line) => /阶段（|这一段还差|这一段的几项都齐了/.test(line)), false);
});

test("空闲时保存修订：页与问题可以写，别的集合的条目被拦，原话写任务现在没有在进行的活动、由用户从任务状况卡开展一项活动", () => {
  // 在写条目阶段先写好一页与一条用例，再置为空闲。
  const { dir } = workspace();
  enterStage(dir, "writing");
  saveRevision(callIn(dir), { operations: [READY_PAGE] });
  runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: "ui-op-idle-view", kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 1 }] });
  saveRevision(callIn(dir), { operations: [useCase("借书")] });
  endActivities(dir);
  const revisions = count(dir, "revision");
  const added = saveRefusal(dir, [useCase("还书")])!;
  assert.ok(added.includes("- 操作 1（新增，集合「用例」）：新增到「用例」的条目：任务现在没有在进行的活动，这时不能新增「用例」的条目。"), added);
  assert.ok(added.includes(`怎么办：「用例」的条目要在写条目这项活动里写。${HOW}`), added);
  const updated = saveRefusal(dir, [{ op: "update", item: "UC-001", base_revision: 2, fields: { 名称: "借阅图书" } }])!;
  assert.ok(updated.includes("UC-001：任务现在没有在进行的活动，这时不能修改「用例」的条目。"), updated);
  const deleted = saveRefusal(dir, [{ op: "delete", item: "UC-001", base_revision: 2 }])!;
  assert.ok(deleted.includes("任务现在没有在进行的活动，这时不能删除「用例」的条目。"), deleted);
  assert.equal(count(dir, "revision"), revisions, "被拦的一次都没有写进去");
  // 页与问题：新立、修改都可以。
  assert.equal(saveRefusal(dir, [page("预约"), problem("闭馆日算不算在保留期内？")]), null);
  assert.equal(saveRefusal(dir, [{ op: "update", item: "OA-002", base_revision: revisions + 1, fields: { 它是什么: "预约是读者提前占一本书。" } }]), null);
  // 用户在界面上的操作不看阶段，空闲时也一样。
  const out = runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" },
    { op_id: "ui-op-idle-edit", kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 2 }], fields: { 名称: "借阅图书" } });
  assert.equal(out.results[0].item_id, "UC-001");
});

test("空闲时画图、请求评审、完成任务都被拦，原话各写这件事要在哪一项活动里做", async () => {
  const { dir } = idle();
  const diagram: SaveDiagramParams = { name: "借书的过程", kind: "flowchart", mermaid: "flowchart LR\n  a([读者选书]) --> b([办借书手续])", sources: [{ kind: "用户的话", excerpt: "把借书的过程画成一张流程图" }] };
  const layers = async (run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      const found = rejectionOf(error)!;
      return [found.fact, found.guidance];
    }
    assert.fail("应当被拒绝");
  };
  assert.deepEqual(await layers(() => saveDiagram({ ...callIn(dir), userMessages: [{ entryId: "u1", text: "把借书的过程画成一张流程图。" }] }, diagram, { validate: async () => ({ ok: true }) })),
    ["任务现在没有在进行的活动，这时不能画图、改图或删图", `图要在整理建模这项活动里画。${HOW}`]);
  assert.deepEqual(await layers(() => prepareReviews(dir, null, "executor")),
    ["任务现在没有在进行的活动，这时不能请求评审", `评审要在写条目或评审确认这项活动里请求。${HOW}`]);
  assert.deepEqual(await layers(() => completeTask(callIn(dir))),
    ["任务没有标为已完成：任务现在没有在进行的活动，这时不能完成任务。", `完成任务要在评审确认或编写文档这项活动里做。${HOW}。`]);
  assert.deepEqual([count(dir, "diagram"), query<{ status: string }>(dir, "SELECT status FROM task")[0].status], [0, "进行中"]);
});

test("从空闲移到一个阶段：只记开始的一条，事件里的 from 是 null；会话里的说明写从空闲移到哪里；六个阶段都能去", () => {
  const { dir, taskId } = idle();
  const before = count(dir, "event");
  const out = runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: "ui-op-idle-move", kind: "move_stage", fields: { stage: "整理建模" } });
  assert.equal(out.note, "界面操作（不是用户打的字）：用户把任务从空闲移到整理建模。");
  const events = query<{ seq: number; name: string; payload: string }>(dir, "SELECT seq, name, payload FROM event WHERE seq > ? ORDER BY seq", before);
  assert.deepEqual(events.map((e) => [e.name, JSON.parse(e.payload)]), [
    ["ACTIVITY_STARTED", { activity: "modeling", node: "modeling", flow: "initial", from: null, actor: "user", reason: "", run_id: null }],
  ]);
  assert.deepEqual(out.event_seqs, [events[0].seq]);
  assert.deepEqual(read(dir, (db) => [stageOf(db, dir, taskId, DEFINITION), openActivityRecord(db, taskId)!.from]), ["modeling", null]);
  // 移到任务结束前所在的那个阶段也算一次移动：空闲时没有「原地不动」。
  for (const stage of STAGES) {
    const one = idle(stage);
    const records = count(one.dir, "activity_record");
    enterStage(one.dir, stage);
    assert.deepEqual(read(one.dir, (db) => stageOf(db, one.dir, one.taskId, DEFINITION)), stage);
    assert.equal(count(one.dir, "activity_record"), records + 1, stage);
  }
});

test("空闲时卡片上的点击按任务在澄清时判：进入整理建模、开始写条目、退回核读材料算；进入澄清、进入评审确认、退回澄清不算", () => {
  const card = (key: string, text: string, other: { key: string; text: string }) => ({
    id: "reply-card", type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id: "call-card", name: "reply", arguments: { informs: [], act: { kind: "choose", text: "这样可以吗？", options: [{ key, text }, other] } } }] },
  });
  const click = (dir: string, option: { key: string; text: string }, other: { key: string; text: string }) => recordStageCardClick(dir, "sess-a",
    [card(option.key, option.text, other)] as never, { opId: `ui-op-${option.key}`, replyEntry: "reply-card", optionKey: option.key });
  const tried: [{ key: string; text: string }, { key: string; text: string }, boolean, string | null][] = [
    [ENTER_OPTIONS.modeling, STAY_OPTIONS.clarifying, true, null],
    [ENTER_OPTIONS.writing, STAY_OPTIONS.clarifying, true, null],
    [BACK_OPTIONS.reading, STAY_HERE_OPTION, true, null],
    [ENTER_OPTIONS.clarifying, STAY_OPTIONS.reading, false, "not_next"],
    [ENTER_OPTIONS.reviewing, STAY_OPTIONS.writing, false, "not_next"],
    [BACK_OPTIONS.clarifying, STAY_HERE_OPTION, false, "not_back"],
  ];
  for (const [option, other, moved, why] of tried) {
    const { dir } = idle("writing");
    const out = click(dir, option, other);
    assert.deepEqual([out?.from, out?.moved, out?.why], [IDLE, moved, why], option.key);
    assert.equal(moveRows(dir).length, moved ? 2 : 1, option.key);
  }
});
