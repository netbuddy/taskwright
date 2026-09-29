/**
 * 问题条目标为已解决要用户在卡片上点过头：起真的后端进程与真的 pi，模型换成进程内的假端点。
 * 流程：助手保存一个用例与一条牵涉它的问题条目（未解决）；用户打字说「这个问题解决了」，助手不问就把问题改为已解决，被拒，
 * 拒绝写明用户还没有在卡片上点「已解决」并指引发卡片；助手发了「这个问题是否已解决」的卡片（点名这条问题条目），
 * 用户在卡片上点「已解决」（与页面一样经发话接口，origin 为 card_choice），助手再改，状态变为已解决。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { captureConsole, tempDir } from "./helpers.ts";
import { type Dict, MATERIAL, NO_PI, reply, withStack } from "./consent_stack.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: MATERIAL };
const RESOLVE = { operations: [{ op: "update", item: "TBD-001", base_revision: 1, fields: { 状态: "已解决", 处理结果: "用户确认：借书前不检查逾期。" } }] };
const CARD = { kind: "choose", text: "TBD-001 这个问题是否已解决？", items: [{ item_id: "TBD-001", revision_no: 1 }],
  options: [{ key: "a", text: "已解决" }, { key: "b", text: "还没解决，继续改" }, { key: "c", text: "先不管，保留" }] };
const SCRIPT = {
  sequence: [
    { tool_calls: [{ id: "call-save", name: "save_revision", arguments: { operations: [
      { op: "add", collection: "功能用例", sources: [SOURCE],
        fields: { 用例名称: "借书", 用例功能: "读者借书。", 参与者: ["读者"], 基本流程: ["读者在自助机上刷借书证", "系统记下借阅"] } },
      { op: "add", collection: "问题", sources: [SOURCE],
        fields: { 事项: "借书前要不要检查逾期未还的书？", 种类: "待澄清", 状态: "未解决", 关联条目: ["UC-001"] } },
    ] } }] },
    reply("整理好了一个用例，还有一个问题要问你。", "call-done-1"),
    { tool_calls: [{ id: "call-resolve-early", name: "save_revision", arguments: RESOLVE }] },
    reply("我照你的话记下了。", "call-card", CARD),
    { tool_calls: [{ id: "call-resolve", name: "save_revision", arguments: RESOLVE }] },
    reply("TBD-001 已标为已解决。", "call-done-2"),
  ],
};

test("助手不问就把问题标为已解决被拒；发卡片、用户点「已解决」之后再改，成功", { skip: NO_PI, timeout: 120000 }, () =>
  withStack(tmp, "problem", SCRIPT, async ({ db, send, entryOfCall }) => {
    await send({ text: "把材料整理成需求规格说明。", client_id: "c-1" });
    assert.equal(db("SELECT fields FROM item_version WHERE item_id = 'TBD-001'").length, 1);

    await send({ text: "借书前不检查逾期，这个问题解决了。", client_id: "c-2" });
    const early = db("SELECT call_id, fact, guidance FROM tool_rejection WHERE tool_name = 'save_revision'");
    assert.deepEqual(early.map((r: Dict) => r.call_id), ["call-resolve-early"], "用户打字说解决了不算，助手不问就改被拒");
    assert.match(early[0].fact, /助手想把 TBD-001 的状态改为「已解决」，但用户还没有在问 TBD-001 是否已解决的卡片上点「已解决」/);
    assert.match(early[0].guidance, /在 items 里点名 TBD-001，三个选项是「已解决」「还没解决，继续改」「先不管，保留」/);
    assert.ok(!/执行者/.test(early[0].fact + early[0].guidance));
    const status = () => JSON.parse(db("SELECT fields FROM item_version WHERE item_id = 'TBD-001' ORDER BY revision_no DESC LIMIT 1")[0].fields).状态;
    assert.equal(status(), "未解决");

    await send({ text: "我选：已解决", client_id: "c-3", origin: "card_choice", card: { reply_message_id: entryOfCall("call-card"), kind: "choose", choice: "a" } });
    assert.deepEqual(db("SELECT call_id FROM tool_rejection WHERE tool_name = 'save_revision'").map((r: Dict) => r.call_id), ["call-resolve-early"]);
    assert.equal(status(), "已解决");
    assert.deepEqual(db("SELECT call_id FROM revision ORDER BY revision_no").map((r: Dict) => r.call_id), ["call-save", "call-resolve"]);
  }));
