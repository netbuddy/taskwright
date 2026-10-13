/**
 * 开着的提议（lib/stage_proposal.ts）：助手发一张提议进入下一个阶段的卡片，「回复」记的那条事件里带上 proposal；
 * 任务的提议开着没有从事件表里推；卡片在另一条会话里发的，用户在这条会话里点进入照样记移动。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { EVENT_EXECUTOR_ACTS_RECORDED, recordReplyActs } from "../src/lib/dialogue_acts.ts";
import { TASK_ACTIVE, withTaskDatabase } from "../src/lib/schema.ts";
import { BACK_OPTIONS, DOCUMENT_REVIEWED_OPTION, DOCUMENT_REVISE_OPTION, ENTER_OPTIONS, STAY_HERE_OPTION, STAY_OPTIONS, type Stage } from "../src/lib/stage.ts";
import { NO_OPEN_CARDS_LINE, NO_PROPOSAL_LINE, isStayKey, openProposal, proposalKindOf, proposalLine, proposalOfAct } from "../src/lib/stage_proposal.ts";
import { getTaskStatus } from "../src/lib/task_query.ts";
import { taskStatusMessage } from "../src/lib/task_status.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { moveStage, recordStageCardClick } from "../src/lib/stage_read.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, SOURCE, callIn, count, demoDefinition, enterStage, makeWorkspace, overallDefinition, query } from "./helpers.ts";

const SESSION = "sess-a";
const said = (id: string, text: string) => ({ id, type: "message", message: { role: "user", content: text } });

function workspace(definition: unknown = overallDefinition()): string {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}

/** 进入某个阶段的那张卡片：两个选项是进入它与留在前一段。 */
function enterCard(to: Exclude<Stage, "reading">, from: Exclude<Stage, "reviewing">, items: { item_id: string; revision_no?: number }[] = []) {
  return { kind: "choose", text: `这一段做完了，${ENTER_OPTIONS[to].text}吗？`, items, options: [ENTER_OPTIONS[to], STAY_OPTIONS[from]] };
}

let replies = 0;
/** 助手在某条会话里发一条带这张卡片的回复，返回那条回复的会话条目编号与事件序号。 */
function reply(dir: string, act: Record<string, unknown> | null, session = SESSION): { entry: string; seq: number | null } {
  const entry = `reply-${++replies}`;
  const out = recordReplyActs(dir, session, [said(`u-${replies}`, "接着做")] as never, { informs: act ? [] : ["记下了。"], act: act as never }, entry, `call-${entry}`);
  return { entry, seq: out!.eventSeq };
}

const open = (dir: string) => withTaskDatabase(dir, { createIfMissing: false }, (db) => {
  const task = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string };
  return openProposal(db, task.task_id);
});
const payloadOf = (dir: string, seq: number) => JSON.parse(query<{ payload: string }>(dir, "SELECT payload FROM event WHERE seq = ?", seq)[0].payload);

test("一张卡片是不是进入卡片：请选择里有进入某个阶段的键才是；留在这一段的键按五个固定的键认", () => {
  const fact = proposalOfAct(enterCard("clarifying", "reading", [{ item_id: "OA-001", revision_no: 2 }, { item_id: "OA-002" }]))!;
  assert.deepEqual(fact, {
    kind: "enter", stage: "clarifying", enter: ENTER_OPTIONS.clarifying, stay: STAY_OPTIONS.reading, text: "这一段做完了，进入澄清吗？",
    items: [{ item_id: "OA-001", revision_no: 2 }, { item_id: "OA-002", revision_no: null }],
  });
  // 五张卡片各进入一个阶段；没有留在这一段的选项时 stay 是 null。
  assert.deepEqual((["clarifying", "modeling", "writing", "reviewing", "document"] as const).map((to) => proposalOfAct({ kind: "choose", text: "", options: [ENTER_OPTIONS[to]] })),
    (["clarifying", "modeling", "writing", "reviewing", "document"] as const).map((to) => ({ kind: "enter", stage: to, enter: ENTER_OPTIONS[to], stay: null, text: "", items: [] })));
  // 不是请选择、没有进入键、选项不成样子：都不是。
  for (const act of [null, { kind: "confirm", text: "请看", items: [] }, { kind: "choose", text: "选一个", options: [{ key: "a", text: "甲" }, STAY_OPTIONS.reading] },
    { kind: "choose", text: "选一个" }, { kind: "ask", text: "进入澄清吗", options: [ENTER_OPTIONS.clarifying] }]) assert.equal(proposalOfAct(act), null);
  assert.deepEqual(Object.values(STAY_OPTIONS).map((one) => isStayKey(one.key)), [true, true, true, true, true]);
  assert.deepEqual(["enter_clarify", "start_items", "continue", "complete", null, "back_to_clarify", "document_reviewed"].map(isStayKey), [false, false, false, false, false, false, false]);
  // 回退卡片的「留在本段」与请过目卡片的「需要修改」也是不生效的那一项。
  assert.deepEqual([isStayKey(STAY_HERE_OPTION.key), isStayKey(DOCUMENT_REVISE_OPTION.key)], [true, true]);
});

test("发出进入卡片：事件里带 proposal，提议就开着，带着卡片在哪条会话的哪条回复上；别的回复不带，也不结束它", () => {
  const dir = workspace();
  assert.equal(open(dir), null, "还没有发过卡片");
  const card = reply(dir, enterCard("clarifying", "reading", [{ item_id: "OA-001", revision_no: 1 }]));
  assert.deepEqual(payloadOf(dir, card.seq!).proposal, { kind: "enter", stage: "clarifying", enter: ENTER_OPTIONS.clarifying, stay: STAY_OPTIONS.reading,
    text: "这一段做完了，进入澄清吗？", items: [{ item_id: "OA-001", revision_no: 1 }] });
  const now = open(dir)!;
  assert.deepEqual([now.stage, now.enter.key, now.stay?.key, now.session_id, now.reply_entry, now.event_seq, now.items],
    ["clarifying", "enter_clarify", "continue_reading", SESSION, card.entry, card.seq, [{ item_id: "OA-001", revision_no: 1 }]]);
  assert.match(now.at, /^\d{4}-\d{2}-\d{2}/);
  // 之后助手说别的、发别的卡片（文字里碰巧写着 proposal 也一样）：事件里没有 proposal，提议还是原来那一条。
  const plain = reply(dir, null);
  const other = reply(dir, { kind: "choose", text: "\"proposal\" 这个词怎样译？", options: [{ key: "a", text: "提议" }, { key: "b", text: "建议" }] });
  assert.equal("proposal" in payloadOf(dir, plain.seq!), false);
  assert.equal("proposal" in payloadOf(dir, other.seq!), false);
  assert.equal(open(dir)!.event_seq, card.seq);
});

test("提议结束的三种情形：阶段有过一次移动（向前或者退回）、助手发了新的进入卡片、任务不再进行中", () => {
  // 用户点了进入：阶段向前移动，提议结束。
  const forward = workspace();
  reply(forward, enterCard("clarifying", "reading"));
  enterStage(forward, "clarifying");
  assert.equal(open(forward), null);
  // 任务退回了前面的阶段（用户移的：助手不能自己移动阶段）：早先的提议也结束。
  const back = workspace();
  enterStage(back, "modeling");
  reply(back, enterCard("writing", "modeling"));
  assert.equal(open(back)!.stage, "writing");
  withTaskDatabase(back, { createIfMissing: false }, (db) => {
    const task = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string };
    moveStage(db, back, { taskId: task.task_id, sessionId: SESSION, runId: null, callId: "ui-op-back", actor: "user" }, "clarifying", "用户在卡片上选了「退回澄清」：两页的理解对不上");
  });
  assert.equal(open(back), null);
  // 移动之后助手又发了一张：新的这一条开着。早先那一条不会回来。
  const again = reply(back, enterCard("modeling", "clarifying"));
  assert.deepEqual([open(back)!.stage, open(back)!.event_seq], ["modeling", again.seq]);
  // 没有移动、助手又发一张新的进入卡片：开着的是新的那一条。
  const newer = reply(back, enterCard("modeling", "clarifying", [{ item_id: "OA-003", revision_no: 4 }]));
  assert.deepEqual([open(back)!.event_seq, open(back)!.items], [newer.seq, [{ item_id: "OA-003", revision_no: 4 }]]);
  // 任务不再进行中：没有开着的提议。
  withTaskDatabase(back, { createIfMissing: false }, (db) => db.prepare("UPDATE task SET status = '已完成' WHERE status = ?").run(TASK_ACTIVE));
  assert.equal(open(back), null);
});

test("早先建的任务没有阶段：发了带进入键的卡片也不记 proposal", () => {
  const dir = workspace(demoDefinition());
  const card = reply(dir, enterCard("writing", "clarifying"));
  assert.equal("proposal" in payloadOf(dir, card.seq!), false);
  assert.equal(open(dir), null);
});

test("卡片在另一条会话里：这条会话的分支上找不到那条回复，点进入照开着的提议记移动；键或回复编号对不上就不记", () => {
  const dir = workspace();
  const card = reply(dir, enterCard("clarifying", "reading"), "sess-first");
  const elsewhere = [said("u-x", "接着昨天的做")] as never;
  // 键不是开着的提议的进入键、回复编号是别的卡片：都不记。
  assert.equal(recordStageCardClick(dir, "sess-second", elsewhere, { opId: "ui-op-1", replyEntry: card.entry, optionKey: "enter_consolidate" }), null);
  assert.equal(recordStageCardClick(dir, "sess-second", elsewhere, { opId: "ui-op-2", replyEntry: "reply-none", optionKey: "enter_clarify" }), null);
  assert.equal(count(dir, "stage_record"), 0);
  // 键与回复编号都对得上：记一条用户的移动，记在点的那条会话上；提议随之结束。
  const moved = recordStageCardClick(dir, "sess-second", elsewhere, { opId: "ui-op-3", replyEntry: card.entry, optionKey: "enter_clarify" })!;
  assert.deepEqual([moved.moved, moved.from, moved.requested], [true, "reading", "clarifying"]);
  assert.deepEqual(query(dir, "SELECT stage, from_stage, actor, session_id, call_id FROM stage_record").map((row) => ({ ...row })),
    [{ stage: "clarifying", from_stage: "reading", actor: "user", session_id: "sess-second", call_id: "ui-op-3" }]);
  assert.equal(open(dir), null);
  // 提议已经结束：同一个请求再来一次不再记。
  assert.equal(recordStageCardClick(dir, "sess-second", elsewhere, { opId: "ui-op-4", replyEntry: card.entry, optionKey: "enter_clarify" }), null);
  // 没有给回复编号、键对得上开着的提议：也算（任务状况卡上的进入按钮不一定知道回复编号）。
  const next = reply(dir, enterCard("modeling", "clarifying"), "sess-first");
  assert.equal(recordStageCardClick(dir, "sess-second", elsewhere, { opId: "ui-op-5", replyEntry: null, optionKey: "enter_consolidate" })!.moved, true);
  assert.equal(open(dir), null);
  assert.ok(next.seq);
  // 回复编号给的是空文字：与没有给一样。
  reply(dir, enterCard("writing", "modeling"), "sess-first");
  assert.equal(recordStageCardClick(dir, "sess-second", elsewhere, { opId: "ui-op-6", replyEntry: "", optionKey: "start_items" })!.moved, true);
  assert.equal(count(dir, "stage_record"), 3);
});

test("事件的名字与「回复」记的是同一个", () => {
  const dir = workspace();
  const card = reply(dir, enterCard("clarifying", "reading"));
  assert.equal(query<{ name: string }>(dir, "SELECT name FROM event WHERE seq = ?", card.seq)[0].name, EVENT_EXECUTOR_ACTS_RECORDED);
});

// ───────────── 另外两种提议：退回、补写待过目 ─────────────

const backCard = (to: Exclude<Stage, "document">, text = "用户放进了新材料，前面几页要重看。退回吗？") =>
  ({ kind: "choose", text, options: [BACK_OPTIONS[to], STAY_HERE_OPTION] });
const reviewCard = (items: { item_id: string; revision_no?: number }[]) =>
  ({ kind: "choose", text: "补写了两章的导语，请过目。", items, options: [DOCUMENT_REVIEWED_OPTION, DOCUMENT_REVISE_OPTION] });

test("回退卡片与请过目的卡片也是提议：种类、关于哪个阶段、生效与不生效的两项各是什么；早先没有记种类的事件当作进入", () => {
  assert.deepEqual(proposalOfAct(backCard("clarifying")), {
    kind: "back", stage: "clarifying", enter: BACK_OPTIONS.clarifying, stay: STAY_HERE_OPTION, text: "用户放进了新材料，前面几页要重看。退回吗？", items: [] });
  assert.deepEqual(proposalOfAct(reviewCard([{ item_id: "OA-010", revision_no: 3 }])), {
    kind: "review", stage: "document", enter: DOCUMENT_REVIEWED_OPTION, stay: DOCUMENT_REVISE_OPTION, text: "补写了两章的导语，请过目。", items: [{ item_id: "OA-010", revision_no: 3 }] });
  // 只有「需要修改」或只有「留在本段」的卡片不是提议。
  assert.equal(proposalOfAct({ kind: "choose", text: "要改吗", options: [DOCUMENT_REVISE_OPTION, { key: "x", text: "别的" }] }), null);
  assert.equal(proposalOfAct({ kind: "choose", text: "留下吗", options: [STAY_HERE_OPTION, { key: "x", text: "别的" }] }), null);
  assert.deepEqual([
    proposalKindOf({ stage: "clarifying", enter: ENTER_OPTIONS.clarifying }), proposalKindOf({ kind: "back", stage: "reading", enter: BACK_OPTIONS.reading }),
    proposalKindOf({ kind: "review", stage: "document", enter: DOCUMENT_REVIEWED_OPTION }),
    // 种类与键对不上、阶段写法不对、不是对象：认不出。
    proposalKindOf({ kind: "back", stage: "reading", enter: ENTER_OPTIONS.clarifying }), proposalKindOf({ kind: "enter", stage: "别的", enter: ENTER_OPTIONS.clarifying }), proposalKindOf(null),
  ], ["enter", "back", "review", null, null, null]);
});

test("回退的提议：发出就开着，用户点了退回（阶段移动）就结束；用户留在本段时仍然开着", () => {
  const dir = workspace();
  enterStage(dir, "modeling");
  const card = reply(dir, backCard("reading"));
  const now = open(dir)!;
  assert.deepEqual([now.kind, now.stage, now.enter.key, now.stay?.key, now.reply_entry], ["back", "reading", "back_to_reading", "stay_in_stage", card.entry]);
  // 卡片不在这条会话的分支上（换了一条会话）：照开着的提议核对，点退回照样记移动，理由里带卡片的问句。
  const moved = recordStageCardClick(dir, "sess-b", [said("u-9", "在吗")] as never, { opId: "ui-op-b", replyEntry: card.entry, optionKey: "back_to_reading" })!;
  assert.deepEqual([moved.moved, moved.from, moved.requested], [true, "modeling", "reading"]);
  assert.equal(query<{ reason: string }>(dir, "SELECT reason FROM stage_record ORDER BY event_seq DESC LIMIT 1")[0].reason,
    "用户在卡片上选了「退回核读材料」：用户放进了新材料，前面几页要重看。退回吗？");
  assert.equal(open(dir), null);
});

test("补写待过目的提议：发出就开着；卡片点名的页用户都看过了就结束；助手又改了其中一页、再发一张，新的那一条开着", () => {
  const dir = workspace();
  const add = (title: string) => saveRevision(callIn(dir), { operations: [{ op: "add", collection: "总体分析",
    fields: { 标题: title, 它是什么: `${title}的说明。`, 状态: "在用" }, sources: [SOURCE] }] });
  add("业务流程导语");
  add("角色导语");
  enterStage(dir, "document");
  const pages = [{ item_id: "OA-001", revision_no: 1 }, { item_id: "OA-002", revision_no: 2 }];
  const card = reply(dir, reviewCard(pages));
  assert.deepEqual([open(dir)!.kind, open(dir)!.stage, open(dir)!.items, open(dir)!.event_seq], ["review", "document", pages, card.seq]);
  const view = (item: string, revision: number) => runUserOperation({ workspaceDir: dir, sessionId: SESSION },
    { op_id: `ui-view-${item}-${revision}`, kind: "mark_viewed", targets: [{ item_id: item, base_revision: revision }], notify_executor: false });
  // 只看了一页：还开着。
  view("OA-001", 1);
  assert.equal(open(dir)!.event_seq, card.seq);
  // 两页都看过：结束。
  view("OA-002", 2);
  assert.equal(open(dir), null);
  // 助手照用户说的又改了一页（它又成了没看过的），再发一张卡片：开着的是新的那一条。
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "OA-002", base_revision: 2, fields: { 它是什么: "读者与馆员两种角色。" } }] });
  const again = reply(dir, reviewCard([{ item_id: "OA-001", revision_no: 1 }, { item_id: "OA-002", revision_no: 3 }]));
  assert.equal(open(dir)!.event_seq, again.seq);
  // 一页都没有点名的请过目卡片：没有可看的页，一直开着到下一次提议或移动。
  const bare = reply(dir, reviewCard([]));
  assert.equal(open(dir)!.event_seq, bare.seq);
  enterStage(dir, "reviewing");
  assert.equal(open(dir), null);
});

// ───────────── 开着的提议写给助手看 ─────────────

test("给助手看的那一行：三种提议各一句，写明卡片在不在这条会话里、用户要做这件事时请他点「待决定」；没有时写没有", () => {
  const dir = workspace();
  assert.equal(proposalLine(null, SESSION), NO_PROPOSAL_LINE);
  assert.equal(NO_PROPOSAL_LINE, "没有开着的提议。");
  reply(dir, enterCard("clarifying", "reading"));
  assert.equal(proposalLine(open(dir), SESSION),
    "开着的提议：进入澄清（卡片在这条会话里）。用户还没有进入；他要进入时不要重发同一张卡片，请他点输入框上方「待决定」一行里的按钮。");
  assert.match(proposalLine(open(dir), "sess-b"), /^开着的提议：进入澄清（卡片在另一条会话里）。/);
  assert.match(proposalLine(open(dir), null), /卡片在另一条会话里/);
  enterStage(dir, "modeling");
  reply(dir, backCard("reading"));
  assert.equal(proposalLine(open(dir), SESSION),
    "开着的提议：退回核读材料（卡片在这条会话里）。用户还没有决定；他要退回时不要重发同一张卡片，请他点输入框上方「待决定」一行里的按钮。");
  reply(dir, reviewCard([{ item_id: "OA-010", revision_no: 1 }, { item_id: "OA-011", revision_no: 1 }]));
  assert.equal(proposalLine(open(dir), SESSION),
    "开着的提议：请用户过目补写的 2 页（OA-010、OA-011）（卡片在这条会话里）。用户还没有都看过；他说看过了、要生成文档时不要重发同一张卡片，请他点输入框上方「待决定」一行里的按钮。");
});

test("查询任务状态的末尾、新会话的任务现状说明都带这一行；早先建的任务不带", () => {
  const FRESH = { hasUserMessage: false, hasStatusMessage: false, lastMessageAt: null };
  const dir = workspace();
  assert.match(getTaskStatus(dir, SESSION).text, /\n没有开着的提议。\n这一段没有还开着的提问与请选择。$/);
  assert.match(taskStatusMessage(dir, FRESH, "sess-b")!.text, /\n没有开着的提议。$/);
  reply(dir, enterCard("clarifying", "reading"));
  assert.match(getTaskStatus(dir, SESSION).text, /\n开着的提议：进入澄清（卡片在这条会话里）。[^\n]*\n这一段没有还开着的提问与请选择。$/);
  // 没有给会话编号时不写后一行：开着的卡片是按会话算的。
  assert.match(getTaskStatus(dir).text, /\n开着的提议：进入澄清（卡片在另一条会话里）。[^\n]*$/);
  // 新开的另一条会话：助手的上下文里没有那张卡片，靠这一行知道。
  const fresh = taskStatusMessage(dir, FRESH, "sess-b")!;
  assert.match(fresh.text, /\n开着的提议：进入澄清（卡片在另一条会话里）。用户还没有进入；他要进入时不要重发同一张卡片/);
  assert.equal((fresh.details.proposal as { stage: string }).stage, "clarifying");
  const old = workspace(demoDefinition());
  assert.doesNotMatch(getTaskStatus(old, SESSION).text, /提议/);
  assert.doesNotMatch(taskStatusMessage(old, FRESH, "sess-b")!.text, /提议/);
});

test("这一段还开着的提问与请选择：只列这条会话里、进入现在这个阶段之后发出的；提议的卡片、别的种类、答过的、重发过的、前面阶段留下的都不列", () => {
  const dir = workspace();
  const line = (session = SESSION) => getTaskStatus(dir, session).text.split("\n").at(-1)!;
  assert.equal(NO_OPEN_CARDS_LINE, "这一段没有还开着的提问与请选择。");
  assert.equal(line(), NO_OPEN_CARDS_LINE);
  // 核读材料段里问了一问、请选了一次，又发了提议进入澄清的卡片，还有一条给建议值。
  reply(dir, { kind: "ask", text: "借阅期限是多少天" });
  reply(dir, { kind: "choose", text: "逾期按哪种办法处理", options: [{ key: "a", text: "罚款" }, { key: "b", text: "停借" }] });
  reply(dir, { kind: "suggest", text: "建议每人最多借五本", value: "五本", basis: [] });
  reply(dir, enterCard("clarifying", "reading"));
  const ids = query<{ act_id: string }>(dir, "SELECT act_id FROM dialogue_act WHERE expects_response = 1 ORDER BY rowid").map((one) => one.act_id);
  assert.equal(line(),
    `这一段还开着的提问与请选择 2 张（你问过、用户搁下没有答的）：${ids[0]} 提问「借阅期限是多少天」；${ids[1]} 请选择「逾期按哪种办法处理」。` +
    "提议进入下一段之前，把它们一次一张重发（act 里写 resends，值是这里的编号），全部过完再发进入下一段的卡片。");
  // 别的会话里看不到这条会话的卡片。
  assert.equal(line("sess-b"), NO_OPEN_CARDS_LINE);
  // 重发了第一张：原来那张不再列；重发的那一张另列在后半句，写明不要再重发、记成问题条目。
  reply(dir, { kind: "ask", text: "借阅期限是多少天", resends: ids[0] });
  assert.match(line(), new RegExp(`^这一段还开着的提问与请选择 1 张（你问过、用户搁下没有答的）：${ids[1]} 请选择「逾期按哪种办法处理」。提议进入下一段之前，把它们一次一张重发[^。]*。` +
    "这一段重发过一次、用户仍没有答的 1 张：r\\d+-\\d+ 提问「借阅期限是多少天」。不要再重发：还没有为它记问题条目的记一条（写明是否阻断下游），然后照常提议进入下一段。$"));
  assert.doesNotMatch(line(), new RegExp(`${ids[0]} 提问`));
  // 两张都重发过了：只剩后半句。
  reply(dir, { kind: "choose", text: "逾期按哪种办法处理", options: [{ key: "a", text: "罚款" }, { key: "b", text: "停借" }], resends: ids[1] });
  assert.match(line(), /^这一段重发过一次、用户仍没有答的 2 张：/);
  // 任务进入了澄清：前面那一段留下的不再列。
  enterStage(dir, "clarifying");
  assert.equal(line(), NO_OPEN_CARDS_LINE);
  reply(dir, { kind: "ask", text: "馆员能不能代借" });
  assert.match(line(), /^这一段还开着的提问与请选择 1 张（你问过、用户搁下没有答的）：r\d+-\d+ 提问「馆员能不能代借」。/);
});

test("续接旧会话：上次之后才发出的提议写一条（别的都没有变也写）；上次之前发的不重复；没有开着的不写", () => {
  const dir = workspace();
  const facts = (lastMessageAt: number) => ({ hasUserMessage: true, hasStatusMessage: true, lastMessageAt });
  // 没有开着的提议、别的也没有变：照旧不写。
  assert.equal(taskStatusMessage(dir, facts(Date.now() + 1000), "sess-b"), null);
  const before = Date.now() - 60_000;
  reply(dir, enterCard("clarifying", "reading"));
  // 这条会话上次的最后一条消息在卡片之前：写一条，带这一行。
  const told = taskStatusMessage(dir, facts(before), "sess-b")!;
  assert.equal(told.kind, "变化");
  assert.match(told.text, /\n开着的提议：进入澄清（卡片在另一条会话里）。/);
  // 上次的最后一条消息在卡片之后（这条会话已经知道了）：不为它再写。
  assert.equal(taskStatusMessage(dir, facts(Date.now() + 60_000), "sess-b"), null);
});
