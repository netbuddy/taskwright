// 一张图：把 Mermaid 文本画出来，画不出来时写明原因，另有「导出 PNG」与「导出 SVG」两个按钮。用在业务说明里的图（work/overall/Figure.tsx）。
//
// 文本一变就重画；先后发出的两次画图，后到的若是旧文本的结果就丢掉。画不出来（语法不对）时不显示上一张图，
// 只显示原因，免得用户把旧图当成新文本的样子。
//
// 看图：图放在一块看板里，占满组件剩下的高度。按住鼠标左键拖动是平移，滚轮是放大缩小（光标底下的那一处不动）；
// 上面四个按钮「缩小」「放大」「适应宽度」「原始大小」与现在的比例照旧。平移与缩放都用变换做，不靠滚动条，
// 所以看板里滚轮不滚页面。一打开时图不比看板宽就按原始大小，比看板宽就缩到看板的宽度，但最多缩到一半，再大的图拖着看。
// 用户自己动过视图之后，文本再变（改图时的预览）不改视图。
//
// 导出 PNG 用的是画出来的原图，按原始大小的 2 倍导出，与看板里现在放大了多少、拖到了哪里无关。

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "antd";
import { PNG_SCALE, WHEEL_STEP, type DiagramViewport, exportPng, exportSvg, fitZoom, initialZoom, placed, renderDiagram, sizedSvg, stepZoom, wholeZoom, zoomAt } from "./mermaid";

export const DIAGRAM_EMPTY_TEXT = "还没有 Mermaid 文本。";
export const DIAGRAM_DRAWING_TEXT = "正在画图……";
export const DIAGRAM_FAILED_TEXT = "这张图画不出来：";
export const EXPORT_FAILED_TEXT = "没有导出成：";
/** 看板上悬停时的提示。 */
export const STAGE_HINT_TEXT = "按住拖动可以移动图，滚轮放大缩小";
/** 图太大、导出时没有放大到平常的倍数：不到 1 倍的说缩小，别的说只放大了几倍。 */
export const exportShrunkText = (scale: number) => (scale < 1
  ? `这张图很大，导出的 PNG 缩小到了原图的 ${scale.toFixed(1)} 倍，字可能看不清；把图拆成几张再导出。`
  : `这张图很大，导出的 PNG 只放大了 ${scale.toFixed(1)} 倍（平常是 ${PNG_SCALE} 倍）。`);

type Drawn = { state: "empty" } | { state: "drawing" } | { state: "done"; svg: string } | { state: "failed"; reason: string };

/** 嵌在可以上下滚的页面里时悬停的提示：滚轮留给页面，按住 Ctrl 再滚才放大缩小。 */
export const STAGE_HINT_CTRL_TEXT = "按住拖动可以移动图，按住 Ctrl 滚轮放大缩小";

export function DiagramView({ text, fileName = "图", exportOff = null, onDrawn, wheel = "always", fit = "width" }: {
  /** 一打开时怎样定比例：width 是只看宽度（图比看板宽才缩），whole 是整张都看得见（看板的高度定死时用）。 */
  fit?: "width" | "whole";
  text: string;
  fileName?: string;
  /** 图画出来了（每画成一次叫一次）。 */
  onDrawn?: () => void;
  /** 滚轮什么时候放大缩小：always 是一直，ctrl 是按住 Ctrl（或 ⌘）时才是、平常让页面照常滚。 */
  wheel?: "always" | "ctrl";
  /** 现在不能导出的原因（例如文本有没保存的改动）：给了就把「导出 PNG」与「导出 SVG」灰掉，悬停显示这句话。 */
  exportOff?: string | null;
}) {
  const [drawn, setDrawn] = useState<Drawn>({ state: "empty" });
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** 看图的比例与平移；null 是还没有定（等图画出来、量到看板的大小）。 */
  const [view, setView] = useState<DiagramViewport | null>(null);
  const [panning, setPanning] = useState(false);
  /** 用户有没有自己动过视图：动过之后重画不再自动摆放。 */
  const adjusted = useRef(false);
  /** 拖动开始时鼠标的位置与当时的平移。 */
  const panStart = useRef<{ mx: number; my: number; x: number; y: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const svg = drawn.state === "done" ? drawn.svg : null;
  const sized = useMemo(() => (svg === null ? null : sizedSvg(svg)), [svg]);
  const shown: DiagramViewport = view ?? { zoom: 1, x: 0, y: 0 };

  const whenDrawn = useRef(onDrawn);
  whenDrawn.current = onDrawn;
  useEffect(() => {
    setNote(null);
    if (!text.trim()) {
      setDrawn({ state: "empty" });
      return;
    }
    let stale = false;
    setDrawn({ state: "drawing" });
    renderDiagram(text).then(
      (done) => { if (!stale) { setDrawn({ state: "done", svg: done }); whenDrawn.current?.(); } },
      (error: unknown) => { if (!stale) setDrawn({ state: "failed", reason: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { stale = true; };
  }, [text]);

  /** 看板的宽高；量不到时是 0。 */
  const room = () => ({ width: stage.current?.clientWidth ?? 0, height: stage.current?.clientHeight ?? 0 });
  // 图画出来了、用户还没有动过视图：定一打开时的比例，摆进看板。
  useEffect(() => {
    if (!sized || adjusted.current) return;
    const space = room();
    setView(placed(sized, space, fit === "whole" ? wholeZoom(sized, space) : initialZoom(sized.width, space.width)));
  }, [sized]);

  /** 用户换比例：锚点在看板上 (px, py)，不给时是看板的中心。 */
  const zoomBy = (next: (zoom: number) => number, px?: number, py?: number) => {
    adjusted.current = true;
    const space = room();
    setView((old) => { const from = old ?? { zoom: 1, x: 0, y: 0 }; return zoomAt(from, next(from.zoom), px ?? space.width / 2, py ?? space.height / 2); });
  };
  /** 用户要一个比例并重新摆放（「适应宽度」「原始大小」）。 */
  const place = (zoom: number) => {
    if (!sized) return;
    adjusted.current = true;
    setView(placed(sized, room(), zoom));
  };

  // 拖动：按下记起点，移动与松开挂在 window 上，鼠标移出看板也接着拖，松开一定收得住。
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    panStart.current = { mx: event.clientX, my: event.clientY, x: shown.x, y: shown.y };
    setPanning(true);
  };
  useEffect(() => {
    if (!panning) return;
    const move = (event: PointerEvent) => {
      const from = panStart.current;
      if (!from) return;
      adjusted.current = true;
      setView((old) => ({ zoom: old?.zoom ?? 1, x: from.x + (event.clientX - from.mx), y: from.y + (event.clientY - from.my) }));
    };
    const stop = () => { panStart.current = null; setPanning(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [panning]);
  // 滚轮：React 的 onWheel 可能是被动监听，拦不住页面跟着滚，所以挂原生的非被动监听。
  const hasStage = sized !== null;
  useEffect(() => {
    const board = stage.current;
    if (!board) return;
    const onWheel = (event: WheelEvent) => {
      if (wheel === "ctrl" && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = board.getBoundingClientRect();
      const factor = event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      zoomBy((zoom) => zoom * factor, event.clientX - box.left, event.clientY - box.top);
    };
    board.addEventListener("wheel", onWheel, { passive: false });
    return () => board.removeEventListener("wheel", onWheel);
  }, [hasStage, wheel]);

  const downloadSvg = async () => {
    if (drawn.state !== "done" || exporting) return;
    setExporting(true);
    setNote(null);
    try {
      await exportSvg(text, fileName);
    } catch (error) {
      setNote(`${EXPORT_FAILED_TEXT}${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
    }
  };

  const download = async () => {
    if (drawn.state !== "done" || exporting) return;
    setExporting(true);
    setNote(null);
    try {
      const { scale } = await exportPng(drawn.svg, fileName);
      if (scale < PNG_SCALE) setNote(exportShrunkText(scale));
    } catch (error) {
      setNote(`${EXPORT_FAILED_TEXT}${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="diagram-view" data-testid="diagram-view" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.5rem 0.75rem", marginBottom: "0.5rem" }}>
        <Button onClick={() => void download()} disabled={drawn.state !== "done" || !!exportOff} title={exportOff ?? undefined} loading={exporting}
          data-testid="diagram-export">导出 PNG</Button>
        <Button onClick={() => void downloadSvg()} disabled={drawn.state !== "done" || !!exportOff} title={exportOff ?? undefined} loading={exporting}
          data-testid="diagram-export-svg">导出 SVG</Button>
        {sized && (
          <span data-testid="diagram-zoom" style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
            <Button size="small" onClick={() => zoomBy((zoom) => stepZoom(zoom, -1))} data-testid="diagram-zoom-out">缩小</Button>
            <Button size="small" onClick={() => zoomBy((zoom) => stepZoom(zoom, 1))} data-testid="diagram-zoom-in">放大</Button>
            <Button size="small" onClick={() => place(fitZoom(sized.width, room().width))} data-testid="diagram-zoom-fit">适应宽度</Button>
            <Button size="small" onClick={() => place(1)} data-testid="diagram-zoom-actual">原始大小</Button>
            <span data-testid="diagram-zoom-now" style={{ fontSize: "0.8125rem", color: "var(--mut)", fontVariantNumeric: "tabular-nums" }}>{Math.round(shown.zoom * 100)}%</span>
          </span>
        )}
        {note && <span data-testid="diagram-note" style={{ fontSize: "0.8125rem", color: "var(--mut)" }}>{note}</span>}
      </div>
      {drawn.state === "empty" && <div data-testid="diagram-empty" style={{ color: "var(--mut)" }}>{DIAGRAM_EMPTY_TEXT}</div>}
      {drawn.state === "drawing" && <div data-testid="diagram-drawing" style={{ color: "var(--mut)" }}>{DIAGRAM_DRAWING_TEXT}</div>}
      {drawn.state === "failed" && (
        <div data-testid="diagram-error" role="alert">
          <div style={{ color: "var(--gap)" }}>{DIAGRAM_FAILED_TEXT}</div>
          <pre style={{ margin: "0.25rem 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "0.8125rem" }}>{drawn.reason}</pre>
        </div>
      )}
      {sized && (
        <div ref={stage} className={`diagram-stage${panning ? " panning" : ""}`} data-testid="diagram-stage" title={wheel === "ctrl" ? STAGE_HINT_CTRL_TEXT : STAGE_HINT_TEXT} onPointerDown={startPan}
          style={{ position: "relative", flex: "1 1 auto", minHeight: "16rem", overflow: "hidden", cursor: panning ? "grabbing" : "grab", userSelect: "none", touchAction: "none" }}>
          <div data-testid="diagram-svg" dangerouslySetInnerHTML={{ __html: sized.text }}
            style={{ position: "absolute", left: 0, top: 0, width: `${sized.width}px`, height: `${sized.height}px`, transformOrigin: "0 0",
              transform: `translate(${Math.round(shown.x)}px, ${Math.round(shown.y)}px) scale(${shown.zoom})` }} />
        </div>
      )}
    </div>
  );
}
