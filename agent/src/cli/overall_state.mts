// 总体分析那几样计算结果的命令行入口：模拟器的评测（Python）经 Node 子进程调用它，库以只读方式打开。
// 待核实、提到与各页的情况怎样算只有 agent 里那一份（lib/overall_read.ts 的 overallState），这里不另写一套。
// 用法：node overall_state.mts <库文件> <任务编号>
// 输出：{"has_overall": 任务定义里有没有总体分析这个集合,
//        "verification": {条目编号: {pending_verification, pending_sources, pending_places, basis_pending}},
//        "mentions": {被提到的页的编号: [{item_id, collection, field, index, word, sentence, revision_no}]},
//        "pages": [{item_id, tagged, deprecated, examples, pending}],
//        "lamps": {灯的键: {ok, items, summary}}}
// lamps 是产品自己算出的几盏灯（lib/stage.ts 的 stageLamps），只给下面这十二盏：与图、规则冲突有关的七盏，与问题是否阻断下游、待定标记、各章导语、术语有关的五盏。前七盏要扫图的 Mermaid 文本、
// 要算规则表，评测不另写一套。ok 为 true 是通过，false 是不通过，null 是不适用。任务定义里没有总体分析集合时是空的。
// 任务定义取库里创建任务那一刻的快照。库里没有这个任务时写一句原因到标准错误，退出码 1。
import { DatabaseSync } from "node:sqlite";
import { validateDefinition } from "../lib/definition.ts";
import { hasOverall } from "../lib/overall_analysis.ts";
import { overallState } from "../lib/overall_read.ts";
import { stageLamps } from "../lib/stage.ts";
import { lampFacts } from "../lib/stage_read.ts";

/** 由这里交给评测的十二盏灯：整理建模里看图与规则表的五盏，写条目里看图的两盏、看问题与待定标记的两盏，编写文档的三盏。 */
const PRODUCT_LAMPS = [
  "roles_in_context_and_use_cases", "concepts_related_in_class", "flows_have_flowchart_with_branch", "stateful_concepts_have_state", "rules_no_conflict",
  "flows_backed_by_use_cases", "basis_diagrams_viewed",
  "no_blocking_questions", "no_pending_marks", "chapters_have_intro", "glossary_complete", "document_no_blocking_questions",
];

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
  // 这十二盏只看库里的内容；要看任务目录的三样（材料、评审、完成条件）这里填空的，它们的灯不从这里出。
  const all = hasOverall(definition.collections)
    ? Object.values(stageLamps({ ...lampFacts(db, taskId, definition), materials: [], review: { failing: [], any: false }, completion: { satisfied: false, unmet: [] } })).flat()
    : [];
  process.stdout.write(JSON.stringify({
    has_overall: hasOverall(definition.collections),
    verification: Object.fromEntries(state.verification),
    mentions: Object.fromEntries(state.mentions),
    pages: state.pages,
    lamps: Object.fromEntries(all.filter((one) => PRODUCT_LAMPS.includes(one.key)).map((one) => [one.key, { ok: one.ok, items: one.items, summary: one.summary }])),
  }));
} finally {
  db.close();
}
