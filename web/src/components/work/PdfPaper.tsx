// 材料区里的 PDF 材料：按原样分页显示，只画看得见的页；被条目引用的句子画浅蓝底线，点来源时滚到那一页、
// 框出来源指的那一块、把摘录逐字标出来。任务页「查看」一份 PDF 材料时也用它。
//
// 怎样画：每一页先留一张同样大小的白纸（大小取位置表，不用先读每一页）；滚到看得见的页连同上下各一页才交给 pdf.js
// 画——一张画布加一层文字层（叠在画布上的透明文字，用来选字、标字）；滚走的页把画布与文字层收掉。
// 画布与文字层由 pdf.js 直接写进页面，不归 React 管；框与提示条是 React 画的，叠在上面。
//
// 定位（点来源）：出处是「路径#p页-块」。块的选取、摘录有没有接到后面的块、有没有跨页，用与保存修订时的核对同一个函数
// （agent/src/lib/pdf_source.ts 的 placePdfExcerpt）在投影的文字上算；算出来的每一截再到这一块的文字层里去找
// （model/pdfView.ts 的 findInBlock，两边都规范化），找到了逐字标出，找不到就只框出这一块并在材料区顶部写一句。
// 高亮过两秒褪掉，框留到下一次定位。
//
// 被引用的句子：各条目「文档原文」来源里出处对得上这份材料的，同样算出落在哪里，页面画出来时画上底线，点一下打开那个条目。
// 没有读出文字的页（位置表里 no_text 为真，多半是扫描件）顶上有一条提示。

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
import type { Item } from "../../api/types";
import { parsePdfLocator, pdfBlockBox, type PdfLocationFile } from "../../../../agent/src/lib/pdf_locations";
import { type PdfUnit, placePdfExcerpt, pdfUnitsWith } from "../../../../agent/src/lib/pdf_source";
import { type OpenedPdf, loadPdfjs, openPdf } from "../../model/pdf";
import {
  MAX_SCALE, MIN_SCALE, SCALE_STEP, type LayerItem, type Mark, type PageSize, clampScale, currentPage, findInBlock, fitScale, pageLayout, pageSizes, roughTop,
  screenBox, splitByMarks, visiblePages,
} from "../../model/pdfView";
import { usePdfBytes, usePdfLocations, usePdfUnits } from "../../state/pdfStore";
import type { LocateRequest } from "./MaterialPane";

/** 文件读到了、但 pdf.js 打不开（文件坏了、设了口令）时显示的说明。错误原文不给用户看，写进浏览器的控制台。 */
export const PDF_UNRENDERABLE = "这份 PDF 在这里显示不出来，但文件已经上传好了：助手仍然能读到它的内容，条目的来源仍然有效，不需要重新上传。";
/** 没有读出文字的页顶上的提示。 */
export const NO_TEXT_PAGE = "这一页没有可读的文字（多半是扫描的图片），助手读不到这一页的内容，条目也不能引用它。";
/** 页面两边各留的空（像素）：「适应宽度」时页面比材料区窄这么多的两倍。 */
export const PAGE_MARGIN = 12;
/** 高亮多久之后褪掉（毫秒）。测试里改小。 */
export const pdfHit = { fadeMs: 2200 };

/** 定位时写在材料区顶部的几句话。 */
export const PDF_NOTES = {
  noBlock: (page: number, block: number) => `这份 PDF 里没有第 ${page} 页的第 ${block} 块。`,
  miss: (page: number) => `没有在第 ${page} 页框出的这一块里找到这段原文。`,
  crossPage: (page: number) => `这段摘录跨了页，只框出了它在第 ${page} 页开始的那一块。`,
  span: (page: number, blocks: number) => `这段摘录从第 ${page} 页框出的第一块接到了后面，一共 ${blocks} 块，都框出来了。`,
  unmatched: "已经框出来源指的那一块；摘录的字在页面上对不上，没有逐字标出。",
  nowhere: "没有在这份 PDF 里找到这段原文。",
};

/** 这份 PDF 材料被哪些条目的哪一块引用：[{ 页, 块, 摘录, 条目编号 }]（出处对得上这份材料、带「#p页-块」的「文档原文」来源）。 */
export function pdfCitations(items: Item[], path: string): { page: number; block: number; excerpt: string; itemId: string }[] {
  const out: { page: number; block: number; excerpt: string; itemId: string }[] = [];
  for (const item of items) {
    for (const s of item.sources) {
      if (s.kind !== "文档原文" || !s.excerpt?.trim()) continue;
      const loc = parsePdfLocator(s.locator);
      if (!loc || loc.page === null || loc.block === null) continue;
      if (!(loc.path === path || path.endsWith(loc.path) || loc.path.endsWith(path))) continue;
      out.push({ page: loc.page, block: loc.block, excerpt: s.excerpt, itemId: item.item_id });
    }
  }
  return out;
}

/** 一页画出来之后留着的东西。 */
interface Drawn {
  scale: number;
  viewport: PageViewport;
  /** 文字层的各个元素与它们原来的文字（标字时按原来的文字重写元素的内容）。 */
  divs: HTMLElement[];
  texts: string[];
  items: LayerItem[];
  /** 上一次标字时各元素的标法，没有变就不重写。 */
  painted: Map<number, string>;
}

/** 定位的目标：页、要框出的各块、要逐字标出的各截（投影文字上的），以及这一次是第几次定位。 */
interface Target {
  nonce: number;
  page: number;
  blocks: number[];
  ranges: { block: number; text: string }[];
  /** 高亮还在不在（两秒后褪掉，框留着）。 */
  hit: boolean;
}

export function PdfPaper({ taskId, path, items, locate, jump = null, paperRef, scrollRef, onOpenItem, onMouseUp, onCitedCount, onNote, onUnavailable, onPage }: {
  taskId: string;
  path: string;
  items: Item[];
  /** 只传出处对得上这份材料的定位请求。 */
  locate: LocateRequest | null;
  /** 跳到第 page 页的开头（目录里点一项时给）；nonce 变了才跳。 */
  jump?: { page: number; nonce: number } | null;
  paperRef?: RefObject<HTMLDivElement | null>;
  /** 滚动的那个容器（材料区的原文区）；不给时找最近的一个 .doc-b。 */
  scrollRef?: RefObject<HTMLElement | null>;
  onOpenItem?: (itemId: string) => void;
  onMouseUp?: () => void;
  /** 报告有几个条目的引用在材料里找得到（材料区顶部「被 N 个条目引用过」）。 */
  onCitedCount?: (n: number) => void;
  /** 定位时要在材料区顶部显示的提示；null 表示收起。 */
  onNote?: (text: string | null) => void;
  /** 这份文件显示不出来（读不到，或读到了打不开）时报真，恢复时报假。 */
  onUnavailable?: (unavailable: boolean) => void;
  /** 现在看的是第几页、一共几页（目录与工具条用）。 */
  onPage?: (page: number, count: number) => void;
}) {
  const bytes = usePdfBytes(taskId, path);
  const located = usePdfLocations(taskId, path);
  const projected = usePdfUnits(taskId, path);
  const locations: PdfLocationFile | null = located?.locations ?? null;
  const units: PdfUnit[] | null = projected?.units ?? null;
  const ownHost = useRef<HTMLDivElement>(null);
  const host = paperRef ?? ownHost;
  const pagesEl = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [first, setFirst] = useState<PageSize | null>(null);
  /** 用户定的比例；null 是「适应宽度」，跟着材料区的宽度走。 */
  const [chosen, setChosen] = useState<number | null>(null);
  const [room, setRoom] = useState(0);
  const [scroll, setScroll] = useState({ top: 0, view: 0 });
  /** 每画好或收掉一页加一：框与标字要等页面画出来。 */
  const [tick, setTick] = useState(0);
  const [target, setTarget] = useState<Target | null>(null);
  const drawn = useRef(new Map<number, Drawn>());
  const drawing = useRef(new Map<number, { scale: number; cancel: () => void }>());
  const centred = useRef(0);
  /** 重新量一遍滚动的位置（滚动事件里用；程序自己改了滚动位置之后也调一次，不等事件）。 */
  const remeasure = useRef<() => void>(() => {});

  const scroller = () => scrollRef?.current ?? (host.current?.closest(".doc-b") as HTMLElement | null) ?? null;
  /** 各页所在的那一层在滚动内容里的上沿（像素）：滚动位置减去它，就是看得见的那一段在各页里的上沿。 */
  const pagesOffset = (pane: HTMLElement) =>
    (pagesEl.current?.getBoundingClientRect().top ?? 0) - pane.getBoundingClientRect().top + pane.scrollTop;

  // 打开文件：原始字节到了就交给 pdf.js；换文件、卸下时关掉上一份。
  useEffect(() => {
    setDoc(null);
    setFailed(false);
    setFirst(null);
    setTarget(null);
    if (bytes?.status !== "ready" || !bytes.bytes) return;
    let live = true;
    let opened: OpenedPdf | null = null;
    openPdf(bytes.bytes).then(async (got) => {
      opened = got;
      if (!live) { got.close(); return; }
      // 位置表读不到时要靠第一页实际的大小给各页留位置。
      const page = await got.doc.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      if (!live) return;
      setFirst({ width: viewport.width, height: viewport.height });
      setDoc(got.doc);
    }).catch((error: unknown) => {
      if (!live) return;
      console.error(`PDF 文件 ${path} 显示不出来，pdf.js 的报错：`, error);
      setFailed(true);
    });
    return () => {
      live = false;
      for (const one of drawing.current.values()) one.cancel();
      drawing.current.clear();
      drawn.current.clear();
      opened?.close();
    };
  }, [bytes?.status, bytes?.bytes, path]);

  const unavailable = bytes?.status === "error" || failed;
  useEffect(() => { onUnavailable?.(unavailable); }, [unavailable]);

  const count = doc?.numPages ?? 0;
  const sizes = useMemo(() => pageSizes(locations, count, first), [locations, count, first]);
  const scale = chosen ?? fitScale(sizes, room);
  const layout = useMemo(() => pageLayout(sizes, scale), [sizes, scale]);

  // 量材料区给页面留的宽度（「适应宽度」用）与滚动的位置；宽度变了、滚动了都重算要画哪几页。
  useEffect(() => {
    const box = host.current;
    const pane = scroller();
    if (!box || !pane) return;
    const measure = () => {
      // 页面两边各留一点空。
      setRoom(Math.max(0, box.clientWidth - 2 * PAGE_MARGIN));
      setScroll({ top: pane.scrollTop - pagesOffset(pane), view: pane.clientHeight });
    };
    measure();
    remeasure.current = measure;
    pane.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(box);
    observer?.observe(pane);
    return () => { pane.removeEventListener("scroll", measure); observer?.disconnect(); remeasure.current = () => {}; };
  }, [doc]);

  const visible = useMemo(() => visiblePages(layout, scroll.top, scroll.view), [layout, scroll.top, scroll.view]);
  const now = count ? currentPage(layout, scroll.top, scroll.view) : 0;
  useEffect(() => { if (count) onPage?.(now, count); }, [now, count]);

  // 画看得见的页，收掉滚走的与比例不对的。
  useEffect(() => {
    if (!doc || !visible) return;
    const wanted = (n: number) => n >= visible.first && n <= visible.last;
    for (const [n, one] of drawn.current) {
      if (!wanted(n) || one.scale !== scale) { clearPage(n); drawn.current.delete(n); setTick((t) => t + 1); }
    }
    for (const [n, one] of drawing.current) {
      // 还在画的那一次已经把画布放进了页里：取消的同时把它收掉，不然滚走的页上留着一张没画完的画布。
      if (!wanted(n) || one.scale !== scale) { one.cancel(); clearPage(n); drawing.current.delete(n); }
    }
    for (let n = visible.first; n <= visible.last; n++) {
      if (drawn.current.has(n) || drawing.current.has(n)) continue;
      void drawPage(doc, n, scale);
    }
  }, [doc, scale, visible?.first, visible?.last]);

  const slot = (n: number) => pagesEl.current?.querySelector<HTMLElement>(`[data-pdf-page="${n}"] .pdf-drawn`) ?? null;
  function clearPage(n: number) { slot(n)?.replaceChildren(); }

  async function drawPage(file: PDFDocumentProxy, n: number, at: number) {
    let cancelled = false;
    let stop = () => { cancelled = true; };
    const mine = { scale: at, cancel: () => stop() };
    drawing.current.set(n, mine);
    try {
      const lib = await loadPdfjs();
      const page = await file.getPage(n);
      const viewport = page.getViewport({ scale: at });
      const holder = slot(n);
      if (cancelled || !holder) return;
      const canvas = document.createElement("canvas");
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const layerEl = document.createElement("div");
      layerEl.className = "textLayer";
      holder.replaceChildren(canvas, layerEl);
      holder.style.setProperty("--scale-factor", String(at));
      holder.style.setProperty("--total-scale-factor", String(at));
      const context = canvas.getContext("2d");
      if (context) {
        const task = page.render({ canvas, canvasContext: context, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
        stop = () => { cancelled = true; task.cancel(); };
        await task.promise;
      }
      const content = await page.getTextContent();
      if (cancelled) return;
      const layer = new lib.TextLayer({ textContentSource: content, container: layerEl, viewport });
      await layer.render();
      if (cancelled) return;
      const divs = layer.textDivs as HTMLElement[];
      const texts = layer.textContentItemsStr as string[];
      // 文字层的各个元素与有字的文字条目一一对应；条目带着它在 PDF 坐标里的起点。
      const withText = (content.items as { str?: string; transform?: number[] }[]).filter((one) => typeof one.str === "string");
      const layerItems: LayerItem[] = divs.map((_, index) => {
        const item = withText.length === divs.length ? withText[index] : undefined;
        return { index, text: texts[index] ?? divs[index].textContent ?? "", x: item?.transform?.[4] ?? Number.NaN, y: item?.transform?.[5] ?? Number.NaN };
      });
      drawn.current.set(n, { scale: at, viewport, divs, texts: layerItems.map((one) => one.text), items: layerItems, painted: new Map() });
      setTick((t) => t + 1);
    } catch (error) {
      // 滚走时取消的那一次不算出错。
      if (!cancelled) console.error(`PDF 文件 ${path} 的第 ${n} 页没有画出来：`, error);
    } finally {
      // 只收自己登记的那一项：这一次被取消之后同一页可能又开始画了一次，那是另一项。
      if (drawing.current.get(n) === mine) drawing.current.delete(n);
    }
  }

  // 各条目的引用落在哪里（在投影的文字上算，与核对同一个函数）。
  const cites = useMemo(() => {
    if (!units) return [];
    return pdfCitations(items, path).flatMap((cite) => {
      const place = placePdfExcerpt(units, cite.page, cite.block, cite.excerpt);
      if (place.kind !== "in" && place.kind !== "span") return [];
      return [{ itemId: cite.itemId, ranges: place.ranges.map((r) => ({ page: r.page, block: r.block, text: units[r.index].text.slice(r.start, r.end) })) }];
    });
  }, [units, items, path]);
  const citedCount = useMemo(() => new Set(cites.map((cite) => cite.itemId)).size, [cites]);
  useEffect(() => { if (units) onCitedCount?.(citedCount); }, [citedCount, units]);

  // 收到定位请求：算出要去哪一页、框哪几块、标哪几截，先滚到附近。
  useEffect(() => {
    if (!locate || !doc) return;
    // 投影还在读时先等一等：算摘录落在哪里要用它；读不到（null）时照样能框出那一块。
    if (projected?.status === "loading") return;
    const loc = parsePdfLocator(locate.locator);
    let page = loc?.page ?? null;
    let block = loc?.block ?? null;
    if ((page === null || block === null) && units) {
      // 出处没有写页与块（不该有，兜底）：按摘录找它在哪一块。
      const found = pdfUnitsWith(units, locate.excerpt)[0];
      if (found) { page = found.page; block = found.block; }
    }
    if (page === null || block === null) { onNote?.(PDF_NOTES.nowhere); return; }
    const exists = !!locations && pdfBlockBox(locations, page, block) !== null;
    if (page < 1 || page > doc.numPages || (locations && !exists)) { onNote?.(PDF_NOTES.noBlock(page, block)); return; }
    const place = units ? placePdfExcerpt(units, page, block, locate.excerpt) : null;
    const found = place && (place.kind === "in" || place.kind === "span") ? place.ranges : [];
    const ranges = found.map((r) => ({ block: r.block, text: units![r.index].text.slice(r.start, r.end) }));
    setTarget({ nonce: locate.nonce, page, blocks: found.length ? found.map((r) => r.block) : [block], ranges, hit: ranges.length > 0 });
    onNote?.(!place ? null : place.kind === "miss" ? PDF_NOTES.miss(page) : place.kind === "cross_page" ? PDF_NOTES.crossPage(page)
      : place.kind === "span" ? PDF_NOTES.span(page, found.length) : null);
    // 先滚到那一页的那一块附近（页面多半还没有画出来，按位置表估）；画出来之后再把框对到中间。
    const pane = scroller();
    const box = locations ? pdfBlockBox(locations, page, block) : null;
    if (pane) {
      const inPage = box ? roughTop(box, sizes[page - 1], scale) : 0;
      pane.scrollTop = Math.max(0, pagesOffset(pane) + layout.tops[page - 1] + inPage - pane.clientHeight / 3);
      remeasure.current();
    }
    if (ranges.length === 0) return;
    const timer = setTimeout(() => setTarget((old) => (old && old.nonce === locate.nonce ? { ...old, hit: false } : old)), pdfHit.fadeMs);
    return () => clearTimeout(timer);
  }, [locate?.nonce, doc, projected?.status]);

  // 目录里点了一项：滚到那一页的开头。
  useEffect(() => {
    if (!jump || !doc) return;
    const pane = scroller();
    if (!pane || jump.page < 1 || jump.page > doc.numPages) return;
    pane.scrollTop = Math.max(0, pagesOffset(pane) + layout.tops[jump.page - 1]);
    remeasure.current();
  }, [jump?.nonce, doc]);

  // 页面画出来之后：把被引用的句子与定位的摘录标在文字层上。逐页算出每个元素该怎样标，与上一次不同才重写。
  const unmatched = useRef(0);
  useEffect(() => {
    let missing = false;
    for (const [n, page] of drawn.current) {
      const boxOf = (block: number) => (locations ? pdfBlockBox(locations, n, block) : null);
      const marks = new Map<number, Mark[]>();
      const add = (block: number, text: string, mark: Omit<Mark, "start" | "end">): boolean => {
        const box = boxOf(block);
        const where = box ? findInBlock(page.items, box, text) : null;
        if (!where) return false;
        for (const one of where) marks.set(one.index, [...(marks.get(one.index) ?? []), { start: one.start, end: one.end, ...mark }]);
        return true;
      };
      for (const cite of cites) for (const r of cite.ranges) if (r.page === n) add(r.block, r.text, { items: [cite.itemId] });
      if (target?.hit && target.page === n) for (const r of target.ranges) if (!add(r.block, r.text, { hit: true })) missing = true;
      page.divs.forEach((div, index) => {
        const list = marks.get(index) ?? [];
        // 同一截被几个条目引用时合在一起。
        const merged: Mark[] = [];
        for (const mark of list) {
          const same = merged.find((one) => !one.hit && !mark.hit && one.start === mark.start && one.end === mark.end);
          if (same) same.items = [...(same.items ?? []), ...(mark.items ?? [])];
          else merged.push({ ...mark, items: mark.items ? [...mark.items] : undefined });
        }
        const signature = JSON.stringify(merged);
        if ((page.painted.get(index) ?? "[]") === signature) return;
        page.painted.set(index, signature);
        div.replaceChildren(...splitByMarks(page.texts[index], merged).map((piece) => {
          if (piece.hit) { const mark = document.createElement("mark"); mark.className = "hit"; mark.textContent = piece.text; return mark; }
          if (piece.items) {
            const span = document.createElement("span");
            span.className = "cited";
            span.dataset.items = piece.items.join(" ");
            span.title = `被 ${piece.items.join("、")} 引用`;
            span.textContent = piece.text;
            return span;
          }
          return document.createTextNode(piece.text);
        }));
      });
    }
    // 摘录在投影里找到了、在页面的文字层里却对不上：只框出那一块，写一句。每次定位只写一次。
    if (missing && target && unmatched.current !== target.nonce) { unmatched.current = target.nonce; onNote?.(PDF_NOTES.unmatched); }
  }, [tick, cites, target, locations]);

  // 框画出来之后把它对到看得见的那一段的中间（每次定位只对一次）。
  useEffect(() => {
    if (!target || centred.current === target.nonce || !drawn.current.has(target.page)) return;
    const frame = pagesEl.current?.querySelector<HTMLElement>(`[data-pdf-page="${target.page}"] .pdf-blockbox`);
    if (!frame) return;
    centred.current = target.nonce;
    frame.scrollIntoView?.({ block: "center" });
  }, [tick, target]);

  if (bytes?.status === "error") return <div className="busy-note" data-testid="pdf-error">{bytes.error}</div>;
  if (failed) return <div className="busy-note" data-testid="pdf-unrenderable">{PDF_UNRENDERABLE}</div>;
  if (!doc) return <div className="empty" data-testid="pdf-loading">正在读这份 PDF。</div>;

  const zoom = (next: number) => setChosen(clampScale(next));
  const openCited = (event: ReactMouseEvent) => {
    const hit = (event.target as HTMLElement).closest?.<HTMLElement>("[data-items]");
    const id = hit?.dataset.items?.split(" ")[0];
    // 正在选字的时候不当成点击。
    if (id && !String(window.getSelection() ?? "").trim()) onOpenItem?.(id);
  };

  return (
    <div className="pdf-paper" ref={host} onMouseUp={onMouseUp} onClick={openCited} data-testid="pdf-paper">
      <div className="pdf-bar" data-testid="pdf-bar">
        <span data-testid="pdf-page-now">第 <b>{now}</b> / {count} 页</span>
        <span className="sp" />
        <button type="button" className="btn sm" disabled={scale <= MIN_SCALE} onClick={() => zoom(scale / SCALE_STEP)} data-testid="pdf-zoom-out">缩小</button>
        <button type="button" className="btn sm" disabled={scale >= MAX_SCALE} onClick={() => zoom(scale * SCALE_STEP)} data-testid="pdf-zoom-in">放大</button>
        <button type="button" className="btn sm" disabled={chosen === null} onClick={() => setChosen(null)} data-testid="pdf-zoom-fit">适应宽度</button>
        <span className="pct" data-testid="pdf-zoom-now">{Math.round(scale * 100)}%</span>
      </div>
      <div className="pdf-pages" ref={pagesEl} style={{ height: `${layout.total}px` }} data-testid="pdf-pages">
        {sizes.map((size, i) => {
          const n = i + 1;
          const page = drawn.current.get(n);
          const frames = target && target.page === n && page && locations
            ? target.blocks.flatMap((block) => { const box = pdfBlockBox(locations, n, block); return box ? [{ block, at: screenBox(box, (x, y) => page.viewport.convertToViewportPoint(x, y)) }] : []; })
            : [];
          return (
            <div key={n} className="pdf-page" data-pdf-page={n} data-testid={`pdf-page-${n}`}
              style={{ top: `${layout.tops[i]}px`, left: `max(${PAGE_MARGIN}px, calc((100% - ${Math.round(size.width * scale)}px) / 2))`,
                width: `${Math.round(size.width * scale)}px`, height: `${layout.heights[i]}px` }}>
              <div className="pdf-drawn" />
              <span className="pdf-no">第 {n} 页</span>
              {locations?.pages.find((one) => one.page === n)?.no_text && <div className="pdf-notext" data-testid={`pdf-notext-${n}`}>{NO_TEXT_PAGE}</div>}
              {frames.map((frame) => (
                <div key={frame.block} className="pdf-blockbox" data-testid={`pdf-blockbox-${n}-${frame.block}`}
                  style={{ left: `${frame.at.left - 3}px`, top: `${frame.at.top - 3}px`, width: `${frame.at.width + 6}px`, height: `${frame.at.height + 6}px` }} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
