// 任务起点页：任务一级的家，也是活动的目录。自上而下：面包屑、任务头（任务类型与时刻一行、任务名与一句状态、一段定位的话）、
// 待处理事项（有需求资产时显示，model/pendingWork.ts）、工作项（有工作项时显示）、需求资产现状六格、
// 工作流程两张卡、单项活动七张卡与「自由讨论」一行、会话清单、材料与选用的知识库两张并排的卡。这一页没有对话区。
// 「三步开始」指引与三种常见起点是推荐流程的入口，任务里没有流程工作项时才显示：六类资产都空着时在页头之下，
// 已有资产时在「工作项」之后、六格之前，标题改「启动需求分析」。
// 外框是工作视图的顶栏加导航条（components/TaskFrame.tsx）；各块的组件在 components/task/，样式在 styles/task-page.css。
// 数据是两次普通读取：任务详情（GET …/tasks/{task_id}，带材料与会话）与任务状况（GET …/status，带资产现状、活动目录与这一页的几段话）。
// 另开一条不带会话的事件连接，只听执行者状态：助手做完一轮时两样都重读一次。
// 工作流程卡、活动卡、三种常见起点与主按钮都只是进活动输入页（pages/StartInputPage.tsx），启动在那里提交。
// 「自由讨论」不经输入页：新建一条会话直接进工作台。工作项卡上：「打开最新会话」进它最近有动静的那条会话；「换一条干净的会话接着」
// 让后端新建一条属于它的会话再进去（不替用户发话：没说过话就离开的会话不保留，任务状况里也不计入）；「删除这个工作项」先弹确认，
// 写明会归档几条会话，删了之后重读。
// 任务已完成或已放弃时整页只读：没有活动目录，上传区、材料的「删除」与知识库的改选用都不显示，只读说明写明原因。
// 没有阶段的任务（早先建的）没有资产现状与活动目录，这一页只有任务头、「自由讨论」、会话与材料。

import { useEffect, useState } from "react";
import { Alert, App as AntApp, Spin } from "antd";
import { api, ApiError } from "../api/client";
import { openEventStream } from "../api/events";
import type { KnowledgeLibrary, TaskDetail, TaskStatusView, WorkItemView } from "../api/types";
import { TaskFrame } from "../components/TaskFrame";
import { useToast } from "../components/Toasts";
import { saveBlob } from "../model/download";
import { formatTime, formatTimeShort } from "../model/format";
import { ownMaterials } from "../model/docx";
import { go, href } from "../router";
import { useService } from "../components/ServiceControls";
import { GENERAL } from "../model/knowledge";
import { allAssetsEmpty, deleteConfirmText, stateLine } from "../model/startPage";
import { TaskKnowledgeCard } from "../components/TaskKnowledgeCard";
import { SessionList } from "../components/task/SessionList";
import { MaterialsCard } from "../components/task/MaterialsCard";
import { useMaterialViewer } from "../components/task/MaterialViewer";
import { ActivityCards, AssetCells, FlowCards, FreeTalk, StartGuide, WorkItemCards } from "../components/task/StartBlocks";
import { PendingWorkSection } from "../components/task/PendingWork";
import { showsPendingWork } from "../model/pendingWork";
import "../styles/task-page.css";

/**
 * 任务类型说明的版本与产品自带的不同时的那一句；两个数有一个没有记、或者相同，就不写（返回 null）。
 * 说明是建任务时复制进任务目录的，不随程序升级更新，所以旧任务用的可能是旧的一版。
 */
export function taskTypeVersionNote(versions: { copied: number | null; current: number | null } | undefined): string | null {
  if (!versions || versions.copied === null || versions.current === null || versions.copied === versions.current) return null;
  return `任务类型说明是 ${versions.copied} 版，当前产品自带的是 ${versions.current} 版。`;
}

export function TaskPage({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  // 任务状况：资产现状、活动目录与这一页的几段话。读不到（没有阶段的任务、早先的后端）时是 null，页面只画任务详情里有的。
  const [status, setStatus] = useState<TaskStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { view, viewer } = useMaterialViewer(taskId);
  // 「自由讨论」新建会话的请求还没有回来：按钮点不动，免得建出两条会话。
  const [entering, setEntering] = useState(false);
  const toast = useToast();
  const { modal } = AntApp.useApp();
  // 工作项卡上某个按钮的请求还没有回来（新建会话、删除）：卡上的按钮都点不动。
  const [itemBusy, setItemBusy] = useState(false);
  const service = useService();
  const hasKnowledge = !!service.info?.capabilities.knowledge;
  // 全部知识库：「选用别的知识库」的勾选框列表要用。
  const [libraries, setLibraries] = useState<KnowledgeLibrary[]>([]);
  const loadKnowledge = () => { if (hasKnowledge) api.knowledge().then(setLibraries).catch(() => setLibraries([])); };
  useEffect(loadKnowledge, [hasKnowledge]);

  const load = () => {
    void api.taskStatus(taskId).then((r) => setStatus(r.status)).catch(() => setStatus(null));
    return api.getTask(taskId).then(setTask).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  };
  useEffect(() => { void load(); }, [taskId]);
  // 执行者状态从工作中变为别的状态（助手做完一轮）时重读；刚连上、还不知道之前的状态时收到的第一条非工作中状态也算。
  // 连接不带会话，服务把整个任务的事件都发过来，这里只看 executor_state；不带 Last-Event-ID，不补发旧事件。
  // 断线照 openEventStream 的办法重连，重新连上时重读一次（断开期间可能错过一轮的结束）。
  // 任务读到之后才开；离开页面时断开。不定时轮询。
  const loaded = !!task;
  useEffect(() => {
    if (!loaded) return;
    let last: string | null = null;
    let opened = false;
    return openEventStream(`/api/v1/tasks/${encodeURIComponent(taskId)}/events`, () => null, {
      onMessage: (m) => {
        if (m.event !== "executor_state") return;
        const state = (m.data as { state?: string } | null)?.state ?? null;
        if (state !== "working" && (last === null || last === "working")) void load();
        last = state;
      },
      onStatus: (status) => {
        if (status !== "open") return;
        if (opened) void load();
        opened = true;
      },
    });
  }, [taskId, loaded]);

  if (error) return <TaskFrame taskId={taskId} where="任务起点" sessions={[]}><div className="tp-page"><Alert type="error" showIcon message={error} /></div></TaskFrame>;
  if (!task) return <TaskFrame taskId={taskId} where="任务起点" sessions={[]}><div className="tp-page"><Spin /></div></TaskFrame>;

  const selected = task.knowledge_libraries ?? [GENERAL];
  const lastActive = task.sessions.map((s) => s.last_active_at).filter(Boolean).sort().pop();
  const versionNote = taskTypeVersionNote(task.task_type_versions);
  const catalog = status?.catalog ?? null;
  const workItems = status?.work_items ?? [];
  // 「三步开始」是推荐流程的入口：任务里没有流程工作项时显示（流程工作项每个任务至多一条，有了就从它的卡片接着做）。
  // 六类资产都空着时排在页头之下；已有资产时排在「工作项」之后、六格之前。任务状况读回来之前不画，免得一闪。
  const guide = !!status && !workItems.some((one) => one.kind === "flow");
  const guideFirst = guide && allAssetsEmpty(status?.assets);
  const materialCount = ownMaterials(task.materials).length;
  const recommended = catalog?.flows.find((one) => one.recommended) ?? null;

  const changeKnowledge = async (ids: string[]) => {
    try {
      await api.setTaskKnowledge(taskId, ids);
      void load();
      loadKnowledge();
      return true;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "选用的知识库没有改成。");
      return false;
    }
  };

  /** 调试模式下的「导出为用户画像」：让后端把这个任务里用户说过的话整理成草稿，存成一份 JSON 文件。 */
  const exportPersona = async () => {
    try {
      const draft = await api.personaDraft(taskId);
      saveBlob(new Blob([`${JSON.stringify(draft.persona, null, 2)}\n`], { type: "application/json" }), draft.file_name);
      toast.success(`已导出 ${draft.facts} 条，来自 ${draft.sessions} 条会话。关键词、人设与目标要你自己补。`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "没有导出成。");
    }
  };

  /** 「打开最新会话」：进这个工作项最近有动静的那条会话；它一条还在的会话都没有时，新建一条属于它的会话再进去。 */
  const openWorkItem = (item: WorkItemView) => {
    if (item.latest_session) go(href.work(taskId, item.latest_session.session_id));
    else void continueWorkItem(item);
  };

  /** 「换一条干净的会话接着」：后端新建一条属于这个工作项的会话，进去。不替用户发第一句话。 */
  const continueWorkItem = async (item: WorkItemView) => {
    if (itemBusy) return;
    setItemBusy(true);
    try {
      const { session_id } = await api.continueWorkItem(taskId, item.record_id);
      go(href.work(taskId, session_id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "新建会话没有成功。");
    } finally {
      setItemBusy(false);
    }
  };

  /** 「删除这个工作项」：先确认，写明会归档几条会话；删了之后提示归档了几条，重读这一页。 */
  const deleteWorkItem = (item: WorkItemView) => {
    if (itemBusy) return;
    modal.confirm({
      title: `删除工作项「${item.name}」？`,
      content: deleteConfirmText(item),
      okText: "删除", cancelText: "取消", okButtonProps: { danger: true },
      onOk: async () => {
        setItemBusy(true);
        try {
          const done = await api.deleteWorkItem(taskId, item.record_id);
          toast.success(`已删除工作项「${item.name}」${done.archived_sessions > 0 ? `，归档了 ${done.archived_sessions} 条会话` : ""}。`);
          void load();
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : "删除没有成功。");
        } finally {
          setItemBusy(false);
        }
      },
    });
  };

  /** 流程卡上的「打开它的会话」：那个流程工作项在工作项清单里，照「打开最新会话」办。 */
  const openFlowItem = (recordId: number) => {
    const item = workItems.find((one) => one.record_id === recordId);
    if (item) openWorkItem(item);
  };

  /** 「自由讨论」：新建一条会话，直接进工作台。 */
  const enterWorkbench = async () => {
    if (entering) return;
    setEntering(true);
    try {
      const { session_id } = await api.createSession(taskId);
      go(href.work(taskId, session_id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "新建会话没有成功。");
    } finally {
      setEntering(false);
    }
  };

  return (
    <TaskFrame taskId={taskId} taskName={task.task_name} where="任务起点" sessions={task.sessions}>
      <div className="tp-page" data-testid="task-page">
        <div className="tp-crumb"><a href={href.tasks()}>任务</a><span className="sep">›</span>{task.task_name}</div>

        <header className="tp-head">
          <div className="tp-head-l">
            <div className="tp-head-meta" data-testid="task-meta">
              任务类型：{task.task_type}{task.domain_tag ? ` · ${task.domain_tag}` : ""} · 创建于 {formatTime(task.started_at)}{lastActive ? `，最近一次活动在 ${formatTimeShort(lastActive)}` : ""}。
              {versionNote && <span data-testid="task-type-version">{versionNote}</span>}
            </div>
            <div className="tp-head-title">
              <h1>{task.task_name}</h1>
              {stateLine(status) && <span className="tp-state" data-testid="task-state">{stateLine(status)}</span>}
            </div>
            {status?.start_page && <p className="tp-lead" data-testid="task-lead">{status.start_page.lead}</p>}
          </div>
          {service.info?.debug && (
            <div className="tp-head-r">
              <button className="btn sm" onClick={() => void exportPersona()} title="把这个任务里你说过的话整理成模拟器用户画像的草稿，存成一份文件。只在调试模式下有。"
                data-testid="export-persona">导出为用户画像</button>
            </div>
          )}
        </header>
        {guideFirst && <StartGuide taskId={taskId} flow={recommended} texts={status?.start_page} materials={materialCount} />}

        {showsPendingWork(task, status) && (
          <section className="tp-sec">
            <div className="tp-sec-h"><h2>待处理事项</h2><span className="tp-sec-note">由需求资产上的记号汇总；每一项可直接启动对应的活动，或打开做它的会话</span></div>
            <PendingWorkSection task={task} status={status} />
          </section>
        )}

        {workItems.length > 0 && (
          <section className="tp-sec">
            <div className="tp-sec-h"><h2>工作项</h2><span className="tp-sec-note">每个工作项有自己的会话；打开会话接着做，或换一条干净的会话接着；按最近有动静的先后排列，不要的直接删除</span></div>
            <WorkItemCards items={workItems} busy={itemBusy} onOpen={openWorkItem} onContinue={(item) => void continueWorkItem(item)} onDelete={deleteWorkItem} />
          </section>
        )}

        {guide && !guideFirst && <StartGuide taskId={taskId} flow={recommended} texts={status?.start_page} materials={materialCount} compact />}

        {status?.assets && (
          <section className="tp-sec">
            <div className="tp-sec-h"><h2>需求资产现状</h2><span className="tp-sec-note">六类资产构成本项目的需求基础；每类下方写明由哪些活动产出</span></div>
            <AssetCells assets={status.assets} />
          </section>
        )}

        {catalog && (
          <>
            <section className="tp-sec">
              <div className="tp-sec-h"><h2>工作流程</h2><span className="tp-sec-note">按推荐次序串联多项活动；每站完成后助手提议下一站，由你确认后进入。每次启动新建一个工作项和一条会话</span></div>
              <FlowCards taskId={taskId} flows={catalog.flows} onOpenWorkItem={openFlowItem} />
            </section>
            <section className="tp-sec">
              <div className="tp-sec-h"><h2>单项活动</h2><span className="tp-sec-note">独立启动其中一项；可否启动取决于其输入资产是否具备；完成后仅汇报结果，不提议下一站。同一项活动可以有多个工作项，靠范围说明区分</span></div>
              <ActivityCards taskId={taskId} activities={catalog.activities} />
              <FreeTalk busy={entering} onEnter={() => void enterWorkbench()} />
            </section>
          </>
        )}
        {!catalog && (
          <section className="tp-sec">
            <div className="tp-sec-h"><h2>进入工作台</h2></div>
            <FreeTalk busy={entering} onEnter={() => void enterWorkbench()} />
          </section>
        )}

        <SessionList taskId={taskId} sessions={task.sessions} />

        <div className={`tp-pair${hasKnowledge ? "" : " single"}`}>
          <MaterialsCard taskId={taskId} materials={ownMaterials(task.materials)} info={service.info} onView={view} onChanged={() => void load()} />
          {hasKnowledge && <TaskKnowledgeCard libraries={libraries} selected={selected} readOnly={false} onChange={changeKnowledge} />}
        </div>
      </div>

      {viewer}
    </TaskFrame>
  );
}
