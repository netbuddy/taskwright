// 生成文档的预览：把文档（Markdown 文本）照共用的分块函数切成块，排版显示——标题、段落、列表、表格、引用各有样子，
// 图当场画出来（画不出来时写明原因并显示它的 Mermaid 文本）。下载的 Markdown 与 Word 文件用的是同一批块。
// 不用 innerHTML 拼文字；只有图是 mermaid 画出来的 SVG（securityLevel 为 strict，见 diagram/mermaid.ts）。

import { useEffect, useMemo, useState } from "react";
import { type DocBlock, type DocRun, documentBlocks } from "../../../agent/src/lib/document_blocks.ts";
import { renderDiagram, sizedSvg } from "./diagram/mermaid";

const runs = (list: readonly DocRun[]) => list.map((run, i) => (run.bold ? <b key={i}>{run.text}</b> : <span key={i}>{run.text}</span>));

/** 一张图：画成 SVG，宽度不超过预览区。 */
function Figure({ mermaid, id }: { mermaid: string; id: string | null }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSvg(null);
    setError(null);
    renderDiagram(mermaid).then((text) => { if (live) setSvg(sizedSvg(text).text); }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [mermaid]);
  if (error !== null) {
    return (
      <div className="docview-fig bad" data-testid={`doc-figure-${id ?? "x"}`}>
        <div className="docview-fig-note">这张图没有画出来：{error}</div>
        <pre>{mermaid}</pre>
      </div>
    );
  }
  return (
    <div className="docview-fig" data-testid={`doc-figure-${id ?? "x"}`} data-drawn={svg !== null ? "true" : "false"}
      {...(svg !== null ? { dangerouslySetInnerHTML: { __html: svg } } : { children: <span className="docview-fig-note">正在画图。</span> })} />
  );
}

function Block({ block }: { block: DocBlock }) {
  if (block.kind === "heading") {
    const Tag = (["h1", "h2", "h3", "h4"] as const)[block.level - 1];
    return <Tag>{block.text}</Tag>;
  }
  if (block.kind === "paragraph") return <p>{runs(block.runs)}</p>;
  if (block.kind === "quote") return <blockquote>{runs(block.runs)}</blockquote>;
  if (block.kind === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return <Tag>{block.items.map((item, i) => <li key={i} style={item.depth ? { marginLeft: `${item.depth * 1.4}rem` } : undefined}>{runs(item.runs)}</li>)}</Tag>;
  }
  if (block.kind === "table") {
    return (
      <div className="docview-table">
        <table>
          <thead><tr>{block.head.map((cell, i) => <th key={i}>{cell}</th>)}</tr></thead>
          <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (block.kind === "figure") return <Figure mermaid={block.mermaid} id={block.diagram_id} />;
  return <pre>{block.text}</pre>;
}

export function DocumentPreview({ text }: { text: string }) {
  const blocks = useMemo(() => documentBlocks(text), [text]);
  return <div className="docview" data-testid="doc-preview">{blocks.map((block, i) => <Block key={i} block={block} />)}</div>;
}
