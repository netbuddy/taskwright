/**
 * 用户在页面上改一张图的 Mermaid 文本（界面操作 edit_diagram）。经扩展命令 /tw-user 进来（hooks/user_commands.ts），不经模型。
 *
 * 与条目的界面修改一样是一次直接写库，只是写的是图：记作这张图自己的一次新修订，发起方是用户。写库用「保存图」的核心函数
 * （lib/save_diagram.ts），与助手画图有三处不同：
 * - Mermaid 文本的写法由任务服务在转交之前校验过（backend/src/executor.ts），这里不再问一遍；/tw-user 只有任务服务能发，模型触发不了。
 * - 不核对文本里写的条目编号是不是现有的条目、画进图里的条目是不是各有来源（saveDiagram 的 userEdit）。
 * - 来源沿用这张图上一次修订的，用户不写来源。
 * 页面这一版只让改 Mermaid 文本；图名、说明、种类与删除由助手来做。
 *
 * 写完往会话里追加的那句说明由调用方发（note），不引出一次运行。图的修订不占任务的修订序号，所以结果里的 revision_no 是 null，
 * 图自己的修订号在 results 里；这一步不能撤销。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import type { DatabaseSync } from "node:sqlite";
import { ACTOR_USER } from "./db.ts";
import { DIAGRAM_ID, latestVersion, readDiagrams } from "./diagram.ts";
import { saveDiagram } from "./save_diagram.ts";
import { NoDatabaseYet, TASK_ACTIVE, withTaskDatabase } from "./schema.ts";
import { ToolRejection } from "./tool_rejection.ts";
import { UserOpError, type UserOpRequest } from "./user_ops.ts";

/** 操作种类。它不在 USER_OP_KINDS 里：写的是图，不经 runUserOperation。 */
export const DIAGRAM_OP_KIND = "edit_diagram";

export interface DiagramOpResult {
  op_id: string;
  kind: typeof DIAGRAM_OP_KIND;
  event_seqs: number[];
  results: { diagram_id: string; revision_no: number }[];
  revision_no: null;
  note: string;
  undoable: false;
}

function inDatabase<T>(workspaceDir: string, body: (db: DatabaseSync) => T): T {
  try {
    return withTaskDatabase(workspaceDir, { createIfMissing: false }, body);
  } catch (error) {
    if (error instanceof NoDatabaseYet) throw new UserOpError("no_task", "这个任务目录里还没有任务记录。");
    throw error;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 追加进会话的那句说明。 */
export const diagramEditNote = (id: string, name: string, revisionNo: number): string =>
  `界面操作（不是用户打的字）：用户在界面上改了图 ${id}「${name}」的 Mermaid 文本，${id} 现在是修订 ${revisionNo}。要看现在的文本，用 get_item 写 ${id}。`;

export async function editDiagram(ctx: { workspaceDir: string; sessionId: string }, request: UserOpRequest): Promise<DiagramOpResult> {
  const opId = typeof request.op_id === "string" ? request.op_id : "";
  if (!opId.startsWith("ui-")) throw new UserOpError("bad_request", "操作编号 op_id 应当由后端生成，以 ui- 开头。");
  const target = Array.isArray(request.targets) && request.targets.length === 1 ? request.targets[0] : null;
  if (!isObject(target) || typeof target.diagram_id !== "string" || !Number.isInteger(target.base_revision)) {
    throw new UserOpError("bad_request", "edit_diagram 的 targets 只能有一项，写 { \"diagram_id\": 图的编号, \"base_revision\": 整数 }。");
  }
  const id = target.diagram_id;
  const base = target.base_revision as number;
  const fields = request.fields;
  if (!isObject(fields) || typeof fields.mermaid !== "string" || fields.mermaid.trim() === "" || Object.keys(fields).some((key) => key !== "mermaid")) {
    throw new UserOpError("bad_request", "edit_diagram 的 fields 只写 { \"mermaid\": 改后的 Mermaid 文本 }，文本不能是空的。");
  }
  const mermaid = fields.mermaid;

  // 先把给用户看的几种拒绝分清楚：任务已经结束、没有这张图、图在这之后改过、文本没有变。之后的写库由 saveDiagram 再核对一遍。
  const name = inDatabase(ctx.workspaceDir, (db) => {
    const task = db.prepare("SELECT task_id, status FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; status: string } | undefined;
    if (!task) throw new UserOpError("no_task", "这个任务目录里还没有任务记录。");
    if (typeof request.task_id === "string" && request.task_id !== "" && request.task_id !== task.task_id) {
      throw new UserOpError("bad_request", `task_id 写的是 ${request.task_id}，这个库里的任务是 ${task.task_id}。`);
    }
    if (task.status !== TASK_ACTIVE) throw new UserOpError("task_closed", `任务已经${task.status}，不能再改。`, { status: task.status });
    const record = DIAGRAM_ID.test(id) ? readDiagrams(db, task.task_id).find((one) => one.diagram_id === id) : undefined;
    const current = record ? latestVersion(record) : null;
    if (!record || !current || record.deleted_in_revision !== null) {
      throw new UserOpError("rejected", `图 ${id} 不存在或已经删除。`, { reasons: [`图 ${id} 不存在或已经删除`] });
    }
    if (current.revision_no !== base) {
      throw new UserOpError("stale_revision", `图 ${id} 刚被改过（可能是助手，也可能是另一个页面），现在是修订 ${current.revision_no}，请看最新内容后再改。`,
        { diagrams: [{ diagram_id: id, base_revision: base, current_revision: current.revision_no, changed_by: current.actor === ACTOR_USER ? "user" : "executor" }] });
    }
    if (current.mermaid === mermaid) {
      throw new UserOpError("rejected", `图 ${id} 的 Mermaid 文本没有改动。`, { reasons: ["Mermaid 文本与现在的一样"] });
    }
    return current.name;
  });

  try {
    const outcome = await saveDiagram(
      { workspaceDir: ctx.workspaceDir, sessionId: ctx.sessionId, callId: opId, actor: ACTOR_USER },
      { diagram: id, base_revision: base, mermaid },
      { validate: async () => ({ ok: true }), userEdit: true },
    );
    const details = outcome.details as { revision_no: number; event_seq: number };
    return {
      op_id: opId, kind: DIAGRAM_OP_KIND, event_seqs: [details.event_seq], results: [{ diagram_id: id, revision_no: details.revision_no }],
      revision_no: null, note: diagramEditNote(id, name, details.revision_no), undoable: false,
    };
  } catch (error) {
    // 两次核对之间库变了（很少见）：saveDiagram 的话是写给助手看的，这里只取其中说事实的那一句。
    if (error instanceof ToolRejection) throw new UserOpError("rejected", `图 ${id} 没有保存：${error.fact}。`, { reasons: [error.fact] });
    throw error;
  }
}
