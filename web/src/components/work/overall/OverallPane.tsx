// 条目区停在「总体分析」页签时的主体：左边是提纲，右边是一页主题。
// 提纲可以收成一条竖着的把手（做法与右侧栏相同：点把手展开、点「收起」收起）。条目区很窄时（样式里按条目区的宽度判断，
// 阈值 48rem）提纲缺省收着，点把手后盖在主题页上面，点了一个主题就自己收起。
// 还没有点任何主题时，右边是这个集合的一句说明与总计；不替用户打开第一页。
// 提纲一栏顶上有「提纲」「术语表」两个切换：切到术语表时右边换成术语表（Glossary.tsx），点里面的一行或者提纲里的一行就回到主题页。

import { useRef, useState, type ReactNode } from "react";
import type { Task } from "../../../api/types";
import { writeOffReason } from "../../../model/items";
import { overallDef, retellText, titleOf, totals } from "../../../model/overall";
import { Outline } from "./Outline";
import { Glossary } from "./Glossary";

/** 提纲展开没有：auto 是没有动过，够宽就展开、窄就收着；open 与 closed 是用户点出来的。 */
type OutlineShown = "auto" | "open" | "closed";

export function OverallPane({ task, selected, onSelect, page, readOnly = false, writesOff = false, onSend }: {
  readOnly?: boolean;
  writesOff?: boolean;
  /** 把一句话发给助手（「复述一遍」用）。 */
  onSend?: (text: string) => void;
  task: Task;
  /** 打开着的那一页的编号；没有打开时是 null。 */
  selected: string | null;
  onSelect: (itemId: string | null) => void;
  /** 打开着的那一页画成什么（由条目区交进来）；没有打开时不给。 */
  page: ReactNode;
}) {
  const [shown, setShown] = useState<OutlineShown>("auto");
  const [view, setView] = useState<"outline" | "glossary">("outline");
  const side = useRef<HTMLDivElement>(null);
  const def = overallDef(task);
  const sum = totals(task);
  // 复述一遍：打开着一页就讲它与它下面的主题，没有打开就讲整个总体分析。
  const current = task.items.find((i) => i.item_id === selected) ?? null;
  const retell = onSend ? () => onSend(retellText(current ? titleOf(current) : null)) : undefined;
  const retellOff = writeOffReason(task, { readOnly, writesOff });
  // 展开或收起。用户点过之后就在展开与收起之间来回；还没有动过时它看不看得见由样式按宽度定，先量一下再反过来。
  const toggle = () => {
    const visible = shown === "auto" ? !!side.current && getComputedStyle(side.current).display !== "none" : shown === "open";
    setShown(visible ? "closed" : "open");
  };
  // 点了一个主题：用户点开的提纲回到「没有动过」，窄的时候它就自己收起，宽的时候照样留着。
  const open = (itemId: string) => { if (shown === "open") setShown("auto"); setView("outline"); onSelect(itemId); };

  return (
    <div className={`oa-pane ${shown}`} data-testid="overall-pane">
      <div className="oa-handle" role="button" title="展开提纲" onClick={toggle} data-testid="outline-handle"><span className="harrow">▸</span><span>提纲</span></div>
      <aside className="oa-outline" ref={side}>
        <div className="oa-outline-h">
          <span className="oa-seg" role="tablist">
            <a role="tab" className={view === "outline" ? "on" : ""} aria-selected={view === "outline"} onClick={() => setView("outline")} data-testid="view-outline">提纲</a>
            <a role="tab" className={view === "glossary" ? "on" : ""} aria-selected={view === "glossary"} onClick={() => setView("glossary")} data-testid="view-glossary">术语表</a>
          </span>
          <span className="btn sm" role="button" onClick={toggle} data-testid="outline-collapse">⇤ 收起</span>
        </div>
        <Outline task={task} current={selected} onOpen={open} onRetell={retell} retellOff={retellOff} />
      </aside>
      <div className="oa-main" data-testid="overall-main">
        {view === "glossary" ? <Glossary task={task} onOpen={open} /> : page ?? (
          <div className="oa-intro" data-testid="overall-intro">
            <p className="oa-intro-note">{def?.display?.note ?? "用这件事自己的话写下的主题。"}</p>
            <p className="oa-intro-sum">现在有 {sum.pages} 个主题，{sum.settled} 条已经定下，{sum.open} 条还没定，{sum.pending} 处是助手补的、等你核实。</p>
            <p className="oa-intro-hint">在左边的提纲里点一个主题，看它是什么、有哪些例子、定下了什么、还有什么没定。</p>
            {retell && sum.pages > 0 && (
              <p><button type="button" className="aibtn" disabled={!!retellOff} title={retellOff ?? "请助手把对各个主题的理解讲成一段故事，你看哪里不对"}
                onClick={retell} data-testid="intro-retell">复述一遍</button></p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
