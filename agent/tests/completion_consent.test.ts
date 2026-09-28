// 提交交付物之前的同意（lib/completion_consent.ts 与 lib/complete_task.ts）：只认「这个任务是否已经完成」卡片上的点击，
// 点的要是「已完成，提交交付物」，点了之后交付物没有新的修订；以最近一次点击为准；条件不满足时只报条件。
// 会话分支照 pi 的条目形状现造：卡片是助手消息里的一次回复工具调用，点击是一条界面点击的自定义消息加系统替用户发的那句话。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { completeTask } from "../src/lib/complete_task.ts";
import { AGREE_TEXT, COMPLETE_KEY, DECLINE_TEXT, judgeConsent, lastCompletionClick } from "../src/lib/completion_consent.ts";
import { recordAtSettle } from "../src/lib/dialogue_acts.ts";
import { REGISTERED_OUTPUTS } from "../src/lib/registered_outputs.ts";
import { runUserOperation } from "../src/lib/user_ops.ts";
import { withRejectionRecord } from "../src/lib/tool_rejection.ts";
import { DEFINITION_PATH, SOURCE, callIn, demoDefinition, makeWorkspace, query } from "./helpers.ts";

const SESSION = "session-consent";

/** 完成条件只有「至少一个条目」与「没有未解决的问题」，新增一个用例就满足。 */
function workspace(met = true): string {
  const definition = demoDefinition() as any;
  definition.完成条件 = { 用例: ["至少一个条目"], 问题: ["没有状态为未解决的条目"] };
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  saveRevision(callIn(dir), { operations: [
    { op: "add", collection: "用例", fields: { 名称: "登录", 步骤: ["用户输入口令"] }, sources: [SOURCE] },
    ...(met ? [] : [{ op: "add", collection: "问题", fields: { 事项: "口令长度", 状态: "未解决" }, sources: [SOURCE] }]),
  ] });
  return dir;
}

type Entry = { id: string; type: string; customType?: string; details?: any; message?: any };
let serial = 0;
const user = (text: string, id = `u${++serial}`): Entry => ({ id, type: "message", message: { role: "user", content: [{ type: "text", text }] } });
/** 一张请选择卡片；completion 为真时是问任务是否已经完成的那种（有一项 key 为 complete）。 */
const card = (id: string, completion = true): Entry => ({
  id, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `call-${id}`, name: "reply", arguments: {
    informs: [], text: "……", act: { kind: "choose", text: "这个任务是否已经完成？",
      options: completion ? [{ key: COMPLETE_KEY, text: AGREE_TEXT }, { key: "continue", text: DECLINE_TEXT }] : [{ key: "a", text: "允许" }, { key: "b", text: "不允许" }] } } }] },
});
/** 用户在卡片上点了一项：界面点击的自定义消息，紧跟着系统替用户发的那句话。 */
const click = (cardId: string, key: string, text: string): Entry[] => {
  const said = `我选：${text}`;
  return [{ id: `c${++serial}`, type: "custom_message", customType: "taskwright-ui-click", details: { reply_entry: cardId, option_key: key, option_text: text, text: said } },
    user(said)];
};

/** 把分支上界面点击合成的那几句话按事实记进对话行为表（与扩展在助手回应时做的相同），再调用完成任务。 */
function complete(dir: string, branch: Entry[]) {
  recordAtSettle(dir, SESSION, branch as never, branch.filter((e) => e.message?.role === "user").map((e) => e.id), REGISTERED_OUTPUTS);
  const found = lastCompletionClick(branch);
  return withRejectionRecord({ workspaceDir: dir, sessionId: SESSION, callId: `call-done-${++serial}`, toolName: "complete_task" }, {}, () =>
    completeTask({ workspaceDir: dir, sessionId: SESSION, callId: `call-done-${serial}`, consent: found ? { source: "card", click: found } : null }));
}
const refused = async (dir: string, branch: Entry[]) => {
  try {
    await complete(dir, branch);
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail("应当被拒绝");
};
const status = (dir: string) => query<any>(dir, "SELECT status FROM task")[0].status;

test("没有卡片就调用：拒绝，说明用户还没有点同意，指引写明卡片怎么写；拒绝记进工具拒绝表", async () => {
  const dir = workspace();
  const text = await refused(dir, [user("把材料整理成用例")]);
  assert.match(text, new RegExp(`^任务没有标为已完成：用户还没有在问这个任务是否已经完成的卡片上点「${AGREE_TEXT}」。\\n请用回复的请选择`));
  assert.match(text, /问句照实写出事实与后果/);
  assert.match(text, /\{ key: "complete", text: "已完成，提交交付物" \} 与「还没完成，继续修改」/);
  assert.match(text, /用户在对话里打字说要完成不算/);
  assert.ok(!/现在完成|还要再改/.test(text), "不再用旧的说法");
  assert.equal(status(dir), "进行中");
  assert.deepEqual(query<any>(dir, "SELECT tool_name FROM tool_rejection").map((r) => r.tool_name), ["complete_task"]);
});

test("发了卡片、用户还没点：拒绝", async () => {
  const dir = workspace();
  assert.match(await refused(dir, [user("整理好了吗"), card("k1")]), /用户还没有在问这个任务是否已经完成的卡片上点/);
});

test("用户点了「还没完成，继续修改」：拒绝，说明点的是哪一项", async () => {
  const dir = workspace();
  const text = await refused(dir, [user("整理好了吗"), card("k1"), ...click("k1", "continue", DECLINE_TEXT)]);
  assert.match(text, /用户在最近一张问这个任务是否已经完成的卡片上选的是「还没完成，继续修改」。/);
});

test("用户点了「已完成，提交交付物」：任务标为已完成；之后看过条目（已读不产生修订）也不让同意失效", async () => {
  const dir = workspace();
  const branch = [user("整理好了吗"), card("k1"), ...click("k1", COMPLETE_KEY, AGREE_TEXT)];
  runUserOperation({ workspaceDir: dir, sessionId: SESSION }, { op_id: "ui-op-view", kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] });
  const outcome = await complete(dir, branch);
  assert.match(outcome.text, /已标为已完成/);
  assert.equal(status(dir), "已完成");
});

test("点了同意之后交付物又有了新的修订：拒绝，要重新问；在新卡片上再点同意才通过", async () => {
  const dir = workspace();
  const branch = [user("整理好了吗"), card("k1"), ...click("k1", COMPLETE_KEY, AGREE_TEXT)];
  recordAtSettle(dir, SESSION, branch as never, [branch.at(-1)!.id], REGISTERED_OUTPUTS);
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } }] });
  assert.match(await refused(dir, branch), /用户在修订 1 时点了「已完成，提交交付物」，之后交付物又有了修订 2，要重新问。/);
  const again = [...branch, card("k2"), ...click("k2", COMPLETE_KEY, AGREE_TEXT)];
  assert.match((await complete(dir, again)).text, /已标为已完成/);
});

test("用户在对话里打字说要完成而没有点卡片：拒绝；照着卡片的话打字也不算点击", async () => {
  const dir = workspace();
  assert.match(await refused(dir, [user("请完成任务")]), /还没有在问这个任务是否已经完成的卡片上点/);
  assert.match(await refused(dir, [user("整理好了吗"), card("k1"), user(`我选：${AGREE_TEXT}`)]), /还没有在问这个任务是否已经完成的卡片上点/);
});

test("完成条件不满足时只报条件，不提同意；用户已经点了同意也一样", async () => {
  const dir = workspace(false);
  const text = await refused(dir, [user("整理好了吗"), card("k1"), ...click("k1", COMPLETE_KEY, AGREE_TEXT)]);
  assert.match(text, /^任务没有标为已完成。\n另有 1 条完成条件没有满足/);
  assert.ok(!/卡片|提交交付物/.test(text), "条件不满足时不提同意");
});

test("点的是别的卡片（没有 key 为 complete 的选项）：不算同意", async () => {
  const dir = workspace();
  assert.match(await refused(dir, [user("可以吗"), card("k1", false), ...click("k1", "a", "允许")]), /还没有在问这个任务是否已经完成的卡片上点/);
});

test("以最近一次点击为准：先点了同意，后来在新的卡片上点了「还没完成，继续修改」，拒绝", async () => {
  const dir = workspace();
  const branch = [user("整理好了吗"), card("k1"), ...click("k1", COMPLETE_KEY, AGREE_TEXT), card("k2"), ...click("k2", "continue", DECLINE_TEXT)];
  assert.match(await refused(dir, branch), /选的是「还没完成，继续修改」/);
});

test("判断函数：两种来源同一套规则——没有、没同意、修订变了、都对", () => {
  assert.deepEqual(judgeConsent(null, 3), { ok: false, reason: "none" });
  assert.deepEqual(judgeConsent({ source: "card", agreed: false, revisionNo: 3, optionText: DECLINE_TEXT }, 3), { ok: false, reason: "declined", optionText: DECLINE_TEXT });
  assert.deepEqual(judgeConsent({ source: "page", agreed: true, revisionNo: 2 }, 3), { ok: false, reason: "stale", revisionNo: 2, latest: 3 });
  assert.deepEqual(judgeConsent({ source: "page", agreed: true, revisionNo: 3 }, 3), { ok: true });
  assert.deepEqual(judgeConsent({ source: "card", agreed: true, revisionNo: 0 }, 0), { ok: true });
});
