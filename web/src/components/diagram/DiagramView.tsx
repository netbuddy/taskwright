// 一张图：把 Mermaid 文本画出来，画不出来时写明原因，另有一个「导出 PNG」按钮。现在还没有接进任何页面。
//
// 文本一变就重画；先后发出的两次画图，后到的若是旧文本的结果就丢掉。画不出来（语法不对）时不显示上一张图，
// 只显示原因，免得用户把旧图当成新文本的样子。

import { useEffect, useState } from "react";
import { Button } from "antd";
import { PNG_SCALE, exportPng, renderDiagram } from "./mermaid";

export const DIAGRAM_EMPTY_TEXT = "还没有 Mermaid 文本。";
export const DIAGRAM_DRAWING_TEXT = "正在画图……";
export const DIAGRAM_FAILED_TEXT = "这张图画不出来：";
export const EXPORT_FAILED_TEXT = "没有导出成：";
/** 图太大、导出时没有放大到平常的倍数：不到 1 倍的说缩小，别的说只放大了几倍。 */
export const exportShrunkText = (scale: number) => (scale < 1
  ? `这张图很大，导出的 PNG 缩小到了原图的 ${scale.toFixed(1)} 倍，字可能看不清；把图拆成几张再导出。`
  : `这张图很大，导出的 PNG 只放大了 ${scale.toFixed(1)} 倍（平常是 ${PNG_SCALE} 倍）。`);

type Drawn = { state: "empty" } | { state: "drawing" } | { state: "done"; svg: string } | { state: "failed"; reason: string };

export function DiagramView({ text, fileName = "图" }: { text: string; fileName?: string }) {
  const [drawn, setDrawn] = useState<Drawn>({ state: "empty" });
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

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
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
        <Button onClick={() => void download()} disabled={drawn.state !== "done"} loading={exporting} data-testid="diagram-export">导出 PNG</Button>
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
      {drawn.state === "done" && <div data-testid="diagram-svg" style={{ overflow: "auto" }} dangerouslySetInnerHTML={{ __html: drawn.svg }} />}
    </div>
  );
}
