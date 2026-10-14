// 工作视图：结构与样式照设计原型——顶栏（任务名 · 会话名、当前活动、字号三档、会话菜单），左边细导航条，
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
import type { ActionRequest, AssistantReply, DiagramRow, Item, KnowledgeLibrary, MessageRequest, SessionListEntry, Task, UiActionNoted } from "../api/types";
import { useWorkView } from "../state/useWorkView";
import { Conversation } from "../components/work/Conversation";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { DIAGRAM_HOLD_TEXT } from "../components/work/ReplyCard";
import type { ViewRequest } from "../components/work/ItemDetail";
import type { LocateRequest } from "../components/work/MaterialPane";
import { SidePanel, type SideTab } from "../components/work/SidePanel";
import { DebugPane } from "../components/work/DebugPane";
import { DOCUMENT_REVIEWED_KEY, START_WORK_TEXT, quietChoiceText, topbarActivity } from "../model/stage";
import { App as AntApp } from "antd";
import { SwitchWorkPanel, type SwitchWorkActions } from "../components/work/SwitchWorkPanel";
import { deleteConfirmText } from "../model/startPage";
import { newSessionLine } from "../model/taskStatus";
import { SessionMenu } from "../components/SessionMenu";
import { retellText } from "../model/overall";
import { pendingReview } from "../model/items";
import { ReviewPanel } from "../components/work/ReviewPanel";
import { DocumentModal } from "../components/DocumentModal";
import { errorText } from "../components/work/errors";
import { FONT_TIERS, narrowViewport, readFontTier, saveFontTier, type FontTier } from "../model/fontScale";
import { justChangedItems, marksByItem, revisionsOfReply, revisionsOfWork, touchedItems } from "../model/revisions";
import { openProblems } from "../model/items";
import { factsKey, viewOnOpen } from "../model/overall";
import { diagramViewTarget } from "../model/sectionDiagrams";
import { showSubmitBar } from "../model/submit";
import { figuresOf } from "../model/versions";
import { figurePngs } from "../components/diagram/mermaid";
import { go, href, openSettings } from "../router";
import { useToast } from "../components/Toasts";
import { NoModelBanner, UserMenu, useService } from "../components/ServiceControls";
import { useConnectionToast, useProblemToasts, useReviewToast } from "../components/work/workToasts";
import { pdfUploadingText, tooLargeText, unsupportedTypeText } from "../model/upload";
import { executorHint } from "../components/work/executorHint";
import { KnowledgeContext } from "../state/knowledge";
import { KnowledgeDocModal, type KnowledgeDocRequest } from "../components/work/KnowledgeDocModal";
import { isKnowledgeLocator } from "../model/knowledge";

/** 「让助手改这一条」与「回答这个问题」预填的话。 */
export const PREFILL = {
  revise: (itemId: string) => `请修改 ${itemId}：`,
  answer: (itemId: string, matter: string) => `关于 ${itemId}「${matter}」：`,
};

export function WorkViewPage({ taskId, sessionId, collection = null, diagrams = false, diagram = null }: {
  taskId: string;
  sessionId: string;
  /** 地址里带的集合名（从任务页的集合卡点进来）：条目区一打开就停在这个集合的页签。 */
  collection?: string | null;
  /** 地址里带了 tab=diagrams：条目区一打开就停在图表页签。 */
  diagrams?: boolean;
  /** 地址里带的图的编号：条目区一打开就打开这张图。 */
  diagram?: string | null;
}) {
  const { state, log, dispatch, stream, loadError, loadErrorCode } = useWorkView(taskId, sessionId);
  const missing = useMissingSession(taskId, sessionId, !state.task && loadErrorCode === "not_found");
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ open: boolean; revision: number | null }>({ open: false, revision: null });
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  // 这条会话是不是归档的会话（它的工作项被删除了）：归档的会话开头不写「新会话 · …」那一行。会话清单读回来之前是 null，那一行先不画，免得一闪。
  const [archivedHere, setArchivedHere] = useState<boolean | null>(null);
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
  /** 图表页签里有没保存的改图：与有未保存的条目编辑一样，发送键与卡片按钮灰化，只是提示的说法不同。 */
  const [diagramDirty, setDiagramDirty] = useState(false);
  const [fontTier, setFontTier] = useState<FontTier>(readFontTier);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [locate, setLocate] = useState<LocateRequest | null>(null);
  const userToggledDoc = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  const { modal } = AntApp.useApp();
  // 切换工作面板开着没有；对话区插状况卡的请求（面板里的「查看工作进展」每点一次加一）。
  const [panelOpen, setPanelOpen] = useState(false);
  const [statusRequest, setStatusRequest] = useState(0);
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
  const executor = state.executor;
  const busyElsewhere = !!executor && executor.state === "working" && !!executor.active_session && executor.active_session !== sessionId;
  const working = executor?.state === "working";
  const busySession = sessions.find((s) => s.session_id === executor?.active_session)?.name;
  const disabledReason = busyElsewhere || busyError ? `助手正在${busySession ? `会话「${busySession}」` : "另一条会话"}里工作，做完才能在这里继续。`
    : executor?.state === "failed_to_start" ? `助手现在不可用：${executor.text}`
    : null;
  // 助手启动不起来：一切写入都不能做。执行者工作中另算（writesOff），预填输入框的两个按钮那时照常可用。
  // 助手已经退出、还没启动、正在启动时不设只读：说话与操作都会让服务先把助手启动起来，只在输入框上方提示一句（executorHint.ts）。
  const hint = executorHint(executor, state.outgoing.some((m) => m.state === "sending"));
  const readOnly = !!disabledReason && !busyElsewhere && !busyError;

  // 会话列表（会话菜单里每条会话的最近活动与消息条数）：打开页面、会话改名、助手做完一轮（执行者状态从工作中变为不在工作）、
  // 打开会话菜单时各读一次；不定时轮询。执行者状态属于整个任务，别的会话里做完一轮也会重读。
  // 取的是带归档的清单：菜单里只列未归档的（归档的由菜单底部的开关另取），这里只用它看本会话是不是归档的。
  const loadSessions = () => {
    api.listSessions(taskId, true).then((all) => {
      setSessions(all.filter((s) => !s.archived));
      setArchivedHere(all.some((s) => s.session_id === sessionId && !!s.archived));
    }).catch(() => { setSessions([]); setArchivedHere((was) => was ?? false); });
  };
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
  // 待核实、依据待核实、提到这几项只随整份数据来，库事件里没有：任务里有总体分析时，交付物有了新修订、或者有条目被确认之后，
  // 稍等一下另取一次任务详情，把这几项并进来（state/workState.ts 的 facts）。头一次的整份数据里本来就有，不用取。
  const facts = factsKey(state.task, state.latestRevision);
  const factsSeen = useRef<string | null>(null);
  useEffect(() => {
    if (facts === null) { factsSeen.current = null; return; }
    if (factsSeen.current === null) { factsSeen.current = facts; return; }
    if (factsSeen.current === facts) return;
    factsSeen.current = facts;
    let live = true;
    const timer = setTimeout(() => {
      api.getTask(taskId).then((t) => { if (live) dispatch({ type: "facts", items: t.items, overall_views: t.overall_views }); }).catch(() => undefined);
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [facts, taskId]);

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

  /** 停止助手正在进行的这一次工作。返回真＝请求做成了（这次工作随后结束，对话区留一条通知）；假＝没有做成，另报一条失败提示。 */
  const stop = async (): Promise<boolean> => {
    try {
      await api.control(taskId, sessionId, "stop");
      return true;
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError("network", String(e));
      toast.error(`没有停下来：${errorText(error)}`);
      return false;
    }
  };

  const submit = async (req: Pick<ActionRequest, "kind" | "targets" | "fields" | "notify_executor">, label: string): Promise<ApiError | null> => {
    try {
      const r = await api.action(taskId, sessionId, { client_id: clientId(), task_id: taskId, ...req });
      // 标为已读不改内容，不显示「正在保存」；都已读过时后端什么都不写、没有库事件，挂着的话会一直等不到。
      // 评审也不改内容，进度与结果另有 review_progress、review_finished 两种事件，同样不登记。
      // 改图（edit_diagram）照常登记：图的事件 diagram_changed 带操作编号，到了就消去。
      // 移动阶段也不登记：任务本来就在那个阶段时后端什么都不记、没有库事件，挂着的话会一直等不到。
      // 「继续本阶段」同样不登记：它只在会话里留一条通知，没有库事件。
      if (req.kind !== "mark_viewed" && req.kind !== "request_review" && req.kind !== "move_stage" && req.kind !== "start_activity" && req.kind !== "continue_stage") dispatch({ type: "op_pending", op_id: r.op_id, label, items: req.targets.map((t) => t.item_id).filter(Boolean) as string[] });
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
   * 没记上时条目照旧显示未读，再打开一次就会重记。总体分析里待核实的页打开时不记，由主题页上的「确认」来记（model/overall.ts）。
   */
  const openItem = (itemId: string | null) => {
    setSelected(itemId);
    const target = viewOnOpen(state.task, itemId);
    if (!target) return;
    void api.action(taskId, sessionId, { client_id: clientId(), task_id: taskId, kind: "mark_viewed", targets: [target], notify_executor: false })
      .catch(() => undefined);
  };
  /**
   * 用户在业务说明里看到了一张图现在的内容：在它现在的修订上记一条「看过」。与打开条目记已读一样不显示「正在保存」、不报错：
   * 没记上时这张图照旧算没看过，下一次看到再记。任务结束后、已经看过的图不记（model/sectionDiagrams.ts 的 diagramViewTarget）。
   */
  const viewDiagram = (row: DiagramRow) => {
    const target = diagramViewTarget(state.task, row);
    if (!target) return;
    void api.action(taskId, sessionId, { client_id: clientId(), task_id: taskId, kind: "mark_diagram_viewed", targets: [target], notify_executor: false })
      .catch(() => undefined);
  };
  /** 发起评审：targets 为空＝全部待评审的条目。后端核对通过就回应，被拒时报一条失败提示。 */
  const review = (targets: { item_id: string; base_revision: number }[], label: string) =>
    void submit({ kind: "request_review", targets, notify_executor: false }, label).then((e) => { if (e) toast.error(errorText(e)); });
  const undo = (revision: number) =>
    void submit({ kind: "undo", targets: [{ revision_no: revision }], notify_executor: false }, `撤销修订 ${revision}`).then((e) => { if (e) toast.error(errorText(e)); });

  /** 取一次本会话的工作进展给对话区的工作进展卡用；取不到时报一条失败提示，返回 null。 */
  const loadStatus = () => api.taskStatus(taskId, sessionId).then((r) => r.status).catch((e) => {
    toast.error(`工作进展没有取到：${errorText(e instanceof ApiError ? e : new ApiError("network", String(e)))}`);
    return null;
  });

  const cardHandlers = {
    onAction: (req: Pick<ActionRequest, "kind" | "targets" | "fields" | "notify_executor">, label: string) => {
      void submit(req, label).then((e) => { if (e) toast.error(errorText(e)); });
    },
    onMessage: (text: string, card?: MessageRequest["card"]) => send(text, card),
    onShowUnread: () => setUnreadRequest((n) => n + 1),
    // 请过目的卡片上点了「看过了，生成文档」：先在会话里留一条通知（这时提议还开着，卡片在另一条会话里也认得出），
    // 再把卡片点名的页标为已读（提议随之结束），然后打开生成文档。两步都不引出助手的一次运行。
    onReviewed: async (replyMessageId: string, items: { item_id: string; revision_no?: number | null }[]): Promise<boolean> => {
      const noted = await submit({ kind: "continue_stage", targets: [], fields: { reply_message_id: replyMessageId, option_key: DOCUMENT_REVIEWED_KEY }, notify_executor: false },
        `选择${quietChoiceText(DOCUMENT_REVIEWED_KEY)}`);
      const failed = noted ?? (items.length > 0
        ? await submit({ kind: "mark_viewed", targets: items.map((one) => ({ item_id: one.item_id, base_revision: one.revision_no ?? undefined })), notify_executor: false },
          `把 ${items.map((one) => one.item_id).join("、")} 标为已读`)
        : null);
      if (failed) { toast.error(errorText(failed)); return false; }
      setDoc({ open: true, revision: null });
      return true;
    },
  };

  const attach = async (file: File) => {
    // 类型不符或超过上限的文件不发请求，直接报后端给的那句话（先查类型，与后端的先后相同）。
    const refused = unsupportedTypeText(service.info, file) ?? tooLargeText(service.info, file);
    if (refused) {
      toast.error(refused);
      return;
    }
    // PDF 要等一会儿：先说一句，结果出来时原地换成结果（同一个 key）。
    const waiting = pdfUploadingText(file.name);
    const same = waiting ? { key: `upload:${file.name}` } : undefined;
    if (waiting && same) toast.running(same.key, waiting);
    try {
      const r = await api.uploadMaterial(taskId, file, sessionId);
      setAttachments((a) => [...a, r.path]);
      toast.success(`已上传：${r.path}。它会随你的下一句话一起交给助手。`, same);
    } catch (e) {
      toast.error(e instanceof ApiError ? errorText(e) : "上传没有成功。", same);
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
  /**
   * 发布一个版本：照「下载 Word」的做法先取这一修订的文档、把里面用到的图画成 PNG，再带着页面看到的修订号与发布说明请任务服务发布。
   * 成了提示一句（版本列表随事件更新）；被拒或出错返回原因，写在提示条上。
   */
  const publish = async (note: string): Promise<string | null> => {
    try {
      const revision = latestRevision;
      const preview = revision ? (await api.previewDocument(taskId, { revision_no: revision })).text : "";
      const images = await figurePngs(figuresOf(preview));
      const done = await api.publishVersion(taskId, sessionId, { revision_no: revision, note: note.trim() || null, images });
      toast.success(`第 ${done.version_no} 版已发布。`);
      return null;
    } catch (e) {
      return errorText(e instanceof ApiError ? e : new ApiError("network", String(e)));
    }
  };
  /** 换一条干净的会话接着做一个工作项：后端新建一条属于它的会话，进去，不替用户发话。 */
  const continueWorkItem = async (recordId: number) => {
    try {
      const { session_id } = await api.continueWorkItem(taskId, recordId);
      go(href.work(taskId, session_id));
    } catch (e) {
      toast.error(errorText(e instanceof ApiError ? e : new ApiError("network", String(e))));
    }
  };
  /** 删除一个工作项：先确认，写明会归档几条会话；删了之后本会话随之归档、按自由讨论办（整份数据随事件更新）。 */
  const deleteWorkItem = (recordId: number, name: string, sessionCount: number, flow: boolean) => {
    modal.confirm({
      title: `删除工作项「${name}」？`,
      content: deleteConfirmText({ name, kind: flow ? "flow" : "activity", session_count: sessionCount }),
      okText: "删除", cancelText: "取消", okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const done = await api.deleteWorkItem(taskId, recordId, sessionId);
          toast.success(`已删除工作项「${name}」${done.archived_sessions > 0 ? `，归档了 ${done.archived_sessions} 条会话` : ""}。`);
        } catch (e) {
          toast.error(errorText(e instanceof ApiError ? e : new ApiError("network", String(e))));
        }
      },
    });
  };
  /** 切换工作面板里的几样操作：都是这一页已有的操作。 */
  const panelActions: SwitchWorkActions = {
    onPrefill: prefill,
    onRetell: () => void send(retellText(null)),
    onReview: () => review([], "评审待评审的条目"),
    onAttach: (file) => void attach(file),
    onShowStatus: () => setStatusRequest((n) => n + 1),
    onContinue: (recordId) => void continueWorkItem(recordId),
    onDelete: deleteWorkItem,
  };
  /** 阶段条上点了一盏说材料还没有被引用的灯：展开右侧栏、切到材料页签，由材料页签选中那份材料。 */
  const openMaterial = (path: string) => {
    toggleDoc(false);
    setSide("material");
    dispatch({ type: "focus_material", path });
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
            <div><a href={href.task(taskId)} data-testid="missing-session-back">回到任务起点</a></div>
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
          {task && <TopbarActivityChip task={task} startHref={href.task(taskId)} onOpenPanel={() => setPanelOpen(true)} />}
          {Object.keys(state.pendingOps).length > 0 && <span className="chip warn">正在保存：{Object.values(state.pendingOps).map((p) => p.label).join("；")}</span>}
          <span className="sw-fs" title="字号：根字号随视口流动，这里再选一档" data-testid="font-tiers">
            字号{FONT_TIERS.map((t) => (
              <a key={t.key} className={fontTier === t.key ? "on" : undefined} role="button" onClick={() => chooseFont(t.key)} data-testid={`font-${t.key}`}>{t.label}</a>
            ))}
          </span>
          <span className="smenu-btn" role="button" onClick={() => setMenuOpen(!menuOpen)} data-testid="session-menu-button">会话 ▾</span>
          <span className="set-btn" role="button" onClick={openSettings} data-testid="open-settings"><SettingOutlined />设置</span>
          <UserMenu where="topbar" />
          <SessionMenu taskId={taskId} taskName={task?.task_name} sessions={sessions} open={menuOpen} onClose={() => setMenuOpen(false)} currentId={sessionId}
            onNew={() => void newSession()} />
        </div>
        <div className="app-body">
          <div className="rail">
            <div className="ico" title="全局查找（还没有做）">⌕</div>
            <a className="ico on" title="任务起点" href={href.task(taskId)}>▣</a>
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
                hold={dirty || diagramDirty} holdText={diagramDirty && !dirty ? DIAGRAM_HOLD_TEXT : undefined} working={working} hint={hint} starting={executor?.state === "starting"}
                onSend={(t) => send(t)} onUndo={undo} onShowReviews={showReviews} onStop={busyElsewhere ? undefined : stop}
                onOpenItem={openItem} onAttach={attach} revisionOf={revisionOf} attachments={attachments}
                draft={draft} onDraft={setDraft} inputRef={input} loadStatus={loadStatus} statusRequest={statusRequest}
                sessionLine={task?.stage && archivedHere === false ? newSessionLine(task.stage.work_item) : null}
                onOtherWork={task?.stage ? () => setPanelOpen(true) : undefined}
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
                <ItemsPanel task={task} initialCollection={collection} initialDiagrams={diagrams} initialDiagram={diagram} readOnly={readOnly} writesOff={working} recentlyChanged={state.recentlyChanged} marks={marks} just={just}
                  pendingItems={pendingItems} selected={selected} onSelect={openItem} submit={submit} onGenerateDoc={() => setDoc({ open: true, revision: null })}
                  onLocate={locateSource} onAskAssistant={(id) => prefill(PREFILL.revise(id))} onAnswer={answer} onSend={(t) => send(t)}
                  hit={hit} onClearHit={() => setSelectedRevision(null)} view={view} latestRevision={latestRevision} onDirty={setDirty} onDiagramDirty={setDiagramDirty} onDiagramViewed={viewDiagram}
                  unreadRequest={unreadRequest} review={state.review} onReview={review} onPrefill={prefill}
                  submitBar={showSubmitBar(task, working, state.messages)} onPublish={publish} />
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
                  reviewCount={task ? openProblems(task) : 0} task={task ?? undefined}
                  debug={service.info?.debug ? <DebugPane taskId={taskId} stage={task?.stage ?? null} items={task?.items ?? []} working={!!working} onOpenItem={openItem} onOpenMaterial={openMaterial} /> : undefined} />
              </div>
            </div>
          </div>
        </div>
      </div>
      {task && <DocumentModal task={task} log={log} open={doc.open} revision={doc.revision} onClose={() => setDoc({ open: false, revision: null })} />}
      <KnowledgeDocModal request={knowledgeDoc} libraries={libraries} onClose={() => setKnowledgeDoc(null)} />
      {task?.stage && (
        <SwitchWorkPanel open={panelOpen} taskId={taskId} sessionId={sessionId} stage={task.stage} pendingReview={pendingReview(task).length}
          off={disabledReason ?? (working ? "助手正在工作，等它做完这一轮。" : null)} actions={panelActions} onClose={() => setPanelOpen(false)} />
      )}
    </div>
  );
}

/**
 * 顶栏上任务名与会话名后面的那一处（model/stage.ts 的 topbarActivity），只有两种写法：这条会话在做一个工作项时是「当前活动：某项活动 ▾」，
 * 点了打开切换工作面板；这条会话是自由讨论时是「自由讨论 · 不绑定活动」（点了同样打开面板），旁边一枚深色的「启动工作」去任务起点页。
 * 任务已经结束、任务没有阶段时只是一枚不能点的标签。
 */
function TopbarActivityChip({ task, startHref, onOpenPanel }: { task: Task; startHref: string; onOpenPanel: () => void }) {
  const now = topbarActivity(task);
  if (now.kind === "active") {
    return <span className="chip ai" role="button" onClick={onOpenPanel} title="打开切换工作面板" data-testid="current-activity">{now.text} ▾</span>;
  }
  if (now.kind === "idle") {
    return (
      <>
        <span className="chip" role="button" onClick={onOpenPanel} title="打开切换工作面板" data-testid="current-activity">{now.text}</span>
        <a className="chip dark" href={startHref} data-testid="start-work">{START_WORK_TEXT}</a>
      </>
    );
  }
  return <span className="chip" data-testid="current-activity">{now.text}</span>;
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
