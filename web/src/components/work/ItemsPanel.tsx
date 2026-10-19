// 条目区（工作台中栏），照设计原型：顶上一排页签按需求资产分，任务定义有问题集合时另有「问题」页签（model/assetTabs.ts），
// 下面一行汇总（点开是完成条件）。
// 材料与证据、分析模型、评审与确认、文档与版本四页各是一个组件（MaterialsTab、ModelsTab、ReviewTab、DocsTab）；业务说明页签是 overall/ 下的目录加一节。
// 「需求条目」与「问题」页签里：集合的子页签一行与「导出 Word」（问题页签只有一个集合时不排子页签），下面一行筛选，
// 「还有 N 条未读」的提示与勾选后的批量标为已读，然后是列表；点一行，列表换成这个条目的详情（带「回到列表」）。
// 打开详情就记为已读（由页面在打开时发 mark_viewed），已读就算确认；未读的行像邮件一样加粗。
// 问题条目一类的集合（有取值「用户决定保留」的枚举字段）铺成一张张卡片，未解决的带「回答这个问题」「暂不处理」。
// 自上次确认以来助手改过的条目带「修订 N · 刚改」；库事件刚改过的条目短时闪一下。集合名、字段名一律取自任务定义。
//
// 单一写入者：执行者工作中（writesOff），顶部一条横幅，改字段、保存、删除、批量标为已读、撤回、
// 暂不处理全部灰化；「回答这个问题」「让助手来改这一条」只往对话区输入框预填文字、不写库，照常可用。
// 在右侧「修订」页签选中一次修订（hit）时，它碰到的条目高亮，集合页签上标出各有几个，筛选行加一个可点掉的提示。
// 宽屏时列表每行在标题后多一列「一句摘要」，显隐由样式里的容器查询按条目区宽度决定（阈值 40rem）。
//
// 评审：「评审与确认」页签页头右边「评审 N 条待评审的条目」（N 为 0、助手工作中、上一批还在评时灰化并悬停说明），点了发 request_review；
// 后端核对通过就回应，评审在后台跑，进度与结果由全站提示条报（workToasts.ts）。进度汇总一行写待评审、评审不通过（不含保留的）各几条，
// 有保留了写法的条目时另写「已保留写法 N」。点开进度看到的完成条件
// 与任务页是同一个面板，评审那一条旁边有「评审这 N 条」与「打开 X」。
// 导出 Word：需求条目页签子页签一行右边的「导出 Word」导出列表里勾选的条目（全部页签里勾中的都算，不只当前页签），一个都没勾时灰；
// 点了弹对话框（ExportDocxModal.tsx）。导出不改任何东西，所以勾选框在助手工作中、任务结束后也能勾；「标为已读」在这两种时候照旧不能用。
// 卡片式的集合（问题条目）没有勾选框，导不了。
// 图：画在业务说明里它说明的那一节、那一章的章首（overall/Figure.tsx）。「分析模型」页签是全部图的索引（ModelsTab.tsx），
// 「打开所在章节」打开业务说明里那张图所在的地方并滚到它，改图在图下的「文本与来源」里。地址里的 diagram=D-001 与条目详情
// 「依据」「被谁依据」里的图同样去那里；地址里只说看图（tab=diagrams）时停在「分析模型」页签。
// 问题跟着条目走（ItemIssues.tsx）：列表行的状态徽标里带「问题 N」（ItemStatus.tsx），详情顶部列出挂在这条上、还没了结的问题；从问题卡片上的「牵涉 UC-003」跳来时
// 记下来源（fromIssue），详情顶部给「回到问题列表」；换到别的条目或回到列表就清掉。

import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Modal } from "antd";
import type { DiagramRow, Item, KnowledgeLibrary, Material, ServiceInfo, Task } from "../../api/types";
import type { ReviewRun } from "../../state/workState";
import { BUSY_TEXT, FILTERS, failedReview, isEmptyValue, isUnread, keptReview, keepPendingField, matchesFilter, needsReading, pendingReview, reviewOffReason, summaryOf, unreadItems, writeOffReason, type ItemFilter } from "../../model/items";
import { CompletionPanel } from "../CompletionPanel";
import { ItemDetail, type SubmitAction, type ViewRequest } from "./ItemDetail";
import { ItemStatus } from "./ItemStatus";
import { submitQuestion, submitTitle } from "../../model/submit";
import { changesAfter, changesLine, nextVersionNo } from "../../model/versions";
import { initialTab, readTab, saveTab, tabOrder } from "../../model/itemsTab";
import { type AssetPane, assetPanes, issueCollections, itemCollections, paneCount, paneKey, paneOfCollection, paneOfKey, unresolvedIssues } from "../../model/assetTabs";
import { MaterialsTab } from "./MaterialsTab";
import { ReviewTab } from "./ReviewTab";
import { DocsTab } from "./DocsTab";
import type { GoTarget } from "../../model/docsCheck";
import { FromIssueCrumb, ItemIssues } from "./ItemIssues";
import { errorText, rejectedText } from "./errors";
import { EXPORT_DOCX_HINT, ExportDocxModal } from "./ExportDocxModal";
import { ModelsTab } from "./ModelsTab";
import { OverallPane } from "./overall/OverallPane";
import { SectionPage } from "./overall/SectionPage";
import { FigureBlocks, type FigureHost } from "./overall/Figure";
import type { HeadView } from "./overall/Contents";
import { SectionLinks } from "./overall/SectionLinks";
import { OVERALL_COLLECTION, isOverall } from "../../model/overall";
import { figureHome } from "../../model/sectionDiagrams";
import { toc, tocOrder } from "../../model/chapters";
import { useToast } from "../Toasts";

/** 发起评审：给要评的条目（空列表＝全部待评审的条目）与一句说明。 */
export type ReviewAction = (targets: { item_id: string; base_revision: number }[], label: string) => void;

export { BUSY_TEXT };
/** 左边导航栏要中栏去的地方（components/work/LeftNav.tsx）。 */
export type NavRequest = { target: "issues" | { diagram: string }; nonce: number };

export function ItemsPanel({
  task, initialCollection = null, initialDiagrams = false, initialDiagram = null, readOnly, writesOff = false, recentlyChanged, marks = {}, just = new Set<string>(), pendingItems, selected, onSelect, submit, onGenerateDoc, onLocate,
  onAskAssistant, onAnswer, onSend, hit = null, onClearHit, view = null, latestRevision = 0, onDirty, onDiagramDirty, onDiagramViewed, unreadRequest = 0, navRequest = null, review = null, onReview, onPrefill,
  submitBar = false, onPublish, materials = [], info = null, libraries, onViewMaterial, onShowRevision,
}: {
  task: Task;
  /** 一打开停在哪个集合的页签（任务页的集合卡带过来的）；不给、或者没有这个集合时是第一个集合。 */
  initialCollection?: string | null;
  /** 一打开就停在「分析模型」页签（地址里的 tab=diagrams）。 */
  initialDiagrams?: boolean;
  /** 一打开就打开这张图（地址里的 diagram=D-001）；有业务说明的任务打开它所在的节或章首并滚到它。 */
  initialDiagram?: string | null;
  /** 任务已结束或助手不可用：一切写入都不能做。 */
  readOnly: boolean;
  /** 执行者正在工作：写入按钮灰化，预填输入框的两个按钮照常可用。 */
  writesOff?: boolean;
  recentlyChanged: string[];
  /** 字段修订标识：条目编号 → 自上次确认以来助手改过的字段（model/revisions.ts 的 marksByItem）。 */
  marks?: Record<string, string[]>;
  /** 带「刚改」标签的条目：执行者最近一次运行改过的（model/revisions.ts 的 justChangedItems）。 */
  just?: Set<string>;
  pendingItems: Set<string>;
  selected: string | null;
  onSelect: (itemId: string | null) => void;
  submit: SubmitAction;
  onGenerateDoc: () => void;
  onLocate?: (excerpt: string, locator: string) => void;
  onAskAssistant?: (itemId: string) => void;
  /** 问题条目卡片上的「回答这个问题」：预填对话区输入框。 */
  onAnswer?: (item: Item) => void;
  /** 条目详情里问题卡片上的「回答」：把一句话直接发到对话区。 */
  onSend?: (text: string) => void;
  /** 在「修订」页签里选中的那次修订与它碰到的条目。 */
  hit?: { revision: number; items: string[] } | null;
  onClearHit?: () => void;
  /** 从修订页签的「查看差异」来的：打开这个条目并停在那次修订。 */
  view?: ViewRequest | null;
  latestRevision?: number;
  /** 有没有未保存的条目编辑（编辑框打开且内容与打开时不同）。 */
  onDirty?: (dirty: boolean) => void;
  /** 有没有没保存的改图（业务说明里改了图的 Mermaid 文本还没有保存）。 */
  onDiagramDirty?: (dirty: boolean) => void;
  /** 用户在业务说明里看到了一张图现在的内容（图画出来并且在看得见的范围里）。 */
  onDiagramViewed?: (row: DiagramRow) => void;
  /** 卡片上点「筛出来看」时加一：筛选切到「未读」、回到列表。 */
  unreadRequest?: number;
  /** 左边导航栏点了一行要中栏去的地方：「问题」页签，或者业务说明里的一张图；nonce 每次加一。 */
  navRequest?: NavRequest | null;
  /** 最近一批界面发起的评审（进度与结果）。 */
  review?: ReviewRun | null;
  /** 发起评审。 */
  onReview?: ReviewAction;
  /** 往对话区输入框预填一句话（「让助手照这条改」）。 */
  onPrefill?: (text: string) => void;
  /** 显示发布版本的提示条（model/submit.ts 的 showSubmitBar 算好交进来）。 */
  submitBar?: boolean;
  /** 发布一个版本（工作视图做：生成图、发请求）；返回被拒的原因，成了是 null。不给时提示条上的按钮不能点。 */
  onPublish?: (note: string) => Promise<string | null>;
  /** 工作台手里的材料清单（随事件流更新）：「材料与证据」页签上的份数，它变了那一页重取任务详情。 */
  materials?: Material[];
  info?: ServiceInfo | null;
  /** 知识库清单（「材料与证据」页签用）；服务没有知识库这一功能时不给，还没取到时是 null。 */
  libraries?: KnowledgeLibrary[] | null;
  /** 「材料与证据」页签上的「查看」：在右侧栏原文定位里打开这份材料。 */
  onViewMaterial?: (path: string) => void;
  /** 「文档与版本」页签版本表里点「修订 N」：在右侧栏修订页签里选中那次修订。 */
  onShowRevision?: (revision: number) => void;
}) {
  // 页签的次序：有业务说明集合时它排最前（model/itemsTab.ts）。
  const collections = useMemo(() => tabOrder(task.definition.collections), [task.definition.collections]);
  const selectedItem = task.items.find((i) => i.item_id === selected);
  // 集合的初值：选中的条目所在的集合；地址里要看的一张图（业务说明）或带的集合；这个任务上次停的集合；都没有时，
  // 任务里只有业务说明有内容就停在业务说明，否则停在它之外的第一个集合。
  const [opened] = useState(() => initialTab(task, { selected, collection: initialCollection, diagram: !!initialDiagram }));
  const [tab, setTab] = useState<string>(opened.tab);
  // 顶上一排页签停在哪一个（model/assetTabs.ts）：业务说明、需求条目与问题三个页签里是集合（tab 是哪个集合），另外四个不是。
  // 一打开：地址里带了条目、集合或图，或者浏览器记着的是一个集合时，跟着那个集合走；记着的是另外四个页签之一时停在那里。
  const [pane, setPane] = useState<AssetPane>(() =>
    (!selected && initialDiagrams && !initialDiagram ? "models" : null)
    || (!selected && !initialCollection && !initialDiagram && paneOfKey(readTab(task.task_id))) || paneOfCollection(task, opened.tab));
  /** 需求条目页签里上次停的集合：从别的页签回来时回到它。 */
  const lastItemsTab = useRef<string | null>(paneOfCollection(task, opened.tab) === "items" ? opened.tab : null);
  if (paneOfCollection(task, tab) === "items") lastItemsTab.current = tab;
  // 业务说明里哪几张图有没保存的改动：有一张就算有。
  const dirtyFigures = useRef(new Set<string>());
  const figureDirty = (diagramId: string, dirty: boolean) => {
    if (dirty) dirtyFigures.current.add(diagramId); else dirtyFigures.current.delete(diagramId);
    onDiagramDirty?.(dirtyFigures.current.size > 0);
  };
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [flash, setFlash] = useState<string[]>([]);
  const toast = useToast();
  // 发布版本：点提示条上的按钮先弹确认框，可以写一句发布说明，点「发布」才发出（工作视图带上页面看到的修订号与画好的图）。
  // 被拒（例如确认框开着时交付物又改了）把说明写在提示条上；成功时版本列表多一版，提示条随之消失，直到又有改动。
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [publishNote, setPublishNote] = useState("");
  // 「有 M 处改动在第 N 版之后」那一行展开没有。
  const [showChanges, setShowChanges] = useState(false);
  const publishNow = async () => {
    if (!onPublish) return;
    setSubmitting(true);
    const error = await onPublish(publishNote);
    setSubmitting(false);
    setConfirmSubmit(false);
    setSubmitError(error);
    if (!error) setPublishNote("");
  };
  /** 从哪个问题跳到当前条目的；详情顶部据此给「回到问题列表」，那张问题卡片排第一并高亮。 */
  const [fromIssue, setFromIssue] = useState<{ issueId: string; itemId: string } | null>(null);
  /** 回到问题列表后要滚到并闪一下的问题卡片；n 每次加一。 */
  const [scrollTo, setScrollTo] = useState<{ id: string; n: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const activeTab = selectedItem?.collection ?? tab;
  // 停在「业务说明」页签：主体不是列表，是目录加一节（overall/OverallPane.tsx）；筛选、未读提示、批量条都是给列表用的，不显示。
  const onCollection = pane === "description" || pane === "items" || pane === "issues";
  const onOverall = pane === "description" && isOverall(activeTab);
  // 停在需求条目或问题页签的列表上才有筛选、未读提示与批量条。
  const noList = (pane !== "items" && pane !== "issues") || onOverall;
  // 记住这个任务停在哪个页签（存在浏览器本地），下次打开这个任务回到这里。
  useEffect(() => { saveTab(task.task_id, onCollection ? activeTab : paneKey(pane)); }, [task.task_id, pane, onCollection, activeTab]);
  /** 点顶上一排的页签。离开集合页签时关掉打开着的条目；进需求条目回到上次停的集合，进问题停在第一个问题集合。 */
  const openPane = (next: AssetPane) => {
    setPane(next);
    onSelect(null);
    if (next === "description") setTab(OVERALL_COLLECTION);
    if (next === "items") setTab(lastItemsTab.current ?? itemCollections(task)[0]?.name ?? tab);
    if (next === "issues") setTab(issueCollections(task)[0]?.name ?? tab);
  };
  const [headRequest, setHeadRequest] = useState<{ view: HeadView | null; seq: number } | null>(null);
  const [figureFocus, setFigureFocus] = useState<{ diagramId: string; seq: number } | null>(null);
  const requests = useRef(0);
  /** 去业务说明里看一张图：打开它所在的节或章首并滚到它；找不到就停在业务说明的首页。 */
  const goFigure = (diagramId: string) => {
    const home = figureHome(task, toc(task), diagramId);
    const seq = (requests.current += 1);
    setTab(OVERALL_COLLECTION);
    setPane("description");
    setFigureFocus(home ? { diagramId, seq } : null);
    if (home?.where === "section") { onSelect(home.itemId); return; }
    onSelect(null);
    setHeadRequest({ view: home?.where === "chapter" ? { kind: "chapter", no: home.chapter } : home?.where === "loose" ? { kind: "loose" } : null, seq });
  };
  /** 「文档与版本」页签发布前检查里的「去补」：切到对应的页签，停在那个集合与筛选、那个条目、那一章的章首或那张图。 */
  const goTo = (target: GoTarget) => {
    if (target.kind === "review") { openPane("review"); return; }
    if (target.kind === "item") { openItem(target.itemId); return; }
    if (target.kind === "diagram") { goFigure(target.diagramId); return; }
    if (target.kind === "chapter") {
      setPane("description"); setTab(OVERALL_COLLECTION); onSelect(null);
      setHeadRequest({ view: { kind: "chapter", no: target.no }, seq: (requests.current += 1) });
      return;
    }
    openPane(paneOfCollection(task, target.collection)); setTab(target.collection); setFilter(target.filter ?? "all");
  };
  /** 打开一张图：去业务说明里它所在的地方。 */
  const openDiagram = (diagramId: string) => goFigure(diagramId);
  // 地址里要看一张图（diagram=D-001）：一打开就去那里。地址里同时选中了条目时以条目为准。
  useEffect(() => { if (!selected && initialDiagram) goFigure(initialDiagram); }, []);
  const hitIds = hit?.items ?? [];
  const offTitle = writeOffReason(task, { readOnly, writesOff });

  // 从卡片、修订页签点来的条目：切到它所在的集合、不让筛选挡住它。
  useEffect(() => {
    if (!selected) return;
    const item = task.items.find((i) => i.item_id === selected);
    if (item) { setTab(item.collection); setPane(paneOfCollection(task, item.collection)); if (!matchesFilter(item, filter, task)) setFilter("all"); }
    document.querySelector(".app .items-body")?.scrollTo({ top: 0 });
  }, [selected]);
  // 换到别的条目或回到列表：不再是从问题跳来的。
  useEffect(() => { if (fromIssue && selected !== fromIssue.itemId) setFromIssue(null); }, [selected]);
  useEffect(() => {
    if (!scrollTo) return;
    document.querySelector(`.app [data-testid="item-${scrollTo.id}"]`)?.scrollIntoView?.({ block: "center" });
    setFlash([scrollTo.id]);
    const t = setTimeout(() => setFlash([]), 2400);
    return () => clearTimeout(t);
  }, [scrollTo]);
  // 卡片上点了「还有 N 条未读 · 筛出来看」。
  useEffect(() => { if (unreadRequest > 0) { setFilter("unread"); onSelect(null); if (pane !== "items") openPane("items"); } }, [unreadRequest]);
  // 左边导航栏点了「待澄清问题」或「请过目」里的一张图。
  useEffect(() => {
    if (!navRequest) return;
    if (navRequest.target === "issues") openPane("issues");
    else goFigure(navRequest.target.diagram);
  }, [navRequest?.nonce]);
  // 库事件改过的条目闪一下。
  useEffect(() => {
    if (!recentlyChanged.length) return;
    setFlash(recentlyChanged);
    const t = setTimeout(() => setFlash([]), 2400);
    return () => clearTimeout(t);
  }, [recentlyChanged]);

  const def = collections.find((c) => c.name === activeTab);
  const statusField = keepPendingField(task, activeTab);
  const items = useMemo(() => task.items.filter((i) => i.collection === activeTab && matchesFilter(i, filter, task)), [task, activeTab, filter]);
  const unread = unreadItems(task);
  const unresolved = unresolvedIssues(task).length;
  const checkedItems = items.filter((i) => checked.has(i.item_id));
  // 导出 Word 用的：全部页签里勾中的条目（已经不在的编号不算）。
  const exportItems = task.items.filter((i) => checked.has(i.item_id));
  const pos = selectedItem ? items.findIndex((i) => i.item_id === selectedItem.item_id) : -1;
  // 业务说明的节：「上一条」「下一条」照目录从上到下的次序走；看节的版式还是按条目的样子看（修订与全部来源），换一节就回到节的版式。
  const contents = useMemo(() => (onOverall ? toc(task) : null), [task, onOverall]);
  const topics = useMemo(() => (contents ? tocOrder(contents) : []), [contents]);
  const topicPos = selectedItem ? topics.findIndex((i) => i.item_id === selectedItem.item_id) : -1;
  const [rawTopic, setRawTopic] = useState(false);
  useEffect(() => { setRawTopic(false); }, [selected]);
  const hitsIn = (collection: string) => task.items.filter((i) => i.collection === collection && hitIds.includes(i.item_id)).length;
  /** 需求条目与问题两个页签各自的集合，照页签的次序。 */
  const subCollections = (one: "items" | "issues") => {
    const names = new Set((one === "items" ? itemCollections(task) : issueCollections(task)).map((c) => c.name));
    return collections.filter((c) => names.has(c.name));
  };
  const toReview = pendingReview(task);
  const failed = failedReview(task);
  const kept = keptReview(task);
  const reviewing = !!review && !review.finished;
  const reviewOff = reviewOffReason(task, { readOnly, writesOff, running: reviewing, count: toReview.length });
  const reviewItems = (list: Item[], label: string) =>
    onReview?.(list.map((i) => ({ item_id: i.item_id, base_revision: i.revision_no })), label);

  /** 打开一个条目；从问题卡片上跳来时带上来源。 */
  const openItem = (itemId: string, o: { fromIssue?: string } = {}) => {
    setFromIssue(o.fromIssue ? { issueId: o.fromIssue, itemId } : null);
    onSelect(itemId);
  };
  // 业务说明里画图要的那几样（节里的图、章首的图、未归入节的图都用它）。
  const figureHost: FigureHost | null = contents ? {
    task, contents, readOnly, writesOff, latestRevision, submit, onLocate, onOpen: (id) => openItem(id), onOpenItem: (id) => openItem(id),
    onViewed: onDiagramViewed, onDirty: figureDirty, focus: figureFocus,
  } : null;
  /** 「回到问题列表」：切回问题所在的页签，滚到那张问题卡片。 */
  const backToIssue = (issueId: string) => {
    const issue = task.items.find((i) => i.item_id === issueId);
    setFromIssue(null);
    if (issue) { setTab(issue.collection); setPane(paneOfCollection(task, issue.collection)); if (!matchesFilter(issue, filter)) setFilter("all"); }
    onSelect(null);
    setScrollTo((s) => ({ id: issueId, n: (s?.n ?? 0) + 1 }));
  };

  const markMany = async (list: Item[]) => {
    const label = `把 ${list.map((i) => i.item_id).join("、")} 标为已读`;
    const e = await submit({ kind: "mark_viewed", targets: list.map((i) => ({ item_id: i.item_id, base_revision: i.revision_no })), notify_executor: false }, label);
    if (!e) setChecked(new Set());
    else toast.error(rejectedText(label, e));
  };
  const keepPending = async (item: Item) => {
    const label = `把 ${item.item_id} 标为暂不处理`;
    const e = await submit({ kind: "keep_pending", targets: [{ item_id: item.item_id, base_revision: item.revision_no }], notify_executor: false }, label);
    if (e) toast.error(rejectedText(label, e, item.item_id));
  };

  /** 打开着的条目的详情；没有打开条目时为 null。 */
  const detail = selectedItem && def ? (
    <ItemDetail task={task} item={selectedItem} def={def} readOnly={readOnly} writesOff={writesOff} pending={pendingItems.has(selectedItem.item_id)} submit={submit}
      reviewOff={reviewOffReason(task, { readOnly, writesOff, running: reviewing, count: 1 })}
      onReview={onReview ? () => reviewItems([selectedItem], `评审 ${selectedItem.item_id}`) : undefined} onPrefill={onPrefill}
      marked={marks[selectedItem.item_id] ?? []} just={just.has(selectedItem.item_id)} onBack={() => onSelect(null)}
      onPrev={pos > 0 ? () => onSelect(items[pos - 1].item_id) : null}
      onNext={pos >= 0 && pos < items.length - 1 ? () => onSelect(items[pos + 1].item_id) : null}
      onLocate={onLocate} onOpenItem={onSelect} onOpenDiagram={openDiagram} onAskAssistant={onAskAssistant}
      view={view && view.itemId === selectedItem.item_id ? view : null} latestRevision={latestRevision} onDirty={(d) => { setDirty(d); onDirty?.(d); }}
      crumb={onOverall ? <span className="crumb" role="button" onClick={() => setRawTopic(false)} data-testid="back-to-topic">‹ 回到这一节</span>
        : fromIssue ? <FromIssueCrumb issueId={fromIssue.issueId} onBack={() => backToIssue(fromIssue.issueId)} /> : null}
      top={<ItemIssues task={task} itemId={selectedItem.item_id} readOnly={readOnly} writesOff={writesOff} hold={dirty} pendingItems={pendingItems}
        submit={submit} onSend={onSend} onPrefill={onAnswer} fromIssue={fromIssue?.issueId ?? null} />} />
  ) : null;

  return (
    <div className="pane-items" data-testid="items-panel">
      {writesOff && <div className="sw-busy-banner" data-testid="busy-banner"><span className="spin" />{BUSY_TEXT}</div>}
      <div className="itabs" role="tablist" data-testid="asset-tabs">
        {assetPanes(task).map((one) => {
          const count = paneCount(one.key, task, materials);
          const hits = one.key === "description" ? hitsIn(OVERALL_COLLECTION)
            : one.key === "items" || one.key === "issues" ? subCollections(one.key).reduce((n, c) => n + hitsIn(c.name), 0) : 0;
          return (
            <span key={one.key} className={`itab${pane === one.key ? " on" : ""}`} role="tab" onClick={() => openPane(one.key)} data-testid={`pane-${one.key}`}
              title={one.key === "issues" ? `${count} 条未解决` : undefined}>
              {one.label}{count !== null && <span className={`cnt${one.key === "issues" && count !== "0" ? " open" : ""}`}>{count}</span>}
              {hit && hits > 0 && <span className="sw-hitn" title={`修订 ${hit.revision} 碰到这个页签里 ${hits} 个条目`} data-testid={`hit-count-${one.key}`}>{hits}</span>}
            </span>
          );
        })}
      </div>
      {/* 汇总行：六个页签都有，点开是完成条件。 */}
      <div className="filters sumrow">
        <span className="prog" role="button" onClick={() => setShowProgress(!showProgress)} data-testid="progress">
          {task.items.length} 个条目 · 待评审 {toReview.length} · 评审不通过 {failed.length}{kept.length > 0 ? ` · 已保留写法 ${kept.length}` : ""} · {unread.length} 条未读；问题 {unresolved} 条未解决 {showProgress ? "▴" : "▾"}
        </span>
      </div>
      <div className={`prog-detail${showProgress ? " show" : ""}`}>
        <div>这份交付物什么时候算做完，由下面这几条决定：</div>
        {showProgress && <CompletionPanel completion={task.completion} items={task.items} task={task}
          reviewOff={reviewOffReason(task, { readOnly, writesOff, running: reviewing, count: 1 })}
          onReview={onReview ? (list) => reviewItems(list, `评审 ${list.map((i) => i.item_id).join("、")}`) : undefined}
          onOpen={(id) => { setShowProgress(false); onSelect(id); }} />}
      </div>
      {(pane === "items" || pane === "issues") && (<>
        <div className="itabs" role="tablist" data-testid="item-tabs">
          {/* 问题页签里只有一个集合时不排子页签，这一行只留「导出 Word」。 */}
          {(pane === "issues" && subCollections(pane).length === 1 ? [] : subCollections(pane)).map((c) => (
            <span key={c.name} className={`itab${c.name === activeTab ? " on" : ""}`} role="tab"
              onClick={() => { setTab(c.name); onSelect(null); }}>
              {c.name}<span className="cnt">{task.items.filter((i) => i.collection === c.name).length}</span>
              {hit && hitsIn(c.name) > 0 && <span className="sw-hitn" title={`修订 ${hit.revision} 碰到这个页签里 ${hitsIn(c.name)} 个条目`} data-testid={`hit-count-${c.name}`}>{hitsIn(c.name)}</span>}
            </span>
          ))}
          <span className="spacer" />
          <button type="button" className="btn sm" disabled={!exportItems.length} title={exportItems.length ? undefined : EXPORT_DOCX_HINT} data-testid="export-docx"
            onClick={() => setExporting(true)}>导出 Word{exportItems.length ? `（${exportItems.length}）` : ""}</button>
        </div>
        <div className="filters" data-testid="item-filters">
          <span className="flabel">筛选：</span>
          {FILTERS.map((f) => (
            <span key={f.key} className={`filt${filter === f.key ? " on" : ""}${f.key === "review_failed" || f.key === "unread" ? " warn" : f.key === "review_passed" || f.key === "review_kept" ? " okf" : ""}`}
              role="button" onClick={() => { setFilter(f.key); onSelect(null); }}>{f.label}</span>
          ))}
          {hit && hitIds.length > 0 && (
            <span className="sw-hitnote" role="button" title="点一下取消高亮" onClick={onClearHit} data-testid="hit-note">修订 {hit.revision} 碰到的条目 ✕</span>
          )}
        </div>
      </>)}
      {submitBar && !readOnly && (
        <div className="alertbar submitbar" data-testid="submit-bar">
          <div className="q"><b>{submitTitle(task)}</b>{submitQuestion(task)}{submitError && <div className="err" data-testid="submit-error">{submitError}</div>}</div>
          <button type="button" className="btn sm pri" disabled={writesOff || !onPublish} onClick={() => setConfirmSubmit(true)} data-testid="submit-deliverable">发布版本</button>
        </div>
      )}
      <Modal title={`发布第 ${nextVersionNo(task)} 版`} open={confirmSubmit} onOk={() => void publishNow()} onCancel={() => setConfirmSubmit(false)} okText="发布" cancelText="取消"
        confirmLoading={submitting} destroyOnHidden>
        <p data-testid="publish-what">把现在的交付物（修订 {latestRevision}）记为第 {nextVersionNo(task)} 版，并存下这一版生成的 Markdown 与 Word，以后可以随时下载当时的样子。
          发布之后仍然可以接着修改，以后再发布新的一版。</p>
        <Input.TextArea value={publishNote} onChange={(e) => setPublishNote(e.target.value)} maxLength={200} autoSize={{ minRows: 2, maxRows: 4 }}
          placeholder="发布说明（可以不写），例如：首版，覆盖借阅主流程。" data-testid="publish-note" />
      </Modal>
      {changesLine(task) && (
        <div className="alertbar verbar" data-testid="changes-bar">
          {changesLine(task)} ·
          <button type="button" className="btn sm" onClick={() => setShowChanges(!showChanges)} data-testid="changes-toggle">{showChanges ? "收起" : "列出来"}</button>
          {showChanges && (
            <div className="verlist" data-testid="changes-list">
              {changesAfter(task).items.map((one) => (
                <span key={one.item_id} className="ref" role="button" onClick={() => { setShowChanges(false); openItem(one.item_id); }}>{one.item_id} {one.title}</span>
              ))}
              {changesAfter(task).diagrams.map((one) => (
                <span key={one.diagram_id} className="ref" role="button" onClick={() => { setShowChanges(false); openDiagram(one.diagram_id); }}>{one.diagram_id} {one.name}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {!noList && unread.length > 0 && filter !== "unread" && (
        <div className="alertbar" data-testid="unread-bar">
          还有 {unread.length} 条未读 ·
          <button type="button" className="btn sm" onClick={() => { setFilter("unread"); onSelect(null); }}>筛出来看</button>
        </div>
      )}
      {!noList && !selectedItem && !readOnly && !statusField && (checkedItems.length > 0 ? (
        <div className="bulkbar">
          已勾选 {checkedItems.length} 个条目。
          <button type="button" className="btn sm pri" disabled={writesOff} title={offTitle} onClick={() => void markMany(checkedItems)} data-testid="bulk-viewed">把选中的这几条标为已读</button>
          <button type="button" className="btn sm" onClick={() => setChecked(new Set())}>取消勾选</button>
        </div>
      ) : null)}
      <ExportDocxModal open={exporting} task={task} items={exportItems} onClose={() => setExporting(false)} />
      <div className={`items-body${onOverall ? " oa-body" : ""}`}>
        {pane === "materials" ? (
          <MaterialsTab task={task} materials={materials} info={info} libraries={libraries} readOnly={readOnly} onView={(path) => onViewMaterial?.(path)} />
        ) : pane === "models" ? (
          <ModelsTab task={task} contents={toc(task)} onView={(id) => goFigure(id)} onOpenItem={(id) => openItem(id)} />
        ) : pane === "review" ? (
          <ReviewTab task={task} reviewButton={onReview && (
            <button type="button" className="btn sm pri" disabled={!!reviewOff} title={reviewOff} data-testid="review-all"
              onClick={() => onReview([], `评审 ${toReview.length} 条待评审的条目`)}>评审 {toReview.length} 条待评审的条目</button>
          )} />
        ) : pane === "docs" ? (
          <DocsTab task={task} readOnly={readOnly} writesOff={writesOff} onGenerate={onGenerateDoc} onPublish={onPublish ? () => setConfirmSubmit(true) : undefined}
            publishError={submitError} onShowRevision={(revision) => onShowRevision?.(revision)} onGo={goTo} />
        ) : onOverall ? (
          <OverallPane task={task} host={figureHost!} headRequest={headRequest} selected={selectedItem?.item_id ?? null} onSelect={onSelect} readOnly={readOnly} writesOff={writesOff} onSend={onSend}
            page={selectedItem && !rawTopic ? (
              <SectionPage key={selectedItem.item_id} task={task} item={selectedItem} def={def!} contents={contents!} readOnly={readOnly} writesOff={writesOff} submit={submit}
                onSend={onSend} onAnswer={onAnswer} onPrefill={onPrefill} onDirty={(d) => { setDirty(d); onDirty?.(d); }}
                onOpen={(id) => openItem(id)} onBack={() => onSelect(null)} onLocate={onLocate} onRaw={() => setRawTopic(true)}
                onPrev={topicPos > 0 ? () => onSelect(topics[topicPos - 1].item_id) : null}
                onNext={topicPos >= 0 && topicPos < topics.length - 1 ? () => onSelect(topics[topicPos + 1].item_id) : null}
                figures={<FigureBlocks host={figureHost!} item={selectedItem} slots={["steps", "state", "relations"]} />}
                links={<>
                  <FigureBlocks host={figureHost!} item={selectedItem} slots={["other"]} />
                  <SectionLinks host={figureHost!} item={selectedItem} onRaw={() => setRawTopic(true)} />
                </>} />
            ) : detail} />
        ) : detail ? detail : items.length === 0 ? (
          <div className="empty">这个筛选下没有条目。换一个筛选试试。</div>
        ) : statusField && def ? (
          <div className="list">
            {items.map((item) => (
              <PendingCard key={item.item_id} task={task} item={item} readOnly={readOnly} writesOff={writesOff} flash={flash.includes(item.item_id)}
                hit={hitIds.includes(item.item_id)} just={just.has(item.item_id)} pending={pendingItems.has(item.item_id)}
                onOpen={() => onSelect(item.item_id)} onOpenItem={(id) => openItem(id, { fromIssue: item.item_id })}
                onKeep={() => void keepPending(item)}
                onAnswer={() => onAnswer?.(item)} />
            ))}
          </div>
        ) : (
          <div className="list">
            {def?.display?.note && <CollectionLead name={def.name} note={def.display.note} />}
            {items.map((item) => {
              const summary = summaryOf(task, item);
              return (
                <div key={item.item_id}>
                  <div className={`lrow${checked.has(item.item_id) ? " sel" : ""}${flash.includes(item.item_id) ? " flash" : ""}${hitIds.includes(item.item_id) ? " sw-hit" : ""}${needsReading(task, item.collection) && isUnread(item) ? " unread" : ""}`}
                    onClick={() => onSelect(item.item_id)} data-testid={`item-${item.item_id}`}>
                    <input type="checkbox" checked={checked.has(item.item_id)} onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setChecked((s) => { const n = new Set(s); if (e.target.checked) n.add(item.item_id); else n.delete(item.item_id); return n; })} />
                    <span className="lid">{item.item_id}</span>
                    <span className="lname" title={item.title}>{item.title}</span>
                    <span className="lsum" title={summary}>{summary}</span>
                    <ItemStatus task={task} item={item} just={just.has(item.item_id)} pending={pendingItems.has(item.item_id)} row />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 任务定义「界面」里写了说明的集合：页签下先写一句白话说明它是什么，再写有几条还没和任何条目关联。 */
export function CollectionLead({ name, note }: { name: string; note: string }) {
  return (
    <div className="dn-lead" data-testid="collection-lead">
      <b>{name}：{note}</b>
    </div>
  );
}

/** 问题条目卡片：编号、枚举字段与状态、牵涉的条目、事项正文、其余文本字段；未解决的带两个动作。 */
function PendingCard({ task, item, readOnly, writesOff, flash, hit, just, pending, onOpen, onOpenItem, onKeep, onAnswer }: {
  task: Task; item: Item; readOnly: boolean; writesOff: boolean; flash: boolean; hit: boolean; just: boolean; pending: boolean;
  onOpen: () => void; onOpenItem: (id: string) => void; onKeep: () => void; onAnswer: () => void;
}) {
  const def = task.definition.collections.find((c) => c.name === item.collection)!;
  const status = keepPendingField(task, item.collection)!;
  const open = item.fields[status.name] === (status.values ?? [])[0];
  const first = def.fields[0]?.name;
  const refs = def.fields.filter((f) => f.type === "条目引用").flatMap((f) => (Array.isArray(item.fields[f.name]) ? (item.fields[f.name] as string[]) : []));
  const texts = def.fields.filter((f) => f.type === "文本" && f.name !== first && !isEmptyValue(item.fields[f.name]));
  return (
    <div className={`tbd${flash ? " flash" : ""}${hit ? " sw-hit" : ""}`} data-testid={`item-${item.item_id}`}>
      <div className="th">
        <span className="tid">{item.item_id}</span>
        <ItemStatus task={task} item={item} just={just} pending={pending} />
        {refs.length > 0 && <span style={{ fontSize: "0.889rem", color: "var(--mut)" }}>牵涉 {refs.map((r) => <span key={r} className="ref" role="button" onClick={() => onOpenItem(r)}>{r}</span>)}</span>}
        <button type="button" className="btn sm" style={{ marginLeft: "auto" }} onClick={onOpen}>看详情</button>
      </div>
      <div className="item-text">{first ? String(item.fields[first] ?? item.title) : item.title}</div>
      {texts.map((f) => <div className="sug" key={f.name}><b>{f.name}：</b>{String(item.fields[f.name])}</div>)}
      {open && (
        <div className="tfoot">
          {/* 「回答这个问题」只往对话区输入框里预填一句话、不写库，执行者工作中也可用；「暂不处理」是写入，工作中灰化 */}
          <button type="button" className="aibtn" disabled={readOnly} onClick={onAnswer} data-testid={`answer-${item.item_id}`}>回答这个问题</button>
          <span className="aihint">回答要发给助手，它改完要等一会儿</span>
          <button type="button" className="btn sm" disabled={readOnly || writesOff || pending} title={writeOffReason(task, { readOnly, writesOff, pending })} onClick={onKeep}
            data-testid={`keep-${item.item_id}`}>暂不处理</button>
        </div>
      )}
    </div>
  );
}
