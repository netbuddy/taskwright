/**
 * 「继续本阶段」留在会话里的那条界面操作通知怎样进对话区的消息：种类是 continue_stage，另带卡片在哪条回复上与卡片提议进入的阶段；
 * 它不是用户的话，不结束这一段，也不让卡片后面多出一句「我选：……」。别的界面操作通知不带这两项。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTINUE_STAGE, USER_EDIT, baseMessages, continueStageFields } from "../src/conversation.ts";

const CARD = { kind: "choose", text: "材料核读完了，进入澄清吗？", items: [{ item_id: "OA-001", revision_no: 1 }],
  options: [{ key: "enter_clarify", text: "进入澄清" }, { key: "continue_reading", text: "继续本阶段" }] };
const NOTE = "界面操作（不是用户打的字）：用户在提议「进入澄清」的卡片上选了「继续本阶段」，没有进入澄清。这个提议仍然开着，用户要进入时会自己点，不用再发同一张卡片。";
const DETAILS = { op_id: "ui-op-7", kind: "continue_stage", event_seqs: [], results: [], revision_no: null, undoable: false,
  reply_entry: "a-1", option_key: "continue_reading", stage: "clarifying" };

test("取值的函数：只有继续本阶段的通知带这两项；阶段写得不对时不带阶段", () => {
  assert.equal(CONTINUE_STAGE, "continue_stage");
  assert.deepEqual(continueStageFields(DETAILS), { reply_message_id: "a-1", stage: "clarifying" });
  assert.deepEqual(continueStageFields({ ...DETAILS, stage: "别的" }), { reply_message_id: "a-1" });
  assert.deepEqual(continueStageFields({ kind: "stop_run", reply_entry: "a-1" }), {});
  assert.deepEqual(continueStageFields({ kind: "continue_stage" }), {});
});

test("对话记录：卡片后面是一条界面操作通知，不是用户的话；之后用户自己打的字照常是一句话", () => {
  const entries = [
    { id: "u-1", parentId: null, type: "message", timestamp: "2026-01-01T01:00:00.000Z", message: { role: "user", content: "读一下材料" } },
    { id: "a-1", parentId: "u-1", type: "message", timestamp: "2026-01-01T01:00:05.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "reply", arguments: { informs: [], act: CARD, text: "进入澄清吗？" } }] } },
    { id: "t-1", parentId: "a-1", type: "message", timestamp: "2026-01-01T01:00:06.000Z",
      message: { role: "toolResult", toolCallId: "call-1", toolName: "reply", isError: false, content: [{ type: "text", text: "回复已送达" }], details: { delivered: true } } },
    { id: "c-1", parentId: "t-1", type: "custom_message", timestamp: "2026-01-01T01:01:00.000Z", customType: USER_EDIT, content: NOTE, display: true, details: DETAILS },
    { id: "u-2", parentId: "c-1", type: "message", timestamp: "2026-01-01T01:02:00.000Z", message: { role: "user", content: "「借书」那一节漏了一句。" } },
  ];
  const out = baseMessages(entries, "sess-1");
  assert.deepEqual(out.map((m) => [m.type, m.message_id]), [["user_message", "u-1"], ["assistant_reply", "a-1"], ["ui_action_noted", "c-1"], ["user_message", "u-2"]]);
  const note = out[2];
  assert.deepEqual([note.kind, note.reply_message_id, note.stage, note.text, note.undoable, note.event_seq, note.op_id],
    ["continue_stage", "a-1", "clarifying", NOTE, false, null, "ui-op-7"]);
  assert.deepEqual([out[3].origin, out[3].text, out[3].annotation], ["typed", "「借书」那一节漏了一句。", null]);
  // 别的界面操作通知没有这两项。
  const other = baseMessages([entries[0], { id: "c-9", parentId: "u-1", type: "custom_message", timestamp: "2026-01-01T01:01:00.000Z", customType: USER_EDIT,
    content: "界面操作（不是用户打的字）：用户把 UC-001 标为已读。", display: true, details: { op_id: "ui-op-1", kind: "mark_viewed", event_seqs: [3], undoable: false } }], "sess-1");
  assert.equal("reply_message_id" in other[1], false);
  assert.equal("stage" in other[1], false);
});
