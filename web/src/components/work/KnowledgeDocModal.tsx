// 点知识库来源的出处看原文：只读对话框，标题是「知识库名 / 文档名」，正文是文档的文字（Word 文档显示由它生成的文字，
// 每段一行、段落号写在方括号里），摘录高亮并滚到那里。知识库文档不放进「材料」页签：材料页签只放这次要整理的材料。

import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "antd";
import { api, ApiError } from "../../api/client";
import type { KnowledgeLibrary } from "../../api/types";
import { excerptSpan, knowledgePlace } from "../../model/knowledge";

export interface KnowledgeDocRequest {
  /** 来源的出处（knowledge/知识库编号/文档名，Word 文档带段落号）。 */
  locator: string;
  excerpt: string;
}

export function KnowledgeDocModal({ request, libraries, onClose }: {
  request: KnowledgeDocRequest | null;
  libraries: KnowledgeLibrary[] | null;
  onClose: () => void;
}) {
  const place = request ? knowledgePlace(request.locator, libraries) : null;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(null);
    setError(null);
    if (!place || !place.library) return;
    let live = true;
    api.documentText(place.library, place.name).then((r) => { if (live) setText(r.text); })
      .catch((e) => { if (live) setError(e instanceof ApiError ? e.message : "这份文档的正文没有读到。"); });
    return () => { live = false; };
  }, [request?.locator]);

  const span = useMemo(() => (text == null || !request ? null : excerptSpan(text, request.excerpt, place?.paragraph ?? null)), [text, request?.excerpt]);
  useEffect(() => {
    if (span) body.current?.querySelector("mark.hit")?.scrollIntoView?.({ block: "center" });
  }, [span]);

  return (
    <Modal title={place?.title ?? ""} open={!!request} onCancel={onClose} footer={null} width="min(52rem, 92vw)">
      <div className="kbdoc" data-testid="kb-doc">
        {error && <div className="kbdoc-note" data-testid="kb-doc-error">{error}</div>}
        {!error && text == null && <div className="kbdoc-note">正在读这份文档。</div>}
        {text != null && !span && <div className="kbdoc-note" data-testid="kb-doc-miss">没有在这份文档里找到这段原文，下面是文档的全文。</div>}
        {text != null && (
          <div className="kbdoc-text" ref={body}>
            {span ? <>{text.slice(0, span[0])}<mark className="hit">{text.slice(span[0], span[1])}</mark>{text.slice(span[1])}</> : text}
          </div>
        )}
      </div>
    </Modal>
  );
}
