/**
 * 界面操作 continue_stage（lib/user_stage.ts 与 hooks/user_commands.ts 的 /tw-user）：用户在提议进入下一个阶段的卡片上选了「继续本阶段」。
 * 只往会话里留一条通知，不写库、不发话；提议仍然开着。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { USER_COMMAND, USER_EDIT_CUSTOM_TYPE, USER_RESULT_KEY, registerUserCommands } from "../src/hooks/user_commands.ts";
import { createTask } from "../src/lib/create_task.ts";
import { recordReplyActs } from "../src/lib/dialogue_acts.ts";
import { TASK_ACTIVE, withTaskDatabase } from "../src/lib/schema.ts";
import { BACK_OPTIONS, DOCUMENT_REVIEWED_OPTION, DOCUMENT_REVISE_OPTION, ENTER_OPTIONS, STAY_HERE_OPTION, STAY_OPTIONS, STAY_TEXT } from "../src/lib/stage.ts";
import { openProposal } from "../src/lib/stage_proposal.ts";
import { UserOpError } from "../src/lib/user_ops.ts";
import { CONTINUE_STAGE_KIND, continueStage, continueStageNote } from "../src/lib/user_stage.ts";
import { DEFINITION_PATH, callIn, count, makeWorkspace, overallDefinition, enterStage } from "./helpers.ts";

const SESSION = "sess-ui";
const ACT = { kind: "choose", text: "材料核读完了，进入澄清吗？", items: [{ item_id: "OA-001", revision_no: 1 }], options: [ENTER_OPTIONS.clarifying, STAY_OPTIONS.reading] };
const card = (id: string, act: unknown = ACT) => ({
  id, type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name: "reply", id: `call-${id}`, arguments: { informs: [], act, text: "进入澄清吗？" } }] },
});
const said = (id: string, text: string) => ({ id, type: "message", message: { role: "user", content: text } });
const OTHER = card("a-2", { kind: "choose", text: "选哪一个？", options: [{ key: "yes", text: "可以" }, { key: "no", text: "不行" }] });
const BRANCH = [said("u-1", "读一下材料"), card("a-1"), OTHER] as never;
const NOTE = "界面操作（不是用户打的字）：用户在提议「进入澄清」的卡片上选了「继续本阶段」，没有进入澄清。这个提议仍然开着，用户要进入时会自己点，不用再发同一张卡片。";

function workspace(): string {
  const dir = makeWorkspace(overallDefinition());
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
const request = (fields: Record<string, unknown>, opId = "ui-op-1") => ({ op_id: opId, kind: CONTINUE_STAGE_KIND, fields });
const refused = (run: () => unknown): UserOpError => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof UserOpError, String(error));
    return error;
  }
  throw new Error("本该被拒绝");
};
const open = (dir: string) => withTaskDatabase(dir, { createIfMissing: false }, (db) =>
  openProposal(db, (db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string }).task_id, SESSION));

test("这条会话里的进入卡片上选「继续本阶段」：返回要留的那句话与卡片的位置，库里什么都不多", () => {
  const dir = workspace();
  const events = count(dir, "event");
  const result = continueStage({ workspaceDir: dir, sessionId: SESSION }, BRANCH, request({ reply_message_id: "a-1", option_key: "continue_reading" }));
  assert.deepEqual(result, { op_id: "ui-op-1", kind: "continue_stage", note: NOTE, reply_entry: "a-1", option_key: "continue_reading", stage: "clarifying" });
  assert.equal(continueStageNote({ stage: "writing", enter: ENTER_OPTIONS.writing }),
    "界面操作（不是用户打的字）：用户在提议「开始写条目」的卡片上选了「继续本阶段」，没有进入写条目。这个提议仍然开着，用户要进入时会自己点，不用再发同一张卡片。");
  assert.equal(STAY_TEXT, "继续本阶段");
  assert.deepEqual([count(dir, "event"), count(dir, "activity_record")], [events, 0]);
});

test("回退卡片上的「留在本段」、请过目卡片上的「需要修改」与「看过了，生成文档」：也只留一句话，各有各的说法；回退卡片上的「退回」不走这里", () => {
  const dir = workspace();
  const back = card("b-1", { kind: "choose", text: "前面几页要重看。退回澄清吗？", options: [BACK_OPTIONS.clarifying, STAY_HERE_OPTION] });
  const review = card("b-2", { kind: "choose", text: "补写了两章的导语，请过目。", items: [{ item_id: "OA-010", revision_no: 1 }], options: [DOCUMENT_REVIEWED_OPTION, DOCUMENT_REVISE_OPTION] });
  const branch = [said("u-1", "接着做"), back, review] as never;
  const run = (entry: string, key: string) => continueStage({ workspaceDir: dir, sessionId: SESSION }, branch, request({ reply_message_id: entry, option_key: key }));
  const before = count(dir, "event");
  assert.deepEqual([run("b-1", "stay_in_stage").note, run("b-1", "stay_in_stage").stage], [
    "界面操作（不是用户打的字）：用户在提议「退回澄清」的卡片上选了「留在本段」，没有退回澄清。这个提议仍然开着，用户要退回时会自己点，不用再发同一张卡片。", "clarifying"]);
  assert.equal(run("b-2", "document_revise").note,
    "界面操作（不是用户打的字）：用户在请你过目的卡片上选了「需要修改」。等用户说要改哪里，照着改，改完再发一次请过目的卡片。");
  assert.deepEqual([run("b-2", "document_reviewed").note, run("b-2", "document_reviewed").stage, run("b-2", "document_reviewed").option_key], [
    "界面操作（不是用户打的字）：用户在请你过目的卡片上选了「看过了，生成文档」：卡片点名的页已经记为看过。生成文档由用户在界面上按，你不用为此再做什么。", "document", "document_reviewed"]);
  assert.equal(count(dir, "event"), before, "库里什么都不多");
  // 退回的那一项要记移动，走卡片点击那条路；别的卡片上的键对不上的照旧拒绝。
  assert.equal(refused(() => run("b-1", "back_to_clarify")).code, "rejected");
  assert.equal(refused(() => run("b-1", "document_revise")).message, "认不出这张卡片：它不是助手提议的卡片，或者上面没有这个选项。");
  assert.equal(refused(() => run("b-2", "stay_in_stage")).code, "rejected");
});

test("认不出就拒绝：不是进入卡片、卡片上留在这一段的不是这个键、点的不是留在这一段的键、参数不全、任务不在进行中", () => {
  const dir = workspace();
  const at = (fields: Record<string, unknown>) => refused(() => continueStage({ workspaceDir: dir, sessionId: SESSION }, BRANCH, request(fields)));
  assert.equal(at({ reply_message_id: "a-2", option_key: "continue_reading" }).code, "rejected");      // 别的请选择卡片
  assert.equal(at({ reply_message_id: "u-1", option_key: "continue_reading" }).code, "rejected");      // 用户的话
  assert.equal(at({ reply_message_id: "a-1", option_key: "continue_clarify" }).code, "rejected");      // 这张卡片上留在这一段的是另一个键
  assert.equal(at({ reply_message_id: "a-9", option_key: "continue_reading" }).code, "rejected");      // 这条会话里没有，任务也没有开着的提议
  const enter = at({ reply_message_id: "a-1", option_key: "enter_clarify" });
  assert.deepEqual([enter.code, enter.message], ["rejected", "「enter_clarify」不是留在这一段的选项。"]);
  assert.equal(at({ reply_message_id: "a-1" }).code, "bad_request");
  assert.equal(at({ option_key: "continue_reading" }).code, "bad_request");
  assert.equal(refused(() => continueStage({ workspaceDir: dir, sessionId: SESSION }, BRANCH, { kind: CONTINUE_STAGE_KIND, fields: {} } as never)).code, "bad_request");
  assert.equal(refused(() => continueStage({ workspaceDir: dir, sessionId: SESSION }, BRANCH, { ...request({ reply_message_id: "a-1", option_key: "continue_reading" }), task_id: "TASK-别的" })).code, "bad_request");
  assert.equal(refused(() => continueStage({ workspaceDir: makeWorkspace(overallDefinition()), sessionId: SESSION }, BRANCH, request({ reply_message_id: "a-1", option_key: "continue_reading" }))).code, "no_task");
  withTaskDatabase(dir, { createIfMissing: false }, (db) => db.prepare("UPDATE task SET status = '已完成' WHERE status = ?").run(TASK_ACTIVE));
  assert.equal(at({ reply_message_id: "a-1", option_key: "continue_reading" }).code, "task_closed");
});

test("卡片在同一个工作项的另一条会话里：照这个工作项开着的提议核对；选了之后提议仍然开着", () => {
  const dir = workspace();
  // 一个首次分析的工作项先后有两条会话：卡片是在头一条里发的，用户在后一条里从「待决定」一行点。
  enterStage(dir, "reading", ["sess-first", SESSION]);
  const elsewhere = [said("u-x", "接着昨天的做")] as never;
  const recorded = recordReplyActs(dir, "sess-first", [said("u-0", "读一下材料")] as never, { informs: [], act: ACT as never }, "reply-far", "call-far")!;
  assert.ok(recorded.eventSeq);
  const result = continueStage({ workspaceDir: dir, sessionId: SESSION }, elsewhere, request({ reply_message_id: "reply-far", option_key: "continue_reading" }));
  assert.deepEqual([result.note, result.reply_entry, result.stage], [NOTE, "reply-far", "clarifying"]);
  assert.equal(open(dir)!.event_seq, recorded.eventSeq, "提议还开着");
  // 回复编号不是开着的那一条、键不是它上面留在这一段的那个：拒绝。
  assert.equal(refused(() => continueStage({ workspaceDir: dir, sessionId: SESSION }, elsewhere, request({ reply_message_id: "reply-none", option_key: "continue_reading" }))).code, "rejected");
  assert.equal(refused(() => continueStage({ workspaceDir: dir, sessionId: SESSION }, elsewhere, request({ reply_message_id: "reply-far", option_key: "continue_writing" }))).code, "rejected");
});

/** 登记两个扩展命令，取 /tw-user 的处理函数；sent 按先后记下它往会话里发的东西。 */
function userHandler() {
  const commands = new Map<string, any>();
  const sent: [string, any][] = [];
  registerUserCommands({
    registerCommand: (name: string, spec: any) => commands.set(name, spec),
    sendMessage: (message: any) => sent.push(["custom", message]),
    sendUserMessage: (text: string) => sent.push(["user", text]),
  } as any);
  return { handler: commands.get(USER_COMMAND).handler as (args: string, ctx: any) => Promise<void>, sent };
}
function fakeCtx(dir: string) {
  const status: Record<string, string> = {};
  return { status, ctx: { mode: "rpc", cwd: dir, isIdle: () => true, sessionManager: { getSessionId: () => SESSION, getBranch: () => BRANCH },
    ui: { setStatus: (key: string, value: string) => (status[key] = value), notify() {} } } };
}

test("处理函数：只追加一条界面操作通知，不替用户发话；被拒时什么都不追加，原因经状态栏回传", async () => {
  const dir = workspace();
  const { handler, sent } = userHandler();
  const { ctx, status } = fakeCtx(dir);
  await handler(JSON.stringify({ op_id: "ui-op-7", kind: "continue_stage", fields: { reply_message_id: "a-1", option_key: "continue_reading" } }), ctx);
  assert.deepEqual(JSON.parse(status[USER_RESULT_KEY]), { op_id: "ui-op-7", ok: true, event_seqs: [], results: [], revision_no: null });
  assert.deepEqual(sent, [["custom", { customType: USER_EDIT_CUSTOM_TYPE, content: NOTE, display: true,
    details: { op_id: "ui-op-7", kind: "continue_stage", event_seqs: [], results: [], revision_no: null, undoable: false,
      reply_entry: "a-1", option_key: "continue_reading", stage: "clarifying" } }]]);
  assert.equal(count(dir, "activity_record"), 0);

  const again = fakeCtx(dir);
  await handler(JSON.stringify({ op_id: "ui-op-8", kind: "continue_stage", fields: { reply_message_id: "a-2", option_key: "continue_reading" } }), again.ctx);
  const result = JSON.parse(again.status[USER_RESULT_KEY]);
  assert.deepEqual([result.op_id, result.ok, result.error.code], ["ui-op-8", false, "rejected"]);
  assert.equal(sent.length, 1);
});
