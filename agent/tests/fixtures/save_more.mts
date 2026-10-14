// 测试夹具：在一个已有任务的任务目录里，用 agent 里真实的保存修订函数再存几次修订。
// 后端的数据升级测试经子进程调用它，核对升级之后的任务还能照常保存；后端自己不导入任何写入函数。
// 用法：node save_more.mts <任务目录> <各批操作的 JSON：[[操作, …], { view: ["OA-001"] }, { stage: "写条目" }, …]> [会话编号]
// 会话编号不写就是 session-fixture：保存与两种用户的步骤都记在这条会话上（助手能写什么看的是这条会话属于的工作项）。
// 每批保存一次修订；有一批被拒就把拒绝的内容写到标准错误并以 1 退出。做成了把各次的修订号写到标准输出（JSON 数组）。
// 夹在中间的 { stage } 与 { view } 是由用户做的两种（user_steps.mts），不产生修订，不算进输出；调用编号仍按这一批在列表里的位置取，
// 所以同一份列表再跑一遍，各次保存得到的是原来的修订。
import { saveRevision } from "../../src/lib/save_revision.ts";
import { userStep } from "./user_steps.mts";

const workspaceDir = process.argv[2];
const batches = JSON.parse(process.argv[3]) as unknown[][];
const sessionId = process.argv[4] || "session-fixture";
const revisions: unknown[] = [];
for (const [i, operations] of batches.entries()) {
  if (userStep(workspaceDir, sessionId, operations, `ui-more-${i + 1}`)) continue;
  const result = saveRevision({ workspaceDir, sessionId, callId: `call-more-${i + 1}` }, { operations }) as Record<string, any>;
  if (result.isError || result.details?.rejected || typeof result.details?.revision_no !== "number") {
    process.stderr.write(JSON.stringify(result.details ?? result) + "\n");
    process.exit(1);
  }
  revisions.push(result.details.revision_no);
}
process.stdout.write(JSON.stringify(revisions) + "\n");
