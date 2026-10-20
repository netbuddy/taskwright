// 任务类型有分析提纲时的业务说明目录：树顶「目前的判断」，八个维度照提纲的先后，维度下是提纲条目，条目下是挂在它下面的页；
// 树底「解决方案创意」「未归类的发现」，最后是没有排进树里的页。维度行写「已做 k/n」与状态小标，提纲条目行写状态小标
// （未起、草稿 · 缺口 N、部分 · 缺失 N、满、确认无关）。还没有页的维度与条目灰着、不能点；现在正在问的那一条高亮。
// 这里只管画，树与状态由 model/outlineTree.ts 算。

import type { Task } from "../../../api/types";
import { type EntryState, type OutlineTree, type PageNode, currentEntryPage, stateText } from "../../../model/outlineTree";
import { titleOf } from "../../../model/overall";

/** 下一层比上一层往里缩多少（rem）。 */
const INDENT = 0.9;

export function OutlineContents({ task, tree, current, onOpen, onRetell, retellOff }: {
  task: Task;
  tree: OutlineTree;
  /** 打开着的那一页（页的编号）；没有打开时是 null。 */
  current: string | null;
  onOpen: (itemId: string) => void;
  onRetell?: () => void;
  retellOff?: string;
}) {
  const asking = currentEntryPage(task, tree);
  const tag = (state: EntryState) => <span className={`oa-st ${state.kind}`} data-testid="outline-state">{stateText(state)}</span>;
  const pageRow = (node: PageNode, depth: number) => (
    <div key={node.item.item_id}>
      <div className={`oa-row${node.item.item_id === current ? " cur" : ""}`} role="button" tabIndex={0} style={{ marginLeft: `${depth * INDENT}rem` }}
        onClick={() => onOpen(node.item.item_id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(node.item.item_id); }} data-testid={`toc-${node.item.item_id}`}>
        <span className="oa-name">{titleOf(node.item)}</span>
      </div>
      {node.children.map((one) => pageRow(one, depth + 1))}
    </div>
  );
  const fixedRow = (node: OutlineTree["judgement"], testId: string) => node && (
    <div className={`oa-ch${node.page ? "" : " dim"}${node.page && node.page.item_id === current ? " cur" : ""}`} role="button" tabIndex={node.page ? 0 : -1}
      onClick={() => node.page && onOpen(node.page.item_id)} onKeyDown={(e) => { if (e.key === "Enter" && node.page) onOpen(node.page.item_id); }} data-testid={testId}>
      <span className="no" /><span className="oa-name">{node.name}</span>{!node.page && <span className="oa-st none">未起</span>}
    </div>
  );

  return (
    <div className="oa-outline-body" data-testid="toc">
      <div className="oa-toc oa-outline-tree" data-testid="outline-toc">
        <div className="oa-chap">{fixedRow(tree.judgement, "outline-judgement")}</div>
        {tree.dimensions.map((dimension, i) => (
          <div key={dimension.name} className="oa-chap" data-testid={`outline-dimension-${i + 1}`}>
            <div className={`oa-ch${dimension.page ? "" : " dim"}${dimension.page && dimension.page.item_id === current ? " cur" : ""}`} role="button" tabIndex={dimension.page ? 0 : -1}
              title={dimension.page ? `打开「${dimension.name}」维度页` : "这个维度还没有页"}
              onClick={() => dimension.page && onOpen(dimension.page.item_id)} onKeyDown={(e) => { if (e.key === "Enter" && dimension.page) onOpen(dimension.page.item_id); }}>
              <span className="no">{i + 1}</span><span className="oa-name">{dimension.name}</span>
              <span className="oa-done" data-testid="outline-done">已做 {dimension.done}/{dimension.total}</span>{tag(dimension.state)}
            </div>
            {dimension.entries.map((entry) => {
              const first = entry.pages[0] ?? null;
              const on = entry.pages.some((page) => page.item_id === current);
              const now = entry.pages.some((page) => page.item_id === asking);
              return (
                <div key={entry.name}>
                  <div className={`oa-row${first ? "" : " dim"}${on ? " cur" : ""}${now ? " asking" : ""}`} role="button" tabIndex={first ? 0 : -1}
                    style={{ marginLeft: `${INDENT}rem` }} title={now ? "正在问这一条" : undefined}
                    onClick={() => first && onOpen(first.item_id)} onKeyDown={(e) => { if (e.key === "Enter" && first) onOpen(first.item_id); }}
                    data-testid={`outline-entry-${entry.name}`} data-asking={now ? "true" : undefined}>
                    <span className="oa-name">{entry.name}</span>{tag(entry.state)}
                  </div>
                  {entry.children.map((one) => pageRow(one, 2))}
                </div>
              );
            })}
            {dimension.others.map((one) => pageRow(one, 1))}
          </div>
        ))}
        <div className="oa-chap">{fixedRow(tree.ideas, "outline-ideas")}</div>
        <div className="oa-chap">{fixedRow(tree.unsorted, "outline-unsorted")}</div>
        {tree.loose.length > 0 && (
          <div className="oa-chap" data-testid="outline-loose">
            <div className="oa-ch dim plain" title="这几页的名字与提纲对不上，上级也不在提纲里"><span className="no" /><span className="oa-name">其他页</span></div>
            {tree.loose.map((item) => pageRow({ item, children: [] }, 1))}
          </div>
        )}
      </div>
      {onRetell && (
        <button type="button" className="aibtn oa-retell" disabled={!!retellOff} title={retellOff ?? "请助手把对各节的理解讲成一段故事"} onClick={onRetell} data-testid="toc-retell">复述一遍</button>
      )}
    </div>
  );
}
