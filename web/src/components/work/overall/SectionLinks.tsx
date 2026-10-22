// 一节末尾的三块（排在「待澄清事项」与「其他图」之后），没有内容的不画：
//   相关角色与对象 ── 与这一页有关的别的节，分「角色」「业务对象」「相关流程」三行，点一个打开那一节。
//   对应的需求条目 ── 依据这一页写的条目，一条一行：标题、所在的集合、状态词（草稿、评审中 · N 处发现、已确认），点一行打开那个条目。
//   追溯 ── 一行，只写页上别处没有的：来源行里没有显示过的材料与澄清记录（只支持标题、别名、标签之类的来源）。
//           点材料在右边的材料里看第一处原文，点澄清记录换成条目详情的样子看全部来源。图、依据这一页的条目、文档节号
//           在页上已经有了（本节的图、「对应的需求条目」、面包屑里的节号），这里不再写；都没有时这一行不画。
// 这里只画；数由 model/sectionLinks.ts 算。用例图与对象关系图的连线要另取图的文本（useDiagramGraphs.ts）。

import { Fragment, type ReactNode } from "react";
import type { Item } from "../../../api/types";
import { sectionLabel } from "../../../model/chapters";
import { KIND_CLASS, KIND_USE_CASE } from "../../../model/sectionDiagrams";
import { relatedPages, requirementStateText, requirementsOf, traceOf } from "../../../model/sectionLinks";
import type { FigureHost } from "./Figure";
import { useDiagramGraphs } from "./useDiagramGraphs";

const GRAPH_KINDS = [KIND_USE_CASE, KIND_CLASS];

export function SectionLinks({ host, item, onRaw }: {
  host: FigureHost;
  item: Item;
  /** 换成条目详情的样子看这一页（全部来源在那里）。 */
  onRaw: () => void;
}) {
  const { task, contents, onOpen, onOpenItem, onLocate } = host;
  const graphs = useDiagramGraphs(task, GRAPH_KINDS);
  const related = relatedPages(task, contents, item, graphs.map((one) => one.graph));
  const rows: [string, Item[]][] = ([["角色", related.roles], ["业务对象", related.objects], ["相关流程", related.flows]] as [string, Item[]][]).filter(([, pages]) => pages.length > 0);
  const requirements = requirementsOf(task, item);
  const trace = traceOf(task, contents, item);
  const segments: ReactNode[] = [];
  if (trace.materials.length > 0) {
    segments.push(<span data-testid="trace-materials">材料 {trace.materials.map((one, i) => (
      <Fragment key={one.name}>{i > 0 && "、"}
        <span className={onLocate ? "see" : undefined} role={onLocate ? "button" : undefined} title={onLocate ? "在右边的材料里看第一处原文" : undefined}
          onClick={onLocate ? () => onLocate(one.first.excerpt, one.first.locator) : undefined}>{one.name}</span>{one.count > 1 && `（${one.count} 处）`}
      </Fragment>
    ))}</span>);
  }
  if (trace.clarified > 0) {
    segments.push(<span data-testid="trace-clarified"><span className="see" role="button" title="看这一节的全部来源" onClick={onRaw}>澄清记录 {trace.clarified} 条</span></span>);
  }
  return (
    <>
      {rows.length > 0 && (
        <section className="oa-blk" data-testid="topic-related">
          <h3>相关角色与对象</h3>
          <dl className="oa-rel">
            {rows.map(([name, pages]) => (
              <Fragment key={name}>
                <dt>{name}</dt>
                <dd>{pages.map((page) => (
                  <span key={page.item_id} className="oa-chip" role="button" title={page.item_id} onClick={() => onOpen(page.item_id)} data-testid={`related-${page.item_id}`}>{sectionLabel(contents, page)}</span>
                ))}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      )}
      {requirements.length > 0 && (
        <section className="oa-blk" data-testid="topic-requirements">
          <h3>对应的需求条目 <small>依据这一节写的条目</small></h3>
          <ul className="oa-reqs">
            {requirements.map(({ item: one, state }) => (
              <li key={one.item_id} role="button" title={one.item_id} onClick={() => onOpenItem?.(one.item_id)} data-testid={`requirement-${one.item_id}`}>
                <span className="n">{one.title || one.item_id}</span>
                <span className="c">{one.collection}</span>
                <span className={`s ${state.kind}`}>{requirementStateText(state)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {segments.length > 0 && (
        <div className="oa-trace" data-testid="topic-trace">
          <span className="k">追溯</span>
          {segments.map((segment, i) => <Fragment key={i}>{i > 0 && <i>›</i>}{segment}</Fragment>)}
        </div>
      )}
    </>
  );
}
