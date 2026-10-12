/**
 * 用户在提议进入下一个阶段的卡片上选了留在这一段的那个选项（页面上写作「继续本阶段」）：界面操作 continue_stage。
 *
 * 它不写库、不发话、不引出助手的一次运行，只往会话里留一条界面操作通知（由 hooks/user_commands.ts 的 /tw-user 追加）：
 * 卡片在页面上据此显示为已选，助手下一次运行时在上下文里看得到用户没有进入。提议仍然开着（lib/stage_proposal.ts），
 * 用户之后从输入框上方的「待决定」一行进入。
 *
 * 请求的 fields 写 { reply_message_id, option_key }：卡片所在那条回复的编号与点的那个选项的键。
 * 先在这条会话的当前分支上找那条回复，核对它是进入卡片、点的键是它上面留在这一段的选项；分支上找不到时（卡片是在另一条会话里发的）
 * 改为核对任务库里开着的提议。任务不在进行中、认不出卡片、点的不是留在这一段的选项，都拒绝。
 */

import { type Entry, chooseActOf } from "./completion_consent.ts";
import { NoDatabaseYet, TASK_ACTIVE, withTaskDatabase } from "./schema.ts";
import { STAGE_NAMES, STAY_TEXT } from "./stage.ts";
import { type ProposalFact, isStayKey, openProposal, proposalOfAct } from "./stage_proposal.ts";
import { UserOpError, type UserOpRequest } from "./user_ops.ts";

export const CONTINUE_STAGE_KIND = "continue_stage";

/** 留在会话里的那句话：给助手看的，页面按种类另写一句给用户看的。 */
export function continueStageNote(fact: Pick<ProposalFact, "stage" | "enter">): string {
  return `界面操作（不是用户打的字）：用户在提议「${fact.enter.text}」的卡片上选了「${STAY_TEXT}」，没有进入${STAGE_NAMES[fact.stage]}。` +
    "这个提议仍然开着，用户要进入时会自己点，不用再发同一张卡片。";
}

export interface ContinueStageResult {
  op_id: string;
  kind: typeof CONTINUE_STAGE_KIND;
  note: string;
  /** 卡片所在那条回复的编号、点的键、卡片提议进入的阶段：记进通知的 details，页面据此把那张卡片显示为已选。 */
  reply_entry: string;
  option_key: string;
  stage: string;
}

export function continueStage(ctx: { workspaceDir: string }, branch: readonly Entry[], request: UserOpRequest): ContinueStageResult {
  const opId = typeof request.op_id === "string" && request.op_id ? request.op_id : "";
  if (!opId) throw new UserOpError("bad_request", "界面操作要带 op_id。");
  const fields = (request.fields ?? {}) as { reply_message_id?: unknown; option_key?: unknown };
  const replyEntry = fields.reply_message_id, optionKey = fields.option_key;
  if (typeof replyEntry !== "string" || !replyEntry || typeof optionKey !== "string" || !optionKey) {
    throw new UserOpError("bad_request", "continue_stage 要在 fields 里写 reply_message_id（卡片所在那条回复的编号）与 option_key（点的那个选项的键）。");
  }
  if (!isStayKey(optionKey)) {
    throw new UserOpError("rejected", `「${optionKey}」不是留在这一段的选项。`, { reasons: ["点的不是留在这一段的选项"] });
  }
  const unknown = () => new UserOpError("rejected", "认不出这张卡片：它不是助手提议进入下一个阶段的卡片，或者上面没有这个选项。", { reasons: ["认不出这张卡片"] });
  const card = branch.find((entry) => entry.id === replyEntry);
  let fact: ProposalFact | null = null;
  if (card) {
    fact = proposalOfAct(chooseActOf(card));
    if (fact === null || fact.stay?.key !== optionKey) throw unknown();
  }
  try {
    withTaskDatabase(ctx.workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id, status FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; status: string } | undefined;
      if (!task) throw new UserOpError("no_task", "这个任务目录里还没有任务记录。");
      if (typeof request.task_id === "string" && request.task_id !== "" && request.task_id !== task.task_id) {
        throw new UserOpError("bad_request", `task_id 写的是 ${request.task_id}，这个库里的任务是 ${task.task_id}。`);
      }
      if (task.status !== TASK_ACTIVE) throw new UserOpError("task_closed", `任务已经${task.status}，卡片不能再点。`, { status: task.status });
      if (fact === null) {
        // 这条会话里没有那条回复：卡片是在另一条会话里发的，照任务库里开着的提议核对。
        const open = openProposal(db, task.task_id);
        if (open === null || open.reply_entry !== replyEntry || open.stay?.key !== optionKey) throw unknown();
        fact = open;
      }
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) throw new UserOpError("no_task", "这个任务目录里还没有任务记录。");
    throw error;
  }
  const known = fact as ProposalFact;
  return { op_id: opId, kind: CONTINUE_STAGE_KIND, note: continueStageNote(known), reply_entry: replyEntry, option_key: optionKey, stage: known.stage };
}
