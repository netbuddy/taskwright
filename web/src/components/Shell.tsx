// 任务列表页与任务页共用的外壳：左侧栏（新建任务、按最近活动排的任务、当前任务的会话）加主体。

import { useEffect, useState, type ReactNode } from "react";
import { Button, Form, Input, Modal, Select, App as AntApp } from "antd";
import { CaretDownOutlined, CaretRightOutlined, MessageOutlined, PlusOutlined } from "@ant-design/icons";
import { api, ApiError } from "../api/client";
import type { SessionListEntry, TaskListEntry } from "../api/types";
import { go, href } from "../router";


export function Shell({ currentTaskId, children }: { currentTaskId?: string; children: ReactNode }) {
  const [tasks, setTasks] = useState<TaskListEntry[]>([]);
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.listTasks().then((list) => setTasks(sortByActivity(list))).catch(() => setTasks([]));
  }, [currentTaskId]);
  useEffect(() => {
    if (currentTaskId) api.listSessions(currentTaskId).then(setSessions).catch(() => setSessions([]));
  }, [currentTaskId]);

  return (
    <div className="shell">
      <div className="shell-card">
        <aside className="sider">
          <div className="sider-head">需求工作台</div>
          <div style={{ padding: "0 8px" }}>
            <Button type="primary" block icon={<PlusOutlined />} onClick={() => setOpen(true)} data-testid="new-task">
              新建任务
            </Button>
          </div>
          <div className="sider-list">
            <div className="sider-caption">任务（按最近活动排序）</div>
            {tasks.map((t) => (
              <div key={t.task_id}>
                <div className={`sider-task${t.task_id === currentTaskId ? " on" : ""}`} onClick={() => go(href.task(t.task_id))}>
                  {t.task_id === currentTaskId ? <CaretDownOutlined /> : <CaretRightOutlined />}
                  <span className="name" title={t.task_name}>{t.task_name}</span>
                  <span className="muted small">{t.session_count}</span>
                </div>
                {t.task_id === currentTaskId &&
                  sessions.map((s) => (
                    <div key={s.session_id} className="sider-session" onClick={() => go(href.work(t.task_id, s.session_id))}>
                      <MessageOutlined />
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                      {s.active && <span style={{ color: "var(--ok)" }}>●</span>}
                    </div>
                  ))}
              </div>
            ))}
          </div>
          <div className="sider-foot">本机用户</div>
        </aside>
        <main className="main">{children}</main>
      </div>
      <NewTaskModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

export function sortByActivity(list: TaskListEntry[]): TaskListEntry[] {
  return [...list].sort((a, b) => String(b.last_active_at).localeCompare(String(a.last_active_at)));
}

export function NewTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [types, setTypes] = useState<{ value: string; label: string }[]>([]);
  const { message } = AntApp.useApp();

  // 任务类型从接口取（GET /api/v1/task-types，与后端对齐后新增）。
  useEffect(() => {
    if (!open) return;
    api.taskTypes()
      .then((list) => {
        const options = list.map((t) => ({ value: t.task_type, label: t.name }));
        setTypes(options);
        if (options[0] && !form.getFieldValue("task_type")) form.setFieldValue("task_type", options[0].value);
      })
      .catch(() => setTypes([]));
  }, [open, form]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const { task_id } = await api.createTask({
        task_type: values.task_type,
        task_name: values.task_name.trim(),
        domain_tag: values.domain_tag?.trim() || null,
      });
      onClose();
      form.resetFields();
      go(href.task(task_id));
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : "新建任务没有成功。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="新建任务" open={open} onCancel={onClose} onOk={submit} okText="新建" cancelText="取消" confirmLoading={saving} destroyOnHidden>
      <p className="muted small">一个任务一份交付物。新建之后在任务页上传材料，再新建会话交给助手。</p>
      <Form form={form} layout="vertical">
        <Form.Item label="任务类型" name="task_type" rules={[{ required: true, message: "请选一种任务类型" }]}>
          <Select options={types} placeholder={types.length ? undefined : "没有读到任务类型"} />
        </Form.Item>
        <Form.Item label="任务名" name="task_name" rules={[{ required: true, whitespace: true, message: "请写一个任务名" }]}>
          <Input placeholder="例如：软件需求规格说明编制：跨境电商退款模块" />
        </Form.Item>
        <Form.Item label="领域标签（可以不写）" name="domain_tag">
          <Input placeholder="例如：电商售后" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
