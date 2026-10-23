// 删除任务的确认框（任务列表每行菜单里的「删除任务」）：先读这个任务，写明它有几份材料、几个条目、发布过几版，删除后不能恢复；
// 给「先导出存档」（下载这个任务的数据包，不关确认框）与「删除」两个按钮，不要求先导出。删除被拒时把任务服务的原话写在框里。

import { useEffect, useState } from "react";
import { Alert, Button, Modal } from "antd";
import { api, ApiError } from "../../api/client";
import { ownMaterials } from "../../model/docx";
import { useToast } from "../Toasts";

/** 确认框正文的那一句。 */
export function deleteTaskText(counts: { materials: number; items: number; versions: number }): string {
  return `这个任务实例有 ${counts.materials} 份输入资料、${counts.items} 个条目、${counts.versions} 版发布，删除后不能恢复。`;
}

export function DeleteTaskModal({ taskId, taskName, onClose, onDeleted }: {
  /** 要删除的任务；null 时确认框关着。 */
  taskId: string | null;
  taskName: string;
  onClose: () => void;
  /** 删除成功之后（列表据此去掉这一行）。 */
  onDeleted: (taskId: string) => void;
}) {
  const toast = useToast();
  const [counts, setCounts] = useState<{ materials: number; items: number; versions: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setCounts(null);
    setError(null);
    if (!taskId) return;
    let live = true;
    api.getTask(taskId)
      .then((task) => { if (live) setCounts({ materials: ownMaterials(task.materials).length, items: task.items.length, versions: (task.versions ?? []).length }); })
      .catch((e) => { if (live) setError(e instanceof ApiError ? e.message : String(e)); });
    return () => { live = false; };
  }, [taskId]);

  const remove = async () => {
    if (!taskId) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteTask(taskId);
      toast.success(`已删除任务实例「${taskName}」。`);
      onDeleted(taskId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "没有删除成。");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal open={!!taskId} title={`删除任务实例「${taskName}」？`} onCancel={() => { if (!deleting) onClose(); }} destroyOnHidden
      closable={!deleting} maskClosable={!deleting} keyboard={!deleting}
      footer={[
        <Button key="cancel" disabled={deleting} onClick={onClose}>取消</Button>,
        <Button key="export" href={taskId ? api.exportTaskHref(taskId) : undefined} disabled={!taskId || deleting} data-testid="delete-task-export">先导出存档</Button>,
        <Button key="delete" danger type="primary" loading={deleting} disabled={!counts} onClick={() => void remove()} data-testid="delete-task-confirm">删除</Button>,
      ]}>
      <p data-testid="delete-task-text">{counts ? deleteTaskText(counts) : "正在读这个任务实例。"}</p>
      <p className="muted small" data-testid="delete-task-export-note">先导出存档：导出这个任务实例的需求资产与对话记录，不含输入资料与知识库的原件，也不含运行日志；含摘录、转述与对话全文。以后可以再导入，导入后重新上传输入资料即可补齐。不导出也可以直接删除。</p>
      {error && <Alert type="error" showIcon message={error} data-testid="delete-task-error" />}
    </Modal>
  );
}
