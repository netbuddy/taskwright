/**
 * 所属流程在后端的三处：整份数据的 stage.flow、库事件 stage_changed 的 flow、调试用的阶段记录流水里每条的 flow。
 * 现在只有一条流程，值恒为 initial（首次分析）；早先记下的移动事件里没有写它，推出去时补上。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import * as library from "../src/library.ts";
import { sqlRun, tempDir } from "./helpers.ts";
import { DEFINITION, build, page } from "./overall_stack.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const FLOW = page({ 标题: "预约取书", 标签: ["流程"], 例子: ["小王周六预约了一本书。"] });

test("整份数据、库事件与阶段记录流水都带所属流程；事件里没有写它的补首次分析", () => {
  const ws = build(tmp, "flow", DEFINITION, [[FLOW], { stage: "评审确认" }]);
  assert.equal(library.taskSnapshot(ws)[1]!.stage!.flow, "initial");
  const moves = library.libraryEvents(ws, 0)[0].filter(([name]) => name === "stage_changed").map(([, data]) => data);
  assert.deepEqual(moves.map((one) => [one.to, one.flow]), [["writing", "initial"], ["reviewing", "initial"]]);
  assert.deepEqual(library.stageDebugView(ws).records.map((one) => [one.to, one.flow]), [["writing", "initial"], ["reviewing", "initial"]]);
  // 早先的移动事件里没有 flow：推出去的事件与流水里补首次分析。
  sqlRun(ws, [["UPDATE event SET payload = json_remove(payload, '$.flow') WHERE name = 'STAGE_MOVED'"]]);
  assert.deepEqual(library.libraryEvents(ws, 0)[0].filter(([name]) => name === "stage_changed").map(([, data]) => data.flow), ["initial", "initial"]);
  assert.deepEqual(library.stageDebugView(ws).records.map((one) => one.flow), ["initial", "initial"]);
  assert.equal(library.taskSnapshot(ws)[1]!.stage!.flow, "initial");
});
