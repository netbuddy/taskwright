/**
 * 测试夹具：给后端的双跑对照（backend/compare/）在一个已建好的任务里写出一份像样的库，并配一条合成的会话文件。
 * 写库一律经 agent 里真实的写入函数（保存修订、界面操作、评审），不手工拼库；评审用假评审者，不连模型。
 * 两个后端各跑一遍同一个夹具，得到内容相同、只有时刻与任务编号不同的两份数据。
 *
 * 用法：
 *   node seed_compare_task.mts seed <任务目录> <归档目录>      写修订、界面操作、评审，并写会话文件
 *   node seed_compare_task.mts old-format <任务目录>          建一个修订统一之前格式的库（只有表结构），给「旧格式」一行用
 *   node seed_compare_task.mts many-events <任务目录> <条目编号> <修订号> <条数>
 *                                                             用「撤回确认」连记这么多条库事件，给事件流「差距太大发 resync」一步用
 *
 * 任务目录里要先有建好的任务（srs-authoring 类型）与三份材料：inputs/需求说明.md、inputs/会议纪要.txt、inputs/退款规则.docx（及其投影）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runReviews } from "../../src/lib/review_run.ts";
import { saveRevision } from "../../src/lib/save_revision.ts";
import { runUserOperation } from "../../src/lib/user_ops.ts";

const [mode, workspaceDir, runsDir] = process.argv.slice(2);

if (mode === "old-format") {
  mkdirSync(workspaceDir, { recursive: true });
  const db = new DatabaseSync(join(workspaceDir, "task.sqlite"));
  db.exec("CREATE TABLE task (task_id TEXT, task_name TEXT, status TEXT, started_at TEXT, definition_text TEXT);" +
    "CREATE TABLE item_version (task_id TEXT, item_id TEXT, version_no INTEGER, fields TEXT);");
  db.close();
  process.exit(0);
}
if (mode === "many-events") {
  const [, , itemId, revision, count] = process.argv.slice(2);
  for (let n = 1; n <= Number(count); n++) {
    runUserOperation({ workspaceDir, sessionId: "" }, { op_id: `ui-op-many-${n}`, kind: "unconfirm", targets: [{ item_id: itemId, base_revision: Number(revision) }] });
  }
  process.exit(0);
}
if (mode !== "seed" || !workspaceDir || !runsDir) {
  process.stderr.write("用法：node seed_compare_task.mts seed <任务目录> <归档目录> | old-format <任务目录>\n");
  process.exit(2);
}

const SESSION = "compare-session-1";
const SESSION_2 = "compare-session-2";
const taskId = basename(workspaceDir);
const call = (callId: string, extra: Record<string, unknown> = {}) => ({ workspaceDir, sessionId: SESSION, callId, ...extra });
const ctx = { workspaceDir, sessionId: SESSION };
const userMessages = [
  { entryId: "e01", text: "请按材料整理退款的需求，退款要在七天内处理完。" },
  { entryId: "e09", text: "用户说：/检查一下约束" },
];
const md = { kind: "文档原文", locator: "inputs/需求说明.md", excerpt: "买家在收货后七天内可以申请退款。" };
const txt = { kind: "文档原文", locator: "inputs/会议纪要.txt", excerpt: "退款金额原路退回。" };
const docx = { kind: "文档原文", locator: "inputs/退款规则.docx#p2", excerpt: "平台在一个工作日内审核退款申请。" };

// 第 1 次修订：执行者新增五个集合各一个条目，来源有材料原文、用户的话、Word 材料三种。
saveRevision(call("call-r1", { userMessages }), {
  operations: [
    { op: "add", collection: "功能用例", fields: { 用例名称: "申请退款", 用例功能: "买家对已收货的订单申请退款", 参与者: ["买家"],
      基本流程: ["买家提交退款申请", "系统受理申请"], 扩展流程: [] },
      sources: [{ ...md, supports: [{ field: "用例名称" }, { field: "基本流程", index: 0 }] }, { ...docx, supports: [{ field: "基本流程", index: 1 }] }] },
    { op: "add", collection: "非功能需求", fields: { 类别: "性能", 句式类型: "普遍型", 需求语句: "系统应在一个工作日内完成退款审核。" }, sources: [docx] },
    { op: "add", collection: "约束", fields: { 类别: "业务规则", 句式类型: "普遍型", 需求语句: "退款金额应原路退回。" }, sources: [txt] },
    { op: "add", collection: "问题", fields: { 事项: "部分退款怎么算？", 种类: "待澄清", 状态: "未解决", 关联条目: [] }, sources: [md] },
    { op: "add", collection: "领域说明", fields: { 标题: "退款时限", 内容: "收货后七天内", 类别: "术语", 关联条目: [] },
      sources: [{ kind: "用户的话", excerpt: "退款要在七天内处理完" }] },
  ],
});
// 第 2 次修订：执行者改用例的基本流程（按第二句用户的话），再加一条约束。
saveRevision(call("call-r2", { userMessages }), {
  operations: [
    { op: "update", item: "UC-001", base_revision: 1, fields: { 基本流程: ["买家提交退款申请", "系统受理申请", "平台审核"] } },
    { op: "add", collection: "约束", fields: { 类别: "合规", 句式类型: "事件驱动型", 需求语句: "当退款完成时，系统应通知买家。" }, sources: [md] },
  ],
});
// 用户在界面上的直接操作：改字段（第 3 次修订）、标为已读、把问题标为先不管（第 4 次修订）。
runUserOperation(ctx, { op_id: "ui-op-edit1", kind: "edit_fields", targets: [{ item_id: "UC-001", base_revision: 2 }], fields: { 用例功能: "买家对已收货订单发起退款" } });
runUserOperation(ctx, { op_id: "ui-op-view1", kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 3 }, { item_id: "DN-001", base_revision: 1 }] });
runUserOperation(ctx, { op_id: "ui-op-keep1", kind: "keep_pending", targets: [{ item_id: "TBD-001", base_revision: 1 }] });
// 评审：用例合规，非功能需求不合规；再保留非功能需求现在的写法。
const verdicts: Record<string, string> = {
  "UC-001": JSON.stringify({ 发现: [] }),
  "NFR-001": JSON.stringify({ 发现: [{ 规则: "EARS-R1", 字段: "需求语句", 问题: "没有写清是哪一个工作日。", 建议: "写明从申请提交起算。" }] }),
};
await runReviews({ ...call("ui-op-rev1"), actor: "user" }, [{ item_id: "UC-001", revision_no: 3 }, { item_id: "NFR-001", revision_no: 1 }], {
  complete: async (_system, _user, _signal, _attempt, item) => ({ text: verdicts[item.item_id] ?? JSON.stringify({ 发现: [] }), inputTokens: 1, outputTokens: 1 }),
  model: "假/评审者",
});
runUserOperation(ctx, { op_id: "ui-op-waive1", kind: "waive_review", targets: [{ item_id: "NFR-001", base_revision: 1 }], fields: { reason: "工作日的算法另有规定" } });
// 第 5 次修订：执行者删掉第二条约束；第 6 次修订：用户撤销它。
saveRevision(call("call-r5", { sessionId: SESSION_2 }), { operations: [{ op: "delete", item: "CON-002", base_revision: 2 }] });
runUserOperation({ workspaceDir, sessionId: SESSION_2 }, { op_id: "ui-op-undo1", kind: "undo", targets: [{ revision_no: 5 }] });

// ───────── 会话文件：与上面的调用编号对得上，修订日志据此找出触发每次修订的那句话 ─────────

const dir = join(runsDir, taskId, "pi-sessions", "service");
mkdirSync(dir, { recursive: true });
let clock = Date.parse("2026-09-25T02:00:00.000Z");
const at = () => new Date((clock += 1500)).toISOString();
function writeSession(file: string, id: string, name: string, body: Record<string, unknown>[]) {
  const lines: Record<string, unknown>[] = [{ type: "session", version: 3, id, timestamp: at(), cwd: workspaceDir }];
  let parent: string | null = null;
  for (const one of body) {
    const entry = { ...one, parentId: parent, timestamp: at() };
    lines.push(entry);
    parent = entry.id as string;
  }
  lines.push({ type: "session_info", id: `${id}-name`, parentId: parent, timestamp: at(), name });
  writeFileSync(join(dir, file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
}
const user = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } });
const toolCall = (id: string, callId: string, name: string, args: Record<string, unknown>) =>
  ({ type: "message", id, message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }] } });
const toolResult = (id: string, callId: string, text: string, details: Record<string, unknown> = {}, isError = false) =>
  ({ type: "message", id, message: { role: "toolResult", toolCallId: callId, content: [{ type: "text", text }], details, isError } });
const reply = (n: string, text: string) => [
  toolCall(`a-${n}`, `call-reply-${n}`, "reply", { text, informs: ["已整理"], act: null }),
  toolResult(`t-reply-${n}`, `call-reply-${n}`, "已发出。", {}),
];

writeSession("2026-09-25T02-00-00_compare-session-1.jsonl", SESSION, "退款需求整理", [
  user("e01", userMessages[0].text),
  toolCall("a01", "call-read-1", "read", { path: "inputs/需求说明.md" }),
  toolResult("t01", "call-read-1", "……"),
  toolCall("a02", "call-read-2", "read", { path: "inputs/会议纪要.txt" }),
  toolResult("t02", "call-read-2", "……"),
  toolCall("a03", "call-r1", "save_revision", { operations: [] }),
  toolResult("t03", "call-r1", "已保存修订 1。", { revision_no: 1, operations: [{ op: "add", collection: "功能用例", item: "UC-001" }] }),
  ...reply("1", "整理好了五个条目。"),
  { type: "custom_message", id: "c05", customType: "taskwright-ui-click", content: "", details: { text: "先看用例", reply_entry: "a-1", option_key: "a", option_text: "先看用例" } },
  user("e06", "先看用例"),
  { type: "message", id: "a07", message: { role: "assistant", content: [{ type: "text", text: "好的，这是用例。" }] } },
  { type: "custom_message", id: "c08", customType: "taskwright-user-edit", content: "你改了 UC-001", details: { op_id: "ui-op-edit1", kind: "edit_fields", revision_no: 3, undoable: true, event_seqs: [4] } },
  user("e09", userMessages[1].text),
  toolCall("a10", "call-r2", "save_revision", { operations: [] }),
  toolResult("t10", "call-r2", "已保存修订 2。", { revision_no: 2 }),
  toolCall("a11", "call-bad", "save_revision", { operations: [] }),
  toolResult("t11", "call-bad", "这次「保存修订」什么都没有写入，因为有 1 个操作不对：\n- 操作 1（新增）：集合「没有这个」不存在\n  怎么办：改用任务定义里的集合名\n请把这些地方改正之后再调用。", {}, true),
  ...reply("2", "约束补上了。"),
  { type: "custom_message", id: "c13", customType: "taskwright-task-status", content: "任务现状：条目 6 个。", details: {} },
]);
writeSession("2026-09-25T03-00-00_compare-session-2.jsonl", SESSION_2, "约束复核", [
  user("f01", "第二条约束不要了"),
  toolCall("b02", "call-r5", "save_revision", { operations: [] }),
  toolResult("u02", "call-r5", "已保存修订 5。", { revision_no: 5 }),
  ...reply("3", "删掉了。"),
  { type: "custom_message", id: "g04", customType: "taskwright-user-edit", content: "你撤销了修订 5", details: { op_id: "ui-op-undo1", kind: "undo", revision_no: 6, undoable: false } },
]);
process.stdout.write(JSON.stringify({ ok: true, task_id: taskId, revisions: readFileSync(join(workspaceDir, "task.sqlite")).length > 0 }) + "\n");
