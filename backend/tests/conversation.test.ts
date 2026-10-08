/**
 * 会话记录：卡片点击合成、界面操作与系统说明、兜底回复、只取当前分支、分页；过程摘要：相邻同类合并、用时与工作编号、
 * 保存修订被拒的原因（两层写法）、重放的保存、请求评审；告知的两种写法；会话列表从会话文件读。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FALLBACK_TEXT, baseMessages, branch, normalizeInforms, page, textOf } from "../src/conversation.ts";
import { Sessions } from "../src/sessions.ts";
import { LIMIT_STOPPED_STEP_TEXT, rejectionParts, rejectionReasons, replyRefusal, stepText, worksFromEntries } from "../src/work_summary.ts";
import { tempDir } from "./helpers.ts";

const works = (entries: Record<string, unknown>[], definition: Record<string, unknown> = {}) =>
  worksFromEntries(branch(entries), definition, FALLBACK_TEXT, textOf);

test("对话记录：卡片点击合成、界面操作与系统说明、兜底回复、只取当前分支、分页", () => {
  const ts = "2026-09-22T01:00:00.000Z";
  const entries = [
    { type: "session", id: "h" },
    { type: "custom_message", id: "s1", parentId: null, customType: "taskwright-task-status", content: "【任务现状】", timestamp: ts },
    { type: "message", id: "u1", parentId: "s1", timestamp: ts, message: { role: "user", content: [{ type: "text", text: "用户说：/hi" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "reply", arguments: { informs: ["一"], act: null, text: "你好" } }] } },
    { type: "message", id: "r1", parentId: "a1", timestamp: ts, message: { role: "toolResult", toolCallId: "c1", isError: false } },
    { type: "custom_message", id: "k1", parentId: "r1", customType: "taskwright-ui-click", content: "界面点击",
      details: { reply_entry: "a1", option_key: "a", option_text: "甲", text: "我选：甲" }, timestamp: ts },
    { type: "message", id: "u2", parentId: "k1", timestamp: ts, message: { role: "user", content: [{ type: "text", text: "我选：甲" }] } },
    { type: "message", id: "a2", parentId: "u2", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "直接说的话" }] } },
    { type: "custom_message", id: "e1", parentId: "a2", customType: "taskwright-user-edit", content: "界面操作",
      details: { op_id: "ui-op-1", event_seqs: [7], undoable: true, kind: "edit_fields" }, timestamp: ts },
    { type: "message", id: "x9", parentId: "s1", timestamp: ts, message: { role: "user", content: "被放弃的分支" } },
  ];
  const messages = baseMessages(entries.slice(0, -1), "S");
  assert.deepEqual(messages.map((m) => [m.type, m.message_id]), [["system_note", "s1"], ["user_message", "u1"], ["assistant_reply", "a1"],
    ["user_message", "u2"], ["assistant_reply", "a2"], ["ui_action_noted", "e1"]]);
  assert.equal(messages[1].text, "/hi");
  assert.deepEqual([messages[2].informs, messages[2].via_reply_tool], [[{ text: "一" }], true]);
  assert.deepEqual([messages[3].origin, messages[3].annotation.option_text], ["card_choice", "甲"]);
  assert.deepEqual([messages[4].via_reply_tool, messages[4].text], [false, "直接说的话"]);
  assert.deepEqual([messages[5].event_seq, messages[5].undoable], [7, true]);
  const first = page(messages, null, 2);
  assert.deepEqual([first.has_earlier, first.earliest_id], [true, "a2"]);
  assert.equal(page(messages, "u2", 100).messages.at(-1)!.message_id, "a1");
  assert.deepEqual(baseMessages(entries, "S").map((m) => m.message_id), ["s1", "x9"], "只取当前分支");
});

test("兜底追加的那句固定文字显示成系统说明，不结束这一段", () => {
  const ts = "2026-09-22T01:00:00.000Z";
  const out = baseMessages([
    { type: "message", id: "u1", parentId: null, timestamp: ts, message: { role: "user", content: "整理" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "我先说一句" }] } },
    { type: "message", id: "f1", parentId: "a1", timestamp: ts, message: { role: "user", content: FALLBACK_TEXT } },
  ], "S");
  assert.deepEqual(out.map((m) => [m.type, m.message_id]), [["user_message", "u1"], ["assistant_reply", "a1"], ["system_note", "f1"]]);
  assert.match(out[2].text, /这句不是你说的/);
});

test("过程摘要：相邻同类合并，用时与工作编号，回复所在的条目", () => {
  const msg = (id: string, parentId: string | null, t: number, role: string, content: unknown) =>
    ({ type: "message", id, parentId, timestamp: `2026-09-22T01:00:${String(t).padStart(2, "0")}.000Z`, message: { role, content } });
  const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
  const result = (id: string, parentId: string, t: number, callId: string, isError = false, details: unknown = {}) =>
    ({ type: "message", id, parentId, timestamp: `2026-09-22T01:00:${String(t).padStart(2, "0")}.000Z`, message: { role: "toolResult", toolCallId: callId, isError, details } });
  const entries = [
    { type: "session", id: "h" },
    msg("u1", null, 0, "user", "整理材料"),
    msg("a1", "u1", 2, "assistant", [call("c1", "read", { path: "/w/inputs/甲.md" }), call("c2", "read", { path: "/w/inputs/乙.md" })]),
    result("r1", "a1", 3, "c1"), result("r2", "r1", 3, "c2"),
    msg("a2", "r2", 5, "assistant", [call("c3", "save_revision", {})]), result("r3", "a2", 6, "c3", true),
    msg("a3", "r3", 8, "assistant", [call("c4", "save_revision", {})]),
    result("r4", "a3", 9, "c4", false, { revision_no: 1, operations: [{ op: "add", collection: "功能用例", item: "UC-001" }] }),
    msg("a4", "r4", 12, "assistant", [call("c5", "reply", { informs: [], act: null, text: "好了" })]), result("r5", "a4", 12, "c5"),
    msg("u2", "r5", 20, "user", "再看看"),
    msg("a5", "u2", 22, "assistant", [call("c6", "ls", { path: "/w/inputs" })]), result("r6", "a5", 23, "c6"),
  ];
  const [first, second] = works(entries, { 材料目录: "inputs/" });
  assert.deepEqual([first.work_id, first.step_count, first.seconds, first.reply_ids, first.call_ids], ["w-u1", 5, 12, ["a4"], ["c1", "c2", "c3", "c4", "c5"]]);
  assert.deepEqual(first.stages.map((s) => s.text), ["读了材料《甲.md》、《乙.md》", "保存修订被拒，助手正在照原因改", "写好并保存了修订 1：新增功能用例 1 个（UC-001）", "组织并发出了回复"]);
  assert.ok(!("reasons" in first.stages[1]), "结果正文里取不到原因时照旧写固定的一句，不带 reasons");
  assert.deepEqual([second.work_id, second.step_count, second.stages[0].text], ["w-u2", 1, "看了目录"]);
});

test("过程摘要：保存修订被拒附上原因，多于一条时写还有几条", () => {
  const msg = (id: string, parentId: string | null, role: string, content: unknown) => ({ type: "message", id, parentId, timestamp: "2026-09-22T01:00:00.000Z", message: { role, content } });
  const rejected = (id: string, parentId: string, callId: string, text: string) =>
    ({ type: "message", id, parentId, timestamp: "2026-09-22T01:00:01.000Z", message: { role: "toolResult", toolCallId: callId, isError: true, details: {}, content: [{ type: "text", text }] } });
  const two = "这次「保存修订」什么都没有写入，因为有 2 个操作不对：\n- 操作 1（新增，集合「功能用例」）：第 1 条来源的摘录「借书」在 inputs/甲.md 里找不到。\n" +
    "- 操作 2（修改，条目 UC-001）：这个条目已经被用户改到修订 3。\n  它现在的内容：……\n请把这些地方改正之后，把整批操作重新提交一次。";
  const one = "这次「保存修订」什么都没有写入，因为有 1 个操作不对：\n- 操作 1（新增，集合「问题」）：字段「关联条目」是条目引用类型，第 1 个编号 \"UC-006\" 指向的条目在这个任务里不存在。\n" +
    "请把这些地方改正之后，把整批操作重新提交一次。";
  const call = (id: string, parentId: string, callId: string) => msg(id, parentId, "assistant", [{ type: "toolCall", id: callId, name: "save_revision", arguments: {} }]);
  const [work] = works([{ type: "session", id: "h" }, msg("u1", null, "user", "整理材料"),
    call("a1", "u1", "c1"), rejected("r1", "a1", "c1", two), call("a2", "r1", "c2"), rejected("r2", "a2", "c2", one),
    call("a3", "r2", "c3"), rejected("r3", "a3", "c3", "Validation failed for tool \"save_revision\"")]);
  assert.equal(work.stages[0].text, "保存修订被拒：第 1 条来源的摘录「借书」在 inputs/甲.md 里找不到。（还有 1 条）");
  assert.deepEqual(work.stages[0].reasons, ["第 1 条来源的摘录「借书」在 inputs/甲.md 里找不到。", "这个条目已经被用户改到修订 3。"]);
  assert.equal(work.stages[1].text, "保存修订被拒：字段「关联条目」是条目引用类型，第 1 个编号 \"UC-006\" 指向的条目在这个任务里不存在。");
  assert.equal(work.stages[1].reasons.length, 1);
  assert.deepEqual(work.stages[2], { text: "保存修订被拒，助手正在照原因改", count: 1 }, "不是保存修订自己的拒绝正文时照旧写固定的一句");
});

test("过程摘要：拒绝原因分两层，摘要与展开只用事实", () => {
  const text = "这次「保存修订」什么都没有写入，因为有 2 个操作不对：\n" +
    "- 操作 1（修改，条目 TBD-001）：助手想改 TBD-001 的「种类」，但问题条目写下后只能改状态与处理结果。\n" +
    "  怎么办：用户的回答要写进它牵涉的条目（关联条目里列的那些），改完再问用户这个问题是否已解决。\n" +
    "- 操作 2（修改，条目 UC-001）：UC-001 已经被用户改到修订 3，助手看到的还是修订 2。\n" +
    "  怎么办：请先读最新内容再改。它在修订 3 的内容是：{\"名称\":\"借书\"}。\n" +
    "请把这些地方改正之后，把整批操作重新提交一次。";
  const parts = rejectionParts({}, text);
  assert.deepEqual(parts[0], { fact: "助手想改 TBD-001 的「种类」，但问题条目写下后只能改状态与处理结果。",
    guidance: "用户的回答要写进它牵涉的条目（关联条目里列的那些），改完再问用户这个问题是否已解决。" });
  assert.equal(stepText("save_revision", {}, true, true, { reasons: parts }, {}), "保存修订被拒：助手想改 TBD-001 的「种类」，但问题条目写下后只能改状态与处理结果。（还有 1 条）");
  assert.deepEqual(rejectionReasons({}, text), ["助手想改 TBD-001 的「种类」，但问题条目写下后只能改状态与处理结果。", "UC-001 已经被用户改到修订 3，助手看到的还是修订 2。"]);
});

test("过程摘要：重放的保存修订写明没有重复写入；请求评审写评审了几个条目几个不合规", () => {
  assert.equal(stepText("save_revision", {}, true, false, { revision_no: 4, replayed: true, operations: [] }, {}), "这次保存是重复的请求，修订 4 之前已经保存过，没有重复写入");
  const details = { results: [{ status: "合规" }, { status: "不合规" }, { status: "评审未完成" }] };
  assert.equal(stepText("request_review", {}, true, false, details, {}), "评审了 3 个条目，1 个不合规");
  assert.equal(stepText("request_review", {}, false, false, null, {}), "正在请评审者评审");
  assert.equal(stepText("request_review", {}, true, true, null, {}), "请评审者评审没有做成");
});

test("过程摘要：查找知识库写查到几个片段，只按字面找的写明；工具只回一句话（没有查到、没有联系上）时写没有查到片段；列给助手的个数比查到的少时写列出的个数", () => {
  const query = { query: "图书超期不还怎样罚款" };
  assert.equal(stepText("search_knowledge", query, false, false, null, {}), "正在查找知识库");
  assert.equal(stepText("search_knowledge", query, true, false, { ok: true, mode: "hybrid", hits: [{ score: 0.71 }, { score: 0.63 }], shown: 2 }, {}), "在知识库里查到 2 个片段");
  assert.equal(stepText("search_knowledge", query, true, false, { ok: true, mode: "hybrid_partial", hits: [{ score: 0.71 }], shown: 1 }, {}), "在知识库里查到 1 个片段");
  assert.equal(stepText("search_knowledge", query, true, false, { ok: true, mode: "keyword", reason: "not_selected", hits: [{}, {}, {}], shown: 3 }, {}), "只按字面在知识库里查到 3 个片段");
  // 超过字节上限、只列了前 3 个。
  assert.equal(stepText("search_knowledge", query, true, false, { ok: true, mode: "hybrid", hits: [{}, {}, {}, {}, {}], shown: 3 }, {}), "在知识库里查到 3 个片段");
  // 更早的结果里没有 shown：按片段的个数写。
  assert.equal(stepText("search_knowledge", query, true, false, { ok: true, ready: true, hits: [{ score: 0.71 }, { score: 0.63 }] }, {}), "在知识库里查到 2 个片段");
  assert.equal(stepText("search_knowledge", query, true, false, { ok: true, mode: "keyword", hits: [], shown: 0 }, {}), "查找知识库，没有查到片段");
  assert.equal(stepText("search_knowledge", query, true, false, { ok: false, ready: false, reason: "unreachable", hits: [] }, {}), "查找知识库，没有查到片段");
  assert.equal(stepText("search_knowledge", {}, true, true, null, {}), "查找知识库没有成");
});

test("过程摘要：grep 的返回太多、被截短时写搜到几行、只看了前几行；没有截短的与出错的照旧", () => {
  const args = { pattern: "罚款", path: "inputs" };
  assert.equal(stepText("grep", args, true, false, { capped: { shown_lines: 40, total_lines: 100 } }, {}), "用 grep 搜到 100 行，只看了前 40 行");
  assert.equal(stepText("grep", args, true, false, { matchLimitReached: 100, capped: { shown_lines: 12, total_lines: 30 } }, {}), "用 grep 搜到 30 行，只看了前 12 行");
  assert.equal(stepText("grep", args, true, false, null, {}), "调用了 grep");
  assert.equal(stepText("grep", args, true, false, { matchLimitReached: 100 }, {}), "调用了 grep");
  assert.equal(stepText("grep", args, false, false, null, {}), "正在调用 grep");
  assert.equal(stepText("grep", args, true, true, { capped: { shown_lines: 40, total_lines: 100 } }, {}), "调用 grep 失败");
  // 别的工具的结果里碰巧有同名的一项：不当成截短。
  assert.equal(stepText("find", args, true, false, { capped: { shown_lines: 40, total_lines: 100 } }, {}), "调用了 find");
});

test("过程摘要：回复被拒按真实原因分写（没有写理解、理解不合格、形式不对）；连续被拒到上限、由工具停下的那一步写已经停下", () => {
  const missing = "回复没有执行：先按 schema 写下你对用户这句话的理解。这一轮还没有写理解。\n请按平台 skill「先写理解」一节的格式……";
  const invalid = "回复没有执行：先按 schema 写下你对用户这句话的理解。这一轮写了 2 个 JSON 片段，都不是合格的理解。各片段的问题：（1）……";
  const form = "回复没有执行：informs 应当是一个列表。";
  assert.deepEqual([replyRefusal(missing), replyRefusal(invalid), replyRefusal(form)], ["understanding_missing", "understanding_invalid", "form"]);
  const said = (text: string) => stepText("reply", {}, true, true, { refusal: replyRefusal(text) }, {});
  assert.equal(said(missing), "助手还没有写下对这句话的理解，正在补");
  assert.equal(said(invalid), "助手写的理解不合格，正在改");
  assert.equal(said(form), "回复的形式不对，助手正在改");
  // 没有认出原因（旧的调用方没有放 refusal）时照原来的说法。
  assert.equal(stepText("reply", {}, true, true, null, {}), "回复的形式不对，助手正在改");
  assert.equal(stepText("reply", {}, true, false, { delivered: true }, {}), "说完了");
  assert.equal(stepText("reply", {}, false, false, null, {}), "正在组织回复");
  // 停下的那一步：三个工具都可能，都写同一句，不写「正在改」。
  for (const tool of ["reply", "save_revision", "complete_task"]) {
    assert.equal(stepText(tool, {}, true, true, { stopped: true, rejections: 5, reason_kind: "understanding_missing" }, {}), "助手这一轮没有按规矩回答，已经停下", tool);
  }
  assert.equal(LIMIT_STOPPED_STEP_TEXT, "助手这一轮没有按规矩回答，已经停下");
});

test("过程摘要：完成任务被拒时不写原因（条件没满足与用户还没同意都一样），做成了写把任务标为已完成", () => {
  assert.equal(stepText("complete_task", {}, true, true, null, {}), "完成任务没有做成");
  assert.equal(stepText("complete_task", {}, true, false, null, {}), "把任务标为已完成");
  assert.equal(stepText("complete_task", {}, false, false, null, {}), "正在完成任务");
});

test("告知：纯文字与带条目的都整理成对象，认不出的丢掉", () => {
  assert.deepEqual(normalizeInforms(["甲", { text: "乙", items: [{ item_id: "UC-001" }, { x: 1 }] }, { text: "丙", items: [] }, 3, { items: [] }]),
    [{ text: "甲" }, { text: "乙", items: [{ item_id: "UC-001" }] }, { text: "丙" }]);
});

test("会话列表从会话文件读：编号、名字、开始与最近活动、消息条数；不起 pi 时都不是活动会话", () => {
  const runs = tempDir();
  try {
    const dir = join(runs, "T", "pi-sessions", "service");
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: "session", id: "S2", timestamp: "2026-09-22T01:00:00.000Z" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-22T01:00:05.000Z", message: { role: "user", content: "你好" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-22T01:00:09.000Z", message: { role: "assistant", content: [] } },
      { type: "message", id: "t1", parentId: "a1", timestamp: "2026-09-22T01:00:10.000Z", message: { role: "toolResult", content: [] } },
      { type: "session_info", id: "n1", parentId: "t1", name: "第一条" },
    ];
    writeFileSync(join(dir, "b.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n不是 JSON 的一行\n", "utf-8");
    writeFileSync(join(dir, "a.jsonl"), JSON.stringify({ type: "session", id: "S1", timestamp: "2026-09-21T01:00:00.000Z" }) + "\n", "utf-8");
    writeFileSync(join(dir, "c.txt"), "不是会话文件", "utf-8");
    const rows = new Sessions(runs, "T").list();
    assert.deepEqual(rows.map((r) => [r.session_id, r.name, r.message_count, r.active]), [["S1", null, 0, false], ["S2", "第一条", 2, false]]);
    assert.equal(rows[1].started_at!.slice(0, 10), rows[1].last_active_at!.slice(0, 10));
    assert.notEqual(rows[1].started_at, rows[1].last_active_at);
    assert.deepEqual(new Sessions(runs, "没有这个任务").list(), []);
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
});

// ───────────── 带过程摘要的对话记录：与期望值逐字一致 ─────────────

import { readFileSync } from "node:fs";
import { ROOT } from "./helpers.ts";
import { messages as fullMessages } from "../src/conversation.ts";
import { CONVERSATION_DEFINITION, CONVERSATION_ENTRIES } from "./fixtures/expected/inputs.ts";

test("对话记录与过程摘要：对一份会话条目，输出与期望值逐字一致；没有回复的那次工作的摘要放在下一句话之前、只有正文的不算一次工作", () => {
  const [entries, definition] = [CONVERSATION_ENTRIES, CONVERSATION_DEFINITION];
  // 期望值在 fixtures/expected/conversation.json（说明见那里的 README.md）。
  const expected = JSON.parse(readFileSync(join(ROOT, "backend", "tests", "fixtures", "expected", "conversation.json"), "utf-8"));
  // 结束原因（outcome）不在期望值里（见 fixtures/expected/README.md「期望值里没有的字段」）：比较之前只去掉这一个字段，其余逐字比较，结束原因另外断言。
  const withoutOutcome = <T extends Record<string, unknown>>(list: T[]) => list.map(({ outcome: _outcome, ...rest }) => rest);
  const messages = fullMessages(entries, "S", definition);
  const works = worksFromEntries(branch(entries), definition, FALLBACK_TEXT, textOf);
  assert.deepEqual(withoutOutcome(messages), expected.messages);
  assert.deepEqual(withoutOutcome(works as unknown as Record<string, unknown>[]), expected.works);
  assert.deepEqual(works.map((w) => w.outcome), ["replied", "no_reply"]);
  assert.deepEqual(messages.filter((m) => m.type === "work_summary").map((m) => m.outcome), ["replied", "no_reply"]);
  // 第二次工作没有回复，摘要放在下一句话之前；第三句话之后只有正文、没有工具调用也没有经回复工具说话，不算一次工作，不出摘要。
  assert.deepEqual(expected.messages.map((m: any) => m.type), ["system_note", "user_message", "work_summary", "assistant_reply", "user_message", "work_summary",
    "user_message", "assistant_reply"]);
});
