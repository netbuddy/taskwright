// 「工作进展」卡：本会话的工作项与任务的各类成果现在怎样。由程序据任务记录算出来（后端的状况接口），不经助手。
// 出现在两处：在已有任务里新建会话时，对话区开头放一张；点输入框旁的「工作进展」、切换工作面板的「查看工作进展」或者打 /状况，在对话里插一张。
// 行：本会话（属于哪个工作项、在第几站，或者是自由讨论）、业务说明、模型、需求条目、这一段还差、待决定（有开着的提议时）。
// 底下两个按钮：开着的提议的进入项（与输入框上方「待决定」一行的按钮是同一个请求），与「请助手说明下一步」（替用户发一句固定的话，由助手回答）。
// 卡上的内容是取数那一刻的；提议在那之后结束了（换了站，或者助手发了新的提议），进入按钮就不能点了。
// 早先卡上另有一节「开展一项活动」，工作项与会话绑定之后退役：启动工作在任务起点页，或者顶栏「当前活动」打开的切换工作面板里。

import { useState } from "react";
import type { MessageRequest, StageProposal, TaskStatusView } from "../../api/types";
import {
  SESSION_ROW_LABEL, STATUS_NEXT_LABEL, STATUS_NEXT_TEXT, STATUS_TITLE, activityLine, descriptionLine, itemsLine, missingLine, modelsLine, statusSubtitle,
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
      <div className="row" data-testid="status-activity"><b>{SESSION_ROW_LABEL}</b><span>{activityLine(status.activity)}</span></div>
      <div className="row" data-testid="status-description"><b>业务说明</b>
        <span>{description.text}{description.open && <>；<em>{description.open}</em></>}</span></div>
      <div className="row" data-testid="status-models"><b>模型</b><span>{modelsLine(status.models)}</span></div>
      <div className="row" data-testid="status-items"><b>需求条目</b><span>{itemsLine(status.items)}</span></div>
      {status.activity.kind !== "idle" && <div className="row" data-testid="status-missing"><b>这一段还差</b><span>{missingLine(status.missing)}</span></div>}
      {proposal && <div className="row" data-testid="status-proposal"><b>{PENDING_LABEL}</b><span>{pendingParts(proposal).join("")}</span></div>}
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
