/**
 * 「导出为用户画像」的草稿（src/persona_draft.ts 与调试接口）：用户自己打的每一句话一条事实；卡片上的选择写成「问……答……」；
 * 系统替用户发的固定句、两个开头按钮发的两句、进入或留在某个阶段的卡片选择不收；形状照模拟器的画像文件，关键词等留空。
 * 接口只在调试模式可用，遍历任务的全部会话。
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEBUG_ONLY_TEXT } from "../src/debug_prompt.ts";
import { dispatch } from "../src/http.ts";
import { factsOfSession, personaDraft } from "../src/persona_draft.ts";
import { Service } from "../src/service.ts";
import { ROOT, captureConsole, sendAndWaitTurn, tempDir } from "./helpers.ts";
import { type Dict, NO_PI, reply, withStack } from "./consent_stack.ts";

captureConsole();
process.env.PI_OFFLINE = "1";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const said = (text: string, over: Dict = {}) => ({ type: "user_message", message_id: `u-${text.length}`, text, origin: "typed", annotation: null, ...over });
const card = (id: string, text: string) => ({ type: "assistant_reply", message_id: id, text: "成文的话", act: { kind: "choose", text, options: [] } });
const click = (replyId: string, key: string, option: string) => said(`我选：${option}`, { origin: "card_choice", annotation: { reply_message_id: replyId, option_key: key, option_text: option } });

test("一条会话里的事实：打的字照原话；卡片选择写成问与答；固定句与阶段卡片的选择不收", () => {
  const facts = factsOfSession([
    said("请通读材料，把材料里已经写明的概念、角色、流程与目标各立一页主题。"),
    said("  预约的书到馆后留三天。  "),
    card("a-1", "逾期未还的读者能不能续借？"),
    click("a-1", "b", "不允许"),
    card("a-2", "材料读完了。现在进入澄清吗？"),
    click("a-2", "enter_clarify", "进入澄清"),
    card("a-3", "现在开始写条目吗？"),
    click("a-3", "continue_consolidate", "继续本阶段"),
    said("我已经看过了：UC-001（修订 2）。请接着往下做。", { origin: "ui_request" }),
    { type: "system_note", message_id: "n-1", text: "请用 reply 工具把要对用户说的话发出来" },
    said("请逐项澄清：一次只问一件事，先给出候选再问。"),
    said("   "),
    click("a-9", "x", "就这样"),
  ]);
  assert.deepEqual(facts.map((one) => one.事实), ["预约的书到馆后留三天。", "问：逾期未还的读者能不能续借？　答：不允许", "就这样"]);
  for (const one of facts) assert.deepEqual([one.关键词, one.必须同时出现, one.问到的迹象], [[], [], []]);
});

test("整份草稿的形状照模拟器的画像文件：键与次序相同，材料写文件名，人设与目标留空，说明里写出自哪个任务与条数", () => {
  const sample = JSON.parse(readFileSync(join(ROOT, "sim", "personas", "library-short.json"), "utf-8"));
  const draft = personaDraft({ task_id: "TASK-20261010-AB12", task_name: "图书馆借还" }, ["inputs/requirements.md", "inputs/规则.docx"],
    [[said("一次最多借五本。")], [said("逾期每天罚五毛。"), said("寒暑假顺延。")]]);
  assert.deepEqual(Object.keys(draft), Object.keys(sample));
  assert.deepEqual(Object.keys(draft.隐藏事实[0]), Object.keys(sample.隐藏事实[0]));
  assert.deepEqual([draft.名字, draft.人设, draft.目标, draft.答不上的说法, draft.材料说明, draft.接受底线], ["", "", "", [], "", []]);
  assert.deepEqual([draft.材料, draft.熟悉的材料], [["requirements.md", "规则.docx"], ["requirements.md", "规则.docx"]]);
  assert.deepEqual(draft.隐藏事实.map((one) => one.事实), ["一次最多借五本。", "逾期每天罚五毛。", "寒暑假顺延。"]);
  assert.match(draft.说明, /^由任务「图书馆借还」（TASK-20261010-AB12）导出的草稿：隐藏事实是这个任务里用户说过的 3 句话与卡片上的选择/);
});

test("接口只在调试模式可用", async () => {
  const service = new Service(join(tmp, "n1", "tasks"), join(tmp, "n1", "runs"), {});
  try {
    const answer = await dispatch(service, { method: "GET", path: "/api/v1/tasks/TASK-X/debug/persona-draft", query: {}, headers: {}, body: Buffer.alloc(0), remote: "127.0.0.1" }) as Dict;
    assert.equal(answer.status, 404);
    assert.equal(JSON.parse(answer.body.toString()).error.message, DEBUG_ONLY_TEXT);
  } finally {
    await service.close();
  }
});

const CHOICE = { kind: "choose", text: "逾期未还的读者续借，怎样处理？", options: [{ key: "a", text: "允许" }, { key: "b", text: "不允许" }] };
const SCRIPT = { sequence: [reply("记下了。逾期未还的读者续借，怎样处理？", "call-card", CHOICE), reply("好的，不允许续借。", "call-2"), reply("第二条会话里的回答。", "call-3")] };

test("真的跑一遍：两条会话里用户打的字与卡片上的选择都进了草稿，按会话的先后；文件名带任务编号", { skip: NO_PI, timeout: 180000 }, async () => {
  await withStack(tmp, "persona", SCRIPT, async ({ call, taskId, port, send, entryOfCall }) => {
    await send({ text: "预约的书到馆后留三天。", client_id: "c-1" });
    await send({ text: "我选：不允许", client_id: "c-2", origin: "card_choice", card: { reply_message_id: entryOfCall("call-card"), kind: "choose", choice: "b" } });
    const second: string = (await call("POST", `/api/v1/tasks/${taskId}/sessions`)).body.session_id;
    await sendAndWaitTurn(port, taskId, second, async () => {
      assert.equal((await call("POST", `/api/v1/tasks/${taskId}/messages?session=${second}`, { text: "寒暑假借的书顺延到开学。", client_id: "c-3" })).status, 200);
    });
    const answer = (await call("GET", `/api/v1/tasks/${taskId}/debug/persona-draft`)).body;
    assert.deepEqual([answer.file_name, answer.sessions, answer.facts, answer.skipped], [`persona-${taskId}.json`, 2, 3, []]);
    assert.deepEqual(answer.persona.隐藏事实.map((one: Dict) => one.事实),
      ["预约的书到馆后留三天。", "问：逾期未还的读者续借，怎样处理？　答：不允许", "寒暑假借的书顺延到开学。"]);
    assert.deepEqual(answer.persona.材料, ["材料.md"]);
    assert.match(answer.persona.说明, new RegExp(`（${taskId}）导出的草稿`));
  }, { seed: false, args: ["--debug"], env: { TASKWRIGHT_SETTINGS_FILE: join(tmp, "persona-settings.json") } });
});
