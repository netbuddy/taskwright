// 右侧栏「材料」页签：材料清单与原文（按需读取 GET …/materials/content）。只读。样式照设计原型：
// 页签行（SidePanel）下面一行写文件名与引用计数（.sw-subh），再下面是原文（.paper）。
//
// 原文里被条目引用的句子画浅蓝底线（按各条目「文档原文」来源的摘录找，见 findExcerpt），点一下打开引用它的条目；
// 条目那边点来源小标签时，这里切到那份材料、滚到那句并高亮（locate）；一段都找不到时在顶部提示两秒。
// 选中一段原文后，底部出现三个动作，都要发给助手：据此新建条目、补到当前条目、就这段提问。
//
// Word 材料（.docx）按原版式分页显示，交给 DocxPaper；它的来源出处带段落号（inputs/x.docx#p37），按段落定位。
// 上传 .docx 时后端生成的投影（x.docx.md；0.2 的任务里是 x.docx.txt）是给助手读的，材料清单里带 derived_from，材料下拉框里不列出。

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Item, Material } from "../../api/types";
import { docxLocator, ownMaterials } from "../../model/docx";
import { DocxPaper } from "./DocxPaper";

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

/** 出处去掉 Word 材料的段落号，剩下的是文件路径。 */
const locatorPath = (locator: string) => docxLocator(locator)?.path ?? locator;
const samePath = (a: string, b: string) => a === b || a.endsWith(b) || b.endsWith(a);

export function MaterialPane({ taskId, materials: all, focusPath, items = [], locate, currentItem, disabled, onOpenItem, onSend }: {
  taskId: string;
  materials: Material[];
  /** 新加进来的材料：变了就选中它显示正文。 */
  focusPath?: string | null;
  items?: Item[];
  locate?: LocateRequest | null;
  /** 条目区当前打开的条目（「补到当前条目」要用）。 */
  currentItem?: string | null;
  disabled?: boolean;
  onOpenItem?: (itemId: string) => void;
  onSend?: (text: string) => void;
}) {
  const materials = useMemo(() => ownMaterials(all), [all]);
  const [path, setPath] = useState<string | null>(materials[0]?.path ?? null);
  const isDocx = !!path && /\.docx$/i.test(path);
  const [docxNote, setDocxNote] = useState<string | null>(null);
  const [docxCited, setDocxCited] = useState<number | null>(null);
  // 正文连同它属于哪份材料一起记：切材料的那一下旧正文还在，不能拿它去找高亮。
  const [doc, setDoc] = useState<{ path: string; text: string } | null>(null);
  const text = doc && doc.path === path ? doc.text : null;
  const [error, setError] = useState<string | null>(null);
  const [hit, setHit] = useState<string | null>(null);
  const [missed, setMissed] = useState(false);
  const [selection, setSelection] = useState("");
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const paper = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!path && materials[0]) setPath(materials[0].path); }, [materials, path]);
  useEffect(() => { if (focusPath) setPath(focusPath); }, [focusPath]);
  useEffect(() => {
    if (!locate) return;
    const target = locatorPath(locate.locator);
    const match = materials.find((m) => samePath(m.path, target));
    if (match) setPath(match.path);
    if (!(match ? /\.docx$/i.test(match.path) : isDocx)) setHit(locate.excerpt);
  }, [locate?.nonce]);
  useEffect(() => { setDocxNote(null); setDocxCited(null); }, [path]);
  useEffect(() => {
    if (!path || /\.docx$/i.test(path)) return;
    setDoc(null);
    api.materialContent(taskId, path).then((r) => { setDoc({ path, text: r.text }); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [taskId, path]);
  // 高亮的几段出现之后滚到第一段，两秒后褪掉；一段都没找到就在顶部提示两秒。
  useEffect(() => {
    if (!hit || text == null) return;
    const el = paper.current?.querySelector("mark.hit");
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    else setMissed(true);
    const t = setTimeout(() => { setHit(null); setMissed(false); }, el ? 2200 : 2000);
    return () => clearTimeout(t);
  }, [hit, text]);

  const name = path?.split("/").pop() ?? "还没有材料";
  const cites = useMemo(() => citationsOf(items, path), [items, path]);
  const segments = useMemo(() => (text == null ? [] : segment(text, cites, hit)), [text, cites, hit]);
  const citedItems = new Set(segments.flatMap((s) => s.items ?? []));

  // 取消选中时收起底部的动作条：在纸面里点一下（选区为空）或在纸面与动作条之外按下鼠标，都算取消；
  // 正在「就这段提问」而且输入框里已经写了字时不收，免得打断输入。
  const keepAsking = useRef(false);
  keepAsking.current = asking && question.trim() !== "";
  const selbar = useRef<HTMLDivElement>(null);
  const dropSelection = () => { if (!keepAsking.current) { setSelection(""); setAsking(false); } };
  useEffect(() => {
    if (!selection) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && (paper.current?.contains(target) || selbar.current?.contains(target))) return;
      dropSelection();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [selection]);
  const onMouseUp = () => {
    const sel = window.getSelection();
    const t = sel ? String(sel).trim() : "";
    if (t.length > 1 && sel?.anchorNode && paper.current?.contains(sel.anchorNode)) { setSelection(t); setAsking(false); }
    else if (selection) dropSelection();
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
      <div className="sw-subh">
        {materials.length > 1 ? (
          <select value={path ?? ""} onChange={(e) => setPath(e.target.value)} data-testid="material-select">
            {materials.map((m) => <option key={m.path} value={m.path}>{m.path.split("/").pop()}</option>)}
          </select>
        ) : <b>{name}</b>}
        <span className="chip">外来 · 只读</span>
        {text != null && <span className="chip">{citedItems.size ? `被 ${citedItems.size} 个条目引用过` : "还没有被条目引用"}</span>}
        {isDocx && docxCited != null && <span className="chip">{docxCited ? `被 ${docxCited} 个条目引用过` : "还没有被条目引用"}</span>}
      </div>
      {isDocx && <div className="hint docx-hint">Word 文件按原版式分页显示。页眉页脚、文本框、脚注尾注里的文字只能看，不能被条目引用；批注不显示，修订按接受后的文字显示。</div>}
      {missed && <div className="busy-note locate-miss" data-testid="locate-miss">没有在材料里找到这段原文</div>}
      {isDocx && docxNote && <div className="busy-note locate-miss" data-testid="locate-note">{docxNote}</div>}
      <div className="doc-wrap">
        <div className="doc-b">
          {!materials.length && <div className="empty">这个任务还没有材料。可以在任务页上传，或者在对话区「附一份材料」。</div>}
          {error && <div className="busy-note">{error}</div>}
          {path && isDocx && (
            <DocxPaper taskId={taskId} path={path} items={items} paperRef={paper} onOpenItem={onOpenItem} onMouseUp={onMouseUp}
              locate={locate && samePath(path, locatorPath(locate.locator)) ? locate : null} onCitedCount={setDocxCited} onNote={setDocxNote} />
          )}
          {path && !isDocx && text == null && !error && <div className="empty">正在读原文。</div>}
          {!isDocx && text != null && (
            <div className="paper" ref={paper} onMouseUp={onMouseUp} data-testid="paper">
              {segments.map((s, i) => s.hit ? <mark key={i} className="hit">{s.text}</mark>
                : s.items ? <span key={i} className="cited" title={`被 ${s.items.join("、")} 引用`} onClick={() => onOpenItem?.(s.items![0])}>{s.text}</span>
                : <span key={i}>{s.text}</span>)}
            </div>
          )}
        </div>
        {selection && onSend && (
          <div className="selbar" ref={selbar} data-testid="selbar">
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

/** 这份材料被哪些条目引用了哪几句：摘录 → 条目编号（按条目当前所在修订的「文档原文」来源，出处对得上这份材料的）。 */
export function citationsOf(items: Item[], path: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!path) return out;
  for (const item of items) {
    for (const s of item.sources) {
      if (s.kind !== "文档原文" || !s.excerpt?.trim()) continue;
      if (!samePath(locatorPath(s.locator), path)) continue;
      const list = out.get(s.excerpt) ?? [];
      if (!list.includes(item.item_id)) list.push(item.item_id);
      out.set(s.excerpt, list);
    }
  }
  return out;
}

/**
 * 摘录在原文里的位置。摘录常把不相邻的几句用空行拼在一起，所以先按空行拆段，逐段找；
 * 某段逐字找不到时退到它的前 12 个字（不足 12 个字的就是整段）。找到几段算几段，一段都没有就是空数组。
 */
export function findExcerpt(text: string, excerpt: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const piece of excerpt.replace(/\r\n/g, "\n").split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean)) {
    let start = text.indexOf(piece);
    let len = piece.length;
    if (start < 0 && piece.length > 12) { start = text.indexOf(piece.slice(0, 12)); len = 12; }
    if (start >= 0) out.push({ start, end: start + len });
  }
  return out;
}

/** 把原文切成几段：要高亮的那几段、被引用的句子、其余，找法都是 findExcerpt。重叠时先到的算。 */
export function segment(text: string, cites: Map<string, string[]>, hit: string | null): Segment[] {
  const ranges: { start: number; end: number; items?: string[]; hit?: boolean }[] = [];
  if (hit) for (const r of findExcerpt(text, hit)) ranges.push({ ...r, hit: true });
  for (const [excerpt, items] of cites) for (const r of findExcerpt(text, excerpt)) ranges.push({ ...r, items });
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
