// 提交交付物的提示条（条目区顶部，绿色，只有「已完成，提交交付物」一个按钮）：什么时候显示、问句怎么写。
// 完成条件满没满足只看后端算好的 task.completion.all_met（与「完成任务」同一组核对），页面不另算；问句里的数字与事实照数据填写。
// 与助手的卡片不同时出现：本会话的对话里有一张还没回应的「这个任务是否已经完成」卡片时不显示。

import type { AssistantReply, ConversationMessage, Task } from "../api/types";
import { COMPLETE_KEY } from "../../../agent/src/lib/completion_consent.ts";
import { CONFIRM_CONDITION, REVIEW_CONDITION, keepPendingField } from "./items";

/** 完成条件「没有状态为未解决的条目」的名称（agent/src/lib/conditions.ts）。 */
export const UNRESOLVED_CONDITION = "没有状态为未解决的条目";

/** 对话里最近一张「这个任务是否已经完成」卡片（请选择，有一项 key 为 complete）还没回应：它之后还没有用户的话。 */
export function pendingSubmitCard(messages: ConversationMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== "assistant_reply") continue;
    const act = (m as AssistantReply).act;
    if (act?.kind !== "choose" || !(act.options ?? []).some((o) => o.key === COMPLETE_KEY)) continue;
    return !messages.slice(i + 1).some((later) => later.type === "user_message");
  }
  return false;
}

/** 提示条显示不显示：任务进行中、完成条件全部满足、助手不在工作、对话里没有还没回应的提交卡片。 */
export function showSubmitBar(task: Task, working: boolean, messages: ConversationMessage[]): boolean {
  return task.status === "进行中" && !!task.completion?.all_met && !working && !pendingSubmitCard(messages);
}

/**
 * 提示条的问句：写明事实与后果。分三段，各段之间用分号：
 * ①点名有条目的集合与条目总数（要求评审的集合；没有时是问题条目之外有条目的集合），完成条件里有评审、用户确认时各说一句；
 * ②要求用户确认、但不在①里的集合（例如领域说明），单独点名并写条目个数：「2 条领域说明你也都看过了」；
 * ③要求没有未解决条目的集合（例如问题）有条目时写「2 个问题都已经解决或者由你决定保留」，一个条目都没有时不写。
 * 末尾问是否已经完成、说清提交之后的后果，这两句是定稿，不随条目变。
 */
export function submitQuestion(task: Task): string {
  const conditions = task.completion?.conditions ?? [];
  const has = (collection: string, name: string) => conditions.some((c) => c.collection === collection && c.name === name);
  const countOf = (collection: string) => task.items.filter((i) => i.collection === collection).length;
  const filled = task.definition.collections.filter((c) => countOf(c.name) > 0);
  const reviewed = filled.filter((c) => has(c.name, REVIEW_CONDITION));
  const listed = reviewed.length ? reviewed : filled.filter((c) => keepPendingField(task, c.name) === null);
  const count = listed.reduce((n, c) => n + countOf(c.name), 0);
  const facts = [
    ...(reviewed.length ? ["都已经评审通过或者由你保留了写法"] : []),
    ...(listed.some((c) => has(c.name, CONFIRM_CONDITION)) ? ["你也都看过了"] : []),
  ];
  const read = filled.filter((c) => !listed.includes(c) && keepPendingField(task, c.name) === null && has(c.name, CONFIRM_CONDITION));
  const issues = filled.filter((c) => has(c.name, UNRESOLVED_CONDITION));
  const parts = [
    ...(listed.length ? [`${listed.map((c) => c.name).join("、")}一共 ${count} 个条目${facts.map((f) => "，" + f).join("")}`] : []),
    ...(read.length ? [`${read.map((c) => `${countOf(c.name)} 条${c.name}`).join("、")}你也都看过了`] : []),
    ...(issues.length ? [`${issues.map((c) => `${countOf(c.name)} 个${c.name}`).join("、")}都已经解决或者由你决定保留`] : []),
  ];
  return `${parts.length ? parts.join("；") + "。" : ""}这个任务是否已经完成？提交之后交付物不能再改，仍然可以生成文档。`;
}
