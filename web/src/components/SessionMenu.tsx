// 顶栏「会话 ▾」打开的会话菜单：工作视图与任务一级的整页（任务起点页、活动输入页）共用。
// 每条会话一行：会话名、它属于哪个工作项的标签（model/sessionTag.ts）、当前打开的与助手正接着的标记、最近活动与消息条数，点一行进它的工作台。
// 底部一个开关「显示已归档的会话」：默认关着，归档的会话（工作项被删除了）不列出；打开时另取一次带归档的会话清单，归档的接在后面、标「已归档」，
// 也能点开（打开后按自由讨论办）。工作视图另有一行「新建会话」，新建的是自由讨论的会话。

import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { SessionListEntry } from "../api/types";
import { formatTime } from "../model/format";
import { SHOW_ARCHIVED, SHOW_ARCHIVED_NOTE, sessionTag, withArchived } from "../model/sessionTag";
import { go, href } from "../router";

export function SessionMenu({ taskId, taskName, sessions, open, onClose, currentId = null, onNew }: {
  taskId: string;
  taskName: string | undefined;
  /** 未归档的会话。 */
  sessions: SessionListEntry[];
  open: boolean;
  onClose: () => void;
  /** 现在打开着的那条会话（工作视图里）；任务一级的整页没有。 */
  currentId?: string | null;
  /** 「新建会话」一行；不给时没有这一行（任务已经结束、任务一级的整页）。 */
  onNew?: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<SessionListEntry[] | null>(null);
  // 开关开着、菜单打开时取一次带归档的清单；取不到时只列未归档的。
  useEffect(() => {
    if (!open || !showArchived) return;
    let live = true;
    api.listSessions(taskId, true).then((all) => { if (live) setArchived(all); }).catch(() => { if (live) setArchived([]); });
    return () => { live = false; };
  }, [open, showArchived, taskId]);
  const rows = withArchived(sessions, showArchived ? archived : null);
  const pick = (id: string) => { onClose(); if (id !== currentId) go(href.work(taskId, id)); };
  return (
    <div className={`smenu${open ? " show" : ""}`} data-testid="session-menu">
      <div className="mh">任务「{taskName}」的会话（共 {sessions.length} 条，所有会话共享同一份交付物）</div>
      {rows.length === 0 && <div className="mh">还没有会话。启动工作项时自动建立。</div>}
      {rows.map((s) => {
        const tag = sessionTag(s);
        return (
          <div key={s.session_id} className={`srow${s.archived ? " archived" : ""}`} role="button" onClick={() => pick(s.session_id)} data-testid="session-menu-row">
            <span className="sn">{s.name || "新会话，还没有说过话。"}</span>
            {tag && <span className="chip" data-testid="session-menu-tag">{tag}</span>}
            {s.session_id === currentId && <span className="chip on">当前打开</span>}
            {s.active && <span className="chip okc">活动中</span>}
            <span className="st">最近活动 {formatTime(s.last_active_at)} · {s.message_count} 条消息</span>
          </div>
        );
      })}
      {onNew && <div className="srow newrow" role="button" onClick={onNew}>＋ 新建会话（自由讨论，不绑定活动；交付物还是这一份）</div>}
      <label className="sarch" data-testid="session-menu-archived">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        <span>{SHOW_ARCHIVED}<small>{SHOW_ARCHIVED_NOTE}</small></span>
      </label>
    </div>
  );
}
