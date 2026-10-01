// 任务页的会话清单：每条会话一行，写它的第一句话、最近活动的时刻与它产生了几次修订，右边「打开」进入工作视图。
// 最近活动的排在前面；助手正接着的那条会话行前有一个绿色小圆点（与左侧栏的做法相同）。

import { MessageOutlined, RightOutlined } from "@ant-design/icons";
import type { SessionListEntry } from "../../api/types";
import { formatTimeShort } from "../../model/format";
import { go, href } from "../../router";

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

export function SessionList({ taskId, sessions }: { taskId: string; sessions: SessionListEntry[] }) {
  const rows = byRecentActivity(sessions);
  return (
    <section className="tp-sec">
      <div className="tp-sec-h"><h2><MessageOutlined className="tp-hic" />会话</h2><span className="cnt" data-testid="session-count">{rows.length}</span></div>
      <div className="tp-sessions">
        {rows.length === 0 && <div className="tp-sempty" data-testid="session-empty">还没有会话。点右上角「新建会话」开始。</div>}
        {rows.map((s) => (
          <div key={s.session_id} className="tp-srow" title="打开这条会话，进入工作视图。" onClick={() => go(href.work(taskId, s.session_id))} data-testid="session-row">
            <MessageOutlined className="sic" />
            <div className="sbody">
              <div className="sfirst">
                {s.active && <span className="tp-live" title="助手正接着这条会话。" data-testid="session-active">●</span>}
                {s.name || "新会话，还没有说过话。"}
              </div>
              <div className="smeta">
                {s.last_active_at ? `最近活动在 ${formatTimeShort(s.last_active_at)}` : "还没有活动"}<span className="dot">·</span>{revisionText(s)}
              </div>
            </div>
            <a className="tp-lnk" href={href.work(taskId, s.session_id)} onClick={(e) => e.stopPropagation()}>打开<RightOutlined /></a>
          </div>
        ))}
      </div>
    </section>
  );
}
