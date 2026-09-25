// 材料区里的 Word 材料：按原版式分页显示（model/docx.ts），被条目引用的句子画浅蓝底线，点来源时按段落号定位。
//
// 定位的四种结果：段内找到，那几个字蓝底黑框高亮；从出处那一段起跨到后面几段，这几段整段淡黄底标出并提示；
// 找不到，只提示「没有在第 3 页 · 2.3 借阅上限 · 页上附近找到这段原文」，不滚动；表格单元格里的段落与正文一样处理。
// 渲染出来的内容由 docx-preview 直接写进容器，不归 React 管；高亮与底线都是在这些元素上直接包一层，用完拆掉。

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Item } from "../../api/types";
import { charsOf, docxLocator, placeExcerpt, polish, renderDocx, tableOf, whereOf, wrapChars, type DocxTable, type RenderedDocx } from "../../model/docx";
import { useDocx } from "../../state/docxStore";
import type { LocateRequest } from "./MaterialPane";

/** 这份 Word 材料被哪些条目的哪一段引用：[{ 段落号, 摘录, 条目编号 }]（出处对得上这份材料、带段落号的「文档原文」来源）。 */
export function docxCitations(items: Item[], path: string): { n: number; excerpt: string; itemId: string }[] {
  const out: { n: number; excerpt: string; itemId: string }[] = [];
  for (const item of items) {
    for (const s of item.sources) {
      if (s.kind !== "文档原文" || !s.excerpt?.trim()) continue;
      const loc = docxLocator(s.locator);
      if (!loc?.paragraph || !(loc.path === path || path.endsWith(loc.path) || loc.path.endsWith(path))) continue;
      out.push({ n: loc.paragraph, excerpt: s.excerpt, itemId: item.item_id });
    }
  }
  return out;
}

/** 出处没写段落号时（不该有，旧数据兜底），摘录在哪一段里；都没有是 null。 */
function paragraphOf(t: DocxTable, excerpt: string): number | null {
  for (let n = 1; n < t.texts.length; n++) if (placeExcerpt(t.texts, n, excerpt).kind === "in") return n;
  return null;
}

export function DocxPaper({ taskId, path, items, locate, paperRef, onOpenItem, onMouseUp, onCitedCount, onNote }: {
  taskId: string;
  path: string;
  items: Item[];
  /** 只传出处对得上这份材料的定位请求。 */
  locate: LocateRequest | null;
  paperRef?: RefObject<HTMLDivElement | null>;
  onOpenItem?: (itemId: string) => void;
  onMouseUp?: () => void;
  /** 渲染好以后，报告有几个条目的引用在材料里找得到（材料区顶部「被 N 个条目引用过」）。 */
  onCitedCount?: (n: number) => void;
  /** 定位时要在材料区顶部显示的提示（跨段、找不到）；null 表示收起。 */
  onNote?: (text: string | null) => void;
}) {
  const entry = useDocx(taskId, path);
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<{ r: RenderedDocx; t: DocxTable } | null>(null);
  const setNote = (text: string | null) => onNote?.(text);
  const handled = useRef(0);

  useEffect(() => {
    const el = host.current;
    if (!entry?.bytes || !el) return;
    let alive = true;
    setView(null);
    renderDocx(entry.bytes, el).then((r) => {
      if (!alive) return;
      polish(r.root);
      setView({ r, t: tableOf(r) });
    }).catch(() => { if (alive) setNote("这份 Word 文件显示不出来。"); });
    return () => { alive = false; };
  }, [entry?.bytes]);

  const citations = useMemo(() => docxCitations(items, path), [items, path]);

  // 被引用的句子画浅蓝底线，点一下打开引用它的条目；条目变了先拆掉旧的再画。
  useEffect(() => {
    if (!view) return;
    const made: HTMLElement[] = [];
    const cited = new Set<string>();
    for (const c of citations) {
      const place = placeExcerpt(view.t.texts, c.n, c.excerpt);
      if (place.kind === "miss") continue;
      cited.add(c.itemId);
      if (place.kind !== "in") continue;
      // 几个条目引用同一句时只画一层底线，悬停提示里列出全部条目，点一下打开第一个。
      const first = charsOf(view.r.paras[c.n])[place.start]?.node.parentElement?.closest<HTMLElement>(".cited");
      if (first && made.includes(first)) {
        const ids = (first.dataset.items ?? "").split("、");
        if (!ids.includes(c.itemId)) first.dataset.items = [...ids, c.itemId].join("、");
        first.title = `被 ${first.dataset.items} 引用`;
        continue;
      }
      made.push(...wrapChars(view.r.paras[c.n], place.start, place.end, () => {
        const s = document.createElement("span");
        s.className = "cited";
        s.dataset.items = c.itemId;
        s.title = `被 ${c.itemId} 引用`;
        s.onclick = () => onOpenItem?.(c.itemId);
        return s;
      }));
    }
    onCitedCount?.(cited.size);
    return () => { for (const s of made) s.replaceWith(...s.childNodes); };
  }, [view, citations]);

  // 点来源定位。渲染完成之前来的请求，渲染完再处理；同一个请求只处理一次。
  useEffect(() => {
    if (!locate || !view || handled.current === locate.nonce) return;
    handled.current = locate.nonce;
    const { r, t } = view;
    const n = docxLocator(locate.locator)?.paragraph ?? paragraphOf(t, locate.excerpt);
    const place = n ? placeExcerpt(t.texts, n, locate.excerpt) : { kind: "miss" as const };
    let undo = () => {};
    let ms = 3000;
    if (n && place.kind === "in") {
      const marks = wrapChars(r.paras[n], place.start, place.end, () => { const m = document.createElement("mark"); m.className = "hit"; return m; });
      marks[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
      undo = () => { for (const m of marks) m.replaceWith(...m.childNodes); };
      ms = 2200;
      setNote(null);
    } else if (n && place.kind === "span") {
      const ps = r.paras.slice(n, place.last + 1).flat();
      for (const p of ps) p.classList.add("hitpara");
      ps[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
      undo = () => { for (const p of ps) p.classList.remove("hitpara"); };
      ms = 4000;
      setNote("这段引用跨越了多个段落，已整段标出。");
    } else {
      const where = n ? whereOf(t, n) : [];
      setNote(`没有在${where.length ? `${where.join(" · ")}附近` : "材料里"}找到这段原文。`);
    }
    const timer = setTimeout(() => { undo(); setNote(null); }, ms);
    return () => { clearTimeout(timer); undo(); };
  }, [locate?.nonce, view]);

  return (
    <>
      {entry?.status === "loading" && <div className="empty">正在读原文。</div>}
      {entry?.status === "error" && <div className="busy-note">{entry.error}</div>}
      <div className="docx-paper" ref={(el) => { host.current = el; if (paperRef) paperRef.current = el; }} onMouseUp={onMouseUp} data-testid="docx-paper" />
    </>
  );
}
