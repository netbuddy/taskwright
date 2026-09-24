// 核对完成条件的命令行入口：服务端与观测台（都是 Python）经 Node 子进程调用它，库以只读方式打开。
// 核对逻辑与概括句只有 agent 里那一份（lib/conditions.ts），这里不另写一套。
// 用法：node check_completion.mts <库文件> <任务编号> <完成条件的 JSON>
// 输出：{"results": [每项的结果，带 state：met、unmet、empty], "brief": "要完成任务，还差 N 项：……"}
import { DatabaseSync } from "node:sqlite";
import { checkCompletion, completionBrief } from "../lib/conditions.ts";

const [dbPath, taskId, completionJson] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const results = checkCompletion(db, taskId, JSON.parse(completionJson));
  process.stdout.write(JSON.stringify({ results, brief: completionBrief(results) }));
} finally {
  db.close();
}
