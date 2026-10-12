/**
 * 完成任务按工作阶段守门（lib/complete_task.ts 调 lib/stage.ts）：助手只有在评审确认阶段才能完成任务，先于完成条件核对。
 * 用户在页面上提交不看阶段；早先建的任务没有阶段。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { completeTask } from "../src/lib/complete_task.ts";
import { createTask } from "../src/lib/create_task.ts";
import { STAGES, STAGE_NAMES } from "../src/lib/stage.ts";
import { rejectionOf } from "../src/lib/tool_rejection.ts";
import { UserOpError, runUserOperation } from "../src/lib/user_ops.ts";
import { DEFINITION_PATH, callIn, demoDefinition, enterStage, makeWorkspace, overallDefinition, query } from "./helpers.ts";

function workspace(definition: unknown = overallDefinition()): string {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
/** 助手调用「完成任务」被拒时的两层文字。这里的任务里一个条目都没有，完成条件不满足，所以每个阶段都会被拒，看的是被哪一条拒。 */
function refusal(dir: string): { fact: string; guidance: string; message: string } {
  try {
    completeTask(callIn(dir));
  } catch (error) {
    const layers = rejectionOf(error)!;
    return { fact: layers.fact, guidance: layers.guidance, message: (error as Error).message };
  }
  assert.fail("应当被拒绝");
}

test("助手完成任务：评审确认之前的四个阶段被阶段拦下；到了评审确认阶段才轮到核对完成条件", () => {
  const dir = workspace();
  for (const stage of STAGES) {
    enterStage(dir, stage);
    const out = refusal(dir);
    if (stage === "reviewing") {
      assert.equal(out.fact.includes("完成任务要在评审确认阶段"), false);
      assert.match(out.fact, /^任务没有标为已完成。\n/, "过了阶段这一关，被拒是因为完成条件没满足");
      continue;
    }
    assert.equal(out.fact, `任务没有标为已完成：任务现在在${STAGE_NAMES[stage]}阶段，完成任务要在评审确认阶段。`);
    assert.equal(out.message, `${out.fact}\n${out.guidance}`);
    if (stage === "writing") assert.equal(out.guidance, "条目写完之后，要由用户在卡片上选「进入评审确认」进入评审确认，再完成任务。" +
      "请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 enter_review「进入评审确认」、continue_writing「继续本阶段」。");
    else assert.match(out.guidance, /^要先写条目、再由用户进入评审确认，才能完成任务。进入写条目要由用户在卡片上选「开始写条目」/);
  }
  assert.equal(query<{ status: string }>(dir, "SELECT status FROM task")[0].status, "进行中");
});

test("用户在页面上提交不看阶段：核读材料阶段提交，被拒的原因是完成条件，不是阶段", () => {
  const dir = workspace();
  try {
    runUserOperation({ workspaceDir: dir, sessionId: "sess-ui" }, { op_id: "ui-op-1", kind: "submit_deliverable", fields: { revision_no: 0 } });
    assert.fail("应当被拒绝");
  } catch (error) {
    assert.ok(error instanceof UserOpError, String(error));
    assert.equal(error.message.includes("阶段"), false, error.message);
    assert.match(error.message, /^任务没有标为已完成。/);
  }
});

test("早先建的任务没有阶段：助手完成任务只看完成条件", () => {
  const dir = workspace(demoDefinition());
  const out = refusal(dir);
  assert.equal(out.fact.includes("阶段"), false);
  assert.match(out.fact, /^任务没有标为已完成。\n/);
});
