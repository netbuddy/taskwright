// 「任务状况」卡：任务现在做到哪里了。由程序据任务记录算出来（后端的状况接口），不经助手。
// 出现在两处：在已有任务里新建会话时，对话区第一条是它；点输入框旁的「任务状况」或者打 /状况，在对话里插一张。
// 行：阶段、业务说明、模型、需求条目、这一段还差、待决定（有开着的提议时）。底下两个按钮：开着的提议的进入项（与输入框上方
// 「待决定」一行的按钮是同一个请求），与「请助手说明下一步」（替用户发一句固定的话，由助手回答）。
// 卡上的内容是取数那一刻的；提议在那之后结束了（任务的阶段移动过，或者助手发了新的提议），进入按钮就不能点了。
// 卡上另有一节「开展一项活动」：正在进行的活动（一行，不是按钮）、可以启动或继续的流程、可以单独开展的六项活动、以后才有的（发布）。
// 每一项能不能开展、缺什么由后端算好；能开展的是按钮，点了是一次界面操作（start_activity），不替用户发话；不能开展的灰着并写缺什么。
// 这一节不是必答题：没有「不选」的按钮，用户直接在输入框里说话就行。按钮照任务现在的情形画（整份数据里的那一份），不照取数那一刻的。
// 可点的选项只在对话里最后一张状况卡上：更早的卡上半部分是当时的情形，按钮却是现在的，放在一起会说两个时刻的事，所以收成一行。

import { useState } from "react";
import type { LaunchOption, LaunchView, MessageRequest, StageProposal, TaskStatusView } from "../../api/types";
import {
  LAUNCH_ALONE_LABEL, LAUNCH_CURRENT_LABEL, LAUNCH_EARLIER_LINE, LAUNCH_FLOW_LABEL, LAUNCH_HINT, LAUNCH_LATER_LABEL, LAUNCH_TITLE,
  STATUS_NEXT_LABEL, STATUS_NEXT_TEXT, STATUS_TITLE, activityLabel, activityLine, descriptionLine, itemsLine, missingLine, modelsLine, statusSubtitle,
} from "../../model/taskStatus";
import { PENDING_LABEL, actOnProposal, pendingParts } from "./PendingProposal";
import type { ReviewedHandler } from "./ReplyCard";
import type { SendResult } from "./sendRestore";

export function TaskStatusCard({ status, liveProposal, liveLaunch, earlier = false, off = false, offTitle, onMessage, onSend, onReviewed, onLaunch }: {
  status: TaskStatusView;
  /** 这张卡不是对话里最后一张状况卡：「开展一项活动」一节不列选项，只写一行请用户看最新的那张。 */
  earlier?: boolean;
  /** 「开展一项活动」一节现在的内容（整份数据的 stage.launch）；没有给时照卡上取数那一刻的。 */
  liveLaunch?: LaunchView | null;
  /** 点了「开展一项活动」里的一项：返回有没有做成。不给时这一节的按钮都不能点。 */
  onLaunch?: (option: LaunchOption) => Promise<boolean> | boolean;
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
  const [launching, setLaunching] = useState(false);
  const launch = liveLaunch === undefined ? status.launch ?? null : liveLaunch;
  const start = (option: LaunchOption) => {
    if (off || launching || !option.enabled || !onLaunch) return;
    setLaunching(true);
    void Promise.resolve(onLaunch(option)).finally(() => setLaunching(false));
  };
  /** 一项：能开展的是按钮；不能开展的灰着，后面写状态（正在进行，或者缺什么）。 */
  const option = (one: LaunchOption, group: string) => (
    <span key={`${group}-${one.activity}`} className="lopt" data-testid={`launch-${group}-${one.activity}`}>
      <button type="button" className="btn sm" disabled={off || launching || !one.enabled || !onLaunch} title={off ? offTitle : one.state} onClick={() => start(one)}>{one.label}</button>
      {!one.enabled && <small>{one.state}</small>}
    </span>
  );
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
      <div className="row" data-testid="status-activity"><b>{activityLabel(status.activity)}</b><span>{activityLine(status.activity)}</span></div>
      <div className="row" data-testid="status-description"><b>业务说明</b>
        <span>{description.text}{description.open && <>；<em>{description.open}</em></>}</span></div>
      <div className="row" data-testid="status-models"><b>模型</b><span>{modelsLine(status.models)}</span></div>
      <div className="row" data-testid="status-items"><b>需求条目</b><span>{itemsLine(status.items)}</span></div>
      {status.activity.kind !== "idle" && <div className="row" data-testid="status-missing"><b>这一段还差</b><span>{missingLine(status.missing)}</span></div>}
      {proposal && <div className="row" data-testid="status-proposal"><b>{PENDING_LABEL}</b><span>{pendingParts(proposal).join("")}</span></div>}
      {launch && earlier && <div className="activities" data-testid="status-activities-earlier"><div className="lhint">{LAUNCH_EARLIER_LINE}</div></div>}
      {launch && !earlier && (
        <div className="activities" data-testid="status-activities" aria-label={LAUNCH_TITLE}>
          <div className="k2">{LAUNCH_TITLE}</div>
          {launch.current && <div className="row" data-testid="launch-current"><b>{LAUNCH_CURRENT_LABEL}</b><span>{launch.current.label}</span></div>}
          <div className="row" data-testid="launch-flows"><b>{LAUNCH_FLOW_LABEL}</b><span className="lopts">{launch.flows.map((one) => option(one, "flow"))}</span></div>
          <div className="row" data-testid="launch-activities"><b>{LAUNCH_ALONE_LABEL}</b><span className="lopts">{launch.activities.map((one) => option(one, "alone"))}</span></div>
          {launch.later.length > 0 && (
            <div className="row" data-testid="launch-later"><b>{LAUNCH_LATER_LABEL}</b><span className="lopts">{launch.later.map((one) => <span key={one.label} className="lopt"><span className="later">{one.label}</span><small>{one.state}</small></span>)}</span></div>
          )}
          <div className="lhint">{LAUNCH_HINT}</div>
        </div>
      )}
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
