// 条目的状态标签，照设计原型的「状态小标」：评审与确认是并排的两个独立标记（中间不连线），
// 再跟「确认已失效」「有助手补充的内容」「第 N 版」几种小标签。待定事项一类的集合只显示状态与枚举字段。
// 最近一次工作刚改过的条目，版本标签写成「第 N 版 · 刚改」。

import type { Item, Task } from "../../api/types";
import { confirmState, hasExecutorSupplement, keepPendingField, reviewState } from "../../model/items";

export function ItemStatus({ task, item, justVersion, pending }: { task: Task; item: Item; justVersion?: number; pending?: boolean }) {
  const keep = keepPendingField(task, item.collection);
  const just = justVersion != null && justVersion === item.version_no;
  const saving = pending ? <span className="chip warn saving">正在保存</span> : null;
  const version = just
    ? <span className="chip just" data-testid={`just-${item.item_id}`}>第 {item.version_no} 版 · 刚改</span>
    : item.version_no > 1 ? <span className="chip">第 {item.version_no} 版</span> : null;
  if (keep) {
    const def = task.definition.collections.find((c) => c.name === item.collection);
    const status = String(item.fields[keep.name] ?? "");
    const unresolved = (keep.values ?? [])[0];
    const others = (def?.fields ?? []).filter((f) => f.type === "枚举" && f.name !== keep.name && item.fields[f.name]);
    return (
      <>
        {status && <span className={`chip ${status === unresolved ? "warn" : status === (keep.values ?? [])[1] ? "okc" : ""}`} data-testid={`status-${item.item_id}`}>{status}</span>}
        {others.map((f) => <span key={f.name} className="chip">{String(item.fields[f.name])}</span>)}
        {version}{saving}
      </>
    );
  }
  const review = reviewState(item);
  const confirm = confirmState(item);
  const rCls = review.state === "passed" ? "ok" : review.state === "failed" ? "bad" : "wait";
  const rTxt = review.state === "passed" ? "评审通过" : review.state === "failed" ? `评审不通过 ${review.findings} 处` : "待评审";
  const confirmed = confirm === "confirmed";
  return (
    <>
      <span className="st2" title="评审由评审者做，确认由你做，两件事互不挡着">
        <span className={`nd ${rCls}`}><span className="dot" />{rTxt}</span>
        <span className={`nd ${confirmed ? "ok" : "wait"}`}><span className="dot" />{confirmed ? "你已确认" : "待你确认"}</span>
        {review.state === "failed" && !confirmed && <span className="stnote">评审没有通过，你仍然可以确认</span>}
      </span>
      {confirm === "stale" && <span className="chip warn">确认已失效</span>}
      {hasExecutorSupplement(item) && <span className="chip warn">有助手补充的内容</span>}
      {version}{saving}
    </>
  );
}
