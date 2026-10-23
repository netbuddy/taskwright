// 任务起点页的会话清单：每条会话一行，写会话名、它属于哪个工作项的标签（model/sessionTag.ts）、最近活动的时刻与它产生了几次修订，
// 右边「打开」进入工作视图，再右边一个「…」菜单，里面是「导出这条会话的诊断包」（确认框见 DiagnosticExportModal）。最近活动的排在前面；助手正接着的那条会话行前有一个绿色小圆点（与左侧栏的做法相同）。
// 底部一个开关「显示已归档的会话」：默认关着；打开时另取一次带归档的会话清单，归档的会话（工作项被删除了）接在后面、标「已归档」。

import { useEffect, useState } from "react";
import { EllipsisOutlined, MessageOutlined, RightOutlined } from "@ant-design/icons";
import { Button, Dropdown } from "antd";
import { api } from "../../api/client";
import type { SessionListEntry } from "../../api/types";
import { formatTimeShort } from "../../model/format";
import { SHOW_ARCHIVED, SHOW_ARCHIVED_NOTE, sessionTag, withArchived } from "../../model/sessionTag";
import { go, href } from "../../router";
import { DiagnosticExportModal } from "./DiagnosticExportModal";

/** 会话行菜单里的那一项。 */
export const SESSION_DIAGNOSTIC_ITEM = "导出这条会话的诊断包";
/** 确认框里没有名字的会话写成这样。 */
export const UNNAMED_SESSION = "未命名会话";

/** 最近活动的在前；刚新建、还没有活动时刻的会话排最前（它是最新的）。 */
export function byRecentActivity(sessions: SessionListEntry[]): SessionListEntry[] {
  return [...sessions].sort((a, b) => {
    if (!a.last_active_at || !b.last_active_at) return a.last_active_at ? 1 : b.last_active_at ? -1 : 0;
    return String(b.last_active_at).localeCompare(String(a.last_active_at));
  });
}

function revisionText(s: SessionListEntry): string {
  if (s.revision_count === undefined) return `一共 ${s.message_count} 条消息。`;
  return s.revision_count > 0 ? `这条会话产生了 ${s.revision_count} 次修订。` : "这条会话还没有产生修订。";
}

export function SessionList({ taskId, taskName, sessions }: { taskId: string; taskName: string; sessions: SessionListEntry[] }) {
  const [showArchived, setShowArchived] = useState(false);
  const [diagnosing, setDiagnosing] = useState<SessionListEntry | null>(null);
  const [archived, setArchived] = useState<SessionListEntry[] | null>(null);
  useEffect(() => {
    if (!showArchived) return;
    let live = true;
    api.listSessions(taskId, true).then((all) => { if (live) setArchived(byRecentActivity(all)); }).catch(() => { if (live) setArchived([]); });
    return () => { live = false; };
  }, [showArchived, taskId, sessions]);
  const rows = withArchived(byRecentActivity(sessions), showArchived ? archived : null);
  return (
    <section className="tp-sec">
      <div className="tp-sec-h">
        <h2><MessageOutlined className="tp-hic" />会话</h2><span className="cnt" data-testid="session-count">{sessions.length}</span>
        <span className="tp-sec-note">每条会话属于一个工作项，或是自由讨论</span>
      </div>
      <div className="tp-sessions">
        {rows.length === 0 && <div className="tp-sempty" data-testid="session-empty">还没有会话。启动工作项时自动建立。</div>}
        {rows.map((s) => (
          <div key={s.session_id} className={`tp-srow${s.archived ? " archived" : ""}`} title="打开这条会话，进入工作视图。" onClick={() => go(href.work(taskId, s.session_id))} data-testid="session-row">
            <MessageOutlined className="sic" />
            <div className="sbody">
              <div className="sfirst">
                {s.active && <span className="tp-live" title="助手正接着这条会话。" data-testid="session-active">●</span>}
                {s.name || "新会话，还没有说过话。"}
                {sessionTag(s) && <span className="chip" data-testid="session-tag">{sessionTag(s)}</span>}
              </div>
              <div className="smeta">
                {s.last_active_at ? `最近活动在 ${formatTimeShort(s.last_active_at)}` : "还没有活动"}<span className="dot">·</span>{revisionText(s)}
              </div>
            </div>
            <a className="tp-lnk" href={href.work(taskId, s.session_id)} onClick={(e) => e.stopPropagation()}>打开<RightOutlined /></a>
            <span onClick={(e) => e.stopPropagation()}>
              <Dropdown trigger={["click"]} menu={{ items: [{ key: "diagnostic", label: SESSION_DIAGNOSTIC_ITEM }], onClick: () => setDiagnosing(s) }}>
                <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label="更多操作" title="更多操作" data-testid={`session-menu-${s.session_id}`} />
              </Dropdown>
            </span>
          </div>
        ))}
      </div>
      <label className="tp-sarch" data-testid="show-archived">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        <span>{SHOW_ARCHIVED}<small>{SHOW_ARCHIVED_NOTE}</small></span>
      </label>
      <DiagnosticExportModal taskId={diagnosing ? taskId : null} taskName={taskName}
        session={diagnosing ? { id: diagnosing.session_id, name: diagnosing.name || UNNAMED_SESSION } : null} onClose={() => setDiagnosing(null)} />
    </section>
  );
}
