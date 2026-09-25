// 条目区，照设计原型：顶上一行集合页签与「生成文档」，下面一行筛选与进度（点开是完成条件），
// 「还有 N 条未读」的提示与勾选后的批量标为已读，然后是列表；点一行，列表换成这个条目的详情（带「回到列表」）。
// 打开详情就记为已读（由页面在打开时发 mark_viewed），已读就算确认；未读的行像邮件一样加粗。
// 问题条目一类的集合（有取值「用户决定保留」的枚举字段）铺成一张张卡片，未解决的带「回答这个问题」「先不管，保留」。
// 自上次确认以来助手改过的条目带「修订 N · 刚改」；库事件刚改过的条目短时闪一下。集合名、字段名一律取自任务定义。
//
// 单一写入者：执行者工作中（writesOff），顶部一条横幅，改字段、保存、删除、批量标为已读、撤回、
// 先不管全部灰化；「回答这个问题」「让助手来改这一条」只往对话区输入框预填文字、不写库，照常可用。
// 在右侧「修订」页签选中一次修订（hit）时，它碰到的条目高亮，集合页签上标出各有几个，筛选行加一个可点掉的提示。
// 宽屏时列表每行在标题后多一列「一句摘要」，显隐由样式里的容器查询按条目区宽度决定（阈值 40rem）。
//
// 评审：顶上一行右侧「评审 N 条待评审的条目」（N 为 0、助手工作中、上一批还在评时灰化并悬停说明），点了发 request_review；
// 后端核对通过就回应，评审在后台跑，review_progress 到了在页签下面显示「评审中 3/12」、进度条与正在评的条目，
// review_finished 到了显示一行结果，5 秒后收起。进度汇总一行写待评审与评审不通过各几条。点开进度看到的完成条件
// 与任务页是同一个面板，评审那一条旁边有「评审这 N 条」与「打开 X」。
// 问题跟着条目走（ItemIssues.tsx）：列表行带「问题 N」，详情顶部列出挂在这条上的问题；从问题卡片上的「牵涉 UC-003」跳来时
// 记下来源（fromIssue），详情顶部给「回到问题列表」；换到别的条目或回到列表就清掉。

import { useEffect, useMemo, useState } from "react";
import type { Item, Task } from "../../api/types";
import type { ReviewRun } from "../../state/workState";
import { BUSY_TEXT, FILTERS, failedReview, isEmptyValue, isUnread, keepPendingField, matchesFilter, needsReading, pendingReview, reviewOffReason, summaryOf, unreadItems, writeOffReason, type ItemFilter } from "../../model/items";
import { CompletionPanel } from "../CompletionPanel";
import { ItemDetail, type SubmitAction, type ViewRequest } from "./ItemDetail";
import { ItemStatus } from "./ItemStatus";
import { unlinkedIds } from "../../model/domainNotes";
import { FromIssueCrumb, IssueBadge, ItemIssues } from "./ItemIssues";

/** 发起评审：给要评的条目（空列表＝全部待评审的条目）与一句说明。 */
export type ReviewAction = (targets: { item_id: string; base_revision: number }[], label: string, force?: boolean) => void;

export { BUSY_TEXT };

export function ItemsPanel({
  task, readOnly, writesOff = false, recentlyChanged, marks = {}, just = new Set<string>(), pendingItems, selected, onSelect, submit, onGenerateDoc, onLocate,
  onAskAssistant, onAnswer, onSend, hit = null, onClearHit, view = null, latestRevision = 0, onDirty, unreadRequest = 0, review = null, onReview, onPrefill,
}: {
  task: Task;
  /** 任务已结束或助手不可用：一切写入都不能做。 */
  readOnly: boolean;
  /** 执行者正在工作：写入按钮灰化，预填输入框的两个按钮照常可用。 */
  writesOff?: boolean;
  recentlyChanged: string[];
  /** 字段修订标识：条目编号 → 自上次确认以来助手改过的字段（model/revisions.ts 的 marksByItem）。 */
  marks?: Record<string, string[]>;
  /** 带「刚改」标签的条目：执行者最近一次运行改过的（model/revisions.ts 的 justChangedItems）。 */
  just?: Set<string>;
  pendingItems: Set<string>;
  selected: string | null;
  onSelect: (itemId: string | null) => void;
  submit: SubmitAction;
  onGenerateDoc: () => void;
  onLocate?: (excerpt: string, locator: string) => void;
  onAskAssistant?: (itemId: string) => void;
  /** 问题条目卡片上的「回答这个问题」：预填对话区输入框。 */
  onAnswer?: (item: Item) => void;
  /** 条目详情里问题卡片上的「回答」：把一句话直接发到对话区。 */
  onSend?: (text: string) => void;
  /** 在「修订」页签里选中的那次修订与它碰到的条目。 */
  hit?: { revision: number; items: string[] } | null;
  onClearHit?: () => void;
  /** 从修订页签的「查看差异」来的：打开这个条目并停在那次修订。 */
  view?: ViewRequest | null;
  latestRevision?: number;
  /** 有没有未保存的条目编辑（编辑框打开且内容与打开时不同）。 */
  onDirty?: (dirty: boolean) => void;
  /** 卡片上点「筛出来看」时加一：筛选切到「未读」、回到列表。 */
  unreadRequest?: number;
  /** 最近一批界面发起的评审（进度与结果）。 */
  review?: ReviewRun | null;
  /** 发起评审。 */
  onReview?: ReviewAction;
  /** 往对话区输入框预填一句话（「让助手照这条改」）。 */
  onPrefill?: (text: string) => void;
}) {
  const collections = task.definition.collections;
  const selectedItem = task.items.find((i) => i.item_id === selected);
  const [tab, setTab] = useState<string>(selectedItem?.collection ?? collections[0]?.name ?? "");
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [showProgress, setShowProgress] = useState(false);
  const [flash, setFlash] = useState<string[]>([]);
  /** 这批评审评完之后那一行结果还显示着（5 秒后收起）。 */
  const [finishShown, setFinishShown] = useState<string | null>(null);
  /** 从哪个问题跳到当前条目的；详情顶部据此给「回到问题列表」，那张问题卡片排第一并高亮。 */
  const [fromIssue, setFromIssue] = useState<{ issueId: string; itemId: string } | null>(null);
  /** 回到问题列表后要滚到并闪一下的问题卡片；n 每次加一。 */
  const [scrollTo, setScrollTo] = useState<{ id: string; n: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const activeTab = selectedItem?.collection ?? tab;
  const hitIds = hit?.items ?? [];
  const off = readOnly || writesOff;
  const offTitle = writeOffReason(task, { readOnly, writesOff });

  // 从卡片、修订页签点来的条目：切到它所在的集合、不让筛选挡住它。
  useEffect(() => {
    if (!selected) return;
    const item = task.items.find((i) => i.item_id === selected);
    if (item) { setTab(item.collection); if (!matchesFilter(item, filter, task)) setFilter("all"); }
    document.querySelector(".app .items-body")?.scrollTo({ top: 0 });
  }, [selected]);
  // 换到别的条目或回到列表：不再是从问题跳来的。
  useEffect(() => { if (fromIssue && selected !== fromIssue.itemId) setFromIssue(null); }, [selected]);
  useEffect(() => {
    if (!scrollTo) return;
    document.querySelector(`.app [data-testid="item-${scrollTo.id}"]`)?.scrollIntoView?.({ block: "center" });
    setFlash([scrollTo.id]);
    const t = setTimeout(() => setFlash([]), 2400);
    return () => clearTimeout(t);
  }, [scrollTo]);
  // 卡片上点了「还有 N 条未读 · 筛出来看」。
  useEffect(() => { if (unreadRequest > 0) { setFilter("unread"); onSelect(null); } }, [unreadRequest]);
  // 一批评审评完：结果显示 5 秒后收起。
  useEffect(() => {
    if (!review?.finished) return;
    setFinishShown(review.op_id);
    const t = setTimeout(() => setFinishShown(null), 5000);
    return () => clearTimeout(t);
  }, [review?.op_id, review?.finished]);
  // 库事件改过的条目闪一下。
  useEffect(() => {
    if (!recentlyChanged.length) return;
    setFlash(recentlyChanged);
    const t = setTimeout(() => setFlash([]), 2400);
    return () => clearTimeout(t);
  }, [recentlyChanged]);

  const def = collections.find((c) => c.name === activeTab);
  const statusField = keepPendingField(task, activeTab);
  const items = useMemo(() => task.items.filter((i) => i.collection === activeTab && matchesFilter(i, filter, task)), [task, activeTab, filter]);
  const unread = unreadItems(task);
  const unresolved = task.items.filter((i) => {
    const f = keepPendingField(task, i.collection);
    return f && i.fields[f.name] === (f.values ?? [])[0];
  }).length;
  const checkedItems = items.filter((i) => checked.has(i.item_id));
  const pos = selectedItem ? items.findIndex((i) => i.item_id === selectedItem.item_id) : -1;
  const hitsIn = (collection: string) => task.items.filter((i) => i.collection === collection && hitIds.includes(i.item_id)).length;
  const toReview = pendingReview(task);
  const failed = failedReview(task);
  const reviewing = !!review && !review.finished;
  const reviewOff = reviewOffReason(task, { readOnly, writesOff, running: reviewing, count: toReview.length });
  const reviewItems = (list: Item[], label: string, force?: boolean) =>
    onReview?.(list.map((i) => ({ item_id: i.item_id, base_revision: i.revision_no })), label, force);

  /** 打开一个条目；从问题卡片上跳来时带上来源。 */
  const openItem = (itemId: string, o: { fromIssue?: string } = {}) => {
    setFromIssue(o.fromIssue ? { issueId: o.fromIssue, itemId } : null);
    onSelect(itemId);
  };
  /** 「回到问题列表」：切回问题所在的页签，滚到那张问题卡片。 */
  const backToIssue = (issueId: string) => {
    const issue = task.items.find((i) => i.item_id === issueId);
    setFromIssue(null);
    if (issue) { setTab(issue.collection); if (!matchesFilter(issue, filter)) setFilter("all"); }
    onSelect(null);
    setScrollTo((s) => ({ id: issueId, n: (s?.n ?? 0) + 1 }));
  };

  const markMany = async (list: Item[]) => {
    const e = await submit({ kind: "mark_viewed", targets: list.map((i) => ({ item_id: i.item_id, base_revision: i.revision_no })), notify_executor: false },
      `把 ${list.map((i) => i.item_id).join("、")} 标为已读`);
    if (!e) setChecked(new Set());
  };

  return (
    <div className="pane-items" data-testid="items-panel">
      {writesOff && <div className="sw-busy-banner" data-testid="busy-banner"><span className="spin" />{BUSY_TEXT}</div>}
      <div className="itabs">
        {collections.map((c) => (
          <span key={c.name} className={`itab${c.name === activeTab ? " on" : ""}`} role="tab"
            onClick={() => { setTab(c.name); onSelect(null); }}>
            {c.name}<span className="cnt">{task.items.filter((i) => i.collection === c.name).length}</span>
            {hit && hitsIn(c.name) > 0 && <span className="sw-hitn" title={`修订 ${hit.revision} 碰到这个页签里 ${hitsIn(c.name)} 个条目`} data-testid={`hit-count-${c.name}`}>{hitsIn(c.name)}</span>}
          </span>
        ))}
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={onGenerateDoc}>生成文档</button>
        {onReview && (
          <button type="button" className="btn sm pri" disabled={!!reviewOff} title={reviewOff} data-testid="review-all"
            onClick={() => onReview([], `评审 ${toReview.length} 条待评审的条目`)}>评审 {toReview.length} 条待评审的条目</button>
        )}
      </div>
      {review && (reviewing || finishShown === review.op_id) && (
        <div className="sw-review-prog" data-testid="review-progress">
          {review.finished ? (
            <span data-testid="review-finished">
              评审完了：{review.finished.passed} 条合规，{review.finished.failed} 条不合规
              {review.finished.unfinished ? `，${review.finished.unfinished} 条没有评完（可以再评一次）` : ""}。{review.finished.error ?? ""}
            </span>
          ) : (
            <>
              <span className="muted">评审中 {review.done}/{review.total}</span>
              <span className="sw-bar"><i style={{ width: `${review.total ? Math.round((review.done / review.total) * 100) : 0}%` }} /></span>
              <span className="muted">{review.current.length ? `${review.current.join("、")} 正在评审…` : "正在收尾…"}（每条约十秒，可以继续做别的）</span>
            </>
          )}
        </div>
      )}
      <div className="filters">
        {FILTERS.map((f) => (
          <span key={f.key} className={`filt${filter === f.key ? " on" : ""}${f.key === "review_failed" || f.key === "unread" ? " warn" : f.key === "review_passed" ? " okf" : ""}`}
            role="button" onClick={() => { setFilter(f.key); onSelect(null); }}>{f.label}</span>
        ))}
        {hit && hitIds.length > 0 && (
          <span className="sw-hitnote" role="button" title="点一下取消高亮" onClick={onClearHit} data-testid="hit-note">修订 {hit.revision} 碰到的条目 ✕</span>
        )}
        <span className="prog" role="button" onClick={() => setShowProgress(!showProgress)} data-testid="progress">
          {task.items.length} 个条目 · 待评审 {toReview.length} · 评审不通过 {failed.length} · {unread.length} 条未读；问题 {unresolved} 条未解决 {showProgress ? "▴" : "▾"}
        </span>
      </div>
      <div className={`prog-detail${showProgress ? " show" : ""}`}>
        <div>这份交付物什么时候算做完，由下面这几条决定：</div>
        {showProgress && <CompletionPanel completion={task.completion} status={task.status} items={task.items} task={task}
          reviewOff={reviewOffReason(task, { readOnly, writesOff, running: reviewing, count: 1 })}
          onReview={onReview ? (list) => reviewItems(list, `评审 ${list.map((i) => i.item_id).join("、")}`) : undefined}
          onOpen={(id) => { setShowProgress(false); onSelect(id); }} />}
      </div>
      {unread.length > 0 && filter !== "unread" && (
        <div className="alertbar" data-testid="unread-bar">
          还有 {unread.length} 条未读 ·
          <button type="button" className="btn sm" onClick={() => { setFilter("unread"); onSelect(null); }}>筛出来看</button>
        </div>
      )}
      {!selectedItem && !readOnly && !statusField && (checkedItems.length > 0 ? (
        <div className="bulkbar">
          已勾选 {checkedItems.length} 个条目。
          <button type="button" className="btn sm pri" disabled={writesOff} title={offTitle} onClick={() => void markMany(checkedItems)} data-testid="bulk-viewed">把选中的这几条标为已读</button>
          <button type="button" className="btn sm" onClick={() => setChecked(new Set())}>取消勾选</button>
        </div>
      ) : null)}
      <div className="items-body">
        {selectedItem && def ? (
          <ItemDetail task={task} item={selectedItem} def={def} readOnly={readOnly} writesOff={writesOff} pending={pendingItems.has(selectedItem.item_id)} submit={submit}
            reviewOff={reviewOffReason(task, { readOnly, writesOff, running: reviewing, count: 1 })}
            onReview={onReview ? (force) => reviewItems([selectedItem], `评审 ${selectedItem.item_id}`, force) : undefined} onPrefill={onPrefill}
            marked={marks[selectedItem.item_id] ?? []} just={just.has(selectedItem.item_id)} onBack={() => onSelect(null)}
            onPrev={pos > 0 ? () => onSelect(items[pos - 1].item_id) : null}
            onNext={pos >= 0 && pos < items.length - 1 ? () => onSelect(items[pos + 1].item_id) : null}
            onLocate={onLocate} onOpenItem={onSelect} onAskAssistant={onAskAssistant}
            view={view && view.itemId === selectedItem.item_id ? view : null} latestRevision={latestRevision} onDirty={(d) => { setDirty(d); onDirty?.(d); }}
            crumb={fromIssue ? <FromIssueCrumb issueId={fromIssue.issueId} onBack={() => backToIssue(fromIssue.issueId)} /> : null}
            top={<ItemIssues task={task} itemId={selectedItem.item_id} readOnly={readOnly} writesOff={writesOff} hold={dirty} pendingItems={pendingItems}
              submit={submit} onSend={onSend} onPrefill={onAnswer} fromIssue={fromIssue?.issueId ?? null} />} />
        ) : items.length === 0 ? (
          <div className="empty">这个筛选下没有条目。换一个筛选试试。</div>
        ) : statusField && def ? (
          <div className="list">
            {items.map((item) => (
              <PendingCard key={item.item_id} task={task} item={item} readOnly={readOnly} writesOff={writesOff} flash={flash.includes(item.item_id)}
                hit={hitIds.includes(item.item_id)} just={just.has(item.item_id)} pending={pendingItems.has(item.item_id)}
                onOpen={() => onSelect(item.item_id)} onOpenItem={(id) => openItem(id, { fromIssue: item.item_id })}
                onKeep={() => void submit({ kind: "keep_pending", targets: [{ item_id: item.item_id, base_revision: item.revision_no }], notify_executor: false }, `把 ${item.item_id} 标为先不管`)}
                onAnswer={() => onAnswer?.(item)} />
            ))}
          </div>
        ) : (
          <div className="list">
            {def?.display?.note && <CollectionLead name={def.name} note={def.display.note} unlinked={unlinkedIds(task, def.name)} />}
            {items.map((item) => {
              const summary = summaryOf(task, item);
              return (
                <div key={item.item_id}>
                  <div className={`lrow${checked.has(item.item_id) ? " sel" : ""}${flash.includes(item.item_id) ? " flash" : ""}${hitIds.includes(item.item_id) ? " sw-hit" : ""}${needsReading(task, item.collection) && isUnread(item) ? " unread" : ""}`}
                    onClick={() => onSelect(item.item_id)} data-testid={`item-${item.item_id}`}>
                    <input type="checkbox" checked={checked.has(item.item_id)} disabled={off} onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setChecked((s) => { const n = new Set(s); if (e.target.checked) n.add(item.item_id); else n.delete(item.item_id); return n; })} />
                    <span className="lid">{item.item_id}</span>
                    <span className="lname" title={item.title}>{item.title}</span>
                    <span className="lsum" title={summary}>{summary}</span>
                    <ItemStatus task={task} item={item} just={just.has(item.item_id)} pending={pendingItems.has(item.item_id)} row />
                    <IssueBadge task={task} itemId={item.item_id} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 任务定义「界面」里写了说明的集合：页签下先写一句白话说明它是什么，再写有几条还没和任何条目关联。 */
export function CollectionLead({ name, note, unlinked }: { name: string; note: string; unlinked: string[] }) {
  return (
    <div className="dn-lead" data-testid="collection-lead">
      <b>{name}：{note}</b>
      {unlinked.length > 0 && <> 有 {unlinked.length} 条还没有和任何条目关联（{unlinked.join("、")}）。</>}
    </div>
  );
}

/** 问题条目卡片：编号、枚举字段与状态、牵涉的条目、事项正文、其余文本字段；未解决的带两个动作。 */
function PendingCard({ task, item, readOnly, writesOff, flash, hit, just, pending, onOpen, onOpenItem, onKeep, onAnswer }: {
  task: Task; item: Item; readOnly: boolean; writesOff: boolean; flash: boolean; hit: boolean; just: boolean; pending: boolean;
  onOpen: () => void; onOpenItem: (id: string) => void; onKeep: () => void; onAnswer: () => void;
}) {
  const def = task.definition.collections.find((c) => c.name === item.collection)!;
  const status = keepPendingField(task, item.collection)!;
  const open = item.fields[status.name] === (status.values ?? [])[0];
  const first = def.fields[0]?.name;
  const refs = def.fields.filter((f) => f.type === "条目引用").flatMap((f) => (Array.isArray(item.fields[f.name]) ? (item.fields[f.name] as string[]) : []));
  const texts = def.fields.filter((f) => f.type === "文本" && f.name !== first && !isEmptyValue(item.fields[f.name]));
  return (
    <div className={`tbd${flash ? " flash" : ""}${hit ? " sw-hit" : ""}`} data-testid={`item-${item.item_id}`}>
      <div className="th">
        <span className="tid">{item.item_id}</span>
        <ItemStatus task={task} item={item} just={just} pending={pending} />
        {refs.length > 0 && <span style={{ fontSize: "0.889rem", color: "var(--mut)" }}>牵涉 {refs.map((r) => <span key={r} className="ref" role="button" onClick={() => onOpenItem(r)}>{r}</span>)}</span>}
        <button type="button" className="btn sm" style={{ marginLeft: "auto" }} onClick={onOpen}>看详情</button>
      </div>
      <div className="item-text">{first ? String(item.fields[first] ?? item.title) : item.title}</div>
      {texts.map((f) => <div className="sug" key={f.name}><b>{f.name}：</b>{String(item.fields[f.name])}</div>)}
      {open && (
        <div className="tfoot">
          {/* 「回答这个问题」只往对话区输入框里预填一句话、不写库，执行者工作中也可用；「先不管，保留」是写入，工作中灰化 */}
          <button type="button" className="aibtn" disabled={readOnly} onClick={onAnswer} data-testid={`answer-${item.item_id}`}>回答这个问题</button>
          <span className="aihint">回答要发给助手，它改完要等一会儿</span>
          <button type="button" className="btn sm" disabled={readOnly || writesOff || pending} title={writeOffReason(task, { readOnly, writesOff, pending })} onClick={onKeep}
            data-testid={`keep-${item.item_id}`}>先不管，保留</button>
        </div>
      )}
    </div>
  );
}
