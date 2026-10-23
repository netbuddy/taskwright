// 没有任务的页面（任务列表页、知识库页）的外壳：左边是全站同一个导航栏（components/work/LeftNav.tsx），只有「任务列表」一行、参考一段与底部三行，
// 这一页那一行高亮；右边是页面主体。知识库清单（导航栏「知识库」一行的计数）由知识库页给，别的页面这里另取一次（服务有知识库时）。
// 新建任务在任务列表页正文上（NewTaskModal）；全部任务也在正文的表格里，导航栏不另列。

import { useEffect, useState, type ReactNode } from "react";
import { Form, Input, Modal, Select } from "antd";
import { api, ApiError } from "../api/client";
import type { KnowledgeLibrary, TaskListEntry } from "../api/types";
import { go, href } from "../router";
import { useToast } from "./Toasts";
import { NoModelBanner, useService } from "./ServiceControls";
import { LeftNav } from "./work/LeftNav";

export function Shell({ nav = "tasks", libraries, children }: {
  nav?: "tasks" | "knowledge";
  /** 知识库页面自己有库的清单，给了就用它算计数，增删库之后导航栏跟着变。 */
  libraries?: Pick<KnowledgeLibrary, "documents">[];
  children: ReactNode;
}) {
  const service = useService();
  const hasKnowledge = service.info ? !!service.info.capabilities.knowledge : null;
  const [loaded, setLoaded] = useState<KnowledgeLibrary[] | null>(null);
  useEffect(() => {
    if (!hasKnowledge || libraries) return;
    let live = true;
    api.knowledge().then((list) => { if (live) setLoaded(list); }).catch(() => undefined);
    return () => { live = false; };
  }, [hasKnowledge, !!libraries]);

  return (
    <div className="shell">
      <NoModelBanner />
      <div className="shell-card">
        <LeftNav here={nav} libraries={hasKnowledge === false ? undefined : libraries ?? loaded} />
        <main className="main">{children}</main>
      </div>
    </div>
  );
}

export function sortByActivity(list: TaskListEntry[]): TaskListEntry[] {
  // 时刻的写法可能带不同的时区，按时刻本身比；没有时刻的排在最后。
  const at = (t: TaskListEntry) => (t.last_active_at ? Date.parse(t.last_active_at) : Number.NEGATIVE_INFINITY);
  return [...list].sort((a, b) => at(b) - at(a));
}

export function NewTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [types, setTypes] = useState<{ value: string; label: string }[]>([]);
  const toast = useToast();

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
      toast.success(`已新建任务实例「${values.task_name.trim()}」。`);
      go(href.task(task_id));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "新建任务实例没有成功。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="新建任务实例" open={open} onCancel={onClose} onOk={submit} okText="新建" cancelText="取消" confirmLoading={saving} destroyOnHidden>
      <p className="muted small">一个任务实例一份交付物。新建之后在任务起点页上传输入资料，再新建会话交给助手。</p>
      <Form form={form} layout="vertical">
        <Form.Item label="任务类型" name="task_type" rules={[{ required: true, message: "请选一种任务类型" }]}>
          <Select options={types} placeholder={types.length ? undefined : "没有读到任务类型"} />
        </Form.Item>
        <Form.Item label="任务名" name="task_name" rules={[{ required: true, whitespace: true, message: "请写一个任务名" }]}>
          <Input placeholder="例如：跨境电商退款模块" />
        </Form.Item>
        <Form.Item label="领域标签（可以不写）" name="domain_tag">
          <Input placeholder="例如：电商售后" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
