/**
 * 「完成任务」的核心逻辑：只做事实核对——按任务定义的「完成条件」逐项调用
 * conditions.ts 里的核对函数（与看板、查询任务状态同一组函数），全部满足才把任务标为已完成并记一条事件；
 * 不满足就拒绝，逐条说明缺什么。它不判断内容好坏。
 *
 * 开发期开关：评审工具还没有，「每个条目评审通过」这一条永远满足不了。开关打开时，这一条暂时视为满足，
 * 事件与返回里如实写明是开关让它通过的。开关默认关，演练时打开；由调用方把开关的值传进来，completeTask 本身不读环境变量。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { ACTOR_EXECUTOR, emit, wallClockText } from "./db.ts";
import { CONFIRM_CONDITION, checkCompletion, type ConditionResult, unreadItems, unreadList } from "./conditions.ts";
import { NoDatabaseYet, TASK_ACTIVE, TASK_DONE, withTaskDatabase } from "./schema.ts";
import { validateDefinition } from "./definition.ts";

export const EVENT_TASK_COMPLETED = "TASK_COMPLETED";

/** 开发期开关打开时视为满足的条件名。 */
export const REVIEW_CONDITION = "每个条目评审通过";

/** 开发期开关的环境变量名。「完成任务」工具读它；看板与「查询任务状态」也读它，好让执行者知道哪一条会被视为满足。 */
export const REVIEW_SWITCH_ENV = "TASKWRIGHT_DEV_REVIEW_AS_MET";

export function reviewSwitchOn(): boolean {
  return process.env[REVIEW_SWITCH_ENV] === "1";
}

export interface CompleteCall {
  workspaceDir: string;
  sessionId: string;
  callId: string;
  /** 开发期开关：为真时「每个条目评审通过」暂时视为满足。 */
  treatReviewAsMet?: boolean;
}

export interface CompleteOutcome {
  text: string;
  details: { task_id: string; event_seq: number; status: string; waived: string[] };
}

function describe(r: ConditionResult): string {
  const items = (r.unmet ?? []).map((u) => u.item).filter(Boolean);
  return `「${r.collection}」${r.condition}：${r.summary}${items.length ? `还差 ${items.join("、")}。` : ""}`;
}

export function completeTask(call: CompleteCall): CompleteOutcome {
  try {
    return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => {
      const task = db.prepare("SELECT task_id, status, definition_text FROM task ORDER BY started_at LIMIT 1").get() as
        | { task_id: string; status: string; definition_text: string }
        | undefined;
      if (!task) throw new Error("库里还没有任务，没有可以完成的任务。");
      if (task.status !== TASK_ACTIVE) throw new Error(`这个任务的状态是「${task.status}」，不能再完成一次。`);
      const definition = validateDefinition(JSON.parse(task.definition_text));
      const results = checkCompletion(db, task.task_id, definition.completion);
      const waived = results.filter((r) => !r.satisfied && call.treatReviewAsMet && r.condition === REVIEW_CONDITION);
      const unmet = results.filter((r) => !r.satisfied && !waived.includes(r));
      if (unmet.length) {
        // 未读的条目单独成一句，执行者可以原样转告用户；其余没满足的条件逐条列出。
        const unread = unreadItems(db, task.task_id, definition.completion,
          (name) => definition.collections.find((c) => c.name === name)?.fields[0]?.name);
        const others = unmet.filter((r) => r.condition !== CONFIRM_CONDITION);
        throw new Error(
          "任务没有标为已完成。\n" +
            (unread.length ? `还有 ${unread.length} 条你从没看过：${unreadList(unread)}。\n` : "") +
            (others.length ? `另有 ${others.length} 条完成条件没有满足：\n${others.map((r, i) => `${i + 1}. ${describe(r)}`).join("\n")}\n` : "") +
            (unread.length ? "请把上面「还有 N 条你从没看过」那句原样告诉用户，请用户打开这几条看一眼；" : "请把缺的告诉用户；") +
            "补齐之后再调用「完成任务」。",
        );
      }
      const at = wallClockText();
      const waivedNames = waived.map((r) => `「${r.collection}」${r.condition}`);
      const seq = emit(db, {
        taskId: task.task_id,
        sessionId: call.sessionId,
        callId: call.callId,
        name: EVENT_TASK_COMPLETED,
        payload: { status_before: TASK_ACTIVE, status_after: TASK_DONE, waived: waivedNames },
        actor: ACTOR_EXECUTOR,
      });
      db.prepare("UPDATE task SET status = ?, ended_at = ? WHERE task_id = ?").run(TASK_DONE, at, task.task_id);
      const text = `任务 ${task.task_id} 已标为已完成：完成条件 ${results.length} 条全部满足。` +
        (waivedNames.length ? `其中 ${waivedNames.join("、")} 是开发期开关让它视为满足的（评审工具还没有），不是真的评审通过。` : "");
      return { text, details: { task_id: task.task_id, event_seq: seq, status: TASK_DONE, waived: waivedNames } };
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) throw new Error("这个任务目录还没有任务数据库，没有可以完成的任务。");
    throw error;
  }
}
