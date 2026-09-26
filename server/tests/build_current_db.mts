// 测试夹具：用 agent 里真实的核心函数，在给定的任务目录里写出一个新格式的库。
// Python 的读取一侧测试调用它，这样测的是工具真正写出来的库，而不是手工拼的库。
// 用法：node build_current_db.mts <任务目录>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTask } from "../../agent/src/lib/create_task.ts";
import { saveRevision } from "../../agent/src/lib/save_revision.ts";
import { withRejectionRecord } from "../../agent/src/lib/tool_rejection.ts";

const workspaceDir = process.argv[2];
const call = (id: string) => ({ workspaceDir, sessionId: "session-fixture", callId: id });
const source = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "买家可以申请退款。" };
// 会话里的用户消息：「用户的话」的出处由工具在这里找到那句话并代填为「session-fixture#entry-9」。
const userMessages = [{ entryId: "entry-9", text: "退款七天内要处理完" }];

// 「文档原文」的摘录要逐字出自出处所指的材料文件，先把材料放好。
mkdirSync(join(workspaceDir, "inputs"), { recursive: true });
writeFileSync(join(workspaceDir, "inputs/材料.md"), "退款规则\n\n买家可以申请退款。\n", "utf-8");

createTask(call("call-create"), { definition_path: "docs/task-definitions/demo.json" });
saveRevision(call("call-r1"), {
  operations: [
    { op: "add", collection: "用例", fields: { 名称: "申请退款", 步骤: ["提交申请", "系统受理"] },
      sources: [{ ...source, supports: [{ field: "名称" }, { field: "步骤", index: 0 }] }] },
    { op: "add", collection: "待定事项", fields: { 事项: "退款时限？", 状态: "未解决" }, sources: [source] },
  ],
});
saveRevision({ ...call("call-r2"), userMessages }, {
  operations: [
    { op: "update", item: "UC-001", base_revision: 1, fields: { 名称: "买家申请退款" } },
    { op: "update", item: "TBD-001", base_revision: 1, fields: { 状态: "已解决", 关联条目: ["UC-001"] },
      sources: [{ kind: "用户的话", excerpt: "七天内", supports: [{ field: "状态" }] }] },
    { op: "add", collection: "用例", fields: { 名称: "撤销申请", 步骤: ["撤销"] }, sources: [source] },
  ],
});
saveRevision(call("call-r3"), { operations: [{ op: "delete", item: "UC-002", base_revision: 2 }] });
// 一次被拒的保存修订：经工具登记处同一个外壳，拒绝记进 tool_rejection 表（修订不变）。
const bad = { operations: [{ op: "add", collection: "没有这个集合", fields: {}, sources: [source] }] };
await withRejectionRecord({ workspaceDir, sessionId: "session-fixture", callId: "call-bad", toolName: "save_revision", workId: "w-entry-9" }, bad,
  () => saveRevision(call("call-bad"), bad)).catch(() => {});
