/**
 * 活动正文分段：声明里的 segments 与正文里的分段标记要对上；拼系统提示只放常驻段；别的段由保存修订、回复做成时附在结果后面，
 * 一条会话只附一次，压缩之后不在上下文里了就再附。
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DefinitionHeadError, parseActivityDef, splitSegments } from "../src/lib/activity_def.ts";
import { SEGMENT_MARK_PATTERN, segmentAttached, segmentMark, withSegment } from "../src/lib/activity_segments.ts";
import { activitySegmentText, composeContext } from "../src/lib/context_assemble.ts";
import { fillText } from "../src/lib/texts.ts";
import { SRS_SKILL_DIR } from "./helpers.ts";

const HEAD = ["name: 核读材料", "mode: batch", "purpose: 通读材料。", "reads: materials, knowledge", "writes: description", "writes_allowed: page, problem",
  "requires: has_materials", "example: 一句例子。", "template: reading", "stage: reading"];
const file = (head: readonly string[], body: string) => `---\n${head.join("\n")}\n---\n\n${body}`;
const BODY = "## 常驻\n\n一直要守的。\n\n<!-- segment: after_save -->\n\n保存之后的。\n\n<!-- segment: after_reply -->\n回复之后的。\n";

test("分段：第一个标记之前是常驻段，标记之后各归各的时机；声明里写的时机与正文里的标记要一一对上", () => {
  assert.deepEqual(splitSegments(BODY), { always: "## 常驻\n\n一直要守的。", segments: { after_save: "保存之后的。", after_reply: "回复之后的。" }, marks: ["after_save", "after_reply"] });
  assert.deepEqual(splitSegments("没有标记。\n"), { always: "没有标记。", segments: {}, marks: [] });
  assert.deepEqual(parseActivityDef(file([...HEAD, "segments: after_save, after_reply"], BODY), "reading", "reading.md").segments, ["after_save", "after_reply"]);
  assert.deepEqual(parseActivityDef(file(HEAD, "没有标记。\n"), "reading", "reading.md").segments, [], "不写 segments 的照旧整段常驻");
  const bad: [string[], string, RegExp][] = [
    [HEAD, BODY, /分段标记「after_save」，声明的「segments」里没有它/],
    [[...HEAD, "segments: after_save"], BODY, /分段标记「after_reply」，声明的「segments」里没有它/],
    [[...HEAD, "segments: after_save, after_reply"], "常驻。\n<!-- segment: after_save -->\n一段。\n", /写了「after_reply」，正文里没有这一段的标记/],
    [[...HEAD, "segments: after_save"], "常驻。\n<!-- segment: after_save -->\n一段。\n<!-- segment: after_save -->\n又一段。\n", /「after_save」出现了两次/],
    [[...HEAD, "segments: after_save"], "常驻。\n<!-- segment: after_save -->\n\n", /「after_save」这一段是空的/],
    [[...HEAD, "segments: after_read"], BODY, /「segments」写了「after_read」，只能是 after_save、after_reply 里的/],
  ];
  for (const [head, body, message] of bad) assert.throws(() => parseActivityDef(file(head, body), "reading", "reading.md"), (error: unknown) => error instanceof DefinitionHeadError && message.test(error.message));
});

const SKILLS = [{ name: "requirements-engineering", filePath: join(SRS_SKILL_DIR, "SKILL.md") }];
const WORKSPACE = join(SRS_SKILL_DIR, "..", "..", "..");

test("需求工程的核读：系统提示里只有常驻段；保存后段与回复后段按时机取得到，别的活动与空闲没有", () => {
  const input = { stage: "reading" as const, inFlow: true, workspaceDir: WORKSPACE, skills: SKILLS, tail: "" };
  const prompt = composeContext(input).text;
  const afterSave = activitySegmentText(input, "after_save")!, afterReply = activitySegmentText(input, "after_reply")!;
  assert.ok(prompt.includes("**一直要守的三条。**") && prompt.includes("## 这一步怎样收尾"));
  assert.ok(afterSave.startsWith("## 盘点、草稿与提问\n") && afterSave.includes("**第三步：提问。**"));
  assert.ok(afterReply.startsWith("## 答后、收尾与之后\n") && afterReply.includes("**总体观察。**"));
  assert.ok(!prompt.includes("**第一步：盘点。**") && !prompt.includes("**第四步：答后。**") && !prompt.includes("<!-- segment:"));
  assert.equal(activitySegmentText({ ...input, inFlow: false }, "after_save"), afterSave, "单项活动里同样附，这两段没有收尾一节可去");
  assert.equal(activitySegmentText({ ...input, stage: "clarifying" }, "after_save"), null);
  assert.equal(activitySegmentText({ ...input, stage: "idle" }, "after_reply"), null);
});

test("附上：这条会话第一次做成时附，附过就不再附；压缩之后不在上下文里了再附一次；取段出错时照旧", () => {
  const result = (id: string, text: string) => ({ id, type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } });
  let calls = 0;
  const segment = () => { calls += 1; return "保存之后的。"; };
  const first = withSegment("已保存为修订 1。", "after_save", [], segment);
  assert.equal(first, `已保存为修订 1。\n\n${segmentMark("after_save")}\n${fillText("result.activity_segment")}\n\n保存之后的。`);
  const [own] = first.split(SEGMENT_MARK_PATTERN);
  assert.equal(own, "已保存为修订 1。", "观测台按分段记号把工具本身的结果分出来");
  const branch = [result("r1", first)];
  assert.equal(segmentAttached(branch, "after_save"), true);
  assert.equal(segmentAttached(branch, "after_reply"), false);
  assert.equal(withSegment("已保存为修订 2。", "after_save", branch, segment), "已保存为修订 2。");
  assert.equal(calls, 1, "附过了不再去读文件");
  // 压缩：留下的第一条在附过的那条之后，附过的那条不在上下文里了。
  const compacted = [...branch, result("r2", "已保存为修订 2。"), { id: "c1", type: "compaction", firstKeptEntryId: "r2" }];
  assert.equal(segmentAttached(compacted, "after_save"), false);
  // 留下的那一截里有附过的那条：仍算附过。
  assert.equal(segmentAttached([...branch, { id: "c1", type: "compaction", firstKeptEntryId: "r1" }], "after_save"), true);
  assert.equal(withSegment("已保存。", "after_save", compacted, () => { throw new Error("文件改坏了"); }), "已保存。");
  assert.equal(withSegment("已保存。", "after_save", [], () => null), "已保存。");
});
