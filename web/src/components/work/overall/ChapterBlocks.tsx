// 各章章首页上自己的那几块（画在各节的摘要之前，由 OverallPane.tsx 交给 ChapterHead.tsx）：
//   第 1 章 概述与范围 ── 系统边界图；业务目标摘要（目标树的前两层，点一个目标打开那一节，「看全部」去第 6 章）。
//   第 2 章 角色 ── 角色与用例对照表（列是角色，行是用例，格子是连线上写的字，末列是所属流程），表下写它依据哪一张用例图，
//                  「查看用例图」展开那张图。
// 这里只画；数由 model/chapterHeads.ts 与 model/sectionDiagrams.ts 算。

import { useState } from "react";
import { CHAPTER_GOALS, sectionLabel } from "../../../model/chapters";
import { goalSummary, useCaseTable } from "../../../model/chapterHeads";
import { revisionText } from "../../../model/diagrams";
import { isOverall, titleOf } from "../../../model/overall";
import { KIND_CONTEXT, KIND_USE_CASE, diagramsOfKind } from "../../../model/sectionDiagrams";
import { Figure, type FigureHost } from "./Figure";
import { useDiagramGraphs } from "./useDiagramGraphs";

/** 第 1 章：系统边界图与业务目标摘要。 */
export function OverviewBlocks({ host, onChapter }: { host: FigureHost; onChapter: (no: number) => void }) {
  const { task, onOpen } = host;
  const context = diagramsOfKind(task, KIND_CONTEXT);
  const goals = goalSummary(task.overall_views?.goals);
  return (
    <>
      {context.length > 0 && (
        <section className="oa-blk" data-testid="chapter-context">
          <h3>系统边界</h3>
          <Figure host={host} rows={context} />
        </section>
      )}
      {goals.length > 0 && (
        <section className="oa-blk" data-testid="chapter-goals-summary">
          <h3>业务目标 <small><span className="oa-sec-link" role="button" onClick={() => onChapter(CHAPTER_GOALS)} data-testid="goals-all">看全部，在第 {CHAPTER_GOALS} 章</span></small></h3>
          <ul className="oa-goals">
            {goals.map((root) => (
              <li key={root.item_id}>
                <span className="oa-sec-link" role="button" title={root.item_id} onClick={() => onOpen(root.item_id)}>{root.title}</span>
                {root.goals.length > 0 && (
                  <ul>{root.goals.map((one) => (
                    <li key={one.item_id}><span className="oa-sec-link" role="button" title={one.item_id} onClick={() => onOpen(one.item_id)}>{one.title}</span></li>
                  ))}</ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

const USE_CASE_KINDS = [KIND_USE_CASE];

/** 第 2 章：角色与用例对照表。 */
export function RolesBlocks({ host }: { host: FigureHost }) {
  const { task, contents, onOpen, onOpenItem } = host;
  const diagrams = diagramsOfKind(task, KIND_USE_CASE);
  const graphs = useDiagramGraphs(task, USE_CASE_KINDS);
  const table = useCaseTable(task, contents, graphs.map((one) => one.graph));
  const [figureOpen, setFigureOpen] = useState(false);
  if (diagrams.length === 0) return null;
  const open = (itemId: string, overall: boolean) => (overall ? onOpen(itemId) : onOpenItem?.(itemId));
  return (
    <section className="oa-blk" data-testid="chapter-usecases">
      <h3>角色与用例对照</h3>
      {table.rows.length === 0 ? (
        <p className="oa-empty" data-testid="usecases-empty">{graphs.length === 0 ? "正在读用例图。" : "用例图里还没有画出角色与用例之间的连线。"}</p>
      ) : (
        <div className="oa-tablebox">
          <table className="oa-table oa-matrix" data-testid="usecases-table">
            <thead>
              <tr>
                <th>用例</th>
                {table.roles.map((role) => (
                  <th key={role.item_id}><span className="oa-sec-link" role="button" title={role.item_id} onClick={() => onOpen(role.item_id)}>{titleOf(role)}</span></th>
                ))}
                <th>所属流程</th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={row.item?.item_id ?? `row-${i}`} data-testid={`usecase-row-${i}`}>
                  <td className="n">{row.item
                    ? <span className="oa-sec-link" role="button" title={row.item.item_id} onClick={() => open(row.item!.item_id, isOverall(row.item!.collection))}>{row.label}</span>
                    : row.label}</td>
                  {row.cells.map((cell, k) => <td key={k} className={cell ? "hit" : "none"}>{cell || "—"}</td>)}
                  <td>{row.flows.length === 0 ? "—" : row.flows.map((flow, k) => (
                    <span key={flow.item_id}>{k > 0 && "、"}<span className="oa-sec-link" role="button" title={flow.item_id} onClick={() => onOpen(flow.item_id)}>{sectionLabel(contents, flow)}</span></span>
                  ))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="oa-tablefoot" data-testid="usecases-basis">
        依据：{diagrams.map((row, i) => <span key={row.diagram_id} title={row.diagram_id}>{i > 0 && "、"}用例图「{row.name}」（{revisionText(row)}）</span>)}
        <button type="button" className="linkbtn" onClick={() => setFigureOpen(!figureOpen)} data-testid="usecases-figure-toggle">{figureOpen ? "收起用例图" : "查看用例图"}</button>
      </div>
      {figureOpen && <Figure host={host} rows={diagrams} />}
    </section>
  );
}
