// 知识库页面里「试一试按意思查找」：在选中的这一个知识库里找与一句话意思最相近的几个片段，让用户不经助手也能看看查不查得到。
// 助手在任务里用的是同一个接口，只是它查的是任务选用的全部知识库。这个知识库里的文档没有都换算好、或者还没有选嵌入模型时不能查，
// 输入框是灰的，下面写明原因。换一个知识库看时，页面给这个组件换一个 key，上一次的结果随之清掉。

import { useState } from "react";
import { Button, Input } from "antd";
import { api, ApiError } from "../api/client";
import type { EmbeddedLibrary, KnowledgeSearchResult } from "../api/types";
import { searchPlaceText } from "../model/knowledge";
import { useToast } from "./Toasts";

export const SEARCH_NO_MODEL_TEXT = "还没有选嵌入模型，不能按意思查找。";
export const SEARCH_NOT_READY_TEXT = "这个知识库里的文档都换算好之后，才能按意思查找。";
export const SEARCH_NO_CHUNKS_TEXT = "这个知识库里的文档没有可比较的文字。";
export const searchPendingText = (pending: number) => `这个知识库里还有 ${pending} 份文档没有换算好，换算完成后才能按意思查找。`;

export function KnowledgeSearchBox({ library, model }: { library: EmbeddedLibrary; model: string | null }) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null);
  const ready = model !== null && library.embedding.done === library.embedding.total;
  const blocked = model === null ? SEARCH_NO_MODEL_TEXT : ready ? null : SEARCH_NOT_READY_TEXT;

  const search = async () => {
    const text = query.trim();
    if (!text || blocked || busy) return;
    setBusy(true);
    try {
      setResult(await api.searchKnowledge(text, [library.id]));
    } catch (e) {
      setResult(null);
      toast.error(e instanceof ApiError ? e.message : "这一次没有查成。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kbsearch" data-testid="kb-search">
      <div className="flabel">试一试按意思查找</div>
      <div className="row">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} onPressEnter={() => void search()} disabled={blocked !== null}
          placeholder="写一句完整的话，例如：图书超期不还怎样罚款" data-testid="kb-search-input" />
        <Button onClick={() => void search()} disabled={blocked !== null || !query.trim()} loading={busy} data-testid="kb-search-button">查找</Button>
      </div>
      <div className="hint" data-testid="kb-search-hint">
        {blocked ?? "在这个知识库的文档里找意思最相近的几个片段，用词不同也找得到。助手在任务里用的是同一种办法，它查的是任务选用的全部知识库。"}
      </div>
      {result && !blocked && (
        <div className="hits" data-testid="kb-search-result">
          {!result.ready ? <div className="none">{searchPendingText(result.pending)}</div>
            : result.hits.length === 0 ? <div className="none">{SEARCH_NO_CHUNKS_TEXT}</div>
              : (
                <>
                  <div className="cap">在 {result.chunks} 个片段里，最相近的 {result.hits.length} 个。相近程度在 0 到 1 之间，越大越相近。</div>
                  {result.hits.map((hit, i) => (
                    <div className="hit" key={i} data-testid="kb-search-hit">
                      <div className="hh">
                        <span className="sc">相近程度 {hit.score.toFixed(2)}</span>
                        <span className="dn">{hit.name}</span>
                        {hit.title && <span className="ht">{hit.title}</span>}
                        <span className="hp">{searchPlaceText(hit)}</span>
                      </div>
                      <div className="hx">{hit.text}</div>
                    </div>
                  ))}
                </>
              )}
        </div>
      )}
    </div>
  );
}
