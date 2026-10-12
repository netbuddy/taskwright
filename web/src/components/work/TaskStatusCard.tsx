// 「任务状况」卡：任务现在做到哪里了。由程序据任务记录算出来（后端的状况接口），不经助手。
// 出现在两处：在已有任务里新建会话时，对话区第一条是它；点输入框旁的「任务状况」或者打 /状况，在对话里插一张。
// 行：阶段、业务说明、模型、需求条目、这一段还差、待决定（有开着的提议时）。底下两个按钮：开着的提议的进入项（与输入框上方
// 「待决定」一行的按钮是同一个请求），与「请助手说明下一步」（替用户发一句固定的话，由助手回答）。
// 卡上的内容是取数那一刻的；提议在那之后结束了（任务的阶段移动过，或者助手发了新的提议），进入按钮就不能点了。
// 组件里留了一块不显示的「开展一项活动」区域：以后任务里可以单独开展一项活动时放在这里。

import { useState } from "react";
import type { MessageRequest, StageProposal, TaskStatusView } from "../../api/types";
import {
  STATUS_NEXT_LABEL, STATUS_NEXT_TEXT, STATUS_TITLE, activityLine, descriptionLine, itemsLine, missingLine, modelsLine, statusSubtitle,
} from "../../model/taskStatus";
import { PENDING_LABEL, actOnProposal, pendingParts } from "./PendingProposal";
import type { ReviewedHandler } from "./ReplyCard";
import type { SendResult } from "./sendRestore";

export function TaskStatusCard({ status, liveProposal, off = false, offTitle, onMessage, onSend, onReviewed }: {
  status: TaskStatusView;
  /** 任务现在开着的提议（整份数据的 stage.proposal）：卡上的提议还是不是它，决定进入按钮能不能点。 */
  liveProposal: StageProposal | null | undefined;
  /** 现在不能发话（任务已结束、助手正在工作、有未保存的编辑等）：两个按钮灰化。 */
  off?: boolean;
  offTitle?: string;
  /** 点进入：与点卡片上的进入项相同。 */
  onMessage: (text: string, card?: MessageRequest["card"]) => SendResult;
  /** 「请助手说明下一步」：发一句普通的话。 */
  onSend: (text: string) => SendResult;
  /** 请过目的提议点了「看过了，生成文档」。 */
  onReviewed?: ReviewedHandler;
}) {
  const [entered, setEntered] = useState(false);
  const [asked, setAsked] = useState(false);
  const description = descriptionLine(status.description);
  const proposal = status.proposal;
  const stillOpen = !!proposal && liveProposal?.event_seq === proposal.event_seq;
  const enter = () => {
    if (!proposal || off || entered || !stillOpen) return;
    setEntered(true);
    void actOnProposal(proposal, onMessage, onReviewed).then((ok) => { if (!ok) setEntered(false); });
  };
  const askNext = () => {
    if (off || asked) return;
    setAsked(true);
    void Promise.resolve(onSend(STATUS_NEXT_TEXT)).then((ok) => { if (ok === false) setAsked(false); });
  };
  return (
    <div className="tstatus" data-testid="task-status" data-activity={status.activity.key}>
      <div className="k">{STATUS_TITLE} <small>{statusSubtitle(status)}</small></div>
      <div className="row" data-testid="status-activity"><b>阶段</b><span>{activityLine(status.activity)}</span></div>
      <div className="row" data-testid="status-description"><b>业务说明</b>
        <span>{description.text}{description.open && <>；<em>{description.open}</em></>}</span></div>
      <div className="row" data-testid="status-models"><b>模型</b><span>{modelsLine(status.models)}</span></div>
      <div className="row" data-testid="status-items"><b>需求条目</b><span>{itemsLine(status.items)}</span></div>
      <div className="row" data-testid="status-missing"><b>这一段还差</b><span>{missingLine(status.missing)}</span></div>
      {proposal && <div className="row" data-testid="status-proposal"><b>{PENDING_LABEL}</b><span>{pendingParts(proposal).join("")}</span></div>}
      {/* 以后任务里可以单独开展一项活动时放在这里；现在只有一条流程，不显示。 */}
      <div className="activities" hidden data-testid="status-activities" aria-label="开展一项活动" />
      <div className="acts">
        {proposal && (
          <button type="button" className="btn sm pri" disabled={off || entered || !stillOpen} title={off ? offTitle : !stillOpen ? "这个提议已经结束了" : undefined}
            onClick={enter} data-testid="status-enter">{proposal.enter.text}</button>
        )}
        <button type="button" className="btn sm" disabled={off || asked} title={off ? offTitle : undefined} onClick={askNext} data-testid="status-next">{STATUS_NEXT_LABEL}</button>
      </div>
    </div>
  );
}
