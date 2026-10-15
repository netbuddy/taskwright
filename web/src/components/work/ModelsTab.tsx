// 工作台中栏「分析模型」页签：任务里全部的图的索引，版式照业务说明的节页（.oa-page）。图仍画在它说明的那一节或章首里，
// 这一页不画图。一张表按种类分组（同一种的几行只在第一行写种类）：种类、名称、所属节或章首、修订（刚改的带「刚改」）、
// 查看（用户看没看过现在的内容）、被哪些条目依据（点了打开那个条目）、「在节中查看」。表上一行计数。
// 「在节中查看」切到业务说明页签，打开图所在的节或章首并滚到它；改图在那张图下面的「文本与来源」里。
// 刚改的那几行底色淡黄，与业务说明里待核实的颜色一致。算法在 model/modelIndex.ts。

import type { Task } from "../../api/types";
import type { Toc } from "../../model/chapters";
import { modelCountLine, modelGroups } from "../../model/modelIndex";

/** 页上的一句说明。 */
export const MODELS_LEAD = "全部图按种类列出。图仍放在它说明的章节里，本页是索引：点「在节中查看」打开所在的节并定位到图。";
/** 一张图都没有时。 */
export const MODELS_EMPTY = "还没有图。启动「整理建模」，或在对话里请助手画一张。";

export function ModelsTab({ task, contents, onView, onOpenItem }: {
  task: Task;
  contents: Toc;
  /** 「在节中查看」。 */
  onView: (diagramId: string) => void;
  /** 点「被依据」里的一个条目。 */
  onOpenItem: (itemId: string) => void;
}) {
  const groups = modelGroups(task, contents);
  return (
    <div className="oa-page ap-page" data-testid="models-tab">
      <div className="ap-head"><h2>分析模型</h2></div>
      <p className="ap-lead">{MODELS_LEAD}</p>
      {groups.length === 0 ? <p className="oa-empty" data-testid="models-empty">{MODELS_EMPTY}</p> : (
        <section className="oa-blk">
          <div className="ap-count" data-testid="models-count">{modelCountLine(groups)}</div>
          <div className="oa-tablebox">
            <table className="oa-table ap-table" data-testid="models-table">
              <thead><tr><th>种类</th><th>名称</th><th>所属</th><th>修订</th><th>查看</th><th>被依据</th><th /></tr></thead>
              <tbody>
                {groups.flatMap((group) => group.rows.map((one, index) => (
                  <tr key={one.row.diagram_id} className={`${index === 0 ? "ap-first" : ""}${one.fresh ? " ap-fresh" : ""}`} data-testid={`model-${one.row.diagram_id}`}>
                    <td className="mut">{index === 0 ? group.kindName : ""}</td>
                    <td className="nm"><span className="ap-id">{one.row.diagram_id}</span>{one.row.name}</td>
                    <td>{one.home}</td>
                    <td className="num">{one.row.revision_no}{one.fresh && <span className="ap-chip warn">刚改</span>}</td>
                    <td className={one.viewed ? "mut" : "ap-warn"}>{one.viewed ? "已查看" : "未查看"}</td>
                    <td>
                      {one.basedOn.length === 0 ? <span className="mut">—</span> : one.basedOn.map((item, i) => (
                        <span key={item.item_id}>{i > 0 && "、"}<a className="ap-lnk" role="button" title={item.title} onClick={() => onOpenItem(item.item_id)}>{item.item_id}</a></span>
                      ))}
                    </td>
                    <td className="acts">
                      <a className="ap-lnk" role="button" onClick={() => onView(one.row.diagram_id)} data-testid={`model-view-${one.row.diagram_id}`}>在节中查看</a>
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
