// 工作视图：结构与样式照设计原型——顶栏（任务名 · 会话名、任务状态、字号三档、会话菜单），左边细导航条，
// 对话区、条目区、右侧栏三栏；视口不到 100rem 宽时右侧栏默认收起成竖排的把手，用户自己开合过之后就不再自动改。
// 数据按接口约定：先连事件流、再读整份数据、之后只听事件；说话与直接操作的响应只当作接受或拒绝。
//
// 单一写入者：任一时刻交付物只有一个写入者。
//   · 执行者工作中（executor.state 为 working）：条目区写入全部灰化并有横幅；对话区发送灰化，输入框照常能打字留草稿（第 2B 节）。
//   · 有未保存的条目编辑（编辑框打开且内容与打开时不同）：对话区发送键与卡片按钮灰化，提示先保存或取消。
// 修订的呈现（第 2A 节第三版）：右侧栏「修订」页签是修订日志；回复底部「产生了修订 N」标签点过去；条目自上次确认以来
// 助手改过的字段加框（字段修订标识）；执行者最近一次运行改过的条目带「刚改」（都在 model/revisions.ts）。

import { useEffect, useMemo, useRef, useState } from "react";
import { App as AntApp } from "antd";
import { api, ApiError, clientId } from "../api/client";
import type { ActionRequest, AssistantReply, Item, MessageRequest, SessionListEntry, UiActionNoted } from "../api/types";
import { useWorkView } from "../state/useWorkView";
import { Conversation } from "../components/work/Conversation";
import { ItemsPanel } from "../components/work/ItemsPanel";
import type { ViewRequest } from "../components/work/ItemDetail";
import type { LocateRequest } from "../components/work/MaterialPane";
import { SidePanel, type SideTab } from "../components/work/SidePanel";
import { DocumentModal } from "../components/DocumentModal";
import { errorText } from "../components/work/errors";
import { formatTime } from "../model/format";
import { FONT_TIERS, narrowViewport, readFontTier, saveFontTier, type FontTier } from "../model/fontScale";
import { justChangedItems, marksByItem, revisionsOfReply, touchedItems } from "../model/revisions";
import { viewTarget } from "../model/items";
import { go, href } from "../router";

/** 「让助手改这一条」与「回答这个问题」预填的话。 */
export const PREFILL = {
  revise: (itemId: string) => `请修改 ${itemId}：`,
  answer: (itemId: string, matter: string) => `关于 ${itemId}「${matter}」：`,
};

export function WorkViewPage({ taskId, sessionId }: { taskId: string; sessionId: string }) {
  const { state, log, dispatch, stream, loadError } = useWorkView(taskId, sessionId);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ open: boolean; revision: number | null }>({ open: false, revision: null });
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busyError, setBusyError] = useState<string | null>(null);
  const [docCollapsed, setDocCollapsed] = useState(narrowViewport);
  const [side, setSide] = useState<SideTab>("material");
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);
  const [view, setView] = useState<ViewRequest | null>(null);
  /** 卡片上点「还有 N 条未读 · 筛出来看」的次数：条目区据此切到「未读」筛选。 */
  const [unreadRequest, setUnreadRequest] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [fontTier, setFontTier] = useState<FontTier>(readFontTier);
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
  const working = executor?.state === "working";
  const busySession = sessions.find((s) => s.session_id === executor?.active_session)?.name;
  const disabledReason = closed ? "这个任务已经结束，只能查看。"
    : busyElsewhere || busyError ? `助手正在${busySession ? `会话「${busySession}」` : "另一条会话"}里工作，做完才能在这里继续。`
    : executor?.state === "failed_to_start" || executor?.state === "exited" ? `助手现在不可用：${executor.text}`
    : null;
  // 任务结束或助手不可用：一切写入都不能做。执行者工作中另算（writesOff），预填输入框的两个按钮那时照常可用。
  const readOnly = closed || (!!disabledReason && !busyElsewhere && !busyError);

  useEffect(() => { api.listSessions(taskId).then(setSessions).catch(() => setSessions([])); }, [taskId, state.session?.name]);
  useEffect(() => { if (!busyElsewhere) setBusyError(null); }, [busyElsewhere]);
  // 新加了材料（material_added 事件）：展开右侧栏、切到材料页签，由材料页签选中它显示正文。
  useEffect(() => { if (state.focusMaterial) { setDocCollapsed(false); setSide("material"); } }, [state.focusMaterial]);
  useEffect(() => {
    const onResize = () => { if (!userToggledDoc.current) setDocCollapsed(narrowViewport()); };
    window.addEventListener("resize", onResize);
    window.addEventListener("taskwright:font-tier", onResize);
    return () => { window.removeEventListener("resize", onResize); window.removeEventListener("taskwright:font-tier", onResize); };
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".smenu, .smenu-btn")) setMenuOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);
  // 切到别的条目、回到列表时编辑框关掉，未保存的编辑也就不在了。
  useEffect(() => { if (!selected) setDirty(false); }, [selected]);

  const toggleDoc = (collapsed: boolean) => { userToggledDoc.current = true; setDocCollapsed(collapsed); };

  const send = async (text: string, card?: MessageRequest["card"]) => {
    const id = clientId();
    // 附件随用户自己打的下一句话发出；点卡片发出的话不带附件（docs/api.md §5.1）。
    const withFiles = card ? [] : attachments;
    if (!card) setAttachments([]);
    dispatch({ type: "outgoing", message: { client_id: id, text, state: "sending" } });
    try {
      await api.sendMessage(taskId, sessionId, { text, client_id: id, attachments: withFiles, ...(card ? { origin: "card_choice", card } : {}) });
      dispatch({ type: "outgoing_update", client_id: id, patch: { state: "sent" } });
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError("network", String(e));
      if (error.code === "session_busy" && error.data.reason !== "working") setBusyError(errorText(error));
      dispatch({ type: "outgoing_update", client_id: id, patch: { state: "failed", error: errorText(error) } });
    }
  };

  const submit = async (req: Pick<ActionRequest, "kind" | "targets" | "fields" | "notify_executor">, label: string): Promise<ApiError | null> => {
    try {
      const r = await api.action(taskId, sessionId, { client_id: clientId(), task_id: taskId, ...req });
      // 标为已读不改内容，不显示「正在保存」；都已读过时后端什么都不写、没有库事件，挂着的话会一直等不到。
      if (req.kind !== "mark_viewed") dispatch({ type: "op_pending", op_id: r.op_id, label, items: req.targets.map((t) => t.item_id).filter(Boolean) as string[] });
      return null;
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError("network", String(e));
      if (error.code === "session_busy" && error.data.reason !== "working") setBusyError(errorText(error));
      return error;
    }
  };
  /**
   * 用户打开一个条目的详情（列表、上一条下一条、对话与卡片里的条目、修订页签的查看差异，都是用户点的）：
   * 要求看过的集合里还是未读的，就在它当前所在的修订上记为已读。不显示「正在保存」，不报错：
   * 没记上时条目照旧显示未读，再打开一次就会重记。
   */
  const openItem = (itemId: string | null) => {
    setSelected(itemId);
    const target = viewTarget(state.task, itemId);
    if (!target) return;
    void api.action(taskId, sessionId, { client_id: clientId(), task_id: taskId, kind: "mark_viewed", targets: [target], notify_executor: false })
      .catch(() => undefined);
  };
  const undo = (revision: number) =>
    void submit({ kind: "undo", targets: [{ revision_no: revision }], notify_executor: false }, `撤销修订 ${revision}`).then((e) => { if (e) message.error(errorText(e)); });

  const cardHandlers = {
    onAction: (req: Pick<ActionRequest, "kind" | "targets" | "notify_executor">, label: string) => {
      void submit(req, label).then((e) => { if (e) message.error(errorText(e)); });
    },
    onMessage: (text: string, card?: MessageRequest["card"]) => void send(text, card),
    onShowUnread: () => setUnreadRequest((n) => n + 1),
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
    setSide("material");
    setLocate((l) => ({ excerpt, locator, nonce: (l?.nonce ?? 0) + 1 }));
  };
  /** 回复底部「产生了修订 N」：右侧栏展开并切到修订页签，选中其中最新的一次，滚到那里。 */
  const showRevisions = (revisions: number[]) => {
    setDocCollapsed(false);
    setSide("rev");
    setSelectedRevision(revisions[revisions.length - 1]);
    setScrollNonce((n) => n + 1);
  };
  /** 修订卡片上的「查看差异」：打开这个条目，停在那次修订，画线的地方是和它上一次改动的差别。 */
  const openDiff = (itemId: string, revision: number) => {
    openItem(itemId);
    setView((v) => ({ itemId, revision, nonce: (v?.nonce ?? 0) + 1 }));
  };
  const chooseFont = (tier: FontTier) => { setFontTier(tier); saveFontTier(tier); };

  // 会话名由后端按第一句话起，整份数据里拿到之前先用会话列表里的，都没有时写「新会话」。
  const sessionName = state.session?.name || sessions.find((s) => s.session_id === sessionId)?.name || "新会话";
  const pendingItems = new Set(Object.values(state.pendingOps).flatMap((p) => p.items));
  const marks = useMemo(() => (task ? marksByItem(task.items, log) : {}), [task?.items, log]);
  const just = useMemo(() => (task ? justChangedItems(task.items, log) : new Set<string>()), [task?.items, log]);
  const hitEntry = selectedRevision != null ? log.find((r) => r.revision_no === selectedRevision) ?? null : null;
  const hit = hitEntry ? { revision: hitEntry.revision_no, items: touchedItems(hitEntry) } : null;
  const latestRevision = Math.max(state.latestRevision, log[0]?.revision_no ?? 0);

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
          <span className="sw-fs" title="字号：根字号随视口流动，这里再选一档" data-testid="font-tiers">
            字号{FONT_TIERS.map((t) => (
              <a key={t.key} className={fontTier === t.key ? "on" : undefined} role="button" onClick={() => chooseFont(t.key)} data-testid={`font-${t.key}`}>{t.label}</a>
            ))}
          </span>
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
            <div className="ico" title="材料、文档与修订：展开或收起右侧栏" role="button" style={{ cursor: "pointer" }} onClick={() => toggleDoc(!docCollapsed)}>▤</div>
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
                hold={dirty} working={working}
                onSend={(t) => void send(t)} onUndo={undo}
                onOpenItem={openItem} onAttach={attach} revisionOf={revisionOf} attachments={attachments}
                draft={draft} onDraft={setDraft} inputRef={input}
                revisionsOfReply={(reply: AssistantReply) => revisionsOfReply(reply, log)} onRevisionTag={showRevisions}
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
                <ItemsPanel task={task} readOnly={readOnly} writesOff={working} recentlyChanged={state.recentlyChanged} marks={marks} just={just}
                  pendingItems={pendingItems} selected={selected} onSelect={openItem} submit={submit} onGenerateDoc={() => setDoc({ open: true, revision: null })}
                  onLocate={locateSource} onAskAssistant={(id) => prefill(PREFILL.revise(id))} onAnswer={answer} onSend={(t) => void send(t)}
                  hit={hit} onClearHit={() => setSelectedRevision(null)} view={view} latestRevision={latestRevision} onDirty={setDirty}
                  unreadRequest={unreadRequest} />
              ) : <div className="pane-items" />}
              <div className="pane-doc">
                <SidePanel side={side} onSide={setSide} onCollapse={() => toggleDoc(true)} onExpand={() => toggleDoc(false)}
                  taskId={taskId} materials={state.materials} focusPath={state.focusMaterial} items={task?.items ?? []} locate={locate}
                  currentItem={selected} disabled={!!disabledReason || working} onOpenItem={openItem} onSend={(t) => void send(t)}
                  log={log} messages={state.messages} selectedRevision={selectedRevision} onSelectRevision={setSelectedRevision} scrollNonce={scrollNonce}
                  onDiff={openDiff} onUndo={undo} onGenerate={(revision) => setDoc({ open: true, revision: revision ?? null })}
                  writesOff={working} readOnly={readOnly} />
              </div>
            </div>
          </div>
        </div>
      </div>
      {task && <DocumentModal task={task} log={log} open={doc.open} revision={doc.revision} onClose={() => setDoc({ open: false, revision: null })} />}
    </div>
  );
}
