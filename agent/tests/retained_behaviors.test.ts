/**
 * 保留行为验收集合的配置一侧：提示词拆成模块、按会话拼装之后，撑着这些行为的规矩仍然拼进了对应位置的系统提示。
 * 行为本身的机械一侧（点卡片换站、拦写入、拼不成停下）另有测试，各条注释里写明在哪里。第 10 条（两个不同活动的会话读任务定义各得其视图）随任务定义视图一起做。
 */

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { composeContext } from "../src/lib/context_assemble.ts";
import { IDLE, type Stage } from "../src/lib/stage.ts";

const SRS_TYPE = join(resolve(import.meta.dirname, "..", ".."), "task-types", "requirements-engineering");
const SKILLS = [{ name: "requirements-engineering", filePath: join(SRS_TYPE, ".pi", "skills", "requirements-engineering", "SKILL.md") }];
const promptAt = (stage: Stage | typeof IDLE, over: { inFlow?: boolean; scope?: string } = {}): string =>
  composeContext({ stage, workspaceDir: SRS_TYPE, skills: SKILLS, tail: "", ...over }).text;
const has = (text: string, ...parts: string[]) => { for (const one of parts) assert.ok(text.includes(one), one); };

// 机械一侧：backend/tests/stage_flow.test.ts（点进入的卡片之后下一次运行只带澄清那一段）、agent/tests/stage_card_click.test.ts（next_step 推出目标）。
test("1 核读结束提议进入澄清：工作流里的核读带进入下一步的卡片写法；点了之后拼的是澄清的模板", () => {
  const reading = promptAt("reading");
  has(reading, "## 各步之间的转移", "`next_step`「进入下一步：澄清」", "`stay`「继续本步」", "# 现在这个阶段：核读材料");
  has(promptAt("clarifying"), "# 现在这个阶段：澄清");
});

// 机械一侧：backend/tests/activity_flow.test.ts（单项活动汇报做完）。
test("2 单项核读做完汇报完成、不发转移卡片：有单项活动的出口，没有各步之间的转移与卡片键", () => {
  const single = promptAt("reading", { inFlow: false });
  has(single, "这项活动做够了就在回复里汇报做完，不提议进入别的活动", "`activity_done: true`");
  for (const absent of ["## 各步之间的转移", "next_step", "goto:", "## 这一步怎样收尾"]) assert.ok(!single.includes(absent), absent);
});

// 机械一侧：agent/tests/stage_idle.test.ts（空闲时页与问题可以写、画图被拦并写明在哪一项活动里做）。
test("3 空闲会话要画图时引导启动活动：空闲的规矩写明请用户从任务起点页启动工作项", () => {
  const idle = promptAt(IDLE);
  has(idle, "# 现在：自由讨论", "用户要做哪一项活动，请他从任务起点页启动一个");
  assert.ok(!idle.includes("## 各步之间的转移"));
});

// 机械一侧：agent/tests/stage_save.test.ts、stage_diagram.test.ts、stage_review.test.ts（写条目阶段三样都准写）。
test("4 写条目时改页、改图、请评审：位置说明列出这三样获准的写入", () => {
  has(promptAt("writing"), "获准的写入：立页、改页、记问题条目、画图、改图、写条目、改条目、请求评审");
});

// 机械一侧：agent/tests/stage_complete.test.ts、user_ops.test.ts（未读时发布被拒）、backend/tests/complete_consent.test.ts（等用户点卡片）。
test("5 评审确认时发布先看未读与完成条件、等用户点：发布的规矩拼进评审确认", () => {
  has(promptAt("reviewing"), "问要不要发布之前，先看未读清单。");
});

// 机械一侧：agent/tests/problem_fields.test.ts（一章至多一页在用的导语，废弃了原来的才能另立）。
test("6 编写文档退回与废弃旧导语页：编写文档带一章一页导语与废弃一页的规矩，也带退回前面一步的规矩", () => {
  const document = promptAt("document");
  has(document, "一章只立一页，已经有导语页的章改那一页", "3. **废弃一页。**", "4. **退回前面的一步。**");
});

test("7 小材料与补读一份时如实说明本次范围：核读带说清三件事的那一条；启动时写了范围说明就拼进去", () => {
  has(promptAt("reading"), "用一小段话说清三件事");
  has(promptAt("reading", { scope: "只补读一份借阅规则。" }), "本次范围说明：只补读一份借阅规则。");
});

// 机械一侧：backend/tests/live_scenarios.test.ts（中途停下之后摘要写实际保存了哪几次修订）。
test("8 停止后继续、换会话、新增材料时按记录说进度：每个位置都带任务现状消息与三个事实的用法、告知只写事实", () => {
  for (const [stage, over] of [["reading", {}], ["clarifying", {}], ["writing", {}], [IDLE, {}], ["reading", { inFlow: false }]] as const) {
    const text = promptAt(stage, over);
    has(text, "1. **任务现状消息。**", "## 三个事实怎么用");
  }
  has(promptAt("clarifying"), "2. **告知只写事实。**");
});

// 拼不成时停下：agent/tests/prompt_modules.test.ts（模块缺失、when 写错）、agent/tests/context_assemble.test.ts、backend/tests/compose_failure.test.ts（真 pi 不调用模型）。
test("9 模块缺失或条件写错时停止并报错：见注释里的三份测试；这里只核对正常的拼装每个位置都拼得成", () => {
  for (const stage of ["reading", "clarifying", "modeling", "writing", "reviewing", "document"] as const) assert.ok(promptAt(stage).length > 0);
});
