// 输入框上方的「待决定」一行：助手发过提议的卡片、用户还没有照它做时出现（整份数据的 stage.proposal 不为空）。
// 提议有三种：进入下一个阶段（「助手已提议进入某阶段」）、退回前面的阶段（「助手已提议退回某阶段」）、
// 编写文档阶段请用户过目补写的页（「补写的 N 处待过目」，按钮是「看过了，生成文档」，点了不发话、不移动阶段）。下面的说明以第一种为例。
// 它是一件待办，不是进度：用户在卡片上选了「继续本阶段」、又讨论修订了多少轮之后，都能从这里进入下一段。
// 按钮上的字就是那张卡片进入项的字，点了与点卡片上的进入项发同一个请求（那句「我选：……」带上卡片所在的回复与选项的键）；
// 卡片是在另一条会话里发的也一样。阶段移动之后提议结束，这一行随整份数据消失。没有开着的提议时不画。

import { useState } from "react";
import type { MessageRequest, StageProposal } from "../../api/types";
import { STAGE_NAMES } from "../../model/stage";
import { TEMPLATES, type ReviewedHandler } from "./ReplyCard";
import type { SendResult } from "./sendRestore";

export const PENDING_LABEL = "待决定";

/** 「待决定」后面那句话拆成三段：中间一段（阶段的名字，或者补写了几处）页面上加重。早先的后端不给提议的种类，当作进入。 */
export function pendingParts(proposal: Pick<StageProposal, "stage"> & Partial<Pick<StageProposal, "kind" | "items">>): [string, string, string] {
  if (proposal.kind === "review") return ["补写的", ` ${(proposal.items ?? []).length} 处`, "待过目"];
  const name = (STAGE_NAMES as Record<string, string>)[proposal.stage] ?? proposal.stage;
  // 任务空闲时助手提议开始核读材料：不是进入下一个阶段，是启动首次分析。
  if (proposal.kind !== "back" && proposal.stage === "reading") return ["助手已提议开始", name, ""];
  return [proposal.kind === "back" ? "助手已提议退回" : "助手已提议进入", name, "阶段"];
}

/**
 * 点「待决定」一行（或任务状况卡片）上的按钮：请过目的提议走「看过了」那一套（不发话），别的两种发那句「我选：……」。
 * 返回有没有做成。
 */
export function actOnProposal(proposal: StageProposal, onMessage: (text: string, card?: MessageRequest["card"]) => SendResult, onReviewed?: ReviewedHandler): Promise<boolean> {
  if (proposal.kind === "review") return Promise.resolve(onReviewed?.(proposal.reply_message_id ?? "", proposal.items) ?? false).then((ok) => ok !== false);
  return Promise.resolve(onMessage(...enterRequest(proposal))).then((ok) => ok !== false);
}

/** 点进入按钮发出去的那一句与它带的卡片：与点卡片上的进入项相同。 */
export function enterRequest(proposal: Pick<StageProposal, "enter" | "reply_message_id">): [string, NonNullable<MessageRequest["card"]>] {
  return [TEMPLATES.choose(proposal.enter.text), { reply_message_id: proposal.reply_message_id ?? "", kind: "choose", choice: proposal.enter.key }];
}

export function PendingProposal({ proposal, off = false, offTitle, onMessage, onReviewed }: {
  proposal: StageProposal | null | undefined;
  /** 现在不能发话（任务已结束、助手正在工作、有未保存的编辑等）：按钮灰化。 */
  off?: boolean;
  offTitle?: string;
  onMessage: (text: string, card?: MessageRequest["card"]) => SendResult;
  /** 请过目的提议点了「看过了，生成文档」。 */
  onReviewed?: ReviewedHandler;
}) {
  // 点过哪一条提议（按记下它的那条事件的序号认）：这一条不再能点第二次；换了一条新的提议就又能点。
  const [sent, setSent] = useState<number | null>(null);
  if (!proposal) return null;
  const [before, name, after] = pendingParts(proposal);
  const done = sent === proposal.event_seq;
  const enter = () => {
    if (off || done) return;
    setSent(proposal.event_seq);
    // 没有发出去（例如助手这时在另一条会话里工作）：放开按钮，可以再点。
    void actOnProposal(proposal, onMessage, onReviewed).then((ok) => { if (!ok) setSent(null); });
  };
  return (
    <div className="pend" data-testid="pending-proposal" data-stage={proposal.stage} data-kind={proposal.kind ?? "enter"}>
      <span className="k">{PENDING_LABEL}</span>
      <span className="what">{before}<b>{name}</b>{after}</span>
      <button type="button" className="btn sm pri go" disabled={off || done} title={off ? offTitle : undefined} onClick={enter} data-testid="pending-enter">
        {proposal.enter.text}
      </button>
    </div>
  );
}
