// 材料区 Word 材料的「按章节看引用」：文件名下面一行，默认收起；展开后逐节列出标题、段落范围与被几个条目引用，
// 没有条目引用的一节灰显。点一节，材料跳到那一节的第一段。分段清单读不到（0.2 的任务、清单还没生成）时整栏不显示。

import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { Item } from "../../api/types";
import { SEGMENTS_SUFFIX, type SegmentList, parseSegments, sectionRows } from "../../model/segments";

export function SectionList({ taskId, path, items, onJump }: {
  taskId: string;
  /** Word 文件的路径，例如 inputs/x.docx。 */
  path: string;
  items: Item[];
  onJump: (paragraph: number) => void;
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
  const cited = rows.filter((r) => r.items > 0).length;
  return (
    <div className={`sec${open ? " open" : ""}`} data-testid="sections">
      <div className="sec-head" role="button" onClick={() => setOpen(!open)} data-testid="sections-toggle">
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="sum">
          按章节看引用：<b>{rows.length}</b> 节里 <b>{cited}</b> 节有条目引用
          {rows.length > cited && <span className="gray">，{rows.length - cited} 节还没有</span>}
        </span>
      </div>
      {open && (
        <div className="sec-list">
          {rows.map((r) => (
            <div key={r.index} className={`sec-row${r.items ? "" : " none"}`} role="button" onClick={() => onJump(r.first)} data-testid="section-row">
              <span className="t">{r.heading ?? "开头（第一个标题之前）"}</span>
              <span className="n">{r.items ? `被 ${r.items} 个条目引用` : "还没有条目引用这一段"}</span>
              <span className="r">第 {r.first}–{r.last} 段</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
