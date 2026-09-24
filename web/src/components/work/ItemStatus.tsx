// 条目的状态标签，照设计原型的「状态小标」：评审与已读是并排的两个独立标记（中间不连线），
// 再跟「有助手补充的内容」「修订 N」几种小标签。已读是条目级、单向的：打开看过就写「已读 · 修订 N」（N 是最后一次看过的修订），
// 助手之后又改过也不翻回未读，改过的提示交给「刚改」标签与详情里的字段边框；从没打开过的写「未读」，加粗。
// 问题条目一类的集合只显示状态与枚举字段。
// 执行者最近一次运行改过的条目（model/revisions.ts 的 justChangedItems），修订标签写成「修订 N · 刚改」；
// 条目改动过不止一次时写「修订 N」，只出现过一次的不写。

import type { Item, Task } from "../../api/types";
import { hasExecutorSupplement, isUnread, keepPendingField, lastViewedRevision, reviewState } from "../../model/items";

export function ItemStatus({ task, item, just, pending }: { task: Task; item: Item; just?: boolean; pending?: boolean }) {
  const keep = keepPendingField(task, item.collection);
  const saving = pending ? <span className="chip warn saving">正在保存</span> : null;
  const revision = just
    ? <span className="chip just" data-testid={`just-${item.item_id}`}>修订 {item.revision_no} · 刚改</span>
    : item.revisions.length > 1 ? <span className="chip" title={`这个条目现在的内容是修订 ${item.revision_no} 写的`}>修订 {item.revision_no}</span> : null;
  if (keep) {
    const def = task.definition.collections.find((c) => c.name === item.collection);
    const status = String(item.fields[keep.name] ?? "");
    const unresolved = (keep.values ?? [])[0];
    const others = (def?.fields ?? []).filter((f) => f.type === "枚举" && f.name !== keep.name && item.fields[f.name]);
    return (
      <>
        {status && <span className={`chip ${status === unresolved ? "warn" : status === (keep.values ?? [])[1] ? "okc" : ""}`} data-testid={`status-${item.item_id}`}>{status}</span>}
        {others.map((f) => <span key={f.name} className="chip">{String(item.fields[f.name])}</span>)}
        {revision}{saving}
      </>
    );
  }
  const review = reviewState(item, task);
  const unread = isUnread(item);
  const rCls = review.state === "passed" ? "ok" : review.state === "failed" ? "bad" : "wait";
  // 评审通过时可选规则给的建议条数写在括号里；不通过时写必选规则的问题处数。
  const rTxt = review.state === "passed" ? (review.advice ? `评审通过（${review.advice} 条建议）` : "评审通过")
    : review.state === "failed" ? `评审不通过 ${review.problems} 处` : "待评审";
  return (
    <>
      <span className="st2" title="评审由评审者做；你打开看过就算确认，两件事互不挡着">
        <span className={`nd ${rCls}`} data-testid={`review-${item.item_id}`}><span className="dot" />{rTxt}</span>
        <span className={`nd ${unread ? "wait unread" : "ok"}`} data-testid={`read-${item.item_id}`}><span className="dot" />{unread ? "未读" : `已读 · 修订 ${lastViewedRevision(item)}`}</span>
      </span>
      {hasExecutorSupplement(item) && <span className="chip warn">有助手补充的内容</span>}
      {revision}{saving}
    </>
  );
}
