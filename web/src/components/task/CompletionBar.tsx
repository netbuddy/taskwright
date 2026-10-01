// 任务页的完成条件横条：左边是分数「完成条件 已满足几条／用得上的一共几条」，右边每条完成条件一行。
// 记号三种：已满足是绿色的勾，还差是琥珀色的圈，集合还没有条目、暂时不用核对的是灰色短横。
// 全部满足时整块换成一句话。完成条件之外的提示（不挡完成任务）列在末尾。句子与分数的算法在 model/completionLines.ts。

import { CheckOutlined, CheckSquareOutlined, InfoCircleOutlined, MinusOutlined } from "@ant-design/icons";
import type { Task } from "../../api/types";
import { completionLines, completionScore, type LinePart } from "../../model/completionLines";
import { unmetCount } from "../../model/items";

const STATE_WORD = { met: "已满足", unmet: "还差", empty: "暂时不用核对" } as const;

function Parts({ parts }: { parts: LinePart[] }) {
  return <span>{parts.map((p, i) => (typeof p === "string" ? p : <span key={i} className="mono">{p.id}</span>))}</span>;
}

/** 全部满足时的那句话：任务还在进行时提示可以请助手标记完成。 */
function allMetText(status: string): string {
  if (status === "进行中") return "完成条件已全部满足，可以在会话里请助手标记完成。";
  if (status === "已完成") return "完成条件已全部满足，任务已经标记为完成。";
  return "完成条件已全部满足。";
}

export function CompletionBar({ task }: { task: Task }) {
  const completion = task.completion;
  if (!completion) {
    return <section className="tp-progress done" aria-label="完成条件" data-testid="completion-bar"><div className="tp-all muted">完成条件这次没有算出来。</div></section>;
  }
  const hints = (completion.hints ?? []).map((h) => (
    <li key={h.kind} className="hint" data-testid="cond-hint">
      <span className="mk"><InfoCircleOutlined /></span>
      <span>提示：{h.summary}这一条不挡完成任务，只是告诉你哪些还没用上。</span>
    </li>
  ));
  if (completion.all_met && unmetCount(completion) === 0) {
    return (
      <section className="tp-progress done" aria-label="完成条件" data-testid="completion-bar">
        <div className="tp-all" data-testid="completion-all-met"><span className="mk"><CheckOutlined /></span>{allMetText(task.status)}</div>
        {hints.length > 0 && <ul className="tp-conds">{hints}</ul>}
      </section>
    );
  }
  const score = completionScore(completion);
  return (
    <section className="tp-progress" aria-label="完成条件" data-testid="completion-bar">
      <div className="tp-score">
        <CheckSquareOutlined className="tp-hic" /><span className="lbl">完成条件</span><span className="num" data-testid="completion-score">{score.met}/{score.total}</span>
      </div>
      <div className="tp-vr" />
      <ul className="tp-conds">
        {completionLines(completion, task).map((line) => (
          <li key={line.key} className={line.state} title={STATE_WORD[line.state]} data-testid={`cond-${line.state}`}>
            <span className="mk">{line.state === "met" ? <CheckOutlined /> : line.state === "unmet" ? <span className="ring" /> : <MinusOutlined />}</span>
            <Parts parts={line.parts} />
          </li>
        ))}
        {hints}
      </ul>
    </section>
  );
}
