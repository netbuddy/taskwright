// 一次运行的看门狗与运行状态（src/run_watch.ts）：四条中止线、一条提示线，与推给页面的运行状态帧。
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, RunWatch, limitsOf, reasonText } from "../src/run_watch.ts";

const delta = (text: string, type = "toolcall_delta") => ({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, delta: text } });
const toolStart = (name: string) => ({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, toolName: name } });

test("空白：连续只含空白的增量到 200 个中止；中间有字就从头数；新的一轮也从头数", () => {
  const watch = new RunWatch();
  watch.feed({ type: "agent_start" }, 0);
  for (let i = 0; i < 199; i++) assert.equal(watch.feed(delta(" \n"), 1), null);
  assert.equal(watch.feed(delta("{\"operations\":"), 1), null);
  for (let i = 0; i < 199; i++) assert.equal(watch.feed(delta(" "), 2), null);
  assert.deepEqual(watch.feed(delta("\n", "text_delta"), 2), { code: "blank_output", run: 200, chars: 200 });
  watch.feed({ type: "turn_start" }, 3);
  assert.equal(watch.feed(delta(" "), 3), null);
  // 很长的空白增量：累计到 2000 字也中止。
  const blank = " ".repeat(500);
  assert.deepEqual([1, 2, 3].map(() => watch.feed(delta(blank, "thinking_delta"), 4)), [null, null, null]);
  assert.equal(watch.feed(delta(blank, "thinking_delta"), 4)?.code, "blank_output");
});

test("工具参数：单个工具参数到 48 KB 中止；换一个工具调用从头数", () => {
  const watch = new RunWatch();
  watch.feed({ type: "agent_start" }, 0);
  watch.feed(toolStart("save_revision"), 0);
  const chunk = "文".repeat(1024); // 一个汉字三字节：一块 3 KB
  for (let i = 0; i < 15; i++) assert.equal(watch.feed(delta(chunk), 1), null);
  watch.feed(toolStart("reply"), 1);
  for (let i = 0; i < 15; i++) assert.equal(watch.feed(delta(chunk), 1), null);
  assert.deepEqual(watch.feed(delta(chunk), 1), { code: "tool_args_too_large", bytes: 48 * 1024 });
});

test("时长：等模型或模型输出时 90 秒没有有效增量中止，45 秒提示可能卡住；执行工具时不算；一次模型调用超过 8 分钟中止", () => {
  const watch = new RunWatch();
  watch.feed({ type: "agent_start" }, 0);
  assert.equal(watch.status(44_000).stalled, false);
  assert.equal(watch.status(45_000).stalled, true);
  assert.equal(watch.clock(89_000), null);
  assert.deepEqual(watch.clock(90_000), { code: "no_progress", seconds: 90 });
  // 执行工具时不算没有新内容。
  watch.feed({ type: "tool_execution_start", toolName: "get_item" }, 0);
  assert.equal(watch.clock(200_000), null);
  assert.equal(watch.status(200_000).idle_seconds, null);
  // 一直有有效增量，但一次调用超过 8 分钟。
  watch.feed({ type: "turn_start" }, 0);
  for (let t = 0; t < 480_000; t += 60_000) assert.equal(watch.feed(delta("字", "text_delta"), t), null);
  assert.deepEqual(watch.clock(480_000), { code: "call_too_long", seconds: 480 });
});

test("运行状态帧：阶段、工具名、已运行秒数、收到的字数、工具参数字数；空闲时没有秒数", () => {
  const watch = new RunWatch();
  assert.deepEqual(watch.status(0), { phase: "idle", tool: null, run_seconds: null, received_chars: 0, tool_args_chars: 0, idle_seconds: null, stalled: false });
  watch.feed({ type: "agent_start" }, 0);
  watch.feed(delta("想一想", "thinking_delta"), 1000);
  watch.feed(toolStart("save_revision"), 2000);
  watch.feed(delta("{\"operations\""), 3000);
  assert.deepEqual(watch.status(5000), { phase: "tool_args", tool: "save_revision", run_seconds: 5, received_chars: 16, tool_args_chars: 13, idle_seconds: 2, stalled: false });
  watch.feed({ type: "tool_execution_start", toolName: "save_revision" }, 6000);
  assert.equal(watch.status(7000).phase, "tool");
  watch.feed({ type: "agent_settled" }, 8000);
  assert.equal(watch.status(9000).run_seconds, null);
});

test("阈值取启动配置的「看门狗」一段：写了正数的用，别的用默认；原因写成给人看的一句", () => {
  assert.deepEqual(limitsOf({ blank_run: 50, no_progress_seconds: -1, call_seconds: "x" }), { ...DEFAULT_LIMITS, blank_run: 50 });
  assert.deepEqual(limitsOf(undefined), DEFAULT_LIMITS);
  assert.equal(reasonText({ code: "blank_output", run: 200, chars: 400 }), "连续输出了 200 段空白");
  assert.equal(reasonText({ code: "tool_args_too_large", bytes: 49_152 }), "工具参数超过 48 KB");
  assert.equal(reasonText({ code: "no_progress", seconds: 90 }), "90 秒没有新内容");
  assert.equal(reasonText({ code: "call_too_long", seconds: 480 }), "一次模型调用超过 8 分钟");
});
