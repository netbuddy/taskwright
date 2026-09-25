// 条目详情：照设计原型画成一张表——左列字段名（必填带星），右列带边框的值格；列表型字段每步一行、行首是序号；
// 每个值格下方是支持这个字段的来源小标签（材料文件名、执行者补充、用户的话、领域说明、用户直接修改五种各有配色），
// 点材料标签，文档区滚到并高亮那句原文；点领域说明标签（「领域说明 DN-003」），打开那条领域说明。
// 任务定义「界面」一项写了的集合（例如领域说明）：关联条目旁写上标题，来源之后另列「被哪些条目引用」。顶部一行：编号、标题、评审与已读状态、修订下拉、上一条与下一条；
// 有助手补充时顶部一条琥珀色横幅；底部「来源」一节按种类列小标签加摘录。
// 没有「确认」按钮：用户打开详情就记为已读（页面在打开时发 mark_viewed），已读就算确认。用户在这里改字段或标为先不管，
// 后端随修订自动写一条确认标记。已读是条目级、单向的，没有撤回按钮。
// 问题条目（见 keepPendingField）写下之后只由用户了结：底部只有「先不管，保留」与「删除」，不能直接修改。
//
// 修订：条目的内容由「条目编号加修订号」标识。下拉列出它改动过的修订，选一个看它那时的样子，
// 画线的地方是和它上一次改动的差别。字段修订标识：自上次确认的修订以来助手改过的字段
// 整块加琥珀色边框（marked，由 model/revisions.ts 从修订日志算出），划掉与加线默认和上次确认的修订比（从没确认过的和新增时比）；
// 打开详情就记为已读，库事件一到边框的依据就没了，所以边框与比较基准在条目变成已读的那一刻停住（seen）：
// 这次打开一直看得到，下次再打开边框与「刚改」就不再出现。
//
// 直接操作全部走 actions；响应只当作接受或拒绝，界面上的变化等库事件到了才发生。
// 单一写入者：执行者工作中（writesOff）改字段、删除、先不管全部灰化，底部写明原因；灰化的写入按钮都带悬停说明（writeOffReason）；
// 「让助手来改这一条」只预填输入框，照常可用。进入编辑时记下改前所在的修订与字段（editBase），保存用它作 base_revision；
// 两个页面同时编辑同一条目时后端以 stale_revision 拒绝，这里只提示「这条已被改到修订 N，请重新打开」，不提供合并。
// 编辑框里的内容与打开时不同，就是「有未保存的条目编辑」，经 onDirty 告诉页面，对话区的发送与卡片按钮据此灰化。
//
// 评审：右上角「评审这条」发 request_review（只带这个条目）。条目当前所在的修订上有评审记录时，每条发现标在它的字段旁：
// 问题（必选规则）红色、建议（可选规则）琥珀色，末尾「违反 UC-R9」点一下展开那条规则的条文（规则清单取自任务定义），
// 旁边「让助手照这条改」往对话区输入框预填一句话，不写库。标题字段有发现时也照常列出这一行。
// 每条发现分两行（FindingLine，与评审页签共用）：第一行是发现本身与「第 N 次评审指出」，第二行是去向（未处理／已在修订 N 改／已保留 · 理由）
// 与操作链接（让助手照这条改、保留这种写法、撤销保留）；保留与评审页签是同一个操作（理由可空）。
// 顶部横幅只在还有未处理的问题时显示一行「评审不通过：N 处问题未处理……」；保留的理由与「撤销保留」只在发现行第二行。条目在当前修订、当前规则下已经评过时，
// 「评审这条」灰化并说明，旁边小字「仍要重评」，确认之后带 force 再评一次。

import { useEffect, useState, type ReactNode } from "react";
import { Popconfirm, Select } from "antd";
import { api, ApiError } from "../../api/client";
import type { ActionRequest, CollectionDef, FieldDef, FieldValue, Fields, Finding, Item, ItemRevision, ReviewRule, Source, Task } from "../../api/types";
import { alignSteps } from "../../model/diff";
import { BUSY_TEXT, batchNo, currentReview, findingStatus, type FindingStatus, isEmptyValue, isListField, isProblem, keepPendingField, KEEP_PENDING_VALUE, needsReview, reviewState, ruleOf, seenCurrent, sourcesFor, writeOffReason } from "../../model/items";
import { baselineRevision, confirmedRevision } from "../../model/revisions";
import { formatTime } from "../../model/format";
import { errorText } from "./errors";
import { ItemStatus } from "./ItemStatus";
import { citationsOf, displayOf, liveOwnRefs, SOURCE_DOMAIN_NOTE } from "../../model/domainNotes";
import { FindingLine } from "./FindingLine";
import { IssueBadge } from "./ItemIssues";

/** 从修订页签的「查看差异」来的请求：打开这个条目并停在那次修订。nonce 每点一次加一。 */
export interface ViewRequest {
  itemId: string;
  revision: number;
  nonce: number;
}

export type SubmitAction = (req: Pick<ActionRequest, "kind" | "targets" | "fields" | "notify_executor">, label: string) => Promise<ApiError | null>;

/** 条目在修订 n 时的内容：改动过它的修订里不大于 n 的最近一次。 */
function contentAt(revisions: ItemRevision[] | null, n: number | null): ItemRevision | null {
  if (!revisions || n == null) return null;
  return [...revisions].filter((r) => r.revision_no <= n).sort((a, b) => b.revision_no - a.revision_no)[0] ?? null;
}

export function ItemDetail({ task, item, def, readOnly, writesOff = false, pending, submit, marked = [], onBack, onPrev, onNext, onLocate, onOpenItem,
  onAskAssistant, view = null, latestRevision = 0, onDirty, just = false, onReview, reviewOff, onPrefill, top = null, crumb = null }: {
  task: Task;
  item: Item;
  def: CollectionDef;
  /** 任务已结束或助手不可用。 */
  readOnly: boolean;
  /** 执行者正在工作：写入按钮灰化。 */
  writesOff?: boolean;
  pending: boolean;
  submit: SubmitAction;
  /** 自上次确认的修订以来助手改过的字段；这些字段加框。 */
  marked?: string[];
  /** 执行者最近一次运行改过这个条目：带「修订 N · 刚改」。 */
  just?: boolean;
  onBack?: () => void;
  onPrev?: (() => void) | null;
  onNext?: (() => void) | null;
  onLocate?: (excerpt: string, locator: string) => void;
  onOpenItem?: (itemId: string) => void;
  /** 「让助手来改这一条」：预填对话区输入框。 */
  onAskAssistant?: (itemId: string) => void;
  view?: ViewRequest | null;
  /** 任务最新的修订号：编辑时提示保存会产生哪次修订。 */
  latestRevision?: number;
  onDirty?: (dirty: boolean) => void;
  /** 「评审这条」。 */
  onReview?: (force?: boolean) => void;
  /** 评审按钮灰化的原因；可用时为 undefined。 */
  reviewOff?: string;
  /** 「让助手照这条改」：预填对话区输入框。 */
  onPrefill?: (text: string) => void;
  /** 标题行之下、字段之上的一块（「挂在这条上的问题」，见 ItemIssues）。 */
  top?: ReactNode;
  /** 顶部那一行换成这个（从问题跳来时的「回到问题列表」）；不给时是「回到列表」。 */
  crumb?: ReactNode;
}) {
  // 边框与比较基准（见文件头）：条目当前所在的修订还没看过时一直跟着最新的算（修订日志可能比条目事件晚到），
  // 这次修订记为看过之后就停在那之前的样子；条目换了或改到新修订，重新开始跟。
  const seenKey = `${item.item_id}@${item.revision_no}`;
  const live = { key: seenKey, marked, base: baselineRevision(item), everConfirmed: confirmedRevision(item) != null };
  const [frozen, setFrozen] = useState(live);
  const follow = frozen.key !== seenKey || !seenCurrent(item);
  const seen = follow ? live : frozen;
  if (follow && (frozen.key !== live.key || frozen.marked.join("\n") !== live.marked.join("\n") || frozen.base !== live.base || frozen.everConfirmed !== live.everConfirmed)) {
    setFrozen(live);
  }
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Fields>(item.fields);
  const [error, setError] = useState<ApiError | null>(null);
  const [revisions, setRevisions] = useState<ItemRevision[] | null>(null);
  /** 修订列表这次没读到：保持 revisions 为 null（不当作只有一次修订），下拉框上提示；条目换了或修订号变了再读。 */
  const [revisionsMissed, setRevisionsMissed] = useState(false);
  const [viewRevision, setViewRevision] = useState<number | null>(null);
  const [compare, setCompare] = useState(false);
  /** 进入编辑时条目所在的修订与字段；不在编辑时为 null。 */
  const [editBase, setEditBase] = useState<{ revision_no: number; fields: Fields } | null>(null);

  useEffect(() => { if (!editing) setDraft(item.fields); }, [item.fields, editing]);
  // 换到另一个条目时退出编辑：编辑框里的草稿与 editBase 都属于原来那个条目，不能拿去保存到新条目上。
  useEffect(() => { setViewRevision(null); setCompare(false); setEditing(false); setEditBase(null); setError(null); }, [item.item_id]);
  // 修订页签点「查看差异」：停在那次修订。就是当前所在的修订时看最新，并打开和上一次改动的比对，
  // 否则没有修订标识的条目（例如只被用户自己改过）点了什么也不画。
  useEffect(() => { if (view) { const latest = view.revision === item.revision_no; setViewRevision(latest ? null : view.revision); setCompare(latest); } }, [view?.nonce]);
  useEffect(() => {
    let live = true;
    setRevisionsMissed(false);
    if (item.revisions.length > 1) {
      api.itemRevisions(task.task_id, item.item_id).then((v) => { if (live) setRevisions(v); })
        .catch(() => { if (live) { setRevisions(null); setRevisionsMissed(true); } });
    } else setRevisions(null);
    return () => { live = false; };
  }, [task.task_id, item.item_id, item.revision_no, item.revisions.length]);
  const dirty = editing && editBase != null && JSON.stringify(draft) !== JSON.stringify(editBase.fields);
  useEffect(() => { onDirty?.(dirty); }, [dirty]);
  useEffect(() => () => onDirty?.(false), []);

  const run = async (req: Parameters<SubmitAction>[0], label: string, after?: () => void) => {
    setError(null);
    const e = await submit(req, label);
    if (e) setError(e);
    else after?.();
  };
  const target = [{ item_id: item.item_id, base_revision: item.revision_no }];
  const review = reviewState(item, task);
  // 任务定义「界面」一项写了的集合（例如领域说明）：详情里另列「被哪些条目引用」，关联条目旁写上标题。
  const display = displayOf(task, item.collection);
  const titleOf = (id: string) => task.items.find((i) => i.item_id === id)?.title ?? "";
  const keepField = keepPendingField(task, item.collection);
  const shownNo = viewRevision ?? item.revision_no;
  const shown = viewRevision != null ? revisions?.find((v) => v.revision_no === viewRevision) ?? null : null;
  const old = viewRevision != null && viewRevision !== item.revision_no;
  const fields = shown?.fields ?? item.fields;
  const sources = shown?.sources ?? item.sources;
  /** 条目在 n 之前改动的那次修订。 */
  const priorOf = (n: number) => [...item.revisions].filter((x) => x < n).pop() ?? null;
  const previousNo = priorOf(shownNo);
  const previous = previousNo != null ? revisions?.find((v) => v.revision_no === previousNo)?.fields ?? null : null;
  const markedSet = new Set(seen.marked);
  const showMarks = !old && seen.marked.length > 0;
  const base = seen.base;
  const baseFields = showMarks ? contentAt(revisions, base)?.fields ?? null : null;
  const everConfirmed = seen.everConfirmed;
  /** 画线的比较对象：看旧修订时是它的上一次改动；有修订标识时是上次确认的修订；点了「比对」时是上一次改动。 */
  const beforeFields = old ? previous : showMarks ? baseFields : compare ? previous : null;
  const supplements = sources.filter((s) => s.kind === "执行者补充");
  // 当前所在的修订上最近一条评审的发现（通过时也可能有建议）；看旧修订时不标。
  const current = old ? undefined : currentReview(item, task);
  const findings = current?.findings ?? [];
  const currentNo = batchNo(task, current?.batch_id);
  const status = current ? findingStatus(item, current) : null;
  /** 在当前修订、当前规则下已经评过：「评审这条」灰化，只能「仍要重评」。 */
  const reviewedNow = !!currentReview(item, task);
  const keepable = !!current && current.verdict !== "合规" && status?.kind === "open";
  const keep = (reason: string) => void run({ kind: "waive_review", targets: [{ item_id: item.item_id, base_revision: item.revision_no }],
    fields: { reason: reason.trim(), source: "detail" }, notify_executor: false }, `保留 ${item.item_id} 现在的写法`);
  const unwaive = () => void run({ kind: "unwaive_review", targets: [{ item_id: item.item_id, base_revision: item.revision_no }], notify_executor: false },
    `撤销对 ${item.item_id} 的保留`);
  const writeOff = readOnly || writesOff || pending;
  const offTitle = writeOffReason(task, { readOnly, writesOff, pending });
  const editOffTitle = writeOffReason(task, { readOnly, writesOff, pending, old });

  const startEdit = () => { setEditBase({ revision_no: item.revision_no, fields: item.fields }); setDraft(item.fields); setError(null); setEditing(true); };
  const stopEdit = () => { setEditing(false); setEditBase(null); };
  const editFrom = editBase ?? { revision_no: item.revision_no, fields: item.fields };
  /** 用户在编辑框里真正改过的字段：与进入编辑时比，不与当前内容比（当前内容可能已被另一个页面改过）。 */
  const myChanges = (): Fields => {
    const changed: Fields = {};
    for (const f of def.fields) {
      if (JSON.stringify(draft[f.name] ?? null) !== JSON.stringify(editFrom.fields[f.name] ?? null)) changed[f.name] = normalize(f, draft[f.name]);
    }
    return changed;
  };
  const save = () => {
    const changed = myChanges();
    if (!Object.keys(changed).length) { stopEdit(); return; }
    void run({ kind: "edit_fields", targets: [{ item_id: item.item_id, base_revision: editFrom.revision_no }], fields: changed, notify_executor: false },
      `修改 ${item.item_id} 的${Object.keys(changed).join("、")}`, stopEdit);
  };

  return (
    <div className="detail" data-testid="item-detail">
      {crumb ?? (onBack && <span className="crumb" role="button" onClick={onBack}>‹ 回到列表</span>)}
      <div className="dh">
        <span className="id">{item.item_id}</span>
        <b className="title" role="heading" aria-level={3}>{item.title}</b>
        <ItemStatus task={task} item={item} just={just} pending={pending} />
        <IssueBadge task={task} itemId={item.item_id} />
        <span className="pager">
          {!keepField && onReview && needsReview(task, item.collection) && (
            <>
              <button type="button" className="btn sm" disabled={!!reviewOff || reviewedNow}
                title={reviewOff ?? (reviewedNow ? `这条在当前修订上已经评过${currentNo ? `（第 ${currentNo} 次评审）` : ""}，内容和规则都没变。` : undefined)}
                onClick={() => onReview()} data-testid="review-one">评审这条</button>
              {reviewedNow && !reviewOff && (
                <Popconfirm title="再评一次会产生新的记录，最新一次为准。" okText="再评一次" cancelText="取消" onConfirm={() => onReview(true)}>
                  <span className="rerun" role="button" data-testid="review-again">仍要重评</span>
                </Popconfirm>
              )}
            </>
          )}
          {!keepField && onAskAssistant && (
            <button type="button" className="aibtn" disabled={readOnly} onClick={() => onAskAssistant(item.item_id)} data-testid="ask-assistant">让助手来改这一条</button>
          )}
          {revisions && revisions.length > 1 ? (
            <select className="vsel" value={shownNo} onChange={(e) => { const n = Number(e.target.value); setViewRevision(n === item.revision_no ? null : n); setCompare(false); }} data-testid="revision-select">
              {[...revisions].reverse().map((v) => (
                <option key={v.revision_no} value={v.revision_no}>修订 {v.revision_no} · {v.by === "user" ? "由你修改" : "由助手写的"} · {formatTime(v.at)}</option>
              ))}
            </select>
          ) : (
            <select className="vsel" value={item.revision_no} disabled
              title={revisionsMissed ? "修订列表没读到，再打开一次试试" : undefined} data-testid={revisionsMissed ? "revisions-missed" : undefined}>
              <option value={item.revision_no}>{revisionsMissed ? "修订列表没读到，再打开一次试试"
                : `修订 ${item.revision_no} · ${item.revision_by === "user" ? "由你修改" : "由助手写的"} · ${formatTime(item.revision_at)}`}</option>
            </select>
          )}
          {onPrev !== undefined && <button type="button" className="btn sm" style={onPrev ? undefined : { opacity: .4 }} onClick={() => onPrev?.()}>‹ 上一条</button>}
          {onNext !== undefined && <button type="button" className="btn sm" style={onNext ? undefined : { opacity: .4 }} onClick={() => onNext?.()}>下一条 ›</button>}
        </span>
      </div>
      {top}

      {error && (
        <div className="err" data-testid="action-error">
          <span className="x" role="button" onClick={() => setError(null)}>×</span>
          {errorText(error)}
        </div>
      )}

      {old && (
        <div className="banner-line diff" data-testid="old-banner">你在看修订 {shownNo} 时这个条目的样子（不是最新）{previousNo != null ? `，画了线的地方是和修订 ${previousNo} 的差别` : "，这是它第一次出现"}。
          <button type="button" className="btn sm" onClick={() => setViewRevision(null)}>回到最新</button></div>
      )}
      {!old && showMarks && (
        <div className="banner-line diff" data-testid="mark-banner">
          {everConfirmed ? `与你上次确认的修订 ${base} 相比，改了这几处` : `这个条目还没有确认过；与它新增时的修订 ${base} 相比，改了这几处`}：
          加了框的字段是助手改的，划掉的是修订 {base} 的写法，加底线的是现在的写法。打开就算你看过了，下次再打开框就不再出现。
        </div>
      )}
      {!old && !showMarks && previousNo != null && (compare ? (
        <div className="banner-line diff" data-testid="compare-banner">正在和修订 {previousNo} 比对：划掉的是原来的写法，加底线的是现在的写法。
          <button type="button" className="btn sm" onClick={() => setCompare(false)}>收起比对</button></div>
      ) : (
        <div className="banner-line">现在的内容是修订 {item.revision_no} 写的。
          <button type="button" className="btn sm" onClick={() => setCompare(true)} data-testid="compare-open">和修订 {previousNo} 比对</button></div>
      ))}
      {/* 评审状态只有两个落点：徽标给结论，发现行给细节。横幅只在还有未处理的问题时提醒一行；都已保留或已改时不显示。 */}
      {review.state === "failed" && !review.kept && (
        <div className="banner-line gap" data-testid="review-banner"><span><b>评审不通过：</b>{review.problems} 处问题未处理，标在下面对应的字段旁。</span></div>
      )}
      {supplements.length > 0 && !editing && (
        <div className="banner-line amber" data-testid="supplement-banner">
          <span><b>助手补充：</b>{supplements.map((s) => s.excerpt).join("；")}　这部分材料里没有，看的时候留意。</span>
        </div>
      )}

      {editing ? (
        <div data-testid="edit-form">
          {def.fields.map((f) => (
            <div className="fld" key={f.name}>
              <div className="k">{f.name}{f.required && <> <span style={{ color: "var(--gap)" }}>*</span></>}</div>
              <div className="v editing">
                <FieldEditor def={f} value={draft[f.name] ?? null} task={task} onChange={(v) => setDraft((d) => ({ ...d, [f.name]: v }))} />
              </div>
            </div>
          ))}
          <div className="edrow">
            <button type="button" className="btn sm pri" onClick={save} disabled={pending || writesOff} title={writeOffReason(task, { writesOff, pending })} data-testid="save-fields">保存</button>
            <button type="button" className="btn sm" onClick={() => { stopEdit(); setError(null); }} data-testid="cancel-edit">取消</button>
            <span style={{ fontSize: "0.881rem", color: "var(--mut)", alignSelf: "center" }}>保存后立刻生效，产生修订 {latestRevision + 1}</span>
          </div>
        </div>
      ) : (
        <>
          <div className="fld"><div className="k">编号</div><div className="v">{item.item_id}<span className="tagflag">编号由系统给，不可改</span></div></div>
          {def.fields.map((f) => {
            const value = fields[f.name];
            const own = findings.filter((x) => x.field === f.name);
            if (f.type === "文本" && value === item.title && !old && own.length === 0) return null; // 标题已在顶部那一行
            return (
              <FieldRow key={f.name} def={f} value={value ?? null} before={beforeFields ? beforeFields[f.name] ?? null : undefined}
                marked={showMarks && markedSet.has(f.name)} sources={sourcesForFields(sources, f.name)}
                findings={own} ruleOf={(id) => ruleOf(task, item.collection, id)}
                onFix={onPrefill ? (x) => onPrefill(fixText(item.item_id, x)) : undefined} fixOff={readOnly}
                status={status} batchNo={currentNo} onKeep={keepable && !writeOff ? keep : undefined}
                onUnwaive={status?.kind === "kept" && current?.revision_no === item.revision_no ? unwaive : undefined} unwaiveOff={writeOff}
                onLocate={onLocate} onOpenItem={onOpenItem} titleOf={titleOf} refTitles={!!display} />
            );
          })}

          <div className="sec-h">来源</div>
          {sources.map((s, i) => <SourceBox key={i} source={s} onLocate={onLocate} onOpenItem={onOpenItem} titleOf={titleOf} />)}
          {sources.length === 0 && <div className="srcbox"><div className="fields">这次修订没有记下任何来源。</div></div>}
          {display && <CitedBy task={task} item={item} onOpenItem={onOpenItem} />}

          {item.reviews.length > 0 && (
            <div className="muted small" style={{ marginTop: "0.571rem" }} data-testid="review-records">
              评审记录：{[...item.reviews].reverse().map((r) => reviewRecordText(r, item.revision_no)).join("；")}
            </div>
          )}
          {item.confirmations.length > 0 && (
            <>
              <div className="sec-h">确认记录</div>
              <div className="confirms" data-testid="confirmations">
                {item.confirmations.map((c, i) => (
                  <div key={i}>修订 {c.revision_no}：{confirmationText(c)} · {formatTime(c.at)}</div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {!editing && (
        <div className="dfoot sticky">
          {!keepField && <button type="button" className="btn" disabled={writeOff || old} title={editOffTitle} onClick={startEdit} data-testid="edit-item">修改</button>}
          {keepField && item.fields[keepField.name] !== KEEP_PENDING_VALUE && (
            <button type="button" className="btn" disabled={writeOff} title={offTitle}
              onClick={() => void run({ kind: "keep_pending", targets: target, notify_executor: false }, `把 ${item.item_id} 标为先不管`)}>先不管，保留</button>
          )}
          <Popconfirm title={`删除 ${item.item_id}？删除会产生一次修订，之后可以在右侧「修订」页签撤销这次修订。`} okText="删除" cancelText="取消" disabled={writeOff}
            onConfirm={() => void run({ kind: "delete_item", targets: target, notify_executor: false }, `删除 ${item.item_id}`)}>
            <button type="button" className="btn" disabled={writeOff} title={offTitle} data-testid="delete-item">删除</button>
          </Popconfirm>
          {writesOff ? <span className="sw-why" data-testid="busy-why">{BUSY_TEXT}</span>
            : <span className="aihint">{keepField ? "问题写下后不直接改：你的回答发给助手，它会改牵涉的条目，再问你这个问题是否已解决。" : "要让助手动手改，用右上角的「让助手来改这一条」。"}</span>}
        </div>
      )}
    </div>
  );
}

/** 「让助手照这条改」预填的那句话。 */
export function fixText(itemId: string, f: Finding): string {
  return `请按评审发现改 ${itemId} 的${f.field}${f.index != null ? `第 ${f.index + 1} 项` : ""}：${f.problem}`;
}

/** 评审记录里的一条：「修订 15 · 不合规 2 处（时刻）」「修订 12 · 合规（时刻）」。 */
function reviewRecordText(r: Item["reviews"][number], current: number): string {
  const list = r.findings ?? [];
  const problems = list.filter(isProblem).length;
  const advice = list.length - problems;
  const verdict = r.verdict === "合规" ? `合规${advice ? `（${advice} 条建议）` : ""}` : `不合规 ${problems} 处`;
  return `修订 ${r.revision_no ?? current} · ${verdict}${r.at ? `（${formatTime(r.at)}）` : ""}`;
}

/** 确认记录里一条标记的说法：写明依据。 */
function confirmationText(c: Item["confirmations"][number]): string {
  if (!c.accepted) return "你撤回了确认";
  if (c.basis === "viewed") return "你打开看过（已读）";
  if (c.basis === "ui_edit") return "你在界面上改了它，改出来的内容算作你已确认";
  if (c.basis === "user_words") return "早期版本登记的确认，依据是你在对话里说的话";
  return "你在界面上点的确认";
}

/** 支持某个字段的来源：指明了支持这个字段的那几条（整个条目的来源只在底部「来源」一节列）。 */
function sourcesForFields(sources: Source[], field: string): Source[] {
  return sourcesFor({ sources } as Item, field);
}

const fileName = (locator: string) => locator.split("/").pop() || locator;

/** 值格下方的一个来源小标签。种类为「领域说明」的写成「领域说明 DN-003」，点一下打开那条领域说明。 */
export function SourceTag({ source, onLocate, onOpenItem, titleOf }: {
  source: Source; onLocate?: (excerpt: string, locator: string) => void; onOpenItem?: (itemId: string) => void; titleOf?: (itemId: string) => string;
}) {
  if (source.kind === SOURCE_DOMAIN_NOTE) {
    const title = titleOf?.(source.locator);
    return <span className="srctag note" role="button" data-testid={`note-source-${source.locator}`}
      title={`${SOURCE_DOMAIN_NOTE} ${source.locator}${title ? `「${title}」` : ""}：${source.excerpt}（点一下，打开这条${SOURCE_DOMAIN_NOTE}）`}
      onClick={() => onOpenItem?.(source.locator)}>{SOURCE_DOMAIN_NOTE} {source.locator}</span>;
  }
  if (source.kind === "文档原文") {
    return <span className="srctag quote" title={`材料原文：${source.excerpt}（点一下，文档区滚到这句）`} role="button"
      onClick={() => onLocate?.(source.excerpt, source.locator)}>❝ {fileName(source.locator)}</span>;
  }
  if (source.kind === "执行者补充") return <span className="srctag added" title={source.excerpt}>助手补充</span>;
  if (source.kind === "用户的话") return <span className="srctag said" title={source.excerpt}>用户的话</span>;
  if (source.kind === "用户直接修改") return <span className="srctag edited" title={source.excerpt}>用户直接修改</span>;
  return <span className="srctag edited" title={source.excerpt}>{source.kind}</span>;
}

function FieldRow({ def, value, before, marked, sources, findings, ruleOf, onFix, fixOff, status = null, batchNo: no = null, onKeep, onUnwaive, unwaiveOff,
  onLocate, onOpenItem, titleOf, refTitles = false }: {
  def: FieldDef;
  value: FieldValue;
  /** 用来画线比较的那次修订里的值；undefined 表示不画线。 */
  before: FieldValue | undefined;
  /** 字段修订标识：自上次确认的修订以来助手改过，整块加框。 */
  marked: boolean;
  sources: Source[];
  /** 这个字段上的评审发现。 */
  findings: Finding[];
  /** 按编号找规则，展开条文用。 */
  ruleOf: (id: string | null | undefined) => ReviewRule | undefined;
  /** 「让助手照这条改」。 */
  onFix?: (finding: Finding) => void;
  fixOff?: boolean;
  /** 这次评审的发现的去向与出自第几次评审。 */
  status?: FindingStatus | null;
  batchNo?: number | null;
  /** 「保留这种写法」；不能保留时不给。 */
  onKeep?: (reason: string) => void;
  /** 「撤销保留」。 */
  onUnwaive?: () => void;
  unwaiveOff?: boolean;
  onLocate?: (excerpt: string, locator: string) => void;
  onOpenItem?: (itemId: string) => void;
  titleOf?: (itemId: string) => string;
  /** 条目引用的编号旁写上那个条目的标题。 */
  refTitles?: boolean;
}) {
  const changed = before !== undefined && JSON.stringify(before ?? null) !== JSON.stringify(value ?? null);
  let body: ReactNode;
  if (isEmptyValue(value)) {
    body = <>
      {changed && !isEmptyValue(before) && <span className="diff-old">{Array.isArray(before) ? before.join("；") : String(before)}</span>}
      <span className={`tagflag${def.required ? " req" : ""}`}>{def.required ? "必填 · 未填" : "没有内容"}</span>
    </>;
  } else if (def.type === "条目引用") {
    body = <span className="refs">{(Array.isArray(value) ? value : [value]).map((id) => (
      <span key={String(id)}>
        <span className="ref" role="button" onClick={() => onOpenItem?.(String(id))}>{id}</span>
        {refTitles && titleOf?.(String(id)) && <span className="muted"> {titleOf(String(id))}</span>}
      </span>
    ))}</span>;
  } else if (def.type === "枚举") {
    body = <>{changed && before && <span className="diff-old">{String(before)}</span>}<span className={`chip on enumv${changed ? " diff-new" : ""}`}>{String(value)}</span></>;
  } else if (isListField(def)) {
    const after = Array.isArray(value) ? value : [String(value)];
    if (changed) {
      const rows = alignSteps(Array.isArray(before) ? before : before ? [String(before)] : [], after);
      body = rows.map((r, i) => (
        <div className="stepline" key={i}>
          <span className="sn">{r.kind === "removed" ? "" : r.index + 1}</span>
          <span className="st">
            {r.kind === "same" && r.text}
            {r.kind === "added" && <><span className="diff-new">{r.text}</span><span className="diff-note">（新加的）</span></>}
            {r.kind === "removed" && <><span className="diff-old">{r.before}</span><span className="diff-note">（删掉了）</span></>}
            {r.kind === "changed" && <><span className="diff-old">{r.before}</span><span className="diff-new">{r.after}</span></>}
          </span>
        </div>
      ));
    } else {
      body = after.map((t, i) => <div className="stepline" key={i}><span className="sn">{i + 1}</span><span className="st">{t}</span></div>);
    }
  } else {
    body = changed
      ? <>{!isEmptyValue(before) && <span className="diff-old">{String(before)}</span>}<span className="diff-new">{String(value)}</span></>
      : String(value);
  }
  return (
    <div className={`fld${marked ? " sw-revmark" : ""}`} data-f={def.name} data-testid={marked ? `marked-${def.name}` : undefined}>
      <div className="k">{def.name}{def.required && <> <span style={{ color: "var(--gap)" }}>*</span></>}</div>
      <div className="v">
        {body}
        {findings.map((f, i) => <FindingLine key={i} finding={f} rule={ruleOf(f.rule_id)} onFix={onFix} fixOff={fixOff} status={status} batchNo={no}
          onKeep={isProblem(f) ? onKeep : undefined} onUnwaive={isProblem(f) ? onUnwaive : undefined} unwaiveOff={unwaiveOff} />)}
        {sources.length > 0 && <div className="srcs">{sources.map((s, i) => <SourceTag key={i} source={s} onLocate={onLocate} onOpenItem={onOpenItem} titleOf={titleOf} />)}</div>}
      </div>
    </div>
  );
}

function SourceBox({ source, onLocate, onOpenItem, titleOf }: {
  source: Source; onLocate?: (excerpt: string, locator: string) => void; onOpenItem?: (itemId: string) => void; titleOf?: (itemId: string) => string;
}) {
  const kinds: Record<string, [string, string]> = {
    文档原文: ["src", "材料原文"], 执行者补充: ["warn", "助手补充"], 用户的话: ["teal", "用户的话"], 用户直接修改: ["on", "用户直接修改"],
    [SOURCE_DOMAIN_NOTE]: ["note", SOURCE_DOMAIN_NOTE],
  };
  const [cls, name] = kinds[source.kind] ?? ["on", source.kind];
  const supports = source.supports ?? [];
  return (
    <div className={`srcbox${source.kind === "执行者补充" ? " added" : ""}`}>
      <div className="sh">
        <span className={`chip ${cls}`}>{name}</span>
        {source.kind === "文档原文" && (
          <span className="evi" role="button" onClick={() => onLocate?.(source.excerpt, source.locator)}>出处：{fileName(source.locator)}（点一下看原文）</span>
        )}
        {source.kind === SOURCE_DOMAIN_NOTE && (
          <> <span className="ref" role="button" onClick={() => onOpenItem?.(source.locator)}>{source.locator}</span> {titleOf?.(source.locator)}</>
        )}
      </div>
      <div className={`quote${source.kind === "用户的话" ? " said" : ""}`}>{source.kind === "文档原文" || source.kind === "用户的话" || source.kind === SOURCE_DOMAIN_NOTE ? `「${source.excerpt}」` : source.excerpt}</div>
      <div className="fields">
        {supports.length
          ? <>支持这几处：<b>{supports.map((x) => (x.index != null ? `${x.field}第 ${x.index + 1} 条` : x.field)).join("、")}</b></>
          : "没有指明它支持哪个字段，算作支持整个条目"}
      </div>
    </div>
  );
}

/**
 * 「被哪些条目引用」：别的条目把这一条写成来源（附支持的字段与引用的那句），或者在条目引用字段里写了它。
 * 都没有时写一句说明；它自己关联了还在的条目时注明不算「没有和任何条目关联」。
 */
function CitedBy({ task, item, onOpenItem }: { task: Task; item: Item; onOpenItem?: (itemId: string) => void }) {
  const cited = citationsOf(task, item.item_id);
  const own = liveOwnRefs(task, item);
  return (
    <>
      <div className="sec-h">被哪些条目引用</div>
      {cited.length === 0 ? (
        <div className="citedby-empty" data-testid="cited-by-none">
          还没有别的条目把它写成来源，也没有别的条目在关联条目里写它。
          {own.length > 0 ? `它自己关联了 ${own.join("、")}，所以不算「没有和任何条目关联」。` : "它现在没有和任何条目关联。"}
        </div>
      ) : cited.map((c, i) => (
        <div className="citedby" key={i} data-testid={`cited-by-${c.item.item_id}`}>
          <span className="ref" role="button" onClick={() => onOpenItem?.(c.item.item_id)}>{c.item.item_id}</span> {c.item.title} · {c.where} · 修订 {c.item.revision_no}
          <span className="how">{c.how === "source" ? "把它写成了来源" : "在关联条目里写了它"}</span>
          {c.excerpt && <div className="q">「{c.excerpt}」</div>}
        </div>
      ))}
    </>
  );
}

function normalize(def: FieldDef, value: FieldValue): FieldValue {
  if (isListField(def)) return (Array.isArray(value) ? value : []).map((s) => String(s).trim()).filter(Boolean);
  return value == null ? "" : String(value);
}

function FieldEditor({ def, value, task, onChange }: { def: FieldDef; value: FieldValue; task: Task; onChange: (v: FieldValue) => void }) {
  if (def.type === "枚举") {
    return (
      <select className="vsel" value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>请选一个</option>
        {(def.values ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  }
  if (def.type === "条目引用") {
    return <Select size="small" mode="multiple" style={{ width: "100%" }} value={Array.isArray(value) ? value : []} onChange={onChange}
      options={task.items.map((i) => ({ value: i.item_id, label: `${i.item_id} ${i.title}` }))} />;
  }
  if (def.type === "文本列表") {
    const list = Array.isArray(value) ? value : [];
    return (
      <div>
        {list.map((line, i) => (
          <div key={i} className="listed">
            <span className="sn">{i + 1}</span>
            <textarea className="ed" rows={1} value={line} onChange={(e) => onChange(list.map((x, j) => (j === i ? e.target.value : x)))} />
            <button type="button" className="btn sm" aria-label="删掉这一条" onClick={() => onChange(list.filter((_, j) => j !== i))}>删</button>
          </div>
        ))}
        <button type="button" className="btn sm ghost" onClick={() => onChange([...list, ""])}>＋ 加一条</button>
      </div>
    );
  }
  return <textarea className="ed" rows={String(value ?? "").length > 34 ? 3 : 1} value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />;
}
