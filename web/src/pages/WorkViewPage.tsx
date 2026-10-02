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
import { SettingOutlined } from "@ant-design/icons";
import { api, ApiError, clientId } from "../api/client";
import type { ActionRequest, AssistantReply, Item, KnowledgeLibrary, MessageRequest, SessionListEntry, UiActionNoted } from "../api/types";
import { useWorkView } from "../state/useWorkView";
import { Conversation } from "../components/work/Conversation";
import { ItemsPanel } from "../components/work/ItemsPanel";
import type { ViewRequest } from "../components/work/ItemDetail";
import type { LocateRequest } from "../components/work/MaterialPane";
import { SidePanel, type SideTab } from "../components/work/SidePanel";
import { ReviewPanel } from "../components/work/ReviewPanel";
import { DocumentModal } from "../components/DocumentModal";
import { errorText } from "../components/work/errors";
import { formatTime } from "../model/format";
import { FONT_TIERS, narrowViewport, readFontTier, saveFontTier, type FontTier } from "../model/fontScale";
import { justChangedItems, marksByItem, revisionsOfReply, revisionsOfWork, touchedItems } from "../model/revisions";
import { openProblems, viewTarget } from "../model/items";
import { showSubmitBar } from "../model/submit";
import { go, href, openSettings } from "../router";
import { useToast } from "../components/Toasts";
import { NoModelBanner, UserMenu, useService } from "../components/ServiceControls";
import { useConnectionToast, useProblemToasts, useReviewToast } from "../components/work/workToasts";
import { tooLargeText, unsupportedTypeText } from "../model/upload";
import { executorHint } from "../components/work/executorHint";
import { KnowledgeContext } from "../state/knowledge";
import { KnowledgeDocModal, type KnowledgeDocRequest } from "../components/work/KnowledgeDocModal";
import { isKnowledgeLocator } from "../model/knowledge";

/** 「让助手改这一条」与「回答这个问题」预填的话。 */
export const PREFILL = {
  revise: (itemId: string) => `请修改 ${itemId}：`,
  answer: (itemId: string, matter: string) => `关于 ${itemId}「${matter}」：`,
};

export function WorkViewPage({ taskId, sessionId, collection = null }: {
  taskId: string;
  sessionId: string;
  /** 地址里带的集合名（从任务页的集合卡点进来）：条目区一打开就停在这个集合的页签。 */
  collection?: string | null;
}) {
  const { state, log, dispatch, stream, loadError, loadErrorCode } = useWorkView(taskId, sessionId);
  const missing = useMissingSession(taskId, sessionId, !state.task && loadErrorCode === "not_found");
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
  const toast = useToast();
  const service = useService();
  // 知识库清单：来源卡片据此把出处里的知识库编号换成名字、判断文档还在不在。知识库的增删不推送事件，
  // 所以进入工作视图时取一次，浏览器窗口重新得到焦点时再取一次。服务没有知识库时是空清单；还没取到时是 null。
  const [libraries, setLibraries] = useState<KnowledgeLibrary[] | null>(null);
  const hasKnowledge = service.info ? !!service.info.capabilities.knowledge : null;
  useEffect(() => {
    if (hasKnowledge === null) return;
    if (!hasKnowledge) { setLibraries([]); return; }
    const load = () => { api.knowledge().then(setLibraries).catch(() => undefined); };
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [hasKnowledge]);
  /** 正在看原文的那条知识库来源；没有在看时为 null。 */
  const [knowledgeDoc, setKnowledgeDoc] = useState<KnowledgeDocRequest | null>(null);

  const task = state.task;
  const closed = !!task && task.status !== "进行中";
  const executor = state.executor;
  const busyElsewhere = !!executor && executor.state === "working" && !!executor.active_session && executor.active_session !== sessionId;
  const working = executor?.state === "working";
  const busySession = sessions.find((s) => s.session_id === executor?.active_session)?.name;
  const disabledReason = closed ? "这个任务已经结束，只能查看。"
    : busyElsewhere || busyError ? `助手正在${busySession ? `会话「${busySession}」` : "另一条会话"}里工作，做完才能在这里继续。`
    : executor?.state === "failed_to_start" ? `助手现在不可用：${executor.text}`
    : null;
  // 任务结束或助手启动不起来：一切写入都不能做。执行者工作中另算（writesOff），预填输入框的两个按钮那时照常可用。
  // 助手已经退出、还没启动、正在启动时不设只读：说话与操作都会让服务先把助手启动起来，只在输入框上方提示一句（executorHint.ts）。
  const hint = executorHint(executor, state.outgoing.some((m) => m.state === "sending"));
  const readOnly = closed || (!!disabledReason && !busyElsewhere && !busyError);

  // 会话列表（会话菜单里每条会话的最近活动与消息条数）：打开页面、会话改名、助手做完一轮（执行者状态从工作中变为不在工作）、
  // 打开会话菜单时各读一次；不定时轮询。执行者状态属于整个任务，别的会话里做完一轮也会重读。
  const loadSessions = () => { api.listSessions(taskId).then(setSessions).catch(() => setSessions([])); };
  useEffect(loadSessions, [taskId, state.session?.name]);
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) loadSessions();
    wasWorking.current = working;
  }, [working]);
  useEffect(() => { if (menuOpen) loadSessions(); }, [menuOpen]);
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

  /** 发出一句话。返回真＝发出去了；假＝没有发出去（那句话留在对话区写明原因，发起的输入框还空着时把原文放回去）。 */
  const send = async (text: string, card?: MessageRequest["card"]): Promise<boolean> => {
    const id = clientId();
    // 附件随用户自己打的下一句话发出；点卡片发出的话不带附件（docs/api.md §5.1）。
    const withFiles = card ? [] : attachments;
    if (!card) setAttachments([]);
    dispatch({ type: "outgoing", message: { client_id: id, text, state: "sending" } });
    try {
      await api.sendMessage(taskId, sessionId, { text, client_id: id, attachments: withFiles, ...(card ? { origin: "card_choice", card } : {}) });
      dispatch({ type: "outgoing_update", client_id: id, patch: { state: "sent" } });
      return true;
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError("network", String(e));
      if (error.code === "session_busy" && error.data.reason !== "working") setBusyError(errorText(error));
      dispatch({ type: "outgoing_update", client_id: id, patch: { state: "failed", error: errorText(error) } });
      // 那句话留在对话区原处（写着没有发出去的原因，可以重发），另报一条失败提示。
      toast.error(`你的话没有发出去：${errorText(error)}`);
      return false;
    }
  };

  const submit = async (req: Pick<ActionRequest, "kind" | "targets" | "fields" | "notify_executor">, label: string): Promise<ApiError | null> => {
    try {
      const r = await api.action(taskId, sessionId, { client_id: clientId(), task_id: taskId, ...req });
      // 标为已读不改内容，不显示「正在保存」；都已读过时后端什么都不写、没有库事件，挂着的话会一直等不到。
      // 评审也不改内容，进度与结果另有 review_progress、review_finished 两种事件，同样不登记。
      // 提交交付物也不登记：任务变为已完成的事件不带操作编号，挂着的话同样等不到；提交之后任务只读，提示条随之消失。
      if (req.kind !== "mark_viewed" && req.kind !== "request_review" && req.kind !== "submit_deliverable") dispatch({ type: "op_pending", op_id: r.op_id, label, items: req.targets.map((t) => t.item_id).filter(Boolean) as string[] });
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
  /** 发起评审：targets 为空＝全部待评审的条目。后端核对通过就回应，被拒时报一条失败提示。 */
  const review = (targets: { item_id: string; base_revision: number }[], label: string) =>
    void submit({ kind: "request_review", targets, notify_executor: false }, label).then((e) => { if (e) toast.error(errorText(e)); });
  const undo = (revision: number) =>
    void submit({ kind: "undo", targets: [{ revision_no: revision }], notify_executor: false }, `撤销修订 ${revision}`).then((e) => { if (e) toast.error(errorText(e)); });

  const cardHandlers = {
    onAction: (req: Pick<ActionRequest, "kind" | "targets" | "notify_executor">, label: string) => {
      void submit(req, label).then((e) => { if (e) toast.error(errorText(e)); });
    },
    onMessage: (text: string, card?: MessageRequest["card"]) => send(text, card),
    onShowUnread: () => setUnreadRequest((n) => n + 1),
  };

  const attach = async (file: File) => {
    // 类型不符或超过上限的文件不发请求，直接报后端给的那句话（先查类型，与后端的先后相同）。
    const refused = unsupportedTypeText(service.info, file) ?? tooLargeText(service.info, file);
    if (refused) {
      toast.error(refused);
      return;
    }
    try {
      const r = await api.uploadMaterial(taskId, file, sessionId);
      setAttachments((a) => [...a, r.path]);
      toast.success(`已上传：${r.path}。它会随你的下一句话一起交给助手。`);
    } catch (e) {
      toast.error(e instanceof ApiError ? errorText(e) : "上传没有成功。");
    }
  };

  const revisionOf = (note: UiActionNoted) =>
    (note as UiActionNoted & { revision_no?: number }).revision_no ?? (note.event_seq != null ? state.revisionBySeq[note.event_seq] ?? null : null);

  const newSession = async () => {
    setMenuOpen(false);
    try {
      const { session_id } = await api.createSession(taskId);
      toast.success("已新建会话。");
      go(href.work(taskId, session_id));
    } catch (e) {
      toast.error(e instanceof ApiError ? newSessionErrorText(e, sessionId) : "新建会话没有成功。");
    }
  };

  /**
   * 预填对话区输入框并把光标放到末尾，用户接着写（「让助手照这条改」「让助手来改这一条」「回答这个问题」、问题卡片上输入框空着时点「回答」）。
   * 输入框里已经有字时，预填的话接在后面、隔一个换行，不替换，用户打了一半的话不丢；空着（或只有空白）时只放预填的话。
   */
  const prefill = (text: string) => {
    setDraft((d) => (d.trim() ? `${d.replace(/\n+$/, "")}\n${text}` : text));
    setTimeout(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 0);
  };
  const answer = (item: Item) => {
    const def = task?.definition.collections.find((c) => c.name === item.collection);
    const first = def?.fields[0]?.name;
    prefill(PREFILL.answer(item.item_id, first ? String(item.fields[first] ?? item.title) : item.title));
  };
  const locateSource = (excerpt: string, locator: string) => {
    // 出自知识库文档的来源：另开对话框看那份文档，不进「材料」页签（材料页签只放这次要整理的材料）。
    if (isKnowledgeLocator(locator)) {
      setKnowledgeDoc({ excerpt, locator });
      return;
    }
    setDocCollapsed(false);
    setSide("material");
    setLocate((l) => ({ excerpt, locator, nonce: (l?.nonce ?? 0) + 1 }));
  };
  /** 回复底部「产生了修订 N」：右侧栏展开并切到修订页签，选中其中最新的一次，滚到那里。 */
  /** 评审页签里点一条发现：打开条目详情，滚到那个字段并高亮一会儿。 */
  const openFinding = (itemId: string, field: string | null) => {
    openItem(itemId);
    if (!field) return;
    setTimeout(() => {
      const el = document.querySelector(`.detail [data-f="${CSS.escape(field)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.classList.add("sw-hit-field");
      setTimeout(() => el.classList.remove("sw-hit-field"), 2500);
    }, 80);
  };
  /** 对话区里评审结束那一行的「看评审页签」。 */
  const showReviews = () => { toggleDoc(false); setSide("review"); };
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
  useReviewToast(state.review, showReviews);
  useProblemToasts(state.problems);
  useConnectionToast(stream);

  // 会话名由后端按第一句话起，整份数据里拿到之前先用会话列表里的，都没有时写「新会话」。
  const sessionName = state.session?.name || sessions.find((s) => s.session_id === sessionId)?.name || "新会话";
  const pendingItems = new Set(Object.values(state.pendingOps).flatMap((p) => p.items));
  const marks = useMemo(() => (task ? marksByItem(task.items, log) : {}), [task?.items, log]);
  const just = useMemo(() => (task ? justChangedItems(task.items, log) : new Set<string>()), [task?.items, log]);
  const hitEntry = selectedRevision != null ? log.find((r) => r.revision_no === selectedRevision) ?? null : null;
  const hit = hitEntry ? { revision: hitEntry.revision_no, items: touchedItems(hitEntry) } : null;
  const latestRevision = Math.max(state.latestRevision, log[0]?.revision_no ?? 0);

  // 这条会话不存在（任务在、会话列表里没有它）：两行说明，照常带顶栏。最常见的是新建之后没说话就打开了别的会话。
  if (missing && !task) {
    return (
      <div className="wv-page">
        <NoModelBanner />
        <div className="app" data-testid="missing-session">
          <div className="topbar">
            <a className="tname" href={href.task(taskId)}>{missing.taskName}</a>
            <UserMenu where="topbar" />
          </div>
          <div className="empty missing">
            <div>找不到这条会话。还没有说过话的会话，在你打开别的会话之后不会保留。</div>
            <div><a href={href.task(taskId)} data-testid="missing-session-back">回到任务页</a></div>
          </div>
        </div>
      </div>
    );
  }
  if (loadError && state.phase === "waiting_snapshot" && !task) {
    return <div className="wv-page"><div className="app"><div className="empty">读不到这条会话的数据：{loadError}</div></div></div>;
  }

  return (
    <div className="wv-page">
      <NoModelBanner />
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
          <span className="set-btn" role="button" onClick={openSettings} data-testid="open-settings"><SettingOutlined />设置</span>
          <UserMenu where="topbar" />
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
            <div className="ico" title="全局查找（还没有做）">⌕</div>
            <a className="ico on" title="当前任务：回到任务页" href={href.task(taskId)}>▣</a>
            <div className="ico" title="材料、文档与修订：展开或收起右侧栏" role="button" style={{ cursor: "pointer" }} onClick={() => toggleDoc(!docCollapsed)}>▤</div>
            <div className="sp" />
            <div className="ico" title="设置" role="button" style={{ cursor: "pointer" }} onClick={openSettings} data-testid="rail-settings">◉</div>
          </div>

          <div className="chat">
            <div className="chat-h"><b>{sessionName}</b><span className="chip">本任务共 {sessions.length} 条会话</span></div>
            {!task && state.phase === "waiting_snapshot" ? <div className="msgs"><div className="selfnote">正在读这条会话。</div></div> : (
              <Conversation
                messages={state.messages} currentWork={state.currentWork} outgoing={state.outgoing} task={task}
                disabled={!!disabledReason} disabledReason={disabledReason} handlers={cardHandlers}
                hold={dirty} working={working} hint={hint} starting={executor?.state === "starting"}
                onSend={(t) => send(t)} onUndo={undo} onShowReviews={showReviews}
                onOpenItem={openItem} onAttach={attach} revisionOf={revisionOf} attachments={attachments}
                draft={draft} onDraft={setDraft} inputRef={input}
                revisionsOfReply={(reply: AssistantReply) => revisionsOfReply(reply, log)}
                revisionsOfWork={(workId: string) => revisionsOfWork(workId, log)} onRevisionTag={showRevisions} revisionCount={log.length}
                onLocate={(excerpt, locator) => locateSource(excerpt, locator && isKnowledgeLocator(locator) ? locator : "")}
                hasEarlier={state.hasEarlier}
                onLoadEarlier={() => state.earliestId && api.earlierConversation(taskId, sessionId, state.earliestId).then((c) =>
                  dispatch({ type: "earlier", messages: c.messages, hasEarlier: c.has_earlier, earliestId: c.earliest_id }))}
              />
            )}
          </div>

          <div className="stage-col">
            <div className="work">
              {task ? (
                <KnowledgeContext.Provider value={libraries}>
                <ItemsPanel task={task} initialCollection={collection} readOnly={readOnly} writesOff={working} recentlyChanged={state.recentlyChanged} marks={marks} just={just}
                  pendingItems={pendingItems} selected={selected} onSelect={openItem} submit={submit} onGenerateDoc={() => setDoc({ open: true, revision: null })}
                  onLocate={locateSource} onAskAssistant={(id) => prefill(PREFILL.revise(id))} onAnswer={answer} onSend={(t) => send(t)}
                  hit={hit} onClearHit={() => setSelectedRevision(null)} view={view} latestRevision={latestRevision} onDirty={setDirty}
                  unreadRequest={unreadRequest} review={state.review} onReview={review} onPrefill={prefill}
                  submitBar={showSubmitBar(task, working, state.messages)} />
                </KnowledgeContext.Provider>
              ) : <div className="pane-items" />}
              <div className="pane-doc">
                <SidePanel side={side} onSide={setSide} onCollapse={() => toggleDoc(true)} onExpand={() => toggleDoc(false)}
                  taskId={taskId} materials={state.materials} focusPath={state.focusMaterial} items={task?.items ?? []} locate={locate}
                  currentItem={selected} disabled={!!disabledReason || working} onOpenItem={openItem} onSend={(t) => void send(t)}
                  log={log} messages={state.messages} selectedRevision={selectedRevision} onSelectRevision={setSelectedRevision} scrollNonce={scrollNonce}
                  onDiff={openDiff} onUndo={undo} onGenerate={(revision) => setDoc({ open: true, revision: revision ?? null })}
                  writesOff={working} readOnly={readOnly}
                  review={task ? (
                    <ReviewPanel task={task} review={state.review} readOnly={readOnly} writesOff={working} onReview={review} submit={submit}
                      onOpenFinding={openFinding} onPrefill={prefill} />
                  ) : undefined}
                  reviewCount={task ? openProblems(task) : 0} task={task ?? undefined} />
              </div>
            </div>
          </div>
        </div>
      </div>
      {task && <DocumentModal task={task} log={log} open={doc.open} revision={doc.revision} onClose={() => setDoc({ open: false, revision: null })} />}
      <KnowledgeDocModal request={knowledgeDoc} libraries={libraries} onClose={() => setKnowledgeDoc(null)} />
    </div>
  );
}

/**
 * 新建会话被拒时的提示。助手正在工作的那条会话就是用户现在所在的这一条时，「另一条会话」说不通，单独说；别的情形照 errorText。
 */
export function newSessionErrorText(error: ApiError, sessionId: string): string {
  if (error.code === "session_busy" && error.data.reason !== "working" && error.data.active_session === sessionId) {
    return "助手正在这条会话里工作，等它做完这一轮再新建会话。";
  }
  return errorText(error);
}

/**
 * 整份数据读不到、后端说「没有」（not_found）时，核实是不是这条会话不存在：任务读得到，任务的会话列表里却没有这条会话。
 * 是时返回任务名，给「找不到这条会话」那一页用；任务本身读不到或还没核实完时为 null，照别的读取失败处理。
 */
function useMissingSession(taskId: string, sessionId: string, notFound: boolean): { taskName: string } | null {
  const [missing, setMissing] = useState<{ taskName: string } | null>(null);
  useEffect(() => {
    if (!notFound) { setMissing(null); return; }
    let live = true;
    api.getTask(taskId).then((t) => {
      if (live) setMissing((t.sessions ?? []).some((s) => s.session_id === sessionId) ? null : { taskName: t.task_name });
    }).catch(() => { if (live) setMissing(null); });
    return () => { live = false; };
  }, [taskId, sessionId, notFound]);
  return missing;
}
