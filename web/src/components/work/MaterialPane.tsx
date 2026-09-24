// 文档区：材料清单与原文（按需读取 GET …/materials/content）。只读。样式照设计原型的 .doc-h 与 .paper。
//
// 原文里被条目引用的句子画浅蓝底线（按各条目「文档原文」来源的摘录逐字找），点一下打开引用它的条目；
// 条目那边点来源小标签时，这里切到那份材料、滚到那句并高亮（locate）。
// 选中一段原文后，底部出现三个动作，都要发给助手：据此新建条目、补到当前条目、就这段提问。

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../../api/client";
import type { Item, Material } from "../../api/types";

export interface LocateRequest {
  excerpt: string;
  locator: string;
  /** 每点一次加一，同一句再点一次也要重新滚过去。 */
  nonce: number;
}

/** 第 7 节的三个框选模板。 */
export const SELECTION_TEMPLATES = {
  create: (path: string, quote: string) => `请根据材料 ${path} 里的这段原文新建条目：「${quote}」`,
  attach: (path: string, itemId: string, quote: string) => `请把材料 ${path} 里的这段原文补到 ${itemId}：「${quote}」`,
  ask: (path: string, quote: string, question: string) => `关于材料 ${path} 里的这段原文：「${quote}」，${question}`,
};

export function MaterialPane({ taskId, materials, focusPath, onCollapse, items = [], locate, currentItem, disabled, onOpenItem, onSend }: {
  taskId: string;
  materials: Material[];
  /** 新加进来的材料：变了就选中它显示正文。 */
  focusPath?: string | null;
  onCollapse: () => void;
  /** 旧接口留下的参数，现在收起按钮照原型写成文字「收起 ⇥」，不用它。 */
  collapseIcon?: ReactNode;
  items?: Item[];
  locate?: LocateRequest | null;
  /** 条目区当前打开的条目（「补到当前条目」要用）。 */
  currentItem?: string | null;
  disabled?: boolean;
  onOpenItem?: (itemId: string) => void;
  onSend?: (text: string) => void;
}) {
  const [path, setPath] = useState<string | null>(materials[0]?.path ?? null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hit, setHit] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const paper = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!path && materials[0]) setPath(materials[0].path); }, [materials, path]);
  useEffect(() => { if (focusPath) setPath(focusPath); }, [focusPath]);
  useEffect(() => {
    if (!locate) return;
    const match = materials.find((m) => m.path === locate.locator || m.path.endsWith(locate.locator) || locate.locator.endsWith(m.path));
    if (match) setPath(match.path);
    setHit(locate.excerpt);
  }, [locate?.nonce]);
  useEffect(() => {
    if (!path) return;
    setText(null);
    api.materialContent(taskId, path).then((r) => { setText(r.text); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [taskId, path]);
  // 高亮的那句出现之后滚过去，两秒后褪掉。
  useEffect(() => {
    if (!hit || text == null) return;
    const el = paper.current?.querySelector("mark.hit");
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => setHit(null), 2200);
    return () => clearTimeout(t);
  }, [hit, text]);

  const name = path?.split("/").pop() ?? "还没有材料";
  const cites = useMemo(() => citationsOf(items, path), [items, path]);
  const segments = useMemo(() => (text == null ? [] : segment(text, cites, hit)), [text, cites, hit]);
  const citedItems = new Set(segments.flatMap((s) => s.items ?? []));

  const onMouseUp = () => {
    const sel = window.getSelection();
    const t = sel ? String(sel).trim() : "";
    if (t.length > 1 && sel?.anchorNode && paper.current?.contains(sel.anchorNode)) { setSelection(t); setAsking(false); }
  };
  const act = (kind: "create" | "attach" | "ask") => {
    if (!path || !selection || !onSend) return;
    if (kind === "ask") { setAsking(true); return; }
    onSend(kind === "create" ? SELECTION_TEMPLATES.create(path, selection) : SELECTION_TEMPLATES.attach(path, currentItem!, selection));
    setSelection("");
    window.getSelection()?.removeAllRanges();
  };
  const sendQuestion = () => {
    if (!path || !question.trim() || !onSend) return;
    onSend(SELECTION_TEMPLATES.ask(path, selection, question.trim()));
    setSelection(""); setAsking(false); setQuestion("");
  };

  return (
    <>
      <div className="doc-h">
        {materials.length > 1 ? (
          <select value={path ?? ""} onChange={(e) => setPath(e.target.value)} data-testid="material-select">
            {materials.map((m) => <option key={m.path} value={m.path}>{m.path.split("/").pop()}</option>)}
          </select>
        ) : <b>{name}</b>}
        <span className="chip">外来 · 只读</span>
        {text != null && <span className="chip">{citedItems.size ? `被 ${citedItems.size} 个条目引用过` : "还没有被条目引用"}</span>}
        <span className="btn sm" role="button" style={{ marginLeft: "auto" }} onClick={onCollapse}>收起 ⇥</span>
      </div>
      <div className="doc-wrap">
        <div className="doc-b">
          {!materials.length && <div className="empty">这个任务还没有材料。可以在任务页上传，或者在对话区「附一份材料」。</div>}
          {error && <div className="busy-note">{error}</div>}
          {path && text == null && !error && <div className="empty">正在读原文。</div>}
          {text != null && (
            <div className="paper" ref={paper} onMouseUp={onMouseUp} data-testid="paper">
              {segments.map((s, i) => s.hit ? <mark key={i} className="hit">{s.text}</mark>
                : s.items ? <span key={i} className="cited" title={`被 ${s.items.join("、")} 引用`} onClick={() => onOpenItem?.(s.items![0])}>{s.text}</span>
                : <span key={i}>{s.text}</span>)}
            </div>
          )}
        </div>
        {selection && onSend && (
          <div className="selbar" data-testid="selbar">
            <span>你选中了一段原文：</span><span className="selq">「{selection}」</span>
            <button type="button" className="aibtn" disabled={disabled} onClick={() => act("create")}>据此新建条目</button>
            <button type="button" className="aibtn" disabled={disabled || !currentItem} title={currentItem ? `补到 ${currentItem}` : "先在条目区打开一个条目"} onClick={() => act("attach")}>
              补到当前条目{currentItem ? `（${currentItem}）` : ""}
            </button>
            <button type="button" className="aibtn" disabled={disabled} onClick={() => act("ask")}>就这段提问</button>
            <span className="aihint">这三件都要发给助手，它做完要等一会儿</span>
            <span className="btn sm" role="button" style={{ marginLeft: "auto" }} onClick={() => { setSelection(""); setAsking(false); }}>不用了</span>
            {asking && (
              <div className="askbox">
                <input autoFocus placeholder="想问这段原文什么？" value={question} onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") sendQuestion(); }} data-testid="selection-question" />
                <button type="button" className="btn sm pri" disabled={!question.trim()} onClick={sendQuestion}>发给助手</button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

interface Segment { text: string; items?: string[]; hit?: boolean }

/** 这份材料被哪些条目引用了哪几句：摘录 → 条目编号（按条目当前版本的「文档原文」来源，出处对得上这份材料的）。 */
export function citationsOf(items: Item[], path: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!path) return out;
  for (const item of items) {
    for (const s of item.sources) {
      if (s.kind !== "文档原文" || !s.excerpt?.trim()) continue;
      if (!(s.locator === path || path.endsWith(s.locator) || s.locator.endsWith(path))) continue;
      const list = out.get(s.excerpt) ?? [];
      if (!list.includes(item.item_id)) list.push(item.item_id);
      out.set(s.excerpt, list);
    }
  }
  return out;
}

/** 把原文切成几段：要高亮的那句（逐字找，找不到退到前 12 个字）、被引用的句子、其余。重叠时先到的算。 */
export function segment(text: string, cites: Map<string, string[]>, hit: string | null): Segment[] {
  const ranges: { start: number; end: number; items?: string[]; hit?: boolean }[] = [];
  if (hit) {
    let start = text.indexOf(hit);
    let len = hit.length;
    if (start < 0 && hit.length > 12) { start = text.indexOf(hit.slice(0, 12)); len = 12; }
    if (start >= 0) ranges.push({ start, end: start + len, hit: true });
  }
  for (const [excerpt, items] of cites) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(excerpt, from);
      if (start < 0) break;
      ranges.push({ start, end: start + excerpt.length, items });
      from = start + excerpt.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start || (a.hit ? -1 : 1));
  const out: Segment[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start < at) continue;
    if (r.start > at) out.push({ text: text.slice(at, r.start) });
    out.push({ text: text.slice(r.start, r.end), items: r.items, hit: r.hit });
    at = r.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
