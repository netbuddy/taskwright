// 任务起点页：任务一级的家。自上而下：面包屑、任务头（任务类型与时刻一行、任务名与一句状态、一段定位的话）、
// 「三步开始」指引与三种常见起点（只在六类需求资产都空着、又没有活动在进行时显示）、需求资产现状六格、工作流程两张卡、
// 单项活动七张卡加「不开展活动」、会话清单、材料与选用的知识库两张并排的卡。这一页没有对话区。
// 外框是工作视图的顶栏加导航条（components/TaskFrame.tsx）；各块的组件在 components/task/，样式在 styles/task-page.css。
// 数据是两次普通读取：任务详情（GET …/tasks/{task_id}，带材料与会话）与任务状况（GET …/status，带资产现状、活动目录与这一页的几段话）。
// 另开一条不带会话的事件连接，只听执行者状态：助手做完一轮时两样都重读一次。
// 点工作流程或单项活动的按钮：在一条新会话里开展它，然后进那条会话的工作台。「不开展活动」是新建一条会话直接进工作台。
// 任务已完成或已放弃时整页只读：没有活动目录，上传区、材料的「删除」与知识库的改选用都不显示，只读说明写明原因。
// 没有阶段的任务（早先建的）没有资产现状与活动目录，这一页只有任务头、「不开展活动」、会话与材料。

import { useEffect, useState } from "react";
import { Alert, Modal, Spin } from "antd";
import { api, ApiError } from "../api/client";
import { openEventStream } from "../api/events";
import type { CatalogActivity, CatalogFlow, KnowledgeLibrary, Material, TaskDetail, TaskStatusView } from "../api/types";
import { TaskFrame } from "../components/TaskFrame";
import { useToast } from "../components/Toasts";
import { saveBlob } from "../model/download";
import { formatTime, formatTimeShort } from "../model/format";
import { ownMaterials } from "../model/docx";
import { DocxPaper } from "../components/work/DocxPaper";
import { PdfPaper } from "../components/work/PdfPaper";
import { go, href } from "../router";
import { useService } from "../components/ServiceControls";
import { GENERAL } from "../model/knowledge";
import { allAssetsEmpty, latestSession, stateLine } from "../model/startPage";
import { TaskKnowledgeCard } from "../components/TaskKnowledgeCard";
import { SessionList } from "../components/task/SessionList";
import { MaterialsCard } from "../components/task/MaterialsCard";
import { ActivityCards, AssetCells, FlowCards, StartGuide } from "../components/task/StartBlocks";
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
  const [material, setMaterial] = useState<{ path: string; text: string } | null>(null);
  // Word 材料的「查看」按原版式显示（与工作视图材料区同一个渲染），不显示给助手读的投影。
  const [wordPath, setWordPath] = useState<string | null>(null);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  // 正在开展的那一项的键（流程或活动的键，「不开展活动」是 none）：请求回来之前各按钮都点不动，免得开展两次。
  const [starting, setStarting] = useState<string | null>(null);
  const toast = useToast();
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
  // 任务已经结束时不开；离开页面时断开。不定时轮询。
  const running = task?.status === "进行中";
  useEffect(() => {
    if (!running) return;
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
  }, [taskId, running]);

  if (error) return <TaskFrame taskId={taskId} where="任务起点" sessions={[]}><div className="tp-page"><Alert type="error" showIcon message={error} /></div></TaskFrame>;
  if (!task) return <TaskFrame taskId={taskId} where="任务起点" sessions={[]}><div className="tp-page"><Spin /></div></TaskFrame>;

  const closed = task.status !== "进行中";
  const selected = task.knowledge_libraries ?? [GENERAL];
  const lastActive = task.sessions.map((s) => s.last_active_at).filter(Boolean).sort().pop();
  const versionNote = taskTypeVersionNote(task.task_type_versions);
  const catalog = status?.catalog ?? null;
  // 「三步开始」只给还没有开始的任务：六类资产都空着，而且没有活动在进行（刚开展了一项、还没有记下内容时不再指引怎样开始）。
  const empty = allAssetsEmpty(status?.assets) && status?.activity.kind === "idle";
  const recommended = catalog?.flows.find((one) => one.recommended) ?? null;
  // 现在这项活动写的那几类资产：它们的格子着色。
  const writing = catalog?.activities.find((one) => one.key === status?.activity.key)?.writes.map((one) => one.key) ?? [];
  const latest = latestSession(task.sessions);

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

  /** 在一条新会话里开展一条流程或一项活动，成功后进那条会话的工作台；不成（例如助手正在工作）就在页上报原因，不跳转。 */
  const startIn = async (key: string, fields: { activity: string; in_flow: boolean }) => {
    if (starting) return;
    setStarting(key);
    try {
      const { session_id } = await api.startInNewSession(taskId, fields);
      go(href.work(taskId, session_id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "没有开展成。");
    } finally {
      setStarting(null);
    }
  };
  const startFlow = (flow: CatalogFlow) => { if (flow.start) void startIn(flow.key, { activity: flow.start, in_flow: true }); };
  const startActivity = (activity: CatalogActivity) => void startIn(activity.key, { activity: activity.key, in_flow: false });

  /** 「不开展活动」：新建一条会话，直接进工作台。 */
  const enterWorkbench = async () => {
    if (starting) return;
    setStarting("none");
    try {
      const { session_id } = await api.createSession(taskId);
      go(href.work(taskId, session_id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "新建会话没有成功。");
    } finally {
      setStarting(null);
    }
  };

  // 查看一份材料：Word 与 PDF 按原样分页显示，别的显示文字。
  const view = (m: Material) => (/\.docx$/i.test(m.path) ? setWordPath(m.path) : /\.pdf$/i.test(m.path) ? setPdfPath(m.path)
    : void api.materialContent(taskId, m.path).then(setMaterial));

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
              {closed ? <span className="tp-status" data-testid="task-status">{task.status}</span>
                : stateLine(status) && <span className="tp-state" data-testid="task-state">{stateLine(status)}</span>}
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
        {closed && <Alert type="info" showIcon style={{ marginTop: "0.857rem" }} message={`这个任务${task.status}，整页只读：不能开展活动、新建会话、上传材料或修改条目。`} />}

        {empty && !closed && <StartGuide flow={recommended} texts={status?.start_page} busy={starting !== null} onStart={startFlow} />}

        {status?.assets && (
          <section className="tp-sec">
            <div className="tp-sec-h"><h2>需求资产现状</h2><span className="tp-sec-note">六类资产构成本项目的需求基础；每类下方写明由哪些活动产出</span></div>
            <AssetCells assets={status.assets} writing={writing} />
          </section>
        )}

        {catalog && (
          <>
            <section className="tp-sec">
              <div className="tp-sec-h"><h2>工作流程</h2><span className="tp-sec-note">按推荐次序串联多项活动；每站完成后助手提议下一站，由你确认后进入</span></div>
              <FlowCards flows={catalog.flows} busy={starting} onStart={startFlow} backHref={latest ? href.work(taskId, latest.session_id) : null} />
            </section>
            <section className="tp-sec">
              <div className="tp-sec-h"><h2>单项活动</h2><span className="tp-sec-note">独立开展其中一项；可否开展取决于其输入资产是否具备；完成后仅汇报结果，不提议下一站</span></div>
              <ActivityCards activities={catalog.activities} busy={starting} onStart={startActivity} onEnter={() => void enterWorkbench()} canEnter={!closed}
                backHref={latest ? href.work(taskId, latest.session_id) : null} />
            </section>
          </>
        )}
        {!catalog && !closed && (
          <section className="tp-sec">
            <div className="tp-sec-h"><h2>进入工作台</h2></div>
            <ActivityCards activities={[]} busy={starting} onStart={startActivity} onEnter={() => void enterWorkbench()} canEnter />
          </section>
        )}

        <SessionList taskId={taskId} sessions={task.sessions} />

        <div className={`tp-pair${hasKnowledge ? "" : " single"}`}>
          <MaterialsCard taskId={taskId} materials={ownMaterials(task.materials)} closed={closed} info={service.info} onView={view} onChanged={() => void load()} />
          {hasKnowledge && <TaskKnowledgeCard libraries={libraries} selected={selected} readOnly={closed} onChange={changeKnowledge} />}
        </div>
      </div>

      <Modal title={material?.path} open={!!material} onCancel={() => setMaterial(null)} footer={null} width="min(54.286rem, 94vw)">
        <pre className="doc-text" style={{ maxHeight: "40rem", overflow: "auto" }}>{material?.text}</pre>
      </Modal>
      <Modal title={wordPath} open={!!wordPath} onCancel={() => setWordPath(null)} footer={null} width="min(64rem, 94vw)" destroyOnHidden>
        {wordPath && (
          <div className="app docx-view">
            <div className="doc-b"><DocxPaper taskId={taskId} path={wordPath} items={[]} locate={null} /></div>
          </div>
        )}
      </Modal>
      <Modal title={pdfPath} open={!!pdfPath} onCancel={() => setPdfPath(null)} footer={null} width="min(64rem, 94vw)" destroyOnHidden>
        {pdfPath && (
          <div className="app docx-view">
            <div className="doc-b pdf-modal-b"><PdfPaper taskId={taskId} path={pdfPath} items={[]} locate={null} /></div>
          </div>
        )}
      </Modal>
    </TaskFrame>
  );
}
