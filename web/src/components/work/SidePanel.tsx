// 右侧栏：三个页签「材料 · 文档 · 修订」，页签行取代原来文档区的标题行。
//   · 材料：材料原文（MaterialPane）。
//   · 文档：现在只放「生成文档」入口与空状态说明；已生成的文档列表要另建表，还没有做。
//   · 修订：修订日志，最新在上，每次修订一张卡片——标题「修订 N · 时刻 · 执行者／你在界面上改的」，副标题写触发它的事，
//     正文每行一个碰到的条目（操作、编号与标题、改了哪些字段、查看差异），底部「撤销这次修订」「按此修订生成文档」。
//     点卡片选中它，条目区高亮它碰到的条目；再点一次取消。助手工作中照常可看，撤销灰化；
//     碰到的条目之后又改过或已删掉的修订撤销不了（undoBlocked），按钮预先灰化并说明原因。
//     顶上一节「版本」：发布过的各版，最新的在上，每版写版本号、时刻、谁发布的、发布时的修订号与发布说明，「下载 Markdown」「下载 Word」；
//     没有存档的那一种灰着并说明原因。点「修订 N」选中那张修订卡片。（B2-3 把这一节搬进中栏「文档与版本」页签。）
//   · 评审：工作视图给了 review（评审页签的内容，ReviewPanel）时才有这个页签，角标是要处理的问题的处数（openProblems，与评审页签顶上一行同一个函数）。
//   · 任务定义「界面」一项写了「右侧栏页签」的集合（例如领域说明）：在「材料」之后各开一个页签，名字是集合名，
//     页签键是「coll:集合名」。按分组字段分组（靠前的组在前），每条写编号与标题、内容摘要、与别的条目的联系、修订；
//     还没有和任何条目关联的，联系那一行用琥珀色。点一条，在条目区打开它。
// 收起后只剩一条竖排的把手，点它展开。

import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import type { ConversationMessage, Material, RevisionLogEntry, Item, Task, VersionView } from "../../api/types";
import { missingArchiveText, versionMeta } from "../../model/versions";
import { BUSY_TEXT, summaryOf } from "../../model/items";
import { EMPTY_GROUP, groupItems, linkPhrase } from "../../model/domainNotes";
import { OVERALL_LABEL, collectionLabel, firstParagraph, isDeprecated, isIntroPage, isOverall, isPending, sideLine, titleOf, whatOf } from "../../model/overall";
import { hhmm, triggerText, UNDO_BLOCKED_TEXT, undoBlocked } from "../../model/revisions";
import { MaterialPane, type LocateRequest } from "./MaterialPane";

export type SideTab = "material" | "doc" | "rev" | "review" | "debug" | `coll:${string}`;

const OP: Record<string, [string, string]> = { add: ["add", "新增"], update: ["edit", "修改"], restore: ["add", "恢复"], delete: ["drop", "删除"] };

export function SidePanel({
  side, onSide, onCollapse, onExpand, taskId, materials, focusPath, items, locate, currentItem, disabled, onOpenItem, onSend,
  log, messages, selectedRevision, onSelectRevision, scrollNonce, onDiff, onUndo, onGenerate, writesOff, readOnly, review, reviewCount = 0, task, debug,
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
  /** 评审页签的内容；不给就没有这个页签。 */
  review?: ReactNode;
  /** 评审页签的角标：要处理的问题的处数。 */
  reviewCount?: number;
  /** 整份任务；给了才按任务定义开集合页签。 */
  task?: Task;
  /** 调试页签的内容；不给就没有这个页签（服务没有开调试模式时）。 */
  debug?: ReactNode;
}) {
  const collTabs = (task?.definition.collections ?? []).filter((c) => c.display?.side_tab);
  const tabs: [SideTab, string, number | null][] = [["material", "材料", null],
    ...collTabs.map((c): [SideTab, string, number | null] => [`coll:${c.name}`, collectionLabel(c.name), task!.items.filter((i) => i.collection === c.name).length]),
    ["doc", "文档", null], ["rev", "修订", log.length || null]];
  if (review) tabs.push(["review", "评审", reviewCount || null]);
  if (debug) tabs.push(["debug", "调试", null]);
  return (
    <>
      <div className="doc-h">
        <span className="sw-stabs" role="tablist">
          {tabs.map(([key, label, count]) => (
            <span key={key} className={`sw-stab${side === key ? " on" : ""}`} role="tab" onClick={() => onSide(key)} data-testid={`side-tab-${key}`}>
              {label}{count != null && <span className={`cnt${key === "review" ? " bad" : ""}`}>{count}</span>}
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
        {side === "review" && review}
        {side === "debug" && debug}
        {side.startsWith("coll:") && task && <CollectionSide task={task} collection={side.slice(5)} currentItem={currentItem} onOpenItem={onOpenItem} />}
        {side === "rev" && (
          <RevisionLogView log={log} messages={messages} selected={selectedRevision} onSelect={onSelectRevision} scrollNonce={scrollNonce}
            onDiff={onDiff} onUndo={onUndo} onGenerate={onGenerate} writesOff={writesOff} readOnly={readOnly} liveItems={items}
            versions={<VersionsBlock taskId={taskId} versions={task?.versions ?? []} onSelectRevision={onSelectRevision} />} />
        )}
      </div>
      <div className="handle" role="button" title="展开右侧栏" onClick={onExpand} data-testid="doc-handle">
        <span className="harrow">◂</span><span>{tabs.map(([, label]) => label).join(" · ")}</span>
      </div>
    </>
  );
}

/** 右侧栏里一个集合的分组清单（任务定义「界面」一项写了「右侧栏页签」的集合）。 */
function CollectionSide({ task, collection, currentItem, onOpenItem }: { task: Task; collection: string; currentItem: string | null; onOpenItem: (id: string) => void }) {
  const def = task.definition.collections.find((c) => c.name === collection);
  // 总体分析（页面上叫业务说明）：这里是看条目时对照用的窄提纲，只列贴了标签、还在用的主题，按标签分组（一页贴了两个标签就在两组里各列一次）；
  // 没有贴标签的与已废弃的到条目区的「业务说明」页签看。各章的导语页不是条目的依据：这里不列，也不算进「另有 N 个」。
  // 点一行切到条目区并打开那一页。
  const overall = isOverall(collection);
  const all = groupItems(task, collection);
  const groups = overall
    ? all.filter((g) => g.name !== EMPTY_GROUP).map((g) => ({ name: g.name, items: g.items.filter((i) => !isDeprecated(i) && !isIntroPage(i)) })).filter((g) => g.items.length > 0)
    : all;
  const left = overall ? task.items.filter((i) => i.collection === collection && !isIntroPage(i) && !groups.some((g) => g.items.includes(i))).length : 0;
  return (
    <div className="dn-side" data-testid={`side-collection-${collection}`}>
      {/* 说明那一句自己已经说出页面上的叫法时（新建任务的业务说明就是）不再在前面重复一遍。 */}
      {def?.display?.note && <div className="dn-lead"><b>{def.display.note.includes(collectionLabel(collection)) ? "" : `${collectionLabel(collection)}：`}{def.display.note}</b>{overall && " 这里只列贴了标签的主题，看条目时对照用。"}</div>}
      {groups.length === 0 && <div className="citedby-empty">{overall && left > 0 ? "还没有贴了标签的主题。" : "这个集合还没有条目。"}</div>}
      {overall && left > 0 && <div className="citedby-empty" data-testid="side-overall-rest">另有 {left} 个主题没有贴标签或者已废弃，到条目区的「{OVERALL_LABEL}」页签看。</div>}
      {groups.map((g) => (
        <div key={g.name}>
          <div className="grp">{g.name}</div>
          {g.items.map((item) => {
            if (overall) {
              return (
                <div key={item.item_id} className={`ent${isPending(item) ? " unl" : ""}${currentItem === item.item_id ? " on" : ""}`} role="button"
                  onClick={() => onOpenItem(item.item_id)} data-testid={`side-entry-${g.name}-${item.item_id}`}>
                  <span className="t">{item.item_id} {titleOf(item)}</span>
                  <div className="c">{firstParagraph(whatOf(item))}</div>
                  <div className="m">{sideLine(task, item)}</div>
                </div>
              );
            }
            const link = linkPhrase(task, item);
            return (
              <div key={item.item_id} className={`ent${link.unlinked ? " unl" : ""}${currentItem === item.item_id ? " on" : ""}`} role="button"
                onClick={() => onOpenItem(item.item_id)} data-testid={`side-entry-${item.item_id}`}>
                <span className="t">{item.item_id} {item.title}</span>
                <div className="c">{summaryOf(task, item)}</div>
                <div className="m">{link.text} · 修订 {item.revision_no}</div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * 修订页签顶上的「版本」一节。各版的存档在不在、图存了没有以版本接口为准：版本列表变了（发布了新的一版）就重取一次；
 * 取到之前先照整份数据里的那一份画。
 */
function VersionsBlock({ taskId, versions, onSelectRevision }: { taskId: string; versions: VersionView[]; onSelectRevision: (revision: number | null) => void }) {
  const [fetched, setFetched] = useState<VersionView[] | null>(null);
  useEffect(() => {
    let live = true;
    if (versions.length) api.listVersions(taskId).then((list) => { if (live) setFetched(list); }).catch(() => undefined);
    return () => { live = false; };
  }, [taskId, versions.length]);
  const list = [...(fetched && fetched.length >= versions.length ? fetched : versions)].sort((a, b) => b.version_no - a.version_no);
  return (
    <div className="sw-versions" data-testid="versions">
      <div className="vh"><b>版本</b><span>{list.length ? `已发布 ${list.length} 版` : "还没有发布过"}</span></div>
      {list.length === 0 && <div className="lead">完成条件都满足之后，条目区上方会出现发布的提示；发布时存下当时生成的 Markdown 与 Word。</div>}
      {list.map((one) => (
        <div key={one.version_no} className="sw-ver" data-testid={`version-${one.version_no}`}>
          <div className="r1"><b>第 {one.version_no} 版</b>
            <span className="m">{versionMeta(one)}</span>
            <span className="look" role="button" onClick={() => onSelectRevision(one.revision_no)} title="在下面的修订日志里选中这次修订">修订 {one.revision_no}</span>
          </div>
          {one.note && <div className="note">{one.note}</div>}
          <div className="dl">
            {one.has_markdown ? <a href={api.versionDocumentHref(taskId, one.version_no, "md")} data-testid={`version-${one.version_no}-md`}>下载 Markdown</a>
              : <span className="off" title={missingArchiveText(one)}>下载 Markdown</span>}
            {one.has_docx ? <a href={api.versionDocumentHref(taskId, one.version_no, "docx")} data-testid={`version-${one.version_no}-docx`}>下载 Word</a>
              : <span className="off" title={missingArchiveText(one)}>下载 Word</span>}
            {!one.has_markdown && !one.has_docx && <span className="why">{missingArchiveText(one)}</span>}
            {one.has_docx && !one.figures_archived && <span className="why">Word 里的图是 Mermaid 文本</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function RevisionLogView({ log, messages, selected, onSelect, scrollNonce, onDiff, onUndo, onGenerate, writesOff, readOnly, liveItems, versions }: {
  /** 顶上的「版本」一节。 */
  versions?: ReactNode;
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
      {versions}
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
