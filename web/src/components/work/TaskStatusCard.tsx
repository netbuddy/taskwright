// 「工作进展」卡：本会话的工作项与任务的各类成果现在怎样。由程序据任务记录算出来（后端的状况接口），不经助手。
// 出现在两处：在已有内容的任务里新建会话、还没有人说过话时，对话区开头放一张；点输入框旁的「工作进展」、切换工作面板的「查看工作进展」
// 或者打 /状况，在对话里插一张。任务空着时不放（空任务不进工作台）。
// 行：本会话（属于哪个工作项、在第几站，或者是自由讨论）、版本、工作项、业务说明、模型、需求条目（后三行取资产现状那一格的数量与一句现状）、
// 这一段还差（本会话在做工作项时）、待决定（有开着的提议时）。
// 按钮：开着的提议的进入项（与输入框上方「待决定」一行的按钮是同一个请求）；推荐的工作流程现在能启动时「启动需求分析」或「启动需求变更」
// （进它的输入页，会新建会话，下面一行小字说本会话怎样）；「请助手汇报当前状况」（替用户发一句固定的话，由助手回答）；「其他工作…」（打开切换工作面板）。
// 卡上的内容是取数那一刻的；提议在那之后结束了（换了站，或者助手发了新的提议），进入按钮就不能点了。
// 早先卡上另有一节「开展一项活动」，工作项与会话绑定之后退役：启动工作在任务起点页，或者切换工作面板里。

import { useState } from "react";
import type { MessageRequest, StageProposal, TaskStatusView } from "../../api/types";
import { flowName } from "../../model/stage";
import {
  OTHER_WORK_LABEL, SESSION_ROW_LABEL, STATUS_NEXT_LABEL, STATUS_NEXT_TEXT, STATUS_SUBTITLE, activityLine, assetLine, descriptionLine, itemsLine, launchNote, missingLine, modelsLine,
  recommendedFlow, statusTitle, versionLine, workItemsLine,
} from "../../model/taskStatus";
import { href, go } from "../../router";
import { PENDING_LABEL, actOnProposal, pendingParts } from "./PendingProposal";
import type { ReviewedHandler } from "./ReplyCard";
import type { SendResult } from "./sendRestore";

export function TaskStatusCard({ status, taskId, liveProposal, off = false, offTitle, onMessage, onSend, onReviewed, onOtherWork }: {
  status: TaskStatusView;
  /** 「启动需求分析」要进的输入页属于哪个任务；不给时没有这个按钮。 */
  taskId?: string;
  /** 任务现在开着的提议（整份数据的 stage.proposal）：卡上的提议还是不是它，决定进入按钮能不能点。 */
  liveProposal: StageProposal | null | undefined;
  /** 现在不能发话（任务已结束、助手正在工作、有未保存的编辑等）：按钮灰化。 */
  off?: boolean;
  offTitle?: string;
  /** 点进入：与点卡片上的进入项相同。 */
  onMessage: (text: string, card?: MessageRequest["card"]) => SendResult;
  /** 「请助手汇报当前状况」：发一句普通的话。 */
  onSend: (text: string) => SendResult;
  /** 请过目的提议点了「看过了，生成文档」。 */
  onReviewed?: ReviewedHandler;
  /** 「其他工作…」：打开切换工作面板。不给时没有这个按钮。 */
  onOtherWork?: () => void;
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
  const version = versionLine(status.assets);
  const items = workItemsLine(status.work_items);
  const flow = taskId ? recommendedFlow(status.catalog?.flows) : null;
  const sessionWork = status.activity.kind === "idle" ? null : status.activity.kind === "stage" ? flowName(status.activity.flow) : status.activity.name;
  return (
    <div className="tstatus" data-testid="task-status" data-activity={status.activity.key}>
      <div className="k">{statusTitle(status)} <small>{STATUS_SUBTITLE}</small></div>
      <div className="row" data-testid="status-activity"><b>{SESSION_ROW_LABEL}</b><span>{activityLine(status.activity)}</span></div>
      {version && <div className="row" data-testid="status-version"><b>版本</b><span>{version}</span></div>}
      {items && <div className="row" data-testid="status-work-items"><b>工作项</b><span>{items}</span></div>}
      <div className="row" data-testid="status-description"><b>业务说明</b>
        {assetLine(status.assets, "description") !== null ? <span>{assetLine(status.assets, "description")}</span>
          : <span>{description.text}{description.open && <>；<em>{description.open}</em></>}</span>}</div>
      <div className="row" data-testid="status-models"><b>模型</b><span>{assetLine(status.assets, "models") ?? modelsLine(status.models)}</span></div>
      <div className="row" data-testid="status-items"><b>需求条目</b><span>{assetLine(status.assets, "items") ?? itemsLine(status.items)}</span></div>
      {status.activity.kind !== "idle" && <div className="row" data-testid="status-missing"><b>这一段还差</b><span>{missingLine(status.missing)}</span></div>}
      {proposal && <div className="row" data-testid="status-proposal"><b>{PENDING_LABEL}</b><span>{pendingParts(proposal).join("")}</span></div>}
      <div className="acts">
        {proposal && (
          <button type="button" className="btn sm pri" disabled={off || entered || !stillOpen} title={off ? offTitle : !stillOpen ? "这个提议已经结束了" : undefined}
            onClick={enter} data-testid="status-enter">{proposal.enter.text}</button>
        )}
        {flow && taskId && (
          <button type="button" className={`btn sm${proposal ? "" : " pri"}`} disabled={off} title={off ? offTitle : undefined}
            onClick={() => go(href.start(taskId, flow.key))} data-testid="status-launch">启动{flow.name}</button>
        )}
        <button type="button" className="btn sm" disabled={off || asked} title={off ? offTitle : undefined} onClick={askNext} data-testid="status-next">{STATUS_NEXT_LABEL}</button>
        {onOtherWork && <button type="button" className="btn sm" disabled={off} title={off ? offTitle : undefined} onClick={onOtherWork} data-testid="status-other">{OTHER_WORK_LABEL}</button>}
      </div>
      {flow && taskId && <div className="lnote" data-testid="status-launch-note">{launchNote(flow, sessionWork)}</div>}
    </div>
  );
}
