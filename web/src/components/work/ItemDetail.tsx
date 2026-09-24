// 条目详情：照设计原型画成一张表——左列字段名（必填带星），右列带边框的值格；列表型字段每步一行、行首是序号；
// 每个值格下方是支持这个字段的来源小标签（材料文件名、执行者补充、用户的话、用户直接修改四种各有配色），
// 点材料标签，文档区滚到并高亮那句原文。顶部一行：编号、标题、评审与确认状态、版本选择、上一条与下一条；
// 有执行者补充时顶部一条琥珀色横幅；底部「来源」一节按种类列小标签加摘录；右下角固定「确认这一版」。
// 看某一版时，与它的上一版不同的地方画线（改前划掉、改后加底线），所以「刚改过」的条目点开就是版本比对。
//
// 直接操作全部走 actions；响应只当作接受或拒绝，界面上的变化等库事件到了才发生。
// 拒绝时原因就地显示；stale_version 时保留用户刚填的内容让他对照重做（第 6 节规则 2）。

import { useEffect, useState, type ReactNode } from "react";
import { Popconfirm, Select } from "antd";
import { api, ApiError } from "../../api/client";
import type { ActionRequest, CollectionDef, FieldDef, FieldValue, Fields, Item, ItemVersion, Source, Task } from "../../api/types";
import { alignSteps } from "../../model/diff";
import { confirmState, isEmptyValue, isListField, keepPendingField, KEEP_PENDING_VALUE, reviewState, sourcesFor } from "../../model/items";
import { formatTime } from "../../model/format";
import { errorText } from "./errors";
import { StaleDiff } from "./StaleDiff";
import { ItemStatus } from "./ItemStatus";

export type SubmitAction = (req: Pick<ActionRequest, "kind" | "targets" | "fields" | "notify_executor">, label: string) => Promise<ApiError | null>;

export function ItemDetail({ task, item, def, readOnly, pending, submit, justVersion, onBack, onPrev, onNext, onLocate, onOpenItem, onAskAssistant }: {
  task: Task;
  item: Item;
  def: CollectionDef;
  readOnly: boolean;
  pending: boolean;
  submit: SubmitAction;
  /** 最近一次工作把它改成了第几版（「第 N 版 · 刚改」）。 */
  justVersion?: number;
  onBack?: () => void;
  onPrev?: (() => void) | null;
  onNext?: (() => void) | null;
  onLocate?: (excerpt: string, locator: string) => void;
  onOpenItem?: (itemId: string) => void;
  /** 「让助手来改这一条」：预填对话区输入框。 */
  onAskAssistant?: (itemId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Fields>(item.fields);
  const [error, setError] = useState<ApiError | null>(null);
  const [versions, setVersions] = useState<ItemVersion[] | null>(null);
  const [viewVersion, setViewVersion] = useState<number | null>(null);

  useEffect(() => { if (!editing) setDraft(item.fields); }, [item.fields, editing]);
  useEffect(() => { setViewVersion(null); }, [item.item_id]);
  useEffect(() => {
    let live = true;
    if (item.version_count > 1 || item.version_no > 1) {
      api.itemVersions(task.task_id, item.item_id).then((v) => { if (live) setVersions(v); }).catch(() => { if (live) setVersions([]); });
    } else setVersions(null);
    return () => { live = false; };
  }, [task.task_id, item.item_id, item.version_no, item.version_count]);

  const run = async (req: Parameters<SubmitAction>[0], label: string, after?: () => void) => {
    setError(null);
    const e = await submit(req, label);
    if (e) setError(e);
    else after?.();
  };
  const target = [{ item_id: item.item_id, base_version: item.version_no }];
  const review = reviewState(item);
  const confirm = confirmState(item);
  const keepField = keepPendingField(task, item.collection);
  const shownNo = viewVersion ?? item.version_no;
  const shown = viewVersion != null ? versions?.find((v) => v.version_no === viewVersion) ?? null : null;
  const fields = shown?.fields ?? item.fields;
  const sources = shown?.sources ?? item.sources;
  const previous = versions?.find((v) => v.version_no === shownNo - 1)?.fields ?? null;
  const old = viewVersion != null && viewVersion !== item.version_no;
  const latestByUser = !old && item.version_by === "user" && item.version_no > 1;
  const supplements = sources.filter((s) => s.kind === "执行者补充");
  const findings = review.state === "failed" ? item.reviews.filter((r) => r.version_no === undefined || r.version_no === item.version_no).pop()?.findings ?? [] : [];
  const userRevision = versions?.find((v) => v.version_no === item.version_no)?.revision_no;

  const save = () => {
    const changed: Fields = {};
    for (const f of def.fields) {
      if (JSON.stringify(draft[f.name] ?? null) !== JSON.stringify(item.fields[f.name] ?? null)) changed[f.name] = normalize(f, draft[f.name]);
    }
    if (!Object.keys(changed).length) { setEditing(false); return; }
    void run({ kind: "edit_fields", targets: target, fields: changed, notify_executor: false },
      `修改 ${item.item_id} 的${Object.keys(changed).join("、")}`, () => setEditing(false));
  };
  const doConfirm = () => run({ kind: "confirm", targets: target, notify_executor: false }, `确认 ${item.item_id} 第 ${item.version_no} 版`);
  const confirmBtn = (
    <button type="button" className="btn pri" disabled={readOnly || pending} data-testid="detail-confirm"
      onClick={review.state === "failed" ? undefined : () => void doConfirm()}>确认这一版</button>
  );

  return (
    <div className="detail" data-testid="item-detail">
      {onBack && <span className="crumb" role="button" onClick={onBack}>‹ 回到列表</span>}
      <div className="dh">
        <span className="id">{item.item_id}</span>
        <b className="title" role="heading" aria-level={3}>{item.title}</b>
        <ItemStatus task={task} item={item} justVersion={justVersion} pending={pending} />
        <span className="pager">
          {!keepField && onAskAssistant && (
            <button type="button" className="aibtn" disabled={readOnly} onClick={() => onAskAssistant(item.item_id)} data-testid="ask-assistant">让助手来改这一条</button>
          )}
          {versions && versions.length > 1 ? (
            <select className="vsel" value={shownNo} onChange={(e) => setViewVersion(Number(e.target.value) === item.version_no ? null : Number(e.target.value))} data-testid="version-select">
              {[...versions].reverse().map((v) => (
                <option key={v.version_no} value={v.version_no}>第 {v.version_no} 版 · {v.by === "user" ? "由你修改" : "由助手写的"} · {formatTime(v.at)}</option>
              ))}
            </select>
          ) : (
            <select className="vsel" value={item.version_no} disabled>
              <option value={item.version_no}>第 {item.version_no} 版 · {item.version_by === "user" ? "由你修改" : "由助手写的"} · {formatTime(item.version_at)}</option>
            </select>
          )}
          {onPrev !== undefined && <button type="button" className="btn sm" style={onPrev ? undefined : { opacity: .4 }} onClick={() => onPrev?.()}>‹ 上一条</button>}
          {onNext !== undefined && <button type="button" className="btn sm" style={onNext ? undefined : { opacity: .4 }} onClick={() => onNext?.()}>下一条 ›</button>}
        </span>
      </div>

      {error && (
        <div className="err" data-testid="action-error">
          <span className="x" role="button" onClick={() => setError(null)}>×</span>
          {errorText(error)}
          {staleDetail(error)}
        </div>
      )}

      {old && (
        <div className="banner-line diff">你在看第 {viewVersion} 版（旧版），画了线的地方是这一版和第 {shownNo - 1} 版的差别。
          <button type="button" className="btn sm" onClick={() => setViewVersion(null)}>回到最新版</button></div>
      )}
      {!old && previous && !latestByUser && (
        <div className="banner-line diff" data-testid="compare-banner">
          这是第 {item.version_no} 版{justVersion === item.version_no ? "，是助手最近一次工作刚改的" : ""}；画了线的地方是和第 {item.version_no - 1} 版的差别：划掉的是原来的写法，加底线的是现在的写法。
        </div>
      )}
      {latestByUser && (
        <div className="banner-line ok">第 {item.version_no} 版 · 由你修改 · {formatTime(item.version_at)}
          {!readOnly && userRevision != null && (
            <button type="button" className="btn sm" onClick={() => void run({ kind: "undo", targets: [{ revision_no: userRevision }], notify_executor: false }, `撤销第 ${userRevision} 次修订`)}>撤销这次修订</button>
          )}
        </div>
      )}
      {review.state === "failed" && (
        <div className="banner-line gap"><b>评审不通过</b>：评审者按写作规矩核对，指出 {findings.length} 处问题（标在下面对应的字段旁）。改完再评一次就行。</div>
      )}
      {confirm === "stale" && !editing && !old && (
        <StaleDiff taskId={task.task_id} item={item} def={def} disabled={readOnly || pending}
          onReconfirm={() => void run({ kind: "confirm", targets: target, notify_executor: false }, `重新确认 ${item.item_id} 第 ${item.version_no} 版`)} />
      )}
      {supplements.length > 0 && !editing && (
        <div className="banner-line amber" data-testid="supplement-banner">
          <span><b>执行者补充：</b>{supplements.map((s) => s.excerpt).join("；")}　这部分材料里没有，请你确认。</span>
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
            <button type="button" className="btn sm pri" onClick={save} disabled={pending} data-testid="save-fields">保存为第 {item.version_no + 1} 版</button>
            <button type="button" className="btn sm" onClick={() => { setEditing(false); setError(null); }}>取消</button>
            <span style={{ fontSize: ".7rem", color: "var(--mut)", alignSelf: "center" }}>保存后立刻生效，会产生这个条目的新一版</span>
          </div>
        </div>
      ) : (
        <>
          <div className="fld"><div className="k">编号</div><div className="v">{item.item_id}<span className="tagflag">编号由系统给，不可改</span></div></div>
          {def.fields.map((f) => {
            const value = fields[f.name];
            if (f.type === "文本" && value === item.title && !old) return null; // 标题已在顶部那一行
            return (
              <FieldRow key={f.name} def={f} value={value ?? null} before={previous ? previous[f.name] ?? null : undefined}
                sources={sourcesForFields(sources, f.name)} findings={findings.filter((x) => x.field === f.name).map((x) => x.problem)}
                onLocate={onLocate} onOpenItem={onOpenItem} />
            );
          })}

          <div className="sec-h">来源</div>
          {sources.map((s, i) => <SourceBox key={i} source={s} onLocate={onLocate} />)}
          {sources.length === 0 && <div className="srcbox"><div className="fields">这一版没有记下任何来源。</div></div>}

          {item.reviews.length > 0 && (
            <>
              <div className="sec-h">评审记录</div>
              <div className="confirms">
                {item.reviews.map((r, i) => (
                  <div key={i}>第 {r.version_no ?? item.version_no} 版：{r.verdict}{(r.findings ?? []).map((f, j) => <div key={j}>· {f.field}{f.index != null ? `第 ${f.index + 1} 条` : ""}：{f.problem}</div>)}</div>
                ))}
              </div>
            </>
          )}
          {item.confirmations.length > 0 && (
            <>
              <div className="sec-h">确认记录</div>
              <div className="confirms" data-testid="confirmations">
                {item.confirmations.map((c, i) => (
                  <div key={i}>第 {c.version_no} 版：{c.accepted ? "接受" : "没有接受"} · {c.basis === "user_words" ? "依据是你在对话里说的话，由确认判读者判定" : "你在界面上点的确认"} · {formatTime(c.at)}</div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {!editing && (
        <div className="dfoot sticky">
          <button type="button" className="btn" disabled={readOnly || pending || old} onClick={() => { setDraft(item.fields); setEditing(true); }}>修改</button>
          {keepField && item.fields[keepField.name] !== KEEP_PENDING_VALUE && (
            <button type="button" className="btn" disabled={readOnly || pending}
              onClick={() => void run({ kind: "keep_pending", targets: target, notify_executor: false }, `把 ${item.item_id} 标为先不管`)}>先不管，保留</button>
          )}
          <Popconfirm title={`删除 ${item.item_id}？删除之后可以在对话区撤销这次修订。`} okText="删除" cancelText="取消"
            onConfirm={() => void run({ kind: "delete_item", targets: target, notify_executor: false }, `删除 ${item.item_id}`)}>
            <button type="button" className="btn" disabled={readOnly || pending}>删除</button>
          </Popconfirm>
          <span className="aihint">{keepField ? "" : "要让助手动手改，用右上角的「让助手来改这一条」。"}</span>
          {old ? <span className="chip" style={{ marginLeft: "auto" }}>先回到最新版才能确认</span>
            : confirm === "confirmed" ? (
              <button type="button" className="btn" style={{ marginLeft: "auto" }} disabled={readOnly || pending}
                onClick={() => void run({ kind: "unconfirm", targets: target, notify_executor: false }, `撤回对 ${item.item_id} 的确认`)}>你已确认 · 撤回</button>
            ) : review.state === "failed" ? (
              <Popconfirm title="这个条目的评审没有通过，你仍然可以确认。" okText="仍然确认" cancelText="再看看" onConfirm={() => void doConfirm()}>
                <span style={{ marginLeft: "auto" }}>{confirmBtn}</span>
              </Popconfirm>
            ) : <span style={{ marginLeft: "auto" }}>{confirmBtn}</span>}
        </div>
      )}
    </div>
  );
}

/** 支持某个字段的来源：指明了支持这个字段的那几条（整个条目的来源只在底部「来源」一节列）。 */
function sourcesForFields(sources: Source[], field: string): Source[] {
  return sourcesFor({ sources } as Item, field);
}

const fileName = (locator: string) => locator.split("/").pop() || locator;

/** 值格下方的一个来源小标签。 */
export function SourceTag({ source, onLocate }: { source: Source; onLocate?: (excerpt: string, locator: string) => void }) {
  if (source.kind === "文档原文") {
    return <span className="srctag quote" title={`材料原文：${source.excerpt}（点一下，文档区滚到这句）`} role="button"
      onClick={() => onLocate?.(source.excerpt, source.locator)}>❝ {fileName(source.locator)}</span>;
  }
  if (source.kind === "执行者补充") return <span className="srctag added" title={source.excerpt}>执行者补充</span>;
  if (source.kind === "用户的话") return <span className="srctag said" title={source.excerpt}>用户的话</span>;
  if (source.kind === "用户直接修改") return <span className="srctag edited" title={source.excerpt}>用户直接修改</span>;
  return <span className="srctag edited" title={source.excerpt}>{source.kind}</span>;
}

function FieldRow({ def, value, before, sources, findings, onLocate, onOpenItem }: {
  def: FieldDef;
  value: FieldValue;
  /** 上一版的值；undefined 表示没有上一版可比。 */
  before: FieldValue | undefined;
  sources: Source[];
  findings: string[];
  onLocate?: (excerpt: string, locator: string) => void;
  onOpenItem?: (itemId: string) => void;
}) {
  const changed = before !== undefined && JSON.stringify(before ?? null) !== JSON.stringify(value ?? null);
  let body: ReactNode;
  if (isEmptyValue(value)) {
    body = <>
      {changed && !isEmptyValue(before) && <span className="diff-old">{Array.isArray(before) ? before.join("；") : String(before)}</span>}
      <span className={`tagflag${def.required ? " req" : ""}`}>{def.required ? "必填 · 未填" : "没有内容"}</span>
    </>;
  } else if (def.type === "条目引用") {
    body = <span className="refs">{(Array.isArray(value) ? value : [value]).map((id) => <span key={String(id)} className="ref" role="button" onClick={() => onOpenItem?.(String(id))}>{id}</span>)}</span>;
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
            {r.kind === "added" && <><span className="diff-new">{r.text}</span><span className="diff-note">（这一版新加的）</span></>}
            {r.kind === "removed" && <><span className="diff-old">{r.before}</span><span className="diff-note">（这一版删掉了）</span></>}
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
    <div className="fld" data-f={def.name}>
      <div className="k">{def.name}{def.required && <> <span style={{ color: "var(--gap)" }}>*</span></>}</div>
      <div className="v">
        {body}
        {findings.map((p, i) => <span key={i} className="finding" title={p}>评审：{p.split("：")[0]}</span>)}
        {sources.length > 0 && <div className="srcs">{sources.map((s, i) => <SourceTag key={i} source={s} onLocate={onLocate} />)}</div>}
      </div>
    </div>
  );
}

function SourceBox({ source, onLocate }: { source: Source; onLocate?: (excerpt: string, locator: string) => void }) {
  const kinds: Record<string, [string, string]> = {
    文档原文: ["src", "材料原文"], 执行者补充: ["warn", "执行者补充"], 用户的话: ["teal", "用户的话"], 用户直接修改: ["on", "用户直接修改"],
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
      </div>
      <div className={`quote${source.kind === "用户的话" ? " said" : ""}`}>{source.kind === "文档原文" || source.kind === "用户的话" ? `「${source.excerpt}」` : source.excerpt}</div>
      <div className="fields">
        {supports.length
          ? <>支持这几处：<b>{supports.map((x) => (x.index != null ? `${x.field}第 ${x.index + 1} 条` : x.field)).join("、")}</b></>
          : "没有指明它支持哪个字段，算作支持整个条目"}
      </div>
    </div>
  );
}

function staleDetail(error: ApiError) {
  if (error.code !== "stale_version") return null;
  const items = (error.data.items as { item_id: string; version_no: number; by?: string }[] | undefined) ?? [];
  return (
    <div>
      {items.map((i) => <div key={i.item_id}>{i.item_id} 现在是第 {i.version_no} 版{i.by ? `，是${i.by === "user" ? "你（或另一个页面）" : "助手"}改的` : ""}。</div>)}
      <div>你刚才填的内容还留在编辑框里，看过最新内容后可以对照重做。</div>
    </div>
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
