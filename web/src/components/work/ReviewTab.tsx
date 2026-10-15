// 工作台中栏「评审与确认」页签，版式照业务说明的节页（.oa-page）。自上而下：
//   · 页头「评审与确认」，右边「评审 N 条待评审的条目」（从需求条目页签搬来，灰化的规矩照旧）；一句说明。
//   · 待处理的发现：只写一句汇总。发现按条目列在右侧栏「评审」页签，与中栏正在看的条目联动，处理发现不用切页签。
//   · 评审历史表：轮次、时间、评了几条、发现几处、处理情况（review_batches）。
//   · 确认记录表四行：需求条目、分析模型、助手补写待核实、待澄清问题，各写已确认几个、一共几个与待处理的话。
//   · 末尾一句发布的前置条件。算法在 model/reviewPage.ts。

import type { Task } from "../../api/types";
import { batchRows, confirmRows, findingsLine, publishCondition } from "../../model/reviewPage";

/** 页上的一句说明。 */
export const REVIEW_LEAD = "评审按任务类型的评审规则检查需求条目；确认记录汇总你对条目、模型与待核实内容的确认。发布的前置条件据此判定。";
/** 发现在哪里处理。 */
export const FINDINGS_WHERE = "评审发现按条目列在右侧栏「评审」页签，与正在看的条目联动；这里只汇总条数。";

export function ReviewTab({ task, reviewButton }: {
  task: Task;
  /** 「评审 N 条待评审的条目」按钮（条目区画好交进来：灰化与发起评审的逻辑在那里）；不能发起评审时不给。 */
  reviewButton?: React.ReactNode;
}) {
  const batches = batchRows(task);
  return (
    <div className="oa-page ap-page" data-testid="review-tab">
      <div className="ap-head"><h2>评审与确认</h2>{reviewButton && <span className="ap-act">{reviewButton}</span>}</div>
      <p className="ap-lead">{REVIEW_LEAD}</p>

      <section className="oa-blk">
        <h3>待处理的发现</h3>
        <p className="ap-line" data-testid="review-findings">{findingsLine(task)}<span className="ap-note">{FINDINGS_WHERE}</span></p>
      </section>

      <section className="oa-blk">
        <h3>评审历史<small>{batches.length ? `${batches.length} 轮` : ""}</small></h3>
        {batches.length === 0 ? <p className="oa-empty" data-testid="review-history-empty">尚无评审记录。</p> : (
          <div className="oa-tablebox">
            <table className="oa-table ap-table" data-testid="review-history">
              <thead><tr><th>轮次</th><th>时间</th><th>评了</th><th>发现</th><th>处理情况</th></tr></thead>
              <tbody>
                {batches.map((one) => (
                  <tr key={one.no} data-testid={`review-batch-${one.no}`}>
                    <td className="num">第 {one.no} 轮</td>
                    <td className="mut num">{one.at}</td>
                    <td className="num">{one.total} 条</td>
                    <td className="num">{one.findings} 处</td>
                    <td>{one.handled}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="oa-blk">
        <h3>确认记录</h3>
        <div className="oa-tablebox">
          <table className="oa-table ap-table" data-testid="confirm-table">
            <thead><tr><th>对象</th><th>已确认</th><th>待处理</th></tr></thead>
            <tbody>
              {confirmRows(task).map((one) => (
                <tr key={one.name} data-testid={`confirm-${one.name}`}>
                  <td className="nm">{one.name}</td>
                  <td className="num">{one.done} / {one.total}</td>
                  <td className={one.pending ? "ap-warn" : "mut"}>{one.pending || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="ap-foot" data-testid="publish-condition">{publishCondition(task)}</p>
      </section>
    </div>
  );
}
