// 点知识库来源的出处看原文、在知识库页面「查看」一份文档：只读对话框，标题是「知识库名 / 文档名」。知识库文档不放进「原文定位」页签：
// 那里只放这次要整理的材料。
//
// PDF 与 Word 文档按原样显示，与材料一侧同一套显示部件：PDF 交给 PdfPaper，按出处的页与块跳过去、框出那一块并逐字标出摘录；
// Word 交给 DocxPaper，按原版式分页，滚到出处那一段并高亮摘录。由文档生成的文字版只给助手读，这里不显示，也没有看它的入口；
// 原件读不到或画不出来时只写「这份文档现在打不开。」。纯文本文档（.md、.txt）本身就是原文，照旧显示文字，摘录高亮并滚到那里。

import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "antd";
import { api, ApiError } from "../../api/client";
import type { KnowledgeLibrary } from "../../api/types";
import { excerptSpan, knowledgePlace } from "../../model/knowledge";
import { knowledgeOwner } from "../../state/docSource";
import { DocxPaper } from "./DocxPaper";
import { PdfPaper } from "./PdfPaper";

/** 文档的正文读不到、后端又没有给说明时的那句话。 */
const NOT_READ = "这份文档的正文没有读到。";
/** PDF、Word 文档的原件读不到或画不出来时的那句话。 */
export const CANNOT_OPEN = "这份文档现在打不开。";

export interface KnowledgeDocRequest {
  /** 来源的出处（knowledge/知识库编号/文档名，Word 文档带段落号，PDF 文档带页与块）。 */
  locator: string;
  /** 摘录；只是查看整份文档（知识库页面的「查看」）时是空的，不定位。 */
  excerpt: string;
}

export function KnowledgeDocModal({ request, libraries, onClose }: {
  request: KnowledgeDocRequest | null;
  libraries: KnowledgeLibrary[] | null;
  onClose: () => void;
}) {
  const place = request ? knowledgePlace(request.locator, libraries) : null;
  const kind = place?.library ? (/\.pdf$/i.test(place.name) ? "pdf" : /\.docx$/i.test(place.name) ? "docx" : "text") : null;
  const paged = kind === "pdf" || kind === "docx";
  // 交给显示部件的定位请求：一次打开一个，nonce 固定为 1；没有摘录时不定位。
  const locate = useMemo(() => (request && request.excerpt.trim() ? { locator: request.locator, excerpt: request.excerpt, nonce: 1 } : null),
    [request?.locator, request?.excerpt]);
  const [note, setNote] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(null);
    setError(null);
    setNote(null);
    setUnavailable(false);
    if (!place || paged) return;
    // 出处拆不出知识库编号与文档名（写法不对）：没有文档可读，直接写明没有读到，不停在「正在读」。
    if (!place.library) {
      setError(NOT_READ);
      return;
    }
    let live = true;
    api.documentText(place.library, place.name).then((r) => { if (live) setText(r.text); })
      .catch((e) => { if (live) setError(e instanceof ApiError ? e.message : NOT_READ); });
    return () => { live = false; };
  }, [request?.locator]);

  const want = request?.excerpt.trim() ? request.excerpt : null;
  const span = useMemo(() => (text == null || want === null ? null : excerptSpan(text, want, place?.paragraph ?? null)), [text, want]);
  useEffect(() => {
    if (span) body.current?.querySelector("mark.hit")?.scrollIntoView?.({ block: "center" });
  }, [span]);

  return (
    <Modal title={place?.title ?? ""} open={!!request} onCancel={onClose} footer={null} width={paged ? "min(64rem, 94vw)" : "min(52rem, 92vw)"} destroyOnHidden>
      {paged && place && (
        <div className="kbdoc" data-testid="kb-doc">
          {unavailable && <div className="kbdoc-note" data-testid="kb-doc-error">{CANNOT_OPEN}</div>}
          {!unavailable && note && <div className="kbdoc-note" data-testid="kb-doc-note">{note}</div>}
          <div className="app docx-view" hidden={unavailable}>
            {kind === "pdf"
              ? <div className="doc-b pdf-modal-b"><PdfPaper taskId={knowledgeOwner(place.library)} path={place.name} items={[]} locate={locate} onNote={setNote} onUnavailable={setUnavailable} /></div>
              : <div className="doc-b"><DocxPaper taskId={knowledgeOwner(place.library)} path={place.name} items={[]} locate={locate} onNote={setNote} onUnavailable={setUnavailable} /></div>}
          </div>
        </div>
      )}
      {!paged && (
        <div className="kbdoc" data-testid="kb-doc">
          {error && <div className="kbdoc-note" data-testid="kb-doc-error">{error}</div>}
          {!error && text == null && <div className="kbdoc-note">正在读这份文档。</div>}
          {text != null && want !== null && !span && <div className="kbdoc-note" data-testid="kb-doc-miss">没有在这份文档里找到这段原文，下面是文档的全文。</div>}
          {text != null && (
            <div className="kbdoc-text" ref={body}>
              {span ? <>{text.slice(0, span[0])}<mark className="hit">{text.slice(span[0], span[1])}</mark>{text.slice(span[1])}</> : text}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
