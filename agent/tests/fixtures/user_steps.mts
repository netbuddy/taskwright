// 测试夹具共用：几批数据里由用户做的两种，build_task_db.mts 与 save_more.mts 都认。
// { stage: 阶段名 } 是用户让夹具的这条会话处在那个工作阶段：这条会话还没有在做流程的工作项时，启动一个首次分析的工作项、从这个阶段开始；
// 已经在做时，把它移到这个阶段。{ view: [条目编号或图的编号, …] } 是用户看过这几个条目、这几张图当前的内容。
// 有「总体分析」集合的任务，助手的会话要在写条目阶段、并且已经有一页用户看过的主题，才能写别的集合的条目，所以这样的夹具里要有这两种。
// 助手能写什么看的是它所在的会话：夹具里助手的调用与这两种用户的步骤用同一个会话编号。
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "../../src/lib/db.ts";
import { DIAGRAM_ID } from "../../src/lib/diagram.ts";
import { DIAGRAM_VIEW_OP_KIND, markDiagramViewed } from "../../src/lib/user_diagram.ts";
import { openActivityRecord } from "../../src/lib/stage_read.ts";
import { UserOpError, runUserOperation } from "../../src/lib/user_ops.ts";

/** 条目当前所在的修订号。 */
function revisionOf(workspaceDir: string, itemId: string): number {
  const db = new DatabaseSync(databasePath(workspaceDir), { readOnly: true });
  try {
    return Number((db.prepare("SELECT MAX(revision_no) AS n FROM item_version WHERE item_id = ?").get(itemId) as { n: number }).n);
  } finally {
    db.close();
  }
}

/** 图当前所在的修订号（图自己的）。 */
function diagramRevisionOf(workspaceDir: string, diagramId: string): number {
  const db = new DatabaseSync(databasePath(workspaceDir), { readOnly: true });
  try {
    return Number((db.prepare("SELECT MAX(revision_no) AS n FROM diagram_version WHERE diagram_id = ?").get(diagramId) as { n: number }).n);
  } finally {
    db.close();
  }
}

/** 这条会话是不是正在做一个流程的工作项。 */
function inFlow(workspaceDir: string, sessionId: string): boolean {
  const db = new DatabaseSync(databasePath(workspaceDir), { readOnly: true });
  try {
    const task = db.prepare("SELECT task_id FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string } | undefined;
    const open = task ? openActivityRecord(db, task.task_id, sessionId) : null;
    return open !== null && open.flow !== null;
  } finally {
    db.close();
  }
}

/** 这一批是不是由用户做的那两种；是就做掉并返回真。opId 是这次界面操作的操作编号（同一个任务里不能重复）。 */
export function userStep(workspaceDir: string, sessionId: string, batch: unknown, opId: string): boolean {
  if (Array.isArray(batch) || typeof batch !== "object" || batch === null) return false;
  const one = batch as { stage?: string; view?: string[] };
  const ui = { workspaceDir, sessionId };
  if (one.stage) {
    try {
      if (inFlow(workspaceDir, sessionId)) runUserOperation(ui, { op_id: opId, kind: "move_stage", fields: { stage: one.stage } });
      else runUserOperation(ui, { op_id: opId, kind: "start_activity", fields: { activity: one.stage, in_flow: true } });
    } catch (error) {
      // 早先建的任务没有阶段：这一步什么都不做，夹具照常往下走。
      if (!(error instanceof UserOpError && error.message === "这个任务没有阶段。")) throw error;
    }
    return true;
  }
  if (one.view) {
    const diagrams = one.view.filter((id) => DIAGRAM_ID.test(id));
    const items = one.view.filter((id) => !DIAGRAM_ID.test(id));
    if (items.length) runUserOperation(ui, { op_id: opId, kind: "mark_viewed", targets: items.map((id) => ({ item_id: id, base_revision: revisionOf(workspaceDir, id) })) });
    if (diagrams.length) {
      markDiagramViewed(ui, { op_id: `${opId}-d`, kind: DIAGRAM_VIEW_OP_KIND, targets: diagrams.map((id) => ({ diagram_id: id, base_revision: diagramRevisionOf(workspaceDir, id) })) });
    }
    return true;
  }
  return false;
}
