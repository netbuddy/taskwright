// 全站左边的导航栏，三种页面共用：工作视图；任务一级的页面（任务起点页、活动输入页，components/TaskFrame.tsx）；
// 没有任务的页面（任务列表页、知识库页，components/Shell.tsx）。回答「在哪个任务、流程走到哪一站、哪条会话、有什么事等我处理」。
// 自上而下：任务（「任务列表」回列表；任务名去任务起点页，没有任务的页面没有这一行）、工作（流程进度与会话列表）、
// 待处理事项（三行）、参考（知识库、查找），底部本机用户、设置与收起。工作与待处理事项两段页面没有给数据时不画（没有任务的页面都不画）。
// 展开约 248px、收起约 56px 只留图标（悬停出全名），宽度是 styles.css 的 --w-nav 与 --w-nav-closed；收起时各组图标之间有分隔线，红点保留。
// 会话按建立时间倒序，当前会话在它的时间位置上高亮；列表末尾有开关「显示已归档的会话」：默认关着；打开时另取一次带归档的会话清单，
// 归档的接在后面、标「已归档」，也能点开（打开后按自由讨论办）。
// 开合与各段的口径在 model/leftNav.ts；除了归档的会话，数据都由页面给。

import { Fragment, useEffect, useState } from "react";
import {
  ApartmentOutlined, BookOutlined, EyeOutlined, FlagOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
  MessageOutlined, PlusOutlined, ProjectOutlined, QuestionCircleOutlined, SearchOutlined, SettingOutlined, UnorderedListOutlined,
} from "@ant-design/icons";
import { api } from "../../api/client";
import type { KnowledgeLibrary, SessionListEntry, StageView, Task } from "../../api/types";
import { formatTime } from "../../model/format";
import {
  NOTHING_PENDING, flowProgress, foldSessions, initialLeftNavOpen, knowledgeText, pendingLines, saveLeftNav, sessionKind, sessionRows, type PendingLine,
} from "../../model/leftNav";
import { SHOW_ARCHIVED, SHOW_ARCHIVED_NOTE, withArchived } from "../../model/sessionTag";
import { go, href, openSettings } from "../../router";
import { UserMenu } from "../ServiceControls";

/** 「＋ 新会话」悬停时的说明：新建的是自由讨论的会话。 */
export const NEW_SESSION_TITLE = "新建一条会话：自由讨论，不绑定活动；交付物还是这一份";

const PENDING_ICONS = { decisions: <FlagOutlined />, questions: <QuestionCircleOutlined />, review: <EyeOutlined /> };

/** 会话的建立时间写成「10-15 19:22」；没有时不写。 */
const shortTime = (iso: string | null | undefined) => (iso ? formatTime(iso).slice(5) : "");

/** 这一页是哪一种：高亮「任务列表」「任务名」或「知识库」那一行。 */
export type NavHere = "tasks" | "task" | "knowledge" | null;

export function LeftNav({ here = null, taskId, taskName, stage, task, sessions, currentSessionId = null, currentSessionName, onNewSession, libraries, onPending }: {
  here?: NavHere;
  /** 任务编号；没有任务的页面（任务列表页、知识库页）不给，这时任务名一行、工作与待处理事项两段都不画。 */
  taskId?: string;
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
  libraries?: Pick<KnowledgeLibrary, "documents">[] | null;
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
    if (!showArchived || !taskId) return;
    let live = true;
    api.listSessions(taskId, true).then((all) => { if (live) setArchived(all); }).catch(() => { if (live) setArchived([]); });
    return () => { live = false; };
  }, [showArchived, taskId]);

  const withTask = taskId ? taskId : null;
  const progress = withTask ? flowProgress(stage, sessions) : null;
  const rows = withTask && sessions ? sessionRows(sessions) : null;
  // 当前会话还不在清单里（刚新建、清单还没读回来）：排在最前。
  const missingCurrent = !!rows && !!currentSessionId && !rows.some((one) => one.session_id === currentSessionId);
  const live = rows ? (allSessions ? rows : foldSessions(rows, currentSessionId)) : [];
  const hidden = rows ? rows.length - live.length : 0;
  const listed = withArchived(live, showArchived ? archived : null);
  const lines = withTask && task ? pendingLines(task) : null;
  const knowledge = libraries === undefined ? undefined : knowledgeText(libraries);
  const pick = (id: string) => { if (withTask && id !== currentSessionId) go(href.work(withTask, id)); };

  const currentRow = (name: string) => (
    <a className="lnav-it on" title={`当前会话 · ${name}`} data-testid="nav-current-session">
      <span className="i"><MessageOutlined /></span><span className="n">当前会话 · {name}</span>
    </a>
  );

  return (
    <nav className={`lnav ${open ? "open" : "closed"}`} data-testid="left-nav">
      <div className="lnav-body">
        <div className="lnav-sec" data-testid="nav-tasks-group">
          <div className="t">任务实例</div>
          <a className={`lnav-it${here === "tasks" ? " on" : ""}`} href={href.tasks()} title="任务实例列表" data-testid="nav-tasks">
            <span className="i"><UnorderedListOutlined /></span><span className="n">任务实例列表</span>
          </a>
          {withTask && (
            <a className={`lnav-it${here === "task" ? " on" : ""}`} href={href.task(withTask)} title={`任务起点：${taskName ?? ""}`} data-testid="nav-task">
              <span className="i"><ProjectOutlined /></span><span className="n">{taskName ?? "…"}</span>
            </a>
          )}
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
            {missingCurrent && currentRow(currentSessionName || "新会话")}
            {listed.map((one) => {
              if (one.session_id === currentSessionId && !one.archived) return <Fragment key={one.session_id}>{currentRow(one.name || currentSessionName || "新会话")}</Fragment>;
              const kind = sessionKind(one);
              return (
                <a key={one.session_id} className={`lnav-it sub sess${one.archived ? " archived" : ""}`} role="button" onClick={() => pick(one.session_id)} title={one.name || "新会话"} data-testid="nav-session">
                  <span className="n">{one.name || "新会话，还没有说过话。"}</span>
                  <span className="c">{kind && <span className="kind" data-testid="nav-session-tag">{kind}</span>}{shortTime(one.started_at)}</span>
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
            <a className={`lnav-it${here === "knowledge" ? " on" : ""}`} href={href.knowledge()} title={`知识库${knowledge ? ` · ${knowledge}` : ""}`} data-testid="nav-knowledge">
              <span className="i"><BookOutlined /></span><span className="n">知识库</span>{knowledge && <span className="c">{knowledge}</span>}
            </a>
          )}
          <div className="lnav-it off" title="全局查找还没有做" aria-disabled="true" data-testid="nav-search">
            <span className="i"><SearchOutlined /></span><span className="n">查找</span><span className="c">⌘K</span>
          </div>
        </div>
      </div>

      <div className="lnav-ft">
        <UserMenu collapsed={!open} />
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
