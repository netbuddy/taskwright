// 总体分析的提纲：按「上级主题」排成的一棵树，一页主题一行。每行是主题名、状态点（说清了、有助手补的待核实、还有没定的、
// 记下了还没归类）与计数（「3 定 · 1 问」）；有下级的行前面有小三角，点它收起或展开下级；点一行打开那一页，当前的一页反色。
// 底下是四种状态点的图例与一行总计。这里只管画与展开收起，数都由 model/overall.ts 算。

import { useState } from "react";
import type { Task } from "../../../api/types";
import { STATE_TEXT, countsText, isDeprecated, outline, titleOf, topicState, totals, type OutlineNode, type TopicState } from "../../../model/overall";

const LEGEND: TopicState[] = ["settled", "pending", "open", "unsorted"];

export function Outline({ task, current, onOpen, onRetell, retellOff }: {
  task: Task; current: string | null; onOpen: (itemId: string) => void;
  /** 「复述一遍」：请助手把现在的理解讲成一段故事；不给就不画这个按钮。 */
  onRetell?: () => void;
  /** 现在不能发给助手的原因（任务结束、助手正在工作）；能发时不给。 */
  retellOff?: string;
}) {
  // 收起了下级的那几页。缺省全部展开：提纲不长，先让人看到全貌。
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setFolded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const roots = outline(task);
  const sum = totals(task);

  const row = (node: OutlineNode) => {
    const { item } = node;
    const state = topicState(task, item);
    const count = countsText(task, item);
    const closed = folded.has(item.item_id);
    return (
      <li key={item.item_id}>
        <div className={`oa-row${item.item_id === current ? " cur" : ""}${isDeprecated(item) ? " gone" : ""}`} role="button" tabIndex={0}
          title={`${item.item_id} ${titleOf(item)}：${STATE_TEXT[state]}`} aria-current={item.item_id === current ? "true" : undefined}
          onClick={() => onOpen(item.item_id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(item.item_id); }} data-testid={`outline-${item.item_id}`}>
          {node.children.length > 0
            ? <span className="oa-caret" role="button" aria-label={closed ? "展开下级" : "收起下级"} aria-expanded={!closed}
                onClick={(e) => { e.stopPropagation(); toggle(item.item_id); }} data-testid={`outline-fold-${item.item_id}`}>{closed ? "▸" : "▾"}</span>
            : <span className="oa-caret none" aria-hidden="true" />}
          <span className={`oa-dot ${state}`} data-state={state} />
          <span className="oa-name">{titleOf(item)}</span>
          {count && <span className="oa-n" data-testid={`outline-count-${item.item_id}`}>{count}</span>}
        </div>
        {node.children.length > 0 && !closed && <ul>{node.children.map(row)}</ul>}
      </li>
    );
  };

  return (
    <div className="oa-outline-body" data-testid="outline">
      {roots.length === 0
        ? <div className="oa-none">还没有主题。把这件事讲给助手听，它会把说到的词一页一页立起来。</div>
        : <ul className="oa-tree">{roots.map(row)}</ul>}
      <div className="oa-legend">
        {LEGEND.map((state) => <span key={state}><i className={`oa-dot ${state}`} />{STATE_TEXT[state]}</span>)}
      </div>
      <div className="oa-foot" data-testid="outline-totals">
        {sum.pages} 个主题 · <b>{sum.settled}</b> 条已定 · <b>{sum.open}</b> 条待问 · <b>{sum.pending}</b> 处待核实
      </div>
      {onRetell && roots.length > 0 && (
        <button type="button" className="aibtn oa-retell" disabled={!!retellOff}
          title={retellOff ?? (current ? "请助手把对打开着的这一页及其下面主题的理解讲成一段故事" : "请助手把对各个主题的理解讲成一段故事")}
          onClick={onRetell} data-testid="outline-retell">复述一遍</button>
      )}
    </div>
  );
}
