// 图表页签的内容：图的列表，点一行换成这张图的详情（带「回到列表」）。图是任务的另一种要素，不是集合里的条目：
// 不评审、不用逐张确认、不算进完成条件，所以这里没有筛选、勾选与状态徽标。
//
// 列表取自整份任务数据里的 diagrams（图的事件 diagram_changed 会更新它）；详情打开时另取（GET …/diagrams/{编号}），
// 这张图自己有了新修订、或者任何条目有了新修订（来源上的「依据已变」与被画条目的标题可能变了）时重新取。
//
// 详情：画出来的图占满条目区中间整块（components/diagram/DiagramView.tsx，可以拖动、放大缩小、导出 PNG）；顶上一行是编号、图名、
// 种类，下面一行是修订信息与说明。别的东西放在右边一栏的两个页签里，这一栏可以收起，让图更大：
// 「文本」页签是 Mermaid 文本（可以改）、保存、放弃改动与没保存成的原因；「来源」页签是来源（与条目的来源同一个卡片，
// 依据已变与已经删除的记号相同）与「图里画了谁」（文本里写的条目编号，可点；已经删除的、任务里没有的标灰并说明）。
// 条目区窄于 40rem 时右边一栏排到图的下面。
//
// 改图：文本框可以直接改，停一下图就按改后的文本重画，图的上方写「预览：改动还没有保存」；点「保存」才成为这张图的一次新修订
// （界面操作 edit_diagram，任务服务先校验写法，不对就不保存并把原话写在文本框下面）。有没保存的改动时「导出 PNG」灰掉，
// 对话区的发送键也灰掉（onDirty），与条目有没保存的编辑时相同；「文本」页签上带一个圆点。草稿不随切换页签、收起右栏而丢。
// 助手工作中、任务结束后文本框只读。这一版页面只能改 Mermaid 文本；图名、说明、种类与删除让助手去做。

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { DiagramDetail as Detail, DiagramRow, Task } from "../../api/types";
import { DiagramView } from "../diagram/DiagramView";
import {
  DIAGRAMS_EMPTY_TEXT, DIAGRAM_DELETED_TEXT, EXPORT_NEEDS_SAVE_TEXT, NOTHING_DRAWN_TEXT, PREVIEW_TEXT, drawnNote, revisionLine, revisionText, saveFailedText,
} from "../../model/diagrams";
import { writeOffReason } from "../../model/items";
import { SourceBox, type SubmitAction } from "./ItemDetail";
import { errorText } from "./errors";

/** 详情右边一栏的两个页签。 */
export type DiagramSideTab = "text" | "sources";

/** 停止打字多久之后图按改后的文本重画（毫秒）。测试里改小。 */
export const diagramPreview = { delayMs: 400 };

export function DiagramsPane({ task, selected, onSelect, readOnly, writesOff, latestRevision, submit, onLocate, onOpenItem, onDirty }: {
  task: Task;
  /** 打开着哪一张图；null 是列表。 */
  selected: string | null;
  onSelect: (diagramId: string | null) => void;
  readOnly: boolean;
  writesOff: boolean;
  /** 任务现在的修订号：条目有了新修订时详情重新取。 */
  latestRevision: number;
  submit: SubmitAction;
  onLocate?: (excerpt: string, locator: string) => void;
  onOpenItem?: (itemId: string) => void;
  /** 有没有没保存的改图。 */
  onDirty?: (dirty: boolean) => void;
}) {
  const rows = task.diagrams ?? [];
  // 右边一栏开着没有、停在哪个页签：记在这里，换一张图看时不变。
  const [sideOpen, setSideOpen] = useState(true);
  const [sideTab, setSideTab] = useState<DiagramSideTab>("text");
  if (selected) {
    return (
      <DiagramDetail key={selected} task={task} diagramId={selected} row={rows.find((one) => one.diagram_id === selected) ?? null} readOnly={readOnly} writesOff={writesOff}
        latestRevision={latestRevision} submit={submit} onBack={() => onSelect(null)} onLocate={onLocate} onOpenItem={onOpenItem} onDirty={onDirty}
        sideOpen={sideOpen} onSideOpen={setSideOpen} sideTab={sideTab} onSideTab={setSideTab} />
    );
  }
  if (rows.length === 0) return <div className="empty" data-testid="diagrams-empty">{DIAGRAMS_EMPTY_TEXT}</div>;
  return (
    <div className="list" data-testid="diagram-list">
      {rows.map((row) => (
        <div key={row.diagram_id} className="lrow" onClick={() => onSelect(row.diagram_id)} data-testid={`diagram-${row.diagram_id}`}>
          <span className="lid">{row.diagram_id}</span>
          <span className="lname" title={row.name}>{row.name}</span>
          <span className="chip">{row.kind_name}</span>
          <span className="dg-rev">{revisionText(row)}</span>
        </div>
      ))}
    </div>
  );
}

function DiagramDetail({ task, diagramId, row, readOnly, writesOff, latestRevision, submit, onBack, onLocate, onOpenItem, onDirty, sideOpen, onSideOpen, sideTab, onSideTab }: {
  task: Task; diagramId: string; row: DiagramRow | null; readOnly: boolean; writesOff: boolean; latestRevision: number; submit: SubmitAction;
  onBack: () => void; onLocate?: (excerpt: string, locator: string) => void; onOpenItem?: (itemId: string) => void; onDirty?: (dirty: boolean) => void;
  sideOpen: boolean; onSideOpen: (open: boolean) => void; sideTab: DiagramSideTab; onSideTab: (tab: DiagramSideTab) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 用户改着的文本；null 是没有在改（文本框里显示库里的文本）。 */
  const [draft, setDraft] = useState<string | null>(null);
  /** 右边画的文本：没有在改时是库里的，在改时是停了一下之后的草稿。 */
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 取详情：打开时、这张图有了新修订或者从清单里没了（被删）时、条目有了新修订时。后发出的一次先回来时，先发出的结果不用。
  const wanted = `${row ? row.revision_no : "gone"}:${latestRevision}`;
  useEffect(() => {
    let stale = false;
    api.diagram(task.task_id, diagramId).then(
      (got) => { if (!stale) { setDetail(got); setLoadError(null); } },
      (error: unknown) => { if (!stale) setLoadError(error instanceof ApiError ? errorText(error) : String(error)); },
    );
    return () => { stale = true; };
  }, [task.task_id, diagramId, wanted]);

  const dirty = detail !== null && draft !== null && draft !== detail.mermaid;
  // 保存成了、新内容取回来了：草稿与库里的一样，收起草稿。
  useEffect(() => {
    if (detail && draft !== null && draft === detail.mermaid) { setDraft(null); setSaving(false); setSaveError(null); }
  }, [detail, draft]);
  // 改着的时候停一下再重画；没有在改时直接画库里的。
  useEffect(() => {
    if (draft === null) { setPreview(null); return; }
    const timer = setTimeout(() => setPreview(draft), diagramPreview.delayMs);
    return () => clearTimeout(timer);
  }, [draft]);
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current !== dirty) { reported.current = dirty; onDirty?.(dirty); }
  }, [dirty]);
  useEffect(() => () => { if (reported.current) onDirty?.(false); }, []);

  if (!detail) {
    return (
      <div className="detail" data-testid="diagram-detail">
        <span className="crumb" role="button" onClick={onBack}>‹ 回到列表</span>
        <div className="empty" data-testid={loadError ? "diagram-load-error" : "diagram-loading"}>{loadError ? `读不到这张图：${loadError}` : "正在读这张图。"}</div>
      </div>
    );
  }
  if (detail.deleted) {
    return (
      <div className="detail" data-testid="diagram-detail">
        <span className="crumb" role="button" onClick={onBack}>‹ 回到列表</span>
        <div className="empty" data-testid="diagram-deleted">{DIAGRAM_DELETED_TEXT}</div>
      </div>
    );
  }

  const off = writeOffReason(task, { readOnly, writesOff });
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    const error = await submit({ kind: "edit_diagram", targets: [{ diagram_id: diagramId, base_revision: detail.revision_no }], fields: { mermaid: draft! }, notify_executor: false },
      `修改图 ${diagramId}`);
    if (error) { setSaving(false); setSaveError(saveFailedText(diagramId, error)); }
  };
  const discard = () => { setDraft(null); setSaveError(null); setSaving(false); };
  const titleOf = (itemId: string) => task.items.find((one) => one.item_id === itemId)?.title ?? "";

  return (
    <div className="detail dg-detail" data-testid="diagram-detail">
      <span className="crumb" role="button" onClick={onBack}>‹ 回到列表</span>
      <div className="dh">
        <span className="id">{detail.diagram_id}</span>
        <b className="title" role="heading" aria-level={3}>{detail.name}</b>
        <span className="chip">{detail.kind_name}</span>
        <span className="pager">
          <button type="button" className="btn sm" onClick={() => onSideOpen(!sideOpen)} data-testid="diagram-side-toggle"
            title={sideOpen ? "收起右边一栏，让图更大" : "展开右边一栏：Mermaid 文本、来源与图里画了谁"}>{sideOpen ? "收起文本与来源 ›" : "‹ 文本与来源"}</button>
        </span>
      </div>
      <div className="dh-sub dg-sub">
        <span data-testid="diagram-sub">{revisionLine(detail)} · 来源 {detail.sources.length} 条{saving && " · 正在保存…"}</span>
        {detail.note && <span className="dg-note" title={detail.note} data-testid="diagram-note-text"> · 说明：{detail.note}</span>}
      </div>

      <div className={`dg-body${sideOpen ? "" : " side-closed"}`}>
        <div className="dg-figure">
          {dirty && <div className="dg-preview" data-testid="diagram-preview-note">{PREVIEW_TEXT}</div>}
          <DiagramView text={preview ?? detail.mermaid} fileName={`${detail.diagram_id} ${detail.name}`} exportOff={dirty ? EXPORT_NEEDS_SAVE_TEXT : null} />
        </div>
        {sideOpen && (
          <div className="dg-side" data-testid="diagram-side">
            <div className="sw-stabs dg-tabs" role="tablist">
              <span className={`sw-stab${sideTab === "text" ? " on" : ""}`} role="tab" onClick={() => onSideTab("text")} data-testid="diagram-tab-text"
                title={dirty ? PREVIEW_TEXT : undefined}>文本{dirty && <span className="dg-dot" data-testid="diagram-dirty-dot">●</span>}</span>
              <span className={`sw-stab${sideTab === "sources" ? " on" : ""}`} role="tab" onClick={() => onSideTab("sources")} data-testid="diagram-tab-sources">
                来源<span className="cnt">{detail.sources.length}</span>
              </span>
            </div>
            {sideTab === "text" ? (
              <div className="dg-side-body dg-text">
                <textarea className="ed dg-mermaid" value={draft ?? detail.mermaid} readOnly={!!off || saving} title={off} spellCheck={false}
                  onChange={(e) => { setDraft(e.target.value); setSaveError(null); }} data-testid="diagram-text" />
                <div className="dg-actions">
                  <button type="button" className="btn sm pri" disabled={!dirty || saving || !!off} title={off} onClick={() => void save()} data-testid="diagram-save">保存</button>
                  <button type="button" className="btn sm" disabled={draft === null || saving} onClick={discard} data-testid="diagram-discard">放弃改动</button>
                  <span className="dg-hint">{off ?? "保存之后是这张图的一次新修订。"}</span>
                </div>
                {saveError && <div className="dg-err" role="alert" data-testid="diagram-save-error">{saveError}</div>}
              </div>
            ) : (
              <div className="dg-side-body" data-testid="diagram-sources">
                {detail.sources.length === 0 && <div className="dg-none">这张图没有来源。</div>}
                {detail.sources.map((source, i) => <SourceBox key={i} source={source} onLocate={onLocate} onOpenItem={onOpenItem} titleOf={titleOf} whole="图" />)}
                <div className="sec-h">图里画了谁</div>
                <div className="dg-drawn" data-testid="diagram-drawn">
                  {detail.drawn.length === 0 ? NOTHING_DRAWN_TEXT : detail.drawn.map((one, i) => {
                    const note = drawnNote(one);
                    return (
                      <span key={one.item_id} data-testid={`drawn-${one.item_id}`}>
                        {i > 0 && "、"}
                        {note === null
                          ? <><span className="ref" role="button" onClick={() => onOpenItem?.(one.item_id)}>{one.item_id}</span>{one.title ? ` ${one.title}` : ""}</>
                          : <span className="gone">{one.item_id}{one.title ? ` ${one.title}` : ""}（{note}）</span>}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
