// 任务一级的整页（任务起点页、活动输入页）用的外框：与工作视图同一个顶栏和左边的导航栏（components/work/LeftNav.tsx），中间一栏放页面内容，没有对话区与右侧栏。
// 顶栏不写会话名与当前活动：这一页不属于哪一条会话。导航栏的会话一段列出这个任务的会话，点一条进它的工作台。
// 流程进度要页面给了任务才画；待处理事项一段另要 pending 为真（与起点页「待处理事项」一节显示的条件相同）才画，点一行滚到那一节；不在起点页时去起点页的那一节。
// 知识库清单这里另取一次（服务有知识库能力时），给导航栏「知识库」一行的计数。
// 中间一栏不套工作视图的清零（类名 unreset，见 styles/workview-extra.css），里面的卡片与表格照任务页原来的样式。

import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { KnowledgeLibrary, SessionListEntry, Task } from "../api/types";
import { FONT_TIERS, readFontTier, saveFontTier, type FontTier } from "../model/fontScale";
import { PENDING_SECTION_ID } from "../model/leftNav";
import { go, href } from "../router";
import { NoModelBanner, UserMenu, useService } from "./ServiceControls";
import { LeftNav } from "./work/LeftNav";

export function TaskFrame({ taskId, taskName, where, sessions, task = null, pending = false, children }: {
  taskId: string;
  /** 任务名；还没有读到时不给。 */
  taskName?: string;
  /** 顶栏任务名后面写的这一页的名字，例如「任务起点」。 */
  where: string;
  sessions: SessionListEntry[];
  /** 任务详情：给了才画导航栏的流程进度。 */
  task?: Task | null;
  /** 画不画导航栏的待处理事项一段（要同时给了任务）。 */
  pending?: boolean;
  children: ReactNode;
}) {
  const [fontTier, setFontTier] = useState<FontTier>(readFontTier);
  const chooseFont = (tier: FontTier) => { setFontTier(tier); saveFontTier(tier); };
  const service = useService();
  const hasKnowledge = service.info ? !!service.info.capabilities.knowledge : null;
  const [libraries, setLibraries] = useState<KnowledgeLibrary[] | null>(null);
  useEffect(() => {
    if (!hasKnowledge) return;
    let live = true;
    api.knowledge().then((all) => { if (live) setLibraries(all); }).catch(() => undefined);
    return () => { live = false; };
  }, [hasKnowledge]);
  const onPending = () => {
    const section = document.getElementById(PENDING_SECTION_ID);
    if (section) section.scrollIntoView?.({ block: "start" });
    else go(href.task(taskId, "pending"));
  };
  return (
    <div className="wv-page">
      <NoModelBanner />
      <div className="app" data-testid="task-frame">
        <div className="topbar">
          <a className="tname" href={href.task(taskId)}>{taskName ?? "…"}</a>
          <span className="tsep">·</span>
          <span className="sname">{where}</span>
          <span className="sw-fs" title="字号：根字号随视口流动，这里再选一档" data-testid="font-tiers">
            字号{FONT_TIERS.map((t) => (
              <a key={t.key} className={fontTier === t.key ? "on" : undefined} role="button" onClick={() => chooseFont(t.key)} data-testid={`font-${t.key}`}>{t.label}</a>
            ))}
          </span>
          <UserMenu where="topbar" />
        </div>
        <div className="app-body">
          <LeftNav taskId={taskId} taskName={taskName} stage={task?.stage} task={pending ? task : null} sessions={sessions}
            libraries={hasKnowledge === false ? undefined : libraries} onPending={onPending} />
          <div className="task-main unreset">{children}</div>
        </div>
      </div>
    </div>
  );
}
