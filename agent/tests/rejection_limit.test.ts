/**
 * 一轮里连续被拒的上限（src/lib/rejection_limit.ts）：数什么、数到哪里为止；到第 5 次时返回「出错并结束本次运行」的结果，
 * 没到时照常抛异常；与「回复」原有的放行规则怎样配合；兜底扩展怎样认出这种收尾。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FALLBACK_TEXT } from "../src/hooks/reply_fallback.ts";
import { GATE_INVALID_TEXT, GATE_MISSING_TEXT, INTENT_GATE_TEXT } from "../src/lib/intent_schema.ts";
import {
  REJECTION_LIMIT, STOPPED_STATUS_KEY, STOPPED_TEXT, consecutiveRefusals, endedStopped, isUnderstandingGate, refusalKind, reportStopped, stopAtLimit,
} from "../src/lib/rejection_limit.ts";
import { consecutiveReplyRejections, decideReply } from "../src/lib/reply.ts";
import { ToolRejection } from "../src/lib/tool_rejection.ts";

/** 「先写理解」那道门拒绝时的文字，照 lib/dialogue_acts.ts 拼的样子。 */
const missing = (label = "回复") => `${label}没有执行：${INTENT_GATE_TEXT}。${GATE_MISSING_TEXT}。\n请按平台 skill「先写理解」一节的格式……`;
const invalid = `回复没有执行：${INTENT_GATE_TEXT}。这一轮写了 2 个 JSON 片段，${GATE_INVALID_TEXT}。各片段的问题：（1）……`;
const FORM = "回复没有执行：informs 应当是一个列表。";

const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const result = (toolName: string, isError: boolean, text = "") => ({ type: "message", message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }] } });
const refused = (text: string) => result("reply", true, text);
const times = <T>(n: number, one: T): T[] => Array.from({ length: n }, () => one);

test("上限是 5 次；按拒绝的文字认它是哪一种", () => {
  assert.equal(REJECTION_LIMIT, 5);
  assert.equal(refusalKind(missing()), "understanding_missing");
  assert.equal(refusalKind(invalid), "understanding_invalid");
  assert.equal(refusalKind(FORM), "form");
});

test("数连续被拒的次数：回复被拒不论原因都算；保存修订、完成任务只算因为没有合格的理解被拒的", () => {
  assert.equal(consecutiveRefusals([]), 0);
  assert.equal(consecutiveRefusals([user("你好"), refused(missing()), refused(invalid), refused(FORM)]), 3);
  // 原来那个函数不数没有写理解的拒绝，现在照旧（放行规则用它）。
  assert.equal(consecutiveReplyRejections([user("你好"), refused(missing()), refused(invalid), refused(FORM)] as never), 1);
  assert.equal(consecutiveRefusals([user("你好"), result("save_revision", true, missing("保存修订")), result("complete_task", true, missing("完成任务")), refused(missing())]), 3);
  // 保存修订因为输入不合规被拒：不算，也不打断。
  assert.equal(consecutiveRefusals([user("你好"), refused(missing()), result("save_revision", true, "保存修订没有执行：第 1 个操作的来源在材料里找不到。"), refused(missing())]), 2);
});

test("数到哪里为止：用户的一句话，或者三个工具里任何一个做成了的一次；兜底追加的那句话不算用户的话，别的工具不打断", () => {
  assert.equal(consecutiveRefusals([refused(missing()), refused(missing()), user("再说一句"), refused(missing())]), 1);
  assert.equal(consecutiveRefusals([user("你好"), refused(missing()), user(FALLBACK_TEXT), refused(missing())]), 2);
  assert.equal(consecutiveRefusals([user("你好"), refused(missing()), result("get_item", false, "UC-001 ……"), { type: "custom_message" }, refused(missing())]), 2);
  assert.equal(consecutiveRefusals([user("你好"), refused(missing()), result("reply", false, "回复已送达"), refused(FORM)]), 1);
  assert.equal(consecutiveRefusals([user("你好"), refused(missing()), refused(missing()), result("save_revision", false, "已保存修订 3"), refused(FORM)]), 1);
  assert.equal(consecutiveRefusals([user("你好"), refused(missing()), result("complete_task", false, "任务已完成"), refused(FORM)]), 1);
});

test("到第 5 次时返回「出错并结束本次运行」的结果，带着拒绝原因与停下的那句话；没到时是 null，照常抛异常", () => {
  const error = new ToolRejection(missing(), "事实", "指引", "gate");
  for (const prior of [0, 1, 2, 3]) assert.equal(stopAtLimit(error, [user("你好"), ...times(prior, refused(missing()))]), null, `之前被拒 ${prior} 次`);
  const stopped = stopAtLimit(error, [user("你好"), ...times(4, refused(missing()))])!;
  assert.deepEqual(stopped, {
    content: [{ type: "text", text: `${missing()}\n${STOPPED_TEXT}` }],
    details: { stopped: true, rejections: 5, reason_kind: "understanding_missing" },
    isError: true, terminate: true,
  });
  assert.equal(STOPPED_TEXT, "这一轮已经连续 5 次没有按规矩回答，这次运行到此停下。");
  // 超过上限（例如上一次因为放行不了又被拒）照样停。
  assert.equal(stopAtLimit(new Error(FORM), [user("你好"), ...times(6, refused(FORM))])!.details.rejections, 7);
  assert.equal(stopAtLimit(new Error(FORM), [user("你好"), ...times(6, refused(FORM))])!.details.reason_kind, "form");
  // 用户再说一句，计数清零。
  assert.equal(stopAtLimit(error, [user("你好"), ...times(4, refused(missing())), user("再说一句")]), null);
  // 不算数的拒绝（保存修订、完成任务因为输入不合规）到不了上限。
  assert.equal(stopAtLimit(new Error("来源找不到"), [user("你好"), ...times(4, refused(missing()))], false), null);
});

test("认「先写理解」那道门的拒绝：是这道门的才算，输入不合规的、别的门的、普通异常都不算", () => {
  assert.equal(isUnderstandingGate(new ToolRejection(missing("保存修订"), "事实", "指引", "gate")), true);
  assert.equal(isUnderstandingGate(new ToolRejection("保存修订没有执行：来源找不到。", "事实", "指引", "input")), false);
  assert.equal(isUnderstandingGate(new ToolRejection("完成任务没有执行：用户还没有同意完成。", "事实", "指引", "gate")), false);
  assert.equal(isUnderstandingGate(new Error(missing())), false);
});

test("与回复原有的放行规则配合：形式不对连着 5 次，第 5 次照旧放行纯文字回复，走不到停下；夹着没写理解的，放行不了就停下", () => {
  const bad = { informs: "不是列表", act: null, text: "退款由谁审批？" };
  const facts = { toolCallId: "c", callsThisTurn: [{ id: "c", name: "reply" }], revisionFact: () => null, currentRevisionOf: () => null };
  // 形式不对连着 5 次：放行规则看的是形式不对的连续次数，这是第 5 次，放行。
  const five = [user("你好"), ...times(4, refused(FORM))];
  assert.equal(decideReply(bad, { ...facts, priorRejections: consecutiveReplyRejections(five as never) }).degraded, true);
  // 3 次没写理解加 1 次形式不对之后又是形式不对：形式不对只连着 2 次，不放行；合起来是第 5 次，停下。
  const mixed = [user("你好"), ...times(3, refused(missing())), refused(FORM)];
  let thrown: unknown = null;
  try {
    decideReply(bad, { ...facts, priorRejections: consecutiveReplyRejections(mixed as never) });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "第 2 次形式不对应当照常被拒");
  assert.equal(stopAtLimit(thrown, mixed)!.details.rejections, 5);
});

test("兜底扩展认出这种收尾：最后一条是带 stopped 标记的工具结果；停下这件事经状态栏报一行", () => {
  assert.equal(endedStopped([{ role: "assistant" }, { role: "toolResult", details: { stopped: true, rejections: 5 } }]), true);
  assert.equal(endedStopped([{ role: "toolResult", details: { stopped: true } }, { role: "assistant" }]), false);
  assert.equal(endedStopped([{ role: "toolResult", details: { delivered: true } }]), false);
  assert.equal(endedStopped([{ role: "toolResult" }]), false);
  assert.equal(endedStopped([]), false);
  const seen: [string, any][] = [];
  const stopped = stopAtLimit(new Error(invalid), [user("你好"), ...times(4, refused(invalid))])!;
  reportStopped({ setStatus: (key, text) => void seen.push([key, JSON.parse(text)]) }, "reply", stopped);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], STOPPED_STATUS_KEY);
  const { 时刻, ...fact } = seen[0][1];
  assert.deepEqual(fact, { 结果: "这一轮连续被拒 5 次，已经停下这次运行", 工具: "reply", 最后一次的原因: "理解写得不合格" });
  assert.equal(typeof 时刻, "number");
  // 报不出去不影响停下。
  reportStopped({ setStatus: () => { throw new Error("坏了"); } }, "reply", stopped);
  reportStopped(undefined, "reply", stopped);
});
