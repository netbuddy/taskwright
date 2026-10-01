// 任务页：一个任务的总览与入口。自上而下六块：面包屑、任务头、完成条件横条、交付物（每个集合一张卡）、会话清单、
// 材料与选用的知识库两张并排的卡。各块的组件在 components/task/，样式在 styles/task-page.css。
// 数据是一次普通读取（GET …/tasks/{task_id}，里面带材料与会话）。另开一条不带会话的事件连接，只听执行者状态：
// 助手做完一轮时重读一次，会话清单与「最近一次活动」不停在打开页面的那一刻（与工作视图的会话菜单同一个做法）。
// 页面上像结论的句子都由数据算出；集合名、完成条件名从接口取。任务已完成或已放弃时整页只读：「新建会话」、上传区、
// 材料的「删除」与知识库的改选用都不显示，只读说明写明原因。服务没有知识库时不显示知识库卡，材料卡独占一行。

import { useEffect, useState } from "react";
import { Alert, Button, Modal, Spin } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api, ApiError } from "../api/client";
import { openEventStream } from "../api/events";
import type { KnowledgeLibrary, Material, RevisionLogEntry, TaskDetail } from "../api/types";
import { Shell } from "../components/Shell";
import { useToast } from "../components/Toasts";
import { DocumentModal } from "../components/DocumentModal";
import { formatTime, formatTimeShort } from "../model/format";
import { ownMaterials } from "../model/docx";
import { DocxPaper } from "../components/work/DocxPaper";
import { go, href } from "../router";
import { useService } from "../components/ServiceControls";
import { GENERAL } from "../model/knowledge";
import { TaskKnowledgeCard } from "../components/TaskKnowledgeCard";
import { CompletionBar } from "../components/task/CompletionBar";
import { CollectionCards } from "../components/task/CollectionCards";
import { SessionList, byRecentActivity } from "../components/task/SessionList";
import { MaterialsCard } from "../components/task/MaterialsCard";
import "../styles/task-page.css";

export function TaskPage({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  // 生成文档要选修订，修订列表来自修订日志；打开对话框时读一次。
  const [log, setLog] = useState<RevisionLogEntry[]>([]);
  useEffect(() => { if (docOpen) api.revisionLog(taskId).then((r) => setLog(r.revisions)).catch(() => setLog([])); }, [docOpen, taskId]);
  const [material, setMaterial] = useState<{ path: string; text: string } | null>(null);
  // Word 材料的「查看」按原版式显示（与工作视图材料区同一个渲染），不显示给助手读的投影。
  const [wordPath, setWordPath] = useState<string | null>(null);
  const toast = useToast();
  const service = useService();
  const hasKnowledge = !!service.info?.capabilities.knowledge;
  // 全部知识库：「选用别的知识库」的勾选框列表要用。
  const [libraries, setLibraries] = useState<KnowledgeLibrary[]>([]);
  const loadKnowledge = () => { if (hasKnowledge) api.knowledge().then(setLibraries).catch(() => setLibraries([])); };
  useEffect(loadKnowledge, [hasKnowledge]);

  const load = () =>
    api.getTask(taskId).then(setTask).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  useEffect(() => { void load(); }, [taskId]);
  // 执行者状态从工作中变为别的状态（助手做完一轮）时重读任务；刚连上、还不知道之前的状态时收到的第一条非工作中状态也算。
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

  if (error) return <Shell currentTaskId={taskId}><Alert type="error" showIcon message={error} /></Shell>;
  if (!task) return <Shell currentTaskId={taskId}><Spin /></Shell>;

  const closed = task.status !== "进行中";
  const selected = task.knowledge_libraries ?? [GENERAL];
  const sessions = byRecentActivity(task.sessions);
  const lastActive = task.sessions.map((s) => s.last_active_at).filter(Boolean).sort().pop();

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

  const newSession = async () => {
    try {
      const { session_id } = await api.createSession(taskId);
      toast.success("已新建会话。");
      go(href.work(taskId, session_id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "新建会话没有成功。");
    }
  };

  const view = (m: Material) => (/\.docx$/i.test(m.path) ? setWordPath(m.path) : void api.materialContent(taskId, m.path).then(setMaterial));

  return (
    <Shell currentTaskId={taskId}>
      <div className="tp-page" data-testid="task-page">
        <div className="tp-crumb"><a href={href.tasks()}>任务</a><span className="sep">›</span>{task.task_name}</div>

        <header className="tp-head">
          <div className="tp-head-l">
            <div className="tp-head-title">
              <h1>{task.task_name}</h1>
              <span className={`tp-status${closed ? "" : " on"}`} data-testid="task-status">{task.status}</span>
              <span className="tp-ttype">{task.task_type}</span>
              {task.domain_tag && <span className="tp-ttype">{task.domain_tag}</span>}
            </div>
            <div className="tp-head-meta" data-testid="task-meta">
              创建于 {formatTime(task.started_at)}{lastActive ? `，最近一次活动在 ${formatTimeShort(lastActive)}` : ""}。
            </div>
          </div>
          <div className="tp-head-r">
            <Button onClick={() => setDocOpen(true)}>生成文档</Button>
            {!closed && <Button type="primary" icon={<PlusOutlined />} onClick={newSession}>新建会话</Button>}
          </div>
        </header>
        {closed && <Alert type="info" showIcon style={{ marginTop: "0.857rem" }} message={`这个任务${task.status}，整页只读：不能新建会话、上传材料或修改条目，生成文档照常可用。`} />}

        <CompletionBar task={task} />
        <CollectionCards task={task} sessionId={sessions.find((s) => s.last_active_at)?.session_id ?? sessions[0]?.session_id ?? null} />
        <SessionList taskId={taskId} sessions={task.sessions} />

        <div className={`tp-pair${hasKnowledge ? "" : " single"}`}>
          <MaterialsCard taskId={taskId} materials={ownMaterials(task.materials)} closed={closed} info={service.info} onView={view} onChanged={() => void load()} />
          {hasKnowledge && <TaskKnowledgeCard libraries={libraries} selected={selected} readOnly={closed} onChange={changeKnowledge} />}
        </div>
      </div>

      <DocumentModal task={task} log={log} open={docOpen} onClose={() => setDocOpen(false)} />
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
    </Shell>
  );
}
