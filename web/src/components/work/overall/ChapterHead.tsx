// 业务说明一章的章首页：面包屑（章号）、章名、一行小字，下面是这一章的各节各一段摘要（节号与标题可点，点了打开那一节）。
// 各章另有自己的块（系统边界、角色与用例对照、对象关系图、规则表、目标树、决策记录）由相应的组件画在摘要之前（ChapterBlocks.tsx）。
// 第 1 章的各节（范围、假设）在章首页上把说明全文合在一起显示，别的章只显示每节说明的第一段。
// 这一章有导语页时（编写文档阶段助手补写的，「导语所属章」写着这一章），导语的正文画在最前面；助手补的、用户还没有确认的
// 带一句「助手补写，待过目」，点「打开导语」去那一页确认或修改。

import type { ReactNode } from "react";
import type { Task } from "../../../api/types";
import { INTRO_NAME, chapterByNo, type Toc } from "../../../model/chapters";
import { firstParagraph, isDeprecated, isPending, titleOf, whatOf } from "../../../model/overall";

/** 导语上那句待过目的话。 */
export const INTRO_PENDING_TEXT = "助手补写，待过目";

export function ChapterHead({ contents, chapterNo, lead, children, onOpen, full = false, sectionNote }: {
  /** 各节的说明显示全文（各段都在），不只是第一段。 */
  full?: boolean;
  task: Task;
  contents: Toc;
  chapterNo: number;
  /** 章名下面那一行小字。 */
  lead: ReactNode;
  /** 这一章自己的块，画在各节的摘要之前。 */
  children?: ReactNode;
  /** 各节标题后面的一句小字（第 3 章写这一节对应几条用例）；不给、或者给的是空的就不写。 */
  sectionNote?: (itemId: string) => string;
  onOpen: (itemId: string) => void;
}) {
  const chapter = chapterByNo(chapterNo);
  const mine = contents.chapters.find((one) => one.chapter.no === chapterNo)!;
  const sections = mine.sections.filter((one) => !isDeprecated(one.item));
  const intro = mine.intro;
  const introText = intro ? whatOf(intro).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : [];
  return (
    <div className="oa-page oa-head" data-testid={`chapter-head-${chapterNo}`}>
      <div className="oa-crumb"><span className="here">{chapter.no}</span></div>
      <div className="oa-title" role="heading" aria-level={2} data-testid="chapter-title">{chapter.name}</div>
      <div className="oa-meta" data-testid="chapter-lead">{lead}</div>
      {intro && (
        <section className={`oa-blk oa-intro-blk${isPending(intro) ? " pending" : ""}`} data-testid="chapter-intro">
          <h3>{INTRO_NAME}{isPending(intro) && <small className="oa-intro-pending" data-testid="chapter-intro-pending">{INTRO_PENDING_TEXT}</small>}
            <small><span className="oa-sec-link" role="button" tabIndex={0} title={intro.item_id} onClick={() => onOpen(intro.item_id)}
              onKeyDown={(e) => { if (e.key === "Enter") onOpen(intro.item_id); }} data-testid="chapter-intro-open">{isPending(intro) ? "打开导语，确认或修改" : "打开导语"}</span></small></h3>
          <div className="oa-prose">{introText.length > 0 ? introText.map((p, i) => <p key={i}>{p}</p>) : <p className="oa-empty">导语还没有写。</p>}</div>
        </section>
      )}
      {children}
      {sections.map((one) => {
        const what = whatOf(one.item);
        const paragraphs = (full ? what.split(/\n\s*\n/) : [firstParagraph(what)]).map((p) => p.trim()).filter(Boolean);
        return (
          <section key={one.item.item_id} className="oa-blk" data-testid={`chapter-section-${one.item.item_id}`}>
            <h3><span className="oa-sec-link" role="button" tabIndex={0} title="打开这一节" onClick={() => onOpen(one.item.item_id)}
              onKeyDown={(e) => { if (e.key === "Enter") onOpen(one.item.item_id); }}>{one.no} {titleOf(one.item)}</span>
              {sectionNote?.(one.item.item_id) && <small data-testid={`chapter-section-note-${one.item.item_id}`}>{sectionNote(one.item.item_id)}</small>}</h3>
            <div className="oa-prose">{paragraphs.length > 0 ? paragraphs.map((p, i) => <p key={i}>{p}</p>) : <p className="oa-empty">这一节还没有写说明。</p>}</div>
          </section>
        );
      })}
    </div>
  );
}
