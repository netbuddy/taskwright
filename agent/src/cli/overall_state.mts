// 总体分析那几样计算结果的命令行入口：模拟器的评测（Python）经 Node 子进程调用它，库以只读方式打开。
// 待核实、提到与各页的情况怎样算只有 agent 里那一份（lib/overall_read.ts 的 overallState），这里不另写一套。
// 用法：node overall_state.mts <库文件> <任务编号>
// 输出：{"has_overall": 任务定义里有没有总体分析这个集合,
//        "verification": {条目编号: {pending_verification, pending_sources, pending_places, basis_pending}},
//        "mentions": {被提到的页的编号: [{item_id, collection, field, index, word, sentence, revision_no}]},
//        "pages": [{item_id, tagged, deprecated, examples, pending}]}
// 任务定义取库里创建任务那一刻的快照。库里没有这个任务时写一句原因到标准错误，退出码 1。
import { DatabaseSync } from "node:sqlite";
import { validateDefinition } from "../lib/definition.ts";
import { hasOverall } from "../lib/overall_analysis.ts";
import { overallState } from "../lib/overall_read.ts";

const [dbPath, taskId] = process.argv.slice(2);
if (!dbPath || !taskId) {
  process.stderr.write("用法：node overall_state.mts <库文件> <任务编号>\n");
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const task = db.prepare("SELECT definition_text FROM task WHERE task_id = ?").get(taskId) as { definition_text: string } | undefined;
  if (!task) {
    process.stderr.write(`库里没有任务 ${taskId}。\n`);
    process.exit(1);
  }
  const definition = validateDefinition(JSON.parse(task.definition_text));
  const state = overallState(db, taskId, definition);
  process.stdout.write(JSON.stringify({
    has_overall: hasOverall(definition.collections),
    verification: Object.fromEntries(state.verification),
    mentions: Object.fromEntries(state.mentions),
    pages: state.pages,
  }));
} finally {
  db.close();
}
