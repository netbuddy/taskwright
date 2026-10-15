// 术语表：业务说明里标签含「概念」、不待核实的页，两列（标题与别名、「它是什么」的首段）。生成的文档里的术语表取的就是这些。
// 还待核实的概念不收，表下面写明是哪几页；点一行打开那一页主题。

import type { Task } from "../../../api/types";
import { glossary, titleOf } from "../../../model/overall";

export function Glossary({ task, onOpen }: { task: Task; onOpen: (itemId: string) => void }) {
  const { rows, waiting } = glossary(task);
  return (
    <div className="oa-gloss" data-testid="glossary">
      <div className="oa-gloss-h">术语表 <small>标签含「概念」、已经核实过的主题</small></div>
      {rows.length === 0 ? <div className="oa-empty">还没有可以进术语表的主题：贴上「概念」标签、又不待核实的主题才会列在这里。</div> : (
        <table className="oa-table">
          <thead><tr><th>标题与别名</th><th>它是什么</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.item.item_id} role="button" tabIndex={0} title={`打开 ${row.item.item_id}`} onClick={() => onOpen(row.item.item_id)}
                onKeyDown={(e) => { if (e.key === "Enter") onOpen(row.item.item_id); }} data-testid={`glossary-${row.item.item_id}`}>
                <td className="n"><b>{titleOf(row.item)}</b>{row.aliases.length > 0 && <span className="alias">又叫：{row.aliases.join("、")}</span>}</td>
                <td>{row.first}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="oa-gloss-note" data-testid="glossary-note">
        待核实的概念确认后才会进文档。
        {waiting.length > 0 && <>现在有 {waiting.length} 页还待核实，没有收进来：{waiting.map((page, i) => (
          <span key={page.item_id}>{i > 0 && "、"}<span className="see" role="button" onClick={() => onOpen(page.item_id)}>{titleOf(page)}</span></span>
        ))}。</>}
      </div>
    </div>
  );
}
