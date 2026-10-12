// 各章章首页上自己的那几块（画在各节的摘要之前，由 OverallPane.tsx 交给 ChapterHead.tsx）：
//   第 1 章 概述与范围 ── 系统边界图；业务目标摘要（目标树的前两层，点一个目标打开那一节，「看全部」去第 6 章）。
//   第 2 章 角色 ── 角色与用例对照表（列是角色，行是用例，格子是连线上写的字，末列是所属流程），表下写它依据哪一张用例图，
//                  「查看用例图」展开那张图。
//   第 4 章 业务对象 ── 整张对象关系图。
//   第 5 章 业务规则 ── 规则表：各节「适用规则」逐条列出，写出自哪一节与出处；标了冲突的行有底色，表上面一句「N 对相互冲突，已记为待澄清」。
//   第 6 章 业务目标 ── 目标树：目标一层一层往里缩，挂在目标下的决定带着为什么这样决定；没有挂到目标下的决定另列。
//   第 7 章 决策记录与待澄清事项 ── 按时间的一张表：时间、类别（决定、待澄清）、事项、说明；点一行打开它所在的节。
// 这里只画；数由 model/chapterHeads.ts 与 model/sectionDiagrams.ts 算。

import { useState } from "react";
import { CHAPTER_GOALS, sectionLabel } from "../../../model/chapters";
import { decisionTarget, goalSummary, useCaseTable } from "../../../model/chapterHeads";
import { formatTime } from "../../../model/format";
import type { DecisionLeaf, GoalNode } from "../../../../../agent/src/lib/overall_views.ts";
import { revisionText } from "../../../model/diagrams";
import { isOverall, sourceShortText, titleOf } from "../../../model/overall";
import { KIND_CLASS, KIND_CONTEXT, KIND_USE_CASE, diagramsOfKind } from "../../../model/sectionDiagrams";
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

/** 第 4 章：整张对象关系图。 */
export function ObjectsBlocks({ host }: { host: FigureHost }) {
  const diagrams = diagramsOfKind(host.task, KIND_CLASS);
  if (diagrams.length === 0) return null;
  return (
    <section className="oa-blk" data-testid="chapter-classes">
      <h3>对象关系</h3>
      <Figure host={host} rows={diagrams} />
    </section>
  );
}

/** 第 5 章：规则表。 */
export function RulesBlocks({ host }: { host: FigureHost }) {
  const { task, contents, onOpen, onOpenItem } = host;
  const rules = task.overall_views?.rules ?? { rows: [], conflicts: [], unmatched: [] };
  const pageOf = (itemId: string) => task.items.find((one) => one.item_id === itemId) ?? null;
  return (
    <section className="oa-blk" data-testid="chapter-rules">
      <h3>规则表</h3>
      {rules.conflicts.length > 0 && (
        <p className="oa-conflicts" data-testid="rules-conflicts">
          {rules.conflicts.length} 对相互冲突，已记为待澄清：
          {rules.conflicts.map((id, i) => (
            <span key={id}>{i > 0 && "、"}<span className="see" role="button" title={id} onClick={() => onOpenItem?.(id)}>{pageOf(id)?.title || id}</span></span>
          ))}
          {rules.unmatched.length > 0 && <span data-testid="rules-unmatched">。其中 {rules.unmatched.length} 对在表里对不上是哪两条规则，请打开问题看。</span>}
        </p>
      )}
      {rules.rows.length === 0 ? <p className="oa-empty">各节还没有写适用规则。</p> : (
        <div className="oa-tablebox">
          <table className="oa-table oa-rulestable" data-testid="rules-table">
            <thead><tr><th>规则</th><th>出自</th><th>出处</th></tr></thead>
            <tbody>
              {rules.rows.map((row) => {
                const page = pageOf(row.item_id);
                return (
                  <tr key={`${row.item_id}:${row.index}`} className={row.conflicts.length > 0 ? "conflict" : undefined} onClick={() => onOpen(row.item_id)}
                    title="打开这条规则所在的节" data-testid={`rule-${row.item_id}-${row.index}`}>
                    <td>{row.text}{row.conflicts.length > 0 && <span className="oa-conflict">有冲突，已记为待澄清</span>}</td>
                    <td className="from">{page ? sectionLabel(contents, page) : row.title}</td>
                    <td className="src">{row.sources.length === 0 ? "—" : <>{sourceShortText(row.sources[0])}{row.sources.length > 1 && ` 等 ${row.sources.length} 条`}</>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** 第 6 章：目标树。 */
export function GoalsBlocks({ host }: { host: FigureHost }) {
  const { task, onOpen } = host;
  const tree = task.overall_views?.goals ?? { roots: [], loose: [] };
  const decision = (one: DecisionLeaf) => (
    <li key={one.item_id} className="dec" data-testid={`goal-decision-${one.item_id}`}>
      <span className="k">决定</span>
      <span className="oa-sec-link" role="button" title={one.item_id} onClick={() => onOpen(one.item_id)}>{one.title}</span>
      {one.why && <span className="why">为什么：{one.why}</span>}
    </li>
  );
  const goal = (node: GoalNode) => (
    <li key={node.item_id} data-testid={`goal-${node.item_id}`}>
      <span className="oa-sec-link g" role="button" title={node.item_id} onClick={() => onOpen(node.item_id)}>{node.title}</span>
      {(node.goals.length > 0 || node.decisions.length > 0) && <ul>{node.decisions.map(decision)}{node.goals.map(goal)}</ul>}
    </li>
  );
  return (
    <>
      <section className="oa-blk" data-testid="chapter-goals">
        <h3>目标树</h3>
        {tree.roots.length === 0 ? <p className="oa-empty">还没有标签含「目标」的节。</p> : <ul className="oa-goaltree">{tree.roots.map(goal)}</ul>}
      </section>
      {tree.loose.length > 0 && (
        <section className="oa-blk" data-testid="chapter-goals-loose">
          <h3>还没有挂到目标下的决定</h3>
          <ul className="oa-goaltree">{tree.loose.map(decision)}</ul>
        </section>
      )}
    </>
  );
}

/** 第 7 章：决策记录与待澄清事项，按时间。 */
export function DecisionsBlocks({ host }: { host: FigureHost }) {
  const { task, onOpen, onOpenItem } = host;
  const rows = task.overall_views?.decisions ?? [];
  const open = (row: (typeof rows)[number]) => {
    const target = decisionTarget(task, row);
    if (target?.kind === "section") onOpen(target.itemId);
    else if (target) onOpenItem?.(target.itemId);
  };
  return (
    <section className="oa-blk" data-testid="chapter-decisions">
      <h3>按时间</h3>
      {rows.length === 0 ? <p className="oa-empty">还没有决定，也没有待澄清事项。</p> : (
        <div className="oa-tablebox">
          <table className="oa-table oa-decisions" data-testid="decisions-table">
            <thead><tr><th>时间</th><th>类别</th><th>事项</th><th>说明</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.entry}:${row.item_id}`} className={row.entry} onClick={() => open(row)} title={row.item_id} data-testid={`decision-${row.item_id}`}>
                  <td className="at">{row.at ? formatTime(row.at) : "—"}</td>
                  <td className="kind">{row.entry === "decision" ? "决定" : `待澄清${row.question_kind ? ` · ${row.question_kind}` : ""}`}</td>
                  <td>{row.title}</td>
                  <td className="note">{row.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
