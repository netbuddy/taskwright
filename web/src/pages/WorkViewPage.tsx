// 工作视图：结构与样式照设计原型——顶栏（任务名 · 会话名、任务状态、会话菜单），左边细导航条，
// 对话区、条目区、文档区三栏；宽度不到 1420 时文档区默认收起成竖排的「材料原文」标签页，用户自己开合过之后就不再自动改。
// 数据按接口约定：先连事件流、再读整份数据、之后只听事件；说话与直接操作的响应只当作接受或拒绝。

import { useEffect, useRef, useState } from "react";
import { App as AntApp } from "antd";
import { api, ApiError, clientId } from "../api/client";
import type { ActionRequest, Item, MessageRequest, SessionListEntry, UiActionNoted } from "../api/types";
import { useWorkView } from "../state/useWorkView";
import { Conversation } from "../components/work/Conversation";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { MaterialPane, type LocateRequest } from "../components/work/MaterialPane";
import { DocumentModal } from "../components/DocumentModal";
import { errorText } from "../components/work/errors";
import { formatTime } from "../model/format";
import { justChanged } from "../model/changes";
import { go, href } from "../router";

/** 窄于这个宽度时文档区默认收起。 */
const DOC_OPEN_MIN_WIDTH = 1420;

/** 「让助手改这一条」与「回答这个问题」预填的话。 */
export const PREFILL = {
  revise: (itemId: string) => `请修改 ${itemId}：`,
  answer: (itemId: string, matter: string) => `关于 ${itemId}「${matter}」：`,
};

export function WorkViewPage({ taskId, sessionId }: { taskId: string; sessionId: string }) {
  const { state, dispatch, stream, loadError } = useWorkView(taskId, sessionId);
  const [selected, setSelected] = useState<string | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busyError, setBusyError] = useState<string | null>(null);
  const [docCollapsed, setDocCollapsed] = useState(() => window.innerWidth < DOC_OPEN_MIN_WIDTH);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [locate, setLocate] = useState<LocateRequest | null>(null);
  const userToggledDoc = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const { message } = AntApp.useApp();

  const task = state.task;
  const closed = !!task && task.status !== "进行中";
  const executor = state.executor;
  const busyElsewhere = !!executor && executor.state === "working" && !!executor.active_session && executor.active_session !== sessionId;
  const busySession = sessions.find((s) => s.session_id === executor?.active_session)?.name;
  const disabledReason = closed ? "这个任务已经结束，只能查看。"
    : busyElsewhere || busyError ? `执行者正在${busySession ? `会话「${busySession}」` : "另一条会话"}里工作，做完才能在这里继续。`
    : executor?.state === "failed_to_start" || executor?.state === "exited" ? `助手现在不可用：${executor.text}`
    : null;

  useEffect(() => { api.listSessions(taskId).then(setSessions).catch(() => setSessions([])); }, [taskId, state.session?.name]);
  useEffect(() => { if (!busyElsewhere) setBusyError(null); }, [busyElsewhere]);
  // 新加了材料（material_added 事件）：展开文档区，由文档区选中它显示正文。
  useEffect(() => { if (state.focusMaterial) setDocCollapsed(false); }, [state.focusMaterial]);
  useEffect(() => {
    const onResize = () => { if (!userToggledDoc.current) setDocCollapsed(window.innerWidth < DOC_OPEN_MIN_WIDTH); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".smenu, .smenu-btn")) setMenuOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);

  const toggleDoc = (collapsed: boolean) => { userToggledDoc.current = true; setDocCollapsed(collapsed); };

  const send = async (text: string, card?: MessageRequest["card"]) => {
    const id = clientId();
    // 附件随用户自己打的下一句话发出；点卡片发出的话不带附件（docs/api.md §5.1）。
    const withFiles = card ? [] : attachments;
    if (!card) setAttachments([]);
    dispatch({ type: "outgoing", message: { client_id: id, text, state: "sending" } });
    try {
      const r = await api.sendMessage(taskId, sessionId, { text, client_id: id, attachments: withFiles, ...(card ? { origin: "card_choice", card } : {}) });
      dispatch({ type: "outgoing_update", client_id: id, patch: { state: "sent", queued: r.queued } });
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError("network", String(e));
      if (error.code === "session_busy") setBusyError(errorText(error));
      dispatch({ type: "outgoing_update", client_id: id, patch: { state: "failed", error: errorText(error) } });
    }
  };

  const submit = async (req: Pick<ActionRequest, "kind" | "targets" | "fields" | "notify_executor">, label: string): Promise<ApiError | null> => {
    try {
      const r = await api.action(taskId, sessionId, { client_id: clientId(), task_id: taskId, ...req });
      dispatch({ type: "op_pending", op_id: r.op_id, label, items: req.targets.map((t) => t.item_id).filter(Boolean) as string[] });
      return null;
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError("network", String(e));
      if (error.code === "session_busy") setBusyError(errorText(error));
      return error;
    }
  };

  const cardHandlers = {
    onAction: (req: Pick<ActionRequest, "kind" | "targets" | "notify_executor">, label: string) => {
      void submit(req, label).then((e) => { if (e) message.error(errorText(e)); });
    },
    onMessage: (text: string, card?: MessageRequest["card"]) => void send(text, card),
  };

  const attach = async (file: File) => {
    try {
      const r = await api.uploadMaterial(taskId, file, sessionId);
      setAttachments((a) => [...a, r.path]);
      message.success(`已上传：${r.path}。它会随你的下一句话一起交给助手。`);
    } catch (e) {
      message.error(e instanceof ApiError ? errorText(e) : "上传没有成功。");
    }
  };

  const revisionOf = (note: UiActionNoted) =>
    (note as UiActionNoted & { revision_no?: number }).revision_no ?? (note.event_seq != null ? state.revisionBySeq[note.event_seq] ?? null : null);

  const newSession = async () => {
    setMenuOpen(false);
    try {
      const { session_id } = await api.createSession(taskId);
      go(href.work(taskId, session_id));
    } catch (e) {
      message.error(e instanceof ApiError ? errorText(e) : "新建会话没有成功。");
    }
  };

  /** 预填对话区输入框并把光标放到末尾，用户接着写（「让助手改这一条」「回答这个问题」）。 */
  const prefill = (text: string) => {
    setDraft(text);
    setTimeout(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(text.length, text.length); } }, 0);
  };
  const answer = (item: Item) => {
    const def = task?.definition.collections.find((c) => c.name === item.collection);
    const first = def?.fields[0]?.name;
    prefill(PREFILL.answer(item.item_id, first ? String(item.fields[first] ?? item.title) : item.title));
  };
  const locateSource = (excerpt: string, locator: string) => {
    setDocCollapsed(false);
    setLocate((l) => ({ excerpt, locator, nonce: (l?.nonce ?? 0) + 1 }));
  };

  // 会话名由后端按第一句话起，整份数据里拿到之前先用会话列表里的，都没有时写「新会话」。
  const sessionName = state.session?.name || sessions.find((s) => s.session_id === sessionId)?.name || "新会话";
  const pendingItems = new Set(Object.values(state.pendingOps).flatMap((p) => p.items));
  const blocks = [...state.rebuiltBlocks, ...state.changeBlocks];
  const just = justChanged(blocks);

  if (loadError && state.phase === "waiting_snapshot" && !task) {
    return <div className="wv-page"><div className="app"><div className="empty">读不到这条会话的数据：{loadError}</div></div></div>;
  }

  return (
    <div className="wv-page">
      <div className={`app ${docCollapsed ? "doc-closed" : "doc-open"}`}>
        <div className="topbar">
          <a className="tname" href={href.task(taskId)}>{task?.task_name ?? "…"}</a>
          <span className="tsep">·</span>
          <span className="sname">{sessionName}</span>
          {task && <span className="chip">{task.status === "进行中" ? "任务进行中" : `任务${task.status}`}</span>}
          {Object.keys(state.pendingOps).length > 0 && <span className="chip warn">正在保存：{Object.values(state.pendingOps).map((p) => p.label).join("；")}</span>}
          <span className="smenu-btn" role="button" onClick={() => setMenuOpen(!menuOpen)} data-testid="session-menu-button">会话 ▾</span>
          <div className={`smenu${menuOpen ? " show" : ""}`} data-testid="session-menu">
            <div className="mh">任务「{task?.task_name}」的会话（共 {sessions.length} 条，所有会话共享同一份交付物）</div>
            {sessions.map((s) => (
              <div key={s.session_id} className="srow" role="button" onClick={() => { setMenuOpen(false); if (s.session_id !== sessionId) go(href.work(taskId, s.session_id)); }}>
                <span className="sn">{s.name}</span>
                {s.session_id === sessionId && <span className="chip on">当前打开</span>}
                {s.active && <span className="chip okc">活动中</span>}
                <span className="st">最近活动 {formatTime(s.last_active_at)} · {s.message_count} 条消息</span>
              </div>
            ))}
            {!closed && <div className="srow newrow" role="button" onClick={() => void newSession()}>＋ 新建会话（让助手从干净的上下文开始，交付物还是这一份）</div>}
          </div>
        </div>
        <div className="app-body">
          <div className="rail">
            <div className="ico" title="全局检索（还没有做）">⌕</div>
            <a className="ico on" title="当前任务：回到任务页" href={href.task(taskId)}>▣</a>
            <div className="ico" title="材料原文：展开或收起文档区" role="button" style={{ cursor: "pointer" }} onClick={() => toggleDoc(!docCollapsed)}>▤</div>
            <div className="sp" />
            <div className="ico" title="设置（还没有做）">◉</div>
          </div>

          <div className="chat">
            <div className="chat-h"><b>{sessionName}</b><span className="chip">本任务共 {sessions.length} 条会话</span></div>
            {state.problems.map((p, i) => (
              <div key={i} className="problem">{p.text}<span className="x" role="button" onClick={() => dispatch({ type: "dismiss_problem", index: i })}>×</span></div>
            ))}
            {!task && state.phase === "waiting_snapshot" ? <div className="msgs"><div className="selfnote">正在读这条会话。</div></div> : (
              <Conversation
                messages={state.messages} currentWork={state.currentWork} outgoing={state.outgoing} task={task}
                disabled={!!disabledReason} disabledReason={disabledReason} handlers={cardHandlers}
                onSend={(t) => void send(t)} onUndo={(rev) => void submit({ kind: "undo", targets: [{ revision_no: rev }], notify_executor: false }, `撤销第 ${rev} 次修订`).then((e) => { if (e) message.error(errorText(e)); })}
                onOpenItem={setSelected} onAttach={attach} revisionOf={revisionOf} attachments={attachments}
                draft={draft} onDraft={setDraft} inputRef={input} blocks={blocks} onOpenDiff={setSelected}
                onLocate={(excerpt) => locateSource(excerpt, "")}
                hasEarlier={state.hasEarlier}
                onLoadEarlier={() => state.earliestId && api.earlierConversation(taskId, sessionId, state.earliestId).then((c) =>
                  dispatch({ type: "earlier", messages: c.messages, hasEarlier: c.has_earlier, earliestId: c.earliest_id }))}
              />
            )}
          </div>

          <div className="stage-col">
            <div className={`netbar${stream === "reconnecting" ? " show" : ""}`}>
              <span className="spin" /><span>与服务器的连接断了，正在重连……你照常可以看和改，连上之后会补上断开期间的变化。</span>
            </div>
            <div className="work">
              {task ? (
                <ItemsPanel task={task} readOnly={closed || !!disabledReason} recentlyChanged={state.recentlyChanged} justChanged={just}
                  pendingItems={pendingItems} selected={selected} onSelect={setSelected} submit={submit} onGenerateDoc={() => setDocOpen(true)}
                  onLocate={locateSource} onAskAssistant={(id) => prefill(PREFILL.revise(id))} onAnswer={answer} />
              ) : <div className="pane-items" />}
              <div className="pane-doc">
                <MaterialPane taskId={taskId} materials={state.materials} focusPath={state.focusMaterial} onCollapse={() => toggleDoc(true)}
                  items={task?.items ?? []} locate={locate} currentItem={selected} disabled={!!disabledReason}
                  onOpenItem={setSelected} onSend={(t) => void send(t)} />
                <div className="handle" role="button" title="展开文档区" onClick={() => toggleDoc(false)} data-testid="doc-handle">
                  <span className="harrow">◂</span><span>材料原文</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {task && <DocumentModal task={task} open={docOpen} onClose={() => setDocOpen(false)} />}
    </div>
  );
}
