// 改动块「这次改了什么」：放在这次工作的回复上方，每个条目一行——
// 编号与标题、改前改后版本、变了哪些字段（前后两版逐字段比较）、待定事项的状态变化与处理结果，带「查看差异」。
// 拼装与重建的规则见 model/changes.ts。

import type { Task } from "../../api/types";
import { entryView, type ChangeBlock } from "../../model/changes";

const OP: Record<string, { cls: string; text: string }> = {
  add: { cls: "add", text: "新增" },
  update: { cls: "edit", text: "修改" },
  restore: { cls: "add", text: "恢复" },
  delete: { cls: "drop", text: "删除" },
};

export function ChangeBlockView({ block, task, onOpenDiff }: {
  block: ChangeBlock;
  task: Task | null;
  onOpenDiff: (itemId: string) => void;
}) {
  return (
    <div className="chg" data-testid="change-block" data-key={block.key}>
      <div className="tt">这次改了什么{block.revisions.length ? `（第 ${block.revisions.join("、")} 次修订）` : ""}</div>
      {block.entries.map((e) => {
        const op = OP[e.op] ?? OP.update;
        const view = entryView(task, e);
        const exists = !!task?.items.some((i) => i.item_id === e.item_id);
        return (
          <div className="crow" key={e.item_id} data-testid={`change-${e.item_id}`}>
            <div className="ch">
              <span className={`opk ${op.cls}`}>{op.text}</span>
              <span className="ref">{e.item_id}</span>
              <span className="ctitle">{e.title}</span>
              <span className="cver">
                {e.op === "add" ? `第 ${e.version_after} 版` : e.op === "delete" ? `删掉了第 ${e.version_before} 版` : `第 ${e.version_before} 版 → 第 ${e.version_after} 版`}
              </span>
              {exists && e.op !== "delete" && (
                <span className="look" role="button" onClick={() => onOpenDiff(e.item_id)} data-testid={`change-open-${e.item_id}`}>
                  {e.op === "update" ? "查看差异" : "打开看看"}
                </span>
              )}
            </div>
            {view.status && (
              <div className="cdetail">{view.status.field}：{view.status.before || "（空）"} → <b>{view.status.after || "（空）"}</b></div>
            )}
            {view.notes.map((n) => <div className="cdetail" key={n.field}>{n.field}：<b>{n.value}</b></div>)}
            {e.op === "update" && view.fields.length > 0 && !view.status && (
              <div className="cdetail">改了 {view.fields.length} 个字段：{view.fields.join("、")}</div>
            )}
            {e.op === "update" && view.status && view.fields.filter((f) => f !== view.status!.field && !view.notes.some((n) => n.field === f)).length > 0 && (
              <div className="cdetail">另外改了：{view.fields.filter((f) => f !== view.status!.field && !view.notes.some((n) => n.field === f)).join("、")}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
