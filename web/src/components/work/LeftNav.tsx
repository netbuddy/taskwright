// 工作视图与任务一级整页（任务起点页、活动输入页）左边的导航栏：回答「哪个任务、流程走到哪一站、哪条会话、有什么事等我处理」。
// 自上而下五段：任务头（「‹」回任务列表，任务名回任务起点）、工作（流程进度与会话列表）、待处理事项（三行）、参考（知识库、查找），末尾设置与收起。
// 展开约 248px、收起约 56px 只留图标（悬停出全名），宽度是 styles.css 的 --w-nav 与 --w-nav-closed；收起时三组图标之间有分隔线，红点保留。
// 会话列表末尾有开关「显示已归档的会话」：默认关着；打开时另取一次带归档的会话清单，归档的接在后面、标「已归档」，也能点开（打开后按自由讨论办）。
// 开合与待处理事项的口径在 model/leftNav.ts；除了归档的会话，数据都由页面给。工作与待处理事项两段数据不全时（页面没有给）不画。

import { useEffect, useState } from "react";
import {
  ApartmentOutlined, BookOutlined, EyeOutlined, FlagOutlined, LeftOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
  MessageOutlined, PlusOutlined, QuestionCircleOutlined, SearchOutlined, SettingOutlined,
} from "@ant-design/icons";
import { api } from "../../api/client";
import type { KnowledgeLibrary, SessionListEntry, StageView, Task } from "../../api/types";
import { formatTime } from "../../model/format";
import {
  NOTHING_PENDING, SESSION_ROWS, flowProgress, initialLeftNavOpen, knowledgeText, pendingLines, saveLeftNav, sessionRows, type PendingLine,
} from "../../model/leftNav";
import { SHOW_ARCHIVED, SHOW_ARCHIVED_NOTE, sessionTag, withArchived } from "../../model/sessionTag";
import { go, href, openSettings } from "../../router";

/** 「＋ 新会话」悬停时的说明：新建的是自由讨论的会话。 */
export const NEW_SESSION_TITLE = "新建一条会话：自由讨论，不绑定活动；交付物还是这一份";

const PENDING_ICONS = { decisions: <FlagOutlined />, questions: <QuestionCircleOutlined />, review: <EyeOutlined /> };

/** 会话的建立时间写成「10-15 19:22」。 */
const shortTime = (iso: string) => formatTime(iso).slice(5);

export function LeftNav({ taskId, taskName, stage, task, sessions, currentSessionId = null, currentSessionName, onNewSession, libraries, onPending }: {
  taskId: string;
  /** 任务名；还没有读到时不给。 */
  taskName?: string;
  /** 任务的阶段（流程进度取它的灯，站取自会话清单）；不给时不画流程进度。 */
  stage?: StageView | null;
  /** 任务详情（待处理事项三行从它算）；不给时不画待处理事项一段。 */
  task?: Task | null;
  /** 未归档的会话；不给时不画会话列表。 */
  sessions?: SessionListEntry[] | null;
  /** 现在打开着的那条会话（工作视图里）；任务一级的整页没有。 */
  currentSessionId?: string | null;
  /** 现在这条会话的名字：会话清单里还没有它（刚新建、清单还没读回来）时用它。 */
  currentSessionName?: string;
  /** 「＋ 新会话」；不给时没有这一行。 */
  onNewSession?: () => void;
  /** 知识库清单：服务没有知识库能力时为 undefined，不显示那一行；还没有取到时是 null。 */
  libraries?: KnowledgeLibrary[] | null;
  /** 点了待处理事项的一行。 */
  onPending?: (line: PendingLine) => void;
}) {
  const [open, setOpen] = useState(initialLeftNavOpen);
  const [allSessions, setAllSessions] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<SessionListEntry[] | null>(null);
  const toggle = () => { setOpen(!open); saveLeftNav(!open); };
  // 开关打开时取一次带归档的清单；取不到时只列未归档的。
  useEffect(() => {
    if (!showArchived) return;
    let live = true;
    api.listSessions(taskId, true).then((all) => { if (live) setArchived(all); }).catch(() => { if (live) setArchived([]); });
    return () => { live = false; };
  }, [showArchived, taskId]);

  const progress = flowProgress(stage, sessions);
  const rows = sessions ? sessionRows(sessions, currentSessionId) : null;
  const listed = rows ? withArchived(rows.others, showArchived ? archived : null).filter((one) => one.session_id !== currentSessionId) : [];
  const others = allSessions ? listed : listed.slice(0, SESSION_ROWS);
  const hidden = listed.length - others.length;
  const lines = task ? pendingLines(task) : null;
  const knowledge = libraries === undefined ? undefined : knowledgeText(libraries);
  const current = rows?.current?.name || currentSessionName || "新会话";
  const pick = (id: string) => { if (id !== currentSessionId) go(href.work(taskId, id)); };

  return (
    <nav className={`lnav ${open ? "open" : "closed"}`} data-testid="left-nav">
      <div className="lnav-hd">
        <a className="i" href={href.tasks()} title="回任务列表" data-testid="nav-back"><LeftOutlined /></a>
        <a className="n" href={href.task(taskId)} title={`回任务起点：${taskName ?? ""}`} data-testid="nav-task"><b>{taskName ?? "…"}</b></a>
      </div>

      {(progress || rows) && (
        <div className="lnav-sec" data-testid="nav-work">
          <div className="t">工作</div>
          {progress && (
            <div className="lnav-flow" title={`${progress.name} · ${progress.line}`} data-testid="nav-flow">
              <div className="lnav-flow-h"><span className="i"><ApartmentOutlined /></span><span className="n">{progress.name}</span></div>
              <div className="bar">{progress.marks.map((m) => <i key={m.key} className={m.mark} title={m.name} />)}</div>
              <div className="lab" data-testid="nav-flow-line">{progress.line}</div>
            </div>
          )}
          {rows && currentSessionId && (
            <a className="lnav-it on" title={`当前会话 · ${current}`} data-testid="nav-current-session">
              <span className="i"><MessageOutlined /></span><span className="n">当前会话 · {current}</span>
            </a>
          )}
          {others.map((one) => {
            const tag = sessionTag(one);
            return (
              <a key={one.session_id} className={`lnav-it sub${one.archived ? " archived" : ""}`} role="button" onClick={() => pick(one.session_id)} title={one.name || "新会话"} data-testid="nav-session">
                <span className="n">{one.name || "新会话，还没有说过话。"}<small>{tag && <span data-testid="nav-session-tag">{tag} · </span>}{shortTime(one.started_at)}</small></span>
              </a>
            );
          })}
          {hidden > 0 && (
            <a className="lnav-it sub more" role="button" onClick={() => setAllSessions(true)} data-testid="nav-sessions-more">
              <span className="n">还有 {hidden} 条</span>
            </a>
          )}
          {onNewSession && (
            <a className="lnav-it sub" role="button" onClick={onNewSession} title={NEW_SESSION_TITLE} data-testid="nav-new-session">
              <span className="i"><PlusOutlined /></span><span className="n">新会话</span>
            </a>
          )}
          {rows && (
            <label className="lnav-arch" title={SHOW_ARCHIVED_NOTE} data-testid="nav-archived">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              <span>{SHOW_ARCHIVED}</span>
            </label>
          )}
        </div>
      )}

      {lines && (
        <div className="lnav-sec" data-testid="nav-pending">
          <div className="t">待处理事项</div>
          {lines.length === 0 && <div className="lnav-none" data-testid="nav-nothing">{NOTHING_PENDING}</div>}
          {lines.map((line) => (
            <a key={line.key} className="lnav-it lnav-pend" role="button" onClick={() => onPending?.(line)}
              title={`${line.label} · ${line.text}${line.ids.length > 2 ? `：${line.ids.join("、")}` : ""}`} data-testid={`nav-pending-${line.key}`}>
              <span className="i">{PENDING_ICONS[line.key]}<span className="lnav-dot" data-testid="nav-dot" /></span>
              <span className="n">{line.label}</span><span className="c">{line.text}</span>
            </a>
          ))}
        </div>
      )}

      <div className="lnav-sec" data-testid="nav-reference">
        <div className="t">参考</div>
        {knowledge !== undefined && (
          <a className="lnav-it" href={href.knowledge()} title="知识库" data-testid="nav-knowledge">
            <span className="i"><BookOutlined /></span><span className="n">知识库</span>{knowledge && <span className="c">{knowledge}</span>}
          </a>
        )}
        <div className="lnav-it off" title="全局查找还没有做" aria-disabled="true" data-testid="nav-search">
          <span className="i"><SearchOutlined /></span><span className="n">查找</span><span className="c">⌘K</span>
        </div>
      </div>

      <div className="sp" />
      <div className="lnav-ft">
        <a className="lnav-it" role="button" onClick={openSettings} title="设置" data-testid="rail-settings">
          <span className="i"><SettingOutlined /></span><span className="n">设置</span>
        </a>
        <a className="lnav-it" role="button" onClick={toggle} title={open ? "收起导航栏" : "展开导航栏"} data-testid="nav-toggle">
          <span className="i">{open ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}</span><span className="n">收起</span>
        </a>
      </div>
    </nav>
  );
}
