// 条目区，照设计原型：顶上一行集合页签与「生成文档」，下面一行筛选与进度（点开是完成条件），
// 确认失效的集中提示与批量确认条，然后是列表；点一行，列表换成这个条目的详情（带「回到列表」）。
// 待定事项一类的集合（有取值「用户决定保留」的枚举字段）铺成一张张卡片，未解决的带「回答这个问题」「先不管，保留」。
// 最近一次工作改过的条目短时高亮并带「第 N 版 · 刚改」。集合名、字段名一律取自任务定义。

import { useEffect, useMemo, useState } from "react";
import type { Item, Task } from "../../api/types";
import { conditionState, confirmState, FILTERS, isEmptyValue, keepPendingField, matchesFilter, type ItemFilter } from "../../model/items";
import { ItemDetail, type SubmitAction } from "./ItemDetail";
import { ItemStatus } from "./ItemStatus";
import { StaleDiff } from "./StaleDiff";

export function ItemsPanel({ task, readOnly, recentlyChanged, justChanged = {}, pendingItems, selected, onSelect, submit, onGenerateDoc, onLocate, onAskAssistant, onAnswer }: {
  task: Task;
  readOnly: boolean;
  recentlyChanged: string[];
  /** 最近一次工作改过的条目 → 改后的版本号。 */
  justChanged?: Record<string, number>;
  pendingItems: Set<string>;
  selected: string | null;
  onSelect: (itemId: string | null) => void;
  submit: SubmitAction;
  onGenerateDoc: () => void;
  onLocate?: (excerpt: string, locator: string) => void;
  onAskAssistant?: (itemId: string) => void;
  /** 待定事项卡片上的「回答这个问题」：预填对话区输入框。 */
  onAnswer?: (item: Item) => void;
}) {
  const collections = task.definition.collections;
  const selectedItem = task.items.find((i) => i.item_id === selected);
  const [tab, setTab] = useState<string>(selectedItem?.collection ?? collections[0]?.name ?? "");
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [showProgress, setShowProgress] = useState(false);
  const [flash, setFlash] = useState<string[]>([]);
  const activeTab = selectedItem?.collection ?? tab;

  // 从卡片、改动块点来的条目：切到它所在的集合、不让筛选挡住它。
  useEffect(() => {
    if (!selected) return;
    const item = task.items.find((i) => i.item_id === selected);
    if (item) { setTab(item.collection); if (!matchesFilter(item, filter)) setFilter("all"); }
    document.querySelector(".app .items-body")?.scrollTo({ top: 0 });
  }, [selected]);
  // 库事件改过的条目闪一下。
  useEffect(() => {
    if (!recentlyChanged.length) return;
    setFlash(recentlyChanged);
    const t = setTimeout(() => setFlash([]), 2400);
    return () => clearTimeout(t);
  }, [recentlyChanged]);

  const def = collections.find((c) => c.name === activeTab);
  const statusField = keepPendingField(task, activeTab);
  const items = useMemo(() => task.items.filter((i) => i.collection === activeTab && matchesFilter(i, filter)), [task.items, activeTab, filter]);
  const stale = task.items.filter((i) => confirmState(i) === "stale");
  const confirmedCount = task.items.filter((i) => confirmState(i) === "confirmed").length;
  const unresolved = task.items.filter((i) => {
    const f = keepPendingField(task, i.collection);
    return f && i.fields[f.name] === (f.values ?? [])[0];
  }).length;
  const checkedItems = items.filter((i) => checked.has(i.item_id));
  const pos = selectedItem ? items.findIndex((i) => i.item_id === selectedItem.item_id) : -1;

  const confirmMany = async (list: Item[]) => {
    const e = await submit({ kind: "confirm", targets: list.map((i) => ({ item_id: i.item_id, base_version: i.version_no })), notify_executor: false },
      `确认 ${list.map((i) => i.item_id).join("、")}`);
    if (!e) setChecked(new Set());
  };
  const waiting = statusField ? [] : items.filter((i) => confirmState(i) !== "confirmed");

  return (
    <div className="pane-items" data-testid="items-panel">
      <div className="itabs">
        {collections.map((c) => (
          <span key={c.name} className={`itab${c.name === activeTab ? " on" : ""}`} role="tab"
            onClick={() => { setTab(c.name); onSelect(null); }}>
            {c.name}<span className="cnt">{task.items.filter((i) => i.collection === c.name).length}</span>
          </span>
        ))}
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={onGenerateDoc}>生成文档</button>
      </div>
      <div className="filters">
        {FILTERS.map((f) => (
          <span key={f.key} className={`filt${filter === f.key ? " on" : ""}${f.key === "review_failed" || f.key === "stale" ? " warn" : ""}`}
            role="button" onClick={() => { setFilter(f.key); onSelect(null); }}>{f.label}</span>
        ))}
        <span className="prog" role="button" onClick={() => setShowProgress(!showProgress)} data-testid="progress">
          {task.items.length} 个条目，{confirmedCount} 个已确认；待定事项 {unresolved} 条未解决 {showProgress ? "▴" : "▾"}
        </span>
      </div>
      <div className={`prog-detail${showProgress ? " show" : ""}`}>
        {task.completion ? (
          <>
            <div>这份交付物什么时候算做完，由下面这几条决定：</div>
            <ul>
              {task.completion.conditions.map((c, i) => (
                <li key={i}>{(() => { const s = conditionState(c); return <span className={s === "met" ? "g-ok" : s === "empty" ? "muted" : "g-warn"}>{s === "met" ? "已达成" : s === "empty" ? "暂无条目" : "还差"}</span>; })()} — {c.collection}：{c.name}。{c.note}</li>
              ))}
            </ul>
          </>
        ) : <div>完成条件这次没有算出来。</div>}
      </div>
      {stale.length > 0 && filter !== "stale" && (
        <div className="alertbar">
          有 {stale.length} 个条目在你确认之后又被改过，需要你重新确认。
          <button type="button" className="btn sm" onClick={() => { setFilter("stale"); onSelect(null); }}>看看是哪几个</button>
        </div>
      )}
      {!selectedItem && !readOnly && !statusField && (checkedItems.length > 0 ? (
        <div className="bulkbar">
          已勾选 {checkedItems.length} 个条目。
          <button type="button" className="btn sm pri" onClick={() => void confirmMany(checkedItems)} data-testid="bulk-confirm">确认选中的这几个</button>
          <button type="button" className="btn sm" onClick={() => setChecked(new Set())}>取消勾选</button>
        </div>
      ) : (filter === "confirm_pending" || filter === "stale") && waiting.length > 0 ? (
        <div className="bulkbar">
          这一页有 {waiting.length} 个条目等你确认。
          <button type="button" className="btn sm" onClick={() => void confirmMany(waiting)}>这一页都没问题，全部确认</button>
        </div>
      ) : null)}
      <div className="items-body">
        {selectedItem && def ? (
          <ItemDetail task={task} item={selectedItem} def={def} readOnly={readOnly} pending={pendingItems.has(selectedItem.item_id)} submit={submit}
            justVersion={justChanged[selectedItem.item_id]} onBack={() => onSelect(null)}
            onPrev={pos > 0 ? () => onSelect(items[pos - 1].item_id) : null}
            onNext={pos >= 0 && pos < items.length - 1 ? () => onSelect(items[pos + 1].item_id) : null}
            onLocate={onLocate} onOpenItem={onSelect} onAskAssistant={onAskAssistant} />
        ) : items.length === 0 ? (
          <div className="empty">这个筛选下没有条目。换一个筛选试试。</div>
        ) : statusField && def ? (
          <div className="list">
            {items.map((item) => (
              <PendingCard key={item.item_id} task={task} item={item} readOnly={readOnly} flash={flash.includes(item.item_id)}
                justVersion={justChanged[item.item_id]} pending={pendingItems.has(item.item_id)} onOpen={() => onSelect(item.item_id)} onOpenItem={onSelect}
                onKeep={() => void submit({ kind: "keep_pending", targets: [{ item_id: item.item_id, base_version: item.version_no }], notify_executor: false }, `把 ${item.item_id} 标为先不管`)}
                onAnswer={() => onAnswer?.(item)} />
            ))}
          </div>
        ) : (
          <div className="list">
            {items.map((item) => (
              <div key={item.item_id}>
                <div className={`lrow${checked.has(item.item_id) ? " sel" : ""}${flash.includes(item.item_id) ? " flash" : ""}`}
                  onClick={() => onSelect(item.item_id)} data-testid={`item-${item.item_id}`}>
                  <input type="checkbox" checked={checked.has(item.item_id)} disabled={readOnly} onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setChecked((s) => { const n = new Set(s); if (e.target.checked) n.add(item.item_id); else n.delete(item.item_id); return n; })} />
                  <span className="lid">{item.item_id}</span>
                  <span className="lname">{item.title}</span>
                  <ItemStatus task={task} item={item} justVersion={justChanged[item.item_id]} pending={pendingItems.has(item.item_id)} />
                </div>
                {filter === "stale" && def && (
                  <StaleDiff taskId={task.task_id} item={item} def={def} disabled={readOnly || pendingItems.has(item.item_id)}
                    onReconfirm={() => void submit({ kind: "confirm", targets: [{ item_id: item.item_id, base_version: item.version_no }], notify_executor: false }, `重新确认 ${item.item_id}`)}
                    onOpen={() => onSelect(item.item_id)} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 待定事项卡片（原型的「待定清单」）：编号、枚举字段与状态、牵涉的条目、事项正文、其余文本字段；未解决的带两个动作。 */
function PendingCard({ task, item, readOnly, flash, justVersion, pending, onOpen, onOpenItem, onKeep, onAnswer }: {
  task: Task; item: Item; readOnly: boolean; flash: boolean; justVersion?: number; pending: boolean;
  onOpen: () => void; onOpenItem: (id: string) => void; onKeep: () => void; onAnswer: () => void;
}) {
  const def = task.definition.collections.find((c) => c.name === item.collection)!;
  const status = keepPendingField(task, item.collection)!;
  const open = item.fields[status.name] === (status.values ?? [])[0];
  const first = def.fields[0]?.name;
  const refs = def.fields.filter((f) => f.type === "条目引用").flatMap((f) => (Array.isArray(item.fields[f.name]) ? (item.fields[f.name] as string[]) : []));
  const texts = def.fields.filter((f) => f.type === "文本" && f.name !== first && !isEmptyValue(item.fields[f.name]));
  return (
    <div className={`tbd${flash ? " flash" : ""}`} data-testid={`item-${item.item_id}`}>
      <div className="th">
        <span className="tid">{item.item_id}</span>
        <ItemStatus task={task} item={item} justVersion={justVersion} pending={pending} />
        {refs.length > 0 && <span style={{ fontSize: ".72rem", color: "var(--mut)" }}>牵涉 {refs.map((r) => <span key={r} className="ref" role="button" onClick={() => onOpenItem(r)}>{r}</span>)}</span>}
        <button type="button" className="btn sm" style={{ marginLeft: "auto" }} onClick={onOpen}>看详情</button>
      </div>
      <div className="item-text">{first ? String(item.fields[first] ?? item.title) : item.title}</div>
      {texts.map((f) => <div className="sug" key={f.name}><b>{f.name}：</b>{String(item.fields[f.name])}</div>)}
      {open && (
        <div className="tfoot">
          <button type="button" className="aibtn" disabled={readOnly} onClick={onAnswer} data-testid={`answer-${item.item_id}`}>回答这个问题</button>
          <span className="aihint">回答要发给助手，它改完要等一会儿</span>
          <button type="button" className="btn sm" disabled={readOnly || pending} onClick={onKeep}>先不管，保留</button>
        </div>
      )}
    </div>
  );
}
