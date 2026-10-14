// 任务一级的整页（任务起点页）用的外框：与工作视图同一个顶栏和左边的导航条，中间一栏放页面内容，没有对话区与右侧栏。
// 顶栏不写会话名与当前活动：这一页不属于哪一条会话。「会话」菜单列出这个任务的会话，点一条进它的工作台。
// 中间一栏不套工作视图的清零（类名 unreset，见 styles/workview-extra.css），里面的卡片与表格照任务页原来的样式。

import { useState, type ReactNode } from "react";
import { SettingOutlined } from "@ant-design/icons";
import type { SessionListEntry } from "../api/types";
import { FONT_TIERS, readFontTier, saveFontTier, type FontTier } from "../model/fontScale";
import { formatTime } from "../model/format";
import { go, href, openSettings } from "../router";
import { NoModelBanner, UserMenu } from "./ServiceControls";

export function TaskFrame({ taskId, taskName, where, sessions, children }: {
  taskId: string;
  /** 任务名；还没有读到时不给。 */
  taskName?: string;
  /** 顶栏任务名后面写的这一页的名字，例如「任务起点」。 */
  where: string;
  sessions: SessionListEntry[];
  children: ReactNode;
}) {
  const [fontTier, setFontTier] = useState<FontTier>(readFontTier);
  const [menuOpen, setMenuOpen] = useState(false);
  const chooseFont = (tier: FontTier) => { setFontTier(tier); saveFontTier(tier); };
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
          <span className="smenu-btn" role="button" onClick={() => setMenuOpen(!menuOpen)} data-testid="session-menu-button">会话 ▾</span>
          <span className="set-btn" role="button" onClick={openSettings} data-testid="open-settings"><SettingOutlined />设置</span>
          <UserMenu where="topbar" />
          <div className={`smenu${menuOpen ? " show" : ""}`} data-testid="session-menu">
            <div className="mh">任务「{taskName}」的会话（共 {sessions.length} 条，所有会话共享同一份交付物）</div>
            {sessions.length === 0 && <div className="mh">还没有会话。启动工作项时自动建立。</div>}
            {sessions.map((s) => (
              <div key={s.session_id} className="srow" role="button" onClick={() => { setMenuOpen(false); go(href.work(taskId, s.session_id)); }}>
                <span className="sn">{s.name || "新会话，还没有说过话。"}</span>
                {s.active && <span className="chip okc">活动中</span>}
                <span className="st">最近活动 {formatTime(s.last_active_at)} · {s.message_count} 条消息</span>
              </div>
            ))}
          </div>
        </div>
        <div className="app-body">
          <div className="rail">
            <div className="ico" title="全局查找（还没有做）">⌕</div>
            <a className="ico on" title="任务起点" href={href.task(taskId)}>▣</a>
            <div className="sp" />
            <div className="ico" title="设置" role="button" style={{ cursor: "pointer" }} onClick={openSettings} data-testid="rail-settings">◉</div>
          </div>
          <div className="task-main unreset">{children}</div>
        </div>
      </div>
    </div>
  );
}
