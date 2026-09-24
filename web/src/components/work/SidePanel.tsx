// 右侧栏：三个页签「材料 · 文档 · 修订」，页签行取代原来文档区的标题行。
//   · 材料：材料原文（MaterialPane）。
//   · 文档：现在只放「生成文档」入口与空状态说明；已生成的文档列表要另建表，还没有做。
//   · 修订：修订日志，最新在上，每次修订一张卡片——标题「修订 N · 时刻 · 执行者／你在界面上改的」，副标题写触发它的事，
//     正文每行一个碰到的条目（操作、编号与标题、改了哪些字段、查看差异），底部「撤销这次修订」「按此修订生成文档」。
//     点卡片选中它，条目区高亮它碰到的条目；再点一次取消。助手工作中照常可看，撤销灰化；
//     碰到的条目之后又改过或已删掉的修订撤销不了（undoBlocked），按钮预先灰化并说明原因。
// 收起后只剩一条竖排的把手，点它展开。

import { useEffect } from "react";
import type { ConversationMessage, Material, RevisionLogEntry, Item } from "../../api/types";
import { BUSY_TEXT } from "../../model/items";
import { hhmm, triggerText, UNDO_BLOCKED_TEXT, undoBlocked } from "../../model/revisions";
import { MaterialPane, type LocateRequest } from "./MaterialPane";

export type SideTab = "material" | "doc" | "rev";

const OP: Record<string, [string, string]> = { add: ["add", "新增"], update: ["edit", "修改"], restore: ["add", "恢复"], delete: ["drop", "删除"] };

export function SidePanel({
  side, onSide, onCollapse, onExpand, taskId, materials, focusPath, items, locate, currentItem, disabled, onOpenItem, onSend,
  log, messages, selectedRevision, onSelectRevision, scrollNonce, onDiff, onUndo, onGenerate, writesOff, readOnly,
}: {
  side: SideTab;
  onSide: (side: SideTab) => void;
  onCollapse: () => void;
  onExpand: () => void;
  taskId: string;
  materials: Material[];
  focusPath: string | null;
  items: Item[];
  locate: LocateRequest | null;
  currentItem: string | null;
  disabled: boolean;
  onOpenItem: (itemId: string) => void;
  onSend: (text: string) => void;
  log: RevisionLogEntry[];
  messages: ConversationMessage[];
  selectedRevision: number | null;
  onSelectRevision: (revision: number | null) => void;
  /** 每次要把选中的那张卡片滚进视野时加一（点回复底部的修订标签）。 */
  scrollNonce: number;
  onDiff: (itemId: string, revision: number) => void;
  onUndo: (revision: number) => void;
  /** 生成文档：不带修订号是按最新修订生成。 */
  onGenerate: (revision?: number) => void;
  writesOff: boolean;
  readOnly: boolean;
}) {
  const tabs: [SideTab, string, number | null][] = [["material", "材料", null], ["doc", "文档", null], ["rev", "修订", log.length || null]];
  return (
    <>
      <div className="doc-h">
        <span className="sw-stabs" role="tablist">
          {tabs.map(([key, label, count]) => (
            <span key={key} className={`sw-stab${side === key ? " on" : ""}`} role="tab" onClick={() => onSide(key)} data-testid={`side-tab-${key}`}>
              {label}{count != null && <span className="cnt">{count}</span>}
            </span>
          ))}
        </span>
        <span className="btn sm" role="button" onClick={onCollapse}>收起 ⇥</span>
      </div>
      <div className="sw-side">
        {side === "material" && (
          <MaterialPane taskId={taskId} materials={materials} focusPath={focusPath} items={items} locate={locate} currentItem={currentItem}
            disabled={disabled} onOpenItem={onOpenItem} onSend={onSend} />
        )}
        {side === "doc" && (
          <div className="sw-docempty" data-testid="doc-tab">
            这里显示生成出来的文档。还没有生成过。<br />
            用条目区右上角的「生成文档」按最新的修订生成，或在「修订」页签里对某一次修订点「按此修订生成文档」。<br />
            <button type="button" className="btn sm" onClick={() => onGenerate()}>生成文档</button>
          </div>
        )}
        {side === "rev" && (
          <RevisionLogView log={log} messages={messages} selected={selectedRevision} onSelect={onSelectRevision} scrollNonce={scrollNonce}
            onDiff={onDiff} onUndo={onUndo} onGenerate={onGenerate} writesOff={writesOff} readOnly={readOnly} liveItems={items} />
        )}
      </div>
      <div className="handle" role="button" title="展开右侧栏" onClick={onExpand} data-testid="doc-handle">
        <span className="harrow">◂</span><span>材料 · 文档 · 修订</span>
      </div>
    </>
  );
}

function RevisionLogView({ log, messages, selected, onSelect, scrollNonce, onDiff, onUndo, onGenerate, writesOff, readOnly, liveItems }: {
  log: RevisionLogEntry[];
  messages: ConversationMessage[];
  selected: number | null;
  onSelect: (revision: number | null) => void;
  scrollNonce: number;
  onDiff: (itemId: string, revision: number) => void;
  onUndo: (revision: number) => void;
  onGenerate: (revision?: number) => void;
  writesOff: boolean;
  readOnly: boolean;
  liveItems: Item[];
}) {
  useEffect(() => {
    if (selected == null) return;
    document.getElementById(`rev-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [scrollNonce]);
  const alive = new Set(liveItems.map((i) => i.item_id));
  return (
    <div className="sw-revlog" data-testid="revision-log">
      <div className="lead">这个任务的每一次修订，最新的在上面。点一张卡片，条目区会标出它碰到的条目。</div>
      {log.length === 0 && <div className="lead">还没有修订。</div>}
      {log.map((r) => {
        const blocked = undoBlocked(r, log, liveItems);
        return (
        <div key={r.revision_no} id={`rev-${r.revision_no}`} className={`sw-rev${selected === r.revision_no ? " on" : ""}`} data-testid={`rev-${r.revision_no}`}
          onClick={(e) => { if ((e.target as HTMLElement).closest("button, .look")) return; onSelect(selected === r.revision_no ? null : r.revision_no); }}>
          <div className="rh">
            <b>修订 {r.revision_no}</b><span className="t">· {hhmm(r.at)} ·</span>
            <span className={`who${r.by === "user" ? " user" : ""}`}>{r.by === "user" ? "你在界面上改的" : "助手"}</span>
          </div>
          <div className="why">{triggerText(r, messages)}</div>
          {r.operations.map((op) => {
            const [cls, word] = OP[op.op] ?? OP.update;
            // 删掉的条目与现在已不在交付物里的条目没有详情可看，不给「查看差异」。
            const canLook = op.op !== "delete" && alive.has(op.item_id);
            return (
              <div className="row" key={op.item_id}>
                <span className={`opk ${cls}`}>{word}</span>
                <span className="ref">{op.item_id}</span>
                <span className="rt" title={op.title}>{op.title}</span>
                {op.fields_changed.length > 0 && <span className="rf">改了 {op.fields_changed.join("、")}</span>}
                {canLook && <span className="look" role="button" onClick={() => onDiff(op.item_id, op.revision_after ?? r.revision_no)}
                  data-testid={`rev-${r.revision_no}-look-${op.item_id}`}>查看差异</span>}
              </div>
            );
          })}
          <div className="rfoot">
            <button type="button" className="btn sm" disabled={writesOff || readOnly || blocked}
              title={readOnly ? "任务已结束或助手不可用，不能撤销。" : writesOff ? BUSY_TEXT : blocked ? UNDO_BLOCKED_TEXT : undefined}
              onClick={() => onUndo(r.revision_no)} data-testid={`rev-${r.revision_no}-undo`}>撤销这次修订</button>
            <button type="button" className="btn sm" onClick={() => onGenerate(r.revision_no)} data-testid={`rev-${r.revision_no}-doc`}>按此修订生成文档</button>
          </div>
        </div>
        );
      })}
    </div>
  );
}
