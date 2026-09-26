/**
 * 「回复」给建议值时的依据：与「保存修订」的来源同一套逐字核对（文档原文、用户的话、领域说明，Word 材料按段落号），
 * 同一套拒绝文字，事实与指引两层；核对后的依据写进送达的回复；被拒时拒绝记录入库。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { checkReply, decideReply, openRevisionLookup, type ReplyFacts } from "../src/lib/reply.ts";
import { checkQuotes, saveRevision } from "../src/lib/save_revision.ts";
import { ToolRejection, withRejectionRecord } from "../src/lib/tool_rejection.ts";
import { DEFINITION_PATH, SAMPLE_DOCX, SOURCE, callIn, demoDefinition, makeWorkspace, putSampleDocx, query } from "./helpers.ts";

const SESSION = "session-test";
const USER_MESSAGES = [{ entryId: "e-3", text: "退款最好七天内办完，别拖。" }];

/** 演示定义加上「领域说明」集合；任务里有 UC-001 与 DN-001，材料目录里另有 Word 样本。 */
function workspace(): string {
  const def = demoDefinition() as Record<string, any>;
  def.交付物.条目集合.push({
    名称: "领域说明", 编号前缀: "DN",
    字段: [{ 名: "标题", 类型: "文本", 必填: true }, { 名: "内容", 类型: "文本", 必填: true }],
  });
  const dir = makeWorkspace(def);
  putSampleDocx(dir);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "退款", 步骤: ["申请退款"] }, sources: [SOURCE] },
    { op: "add", collection: "领域说明", fields: { 标题: "口令", 内容: "口令是登录时输入的一串字符，区分大小写。" },
      sources: [{ kind: "执行者补充", locator: "执行者补充", excerpt: "口令的意思" }] },
  ] });
  return dir;
}

/** 与工具登记处相同的接法：依据交给 checkQuotes 核对。 */
function facts(dir: string): ReplyFacts {
  const lookup = openRevisionLookup(dir);
  return {
    toolCallId: "call-reply", callsThisTurn: [{ id: "call-reply", name: "reply" }],
    revisionFact: lookup.revisionFact, currentRevisionOf: lookup.currentRevisionOf,
    checkBasis: (raw, errors, whereOf) => checkQuotes(dir, SESSION, USER_MESSAGES, raw, errors, whereOf),
  };
}

const suggest = (basis: unknown[]) => ({
  informs: [], text: "建议写成七天。",
  act: { kind: "suggest", text: "处理时限建议写成七天。", value: "七天", scope: "general", basis },
});

function rejection(dir: string, basis: unknown[]): ToolRejection {
  try {
    checkReply(suggest(basis), facts(dir));
  } catch (error) {
    assert.ok(error instanceof ToolRejection);
    return error;
  }
  assert.fail("应当被拒");
}

test("文档原文：摘录逐字出自材料就送达；改了字就拒绝，指引层沿用保存修订的措辞", () => {
  const dir = workspace();
  const ok = checkReply(suggest([{ kind: "文档原文", locator: "inputs/材料.md", excerpt: "退款须在七天内处理完毕。" }]), facts(dir));
  assert.deepEqual(ok.act?.basis, [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: "退款须在七天内处理完毕。" }]);
  const error = rejection(dir, [{ kind: "文档原文", locator: "inputs/材料.md", excerpt: "退款须在五天内处理完毕。" }]);
  assert.match(error.message, /1\. act\.basis 的第 1 条的摘录「退款须在五天内处理完毕。」在 材料\.md 里找不到。\n   怎么办：摘录必须与材料原文逐字一致，包括标点/);
  assert.equal(error.fact, "这次回复的形式不对，没有送达：\n1. act.basis 的第 1 条的摘录「退款须在五天内处理完毕。」在 材料.md 里找不到。");
  assert.match(error.guidance, /^请按这几处改好后重新单独调用 reply\n1\. 摘录必须与材料原文逐字一致，包括标点；不要自行补标点或改写/);
});

test("用户的话：出处由工具代填成「会话编号#会话条目编号」；原话里没有就拒绝", () => {
  const dir = workspace();
  const ok = checkReply(suggest([{ kind: "用户的话", excerpt: "七天内办完" }]), facts(dir));
  assert.deepEqual(ok.act?.basis, [{ kind: "用户的话", locator: `${SESSION}#e-3`, excerpt: "七天内办完" }]);
  const error = rejection(dir, [{ kind: "用户的话", locator: "e-3", excerpt: "五天内办完" }]);
  assert.match(error.message, /act\.basis 的第 1 条引用的用户的话「五天内办完」在对话里没有找到。\n   怎么办：请逐字摘录用户说过的原话。/);
});

test("领域说明：摘录逐字出自那条还在的说明；摘录不在其中、出处不是领域说明，都拒绝", () => {
  const dir = workspace();
  const ok = checkReply(suggest([{ kind: "领域说明", locator: "DN-001", excerpt: "区分大小写" }]), facts(dir));
  assert.deepEqual(ok.act?.basis, [{ kind: "领域说明", locator: "DN-001", excerpt: "区分大小写" }]);
  const error = rejection(dir, [{ kind: "领域说明", locator: "DN-001", excerpt: "不区分大小写" },
    { kind: "领域说明", locator: "UC-001", excerpt: "退款" }]);
  assert.match(error.message, /act\.basis 的第 1 条的摘录「不区分大小写」在 DN-001 的当前修订里找不到/);
  assert.match(error.message, /act\.basis 的第 2 条的种类是「领域说明」，出处 UC-001 不是这个任务里「领域说明」集合的条目编号/);
});

test("Word 材料：出处写段落号，摘录在那一段里送达；写错段落号时拒绝并指出它在哪一段", () => {
  const dir = workspace();
  const ok = checkReply(suggest([{ kind: "文档原文", locator: `${SAMPLE_DOCX}#p76`, excerpt: "逾期的每本每天罚款一角" }]), facts(dir));
  assert.deepEqual(ok.act?.basis, [{ kind: "文档原文", locator: `${SAMPLE_DOCX}#p76`, excerpt: "逾期的每本每天罚款一角" }]);
  const error = rejection(dir, [{ kind: "文档原文", locator: `${SAMPLE_DOCX}#p91`, excerpt: "逾期的每本每天罚款一角" }]);
  assert.match(error.message, /act\.basis 的第 1 条的摘录「逾期的每本每天罚款一角」在 requirements-styled\.docx 第 91 段里找不到，它在第 76 段。\n   怎么办：出处改写成 inputs\/requirements-styled\.docx#p76。/);
});

test("执行者补充不核对摘录；种类不在四种之内、缺摘录，按保存修订的原话拒绝", () => {
  const dir = workspace();
  const ok = checkReply(suggest([{ kind: "执行者补充", locator: "执行者补充", excerpt: "行业惯例是七天" }]), facts(dir));
  assert.equal(ok.act?.basis?.[0].excerpt, "行业惯例是七天");
  const error = rejection(dir, [{ kind: "猜的", locator: "x", excerpt: "" }]);
  assert.match(error.message, /act\.basis 的第 1 条的 kind 写的是 "猜的"，只能是「文档原文」、「用户的话」、「执行者补充」、「领域说明」之一/);
  assert.match(error.message, /act\.basis 的第 1 条缺少 excerpt（摘录的原文）/);
});

test("依据被拒时整条回复被拒，拒绝记进 tool_rejection 表，事实层与指引层分开", async () => {
  const dir = workspace();
  const params = suggest([{ kind: "文档原文", locator: `${SAMPLE_DOCX}#p91`, excerpt: "逾期的每本每天罚款一角" }]);
  await assert.rejects(withRejectionRecord({ workspaceDir: dir, sessionId: SESSION, callId: "call-reply", toolName: "reply" }, params,
    () => decideReply(params, facts(dir))), /没有送达/);
  const [row] = query<any>(dir, "SELECT * FROM tool_rejection");
  assert.equal(row.tool_name, "reply");
  assert.match(row.fact, /在 requirements-styled\.docx 第 91 段里找不到，它在第 76 段。$/);
  assert.doesNotMatch(row.fact, /怎么办/);
  assert.match(row.guidance, /1\. 出处改写成 inputs\/requirements-styled\.docx#p76。$/);
});
