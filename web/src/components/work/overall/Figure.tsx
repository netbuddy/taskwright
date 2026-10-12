// 业务说明里的一张图：画在它说明的那一节里（「流程步骤」「状态图」「与其他对象的关系」「其他图」）、章首页上，或者「未归入节的图」里。
// 从上到下：图名与种类一行（右边是「另有 N 张」与「文本与来源」）；画出来的图（可以拖动，按住 Ctrl 滚轮放大缩小，导出 PNG）；
// 图下面一行「画自」（把它写成来源的各节，可点）与「被依据」（依据这张图写的条目，可点）。
// 同一处有几张图时显示最近修订的那一张，「另有 N 张」展开其余的名字，点一张换成它。
// 「文本与来源」在图下面展开两个页签：「文本」是 Mermaid 文本（可以改）、保存、放弃改动与没保存成的原因；
// 「来源」是每条来源（与条目的来源同一个卡片）与「图里画了谁」。改图的规矩不变：停一下图就按改后的文本重画，图的上方写
// 「预览：改动还没有保存」；点「保存」才成为这张图的一次新修订；有没保存的改动时「导出 PNG」灰掉，对话区的发送键也灰掉（onDirty）。
// 看图记录：图画出来、而且滚进了看得见的范围，就告诉上面一层（onViewed），由它在这张图现在的修订上记一条「看过」。
// 浏览器没有 IntersectionObserver 时画出来就算看见。已经看过现在内容的图不再记。

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { DiagramDetail as Detail, DiagramRow, Item, Task } from "../../../api/types";
import { DiagramView } from "../../diagram/DiagramView";
import { type Toc, sectionLabel } from "../../../model/chapters";
import {
  DIAGRAM_DELETED_TEXT, EXPORT_NEEDS_SAVE_TEXT, NOTHING_DRAWN_TEXT, PREVIEW_TEXT, diagramPreview, drawnNote, otherSourcesText, revisionLine, revisionText, saveFailedText,
} from "../../../model/diagrams";
import { SOURCE_ITEM, sourceKindNow, writeOffReason } from "../../../model/items";
import { type FigureSlot, classNamesOf, looseDiagrams, markClasses, sectionFigures, sourcePages } from "../../../model/sectionDiagrams";
import { SourceBox, type SubmitAction } from "../ItemDetail";
import { errorText } from "../errors";

/** 画图与改图要的那几样，条目区一次交齐。 */
export interface FigureHost {
  task: Task;
  contents: Toc;
  readOnly: boolean;
  writesOff: boolean;
  /** 任务现在的修订号：条目有了新修订时图的详情重新取。 */
  latestRevision: number;
  submit: SubmitAction;
  /** 打开业务说明的一节。 */
  onOpen: (itemId: string) => void;
  /** 打开一个条目（在它自己的页签里）。 */
  onOpenItem?: (itemId: string) => void;
  onLocate?: (excerpt: string, locator: string) => void;
  /** 用户看到了这张图现在的内容。 */
  onViewed?: (row: DiagramRow) => void;
  /** 这张图有没有没保存的改动。 */
  onDirty?: (diagramId: string, dirty: boolean) => void;
  /** 要看的那张图（从地址、条目的依据点过来的）：它在哪一处，那一处就显示它并滚到它；seq 每次加一。 */
  focus?: { diagramId: string; seq: number } | null;
}

/** 一处的图：rows 是放在这一处的各张（最近修订的在前），显示第一张，其余收在「另有 N 张」里。 */
export function Figure({ host, rows, decorate }: {
  host: FigureHost;
  rows: DiagramRow[];
  /** 画之前在文本后面添几行（例如标出本节的那个对象）；只影响画出来的样子，不改库里的文本。 */
  decorate?: (mermaid: string) => string;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const focus = host.focus ?? null;
  const wanted = focus && rows.some((one) => one.diagram_id === focus.diagramId) ? focus : null;
  useEffect(() => {
    if (!wanted) return;
    setPicked(wanted.diagramId);
    root.current?.scrollIntoView?.({ block: "center" });
  }, [wanted?.seq]);
  const row = rows.find((one) => one.diagram_id === picked) ?? rows[0];
  if (!row) return null;
  const others = rows.filter((one) => one.diagram_id !== row.diagram_id);
  return (
    <div className="oa-fig" ref={root} data-testid={`figure-${row.diagram_id}`}>
      <FigureBody key={row.diagram_id} host={host} row={row} decorate={decorate}
        more={others.length > 0 && (
          <button type="button" className="linkbtn" onClick={() => setMoreOpen(!moreOpen)} data-testid="figure-more">{moreOpen ? "收起" : `另有 ${others.length} 张`}</button>
        )} />
      {moreOpen && others.length > 0 && (
        <ul className="oa-fig-more" data-testid="figure-others">
          {others.map((one) => (
            <li key={one.diagram_id} role="button" title={one.diagram_id} onClick={() => { setPicked(one.diagram_id); setMoreOpen(false); }} data-testid={`figure-pick-${one.diagram_id}`}>
              <span className="n">{one.name}</span><span className="chip">{one.kind_name}</span><span className="r">{revisionText(one)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type SideTab = "text" | "sources";

function FigureBody({ host, row, decorate, more }: { host: FigureHost; row: DiagramRow; decorate?: (mermaid: string) => string; more: React.ReactNode }) {
  const { task, contents, readOnly, writesOff, latestRevision, submit, onOpen, onOpenItem, onLocate, onViewed, onDirty } = host;
  const diagramId = row.diagram_id;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 用户改着的文本；null 是没有在改（文本框里显示库里的文本）。 */
  const [draft, setDraft] = useState<string | null>(null);
  /** 画的文本：没有在改时是库里的，在改时是停了一下之后的草稿。 */
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [side, setSide] = useState<SideTab | null>(null);

  // 取详情：打开时、这张图有了新修订时、条目有了新修订时。后发出的一次先回来时，先发出的结果不用。
  const wanted = `${row.revision_no}:${latestRevision}`;
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
    if (reported.current !== dirty) { reported.current = dirty; onDirty?.(diagramId, dirty); }
  }, [dirty]);
  useEffect(() => () => { if (reported.current) onDirty?.(diagramId, false); }, []);

  // 看图记录：画出来了、看得见，而且用户还没有看过它现在的内容，就记一次。同一次修订只告诉上面一层一回。
  const box = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !box.current) return;
    const watcher = new IntersectionObserver((entries) => setVisible(entries[entries.length - 1].isIntersecting));
    watcher.observe(box.current);
    return () => watcher.disconnect();
  }, []);
  const told = useRef<number | null>(null);
  useEffect(() => {
    if (!drawn || !visible || dirty || row.viewed === true || told.current === row.revision_no) return;
    told.current = row.revision_no;
    onViewed?.(row);
  }, [drawn, visible, dirty, row.viewed, row.revision_no]);

  const head = (
    <div className="oa-fig-h">
      <b className="name" title={`${row.diagram_id} · ${revisionText(row)}`} data-testid="figure-name">{row.name}</b>
      <span className="chip">{row.kind_name}</span>
      <span className="acts">
        {more}
        {detail && !detail.deleted && (
          <button type="button" className="linkbtn" onClick={() => setSide(side ? null : "text")} data-testid="figure-side-toggle"
            title={side ? "收起 Mermaid 文本与来源" : "看这张图的 Mermaid 文本（可以改）、每条来源与图里画了谁"}>
            {side ? "收起文本与来源" : "文本与来源"}{dirty && <span className="dg-dot" data-testid="diagram-dirty-dot">●</span>}
          </button>
        )}
      </span>
    </div>
  );
  if (!detail) {
    return <div ref={box}>{head}<div className="empty" data-testid={loadError ? "diagram-load-error" : "diagram-loading"}>{loadError ? `读不到这张图：${loadError}` : "正在读这张图。"}</div></div>;
  }
  if (detail.deleted) return <div ref={box}>{head}<div className="empty" data-testid="diagram-deleted">{DIAGRAM_DELETED_TEXT}</div></div>;

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
  const shownText = preview ?? detail.mermaid;
  const pages = sourcePages(task, contents, diagramId);
  const otherSources = detail.sources.filter((source) => !(sourceKindNow(String(source.kind)) === SOURCE_ITEM && pages.some((page) => page.item_id === source.locator))).length;
  const basedOn = detail.depended_by.filter((one) => one.element_kind === SOURCE_ITEM).map((one) => task.items.find((item) => item.item_id === one.id)).filter((one) => one !== undefined);

  return (
    <div ref={box}>
      {head}
      {detail.note && <div className="oa-fig-note" data-testid="diagram-note-text">{detail.note}</div>}
      <div className="dg-figure oa-fig-stage">
        {dirty && <div className="dg-preview" data-testid="diagram-preview-note">{PREVIEW_TEXT}</div>}
        <DiagramView text={decorate && !dirty ? decorate(shownText) : shownText} fileName={`${detail.diagram_id} ${detail.name}`} exportOff={dirty ? EXPORT_NEEDS_SAVE_TEXT : null}
          wheel="ctrl" fit="whole" onDrawn={() => setDrawn(true)} />
      </div>
      <div className="oa-fig-foot" data-testid="figure-foot">
        <span data-testid="figure-from">
          画自：{pages.length === 0 && otherSources === 0 && "没有写来源"}
          {pages.map((page, i) => (
            <span key={page.item_id}>{i > 0 && "、"}<span className="see" role="button" title={page.item_id} onClick={() => onOpen(page.item_id)}>{sectionLabel(contents, page)}</span></span>
          ))}
          {otherSources > 0 && <>{pages.length > 0 && "；"}<span className="see" role="button" onClick={() => setSide("sources")} data-testid="figure-other-sources">{otherSourcesText(otherSources)}</span></>}
        </span>
        {basedOn.length > 0 && (
          <span data-testid="figure-based">
            被依据：{basedOn.map((item, i) => (
              <span key={item.item_id}>{i > 0 && "、"}<span className="see" role="button" title={item.item_id} onClick={() => onOpenItem?.(item.item_id)}>{item.title || item.item_id}</span></span>
            ))}
          </span>
        )}
        <span className="rev" data-testid="diagram-sub">{revisionLine(detail)}{saving && " · 正在保存…"}</span>
      </div>
      {side && (
        <div className="oa-fig-side" data-testid="diagram-side">
          <div className="sw-stabs dg-tabs" role="tablist">
            <span className={`sw-stab${side === "text" ? " on" : ""}`} role="tab" onClick={() => setSide("text")} data-testid="diagram-tab-text" title={dirty ? PREVIEW_TEXT : undefined}>文本</span>
            <span className={`sw-stab${side === "sources" ? " on" : ""}`} role="tab" onClick={() => setSide("sources")} data-testid="diagram-tab-sources">
              来源<span className="cnt">{detail.sources.length}</span>
            </span>
          </div>
          {side === "text" ? (
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
  );
}

/** 一节里放图的几块的标题。 */
export const SLOT_TITLE: Record<FigureSlot, string> = { steps: "流程步骤", state: "状态图", relations: "与其他对象的关系", other: "其他图" };

/**
 * 一节里放图的几块：给哪几块就按这个先后画哪几块，没有图的块不画。「与其他对象的关系」画的是整张对象关系图，本节的对象边框加粗。
 */
export function FigureBlocks({ host, item, slots }: { host: FigureHost; item: Item; slots: readonly FigureSlot[] }) {
  const figures = sectionFigures(host.task, host.contents, item);
  return (
    <>
      {slots.filter((slot) => figures[slot].length > 0).map((slot) => (
        <section key={slot} className="oa-blk" data-testid={`topic-fig-${slot}`}>
          <h3>{SLOT_TITLE[slot]}{slot === "relations" && <small>取自第 4 章对象关系图，本节的对象边框加粗</small>}</h3>
          <Figure host={host} rows={figures[slot]}
            decorate={slot === "relations" ? (text) => markClasses(text, classNamesOf(text, host.task, item.item_id)) : undefined} />
        </section>
      ))}
    </>
  );
}

/** 「未归入节的图」：哪一节都放不进的图（没有写业务说明的节作来源），一张一张画出来。 */
export function LooseFigures({ host }: { host: FigureHost }) {
  const rows = looseDiagrams(host.task, host.contents);
  return (
    <div className="oa-page" data-testid="loose-figures">
      <div className="oa-title" role="heading" aria-level={2}>{LOOSE_NAME}</div>
      <div className="oa-meta"><span>这几张图没有写它画的是业务说明的哪一节，所以放不进节里。让助手给图补上来源之后，它会出现在相应的节里。</span></div>
      {rows.length === 0 && <p className="oa-empty">现在没有这样的图。</p>}
      {rows.map((row) => <section key={row.diagram_id} className="oa-blk"><Figure host={host} rows={[row]} /></section>)}
    </div>
  );
}

/** 目录末尾那一行的名字。 */
export const LOOSE_NAME = "未归入节的图";
