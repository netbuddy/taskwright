/**
 * 从核读材料走到编写文档，把三件事连着走一遍（真的后端进程与真的 pi，模型换成进程内的假端点）：
 *
 * 1. 提问与了结就地处理：整理建模时助手遇到一个分叉没有定，记一条阻断下游的问题、在那一页上标「待定」，不退回，照常发「开始写条目」的卡片；
 *    写条目的两盏灯（没有未了结的阻断下游的问题、没有待定标记）这时不通过。用户答了之后助手把答案写进那一页、去掉标记，
 *    发「是否已解决」的卡片，用户点了，助手把问题标为已解决并记「落实到」；两盏灯通过。全程没有一次由助手记下的阶段移动。
 * 2. 回退由助手提议、用户点：写条目阶段助手发提议退回整理建模的卡片；用户先选「留在本段」（只留一条通知，助手不运行，提议仍然开着），
 *    再点「退回整理建模」，库里记成用户的移动，原因里带着助手写的那句话。
 * 3. 编写文档：用户点「进入编写文档」，助手给有内容的三章各补一页导语，发请过目的卡片；用户点「看过了，生成文档」
 *    （页面发的两个界面操作：continue_stage 与 mark_viewed），助手不运行，那几页记为看过，提议结束；生成的文档里有这三章的导语。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { captureConsole, movesSql, tempDir } from "./helpers.ts";
import { type Dict, MATERIAL, NO_PI, TOPIC_CALL, reply, sleep, withStack } from "./consent_stack.ts";

captureConsole();
process.env.PI_OFFLINE = "1";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const save = (id: string, operations: unknown[]) => ({ tool_calls: [{ id, name: "save_revision", arguments: { operations } }] });
const choose = (text: string, options: [string, string][], items: [string, number][] = []) =>
  ({ kind: "choose", text, items: items.map(([item_id, revision_no]) => ({ item_id, revision_no })), options: options.map(([key, text]) => ({ key, text })) });

const ANSWER = "借书证丢了要先补办，补办之前不能借书。";
const MARK = "待定：借书证丢失的读者能不能借书";
const RULE = "借书证丢失的读者补办之前不能借书。";
const BACK_REASON = "写用例时发现「自助借书」这一页与材料对不上，前面整理的结果要重来。";

const CLARIFY_CARD = choose("材料读完了。现在进入澄清吗？", [["enter_clarify", "进入澄清"], ["continue_reading", "继续本阶段"]], [["OA-001", 1]]);
const MODEL_CARD = choose("要问的都问到了。现在进入整理建模吗？", [["enter_consolidate", "进入整理建模"], ["continue_clarify", "继续本阶段"]]);
// 修订的先后：1 主题页，2 问题与待定标记，3 把答案写进那一页，4 问题标为已解决，5 用例，6 三页导语。
const START_BLOCKED = choose("主题页理好了。还有 1 个阻断下游的问题没有答：借书证丢失的读者能不能借书？答了之后再开始写条目。",
  [["start_items", "开始写条目"], ["continue_consolidate", "继续本阶段"]], [["OA-001", 2]]);
const SOLVED_CARD = choose("TBD-001 这个问题是否已解决？", [["a", "已解决"], ["b", "还没解决，继续改"], ["c", "先不管，保留"]], [["TBD-001", 2]]);
const START_CARD = choose("问题都了结了。这一页你看过之后，现在开始写条目吗？", [["start_items", "开始写条目"], ["continue_consolidate", "继续本阶段"]], [["OA-001", 3]]);
const BACK_CARD = choose(`${BACK_REASON}退回整理建模吗？`, [["back_to_consolidate", "退回整理建模"], ["stay_in_stage", "留在本段"]]);
const REVIEW_CARD = choose("用例写好了。现在进入评审确认吗？", [["enter_review", "进入评审确认"], ["continue_writing", "继续本阶段"]], [["UC-001", 5]]);
const DOCUMENT_CARD = choose("条目你都看过了。进入编写文档，把各章的导语补上吗？", [["enter_document", "进入编写文档"], ["continue_review", "继续本阶段"]]);
const READ_CARD = choose("补写了三章的导语，请过目。看过之后在条目区按「生成文档」。",
  [["document_reviewed", "看过了，生成文档"], ["document_revise", "需要修改"]], [["OA-002", 6], ["OA-003", 6], ["OA-004", 6]]);

const INTROS: [string, string][] = [
  ["业务流程", "这一章讲读者怎样在自助机上借书。"],
  ["业务规则", "这一章汇总各节里已经定下的规则，现在只有借书证丢失时的一条。"],
  ["决策记录与待澄清事项", "这一章按时间列出问过的问题与它们的去向。"],
];
const intro = ([chapter, text]: [string, string]) => ({ op: "add", collection: "总体分析",
  sources: [{ kind: "助手补充", excerpt: "据 OA-001、TBD-001 与 UC-001 概括。" }], fields: { 标题: `${chapter}导语`, 导语所属章: chapter, 它是什么: text, 状态: "在用" } });

const SCRIPT = {
  sequence: [
    // 核读材料：立一页主题，发「进入澄清」的卡片。
    { tool_calls: [TOPIC_CALL] },
    reply("材料读完了，我立了一页主题。", "call-clarify", CLARIFY_CARD),
    // 澄清：发「进入整理建模」的卡片。
    reply("要问的都问到了。", "call-model", MODEL_CARD),
    // 整理建模：遇到一个分叉没有定——记一条阻断下游的问题，在那一页上标待定，不退回，照常提议开始写条目并把问题列出来。
    save("call-question", [
      { op: "add", collection: "问题", sources: [{ kind: "条目", locator: "OA-001", excerpt: MATERIAL }],
        fields: { 事项: "借书证丢失的读者能不能借书？", 种类: "待澄清", 是否阻断下游: "阻断下游", 建议的处理: "流程里「借书证无效」这个分叉画不出，用例的扩展流程也写不出。",
          状态: "未解决", 关联条目: ["OA-001"] } },
      { op: "update", item: "OA-001", base_revision: 1, fields: { 已经定下的: [MARK] },
        sources: [{ kind: "助手补充", excerpt: "这一条还没有定下来，见问题 TBD-001。", supports: [{ field: "已经定下的", index: 0 }] }] },
    ]),
    reply("主题页理好了，还有一个问题要你答。", "call-start-blocked", START_BLOCKED),
    // 用户答了：把答案写进那一页（去掉待定标记），问是否已解决。
    save("call-answer", [{ op: "update", item: "OA-001", base_revision: 2, fields: { 已经定下的: [RULE] },
      sources: [{ kind: "用户的话", excerpt: "补办之前不能借书", supports: [{ field: "已经定下的", index: 0 }] }] }]),
    reply("记进「自助借书」这一页了。", "call-solved", SOLVED_CARD),
    // 用户点了「已解决」：了结问题，记落实到哪里；再提议开始写条目。
    save("call-settle", [{ op: "update", item: "TBD-001", base_revision: 2, fields: { 状态: "已解决", 处理结果: "补办之前不能借书。", 落实到: "OA-001 已经定下的第 1 条" } }]),
    reply("TBD-001 已了结。", "call-start", START_CARD),
    // 写条目：提议退回整理建模。
    reply(BACK_REASON, "call-back", BACK_CARD),
    // 用户点了「退回整理建模」：再提议开始写条目。
    reply("那一页我重新核过了。", "call-start-again", START_CARD),
    // 写条目：写一个用例，提议进入评审确认。
    save("call-uc", [{ op: "add", collection: "功能用例", sources: [{ kind: "条目", locator: "OA-001", excerpt: MATERIAL }],
      fields: { 用例名称: "借书", 用例功能: "读者借书。", 参与者: ["读者"], 基本流程: ["读者在自助机上刷借书证", "系统记下借阅"] } }]),
    reply("写好了一个用例。", "call-review", REVIEW_CARD),
    // 评审确认：提议进入编写文档。
    reply("条目你都看过了。", "call-document", DOCUMENT_CARD),
    // 编写文档：给有内容的三章各补一页导语，请用户过目。
    save("call-intros", INTROS.map(intro)),
    reply("补写了业务流程、业务规则、决策记录与待澄清事项三章的导语。", "call-read", READ_CARD),
  ],
};

test("核读到编写文档：问题就地记下并了结、回退由用户在卡片上点、补写的导语过目后进文档", { skip: NO_PI, timeout: 420000 }, () =>
  withStack(tmp, "document-flow", SCRIPT, async ({ call, taskId, session, send, action, entryOfCall, requests, db }) => {
    const taskNow = async () => (await call("GET", `/api/v1/tasks/${taskId}`)).body as Dict;
    // 阶段、灯与提议是按会话算的：看的是这条会话（它属于夹具启动的那个需求分析的工作项）。
    const stageNow = async () => (await call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${session}`)).body.task.stage as Dict;
    const lamp = async (stage: string, key: string) => ((await stageNow()).lamps[stage] as Dict[]).find((one) => one.key === key)!;
    const fieldsOf = (itemId: string) => JSON.parse(db("SELECT fields FROM item_version WHERE item_id = ? ORDER BY revision_no DESC LIMIT 1", itemId)[0].fields) as Dict;
    // 启动需求分析的那一条（夹具记的，停在核读材料）不算在内。
    const moves = () => db(movesSql(["actor", "from_stage", "stage", "reason"])).slice(1);
    const rejected = () => db("SELECT tool_name, call_id, fact FROM tool_rejection");
    let n = 0;
    const click = (callId: string, key: string, text: string) => send({ text: `我选：${text}`, client_id: `click-${++n}`, origin: "card_choice",
      card: { reply_message_id: entryOfCall(callId), kind: "choose", choice: key } });
    const view = async (items: [string, number][]) => {
      const done = await action({ client_id: `view-${++n}`, kind: "mark_viewed", targets: items.map(([item_id, base_revision]) => ({ item_id, base_revision })), notify_executor: false });
      assert.equal(done.status, 200, JSON.stringify(done.body));
    };

    // ── 核读材料、澄清、整理建模 ──
    await send({ text: "读一下材料。", client_id: "c-1" });
    await view([["OA-001", 1]]);
    await click("call-clarify", "enter_clarify", "进入澄清");
    await click("call-model", "enter_consolidate", "进入整理建模");
    assert.deepEqual(rejected(), []);

    // 1. 一个分叉没有定：问题记下了、标了待定，任务还在整理建模，没有退回；助手照常提议开始写条目。
    assert.deepEqual([fieldsOf("TBD-001").是否阻断下游, fieldsOf("TBD-001").状态, fieldsOf("OA-001").已经定下的], ["阻断下游", "未解决", [MARK]]);
    const blocked = await stageNow();
    assert.deepEqual([blocked.current, blocked.proposal.kind, blocked.proposal.enter.key], ["modeling", "enter", "start_items"]);
    assert.deepEqual(moves().map((one: Dict) => [one.actor, one.from_stage, one.stage]), [["user", "reading", "clarifying"], ["user", "clarifying", "modeling"]]);
    // 写条目的两盏灯这时不通过，差的是这条问题与标着待定的那一页。
    const open = await lamp("writing", "no_blocking_questions"), marked = await lamp("writing", "no_pending_marks");
    assert.deepEqual([open.ok, open.items, marked.ok, marked.items], [false, ["TBD-001"], false, ["OA-001"]]);

    // 用户答了：答案写进那一页，标记去掉；助手问是否已解决，用户点了之后问题了结，记着落实到哪里。
    await send({ text: ANSWER, client_id: "c-answer" });
    assert.deepEqual([fieldsOf("OA-001").已经定下的, fieldsOf("TBD-001").状态], [[RULE], "未解决"]);
    assert.equal((await lamp("writing", "no_pending_marks")).ok, true);
    await click("call-solved", "a", "已解决");
    assert.deepEqual(rejected(), []);
    assert.deepEqual([fieldsOf("TBD-001").状态, fieldsOf("TBD-001").落实到], ["已解决", "OA-001 已经定下的第 1 条"]);
    assert.equal((await lamp("writing", "no_blocking_questions")).ok, true);
    assert.equal((await lamp("document", "document_no_blocking_questions")).ok, true);
    // 到这里阶段一次都没有因为这个问题移动过。
    assert.equal(moves().length, 2);

    // ── 写条目：回退卡片 ──
    await view([["OA-001", 3]]);
    await click("call-start", "start_items", "开始写条目");
    const back = (await stageNow()).proposal as Dict;
    const backEntry = entryOfCall("call-back");
    assert.deepEqual([back.kind, back.stage, back.enter, back.stay, back.reply_message_id],
      ["back", "modeling", { key: "back_to_consolidate", text: "退回整理建模" }, { key: "stay_in_stage", text: "留在本段" }, backEntry]);
    assert.equal((await stageNow()).current, "writing");
    // 2. 先选「留在本段」：只留一条通知，助手不运行，没有记移动，提议仍然开着。
    const asked = requests().length;
    const stayed = await action({ client_id: "stay-1", kind: "continue_stage", targets: [], fields: { reply_message_id: backEntry, option_key: "stay_in_stage" }, notify_executor: false });
    assert.equal(stayed.status, 200, JSON.stringify(stayed.body));
    await sleep(1500);
    assert.equal(requests().length, asked, "选「留在本段」不引出助手运行");
    assert.deepEqual([(await stageNow()).current, (await stageNow()).proposal.event_seq, moves().length], ["writing", back.event_seq, 3]);
    const stayNote = ((await call("GET", `/api/v1/tasks/${taskId}/conversation?session=${session}`)).body.messages as Dict[]).filter((m) => m.type === "ui_action_noted" && m.kind === "continue_stage").at(-1)!;
    assert.deepEqual([stayNote.reply_message_id, stayNote.option_key, stayNote.stage], [backEntry, "stay_in_stage", "modeling"]);
    assert.match(stayNote.text, /选了「留在本段」，没有退回整理建模/);
    // 再点「退回整理建模」：记成用户的移动，原因里带着助手写的那句话；提议结束。
    await click("call-back", "back_to_consolidate", "退回整理建模");
    const moved = moves().at(-1) as Dict;
    assert.deepEqual([moved.actor, moved.from_stage, moved.stage], ["user", "writing", "modeling"]);
    assert.match(moved.reason, /^用户在卡片上选了「退回整理建模」/);
    assert.ok(moved.reason.includes(BACK_REASON), moved.reason);
    assert.equal(moves().some((one: Dict) => one.actor !== "user"), false, "没有一次移动是助手记的");

    // ── 再进写条目，写用例；评审确认；进入编写文档 ──
    await click("call-start-again", "start_items", "开始写条目");
    assert.deepEqual(rejected(), []);
    await view([["UC-001", 5]]);
    await click("call-review", "enter_review", "进入评审确认");
    assert.deepEqual([(await stageNow()).current, (await stageNow()).proposal.enter.key], ["reviewing", "enter_document"]);
    await click("call-document", "enter_document", "进入编写文档");
    assert.deepEqual(rejected(), []);

    // 3. 编写文档：三页导语存下了（待核实），提议是请过目的那一种；有内容的章都有了导语。
    const reading = await stageNow();
    const readEntry = entryOfCall("call-read");
    assert.deepEqual([reading.current, reading.proposal.kind, reading.proposal.enter.key, reading.proposal.items.map((one: Dict) => one.item_id)],
      ["document", "review", "document_reviewed", ["OA-002", "OA-003", "OA-004"]]);
    assert.deepEqual(["OA-002", "OA-003", "OA-004"].map((id) => fieldsOf(id).导语所属章), INTROS.map(([chapter]) => chapter));
    assert.equal((await lamp("document", "chapters_have_intro")).ok, true);
    const before = (await taskNow()).items.filter((one: Dict) => one.item_id.startsWith("OA-00") && one.item_id !== "OA-001");
    assert.deepEqual(before.map((one: Dict) => [one.pending_verification, one.viewed]), [[true, false], [true, false], [true, false]]);
    // 「看过了，生成文档」：页面先发 continue_stage，再把卡片点名的页标为已读。助手不运行；那几页记为看过；提议结束。
    const quiet = requests().length;
    const noted = await action({ client_id: "read-1", kind: "continue_stage", targets: [], fields: { reply_message_id: readEntry, option_key: "document_reviewed" }, notify_executor: false });
    assert.equal(noted.status, 200, JSON.stringify(noted.body));
    await view([["OA-002", 6], ["OA-003", 6], ["OA-004", 6]]);
    await sleep(1500);
    assert.equal(requests().length, quiet, "点「看过了，生成文档」不引出助手运行");
    const after = await taskNow();
    const afterStage = await stageNow();
    assert.deepEqual([afterStage.current, afterStage.proposal], ["document", null]);
    assert.deepEqual(after.items.filter((one: Dict) => ["OA-002", "OA-003", "OA-004"].includes(one.item_id)).map((one: Dict) => one.viewed), [true, true, true]);
    const readNote = ((await call("GET", `/api/v1/tasks/${taskId}/conversation?session=${session}`)).body.messages as Dict[]).filter((m) => m.type === "ui_action_noted" && m.kind === "continue_stage").at(-1)!;
    assert.deepEqual([readNote.reply_message_id, readNote.option_key, readNote.stage], [readEntry, "document_reviewed", "document"]);
    assert.match(readNote.text, /选了「看过了，生成文档」：卡片点名的页已经记为看过/);
    assert.deepEqual(moves().map((one: Dict) => [one.from_stage, one.stage]),
      [["reading", "clarifying"], ["clarifying", "modeling"], ["modeling", "writing"], ["writing", "modeling"], ["modeling", "writing"], ["writing", "reviewing"], ["reviewing", "document"]]);

    // 生成文档：与页面同一个结构。三章的导语各在自己那一章的开头；规则在流程那一节的「适用规则」里与第 5 章的规则表里；
    // 用例在第 8 章，附录写它依据的是哪一节。
    const document = await call("POST", `/api/v1/tasks/${taskId}/documents/preview`, {});
    assert.equal(document.status, 200, JSON.stringify(document.body));
    const text: string = document.body.text;
    const chapter = (no: number, name: string, next: string) => text.slice(text.indexOf(`## ${no} ${name}`), text.indexOf(next));
    assert.match(chapter(3, "业务流程", "## 4 业务对象"), /^## 3 业务流程\n\n这一章讲读者怎样在自助机上借书。 ［修订 6 · 已确认（已读）］\n\n### 3\.1 自助借书 /);
    assert.match(chapter(5, "业务规则", "## 6 业务目标"), new RegExp(`^## 5 业务规则\\n\\n${INTROS[1][1]} ［修订 6 · 已确认（已读）］\\n\\n\\| 规则 \\| 出自 \\| 冲突 \\|\\n\\|---\\|---\\|---\\|\\n\\| ${RULE} \\| 3\\.1 自助借书 \\|`));
    assert.match(chapter(7, "决策记录与待澄清事项", "## 8 功能需求"), new RegExp(`^## 7 决策记录与待澄清事项\\n\\n${INTROS[2][1]} `));
    assert.ok(chapter(3, "业务流程", "## 4 业务对象").includes(`**适用规则**\n\n1. ${RULE}`) && !text.includes("待定："));
    // 了结了的问题在那一节的待澄清事项里写着落实到哪里。
    assert.ok(chapter(3, "业务流程", "## 4 业务对象").includes("- 已了结：借书证丢失的读者能不能借书？（TBD-001）　落实到：OA-001 已经定下的第 1 条"));
    assert.match(text.slice(text.indexOf("## 8 功能需求")), /### UC-001 借书 /);
    assert.match(text.slice(text.indexOf("## 附录 追溯")), /\| UC-001 借书 \| 3\.1 自助借书 \| — \|/);
  }, { seed: false }));
