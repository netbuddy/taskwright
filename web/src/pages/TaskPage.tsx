// 任务页：一次普通读取（GET …/tasks/{task_id}，里面带材料与会话）。另开一条不带会话的事件连接，只听执行者状态：
// 助手做完一轮时重读一次，会话卡片与「最近一次活动」不停在打开页面的那一刻（与工作视图的会话菜单同一个做法）。
// 页面上像结论的句子都由数据算出；集合名、完成条件名从接口取。任务已完成或已放弃时整页只读：「新建会话」、上传框与材料的「删除」都不显示，
// 只读说明写明原因。
// 服务有知识库时：上传框选好文件后先弹出「这份文件用来做什么？」（UploadDestinationModal），按选择上传成材料或放进知识库；
// 材料清单旁边另有「选用的知识库」一栏（TaskKnowledgeCard）。没有知识库的旧服务照旧直接上传成材料。
// 每份材料一行有「删除」：先确认，删除之后引用它的条目上的来源照旧保留，工作视图里出处旁写明已经删除。

import { useEffect, useState } from "react";
import { Alert, Button, Empty, Modal, Spin, Upload } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api, ApiError } from "../api/client";
import { openEventStream } from "../api/events";
import type { KnowledgeLibrary, RevisionLogEntry, TaskDetail } from "../api/types";
import { Shell } from "../components/Shell";
import { useToast } from "../components/Toasts";
import { DocumentModal } from "../components/DocumentModal";
import { CompletionPanel } from "../components/CompletionPanel";
import { completionHeadline, isUnread, needsReview, reviewCounts } from "../model/items";
import { formatBytes, formatTime } from "../model/format";
import { ownMaterials } from "../model/docx";
import { DocxPaper } from "../components/work/DocxPaper";
import { go, href } from "../router";
import { useService } from "../components/ServiceControls";
import { tooLargeText, unsupportedTypeText, uploadAccept, uploadLimitText, uploadTypesText } from "../model/upload";
import { GENERAL, knowledgeLimitText, knowledgeTooLargeText } from "../model/knowledge";
import { type UploadChoice, UploadDestinationModal } from "../components/UploadDestinationModal";
import { TaskKnowledgeCard } from "../components/TaskKnowledgeCard";
import { statusTag } from "./TaskListPage";

export function TaskPage({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  // 生成文档要选修订，修订列表来自修订日志；打开对话框时读一次。
  const [log, setLog] = useState<RevisionLogEntry[]>([]);
  useEffect(() => { if (docOpen) api.revisionLog(taskId).then((r) => setLog(r.revisions)).catch(() => setLog([])); }, [docOpen, taskId]);
  const [material, setMaterial] = useState<{ path: string; text: string } | null>(null);
  // Word 材料的「查看原文」按原版式显示（与工作视图材料区同一个渲染），不显示给助手读的投影。
  const [wordPath, setWordPath] = useState<string | null>(null);
  const toast = useToast();
  const service = useService();
  const hasKnowledge = !!service.info?.capabilities.knowledge;
  // 上传框说明里写类型与大小的两半句，都取自服务信息；还没取到时两半句都不写，不猜。有知识库时大小分材料与放进知识库的两种写。
  const limit = uploadLimitText(service.info);
  const kbLimit = knowledgeLimitText(service.info);
  const hintParts = [uploadTypesText(service.info), hasKnowledge && limit && kbLimit ? `材料${limit}，放进知识库的${kbLimit.replace("单个文件", "单个")}` : limit]
    .filter(Boolean);
  // 知识库：全部库（选用框与上传对话框要用），选好文件、等着选去向的那份文件，删除材料前确认的那份。
  const [libraries, setLibraries] = useState<KnowledgeLibrary[]>([]);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
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

  const uploadMaterial = async (file: File) => {
    const r = await api.uploadMaterial(taskId, file);
    toast.success(`已上传：${r.path}`);
    void load();
  };

  // 按对话框的选择上传：材料照旧；放进知识库时先建库（选了「新建一个库…」），再上传，勾了「同时让这个任务选用它」就改选用。
  const uploadChosen = async (choice: UploadChoice) => {
    const file = pendingFile;
    if (!file) return;
    const refused = choice.dest === "material" ? tooLargeText(service.info, file) : knowledgeTooLargeText(service.info, file);
    if (refused) {
      toast.error(refused);
      return;
    }
    setUploading(true);
    try {
      if (choice.dest === "material") {
        await uploadMaterial(file);
      } else {
        let id = choice.library;
        let name = libraries.find((l) => l.id === id)?.name ?? "";
        if (id === null) {
          const created = await api.createLibrary(choice.newName);
          id = created.id;
          name = created.name;
        }
        await api.uploadDocument(id, file, choice.kind);
        if (choice.alsoSelect) await api.setTaskKnowledge(taskId, [...selected, id]);
        toast.success(`已放进知识库「${name}」：${file.name}。`);
        void load();
      }
      setPendingFile(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "上传没有成功。");
    } finally {
      setUploading(false);
      loadKnowledge();
    }
  };

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

  const deleteMaterial = async () => {
    const path = deleting;
    if (!path) return;
    try {
      await api.deleteMaterial(taskId, path);
      toast.success(`已删除材料《${path.split("/").pop()}》。`);
      setDeleting(null);
      void load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "删除没有成功。");
    }
  };
  const completion = task.completion;
  const lastActive = task.sessions.map((s) => s.last_active_at).filter(Boolean).sort().pop();

  const newSession = async () => {
    try {
      const { session_id } = await api.createSession(taskId);
      toast.success("已新建会话。");
      go(href.work(taskId, session_id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "新建会话没有成功。");
    }
  };

  return (
    <Shell currentTaskId={taskId}>
      <div className="muted small" style={{ marginBottom: "0.429rem" }}><a href={href.tasks()}>任务</a> › {task.task_name}</div>
      <div className="page-title" style={{ justifyContent: "space-between" }}>
        <div className="page-title">
          <h1>{task.task_name}</h1>
          {statusTag(task.status)}
          <span className="chip">任务类型：{task.task_type}</span>
          {task.domain_tag && <span className="chip">{task.domain_tag}</span>}
        </div>
        <div style={{ display: "flex", gap: "0.571rem" }}>
          <Button onClick={() => setDocOpen(true)}>生成文档</Button>
          {!closed && <Button type="primary" icon={<PlusOutlined />} onClick={newSession}>新建会话</Button>}
        </div>
      </div>
      <p className="lede">
        交付物现在一共 {task.items.length} 个条目，
        {completion ? completionHeadline(completion) : "完成条件这次没有算出来。"}
        任务创建于 {formatTime(task.started_at)}{lastActive ? `，最近一次活动是 ${formatTime(lastActive)}` : ""}。
      </p>
      {closed && <Alert type="info" showIcon style={{ marginBottom: "0.857rem" }} message={`这个任务${task.status}，整页只读：不能新建会话、上传材料或修改条目，生成文档照常可用。`} />}

      <div className="section-title">交付物看板 <span className="muted" style={{ fontWeight: 400 }}>按条目集合分开看：每个集合现在有几个条目、最后一次被改是哪次修订、有几个条目在当前所在的修订上已经评审通过、有几个你已经看过（已读）。</span></div>
      <div className="board">
        {task.definition.collections.map((coll) => {
          const items = task.items.filter((i) => i.collection === coll.name);
          // 评审通过只数真正通过的；保留了写法的单列「已保留写法 N」，为 0 时不写。没有待评审、也没有评审不通过（未保留）的条目时是绿色。
          const counts = reviewCounts(task, coll.name);
          const reviewed = counts.passed;
          const reviewDone = items.length > 0 && counts.pending === 0 && counts.failed === 0;
          const confirmed = items.filter((i) => !isUnread(i)).length;
          const latest = items.reduce((m, i) => Math.max(m, i.revision_no), 0);
          // 不评审的集合（问题、领域说明之类）不写「评审通过 0/N」。空的集合两枚标签都不写：0/0 不说明什么，琥珀色留给真正要处理的事。
          const reviewed_ = needsReview(task, coll.name);
          const empty = items.length === 0;
          return (
            <div className="card" key={coll.name} data-testid={`board-${coll.name}`}>
              <div className="muted small">{coll.name}（编号前缀 {coll.prefix}）</div>
              <div><span className="count">{items.length}</span> 个条目</div>
              <div className="chips">
                {items.length > 0 && <span className="chip">最后改在修订 {latest}</span>}
                {reviewed_ && !empty && <span className={`chip ${reviewDone ? "ok" : "warn"}`} data-testid={`board-review-${coll.name}`}>评审通过 {reviewed}/{items.length}{counts.kept > 0 ? ` · 已保留写法 ${counts.kept}` : ""}</span>}
                {!empty && <span className={`chip ${confirmed === items.length ? "ok" : "warn"}`} data-testid={`board-read-${coll.name}`}>已读 {confirmed}/{items.length}</span>}
              </div>
              <div className="muted small">
                {empty ? "这个集合还没有条目。" : reviewed_
                  ? `这 ${items.length} 个条目里，${reviewed} 个在当前所在的修订上评审通过，${counts.kept > 0 ? `${counts.kept} 个评审不通过但你保留了写法（按你的决定算通过），` : ""}你已经看过其中 ${confirmed} 个（已读）。`
                  : `这 ${items.length} 个条目里，你已经看过 ${confirmed} 个（已读）。这个集合不评审。`}
              </div>
            </div>
          );
        })}
      </div>

      <div className="two-col">
        <div>
          <div className="section-title">完成条件</div>
          <div className="card"><CompletionPanel completion={completion} status={task.status} items={task.items} task={task} /></div>
        </div>
        <div>
          <div className="section-title">材料清单</div>
          <div className="card">
            <div className="small" style={{ marginBottom: "0.571rem" }}>
              这个任务现在有 {ownMaterials(task.materials).length} 份材料。助手读的就是这几份文件。
            </div>
            {ownMaterials(task.materials).map((m) => (
              <div key={m.path} style={{ display: "flex", alignItems: "center", gap: "0.571rem", padding: "0.286rem 0" }} data-testid="material-row">
                <span style={{ flex: 1 }}>{m.path.split("/").pop()}</span>
                <span className="muted small">{formatBytes(m.bytes)} · {formatTime(m.modified_at)}</span>
                <Button size="small" onClick={() => (/\.docx$/i.test(m.path) ? setWordPath(m.path) : api.materialContent(taskId, m.path).then(setMaterial))}>查看原文</Button>
                {!closed && <Button size="small" onClick={() => setDeleting(m.path)} data-testid="material-delete">删除</Button>}
              </div>
            ))}
            {!closed && (
              <Upload.Dragger
                accept={uploadAccept(service.info)}
                showUploadList={false}
                style={{ marginTop: "0.714rem" }}
                customRequest={async ({ file, onSuccess, onError }) => {
                  // 类型不符或超过上限的文件不发请求，直接报后端给的那句话（先查类型，与后端的先后相同）。
                  // 拖进来的文件与在选择框里选了「所有文件」时选中的文件都不经过滤，所以类型也要在这里查。
                  // 有知识库时大小要等选了去向才知道按哪个上限查，先弹出对话框。
                  const refused = unsupportedTypeText(service.info, file as File) ?? (hasKnowledge ? null : tooLargeText(service.info, file as File));
                  if (refused) {
                    toast.error(refused);
                    onError?.(new Error(refused));
                    return;
                  }
                  if (hasKnowledge) {
                    setPendingFile(file as File);
                    onSuccess?.({});
                    return;
                  }
                  try {
                    await uploadMaterial(file as File);
                    onSuccess?.({});
                  } catch (e) {
                    toast.error(e instanceof ApiError ? e.message : "上传没有成功。");
                    onError?.(e as Error);
                  }
                }}
              >
                <span className="muted small" data-testid="upload-hint">把文件拖到这里，或者点这里选择文件{hintParts.length ? `（${hintParts.join("，")}）` : ""}。新传的材料下一次会话开始时助手就能看到。</span>
              </Upload.Dragger>
            )}
          </div>

          {hasKnowledge && (
            <>
              <div className="section-title">选用的知识库</div>
              <TaskKnowledgeCard libraries={libraries} selected={selected} readOnly={closed} onChange={changeKnowledge} />
            </>
          )}

          <div className="section-title">会话</div>
          <div className="card">
            {task.sessions.length === 0 && <Empty description="这个任务还没有会话" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
            {task.sessions.map((s) => (
              <div key={s.session_id} style={{ display: "flex", alignItems: "center", gap: "0.571rem", padding: "0.357rem 0" }}>
                <span style={{ flex: 1 }}><b>{s.name}</b> {s.active && <span className="chip ok">活动中</span>}</span>
                <span className="muted small">{s.message_count} 条消息 · 最近活动 {formatTime(s.last_active_at)}</span>
                <Button size="small" onClick={() => go(href.work(taskId, s.session_id))}>进入</Button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <DocumentModal task={task} log={log} open={docOpen} onClose={() => setDocOpen(false)} />
      <UploadDestinationModal file={pendingFile} libraries={libraries} selected={selected} info={service.info} busy={uploading}
        onCancel={() => setPendingFile(null)} onUpload={(choice) => void uploadChosen(choice)} />
      <Modal title={deleting ? `删除材料《${deleting.split("/").pop()}》？` : ""} open={!!deleting} onCancel={() => setDeleting(null)}
        onOk={() => void deleteMaterial()} okText="删除" cancelText="取消" destroyOnHidden>
        <p>删除之后，已经引用它的条目上的来源仍然保留，出处旁会写明这份材料已经删除。</p>
      </Modal>
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
