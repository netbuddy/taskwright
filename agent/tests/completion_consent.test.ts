// 发布版本之前的同意（lib/completion_consent.ts 与 lib/publish_version.ts）：只认「这个任务是否已经完成」卡片上的点击，
// 点的要是「已完成，发布版本」，点了之后交付物没有新的修订；以最近一次点击为准；条件不满足时只报条件。
// 会话分支照 pi 的条目形状现造：卡片是助手消息里的一次回复工具调用，点击是一条界面点击的自定义消息加系统替用户发的那句话。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { saveRevision } from "../src/lib/save_revision.ts";
import { publishVersion } from "../src/lib/publish_version.ts";
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

/** 这几例只核对同意，不写存档。 */
const NO_ARCHIVE = { markdownPath: null, docxPath: null, figuresArchived: false };
/** 把分支上界面点击合成的那几句话按事实记进对话行为表（与扩展在助手回应时做的相同），再调用发布版本。 */
function complete(dir: string, branch: Entry[]) {
  recordAtSettle(dir, SESSION, branch as never, branch.filter((e) => e.message?.role === "user").map((e) => e.id), REGISTERED_OUTPUTS);
  const found = lastCompletionClick(branch);
  return withRejectionRecord({ workspaceDir: dir, sessionId: SESSION, callId: `call-done-${++serial}`, toolName: "publish_version" }, {}, () =>
    publishVersion({ workspaceDir: dir, sessionId: SESSION, callId: `call-done-${serial}`, consent: found ? { source: "card", click: found } : null }, NO_ARCHIVE));
}
const refused = async (dir: string, branch: Entry[]) => {
  try {
    await complete(dir, branch);
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail("应当被拒绝");
};
/** 发过几版。发布不改任务的状态，看的是版本记录。 */
const versions = (dir: string) => query<any>(dir, "SELECT version_no FROM version_record").length;

test("没有卡片就调用：拒绝，说明用户还没有点同意，指引写明卡片怎么写；拒绝记进工具拒绝表", async () => {
  const dir = workspace();
  const text = await refused(dir, [user("把材料整理成用例")]);
  assert.match(text, new RegExp(`^第 1 版没有发布：用户还没有在问这个任务是否已经完成的卡片上点「${AGREE_TEXT}」。\\n请用回复的请选择`));
  assert.match(text, /问句照实写出事实与后果/);
  assert.match(text, /\{ key: "complete", text: "已完成，发布版本" \} 与「还没完成，继续修改」/);
  assert.match(text, /用户在对话里打字说要发布不算/);
  assert.ok(!/现在完成|还要再改/.test(text), "不再用旧的说法");
  assert.equal(versions(dir), 0);
  assert.deepEqual(query<any>(dir, "SELECT tool_name FROM tool_rejection").map((r) => r.tool_name), ["publish_version"]);
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

test("用户点了「已完成，发布版本」：发布第 1 版；之后看过条目（已读不产生修订）也不让同意失效；任务照常进行", async () => {
  const dir = workspace();
  const branch = [user("整理好了吗"), card("k1"), ...click("k1", COMPLETE_KEY, AGREE_TEXT)];
  runUserOperation({ workspaceDir: dir, sessionId: SESSION }, { op_id: "ui-op-view", kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 1 }] });
  const outcome = await complete(dir, branch);
  assert.match(outcome.text, /^第 1 版已发布：/);
  assert.equal(versions(dir), 1);
  assert.deepEqual(query<any>(dir, "SELECT status FROM task").map((r) => r.status), ["进行中"]);
});

test("点了同意之后交付物又有了新的修订：拒绝，要重新问；在新卡片上再点同意才通过", async () => {
  const dir = workspace();
  const branch = [user("整理好了吗"), card("k1"), ...click("k1", COMPLETE_KEY, AGREE_TEXT)];
  recordAtSettle(dir, SESSION, branch as never, [branch.at(-1)!.id], REGISTERED_OUTPUTS);
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } }] });
  assert.match(await refused(dir, branch), /用户在修订 1 时点了「已完成，发布版本」，之后交付物又有了修订 2，要重新问。/);
  const again = [...branch, card("k2"), ...click("k2", COMPLETE_KEY, AGREE_TEXT)];
  assert.match((await complete(dir, again)).text, /^第 1 版已发布：.*发布的是修订 2/);
});

test("用户在对话里打字说要完成而没有点卡片：拒绝；照着卡片的话打字也不算点击", async () => {
  const dir = workspace();
  assert.match(await refused(dir, [user("请发布")]), /还没有在问这个任务是否已经完成的卡片上点/);
  assert.match(await refused(dir, [user("整理好了吗"), card("k1"), user(`我选：${AGREE_TEXT}`)]), /还没有在问这个任务是否已经完成的卡片上点/);
});

test("用户在卡片的文本框里打字不算点击：写的就是同意那一项的文字也不算同意", async () => {
  const dir = workspace();
  const typed = (cardId: string, text: string): Entry[] => [
    { id: `t${++serial}`, type: "custom_message", customType: "taskwright-card-typed", details: { reply_entry: cardId, text } }, user(text)];
  assert.equal(lastCompletionClick([user("整理好了吗"), card("k1"), ...typed("k1", AGREE_TEXT)]), null);
  assert.match(await refused(dir, [user("整理好了吗"), card("k1"), ...typed("k1", `我选：${AGREE_TEXT}`)]), /还没有在问这个任务是否已经完成的卡片上点/);
  assert.equal(versions(dir), 0);
});

test("完成条件不满足时只报条件，不提同意；用户已经点了同意也一样", async () => {
  const dir = workspace(false);
  const text = await refused(dir, [user("整理好了吗"), card("k1"), ...click("k1", COMPLETE_KEY, AGREE_TEXT)]);
  assert.match(text, /^第 1 版没有发布。\n另有 1 条完成条件没有满足/);
  assert.ok(!/卡片|已完成，发布版本/.test(text), "条件不满足时不提同意");
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

// ───────────── 页面上的发布（界面操作 publish_version，任务服务先写好存档） ─────────────

const ARCHIVE = { markdown_path: "versions/v1/document.md", docx_path: "versions/v1/document.docx", figures_archived: true };
const submit = (dir: string, fields: unknown, opId = `ui-op-publish${++serial}`) =>
  runUserOperation({ workspaceDir: dir, sessionId: SESSION }, { op_id: opId, kind: "publish_version", targets: [], fields });
const userOpError = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error as { code: string; message: string };
  }
  return assert.fail("应当被拒绝");
};

test("页面发布：带着现在的修订号与任务服务定下的版本号、存档位置发布，记一行版本记录与一条事件，发起方是用户、调用编号是操作编号，往会话里追加一句说明；任务照常进行", () => {
  const dir = workspace();
  const result = submit(dir, { revision_no: 1, version_no: 1, note: " 首版 ", ...ARCHIVE }, "ui-op-publish-ok");
  assert.deepEqual(query<any>(dir, "SELECT version_no, actor, revision_no, note, markdown_path, docx_path, figures_archived FROM version_record").map((r) => ({ ...r })),
    [{ version_no: 1, actor: "user", revision_no: 1, note: "首版", markdown_path: "versions/v1/document.md", docx_path: "versions/v1/document.docx", figures_archived: 1 }]);
  assert.deepEqual(query<any>(dir, "SELECT actor, call_id FROM event WHERE name = 'VERSION_PUBLISHED'").map((r) => [r.actor, r.call_id]), [["user", "ui-op-publish-ok"]]);
  assert.deepEqual([result.kind, result.version_no], ["publish_version", 1]);
  assert.equal(result.note, "界面操作（不是用户打的字）：用户在页面上发布了第 1 版（修订 1），发布说明：首版。发布之后任务照常可以修改，以后可以再发布新的一版。");
  assert.equal(result.notify_text, null, "不引出执行者的运行");
  assert.deepEqual(query<any>(dir, "SELECT status FROM task").map((r) => r.status), ["进行中"]);
  // 同一个修订再发一版：版本号对不上（下一版是第 2 版）时拒绝；带对了就是第 2 版。
  const again = userOpError(() => submit(dir, { revision_no: 1, version_no: 1 }));
  assert.deepEqual([again.code, again.message], ["rejected", "这次没有发布：第 1 版已经发布过了，请看过现在的版本再发布。"]);
  submit(dir, { revision_no: 1, version_no: 2 });
  assert.equal(versions(dir), 2);
});

test("页面发布：页面看到的修订号已经不是现在的，拒绝，说明给用户看；与卡片同一个判断函数", () => {
  const dir = workspace();
  saveRevision(callIn(dir), { operations: [{ op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "用口令登录" } }] });
  const error = userOpError(() => submit(dir, { revision_no: 1, version_no: 1 }));
  assert.equal(error.code, "rejected");
  assert.equal(error.message, "这次没有发布：你看到的是修订 1，交付物现在已经是修订 2。请看过现在的内容再发布。");
  assert.equal(versions(dir), 0);
});

test("页面发布：完成条件没满足时拒绝，只写缺什么，不带写给助手的指引；fields 不对时 bad_request", () => {
  const dir = workspace(false);
  const error = userOpError(() => submit(dir, { revision_no: 1, version_no: 1 }));
  assert.equal(error.code, "rejected");
  assert.match(error.message, /^第 1 版没有发布。\n另有 1 条完成条件没有满足/);
  assert.ok(!/调用|告诉用户/.test(error.message));
  assert.equal(userOpError(() => submit(dir, {})).code, "bad_request");
  assert.equal(userOpError(() => submit(dir, { revision_no: "1", version_no: 1 })).code, "bad_request");
  assert.equal(userOpError(() => submit(dir, { revision_no: 1 })).code, "bad_request");
});
