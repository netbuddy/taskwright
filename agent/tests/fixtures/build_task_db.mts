// 测试夹具：在一个已放好起始文件的任务目录里建任务，再按给定的几批各写一次（发起方执行者）。
// 一批是一个操作列表时保存一次修订；是 { diagram: 保存图的参数, said: 用户说过的话 } 时保存一张图（校验一律算通过，
// said 当作这一轮用户说的一句话，图的「用户的话」来源从里面摘）。
// 是 { reply: 卡片, session: 会话编号 } 时助手发一条带这张卡片的回复（只记「回复」记的那条事件，会话编号不写就是 s）。
// 另有两种由用户做的（user_steps.mts）：{ stage: 阶段名 } 把任务移到那个工作阶段，{ view: [条目编号, …] } 看过这几个条目。
// 后端的读取一侧测试经子进程调用它，写库只经 agent 里真实的核心函数。
// 用法：node build_task_db.mts <任务目录> <任务定义相对路径> <几批的 JSON：[[操作, …], { diagram: {…}, said: "…" }, { stage: "写条目" }, …]>
import { createTask } from "../../src/lib/create_task.ts";
import { recordReplyActs } from "../../src/lib/dialogue_acts.ts";
import { saveDiagram } from "../../src/lib/save_diagram.ts";
import { saveRevision } from "../../src/lib/save_revision.ts";
import { userStep } from "./user_steps.mts";

const [workspaceDir, definitionPath, batches] = process.argv.slice(2);
let n = 0;
const call = () => ({ workspaceDir, sessionId: "s", callId: `c${++n}` });
createTask(call(), { definition_path: definitionPath });
let ops = 0;
for (const batch of JSON.parse(batches)) {
  if (Array.isArray(batch)) saveRevision(call(), { operations: batch });
  else if (batch.reply) {
    const at = call();
    recordReplyActs(workspaceDir, batch.session ?? at.sessionId, [{ id: `u-${at.callId}`, type: "message", message: { role: "user", content: "接着做" } }] as never,
      { informs: [], act: batch.reply }, `reply-${at.callId}`, at.callId);
  }
  else if (userStep(workspaceDir, "s", batch, `ui-fixture-${++ops}`)) continue;
  else await saveDiagram({ ...call(), userMessages: batch.said ? [{ entryId: `u${n}`, text: batch.said }] : [] }, batch.diagram, { validate: async () => ({ ok: true }) });
}
