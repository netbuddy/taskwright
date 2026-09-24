// 完成条件：按集合分组，每条写条件名、三种状态之一（已满足、还差、暂无条目）与接口给的说明；还差的条目逐个列出（最多 6 个）。

import type { Completion, TaskStatus } from "../api/types";
import { completionHeadline, conditionState, groupConditions } from "../model/items";

const LIST_AT_MOST = 6;

export function CompletionPanel({ completion, status }: { completion: Completion | null; status?: TaskStatus | string }) {
  if (!completion) return <div className="muted small">完成条件这次没有算出来。</div>;
  const TICK = { met: "✓", unmet: "○", empty: "–" } as const;
  const WORD = { met: "已经满足。", unmet: "还差。", empty: "这个集合现在没有条目，暂不需要核对。" } as const;
  return (
    <div>
      <div className="small" style={{ marginBottom: 4 }}>
        {completionHeadline(completion)}{status === "已完成"
          ? (completion.all_met ? "任务已经标为已完成。" : "任务已经标为已完成：评审工具还没有，完成时开发期开关把「评审通过」几条当作已满足，所以这里仍显示没有满足。")
          : completion.all_met ? "" : "都满足之后，执行者才能把这个任务标记为已完成。"}
      </div>
      {groupConditions(completion).map(([collection, conditions]) => (
        <div key={collection}>
          <div className="cond-group">{collection}</div>
          {conditions.map((c) => {
            const state = conditionState(c);
            return (
            <div key={c.name} className={`cond${state === "met" ? " met" : state === "empty" ? " empty" : ""}`} data-testid={`cond-${state}`}>
              <span className="tick">{TICK[state]}</span>
              <div>
                <div><b style={{ fontWeight: 500 }}>{c.name}</b>：{WORD[state]}{state === "empty" ? "" : c.note}</div>
                {state === "unmet" && c.missing.length > 0 && c.missing.length <= LIST_AT_MOST && (
                  <div className="missing">还差的条目：{c.missing.join("、")}</div>
                )}
              </div>
            </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
