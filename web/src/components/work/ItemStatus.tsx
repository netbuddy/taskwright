// 条目的状态标记。每行只有一枚有色的主状态徽标，写「这条现在还缺什么」（model/items.ts 的 mainStatus），按先后只取最前面的一件：
// 评审不通过 N 处（红）→ 未读（琥珀）→ 待评审（灰底）→ 评审不通过 N 处 · 已保留（绿边框）→ 问题 N 未解决（琥珀）。
// 前四件之一没做完、又有牵涉它的未解决问题时，另挂一枚琥珀色「问题 N」，所以每行有色徽标最多两枚。什么都不缺时不挂徽标。
// 悬停主徽标看得到全部状态（评审结论、已读到哪次修订、问题数）。未读的行照旧加粗（在条目区）。
// 其余信息一律是灰色小字：分组字段的值（类别）、修订 N（执行者最近一次运行改过的写「修订 N · 刚改」并加粗）、来源 N、
// 有助手补充的内容、正在保存。领域说明一类的集合里还没和任何条目关联的条目，另有一枚琥珀色小标签，那是提示，不是状态。
// 问题条目一类的集合（有取值「用户决定保留」的枚举字段）只写它自己的状态：未解决（琥珀）、已解决（绿）、用户决定保留（绿边框）。
// 条目改动过不止一次时写「修订 N」，只出现过一次的不写；任务定义里写了「界面」一项的集合（例如领域说明）在列表行上总写修订与来源。

import type { Item, Task } from "../../api/types";
import { displayOf, groupOf, unlinkedIds } from "../../model/domainNotes";
import { hasExecutorSupplement, KEEP_PENDING_VALUE, keepPendingField, mainStatus, mainStatusDetail, mainStatusText, RESOLVED_VALUE } from "../../model/items";

/** 列表行与详情头部上的有色徽标：主状态一枚，必要时再加「问题 N」。问题条目只写它自己的状态。 */
export function StatusBadges({ task, item }: { task: Task; item: Item }) {
  const keep = keepPendingField(task, item.collection);
  if (keep) return <IssueStateBadge value={String(item.fields[keep.name] ?? "")} unresolved={(keep.values ?? [])[0]} testId={`status-${item.item_id}`} />;
  const s = mainStatus(task, item);
  if (!s.kind) return null;
  return (
    <>
      <span className={`sb ${s.kind}`} title={mainStatusDetail(s, item)} data-testid={`state-${item.item_id}`}>
        {s.kind !== "issues" && <span className="dot" />}{mainStatusText(s)}
      </span>
      {s.kind !== "issues" && s.issues > 0 && (
        <span className="sb issues" title={`有 ${s.issues} 个牵涉这条的问题还没解决，打开详情可以看到并回答。`} data-testid={`issues-${item.item_id}`}>问题 {s.issues}</span>
      )}
    </>
  );
}

/** 问题条目的状态：未解决琥珀、已解决绿、用户决定保留绿边框，其它取值灰字。 */
export function IssueStateBadge({ value, unresolved, testId }: { value: string; unresolved?: string; testId?: string }) {
  if (!value) return null;
  const cls = value === unresolved ? "issues" : value === RESOLVED_VALUE ? "ok" : value === KEEP_PENDING_VALUE ? "kept" : "plain";
  return <span className={`sb ${cls}`} data-testid={testId}>{cls === "ok" || cls === "kept" ? <span className="dot" /> : null}{value}</span>;
}

/** 灰色小字：类别、修订 N（· 刚改）、来源 N、有助手补充的内容、正在保存；问题条目另写状态以外的枚举字段。 */
export function ItemMeta({ task, item, just, pending, row = false }: { task: Task; item: Item; just?: boolean; pending?: boolean; row?: boolean }) {
  const keep = keepPendingField(task, item.collection);
  const display = displayOf(task, item.collection);
  const group = groupOf(item, display);
  const alwaysRevision = !!display && row;
  const revision = just
    ? <span className="gm strong" data-testid={`just-${item.item_id}`}>修订 {item.revision_no} · 刚改</span>
    : item.revisions.length > 1 || alwaysRevision ? <span className="gm" title={`这个条目现在的内容是修订 ${item.revision_no} 写的`}>修订 {item.revision_no}</span> : null;
  const saving = pending ? <span className="gm saving">正在保存…</span> : null;
  if (keep) {
    const def = task.definition.collections.find((c) => c.name === item.collection);
    const others = (def?.fields ?? []).filter((f) => f.type === "枚举" && f.name !== keep.name && item.fields[f.name]);
    return <>{others.map((f) => <span key={f.name} className="chip">{String(item.fields[f.name])}</span>)}{revision}{saving}</>;
  }
  const unlinked = !!display && row && unlinkedIds(task, item.collection).includes(item.item_id);
  return (
    <span className="gms">
      {group && <span className="gm" data-testid={`group-${item.item_id}`}>{group}</span>}
      {revision}
      {display && row && <span className="gm" data-testid={`source-count-${item.item_id}`}>来源 {item.sources.length}</span>}
      {hasExecutorSupplement(item) && <span className="gm">有助手补充的内容</span>}
      {unlinked && <span className="chip warn sm" data-testid={`unlinked-${item.item_id}`}>还没和任何条目关联</span>}
      {saving}
    </span>
  );
}

/** 列表行上的状态：先灰色小字，再有色徽标；问题卡片上状态排在最前。 */
export function ItemStatus({ task, item, just, pending, row = false }: { task: Task; item: Item; just?: boolean; pending?: boolean; row?: boolean }) {
  const meta = <ItemMeta task={task} item={item} just={just} pending={pending} row={row} />;
  const badges = <StatusBadges task={task} item={item} />;
  return keepPendingField(task, item.collection) ? <>{badges}{meta}</> : <>{meta}{badges}</>;
}
