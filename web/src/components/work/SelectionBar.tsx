// 材料区里选中一段原文之后浮在选区上方的动作条：一条圆角横条，一排按钮（上面线条图标、下面小字，中间细分隔线），
// 据此新建条目、补到当前条目（没有打开条目时不显示）、就这段提问。三件都是往对话里发一句话交给助手，要等它做完，
// 这句说明写在各按钮的鼠标悬停提示里。点「就这段提问」横条变成输入框，带「发送」与「取消」。
//
// 位置：对着选区第一行选中部分的中间，放在第一行上方；上方放不下（选区靠近材料区顶部）时放到选区下方。
// 横条不超出材料区的左右边界，超出时往里收。材料区滚动、窗口改变大小、换字号时跟着选区走；选区整个滚出可见范围时横条藏起来，
// 滚回来再出现。输入框拿到焦点后浏览器的选区会消失，提问时在原文上画一层浅蓝底，让用户看得见问的是哪段。
// 横条在页面结构上紧跟原文之后，选中之后按 Tab 键先走到这几个按钮上。

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react";

export type SelectionAction = "create" | "attach" | "ask";

/** 三个按钮的悬停提示：都写明要发给助手、它做完要等一会儿；「补到当前条目」写明补到哪个条目。 */
export const SELECTION_HINTS = {
  create: "把这段原文发给助手，请它据此新建条目。它做完要等一会儿。",
  attach: (id: string, title: string) => `把这段原文发给助手，请它补到 ${id}${title ? ` ${title}` : ""}。它做完要等一会儿。`,
  ask: "写下问题，连同这段原文发给助手。它做完要等一会儿。",
};

type Mark = { left: number; top: number; width: number; height: number };
const sameMarks = (a: Mark[], b: Mark[]) => a.length === b.length && a.every((m, i) =>
  m.left === b[i].left && m.top === b[i].top && m.width === b[i].width && m.height === b[i].height);

type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">;

/**
 * 横条的位置（相对 wrap 的左上角，像素）：lines 是选区各行的矩形，wrap 是定位所相对的容器（也是左右边界），view 是原文的可见范围，
 * bar 是横条的宽高，rem 是根字号。第一行上方放得下（不越过可见范围的顶边）就放在第一行上方，否则放到选区最后一行的下方；
 * 左右对着第一行选中部分的中间，超出容器左右边界时往里收。选区整个在可见范围之外时 out 为真。
 */
export function barPosition(lines: Box[], wrap: Box, view: Box, bar: { width: number; height: number }, rem: number): { top: number; left: number; out: boolean } {
  const first = lines[0];
  const last = lines[lines.length - 1];
  const gap = 0.4 * rem;
  const edge = 0.3 * rem;
  const out = last.bottom < view.top || first.top > view.bottom;
  const top = first.top - bar.height - gap >= view.top ? first.top - wrap.top - bar.height - gap : last.bottom - wrap.top + gap;
  const center = first.left + first.width / 2 - wrap.left - bar.width / 2;
  const left = Math.max(edge, Math.min(center, wrap.width - bar.width - edge));
  return { top, left, out };
}

export function SelectionBar({ range, containerRef, viewRef, barRef, current, disabled, asking, question, onQuestion, onAct, onSendQuestion, onCancelAsk }: {
  /** 选中的那段原文的范围；jsdom 等拿不到范围时为 null，横条照样出现，只是不定位。 */
  range: Range | null;
  /** 横条定位所相对的容器（position: relative），也是左右边界。 */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 原文滚动的那一层：可见范围以它为准。 */
  viewRef: RefObject<HTMLDivElement | null>;
  barRef: RefObject<HTMLDivElement | null>;
  /** 条目区当前打开的条目；没有时不显示「补到当前条目」。 */
  current: { id: string; title: string } | null;
  disabled?: boolean;
  asking: boolean;
  question: string;
  onQuestion: (text: string) => void;
  onAct: (kind: SelectionAction) => void;
  onSendQuestion: () => void;
  onCancelAsk: () => void;
}) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const askingRef = useRef(asking);
  askingRef.current = asking;

  const place = useCallback(() => {
    const bar = barRef.current;
    const box = containerRef.current;
    const view = viewRef.current;
    if (!bar || !box || !view || !range || typeof range.getClientRects !== "function") return;
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) return;
    const wrap = box.getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const { top, left, out } = barPosition(rects, wrap, view.getBoundingClientRect(), { width: bar.offsetWidth, height: bar.offsetHeight }, rem);
    bar.style.visibility = out ? "hidden" : "";
    bar.style.top = `${top}px`;
    bar.style.left = `${left}px`;
    const next = askingRef.current && !out
      ? rects.map((r) => ({ left: r.left - wrap.left, top: r.top - wrap.top, width: r.width, height: r.height }))
      : [];
    // 每次画完都会定位一次：底色的位置没变时不更新，免得来回重画。
    setMarks((prev) => (sameMarks(prev, next) ? prev : next));
  }, [range, barRef, containerRef, viewRef]);

  // 每次画完（换了选区、切到提问、条目变了按钮数变了）重新定位；滚动（捕获阶段，原文里任何一层滚动都算）与改大小时也定位。
  useLayoutEffect(() => { place(); });
  useEffect(() => {
    const box = containerRef.current;
    box?.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    window.addEventListener("taskwright:font-tier", place);
    return () => {
      box?.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("taskwright:font-tier", place);
    };
  }, [place, containerRef]);

  // 按钮上按下鼠标不抢走原文里的选区（输入框除外，要能点进去打字）。
  const keepSelection = (e: MouseEvent) => { if ((e.target as HTMLElement).tagName !== "INPUT") e.preventDefault(); };

  return (
    <>
      {marks.map((m, i) => <div key={i} className="sel-mark" style={{ left: m.left, top: m.top, width: m.width, height: m.height }} />)}
      <div className="fbar" ref={barRef} role="toolbar" aria-label="对选中的这段原文" onMouseDown={keepSelection} data-testid="selbar">
        {asking ? (
          <div className="fask">
            <span className="ql"><AskIcon />就这段提问</span>
            <input autoFocus placeholder="想问这段原文什么？" aria-label="想问这段原文什么" value={question} onChange={(e) => onQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onSendQuestion(); }} data-testid="selection-question" />
            <button type="button" className="btn sm pri" disabled={!question.trim() || disabled} onClick={onSendQuestion}>发送</button>
            <button type="button" className="btn sm" onClick={onCancelAsk}>取消</button>
          </div>
        ) : (
          <>
            <button type="button" className="fbtn" disabled={disabled} title={SELECTION_HINTS.create} onClick={() => onAct("create")}>
              <CreateIcon /><span>据此新建条目</span>
            </button>
            {current && (
              <>
                <span className="fsep" />
                <button type="button" className="fbtn" disabled={disabled} title={SELECTION_HINTS.attach(current.id, current.title)}
                  onClick={() => onAct("attach")}>
                  <AttachIcon /><span>补到当前条目</span>
                </button>
              </>
            )}
            <span className="fsep" />
            <button type="button" className="fbtn" disabled={disabled} title={SELECTION_HINTS.ask} onClick={() => onAct("ask")}>
              <AskIcon /><span>就这段提问</span>
            </button>
          </>
        )}
      </div>
    </>
  );
}

/** 线条图标：一页纸加一个加号。 */
function CreateIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M12 11v6M9 14h6" />
    </svg>
  );
}

/** 线条图标：一张卡片右下角添一笔。 */
function AttachIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M8 9h8M8 13h4" /><path d="M15 13.5v5M12.5 16h5" />
    </svg>
  );
}

/** 线条图标：对话气泡里一个问号。 */
function AskIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z" />
      <path d="M10 8.6a2 2 0 1 1 2.8 1.8c-.5.25-.8.6-.8 1.1v.4" /><path d="M12 13.9v.1" />
    </svg>
  );
}
