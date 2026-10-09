// 材料区 PDF 材料的目录：文件名下面一行，默认收起；点开是一列，点一项材料跳到那一页的开头。
// 目录取位置表里的书签目录（文件自己带的，不按字号猜标题）；文件没有书签目录时写「这份文件没有目录」，改成按页列。
// 现在看的那一页所在的一项标出来；这一页上有不止一个书签时分不出它属于哪一项，就不标（model/pdfView.ts 的 headingOfPage）。
// 位置表还没有读到、读不到时整栏不显示。

import { useState } from "react";
import { headingOfPage } from "../../model/pdfView";
import { usePdfLocations } from "../../state/pdfStore";

export function PdfOutline({ taskId, path, page, pages, onJump }: {
  taskId: string;
  /** PDF 文件的路径，例如 inputs/x.pdf。 */
  path: string;
  /** 现在看的是第几页（还没有显示出来时是 0）。 */
  page: number;
  /** 一共几页（没有书签目录时按页列要用）；还不知道时是 0。 */
  pages: number;
  onJump: (page: number) => void;
}) {
  const entry = usePdfLocations(taskId, path);
  const [open, setOpen] = useState(false);
  if (!entry || entry.status === "loading" || !entry.locations) return null;
  const headings = entry.locations.headings;
  const count = pages || entry.locations.pages.length;
  const current = headingOfPage(headings, page);
  return (
    <div className={`sec pdf-toc${open ? " open" : ""}`} data-testid="pdf-toc">
      <div className="sec-head" role="button" onClick={() => setOpen(!open)} data-testid="pdf-toc-toggle">
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="sum">
          {headings.length > 0
            ? <>目录：<b>{headings.length}</b> 项（点开按章节跳转）</>
            : <>这份文件没有目录，可以按页跳转（共 <b>{count}</b> 页）</>}
        </span>
      </div>
      {open && (
        <div className="toc-list" data-testid="pdf-toc-list">
          {headings.length > 0 ? headings.map((heading, i) => (
            <div key={i} className={`toc-row${i === current ? " cur" : ""}`} role="button" style={{ paddingLeft: `${1.8 + (Math.max(1, heading.level) - 1) * 1.2}rem` }}
              onClick={() => onJump(heading.page)} data-testid="pdf-toc-row">
              <span className="t" title={heading.title}>{heading.title || "（没有标题）"}</span><span className="pg">第 {heading.page} 页</span>
            </div>
          )) : (
            <>
              <div className="toc-none" data-testid="pdf-toc-none">这份文件没有目录</div>
              {Array.from({ length: count }, (_, i) => (
                <div key={i} className={`toc-row${i + 1 === page ? " cur" : ""}`} role="button" onClick={() => onJump(i + 1)} data-testid="pdf-toc-row">
                  <span className="t">第 {i + 1} 页</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
