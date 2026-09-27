/**
 * 与 Python 版逐字对照用的输入：测试与夹具生成脚本（generate.mts）共用这一份，两边拿同样的输入。
 * Python 版在这些输入上的输出存在同目录的 *.json 里，说明见 README.md。
 */

type Dict = Record<string, any>;

/** 直接操作的请求体（十种操作，mark_viewed 两种写法）。 */
export const BODIES: Dict[] = [
  { client_id: "a-1", kind: "edit_fields", task_id: "TASK-001", targets: [{ item_id: "UC-001", base_revision: 1 }], fields: { 用例名称: "改名", 基本流程: ["一", "二"] }, notify_executor: false },
  { client_id: "a-2", kind: "delete_item", targets: [{ item_id: "UC-002", base_revision: 3 }] },
  { client_id: "a-3", kind: "unconfirm", targets: [{ item_id: "UC-001", base_revision: 2 }] },
  { client_id: "a-4", kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 2 }] },
  { client_id: "a-5", kind: "mark_viewed", targets: [{ item_id: "UC-001", base_revision: 2 }, { item_id: "UC-002", base_revision: 1 }], notify_executor: true },
  { client_id: "a-6", kind: "keep_pending", targets: [{ item_id: "TBD-001", base_revision: 1 }, { item_id: "TBD-002", base_revision: 1 }], notify_executor: true },
  { client_id: "a-7", kind: "undo", targets: [{ revision_no: 4 }], extra: "不转交" },
  { client_id: "a-8", kind: "request_review", targets: [{ item_id: "UC-001", base_revision: 2 }], force: true },
  { client_id: "a-9", kind: "waive_review", targets: [{ item_id: "NFR-001", base_revision: 1 }], fields: { reason: "另有规定", source: "panel" } },
  { client_id: "a-10", kind: "unwaive_review", targets: [{ item_id: "NFR-001", base_revision: 1 }] },
  { client_id: "a-11", kind: "set_review_rules", fields: { collection: "功能用例", off: ["UC-R9"], promote: [] }, session_id: "S1" },
];

/** 卡片点击：发给执行者的话与标注。 */
export const CARDS: [string, Dict][] = [
  ["我选：先做退货流程", { reply_message_id: "a0000002", option_key: "a", option_text: "先做退货流程" }],
  ["这个不对。", { reply_message_id: "a0000002" }],
];

/** 卡片标注的计算：会话条目与请求体。 */
const reply = { type: "message", id: "a0000002", message: { role: "assistant", content: [{ type: "text", text: "请选" }, { type: "toolCall", name: "reply", arguments: {
  text: "逾期能续借吗？", act: { kind: "choose", options: [{ key: "allow", text: "允许续借" }, { key: "deny", text: "不允许续借" }, { key: "x" }] } } }] } };
export const CARD_ENTRIES = [{ type: "message", id: "u0000001", message: { role: "user", content: "问吧" } }, reply];
export const CARD_BODIES: Dict[] = [
  { annotation: { reply_message_id: "a0000002", option_key: "a", option_text: "甲" } },
  { card: { reply_message_id: "a0000002", kind: "choose", choice: "deny" } },
  { card: { reply_message_id: "a0000002", kind: "confirm", choice: "不对" } },
  { card: { reply_message_id: "a0000002", kind: "choose", choice: "x" } },
  { card: { reply_message_id: "a9999999", kind: "choose", choice: "allow" } },
  { card: { kind: "choose" } },
  { card: "不是对象", annotation: "也不是" },
  {},
];

/** 带过程摘要的对话记录：一份会话条目与任务定义。 */
export const CONVERSATION_ENTRIES = (() => {
  const msg = (id: string, parentId: string | null, t: number, role: string, content: unknown) =>
    ({ type: "message", id, parentId, timestamp: `2026-09-22T01:00:${String(t).padStart(2, "0")}.000Z`, message: { role, content } });
  const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
  const result = (id: string, parentId: string, t: number, callId: string, isError = false, details: unknown = {}, content: unknown = []) =>
    ({ type: "message", id, parentId, timestamp: `2026-09-22T01:00:${String(t).padStart(2, "0")}.000Z`, message: { role: "toolResult", toolCallId: callId, isError, details, content } });
  return [
    { type: "session", id: "h" },
    { type: "custom_message", id: "s1", parentId: null, customType: "taskwright-task-status", content: "【任务现状】", timestamp: "2026-09-22T01:00:00.000Z" },
    msg("u1", "s1", 0, "user", "整理材料"),
    msg("a1", "u1", 2, "assistant", [call("c1", "read", { path: "/w/inputs/甲.md" }), call("c2", "read", { path: "/w/inputs/乙.md" })]),
    result("r1", "a1", 3, "c1"), result("r2", "r1", 3, "c2"),
    msg("a2", "r2", 5, "assistant", [call("c3", "save_revision", {})]),
    result("r3", "a2", 6, "c3", true, {}, [{ type: "text", text: "这次「保存修订」什么都没有写入，因为有 1 个操作不对：\n- 操作 1（新增）：摘录找不到。\n请把这些地方改正之后再提交。" }]),
    msg("a3", "r3", 8, "assistant", [call("c4", "save_revision", {})]),
    result("r4", "a3", 9, "c4", false, { revision_no: 1, operations: [{ op: "add", collection: "功能用例", item: "UC-001" }] }),
    msg("a4", "r4", 12, "assistant", [call("c5", "reply", { informs: [{ text: "存了", items: [{ item_id: "UC-001", revision_no: 1 }] }], act: null, text: "好了" })]),
    result("r5", "a4", 12, "c5"),
    { type: "custom_message", id: "k1", parentId: "r5", customType: "taskwright-ui-click", content: "点击", details: { reply_entry: "a4", option_key: "a", option_text: "甲", text: "我选：甲" }, timestamp: "2026-09-22T01:00:13.000Z" },
    msg("u2", "k1", 20, "user", "我选：甲"),
    msg("a5", "u2", 22, "assistant", [call("c6", "ls", { path: "/w/inputs" })]), result("r6", "a5", 23, "c6"),
    msg("u3", "r6", 30, "user", "用户说：/再看看"),
    msg("a6", "u3", 31, "assistant", [{ type: "text", text: "直接回答" }]),
  ];
})();
export const CONVERSATION_DEFINITION = { 材料目录: "inputs/" };

/** 假模型端点的命令行进程：脚本与一串请求。 */
const user = (text: string) => ({ model: "fake-model", messages: [{ role: "user", content: text }] });
export const FAKE_MODEL = (() => {
  const script = {
    rules: [{ when: { any_contains: "你是评审者" }, reply: { text: JSON.stringify({ 发现: [] }) } }, { when: { last_role: "tool", last_contains: "被拒" }, reply: { text: "我改一下。" }, max_uses: 1 }],
    sequence: [{ text: "中文，含 \"引号\" 与 \\ 反斜杠。", tool_calls: [{ name: "save_revision", arguments: { operations: [{ op: "add", fields: { 名称: "甲", 步骤: ["一", "二"] }, n: 3, x: null, ok: true }] } }] },
      { tool_calls: [{ name: "reply", arguments: { informs: [], act: null, text: "好。" }, id: "call-1" }] }, { status: 503, error_body: "暂时不可用" }, { text: "慢。", delay: 0.2 }],
    default: { text: "" },
  };
  const requests: Dict[] = [
    { ...user("整理一下"), stream: true, tools: [{ type: "function", function: { name: "ls", parameters: { type: "object" } } }] },
    { model: "fake-model", messages: [{ role: "tool", content: [{ type: "text", text: "调用被拒：缺字段" }] }], stream: true },
    { ...user("你是评审者，看一下"), stream: false },
    user("再来"), user("出错"), { ...user("慢"), stream: true }, { ...user("用完了"), stream: true },
  ];
  return { script, requests };
})();

/** 把随运行变化的东西换成占位写法：操作编号按首次出现的先后编号，给定的路径换成名字。 */
export function normalize(value: unknown, paths: [string, string][] = []): unknown {
  let text = JSON.stringify(value);
  for (const [path, name] of paths) text = text.split(JSON.stringify(path).slice(1, -1)).join(name);
  const seen = new Map<string, string>();
  text = text.replace(/ui-op-[0-9a-f]{12}/g, (m) => {
    if (!seen.has(m)) seen.set(m, `<操作${seen.size + 1}>`);
    return seen.get(m)!;
  });
  return JSON.parse(text);
}
