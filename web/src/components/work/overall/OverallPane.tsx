// 条目区停在「业务说明」页签（总体分析这个集合）时的主体：左边是目录，右边是一节，或者一章的章首页。
// 目录可以收成一条竖着的把手（做法与右侧栏相同：点把手展开、点「收起」收起）。条目区很窄时（样式里按条目区的宽度判断，
// 阈值 48rem）目录缺省收着，点把手后盖在右边的内容上面，点了一节或一章就自己收起。
// 还没有点任何一节时，右边是这个集合的一句说明与总计；不替用户打开第一节。
// 目录里点章标题打开那一章的章首页（ChapterHead.tsx），点第 4 章末尾的「术语表」打开术语表（Glossary.tsx）；点一节就回到节。
// 有哪一节都放不进的图时，目录末尾多一行「未归入节的图」，点它把这几张图一张一张画在右边（Figure.tsx）。

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Task } from "../../../api/types";
import { writeOffReason } from "../../../model/items";
import { overallDef, retellText, titleOf, totals } from "../../../model/overall";
import { CHAPTER_DECISIONS, CHAPTER_FLOWS, CHAPTER_GOALS, CHAPTER_OBJECTS, CHAPTER_OVERVIEW, CHAPTER_ROLES, CHAPTER_RULES } from "../../../model/chapters";
import { requirementsOf } from "../../../model/sectionLinks";
import { USE_CASE_COLLECTION } from "../../../../../agent/src/lib/stage";
import { DecisionsBlocks, GoalsBlocks, ObjectsBlocks, OverviewBlocks, RolesBlocks, RulesBlocks } from "./ChapterBlocks";
import { looseDiagrams } from "../../../model/sectionDiagrams";
import { type FigureHost, LooseFigures } from "./Figure";
import { ChapterHead } from "./ChapterHead";
import { Contents, type HeadView } from "./Contents";
import { Glossary } from "./Glossary";

/** 目录展开没有：auto 是没有动过，够宽就展开、窄就收着；open 与 closed 是用户点出来的。 */
type OutlineShown = "auto" | "open" | "closed";

export function OverallPane({ task, host, selected, onSelect, page, readOnly = false, writesOff = false, onSend, headRequest = null }: {
  /** 条目区要右边换成哪一章的章首页、术语表或者「未归入节的图」（null 是首页）；seq 每次加一。 */
  headRequest?: { view: HeadView | null; seq: number } | null;
  /** 画图要的那几样（目录也在里面）。 */
  host: FigureHost;
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
  const [head, setHead] = useState<HeadView | null>(null);
  useEffect(() => { if (headRequest) setHead(headRequest.view); }, [headRequest?.seq]);
  const contents = host.contents;
  const loose = looseDiagrams(task, contents).length;
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
  // 点了一节：用户点开的目录回到「没有动过」，窄的时候它就自己收起，宽的时候照样留着。
  const open = (itemId: string) => { if (shown === "open") setShown("auto"); setHead(null); onSelect(itemId); };
  // 点了章标题或术语表：不再停在哪一节上，右边换成章首页或术语表。
  const openHead = (view: HeadView) => { if (shown === "open") setShown("auto"); onSelect(null); setHead(view); };
  /** 第 3 章章首页上每一节标题后面的那句：依据这一节（或者画在这一节里的图）写的功能用例有几条；一条都没有不写。 */
  const useCaseNote = (itemId: string): string => {
    const page = task.items.find((one) => one.item_id === itemId);
    const count = page ? requirementsOf(task, page).filter((one) => one.item.collection === USE_CASE_COLLECTION).length : 0;
    return count > 0 ? `${count} 条用例` : "";
  };
  /** 章首页那一行小字。 */
  const chapterLead = (no: number): string => {
    const sections = contents.chapters.find((one) => one.chapter.no === no)!.sections.filter((one) => one.no !== null).length;
    if (no === CHAPTER_RULES) return `${task.overall_views?.rules.rows.length ?? 0} 条，自各节「适用规则」汇总`;
    if (no === CHAPTER_DECISIONS) return `${task.overall_views?.decisions.length ?? 0} 项，自各节的决定与待澄清事项汇总`;
    if (no === CHAPTER_GOALS) return `${sections} 节`;
    return `${sections} 节`;
  };

  return (
    <div className={`oa-pane ${shown}`} data-testid="overall-pane">
      <div className="oa-handle" role="button" title="展开目录" onClick={toggle} data-testid="toc-handle"><span className="harrow">▸</span><span>目录</span></div>
      <aside className="oa-outline" ref={side}>
        <div className="oa-outline-h">
          <span className="oa-seg"><a className="on">目录</a></span>
          <span className="btn sm" role="button" onClick={toggle} data-testid="toc-collapse">⇤ 收起</span>
        </div>
        <Contents task={task} contents={contents} current={selected} head={page ? null : head} onOpen={open} onHead={openHead} onRetell={retell} retellOff={retellOff} looseCount={loose} />
      </aside>
      <div className="oa-main" data-testid="overall-main">
        {page ?? (head?.kind === "glossary" ? <Glossary task={task} onOpen={open} />
          : head?.kind === "loose" ? <LooseFigures host={host} />
          : head?.kind === "chapter" ? (
            <ChapterHead task={task} contents={contents} chapterNo={head.no} lead={chapterLead(head.no)} onOpen={open} full={head.no === CHAPTER_OVERVIEW}
              sectionNote={head.no === CHAPTER_FLOWS ? useCaseNote : undefined}>
              {head.no === CHAPTER_OVERVIEW && <OverviewBlocks host={host} onChapter={(no) => openHead({ kind: "chapter", no })} />}
              {head.no === CHAPTER_ROLES && <RolesBlocks host={host} />}
              {head.no === CHAPTER_OBJECTS && <ObjectsBlocks host={host} />}
              {head.no === CHAPTER_RULES && <RulesBlocks host={host} />}
              {head.no === CHAPTER_GOALS && <GoalsBlocks host={host} />}
              {head.no === CHAPTER_DECISIONS && <DecisionsBlocks host={host} />}
            </ChapterHead>
          )
          : (
          <div className="oa-intro" data-testid="overall-intro">
            <p className="oa-intro-note">{def?.display?.note ?? "按章整理的业务说明。"}</p>
            <p className="oa-intro-sum">现在有 {sum.pages} 节，{sum.settled} 条已经定下，{sum.open} 条还没定，{sum.pending} 处是助手补的、等你核实。</p>
            {sum.pages === 0 && task.stage ? (
              <p className="oa-intro-hint" data-testid="overall-empty">业务说明还没有内容。核读材料、澄清这两项活动把内容写进来：要从头编制，请在任务起点启动需求分析。</p>
            ) : (
              <p className="oa-intro-hint">在左边的目录里点一节，看它的说明、适用规则、待澄清事项与对应的需求条目；点章标题看这一章的章首。</p>
            )}
            {retell && sum.pages > 0 && (
              <p><button type="button" className="aibtn" disabled={!!retellOff} title={retellOff ?? "请助手把对各节的理解讲成一段故事，请核对这段复述"}
                onClick={retell} data-testid="intro-retell">复述一遍</button></p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
