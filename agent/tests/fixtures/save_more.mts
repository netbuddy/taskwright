// 测试夹具：在一个已有任务的任务目录里，用 agent 里真实的保存修订函数再存几次修订。
// 后端的数据升级测试经子进程调用它，核对升级之后的任务还能照常保存；后端自己不导入任何写入函数。
// 用法：node save_more.mts <任务目录> <各批操作的 JSON：[[操作, …], …]>
// 每批保存一次修订；有一批被拒就把拒绝的内容写到标准错误并以 1 退出。做成了把各次的修订号写到标准输出（JSON 数组）。
import { saveRevision } from "../../src/lib/save_revision.ts";

const workspaceDir = process.argv[2];
const batches = JSON.parse(process.argv[3]) as unknown[][];
const revisions: unknown[] = [];
for (const [i, operations] of batches.entries()) {
  const result = saveRevision({ workspaceDir, sessionId: "session-fixture", callId: `call-more-${i + 1}` }, { operations }) as Record<string, any>;
  if (result.isError || result.details?.rejected || typeof result.details?.revision_no !== "number") {
    process.stderr.write(JSON.stringify(result.details ?? result) + "\n");
    process.exit(1);
  }
  revisions.push(result.details.revision_no);
}
process.stdout.write(JSON.stringify(revisions) + "\n");
