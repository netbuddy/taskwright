// 一张图：把 Mermaid 文本画出来，画不出来时写明原因，另有一个「导出 PNG」按钮。用在图表页签里图的详情（work/DiagramsPane.tsx）。
//
// 文本一变就重画；先后发出的两次画图，后到的若是旧文本的结果就丢掉。画不出来（语法不对）时不显示上一张图，
// 只显示原因，免得用户把旧图当成新文本的样子。
//
// 放大与滚动：图放在一个可以横竖滚动的框里，上面四个按钮「缩小」「放大」「适应宽度」「原始大小」，旁边写现在的比例。
// 一打开时图不比框宽就按原始大小，比框宽就缩到框的宽度，但最多缩到一半，再大的图靠滚动看，不缩到看不清。
// 用户自己调过比例之后，文本再变（改图时的预览）也不改比例。不做滚轮缩放：滚轮留给滚动。

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "antd";
import { PNG_SCALE, exportPng, fitZoom, initialZoom, renderDiagram, scalableSvg, stepZoom } from "./mermaid";

export const DIAGRAM_EMPTY_TEXT = "还没有 Mermaid 文本。";
export const DIAGRAM_DRAWING_TEXT = "正在画图……";
export const DIAGRAM_FAILED_TEXT = "这张图画不出来：";
export const EXPORT_FAILED_TEXT = "没有导出成：";
/** 图太大、导出时没有放大到平常的倍数：不到 1 倍的说缩小，别的说只放大了几倍。 */
export const exportShrunkText = (scale: number) => (scale < 1
  ? `这张图很大，导出的 PNG 缩小到了原图的 ${scale.toFixed(1)} 倍，字可能看不清；把图拆成几张再导出。`
  : `这张图很大，导出的 PNG 只放大了 ${scale.toFixed(1)} 倍（平常是 ${PNG_SCALE} 倍）。`);

type Drawn = { state: "empty" } | { state: "drawing" } | { state: "done"; svg: string } | { state: "failed"; reason: string };

export function DiagramView({ text, fileName = "图", exportOff = null }: {
  text: string;
  fileName?: string;
  /** 现在不能导出的原因（例如文本有没保存的改动）：给了就把「导出 PNG」灰掉，悬停显示这句话。 */
  exportOff?: string | null;
}) {
  const [drawn, setDrawn] = useState<Drawn>({ state: "empty" });
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** 看图的比例；null 是还没有定（等图画出来、量到框的宽度）。 */
  const [zoom, setZoom] = useState<number | null>(null);
  /** 用户有没有自己调过比例：调过之后重画不再自动定比例。 */
  const adjusted = useRef(false);
  const frame = useRef<HTMLDivElement>(null);
  const svg = drawn.state === "done" ? drawn.svg : null;
  const scalable = useMemo(() => (svg === null ? null : scalableSvg(svg)), [svg]);
  useEffect(() => {
    if (scalable && !adjusted.current) setZoom(initialZoom(scalable.width, room()));
  }, [scalable]);
  /** 框里能放图的宽度：框的宽度去掉左右内边距；量不到时是 0。 */
  const room = (): number => {
    const box = frame.current;
    if (!box) return 0;
    const style = getComputedStyle(box);
    return box.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
  };
  const setByUser = (next: number) => { adjusted.current = true; setZoom(next); };
  const shown = zoom ?? 1;

  useEffect(() => {
    setNote(null);
    if (!text.trim()) {
      setDrawn({ state: "empty" });
      return;
    }
    let stale = false;
    setDrawn({ state: "drawing" });
    renderDiagram(text).then(
      (svg) => { if (!stale) setDrawn({ state: "done", svg }); },
      (error: unknown) => { if (!stale) setDrawn({ state: "failed", reason: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { stale = true; };
  }, [text]);

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
    <div className="diagram-view" data-testid="diagram-view">
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.5rem 0.75rem", marginBottom: "0.5rem" }}>
        <Button onClick={() => void download()} disabled={drawn.state !== "done" || !!exportOff} title={exportOff ?? undefined} loading={exporting}
          data-testid="diagram-export">导出 PNG</Button>
        {scalable && (
          <span data-testid="diagram-zoom" style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
            <Button size="small" onClick={() => setByUser(stepZoom(shown, -1))} data-testid="diagram-zoom-out">缩小</Button>
            <Button size="small" onClick={() => setByUser(stepZoom(shown, 1))} data-testid="diagram-zoom-in">放大</Button>
            <Button size="small" onClick={() => setByUser(fitZoom(scalable.width, room()))} data-testid="diagram-zoom-fit">适应宽度</Button>
            <Button size="small" onClick={() => setByUser(1)} data-testid="diagram-zoom-actual">原始大小</Button>
            <span data-testid="diagram-zoom-now" style={{ fontSize: "0.8125rem", color: "#8c8c8c", fontVariantNumeric: "tabular-nums" }}>{Math.round(shown * 100)}%</span>
          </span>
        )}
        {note && <span data-testid="diagram-note" style={{ fontSize: "0.8125rem", color: "#8c8c8c" }}>{note}</span>}
      </div>
      {drawn.state === "empty" && <div data-testid="diagram-empty" style={{ color: "#8c8c8c" }}>{DIAGRAM_EMPTY_TEXT}</div>}
      {drawn.state === "drawing" && <div data-testid="diagram-drawing" style={{ color: "#8c8c8c" }}>{DIAGRAM_DRAWING_TEXT}</div>}
      {drawn.state === "failed" && (
        <div data-testid="diagram-error" role="alert">
          <div style={{ color: "#cf1322" }}>{DIAGRAM_FAILED_TEXT}</div>
          <pre style={{ margin: "0.25rem 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "0.8125rem" }}>{drawn.reason}</pre>
        </div>
      )}
      {scalable && (
        <div ref={frame} className="diagram-frame" data-testid="diagram-frame" style={{ overflow: "auto", maxHeight: "36rem" }}>
          <div data-testid="diagram-svg" style={{ width: `${Math.round(scalable.width * shown)}px`, height: `${Math.round(scalable.height * shown)}px` }}
            dangerouslySetInnerHTML={{ __html: scalable.text }} />
        </div>
      )}
    </div>
  );
}
