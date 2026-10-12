// 业务说明的目录：七章固定，每章下面是归到它的各节（一页主题一节），一节一行。
// 章标题可以点：有章首页的章（第 3 章之外的六章）点了打开章首页；第 3 章点了收起或展开它的各节。还没有内容的章灰着。
// 每行是状态点（说清了、有助手补的待核实、还有没定的）与节的标题，章内下级的节往里缩；点一行打开那一节，当前的一节反色；
// 已废弃的页划掉。第 4 章最后一行是「术语表」。没有贴标签的页列在最后的「未归类」下面，灰着。
// 底下是状态点的图例与一行汇总（几节、几条需求条目、几处待澄清）。这里只管画，数都由 model/chapters.ts 与 model/overall.ts 算。

import { useState } from "react";
import type { Task } from "../../../api/types";
import { CHAPTER_DECISIONS, CHAPTER_FLOWS, CHAPTER_OBJECTS, CHAPTER_RULES, GLOSSARY_NAME, UNSORTED_NAME, type Toc, tocTotals } from "../../../model/chapters";
import { STATE_TEXT, isDeprecated, titleOf, topicState, type TopicState } from "../../../model/overall";

/** 中栏右边现在显示的不是某一节时，显示的是哪一样：某一章的章首页，或者术语表。 */
export type HeadView = { kind: "chapter"; no: number } | { kind: "glossary" };

const LEGEND: TopicState[] = ["settled", "pending", "open"];

export function Contents({ task, contents, current, head, onOpen, onHead, onRetell, retellOff }: {
  task: Task;
  contents: Toc;
  /** 打开着的那一节（页的编号）；没有打开节时是 null。 */
  current: string | null;
  /** 打开着的章首页或术语表；打开着某一节、或者什么都没有打开时是 null。 */
  head: HeadView | null;
  onOpen: (itemId: string) => void;
  onHead: (view: HeadView) => void;
  /** 「复述一遍」：请助手把现在的理解讲成一段故事；不给就不画这个按钮。 */
  onRetell?: () => void;
  /** 现在不能发给助手的原因（任务结束、助手正在工作）；能发时不给。 */
  retellOff?: string;
}) {
  // 第 3 章的各节收起了没有。缺省展开。
  const [flowsFolded, setFlowsFolded] = useState(false);
  const sum = tocTotals(task, contents);
  const views = task.overall_views ?? null;
  const pageCount = contents.chapters.reduce((n, one) => n + one.sections.length, 0) + contents.unsorted.length;
  /** 这一章现在有没有内容：有节，或者（没有自己的页的两章）算出来的表里有行。 */
  const filled = (no: number, sections: number): boolean =>
    sections > 0 || (no === CHAPTER_RULES && (views?.rules.rows.length ?? 0) > 0) || (no === CHAPTER_DECISIONS && (views?.decisions.length ?? 0) > 0);

  const row = (item: Toc["unsorted"][number], depth: number, no: string | null, dim = false) => {
    const state = topicState(task, item);
    const on = item.item_id === current;
    return (
      <div key={item.item_id} className={`oa-row${on ? " cur" : ""}${isDeprecated(item) ? " gone" : ""}${dim ? " dim" : ""}`} role="button" tabIndex={0}
        style={depth > 0 ? { marginLeft: `${depth * 0.9}rem` } : undefined}
        title={`${no ? `${no} ` : ""}${titleOf(item)}：${STATE_TEXT[state]}`} aria-current={on ? "true" : undefined}
        onClick={() => onOpen(item.item_id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(item.item_id); }} data-testid={`toc-${item.item_id}`}>
        <span className={`oa-dot ${state}`} data-state={state} />
        <span className="oa-name">{titleOf(item)}</span>
      </div>
    );
  };

  return (
    <div className="oa-outline-body" data-testid="toc">
      {pageCount === 0 && <div className="oa-none">还没有内容。把这件事讲给助手听，它会把说到的角色、流程与业务对象一节一节立起来。</div>}
      <div className="oa-toc">
        {contents.chapters.map(({ chapter, sections, glossaryNo }) => {
          const folds = chapter.no === CHAPTER_FLOWS;
          const on = head?.kind === "chapter" && head.no === chapter.no;
          const closed = folds && flowsFolded;
          return (
            <div key={chapter.no} className="oa-chap">
              <div className={`oa-ch${on ? " cur" : ""}${filled(chapter.no, sections.length) ? "" : " dim"}`} role="button" tabIndex={0}
                title={folds ? (closed ? "展开这一章的各节" : "收起这一章的各节") : `打开第 ${chapter.no} 章的章首`}
                aria-expanded={folds ? !closed : undefined} aria-current={on ? "true" : undefined} data-testid={`toc-chapter-${chapter.no}`}
                onClick={() => (folds ? setFlowsFolded(!closed) : onHead({ kind: "chapter", no: chapter.no }))}
                onKeyDown={(e) => { if (e.key === "Enter") { if (folds) setFlowsFolded(!closed); else onHead({ kind: "chapter", no: chapter.no }); } }}>
                <span className="no">{chapter.no}</span><span className="oa-name">{chapter.name}</span>
                {folds && sections.length > 0 && <span className="oa-caret" aria-hidden="true">{closed ? "▸" : "▾"}</span>}
              </div>
              {!closed && sections.map((one) => row(one.item, one.depth, one.no))}
              {chapter.no === CHAPTER_OBJECTS && glossaryNo && (
                <div className={`oa-row${head?.kind === "glossary" ? " cur" : ""}`} role="button" tabIndex={0} title={`${glossaryNo} ${GLOSSARY_NAME}`}
                  aria-current={head?.kind === "glossary" ? "true" : undefined} data-testid="toc-glossary"
                  onClick={() => onHead({ kind: "glossary" })} onKeyDown={(e) => { if (e.key === "Enter") onHead({ kind: "glossary" }); }}>
                  <span className="oa-dot none" /><span className="oa-name">{GLOSSARY_NAME}</span>
                </div>
              )}
            </div>
          );
        })}
        {contents.unsorted.length > 0 && (
          <div className="oa-chap" data-testid="toc-unsorted">
            <div className="oa-ch dim plain" title="这几页还没有贴标签，贴上之后会排进相应的章"><span className="no" /><span className="oa-name">{UNSORTED_NAME}</span></div>
            {contents.unsorted.map((item) => row(item, 0, null, true))}
          </div>
        )}
      </div>
      <div className="oa-legend">
        {LEGEND.map((state) => <span key={state}><i className={`oa-dot ${state}`} />{STATE_TEXT[state]}</span>)}
      </div>
      <div className="oa-foot" data-testid="toc-totals">
        说明共 <b>{sum.sections}</b> 节 · <b>{sum.items}</b> 条需求条目 · <b>{sum.open}</b> 处待澄清
      </div>
      {onRetell && pageCount > 0 && (
        <button type="button" className="aibtn oa-retell" disabled={!!retellOff}
          title={retellOff ?? (current ? "请助手把对打开着的这一节及其下面各节的理解讲成一段故事" : "请助手把对各节的理解讲成一段故事")}
          onClick={onRetell} data-testid="toc-retell">复述一遍</button>
      )}
    </div>
  );
}
