// 条目区停在「业务说明」页签（总体分析这个集合）时的主体：左边是目录，右边是一节，或者一章的章首页。
// 目录可以收成一条竖着的把手（做法与右侧栏相同：点把手展开、点「收起」收起）。条目区很窄时（样式里按条目区的宽度判断，
// 阈值 48rem）目录缺省收着，点把手后盖在右边的内容上面，点了一节或一章就自己收起。
// 还没有点任何一节时，右边是这个集合的一句说明与总计；不替用户打开第一节。
// 目录里点章标题打开那一章的章首页（ChapterHead.tsx），点第 4 章末尾的「术语表」打开术语表（Glossary.tsx）；点一节就回到节。
// 有哪一节都放不进的图时，目录末尾多一行「未归入节的图」，点它把这几张图一张一张画在右边（Figure.tsx）。

import { useRef, useState, type ReactNode } from "react";
import type { Task } from "../../../api/types";
import { writeOffReason } from "../../../model/items";
import { overallDef, retellText, titleOf, totals } from "../../../model/overall";
import { NO_MATERIALS_TEXT, STAGE_STARTS, type StageStart } from "../../../model/stage";
import { CHAPTER_DECISIONS, CHAPTER_GOALS, CHAPTER_OBJECTS, CHAPTER_OVERVIEW, CHAPTER_ROLES, CHAPTER_RULES } from "../../../model/chapters";
import { DecisionsBlocks, GoalsBlocks, ObjectsBlocks, OverviewBlocks, RolesBlocks, RulesBlocks } from "./ChapterBlocks";
import { looseDiagrams } from "../../../model/sectionDiagrams";
import { type FigureHost, LooseFigures } from "./Figure";
import { ChapterHead } from "./ChapterHead";
import { Contents, type HeadView } from "./Contents";
import { Glossary } from "./Glossary";

/** 目录展开没有：auto 是没有动过，够宽就展开、窄就收着；open 与 closed 是用户点出来的。 */
type OutlineShown = "auto" | "open" | "closed";

export function OverallPane({ task, host, selected, onSelect, page, readOnly = false, writesOff = false, onSend, onStart, materialCount = 0 }: {
  /** 画图要的那几样（目录也在里面）。 */
  host: FigureHost;
  readOnly?: boolean;
  writesOff?: boolean;
  /**
   * 还没有一页主题时的两个开头（「通读材料起草」「逐项澄清」）：先把任务移到那个阶段，再替用户发那句固定的话。
   * 不给时不显示这两个按钮（任务没有阶段时）。
   */
  onStart?: (start: StageStart) => void;
  /** 任务现在有几份材料（不算由别的材料生成的）；一份都没有时「通读材料起草」不可用。 */
  materialCount?: number;
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
            <ChapterHead task={task} contents={contents} chapterNo={head.no} lead={chapterLead(head.no)} onOpen={open} full={head.no === CHAPTER_OVERVIEW}>
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
            <p className="oa-intro-note">{def?.display?.note ?? "用这件事自己的话写下的主题。"}</p>
            <p className="oa-intro-sum">现在有 {sum.pages} 节，{sum.settled} 条已经定下，{sum.open} 条还没定，{sum.pending} 处是助手补的、等你核实。</p>
            {sum.pages === 0 && onStart && task.stage ? (
              <div className="oa-start" data-testid="overall-start">
                <p className="oa-intro-hint">业务说明还没有内容。可以让助手先通读材料、把材料里已经写明的角色、流程与业务对象各立一节，也可以直接从逐项澄清开始。</p>
                <p className="oa-start-acts">
                  <button type="button" className="btn pri" disabled={!!retellOff || materialCount === 0} title={retellOff ?? (materialCount === 0 ? NO_MATERIALS_TEXT : undefined)}
                    onClick={() => onStart(STAGE_STARTS.reading)} data-testid="start-reading">{STAGE_STARTS.reading.label}</button>
                  <button type="button" className="btn" disabled={!!retellOff} title={retellOff}
                    onClick={() => onStart(STAGE_STARTS.clarifying)} data-testid="start-clarifying">{STAGE_STARTS.clarifying.label}</button>
                </p>
              </div>
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
