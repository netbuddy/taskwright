// 问题跟着条目走：问题条目（见 keepPendingField）的「条目引用」字段列着它牵涉的条目，这里把问题挂回到那些条目上。
//   · IssueBadge：条目列表行与详情标题行上的琥珀色「问题 N」，N 只数还没了结的问题，为 0 不显示。
//   · ItemIssues：条目详情标题行之下「挂在这条上的问题」一区，每个问题一张卡片；没有问题时整块不渲染。
//     未解决的卡片带一行输入框与「回答」「先不管，保留」：「回答」把「回答 TBD-002：用户写的话」直接发到对话区，
//     输入框为空时只预填对话区输入框、不发送（与「问题」页签上的「回答这个问题」相同，助手工作中也照常可用）；
//     「先不管，保留」走 keep_pending（notify_executor: false）。
//     已了结的卡片变淡，写明处理结果与它所在的修订。问题卡片上没有「修改」：问题写下后只由用户了结。
//   · FromIssueCrumb：从「问题」页签点「牵涉 UC-003」跳来时，详情顶部那一行「‹ 回到问题列表」。
//     这时那张问题卡片排第一张并加粗边框，其余问题折叠成一行「还有 N 个问题 ▸」。
// 灰化：「先不管，保留」与其它写入按钮一致（任务已结束、助手不可用、助手工作中、正在保存）；「回答」只在任务已结束或
// 助手不可用时灰化，输入框里有字、要直接发送时，再按对话区发送键的规矩灰化（助手工作中、有未保存的条目编辑）。都悬停说明原因。
//
// 卡片上的字段：第一个字段是事项；名为「处理结果」的文本字段是了结时写的处理结果（与保存修订工具认问题条目的判据一致，
// 那个工具只允许改状态与处理结果）；其余有内容的文本字段按任务定义的顺序显示；状态以外的枚举字段（例如种类）作小标签。

import { useEffect, useState } from "react";
import type { Item, Task } from "../../api/types";
import { isEmptyValue, isOpenIssue, issueAnswerText, issuesOf, issueStatus, keepPendingField, RESOLVED_VALUE, unresolvedIssuesOf, writeOffReason } from "../../model/items";
import type { SubmitAction } from "./ItemDetail";
import { HOLD_TEXT } from "./ReplyCard";
import { TURN_TEXT } from "./Conversation";

/** 问题条目里了结时写处理结果的字段名，与保存修订工具的判据相同。 */
export const RESULT_FIELD = "处理结果";

/** 列表行与详情标题行上的「问题 N」：牵涉这个条目、还没了结的问题个数；为 0 不显示。 */
export function IssueBadge({ task, itemId }: { task: Task; itemId: string }) {
  const n = unresolvedIssuesOf(task, itemId).length;
  if (n === 0) return null;
  return <span className="chip warn sw-issn" title={`有 ${n} 个牵涉这条的问题还没解决，打开详情可以看到并回答。`} data-testid={`issues-${itemId}`}>问题 {n}</span>;
}

/** 从问题跳来时详情顶部那一行。 */
export function FromIssueCrumb({ issueId, onBack }: { issueId: string; onBack: () => void }) {
  return (
    <div className="sw-iss-crumb" data-testid="from-issue">
      <span className="crumb" role="button" onClick={onBack} data-testid="back-to-issues">‹ 回到问题列表</span>
      <span className="note">你从 {issueId} 跳过来，它牵涉这条。</span>
    </div>
  );
}

export function ItemIssues({ task, itemId, readOnly, writesOff = false, hold = false, pendingItems, submit, onSend, onPrefill, fromIssue = null }: {
  task: Task;
  /** 详情里正在看的条目。 */
  itemId: string;
  readOnly: boolean;
  writesOff?: boolean;
  /** 有未保存的条目编辑：「回答」要发到对话区，与对话区的发送键一样灰化。 */
  hold?: boolean;
  pendingItems: Set<string>;
  submit: SubmitAction;
  /** 把一句话直接发到对话区。 */
  onSend?: (text: string) => void;
  /** 输入框为空时点「回答」：只预填对话区输入框（与「问题」页签上「回答这个问题」同一个预填）。 */
  onPrefill?: (issue: Item) => void;
  /** 从这个问题跳过来的：它排第一张并高亮，其余折叠。 */
  fromIssue?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [itemId, fromIssue]);
  const issues = issuesOf(task, itemId);
  if (issues.length === 0) return null;
  const open = issues.filter((i) => isOpenIssue(task, i)).length;
  const pinned = fromIssue ? issues.find((i) => i.item_id === fromIssue) ?? null : null;
  const rest = pinned ? issues.filter((i) => i !== pinned) : issues;
  const card = (issue: Item, hi = false) => (
    <IssueCard key={issue.item_id} task={task} issue={issue} hi={hi} readOnly={readOnly} writesOff={writesOff} hold={hold}
      pending={pendingItems.has(issue.item_id)} submit={submit} onSend={onSend} onPrefill={onPrefill} />
  );
  return (
    <div className="sw-iss" data-testid="item-issues">
      <div className="sw-iss-h">挂在这条上的问题 {issues.length} 个，{open} 个未解决</div>
      {pinned && card(pinned, true)}
      {pinned && rest.length > 0 && (
        <div className="sw-iss-more" role="button" onClick={() => setExpanded(!expanded)} data-testid="issues-more">
          还有 {rest.length} 个问题 {expanded ? "▾" : "▸"}
        </div>
      )}
      {(!pinned || expanded) && rest.map((i) => card(i))}
    </div>
  );
}

function IssueCard({ task, issue, hi, readOnly, writesOff, hold, pending, submit, onSend, onPrefill }: {
  task: Task; issue: Item; hi: boolean; readOnly: boolean; writesOff: boolean; hold: boolean; pending: boolean;
  submit: SubmitAction; onSend?: (text: string) => void; onPrefill?: (issue: Item) => void;
}) {
  const [answer, setAnswer] = useState("");
  const def = task.definition.collections.find((c) => c.name === issue.collection)!;
  const statusField = keepPendingField(task, issue.collection)!;
  const status = issueStatus(task, issue) ?? "";
  const open = isOpenIssue(task, issue);
  const [first, ...others] = def.fields;
  const filled = (f: (typeof others)[number]) => f.type === "文本" && !isEmptyValue(issue.fields[f.name]);
  const suggestions = others.filter((f) => f.name !== RESULT_FIELD && filled(f));
  const outcomes = others.filter((f) => f.name === RESULT_FIELD && filled(f));
  const kinds = others.filter((f) => f.type === "枚举" && f.name !== statusField.name && !isEmptyValue(issue.fields[f.name]));
  const matter = first ? String(issue.fields[first.name] ?? issue.title) : issue.title;
  const keepOff = readOnly || writesOff || pending;
  const keepTitle = writeOffReason(task, { readOnly, writesOff, pending });
  // 空着只预填，只有任务已结束、助手不可用时不能点；有字要直接发送时，按对话区发送键的规矩。
  const typed = answer.trim() !== "";
  const answerOff = readOnly || (typed && (writesOff || hold));
  const answerTitle = readOnly ? keepTitle : typed && writesOff ? TURN_TEXT : typed && hold ? HOLD_TEXT : undefined;

  const doAnswer = () => {
    if (answerOff) return;
    if (!answer.trim()) { onPrefill?.(issue); return; }
    onSend?.(issueAnswerText(issue.item_id, answer));
    setAnswer("");
  };
  const keep = () => void submit({ kind: "keep_pending", targets: [{ item_id: issue.item_id, base_revision: issue.revision_no }], notify_executor: false },
    `把 ${issue.item_id} 标为先不管`);

  return (
    <div className={`sw-iss-card${open ? "" : " closed"}${hi ? " hi" : ""}`} data-testid={`issue-card-${issue.item_id}`}>
      <div className="head">
        <span className="id">{issue.item_id}</span>
        {kinds.map((f) => <span key={f.name} className="chip">{String(issue.fields[f.name])}</span>)}
        {status && <span className={`chip ${open ? "warn" : status === RESOLVED_VALUE ? "okc" : ""}`}>{status}</span>}
      </div>
      <div className="body">{matter}</div>
      {!open && (
        <div className="res" data-testid={`issue-outcome-${issue.item_id}`}>
          {outcomes.length > 0 ? `${outcomes.map((f) => `${f.name}：${String(issue.fields[f.name])}`).join("；")}（修订 ${issue.revision_no}）`
            : `在修订 ${issue.revision_no} 标为${status}`}
        </div>
      )}
      {open && suggestions.map((f) => <div className="sug" key={f.name}>助手{f.name}：{String(issue.fields[f.name])}</div>)}
      {open && (
        <div className="ans">
          <input value={answer} disabled={readOnly} placeholder="回答这个问题，助手会改到牵涉的条目里…" aria-label={`回答 ${issue.item_id}`}
            onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) doAnswer(); }}
            data-testid={`issue-input-${issue.item_id}`} />
          <button type="button" className="btn sm" disabled={answerOff} title={answerTitle ?? (typed ? "发给助手" : "输入框空着时只把开头填进对话区输入框，不发送")} onClick={doAnswer}
            data-testid={`issue-answer-${issue.item_id}`}>回答</button>
          <button type="button" className="btn sm" disabled={keepOff} title={keepTitle} onClick={keep} data-testid={`issue-keep-${issue.item_id}`}>先不管，保留</button>
        </div>
      )}
    </div>
  );
}
