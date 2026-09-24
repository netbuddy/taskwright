/** 说话类工具的公共骨架：读最后一条助手消息、单独调用的核对、合格时的返回形状。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { lastAssistantTurn, requireAlone, spoken } from "../src/lib/speak.ts";

test("最后一条助手消息的条目编号与这一轮的工具调用", () => {
  const branch = [
    { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "read" }] } },
    { id: "u1", type: "message", message: { role: "user", content: "x" } },
    { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "嗯" }, { type: "toolCall", id: "c1", name: "look" }] } },
    { id: "r1", type: "message", message: { role: "toolResult", content: [] } },
  ];
  assert.deepEqual(lastAssistantTurn(branch), { entryId: "a2", calls: [{ id: "c1", name: "look" }] });
  assert.deepEqual(lastAssistantTurn([]), { entryId: null, calls: [] });
});

test("单独调用：同一轮混入别的调用就拒绝，拒绝理由用传进来的叫法", () => {
  assert.doesNotThrow(() => requireAlone("回应", "respond", "c1", [{ id: "c1", name: "respond" }]));
  assert.throws(() => requireAlone("回应", "respond", "c1", [{ id: "c0", name: "look" }, { id: "c1", name: "respond" }]),
    /回应必须单独调用，不能与其他工具同一轮。这一轮里除了回应还调用了：look。.*单独调用 respond。这次回应没有送达。/);
});

test("合格时的返回带 terminate", () => {
  assert.deepEqual(spoken("好", { a: 1 }), { content: [{ type: "text", text: "好" }], details: { a: 1 }, terminate: true });
});
