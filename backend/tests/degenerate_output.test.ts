// 模型退化输出的识别（src/degenerate_output.ts）：流式输出里一连串只含空白的增量达到上限就判为退化，执行器据此中止这一次运行。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHARS_LIMIT, DegenerateWatch, RUN_LIMIT } from "../src/degenerate_output.ts";

const delta = (text: string, type = "toolcall_delta") => ({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, delta: text } });

test("连续只含空白的工具参数增量到了上限判为退化；中间夹一个有字的增量就从头数；新的一条消息也从头数；别的事件不影响计数", () => {
  const watch = new DegenerateWatch();
  for (let i = 0; i < RUN_LIMIT - 1; i++) assert.equal(watch.feed(delta(" \n")), false);
  assert.equal(watch.feed(delta("{\"operations\":")), false, "有字的增量从头数");
  for (let i = 0; i < RUN_LIMIT - 1; i++) assert.equal(watch.feed(delta(" ")), false);
  assert.equal(watch.feed({ type: "tool_execution_start" }), false, "别的事件不影响计数");
  assert.equal(watch.feed(delta("\n", "text_delta")), true, "文本增量同样算，到 RUN_LIMIT 个判为退化");
  assert.equal(watch.feed({ type: "turn_end" }), true, "判出之后一直是真，直到从头数");
  assert.equal(watch.feed({ type: "message_start" }), false);
  // 空白很长的增量：累计到 CHARS_LIMIT 个字也判为退化。
  const long = " ".repeat(CHARS_LIMIT / 4);
  assert.deepEqual([1, 2, 3, 4].map(() => watch.feed(delta(long, "thinking_delta"))), [false, false, false, true]);
  // 空串增量与开头、结尾这类事件不算。
  watch.reset();
  assert.equal(watch.feed(delta("")), false);
  assert.equal(watch.feed({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } }), false);
});
