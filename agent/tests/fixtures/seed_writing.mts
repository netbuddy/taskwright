// 测试夹具：把一个刚建好的、有「业务说明」集合的任务备到「可以写条目」的样子，给不是测工作阶段的集成测试用。三步：
// 1. 助手立一页主题（调用编号 call-topic，成为任务的修订 1）；2. 用户看过这一页；3. 用户在会话 seed 上启动需求分析、从写条目开始。
// 这之后属于这个工作项的会话里，助手就能往别的集合里写条目。写库只经 agent 里真实的核心函数；后端的测试经子进程调用它。
// 用法：node seed_writing.mts <任务目录> <立那一页的操作列表的 JSON>
import { saveRevision } from "../../src/lib/save_revision.ts";
import { runUserOperation } from "../../src/lib/user_ops.ts";

const [workspaceDir, operations] = process.argv.slice(2);
const saved = saveRevision({ workspaceDir, sessionId: "seed", callId: "call-topic" }, { operations: JSON.parse(operations) });
const page = (saved.details as { operations: { item: string; to_revision: number }[] }).operations[0];
const ui = { workspaceDir, sessionId: "seed" };
runUserOperation(ui, { op_id: "ui-seed-1", kind: "mark_viewed", targets: [{ item_id: page.item, base_revision: page.to_revision }] });
runUserOperation(ui, { op_id: "ui-seed-2", kind: "start_activity", fields: { activity: "写条目", in_flow: true } });
