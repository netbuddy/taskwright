// 材料区 Word 与 PDF 材料的「分段去向」：说明文字下面一行，默认收起，栏头写一共几节、几节未提取；展开后逐节列出标题、
// 段落范围（PDF 是页范围）与引用到这一节的条目编号，点编号打开那个条目；没有条目引用的一节在标题后标「未提取」并灰显。
// 点一节的其余地方，材料跳到那一节的开头（Word 的第一段、PDF 的第一页）。分段清单读不到（0.2 的任务、清单还没生成）时整栏不显示。

import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { Item } from "../../api/types";
import { SEGMENTS_SUFFIX, type SegmentList, parseSegments, sectionRows } from "../../model/segments";

export function SectionList({ taskId, path, items, onJump, onOpenItem }: {
  taskId: string;
  /** Word 或 PDF 文件的路径，例如 inputs/x.docx、inputs/x.pdf。 */
  path: string;
  items: Item[];
  /** 跳到一节的开头：Word 给段落号，PDF 给页。 */
  onJump: (first: number) => void;
  onOpenItem?: (itemId: string) => void;
}) {
  const [list, setList] = useState<SegmentList | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setList(null);
    let live = true;
    api.materialContent(taskId, `${path}${SEGMENTS_SUFFIX}`)
      .then((r) => { if (live) setList(parseSegments(r.text)); })
      .catch(() => { if (live) setList(null); });
    return () => { live = false; };
  }, [taskId, path]);
  const rows = useMemo(() => (list ? sectionRows(list, items, path) : []), [list, items, path]);
  if (!rows.length) return null;
  const none = rows.filter((r) => !r.cited.length).length;
  return (
    <div className={`sec${open ? " open" : ""}`} data-testid="sections">
      <div className="sec-head" role="button" onClick={() => setOpen(!open)} data-testid="sections-toggle">
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="sum">
          分段去向：<b>{rows.length}</b> 节，{none ? <><b>{none}</b> 节未提取</> : "都有去向"}
        </span>
      </div>
      {open && (
        <div className="sec-list">
          {rows.map((r) => (
            <div key={r.index} className={`sec-row${r.cited.length ? "" : " none"}`} role="button" onClick={() => onJump(r.first)} data-testid="section-row">
              <span className="t">
                <span className="h">{r.heading ?? "开头（第一个标题之前）"}</span>
                {!r.cited.length && <span className="tag">未提取</span>}
              </span>
              <span className="r">第 {r.first === r.last ? r.first : `${r.first}–${r.last}`} {r.unit}</span>
              {r.cited.length > 0 && (
                <span className="n">
                  {r.cited.map((id, i) => (
                    <Fragment key={id}>
                      {i > 0 && "、"}
                      <span className="id" role="button" data-testid="section-item"
                        onClick={(e) => { e.stopPropagation(); onOpenItem?.(id); }}>{id}</span>
                    </Fragment>
                  ))}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
