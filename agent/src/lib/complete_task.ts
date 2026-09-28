/**
 * 「完成任务」的核心逻辑：只做事实核对——按任务定义的「完成条件」逐项调用
 * conditions.ts 里的核对函数（与看板、查询任务状态同一组函数），全部满足才把任务标为已完成并记一条事件；
 * 不满足就拒绝，逐条说明缺什么。它不判断内容好坏。
 *
 * 完成条件都满足之后，再核对用户同意了提交交付物（lib/completion_consent.ts）：任务标为已完成之后只读、不能撤回，
 * 所以要用户在「这个任务是否已经完成」的卡片上点过「已完成，提交交付物」，而且点了之后交付物没有新的修订。
 * 条件不满足时只报条件，不提同意，免得助手在条件还没满足时就去问用户。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { ACTOR_EXECUTOR, emit, wallClockText } from "./db.ts";
import { CONFIRM_CONDITION, checkCompletion, type ConditionResult, unreadItems, unreadList } from "./conditions.ts";
import { NoDatabaseYet, TASK_ACTIVE, TASK_DONE, withTaskDatabase } from "./schema.ts";
import { validateDefinition } from "./definition.ts";
import { ToolRejection } from "./tool_rejection.ts";
import { AGREE_TEXT, COMPLETE_KEY, type CardClick, type Consent, DECLINE_TEXT, judgeConsent } from "./completion_consent.ts";
import type { DatabaseSync } from "node:sqlite";

export const EVENT_TASK_COMPLETED = "TASK_COMPLETED";

export interface CompleteCall {
  workspaceDir: string;
  sessionId: string;
  callId: string;
  /**
   * 用户的同意从哪里来：助手调用时是会话里最近一次对完成卡片的点击（lib/completion_consent.ts 的 lastCompletionClick），没有时为空；
   * 用户在页面的提示条上点「已完成，提交交付物」并确认时（直接操作 submit_deliverable）是页面当时看到的修订号。
   */
  consent?: { source: "card"; click: CardClick } | { source: "page"; revisionNo: number } | null;
  /** 事件的发起方：助手调用时是执行者（缺省），页面上的直接操作是用户。 */
  actor?: string;
}

/** 拒绝时给助手的指引：怎样问用户这个任务是否已经完成。 */
export const CONSENT_GUIDANCE =
  "请用回复的请选择（choose）问用户这个任务是否已经完成：问句照实写出事实与后果，例如「功能用例、非功能需求、约束一共 12 个条目，" +
  "都已经评审通过或者由你保留了写法，你也都看过了，没有未解决的问题。这个任务是否已经完成？提交之后交付物不能再改，仍然可以生成文档。」" +
  `（数字与事实照实填写）；两个选项是 { key: "${COMPLETE_KEY}", text: "${AGREE_TEXT}" } 与「${DECLINE_TEXT}」。` +
  `用户在卡片上点了「${AGREE_TEXT}」之后再调用「完成任务」；用户在对话里打字说要完成不算，照样先发卡片。`;

/** 卡片点击换成同意：点击之后那句话记进对话行为表时的事件序号，定下点的时候交付物是哪次修订。库里找不到那一行时为空。 */
function cardConsent(db: DatabaseSync, taskId: string, sessionId: string, click: CardClick): Consent | null {
  const row = db.prepare("SELECT event_seq FROM dialogue_act WHERE task_id = ? AND session_id = ? AND speaker = 'user' AND origin = 'ui' AND source_entry = ? " +
    "ORDER BY rowid LIMIT 1").get(taskId, sessionId, click.userEntryId) as { event_seq: number } | undefined;
  if (!row) return null;
  const revisionNo = Number((db.prepare("SELECT COALESCE(MAX(revision_no), 0) AS n FROM revision WHERE task_id = ? AND event_seq < ?")
    .get(taskId, row.event_seq) as { n: number }).n);
  return { source: "card", agreed: click.optionKey === COMPLETE_KEY, revisionNo, optionText: click.optionText };
}

export interface CompleteOutcome {
  text: string;
  details: { task_id: string; event_seq: number; status: string };
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
      const results = checkCompletion(db, task.task_id, definition.completion, { workspaceDir: call.workspaceDir });
      const unmet = results.filter((r) => !r.satisfied);
      if (unmet.length) {
        // 未读的条目单独成一句，执行者可以原样转告用户；其余没满足的条件逐条列出。
        const unread = unreadItems(db, task.task_id, definition.completion,
          (name) => definition.collections.find((c) => c.name === name)?.fields[0]?.name);
        const others = unmet.filter((r) => r.condition !== CONFIRM_CONDITION);
        const fact = "任务没有标为已完成。\n" +
          (unread.length ? `还有 ${unread.length} 条你从没看过：${unreadList(unread)}。\n` : "") +
          (others.length ? `另有 ${others.length} 条完成条件没有满足：\n${others.map((r, i) => `${i + 1}. ${describe(r)}`).join("\n")}\n` : "");
        const guidance = (unread.length ? "请把上面「还有 N 条你从没看过」那句原样告诉用户，请用户打开这几条看一眼；" : "请把缺的告诉用户；") +
          "补齐之后再调用「完成任务」。";
        throw new ToolRejection(fact + guidance, fact.trimEnd(), guidance);
      }
      const latest = Number((db.prepare("SELECT COALESCE(MAX(revision_no), 0) AS n FROM revision WHERE task_id = ?").get(task.task_id) as { n: number }).n);
      const consent = call.consent?.source === "card" ? cardConsent(db, task.task_id, call.sessionId, call.consent.click)
        : call.consent?.source === "page" ? { source: "page" as const, agreed: true, revisionNo: call.consent.revisionNo } : null;
      const verdict = judgeConsent(consent, latest);
      if (!verdict.ok && consent?.source === "page") {
        // 页面上的提交：同意就是这次点击，没同过意与点的是另一项都不会出现；只可能是页面看到的修订已经不是现在的。说明是给用户看的。
        const stale = verdict.reason === "stale" ? verdict : { revisionNo: consent.revisionNo, latest };
        const fact = `这次没有提交：你看到的是修订 ${stale.revisionNo}，交付物现在已经是修订 ${stale.latest}。请看过现在的内容再提交。`;
        throw new ToolRejection(fact, fact, "");
      }
      if (!verdict.ok) {
        const fact = "任务没有标为已完成：" + (verdict.reason === "none"
          ? `用户还没有在问这个任务是否已经完成的卡片上点「${AGREE_TEXT}」。`
          : verdict.reason === "declined"
            ? `用户在最近一张问这个任务是否已经完成的卡片上选的是「${verdict.optionText ?? DECLINE_TEXT}」。`
            : `用户在修订 ${verdict.revisionNo} 时点了「${AGREE_TEXT}」，之后交付物又有了修订 ${verdict.latest}，要重新问。`);
        throw new ToolRejection(`${fact}\n${CONSENT_GUIDANCE}`, fact, CONSENT_GUIDANCE);
      }
      const at = wallClockText();
      const seq = emit(db, {
        taskId: task.task_id,
        sessionId: call.sessionId,
        callId: call.callId,
        name: EVENT_TASK_COMPLETED,
        payload: { status_before: TASK_ACTIVE, status_after: TASK_DONE },
        actor: call.actor ?? ACTOR_EXECUTOR,
      });
      db.prepare("UPDATE task SET status = ?, ended_at = ? WHERE task_id = ?").run(TASK_DONE, at, task.task_id);
      const text = `任务 ${task.task_id} 已标为已完成：完成条件 ${results.length} 条全部满足。`;
      return { text, details: { task_id: task.task_id, event_seq: seq, status: TASK_DONE } };
    });
  } catch (error) {
    if (error instanceof NoDatabaseYet) throw new Error("这个任务目录还没有任务数据库，没有可以完成的任务。");
    throw error;
  }
}
