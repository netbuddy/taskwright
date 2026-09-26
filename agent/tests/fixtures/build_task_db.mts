// 测试夹具：在一个已放好起始文件的任务目录里建任务，再按给定的几批操作各保存一次修订（发起方执行者）。
// 后端的读取一侧测试经子进程调用它，写库只经 agent 里真实的核心函数。
// 用法：node build_task_db.mts <任务目录> <任务定义相对路径> <几批操作的 JSON：[[操作, …], …]>
import { createTask } from "../../src/lib/create_task.ts";
import { saveRevision } from "../../src/lib/save_revision.ts";

const [workspaceDir, definitionPath, batches] = process.argv.slice(2);
let n = 0;
const call = () => ({ workspaceDir, sessionId: "s", callId: `c${++n}` });
createTask(call(), { definition_path: definitionPath });
for (const operations of JSON.parse(batches)) saveRevision(call(), { operations });
