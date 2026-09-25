// 完成条件：按集合分组，每条写条件名、三种状态之一（已满足、还差、暂无条目）与接口给的说明；还差的条目逐个列出（最多 6 个）。
// 给了条目（items）时，「每个条目评审通过」还差的那一条按条目现算，分三组写：待评审的、评审不通过的、评审不通过但你保留了的
// （第三组按用户的决定算通过，只是提示）；给了 task 时只认当前规则指纹下的评审记录；
// 再给了 onReview、onOpen 时（工作视图里），旁边有「评审这 N 条」（评待评审的那几条）与「打开 X」（打开评审不通过的条目）。
// 任务页没有事件流、看不到评审进度，只给条目、不给这两个按钮。
// 完成条件之外的提示（completion.hints，不挡完成任务，例如还没有和任何条目关联的领域说明）写在它所属集合那一组的末尾，琥珀色。

import type { Completion, CompletionCondition, Item, Task, TaskStatus } from "../api/types";
import { completionHeadline, conditionState, groupConditions, REVIEW_CONDITION, reviewState } from "../model/items";

const LIST_AT_MOST = 6;
/** 「打开 X」最多给几个。 */
const OPEN_AT_MOST = 3;

export function CompletionPanel({ completion, status, items, task, onReview, onOpen, reviewOff }: {
  completion: Completion | null;
  status?: TaskStatus | string;
  /** 任务的条目：用来把评审一条分成待评审与评审不通过两组。 */
  items?: Item[];
  /** 任务：给了就按当前规则指纹判断评审状态。 */
  task?: Task;
  /** 「评审这 N 条」：评这个集合里待评审的条目。 */
  onReview?: (items: Item[]) => void;
  /** 「打开 X」：打开一个评审不通过的条目。 */
  onOpen?: (itemId: string) => void;
  /** 评审按钮灰化的原因（助手工作中、上一批还在评之类）；可用时为 undefined。 */
  reviewOff?: string;
}) {
  if (!completion) return <div className="muted small">完成条件这次没有算出来。</div>;
  const TICK = { met: "✓", unmet: "○", empty: "–" } as const;
  const WORD = { met: "已经满足。", unmet: "还差。", empty: "这个集合现在没有条目，暂不需要核对。" } as const;
  return (
    <div>
      <div className="small" style={{ marginBottom: "0.286rem" }}>
        {completionHeadline(completion)}{status === "已完成"
          ? "任务已经标为已完成。"
          : completion.all_met ? "" : "都满足之后，助手才能把这个任务标记为已完成。"}
      </div>
      {groupConditions(completion).map(([collection, conditions]) => (
        <div key={collection}>
          <div className="cond-group">{collection}</div>
          {conditions.map((c) => {
            const state = conditionState(c);
            const review = state === "unmet" && c.name === REVIEW_CONDITION && items ? reviewGroups(c, items, task) : null;
            return (
            <div key={c.name} className={`cond${state === "met" ? " met" : state === "empty" ? " empty" : ""}`} data-testid={`cond-${state}`}>
              <span className="tick">{TICK[state]}</span>
              <div>
                {review ? (
                  <div data-testid="cond-review">
                    <b style={{ fontWeight: 500 }}>{c.name}</b>：还差 {review.pending.length + review.failed.length} 条，
                    {[review.pending.length ? `${ids(review.pending)} 待评审` : "", review.failed.length ? `${ids(review.failed)} 评审不通过` : "",
                      review.kept.length ? `${ids(review.kept)} 评审不通过但你保留了（这条按你的决定算通过；条目再改动，评审要重做）` : ""].filter(Boolean).join("；")}。
                    {onReview && review.pending.length > 0 && (
                      <button type="button" className="btn sm" style={{ marginLeft: "0.429rem" }} disabled={!!reviewOff} title={reviewOff}
                        onClick={() => onReview(review.pending)} data-testid="cond-review-these">评审这 {review.pending.length} 条</button>
                    )}
                    {onOpen && review.failed.slice(0, OPEN_AT_MOST).map((i) => (
                      <button type="button" key={i.item_id} className="btn sm" style={{ marginLeft: "0.429rem" }}
                        onClick={() => onOpen(i.item_id)} data-testid={`cond-open-${i.item_id}`}>打开 {i.item_id}</button>
                    ))}
                  </div>
                ) : (
                  <>
                    <div><b style={{ fontWeight: 500 }}>{c.name}</b>：{WORD[state]}{state === "empty" ? "" : c.note}</div>
                    {state === "unmet" && c.missing.length > 0 && c.missing.length <= LIST_AT_MOST && (
                      <div className="missing">还差的条目：{c.missing.join("、")}</div>
                    )}
                  </>
                )}
              </div>
            </div>
            );
          })}
          {(completion.hints ?? []).filter((h) => h.collection === collection).map((h) => (
            <div key={h.kind} className="cond hint" data-testid="cond-hint">
              <span className="tick">ⓘ</span>
              <div><b style={{ fontWeight: 500 }}>提示</b>：{h.summary}这一条不挡完成任务，只是告诉你哪些还没用上。</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 评审一条按条目现在的评审状态分三组：待评审（当前修订、当前规则下没有评审记录）、评审不通过、评审不通过但你保留了（不在还差的里面）。 */
function reviewGroups(c: CompletionCondition, items: Item[], task?: Task): { pending: Item[]; failed: Item[]; kept: Item[] } {
  const mine = items.filter((i) => i.collection === c.collection);
  const missing = mine.filter((i) => c.missing.includes(i.item_id));
  return {
    pending: missing.filter((i) => reviewState(i, task).state === "pending"),
    failed: missing.filter((i) => reviewState(i, task).state === "failed"),
    kept: mine.filter((i) => { const s = reviewState(i, task); return s.state === "failed" && !!s.kept; }),
  };
}

function ids(list: Item[]): string {
  return list.length <= LIST_AT_MOST ? list.map((i) => i.item_id).join("、") : `${list.length} 个条目`;
}
