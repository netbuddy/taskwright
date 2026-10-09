// 测试夹具：在一个已有任务的任务目录里，用 agent 里真实的界面操作函数做几次用户的界面操作（改字段、标为已读等）。
// 后端的测试经子进程调用它，再读整份数据核对；后端自己不导入任何写入函数。
// 用法：node user_ops.mts <任务目录> <各次操作的 JSON：[{ kind, targets, … }, …]>
// 按先后做；每次操作要自带 op_id（同一个任务里不能重复）。有一次出错就把错误写到标准错误并以 1 退出。做成了把各次产生的修订号写到标准输出（JSON 数组，不产生修订的是 null）。
import { runUserOperation } from "../../src/lib/user_ops.ts";

const workspaceDir = process.argv[2];
const requests = JSON.parse(process.argv[3]) as Record<string, unknown>[];
const revisions: unknown[] = [];
for (const [i, request] of requests.entries()) {
  try {
    const result = runUserOperation({ workspaceDir, sessionId: "session-fixture" }, request);
    revisions.push(result.revision_no);
  } catch (error) {
    process.stderr.write(`第 ${i + 1} 次操作没有做成：${(error as Error).message}\n`);
    process.exit(1);
  }
}
process.stdout.write(JSON.stringify(revisions) + "\n");
