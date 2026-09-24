// 任务页：一次普通读取（GET …/tasks/{task_id}，里面带材料与会话），不连事件流，刷新即最新。
// 页面上像结论的句子都由数据算出；集合名、完成条件名从接口取。任务已完成或已放弃时整页只读。

import { useEffect, useState } from "react";
import { Alert, Button, Empty, Modal, Spin, Upload, App as AntApp } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api, ApiError } from "../api/client";
import type { RevisionLogEntry, TaskDetail } from "../api/types";
import { Shell } from "../components/Shell";
import { DocumentModal } from "../components/DocumentModal";
import { CompletionPanel } from "../components/CompletionPanel";
import { completionHeadline, isUnread, reviewState } from "../model/items";
import { formatBytes, formatTime } from "../model/format";
import { go, href } from "../router";
import { statusTag } from "./TaskListPage";

export function TaskPage({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  // 生成文档要选修订，修订列表来自修订日志；打开对话框时读一次。
  const [log, setLog] = useState<RevisionLogEntry[]>([]);
  useEffect(() => { if (docOpen) api.revisionLog(taskId).then((r) => setLog(r.revisions)).catch(() => setLog([])); }, [docOpen, taskId]);
  const [material, setMaterial] = useState<{ path: string; text: string } | null>(null);
  const { message } = AntApp.useApp();

  const load = () =>
    api.getTask(taskId).then(setTask).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  useEffect(() => { void load(); }, [taskId]);

  if (error) return <Shell currentTaskId={taskId}><Alert type="error" showIcon message={error} /></Shell>;
  if (!task) return <Shell currentTaskId={taskId}><Spin /></Shell>;

  const closed = task.status !== "进行中";
  const completion = task.completion;
  const lastActive = task.sessions.map((s) => s.last_active_at).filter(Boolean).sort().pop();

  const newSession = async () => {
    try {
      const { session_id } = await api.createSession(taskId);
      go(href.work(taskId, session_id));
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : "新建会话没有成功。");
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
          <Button type="primary" icon={<PlusOutlined />} disabled={closed} onClick={newSession}>新建会话</Button>
        </div>
      </div>
      <p className="lede">
        交付物现在一共 {task.items.length} 个条目，
        {completion ? completionHeadline(completion) : "完成条件这次没有算出来。"}
        任务创建于 {formatTime(task.started_at)}{lastActive ? `，最近一次活动是 ${formatTime(lastActive)}` : ""}。
      </p>
      {closed && <Alert type="info" showIcon style={{ marginBottom: "0.857rem" }} message={`这个任务${task.status}，整页只读：不能新建会话、上传材料或修改条目，生成文档照常可用。`} />}

      <div className="section-title">交付物看板 <span className="muted" style={{ fontWeight: 400 }}>按条目集合分开看：每个集合现在有几个条目、最后一次被改是哪次修订、有几个条目在当前所在的修订上已经评审通过、有几个用户已经看过（已读）。</span></div>
      <div className="board">
        {task.definition.collections.map((coll) => {
          const items = task.items.filter((i) => i.collection === coll.name);
          const reviewed = items.filter((i) => reviewState(i).state === "passed").length;
          const confirmed = items.filter((i) => !isUnread(i)).length;
          const latest = items.reduce((m, i) => Math.max(m, i.revision_no), 0);
          return (
            <div className="card" key={coll.name}>
              <div className="muted small">{coll.name}（编号前缀 {coll.prefix}）</div>
              <div><span className="count">{items.length}</span> 个条目</div>
              <div className="chips">
                {items.length > 0 && <span className="chip">最后改在修订 {latest}</span>}
                <span className={`chip ${reviewed === items.length && items.length ? "ok" : "warn"}`}>评审通过 {reviewed}/{items.length}</span>
                <span className={`chip ${confirmed === items.length && items.length ? "ok" : "warn"}`}>已读 {confirmed}/{items.length}</span>
              </div>
              <div className="muted small">
                {items.length === 0 ? "这个集合还没有条目。" : `这 ${items.length} 个条目里，${reviewed} 个在当前所在的修订上有评审通过的记录，${confirmed} 个用户已经看过（已读）。`}
              </div>
            </div>
          );
        })}
      </div>

      <div className="two-col">
        <div>
          <div className="section-title">完成条件</div>
          <div className="card"><CompletionPanel completion={completion} status={task.status} items={task.items} /></div>
        </div>
        <div>
          <div className="section-title">材料清单</div>
          <div className="card">
            <div className="small" style={{ marginBottom: "0.571rem" }}>这个任务现在有 {task.materials.length} 份材料。助手读的就是这几份文件。</div>
            {task.materials.map((m) => (
              <div key={m.path} style={{ display: "flex", alignItems: "center", gap: "0.571rem", padding: "0.286rem 0" }}>
                <span style={{ flex: 1 }}>{m.path.split("/").pop()}</span>
                <span className="muted small">{formatBytes(m.bytes)} · {formatTime(m.modified_at)}</span>
                <Button size="small" onClick={() => api.materialContent(taskId, m.path).then(setMaterial)}>查看原文</Button>
              </div>
            ))}
            {!closed && (
              <Upload.Dragger
                accept=".md,.txt"
                showUploadList={false}
                style={{ marginTop: "0.714rem" }}
                customRequest={async ({ file, onSuccess, onError }) => {
                  try {
                    const r = await api.uploadMaterial(taskId, file as File);
                    message.success(`已上传：${r.path}`);
                    onSuccess?.(r);
                    void load();
                  } catch (e) {
                    message.error(e instanceof ApiError ? e.message : "上传没有成功。");
                    onError?.(e as Error);
                  }
                }}
              >
                <span className="muted small">把文件拖到这里，或者点这里选择文件（只收 .md 与 .txt，单个不超过 5 MB）。新传的材料下一次会话开始时助手就能看到。</span>
              </Upload.Dragger>
            )}
          </div>

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
      <Modal title={material?.path} open={!!material} onCancel={() => setMaterial(null)} footer={null} width="min(54.286rem, 94vw)">
        <pre className="doc-text" style={{ maxHeight: "40rem", overflow: "auto" }}>{material?.text}</pre>
      </Modal>
    </Shell>
  );
}
